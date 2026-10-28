"""Read-only audit of a sealed output-cap observation; no credentials or network."""
import collections
import hashlib
import json
import math
import pathlib
import sqlite3
import statistics
import sys

root = pathlib.Path(sys.argv[1])
parent = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
report_raw = (root / 'report.json').read_bytes()
report = json.loads(report_raw)
manifest_raw = (root / 'manifest.json').read_bytes()
manifest = json.loads(manifest_raw)
meta = json.loads((root / 'run.json').read_text())
summary = json.loads((root / 'summary.json').read_text())
assert summary['reportDigest'] == hashlib.sha256(report_raw).hexdigest()
assert report['manifestDigest'] == hashlib.sha256(manifest_raw).hexdigest()
assert report['sourceCommit'] == meta['sourceCommit'] == manifest['sourceCommit']
assert not meta['sourceTreeDirty']
assert report['protocol'] == manifest['protocol'] == 'routing-output-cap-v1'
assert manifest['runMs'] == 90000 and manifest['decisionMs'] == 85000
assert manifest['repeats'] == 3 and len(manifest['cases']) == 20
assert [(c['layout'], c['demos'], c['output']) for c in manifest['conditions']] == [(1, 0, 1024), (1, 0, 2048)]
assert report['benefit'] == 'inconclusive' and report['activeUnchanged']
assert report['selected'] is None and report['confirmationPassed'] is False


def database(path):
    wal = path / 'instance/metadata.sqlite-wal'
    assert not wal.exists() or wal.stat().st_size == 0, 'require sealed, checkpointed instance'
    connection = sqlite3.connect('file:' + str(path / 'instance/metadata.sqlite') + '?mode=ro&immutable=1', uri=True)
    connection.row_factory = sqlite3.Row
    return connection


db = database(root)
assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
assert not db.execute('pragma foreign_key_check').fetchall()
blob_count = 0
for path in (root / 'instance/blobs').glob('*/*'):
    assert hashlib.sha256(path.read_bytes()).hexdigest() == path.name
    blob_count += 1


def blob(ref):
    return (root / 'instance/blobs' / ref).read_bytes()


events = list(db.execute('select * from events where stream_id=? order by seq', ('diagnostic-' + meta['id'],)))
closed = [e for e in events if e['type'] == 'diagnostic.closed']
rows = []
for event in closed:
    ref = json.loads(event['payload'])['receipt']
    raw = blob(ref['ref'])
    assert hashlib.sha256(raw).hexdigest() == ref['digest']
    receipt = json.loads(raw)
    assert event['run_id'] == receipt['runId']
    rows.append(receipt)
assert rows == report['receipts']
assert len({r['runId'] for r in rows}) == len(rows)
assert len({r['callId'] for r in rows}) == len(rows)
conditions = {c['id']: c for c in manifest['conditions']}
cases = {c['id']: c for c in manifest['cases']}
prepared_bodies = {}
for receipt in rows:
    run = db.execute('select * from runs where id=?', (receipt['runId'],)).fetchone()
    calls = db.execute('select * from decision_calls where run_id=?', (receipt['runId'],)).fetchall()
    assert len(calls) == 1
    call = calls[0]
    assert call['id'] == receipt['callId'] and call['sent'] == 1
    assert run['experiment_id'] == meta['id']
    assert run['snapshot_id'] == conditions[receipt['conditionId']]['snapshotId'] == call['snapshot_id']
    assert json.loads(run['budget'])['maxWallClockSeconds'] == 90
    request_raw = blob(call['request_ref'])
    assert hashlib.sha256(request_raw).hexdigest() == call['request_digest']
    body = json.loads(request_raw)['prepared']['body']
    assert body['max_tokens'] == conditions[receipt['conditionId']]['output']
    assert body['model'] == manifest['model']
    response_raw = blob(call['response_ref'])
    assert hashlib.sha256(response_raw).hexdigest() == call['response_digest']
    assert receipt['responseDigest'] == call['response_digest']
    assert receipt['inputTokens'] is None or receipt['inputTokens'] <= manifest['inputPerCall']
    assert receipt['outputTokens'] is None or receipt['outputTokens'] <= body['max_tokens']
    assert receipt['familyId'] == cases[receipt['caseId']]['familyId']
    body.pop('max_tokens')
    key = (receipt['caseId'], receipt['repeat'])
    if key in prepared_bodies:
        assert prepared_bodies[key] == body, 'request factors differ beyond cap'
    prepared_bodies[key] = body

