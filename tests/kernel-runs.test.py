"""P8b /__kernel/runs: run registry, authentication, approvals, effects, SSE."""
import json, os, tempfile, threading, time, unittest, urllib.request, urllib.error
from pathlib import Path

host_dir = tempfile.TemporaryDirectory(prefix='aibro-kernel-host-'); os.environ.setdefault('AI_WORKSTATION_DATA_DIR', host_dir.name)
import kernel_runs
from kernel_runs import KernelRuns, KernelError
from event_log import EventLog

HOST = 'h' * 64
NATIVE = 'n' * 64


class Clock:
    def __init__(self): self.now = 1_800_000_000.0
    def __call__(self): return self.now


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.clock = Clock()
        self.events = EventLog(self.tmp.name, clock=self.clock)
        self.runs = KernelRuns(self.tmp.name, self.events, HOST, clock=self.clock)

    def types(self, run_id):
        return [e['type'] for e in self.events.read('run:' + run_id)]

    def test_create_validates_and_is_idempotent(self):
        run, created = self.runs.create({'prompt': '整理本周论文', 'source': {'kind': 'scheduler', 'id': 'daily'}, 'idempotencyKey': 'd-1'})
        self.assertTrue(created); self.assertEqual(run['status'], 'queued'); self.assertEqual(run['request']['title'], '整理本周论文')
        again, created = self.runs.create({'prompt': '整理本周论文', 'source': {'kind': 'scheduler', 'id': 'daily'}, 'idempotencyKey': 'd-1'})
        self.assertFalse(created); self.assertEqual(again['id'], run['id'])
        for bad in ({}, {'prompt': ''}, {'prompt': 'x', 'apiKey': 'y'}, {'prompt': 'x', 'permissionMode': 'yolo'}, {'prompt': 'x' * 9000}, {'prompt': 'x', 'source': {'kind': 'root'}}):
            with self.assertRaises(KernelError): self.runs.create(bad)
        self.assertEqual(self.types(run['id']), ['run/queued'])
        self.assertEqual(oct(Path(self.tmp.name, 'kernel', 'runs', run['id'] + '.json').stat().st_mode & 0o777), '0o600')

    def test_claim_lease_and_finish(self):
        run, _ = self.runs.create({'prompt': 'a'})
        claim = self.runs.claim('hidden-webview')
        self.assertEqual(claim['run']['id'], run['id']); self.assertNotIn('lease', claim['run'])
        self.assertIsNone(self.runs.claim('other'))
        with self.assertRaises(KernelError): self.runs.heartbeat(run['id'], 'wrong')
        self.assertEqual(self.runs.heartbeat(run['id'], claim['leaseToken']), {'cancelRequested': False})
        done = self.runs.finish(run['id'], claim['leaseToken'], {'status': 'completed', 'result': {'final': '好了', 'stop': 'final', 'steps': 3}})
        self.assertEqual((done['status'], done['result']['final']), ('completed', '好了'))
        with self.assertRaises(KernelError): self.runs.heartbeat(run['id'], claim['leaseToken'])

    def test_lost_host_requeues_only_runs_without_effects(self):
        quiet, _ = self.runs.create({'prompt': 'read only'})
        lease = self.runs.claim('h')['leaseToken']
        self.clock.now += 60
        self.assertEqual(self.runs.get(quiet['id'])['status'], 'queued')  # no effect yet: may start over
        self.assertIn('run/interrupted', self.types(quiet['id']))
        lease = self.runs.claim('h')['leaseToken']
        self.runs.add_effect(quiet['id'], lease, {'id': 'a:s:1', 'tool': 'create_task', 'args': {'title': 't'}})
        self.runs.claim_effects()
        self.clock.now += 60
        self.assertEqual(self.runs.get(quiet['id'])['status'], 'interrupted')  # it may have acted: stop, show the user

    def test_restart_marks_running_runs(self):
        run, _ = self.runs.create({'prompt': 'a'}); self.runs.claim('h')
        again = KernelRuns(self.tmp.name, self.events, HOST, clock=self.clock)
        self.assertEqual(again.get(run['id'])['status'], 'queued')

    def test_approval_waits_for_a_person_and_cancel_releases_it(self):
        run, _ = self.runs.create({'prompt': 'a'})
        lease = self.runs.claim('h')['leaseToken']
        approval = self.runs.ask(run['id'], lease, {'callId': 'h:s:1', 'tool': 'create_note', 'effect': 'local', 'args': {'title': 'x', 'token': 'secret-value'}})
        self.assertEqual(self.runs.get(run['id'])['status'], 'awaiting-approval')
        self.assertNotIn('secret-value', approval['summary'])
        self.assertEqual(self.runs.ask(run['id'], lease, {'callId': 'h:s:1', 'tool': 'create_note'})['id'], approval['id'])  # same call, same approval
        out = self.runs.wait_approval(run['id'], lease, approval['id'], timeout=0)
        self.assertEqual(out['approval']['status'], 'pending')
        threading.Timer(0.05, lambda: self.runs.decide(run['id'], approval['id'], 'allowed-once', 'user')).start()
        self.clock_real()
        out = self.runs.wait_approval(run['id'], lease, approval['id'], timeout=5)
        self.assertEqual(out['approval']['status'], 'allowed-once'); self.assertEqual(self.runs.get(run['id'])['status'], 'running')
        with self.assertRaises(KernelError): self.runs.decide(run['id'], approval['id'], 'rejected', 'user')
        second = self.runs.ask(run['id'], lease, {'callId': 'h:s:2', 'tool': 'create_task'})
        self.runs.cancel(run['id'])
        out = self.runs.wait_approval(run['id'], lease, second['id'], timeout=1)
        self.assertEqual((out['approval']['status'], out['cancelRequested']), ('cancelled', True))

    def test_destructive_steps_are_approved_in_the_window_not_from_a_notification(self):
        run, _ = self.runs.create({'prompt': 'a'})
        lease = self.runs.claim('h')['leaseToken']
        risky = self.runs.ask(run['id'], lease, {'callId': 'h:d:1', 'tool': 'delete_task', 'effect': 'local', 'destructive': True})
        plain = self.runs.ask(run['id'], lease, {'callId': 'h:d:2', 'tool': 'create_task', 'effect': 'local'})
        pending = {a['approvalId']: a['destructive'] for a in self.runs.pending()['approvals']}
        self.assertEqual(pending, {risky['id']: True, plain['id']: False})
        with self.assertRaises(KernelError) as caught: self.runs.decide(run['id'], risky['id'], 'allowed-once', 'native')
        self.assertEqual((caught.exception.status, caught.exception.code), (403, 'REVIEW_IN_WINDOW'))
        self.assertEqual(self.runs.decide(run['id'], plain['id'], 'allowed-once', 'native')['approvals'][1]['status'], 'allowed-once')
        self.assertEqual(self.runs.decide(run['id'], risky['id'], 'rejected', 'native')['approvals'][0]['status'], 'rejected')
        second = self.runs.ask(run['id'], lease, {'callId': 'h:d:3', 'tool': 'delete_task', 'effect': 'local', 'destructive': True})
        self.assertEqual(self.runs.decide(run['id'], second['id'], 'allowed-once', 'user')['approvals'][2]['answerer'], 'user')

    def clock_real(self):
        self.runs.clock = time.time; self.events.clock = time.time

    def test_effects_are_applied_once_by_the_claiming_window(self):
        run, _ = self.runs.create({'prompt': 'a'})
        lease = self.runs.claim('h')['leaseToken']
        effect = self.runs.add_effect(run['id'], lease, {'id': 'h:s:3', 'tool': 'create_task', 'args': {'title': '复核', 'apiKey': 'k'}})
        self.assertEqual(effect['args'], {'title': '复核', 'apiKey': '[redacted]'})
        self.assertEqual(self.runs.add_effect(run['id'], lease, {'id': 'h:s:3', 'tool': 'create_task', 'args': {}})['args'], effect['args'])  # idempotent
        claimed = self.runs.claim_effects()
        self.assertEqual([c['id'] for c in claimed], ['h:s:3']); self.assertEqual(self.runs.claim_effects(), [])
        with self.assertRaises(KernelError): self.runs.effect_receipt(run['id'], 'h:s:3', 'forged', {'ok': True})
        self.runs.effect_receipt(run['id'], 'h:s:3', claimed[0]['claimToken'], {'ok': True, 'result': {'taskId': 't1'}})
        with self.assertRaises(KernelError): self.runs.effect_receipt(run['id'], 'h:s:3', claimed[0]['claimToken'], {'ok': True})
        self.assertEqual(self.runs.wait_effect(run['id'], lease, 'h:s:3', 0)['effect']['status'], 'applied')
        self.assertNotIn('claimToken', json.dumps(self.runs.get(run['id'])))

    def test_unclaimed_effect_expires_as_not_started(self):
        run, _ = self.runs.create({'prompt': 'a'})
        lease = self.runs.claim('h')['leaseToken']
        self.runs.add_effect(run['id'], lease, {'id': 'h:s:4', 'tool': 'create_task', 'args': {'title': 'x'}})
        self.clock.now += kernel_runs.EFFECT_DEADLINE - 10; self.runs.heartbeat(run['id'], lease)
        self.clock.now += 20
        out = self.runs.wait_effect(run['id'], lease, 'h:s:4', 0)['effect']
        self.assertEqual((out['status'], out['receipt']['outcome']), ('expired', 'not-started'))

    def test_cancel_queued_run_finishes_it(self):
        run, _ = self.runs.create({'prompt': 'a'})
        self.assertEqual(self.runs.cancel(run['id'])['status'], 'cancelled')
        self.assertIsNone(self.runs.claim('h'))
        self.assertEqual(self.types(run['id']), ['run/queued', 'run/finished'])

    def test_model_override_is_validated_and_kept(self):
        run, _ = self.runs.create({'prompt': 'a', 'source': {'kind': 'scheduler', 'id': 'nightly'}, 'model': {'connection': 'codex-cli', 'model': 'gpt-5.5', 'effort': 'low'}})
        self.assertEqual(run['request']['model'], {'connection': 'codex-cli', 'model': 'gpt-5.5', 'effort': 'low'})
        self.assertIsNone(self.runs.create({'prompt': 'b'})[0]['request']['model'])
        for bad in ({'connection': ''}, {'connection': 'codex-cli', 'apiKey': 'sk'}, 'codex-cli', {'connection': 'x' * 400}):
            with self.assertRaises(KernelError): self.runs.create({'prompt': 'c', 'model': bad})

    def test_pause_waits_for_resume_then_requeues(self):
        run, _ = self.runs.create({'prompt': 'a'})
        claim = self.runs.claim('h')
        paused = self.runs.pause(run['id'], claim['leaseToken'], {'code': 'CODEX_QUOTA', 'message': 'Codex 订阅额度已用尽。' + 'x' * 500, 'steps': 3})
        self.assertEqual(paused['status'], 'paused')
        self.assertEqual((paused['pause']['code'], paused['pause']['steps'], len(paused['pause']['message'])), ('CODEX_QUOTA', 3, 300))
        # Paused is neither lost nor claimable, and the old lease is gone.
        self.clock.now += 3600
        self.assertIsNone(self.runs.claim('h'))
        self.assertEqual(self.runs.get(run['id'])['status'], 'paused')
        with self.assertRaises(KernelError): self.runs.heartbeat(run['id'], claim['leaseToken'])
        resumed = self.runs.resume(run['id'])
        self.assertEqual((resumed['status'], resumed['resumes'], resumed['pause']), ('queued', 1, None))
        self.assertEqual(len(resumed['pauses']), 1)
        with self.assertRaises(KernelError) as caught: self.runs.resume(run['id'])
        self.assertEqual(caught.exception.code, 'NOT_PAUSED')
        self.assertEqual(self.runs.claim('h')['run']['id'], run['id'])
        self.assertEqual(self.types(run['id']), ['run/queued', 'run/started', 'run/paused', 'run/resumed', 'run/started'])

    def test_cancel_paused_run_finishes_it(self):
        run, _ = self.runs.create({'prompt': 'a'})
        claim = self.runs.claim('h')
        self.runs.pause(run['id'], claim['leaseToken'], {'code': 'CODEX_RATE_LIMIT'})
        self.assertEqual(self.runs.cancel(run['id'])['status'], 'cancelled')
        self.assertEqual(self.types(run['id'])[-1], 'run/finished')


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        import server
        server.EVENT_LOG = EventLog(self.tmp.name)
        server.KERNEL_RUNS = KernelRuns(self.tmp.name, server.EVENT_LOG, HOST)
        server.NATIVE_CONTROL_TOKEN = NATIVE
        self.server = server
        httpd = server.LoopbackHTTPServer(('127.0.0.1', 0), server.Handler)
        server.PORT = self.port = httpd.server_port
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close); self.addCleanup(httpd.shutdown)
        self.token = server.KERNEL_RUNS.api_token()

    def call(self, method, path, body=None, headers=None, host=None):
        data = json.dumps(body).encode() if body is not None else None
        h = {**({'Content-Type': 'application/json'} if data else {}), **(headers or {})}
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=data, headers=h, method=method)
        if host: req.add_header('Host', host)
        try:
            with urllib.request.urlopen(req, timeout=10) as r: return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')

    def bearer(self, token=None): return {'Authorization': 'Bearer ' + (token or self.token)}
    def window(self): return {'Origin': f'http://127.0.0.1:{self.port}', 'Sec-Fetch-Site': 'same-origin'}

    def test_token_file_and_client_auth(self):
        path = Path(self.tmp.name, 'kernel', 'api-token')
        self.assertEqual(oct(path.stat().st_mode & 0o777), '0o600')
        self.assertEqual(self.call('POST', '/__kernel/runs', {'prompt': 'x'})[0], 401)  # no token, not the window
        self.assertEqual(self.call('POST', '/__kernel/runs', {'prompt': 'x'}, self.bearer('0' * 64))[0], 401)
        self.assertEqual(self.call('POST', '/__kernel/runs', {'prompt': 'x'}, {**self.bearer(), 'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.call('GET', '/__kernel/runs', None, self.bearer(), host='evil.example:80')[0], 403)  # DNS rebinding
        self.assertEqual(self.call('POST', '/__kernel/runs', {'prompt': 'x'}, {**self.bearer(), 'Sec-Fetch-Site': 'cross-site'})[0], 403)
        status, body = self.call('POST', '/__kernel/runs', {'prompt': '读一下资料', 'source': {'kind': 'mobile', 'id': 'phone'}}, self.bearer())
        self.assertEqual((status, body['run']['status'], body['run']['source']['kind']), (201, 'queued', 'mobile'))
        self.assertEqual(self.call('GET', '/__kernel/runs/' + body['run']['id'], None, self.bearer())[0], 200)
        status, listed = self.call('GET', '/__kernel/runs', None, self.window())
        self.assertEqual((status, len(listed['runs'])), (200, 1))
        self.assertNotIn(self.token, json.dumps(listed))

    def test_host_pauses_and_a_client_resumes(self):
        status, body = self.call('POST', '/__kernel/runs', {'prompt': 'x', 'model': {'connection': 'codex-cli'}}, self.bearer())
        run_id = body['run']['id']
        host = {'X-AIBro-Kernel-Host': HOST, 'Origin': f'http://127.0.0.1:{self.port}'}
        status, claim = self.call('POST', '/__kernel/host/claim', {'host': 't'}, host)
        self.assertEqual(claim['run']['request']['model']['connection'], 'codex-cli')
        self.assertEqual(self.call('POST', f'/__kernel/host/runs/{run_id}/pause', {'leaseToken': claim['leaseToken'], 'code': 'CODEX_QUOTA', 'message': '额度用尽'}, self.bearer())[0], 403)
        status, paused = self.call('POST', f'/__kernel/host/runs/{run_id}/pause', {'leaseToken': claim['leaseToken'], 'code': 'CODEX_QUOTA', 'message': '额度用尽'}, host)
        self.assertEqual((status, paused['run']['status']), (200, 'paused'))
        status, resumed = self.call('POST', f'/__kernel/runs/{run_id}/resume', {}, self.bearer())
        self.assertEqual((status, resumed['run']['status']), (200, 'queued'))

    def test_codex_kernel_routes_need_the_host_token(self):
        status, body = self.call('POST', '/__kernel/host/codex/step', {'runId': 'krun_x', 'messages': [{'role': 'user', 'content': 'hi'}]}, self.window())
        self.assertEqual((status, body['error']['code']), (403, 'HOST_ONLY'))
        status, body = self.call('POST', '/__kernel/host/codex/close', {'runId': 'krun_x'}, {'X-AIBro-Kernel-Host': HOST, 'Origin': f'http://127.0.0.1:{self.port}'})
        self.assertEqual((status, body), (200, {'ok': False}))

    def test_only_people_answer_and_only_the_window_applies(self):
        status, body = self.call('POST', '/__kernel/runs', {'prompt': 'x'}, self.bearer())
        run_id = body['run']['id']
        self.assertEqual(self.call('POST', '/__kernel/host/claim', {}, self.bearer())[0], 403)
        status, claim = self.call('POST', '/__kernel/host/claim', {}, {'X-AIBro-Kernel-Host': HOST, **self.window()})
        lease = claim['leaseToken']
        _, asked = self.call('POST', f'/__kernel/host/runs/{run_id}/ask', {'leaseToken': lease, 'callId': 'h:1', 'tool': 'create_task', 'effect': 'local'}, {'X-AIBro-Kernel-Host': HOST, **self.window()})
        aid = asked['approval']['id']
        self.assertEqual(self.call('POST', f'/__kernel/runs/{run_id}/approvals/{aid}', {'decision': 'allowed-once'}, self.bearer())[1]['code'], 'HUMAN_ONLY')
        self.assertEqual(self.call('GET', '/__kernel/runs?attention=1', None, self.window())[1]['runs'][0]['id'], run_id)
        status, decided = self.call('POST', f'/__kernel/runs/{run_id}/approvals/{aid}', {'decision': 'allowed-once'}, self.window())
        self.assertEqual((status, decided['run']['approvals'][0]['answerer']), (200, 'user'))
        self.call('POST', f'/__kernel/host/runs/{run_id}/effects', {'leaseToken': lease, 'id': 'h:1', 'tool': 'create_task', 'args': {'title': 't'}}, {'X-AIBro-Kernel-Host': HOST, **self.window()})
        self.assertEqual(self.call('POST', '/__kernel/effects/claim', {}, self.bearer())[0], 403)
        status, claimed = self.call('POST', '/__kernel/effects/claim', {}, self.window())
        self.assertEqual([e['id'] for e in claimed['effects']], ['h:1'])
        status, _ = self.call('POST', f'/__kernel/effects/{run_id}/h:1/receipt', {'claimToken': claimed['effects'][0]['claimToken'], 'receipt': {'ok': True}}, self.window())
        self.assertEqual(status, 200)
        status, pending = self.call('GET', '/__kernel/host/pending', None, {'X-AIBro-Kernel-Host': HOST})
        self.assertEqual(pending['active'], 1)
        # native shell answers from a notification
        _, asked = self.call('POST', f'/__kernel/host/runs/{run_id}/ask', {'leaseToken': lease, 'callId': 'h:2', 'tool': 'create_note'}, {'X-AIBro-Kernel-Host': HOST})
        status, decided = self.call('POST', f"/__kernel/runs/{run_id}/approvals/{asked['approval']['id']}", {'decision': 'rejected'}, {'X-AIBro-Native-Token': NATIVE})
        self.assertEqual((status, decided['run']['approvals'][1]['answerer']), (200, 'native'))

    def test_event_stream_replays_and_ends(self):
        _, body = self.call('POST', '/__kernel/runs', {'prompt': 'x'}, self.bearer())
        run_id = body['run']['id']
        self.call('POST', f'/__kernel/runs/{run_id}/cancel', {}, self.bearer())
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}/__kernel/runs/{run_id}/events/stream?after=0', headers=self.bearer())
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertTrue(r.headers['Content-Type'].startswith('text/event-stream'))
            text = r.read().decode()
        self.assertIn('event: run/queued', text); self.assertIn('event: run/finished', text); self.assertIn('"status": "cancelled"', text)
        _, page = self.call('GET', f'/__kernel/runs/{run_id}/events?after=1', None, self.bearer())
        self.assertEqual([e['type'] for e in page['events']], ['run/finished'])


if __name__ == '__main__':
    unittest.main()
