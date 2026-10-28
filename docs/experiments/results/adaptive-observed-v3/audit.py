import json, pathlib, sqlite3, hashlib, collections, math, sys
p=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2]) if len(sys.argv)>2 else p/'independent-audit.json'
load=lambda path:json.loads(path.read_text())
manifest=load(p/'manifest.json'); report=load(p/'report.json'); summary=load(p/'summary.json')
# Archive is closed and checkpointed; no journal writes are needed for this audit.
wal=p/'instance/metadata.sqlite-wal'
assert not wal.exists() or wal.stat().st_size==0
db=sqlite3.connect('file:'+str(p/'instance/metadata.sqlite')+'?mode=ro&immutable=1',uri=True)
assert db.execute('pragma integrity_check').fetchall()==[('ok',)]
assert not db.execute('pragma foreign_key_check').fetchall()
blobs=list((p/'instance/blobs').glob('*/*'))
for blob in blobs:
 assert hashlib.sha256(blob.read_bytes()).hexdigest()==blob.name, str(blob)
def blobdata(ref):
 path=p/'instance/blobs'/ref['ref']; assert hashlib.sha256(path.read_bytes()).hexdigest()==ref['digest']; return load(path)
closed=[]; responses={}; event_counts=collections.Counter()
for typ,runid,payload in db.execute("select type,run_id,payload from events where type like 'observed.%' order by recorded_at,seq"):
 event_counts[typ]+=1; e=json.loads(payload)
 if typ=='observed.closed': closed.append(blobdata(e['receipt']))
 if typ in ['observed.received','observed.received-late']:
  assert runid not in responses; responses[runid]=blobdata(e['result'])
closed.sort(key=lambda x:x['ordinal'])
assert [r['ordinal'] for r in closed]==list(range(830))
assert len({r['runId'] for r in closed})==830
assert len({r['callId'] for r in closed})==830
assert len(report['rows'])==450 and all(r['complete'] for r in report['rows'])
assert event_counts['observed.sending']==790 and len(responses)==789
assert db.execute('select count(*) from runs').fetchone()[0]==830
assert db.execute('select count(*) from decision_calls').fetchone()[0]==830
for table in ['registry_credentials','evaluations','promotions','candidates']:
 assert db.execute('select count(*) from '+table).fetchone()[0]==0,table
assert sum(r['modelCalls'] for r in closed)==790
assert sum(not r['meteringComplete'] for r in closed)==1
assert report['dispatchComplete'] and report['engineering']=='incomplete'
assert report['unknownUsageCalls']==1 and report['activeUnchanged']
assert report['totalModelCallsIncludingSetup']==793
assert hashlib.sha256((p/'manifest.json').read_bytes()).hexdigest()==summary['manifestDigest']
assert hashlib.sha256((p/'report.json').read_bytes()).hexdigest()==summary['reportDigest']
assert sum(r['inputTokens'] or 0 for r in closed)==report['knownInputTokens']
assert sum(r['outputTokens'] or 0 for r in closed)==report['knownOutputTokens']
cases={c['id']:c for c in manifest['cases']}
slots=[]; units={}
for c in manifest['cases']:
 if c['split'] in ['train','search']:slots.append((c['id'],'source','compiled'))
for conf in [0,1]:
 for c in manifest['cases']:
  if c['split']=='search':slots.append((c['id'],'search','compiled'))
for c in manifest['cases']:
 if c['split'] not in ['formal','regression']:continue
 for repeat in [1,2,3]:
  for armpos in range(3):
   arm=['single','budget-matched','compiled'][(armpos+repeat-1+manifest['seed'])%3]
   for pos in range(3 if arm=='budget-matched' else 1):
    units.setdefault((c['id'],repeat,arm),[]).append(len(slots))
    slots.append((c['id'],'measurement',arm))
assert len(slots)==830
byarm=collections.defaultdict(collections.Counter); empty256=collections.Counter()
for r,(_,phase,arm) in zip(closed,slots):
 if phase!='measurement':continue
 byarm[arm][r['decision']]+=1
 result=responses.get(r['runId'])
 if result and result.get('kind')=='invalid_output' and result.get('raw')=='' and result.get('evidence',{}).get('outputTokens')==256:empty256[arm]+=1
assert len(units)==450
reported={(r['caseId'],r['repeat'],r['arm']):r for r in report['rows']}
assert len(reported)==450
reconstructed=[]
for key,ordinals in units.items():
 got=[closed[i] for i in ordinals]; choices=[r['selectable'] for r in got]
 votes=collections.Counter(choices); choice=max(choices,key=lambda v:votes[v])
 selected=got[choices.index(choice)]
 row={'caseId':key[0],'repeat':key[1],'arm':key[2],'complete':True,'choice':choice,
      'accepted':choice is not None and selected['accepted'],
      'misrouted':choice is not None and choice!=cases[key[0]]['expectedChoice'],
      'latencyMs':sum(r['latencyMs'] for r in got)}
 assert all(reported[key][field]==value for field,value in row.items()),key
 reconstructed.append(row)
unit_counts={}
for arm, splits in report['arms'].items():
 unit_counts[arm]={}
 for split,m in splits.items():
  rows=[r for r in reconstructed if r['arm']==arm and cases[r['caseId']]['split']==split]
  accepted=sum(r['accepted'] for r in rows); assert len(rows)==m['planned']
  # Frozen strata are equal-sized, so independent count agrees with family-weighted rate.
  assert math.isclose(accepted/len(rows),m['successRate'],abs_tol=1e-12)
  unit_counts[arm][split]={'accepted':accepted,'planned':len(rows),'families':len(set(cases[r['caseId']]['familyId'] for r in rows))}
result={'scope':'post-hoc-independent-read-only-audit','sqliteIntegrity':'ok','foreignKeyViolations':0,'sha256VerifiedBlobs':len(blobs),'closedUniqueRuns':830,'uniqueDecisionCalls':830,'modelGenerationAttempts':790,'receivedServiceResults':789,'historicalUnknownUsageCalls':1,'totalGenerationAttemptsIncludingSetup':793,'plannedMeasurementUnits':450,'reconstructedMeasurementUnits':len(reconstructed),'newRuns':report['continuation']['newRuns'],'importedRuns':report['continuation']['importedRuns'],'unitCounts':unit_counts,'measurementDecisionKinds':dict(byarm),'measurementEmptyInvalidAt256Tokens':dict(empty256),'observedEvents':dict(event_counts),'manifestDigest':summary['manifestDigest'],'reportDigest':summary['reportDigest'],'noCandidatesEvaluationsPromotions':True,'noRegistryCredentials':True}
output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n'); print(json.dumps(result,ensure_ascii=False,indent=2))