metrics = {}
for condition in manifest['conditions']:
    subset = [r for r in rows if r['conditionId'] == condition['id']]
    latencies = sorted(r['latencyMs'] for r in subset)
    output = [r['outputTokens'] for r in subset if r['outputTokens'] is not None]
    metrics[condition['id']] = {
        'completed': len(subset), 'planned': 60,
        'accepted': sum(r['accepted'] for r in subset),
        'jsonValid': sum(r['jsonValid'] for r in subset),
        'criticalFailures': sum(not r['accepted'] and cases[r['caseId']]['critical'] for r in subset),
        'misroutes': sum(r['misrouted'] for r in subset),
        'knownInputTokens': sum(r['inputTokens'] or 0 for r in subset),
        'knownOutputTokens': sum(output),
        'medianOutputTokens': statistics.median(output) if output else None,
        'maxObservedOutputTokens': max(output) if output else None,
        'medianRunMs': statistics.median(latencies) if latencies else None,
        'p95RunMs': latencies[math.ceil(.95 * len(latencies)) - 1] if latencies else None,
        'stopReasons': dict(collections.Counter(r['serviceResponse']['stopReason'] if r['serviceResponse'] else 'unavailable' for r in subset)),
        'familyAccepted': {family: sum(r['accepted'] for r in subset if r['familyId'] == family) for family in sorted({c['familyId'] for c in cases.values()})},
    }
    recorded = next(c for c in report['metrics'] if c['id'] == condition['id'])
    for key in ['completed', 'planned', 'accepted', 'criticalFailures', 'knownInputTokens', 'knownOutputTokens', 'stopReasons']:
        assert metrics[condition['id']][key] == recorded[key]
    assert metrics[condition['id']]['jsonValid'] / 60 == recorded['jsonValidRate'] or abs(metrics[condition['id']]['jsonValid'] / 60 - recorded['jsonValidRate']) < 1e-12
    gate = report['engineering'] == 'passed' and metrics[condition['id']]['jsonValid'] >= 57 and metrics[condition['id']]['accepted'] >= 54 and metrics[condition['id']]['misroutes'] <= 3 and metrics[condition['id']]['criticalFailures'] == 0
    assert gate == next(g['passed'] for g in report['qualityGates'] if g['conditionId'] == condition['id'])
assert sum(m['knownInputTokens'] for m in metrics.values()) == report['knownInputTokens']
assert sum(m['knownOutputTokens'] for m in metrics.values()) == report['knownOutputTokens']
lookup = {(r['conditionId'], r['caseId'], r['repeat']): r for r in rows}
paired = collections.Counter()
for case in cases:
    for repeat in range(1, 4):
        a = lookup.get(('v1-t1024-d0', case, repeat))
        b = lookup.get(('v1-t2048-d0', case, repeat))
        if a and b:
            paired[(a['accepted'], b['accepted'])] += 1

parent_event_count = None
if parent:
    pm = json.loads((parent / 'manifest.json').read_text())
    pr = json.loads((parent / 'report.json').read_text())
    assert manifest['cases'] == pm['cases'] and manifest['serviceId'] == pm['serviceId']
    pdb = database(parent)
    pid = json.loads((parent / 'run.json').read_text())['id']
    old = list(pdb.execute('select * from events where stream_id=? order by seq', ('diagnostic-' + pid,)))
    copied = list(db.execute('select * from events where stream_id=? order by seq', ('diagnostic-' + pid,)))
    assert [tuple(e) for e in old] == [tuple(e) for e in copied]
    parent_event_count = len(old)
    assert report['totalModelCallsIncludingHistory'] == pr['totalModelCallsIncludingHistory'] + report['sentModelCalls']
    assert report['totalUnknownUsageCallsIncludingHistory'] == pr['totalUnknownUsageCallsIncludingHistory'] + report['unknownUsageCalls']
    assert report['totalKnownInputTokensIncludingHistory'] == pr['totalKnownInputTokensIncludingHistory'] + report['knownInputTokens']
    assert report['totalKnownOutputTokensIncludingHistory'] == pr['totalKnownOutputTokensIncludingHistory'] + report['knownOutputTokens']
    old_index = {(r['caseId'], r['repeat']): r for r in pr['receipts'] if r['conditionId'] == 'v1-t512-d0'}
    for key, body in prepared_bodies.items():
        old_call = pdb.execute('select request_ref from decision_calls where id=?', (old_index[key]['callId'],)).fetchone()
        old_body = json.loads((parent / 'instance/blobs' / old_call[0]).read_text())['prepared']['body']
        old_body.pop('max_tokens')
        assert old_body == body

result = {
    'scope': 'sealed-developer-visible-output-cap-calibration',
    'metrics': metrics,
    'paired': {'paired': sum(paired.values()), 'bothSucceeded': paired[(True, True)], 'only1024': paired[(True, False)], 'only2048': paired[(False, True)], 'bothFailed': paired[(False, False)]},
    'sha256VerifiedBlobs': blob_count, 'sqliteIntegrity': 'ok', 'foreignKeyViolations': 0,
    'uniqueCurrentRuns': len(rows), 'uniqueCurrentDecisionCalls': len(rows),
    'currentUnknownUsageCalls': report['unknownUsageCalls'],
    'historicalUnknownUsageCalls': report['prior']['unknownUsageCalls'],
    'parentEventsUnchanged': parent_event_count,
    'allRequestBodiesEqualExceptOutputCap': True,
    'reportDigest': hashlib.sha256(report_raw).hexdigest(),
    'manifestDigest': hashlib.sha256(manifest_raw).hexdigest(),
}
print(json.dumps(result, ensure_ascii=False, indent=2))
