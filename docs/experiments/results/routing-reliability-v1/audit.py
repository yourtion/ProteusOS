import pathlib,json,sqlite3,hashlib,tarfile,shutil,statistics,math,sys,collections
root=pathlib.Path(sys.argv[1]);parent=pathlib.Path(sys.argv[2]);name='routing-reliability-v1'
r=json.loads((root/'report.json').read_text());m=json.loads((root/'manifest.json').read_text());meta=json.loads((root/'run.json').read_text());summary=json.loads((root/'summary.json').read_text());p=json.loads((parent/'report.json').read_text());pm=json.loads((parent/'manifest.json').read_text())
assert hashlib.sha256((root/'report.json').read_bytes()).hexdigest()==summary['reportDigest']
assert hashlib.sha256((root/'manifest.json').read_bytes()).hexdigest()==r['manifestDigest']
assert r['mode']=='real' and r['benefit']=='inconclusive' and not meta['sourceTreeDirty']
assert m['conditions'][0]['snapshotDigest']==next(c['snapshotDigest'] for c in pm['conditions'] if c['id']==p['developmentRecommendation'])
for path in [root,parent]:
 wal=path/'instance/metadata.sqlite-wal';assert not wal.exists() or wal.stat().st_size==0
con=sqlite3.connect('file:'+str(root/'instance/metadata.sqlite')+'?mode=ro&immutable=1',uri=True);par=sqlite3.connect('file:'+str(parent/'instance/metadata.sqlite')+'?mode=ro&immutable=1',uri=True)
assert con.execute('pragma integrity_check').fetchone()[0]=='ok' and not con.execute('pragma foreign_key_check').fetchall()
pid=json.loads((parent/'run.json').read_text())['id'];q='select * from events where stream_id=? order by seq';old=par.execute(q,('diagnostic-'+pid,)).fetchall();assert old==con.execute(q,('diagnostic-'+pid,)).fetchall()
blobs=0
for f in (root/'instance/blobs').glob('*/*'):
 assert hashlib.sha256(f.read_bytes()).hexdigest()==f.name
 blobs+=1
rows=[]
for payload,runid in con.execute("select payload,run_id from events where stream_id=? and type='diagnostic.closed' order by seq",('diagnostic-'+meta['id'],)):
 ref=json.loads(payload)['receipt'];raw=(root/'instance/blobs'/ref['ref']).read_bytes();assert hashlib.sha256(raw).hexdigest()==ref['digest'];rec=json.loads(raw);assert rec['runId']==runid;rows.append(rec)
assert rows==r['receipts'] and len(set(x['runId'] for x in rows))==len(rows) and len(set(x['callId'] for x in rows))==len(rows)
for x in rows:
 call=con.execute('select request_ref,request_digest,response_ref,response_digest,snapshot_id from decision_calls where id=? and run_id=?',(x['callId'],x['runId'])).fetchone();assert call
 for ref,digest in [(call[0],call[1]),(call[2],call[3])]:
  if ref:assert hashlib.sha256((root/'instance/blobs'/ref).read_bytes()).hexdigest()==digest
 body=json.loads((root/'instance/blobs'/call[0]).read_text())['prepared']['body'];assert body['max_tokens']==1024 and call[4]==m['conditions'][0]['snapshotId']
lat=sorted(x['latencyMs'] for x in rows);cases={c['id']:c for c in m['cases']};families={f:{'planned':sum(c['familyId']==f for c in cases.values())*m['repeats'],'accepted':sum(x['accepted'] for x in rows if x['familyId']==f)} for f in sorted({c['familyId'] for c in cases.values()})}
analysis={'scope':'developer-visible descriptive reliability observation','planned':len(cases)*m['repeats'],'completed':len(rows),'accepted':sum(x['accepted'] for x in rows),'jsonValid':sum(x['jsonValid'] for x in rows),'criticalFailures':sum(not x['accepted'] and cases[x['caseId']]['critical'] for x in rows),'medianRunMs':statistics.median(lat) if lat else None,'p95RunMs':lat[math.ceil(.95*len(lat))-1] if lat else None,'family':families,'failureReceipts':[x for x in rows if not x['accepted']],'sha256VerifiedBlobs':blobs,'sqliteIntegrity':'ok','foreignKeyViolations':0,'parentEventsUnchanged':len(old),'reportDigest':summary['reportDigest']}
assert r['totalModelCallsIncludingHistory']==p['totalModelCallsIncludingHistory']+r['sentModelCalls']
assert r['totalUnknownUsageCallsIncludingHistory']==p['totalUnknownUsageCallsIncludingHistory']+r['unknownUsageCalls']
(root/'independent-audit.json').write_text(json.dumps(analysis,ensure_ascii=False,indent=2)+'\n')
out=pathlib.Path('docs/experiments/results')/name;out.mkdir()
shutil.copy2(__file__,out/'audit.py')
for f in ['run.json','manifest.json','report.json','summary.json','independent-audit.json']:shutil.copy2(root/f,out/f)
with tarfile.open(out/'evidence.tar.gz','w:gz') as tar:
 for f in ['run.json','manifest.json','report.json','summary.json','independent-audit.json','instance/metadata.sqlite','instance/blobs']:tar.add(root/f,arcname=f)
 tar.add(out/'audit.py',arcname='audit.py')
b=out/'evidence.tar.gz';(out/'archive.json').write_text(json.dumps({'sha256':hashlib.sha256(b.read_bytes()).hexdigest(),'bytes':b.stat().st_size,'reportDigest':summary['reportDigest'],'parentEventsUnchanged':len(old)},indent=2)+'\n');print(json.dumps(analysis,ensure_ascii=False,indent=2))
