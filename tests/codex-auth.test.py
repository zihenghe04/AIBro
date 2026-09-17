"""Auth/stream bridge tests; no real login, tokens, or billed model requests."""
import json
import os
from pathlib import Path
import queue
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = (Path(__file__).resolve().parents[1] / 'app')
sys.path.insert(0, str(ROOT))
import codex_bridge as bridge_module
from codex_bridge import BridgeError, CodexBridge, SAFE_CONFIG, convert_input, runtime_command, runtime_config, request_config, web_sources


MOCK_RUNTIME = r'''
import json,os,sys
from pathlib import Path
home=Path(os.environ['CODEX_HOME'])
audit=home/'mock-audit.jsonl'
startup={}
for index,arg in enumerate(sys.argv[:-1]):
 if arg=='-c':
  key,value=sys.argv[index+1].split('=',1);startup[key]=json.loads(value)
home.joinpath('mock-startup.json').write_text(json.dumps(startup))
home.joinpath('mock-environment.json').write_text(json.dumps({'home':str(home),'cwd':os.getcwd(),'openai_key':os.environ.get('OPENAI_API_KEY'),'codex_thread':os.environ.get('CODEX_THREAD_ID')}))
account=None
pending=False
counter=0
def send(message):
 print(json.dumps(message),flush=True)
for line in sys.stdin:
 m=json.loads(line)
 with audit.open('a') as f:f.write(json.dumps(m)+'\n')
 method=m.get('method'); p=m.get('params',{}); i=m.get('id')
 if i is None or not method:continue
 result={}
 if method=='initialize':result={'userAgent':'official-runtime-mock'}
 elif method=='account/read':
  if pending:
   pending=False;account={'type':'chatgpt','email':'test@example.invalid','planType':'plus','accessToken':'must-not-leak'}
   send({'method':'account/login/completed','params':{'loginId':'login-test','success':True}})
  result={'account':account,'requiresOpenaiAuth':True}
 elif method=='account/login/start':
  pending=True
  url='https://auth.openai.com/oauth/authorize?state=test'
  if '--bad-login' in sys.argv:url='https://auth.openai.com.evil.invalid/steal'
  result={'type':'chatgpt','loginId':'login-test','authUrl':url}
 elif method=='account/login/cancel':pending=False;result={'status':'canceled'}
 elif method=='account/logout':account=None
 elif method=='model/list':result={'data':[{'id':'model-test','model':'model-test','displayName':'Test model','isDefault':True,'inputModalities':['text','image'],'hidden':False,'privateToken':'must-not-leak','defaultReasoningEffort':'medium','supportedReasoningEfforts':[{'reasoningEffort':x,'description':'Official '+x,'privateToken':'must-not-leak'} for x in ('low','medium','high','xhigh','max','ultra')]},{'id':'model-lite','model':'model-lite','displayName':'Lite','isDefault':False,'defaultReasoningEffort':'none','supportedReasoningEfforts':[{'reasoningEffort':'none','description':'No reasoning'},{'reasoningEffort':'minimal','description':'Minimal reasoning'}]}],'nextCursor':None}
 elif method=='thread/start':
  counter+=1;result={'thread':{'id':'thread-'+str(counter)}}
  if not(p['environments']==[] and p['sandbox']=='read-only' and p['approvalPolicy']=='never' and p['config']['features.shell_tool'] is False):raise Exception('unsafe thread config')
 elif method=='turn/start':
  if p.get('summary')!='auto':raise Exception('public reasoning summaries must be explicitly requested')
  result={'turn':{'id':'turn-'+str(counter)}}
 elif method in ('turn/interrupt','thread/unsubscribe'):result={}
 elif method=='fake/error':send({'id':i,'error':{'message':'accessToken: must-not-leak'}});continue
 send({'id':i,'result':result})
 if method=='turn/start':
  thread=p['threadId'];turn='turn-'+str(counter)
  text=' '.join(x.get('text','') for x in p['input'])
  if 'HOLD' not in text:
   if 'WEB_SEARCH' in text:
    if not startup.get('features.code_mode_host'):raise Exception('code-mode host is disabled at process startup')
    web={'id':'observed-web','type':'webSearch','query':'official docs','action':{'type':'search','query':'official docs'},'results':[{'url':'https://developers.openai.com/example','title':'Official source','raw':'PRIVATE WEB RESULT'},{'url':'javascript:alert(1)','title':'unsafe'}]}
    send({'method':'item/started','params':{'threadId':thread,'turnId':turn,'item':web}})
    send({'method':'item/completed','params':{'threadId':thread,'turnId':turn,'item':web}})
   if 'PHASES' in text or 'LEGACY' in text:
    explicit='PHASES' in text
    for item_id,phase,content in [('progress','commentary','Working on it'),('answer','final_answer','{"actions":[]}')]:
     item={'id':item_id,'type':'agentMessage','text':'','phase':phase if explicit else None}
     send({'method':'item/started','params':{'threadId':thread,'turnId':turn,'item':item}})
     send({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':turn,'itemId':item_id,'delta':content}})
     item['text']=content
     send({'method':'item/completed','params':{'threadId':thread,'turnId':turn,'item':item}})
    send({'method':'item/reasoning/textDelta','params':{'threadId':thread,'turnId':turn,'delta':'RAW REASONING NEVER EXPOSE'}})
    send({'method':'item/reasoning/summaryTextDelta','params':{'threadId':thread,'turnId':turn,'delta':'Public summary'}})
   else:
    send({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':turn,'delta':'Hello '}})
    send({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':turn,'delta':'world'}})
   send({'id':'tool-request','method':'item/commandExecution/requestApproval','params':{'command':'never execute me'}})
   send({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'completed'}}})
'''


def assert_error(call, status, code=None):
    try: call()
    except BridgeError as error:
        assert error.status == status, str(error)
        if code: assert error.code == code
        assert 'must-not-leak' not in str(error)
    else: raise AssertionError('expected BridgeError')


def request(origin, route, body=None, headers=None):
    headers = headers or {}
    if body is not None: headers = {'Content-Type': 'application/json', **headers}
    payload = json.dumps(body).encode() if body is not None else None
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(urllib.request.Request(origin + route, data=payload, headers=headers), timeout=15)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()
    with response: return response.status, response.headers, response.read()


def test_generation_waiting(directory):
    """Exercise long generation and cancellation without a real runtime."""
    class Clock:
        now = 0
        def monotonic(self): return self.now

    class TimedEvents:
        def __init__(self, clock, scheduled):
            self.clock, self.scheduled = clock, list(scheduled)
        def get(self, timeout):
            assert 0 < timeout <= 3
            if self.scheduled and self.scheduled[0][0] <= self.clock.now + timeout:
                self.clock.now, event = self.scheduled.pop(0)
                return event
            self.clock.now += timeout
            raise queue.Empty

    class FakeBridge(CodexBridge):
        def __init__(self):
            super().__init__(directory / 'clock-only', command=[])
            self.calls = []
        def rpc(self, method, params):
            self.calls.append((method, params))
            if method == 'thread/start': return {'thread': {'id': 'current-thread'}}
            if method == 'turn/start': return {'turn': {'id': 'current-turn'}}
            raise AssertionError(method)
        def _request(self, method, params, timeout=15):
            assert method in ('turn/interrupt', 'thread/unsubscribe')
            self.calls.append((method, params))
            return {}

    def event(method='item/agentMessage/delta', **params):
        return {'method': method, 'params': {'threadId': 'current-thread', 'turnId': 'current-turn', **params}}

    def done(**params):
        return event('turn/completed', turnId=None, turn={'id': 'current-turn', 'status': 'completed'}, **params)

    def run(scheduled, expected_time, completed=False):
        clock, bridge = Clock(), FakeBridge()
        events = TimedEvents(clock, scheduled)
        with patch.object(bridge_module.queue, 'Queue', return_value=events), patch.object(bridge_module.time, 'monotonic', clock.monotonic):
            results = list(bridge.respond('fixture-model', [{'type': 'text', 'text': 'fixture'}]))
        assert clock.now == expected_time, (clock.now, expected_time)
        assert bridge.subscribers == {}
        assert sum(method == 'thread/unsubscribe' for method, _ in bridge.calls) == 1
        assert sum(method == 'turn/interrupt' for method, _ in bridge.calls) == (0 if completed else 1)
        if not completed:
            assert results[-1]['type'] == 'response.failed'
        return results

    # Legacy JSON stays buffered through long silent intervals, without idle
    # or total generation cutoffs. A matching nested turn id completes.
    results = run([(300, event(delta='{"actions":')), (900, event(delta='[')), (1800, event(delta=']}')), (3600, done())], 3600, completed=True)
    assert results[-1] == {'type': 'response.completed', 'response': {'output_text': '{"actions":[]}'}}
    assert sum(result.get('progress') is True for result in results) == 3

    # Private reasoning and plan deltas are progress only; raw text must never
    # enter SSE, even when they are the only activity during generation.
    results = run([(100, event('item/reasoning/textDelta', delta='private reasoning fixture')), (210, event('item/plan/delta', delta='private plan fixture')), (320, event('item/reasoning/summaryTextDelta', delta='Visible summary')), (420, event(delta='answer')), (430, done())], 430, completed=True)
    assert 'private' not in json.dumps(results)
    assert any(result.get('delta') == 'Visible summary' for result in results)
    assert sum(result.get('progress') is True for result in results) == 4

    # Half an hour with no model output still waits for completion. Empty
    # queues emit three-second keepalives, never synthetic model progress.
    results = run([(1800, done())], 1800, completed=True)
    assert results[-1] == {'type': 'response.completed', 'response': {'output_text': ''}}
    assert len(results) > 500 and not any(result.get('progress') for result in results)
    assert not any(result['type'] == 'response.failed' for result in results)

    irrelevant = [
        event(delta='wrong thread', threadId='old-thread'),
        event(delta='wrong turn', turnId='old-turn'),
        event(delta='unscoped', turnId=None),
        event('turn/completed', turnId=None, turn={'id': 'old-turn', 'status': 'completed'}),
        event('turn/completed', turn={'id': 'old-turn', 'status': 'completed'}),
        event('thread/tokenUsage/updated', delta='not model text'),
        event('turn/started'),
        event('item/agentMessage/delta', delta=''),
        event('item/reasoning/textDelta', delta=''),
        event('item/started', item={'id': 'not-work', 'type': 'heartbeat'}),
        {'method': 'item/agentMessage/delta', 'params': ['invalid']},
    ]
    for notification in irrelevant:
        results = run([(90, notification), (900, done())], 900, completed=True)
        assert results[-1]['type'] == 'response.completed', notification
        assert not any(result.get('progress') for result in results), notification
        assert not any(result.get('delta') for result in results), notification

    # Duplicated lifecycle notifications cannot masquerade as new work. Each
    # unique item boundary can count once, and a new phase can count once.
    item = {'id': 'reasoning-item', 'type': 'reasoning'}
    results = run([(10, event('item/started', item=item)), (100, event('item/started', item=item)), (900, done())], 900, completed=True)
    assert sum(result.get('progress') is True for result in results) == 1
    results = run([(100, event('item/started', item=item)), (210, event('item/completed', item=item)), (320, done())], 320, completed=True)
    assert sum(result.get('progress') is True for result in results) == 2

    # Continuous generation also crosses the old total limit without an
    # interrupt or failure; every streamed fragment reaches completion.
    results = run([(second, event(delta='x')) for second in range(100, 1201, 100)] + [(1500, done())], 1500, completed=True)
    assert results[-1] == {'type': 'response.completed', 'response': {'output_text': 'x' * 12}}
    assert sum(result.get('progress') is True for result in results) == 12

    results = run([(20, {'method': '_runtime_closed', 'params': {}})], 20)
    assert results[-1]['error']['code'] == 'codex_unavailable'
    results = run([(20, event('turn/completed', turn={'id': 'current-turn', 'status': 'interrupted'}))], 20, completed=True)
    assert results[-1]['error']['code'] == 'codex_turn_failed'

    # Only public summary fields and tool identity/lifecycle metadata cross
    # the bridge. Private reasoning, tool inputs and outputs stay excluded.
    tool = {'id': 'tool-item', 'type': 'mcpToolCall', 'tool': 'pdf.read', 'status': 'inProgress', 'arguments': {'token': 'PRIVATE ARG'}, 'result': 'PRIVATE RESULT'}
    results = run([
        (1, event('item/reasoning/summaryTextDelta', itemId='summary-item', summaryIndex=0, delta='正在查看课件。')),
        (2, event('item/completed', item={'id': 'summary-item', 'type': 'reasoning', 'summary': ['正在查看课件。', {'type': 'summary_text', 'text': '核对公开图表。'}, {'type': 'reasoning_text', 'text': 'PRIVATE MISLABEL'}], 'content': ['PRIVATE RAW'], 'encrypted_content': 'PRIVATE ENCRYPTED'})),
        (3, event('item/started', item=tool)),
        (4, event('item/commandExecution/outputDelta', itemId='tool-item', delta='PRIVATE STDOUT')),
        (5, event('item/completed', item={**tool, 'status': 'completed', 'result': 'PRIVATE RESULT'})),
        (6, event('item/completed', item={**tool, 'id': 'failed-tool', 'status': 'failed', 'error': {'message': 'PRIVATE ERROR'}})),
        (7, event('item/completed', turnId='old-turn', item={**tool, 'id': 'wrong-turn-tool', 'status': 'completed'})),
        (8, done()),
    ], 8, completed=True)
    assert 'PRIVATE' not in json.dumps(results)
    summaries = [entry for entry in results if entry['type'] == 'response.reasoning_summary_text.done']
    assert [entry['text'] for entry in summaries] == ['正在查看课件。', '核对公开图表。']
    assert summaries[1]['summary_index'] == 1 and summaries[1]['item_id'] == 'summary-item'
    activities = [entry for entry in results if entry['type'] == 'response.tool_activity']
    assert [(entry['id'], entry['name'], entry['status']) for entry in activities] == [('tool-item', 'pdf.read', 'running'), ('tool-item', 'pdf.read', 'completed'), ('failed-tool', 'pdf.read', 'failed')]
    assert all(set(entry) == {'type', 'id', 'kind', 'name', 'status', 'text'} for entry in activities)
    results = run([(1, event('item/reasoning/summaryTextDelta', itemId='long-summary', delta='x' * 9000)), (2, event('item/reasoning/summaryTextDelta', itemId='long-summary', delta='y' * 9000)), (3, event('item/started', item={'id': 'long-name', 'type': 'commandExecution', 'tool': 'PRIVATE ' * 100, 'command': 'PRIVATE COMMAND'})), (4, done())], 4, completed=True)
    assert sum(len(entry.get('delta', '')) for entry in results) == 4000
    assert 'PRIVATE' not in json.dumps(results)

    # Closing at a progress yield still interrupts precisely the current turn
    # and removes its subscriber; canceling before turn/start does not start it.
    for cancel_before_turn in (True, False):
        clock, bridge = Clock(), FakeBridge()
        with patch.object(bridge_module.queue, 'Queue', return_value=TimedEvents(clock, [(10, event(delta='pending'))])), patch.object(bridge_module.time, 'monotonic', clock.monotonic):
            stream = bridge.respond(None, [{'type': 'text', 'text': 'fixture'}])
            next(stream)
            if not cancel_before_turn:
                next(stream)
                while not next(stream).get('progress'): pass
            stream.close()
        assert bridge.subscribers == {}
        assert sum(method == 'turn/start' for method, _ in bridge.calls) == (0 if cancel_before_turn else 1)
        assert sum(method == 'turn/interrupt' for method, _ in bridge.calls) == (0 if cancel_before_turn else 1)
        assert [params for method, params in bridge.calls if method == 'thread/unsubscribe'] == [{'threadId': 'current-thread'}]
        if not cancel_before_turn:
            assert [params for method, params in bridge.calls if method == 'turn/interrupt'] == [{'threadId': 'current-thread', 'turnId': 'current-turn'}]
    # Cancellation remains possible after a long completely silent interval.
    # Closing at the next heartbeat interrupts immediately, without waiting
    # for a model delta or completion notification.
    clock, bridge = Clock(), FakeBridge()
    with patch.object(bridge_module.queue, 'Queue', return_value=TimedEvents(clock, [])), patch.object(bridge_module.time, 'monotonic', clock.monotonic):
        stream = bridge.respond(None, [{'type': 'text', 'text': 'fixture'}])
        while clock.now < 1800:
            assert next(stream) == {'type': 'response.in_progress'}
        assert not any(method == 'turn/interrupt' for method, _ in bridge.calls)
        canceled_at = clock.now
        stream.close()
    assert clock.now == canceled_at
    assert bridge.subscribers == {}
    assert [params for method, params in bridge.calls if method == 'turn/interrupt'] == [{'threadId': 'current-thread', 'turnId': 'current-turn'}]
    assert [params for method, params in bridge.calls if method == 'thread/unsubscribe'] == [{'threadId': 'current-thread'}]
    print('Codex unlimited generation waiting, scoped progress, keepalives, and cancellation tests passed')


with tempfile.TemporaryDirectory(prefix='workstation-codex-test-') as temporary:
    directory = Path(temporary)
    assert request_config() == SAFE_CONFIG
    assert request_config(True) == {**SAFE_CONFIG, 'features.code_mode_host': True, 'web_search': 'live'}
    assert runtime_config() == {**SAFE_CONFIG, 'features.code_mode_host': True}
    assert runtime_config()['web_search'] == 'disabled'
    assert SAFE_CONFIG['features.code_mode_host'] is False
    assert SAFE_CONFIG['orchestrator.skills.enabled'] is False
    assert SAFE_CONFIG['orchestrator.mcp.enabled'] is False
    assert SAFE_CONFIG['skills.include_instructions'] is False
    for config in (runtime_config(), request_config(True), request_config(False)):
        assert all(config[key] is False for key in ('features.shell_tool', 'features.unified_exec', 'features.multi_agent', 'features.apps', 'features.browser_use', 'features.browser_use_external', 'features.computer_use', 'features.skill_search', 'features.skill_mcp_dependency_install', 'features.view_image', 'tools.view_image'))
    assert SAFE_CONFIG['web_search'] == 'disabled', 'Per-request access must not mutate the isolated runtime default'
    for value in (None, 1, 'true', {}, []): assert_error(lambda value=value: request_config(value), 400, 'invalid_web_search')
    assert web_sources({'type': 'mcpToolCall', 'results': [{'url': 'https://example.invalid'}]}) == []
    assert web_sources({'type': 'webSearch', 'action': {'type': 'openPage', 'url': 'https://example.invalid/page'}, 'results': [{'url': 'file:///private/key'}, {'url': 'https://user:password@example.invalid/'}, {'url': 'https://example.invalid/page', 'title': 'Read page', 'secret': 'PRIVATE'}]}) == [{'url': 'https://example.invalid/page', 'title': 'Read page', 'type': 'web_source'}]
    test_generation_waiting(directory)
    script = directory / 'mock-runtime.py'
    script.write_text(MOCK_RUNTIME)
    bridge = CodexBridge(directory / 'store', command=[sys.executable, str(script)])
    try:
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'must-not-inherit', 'CODEX_THREAD_ID': 'other-app-thread'}):
            status = bridge.status()
        assert status['available'] and not status['authenticated'] and status['account'] is None
        environment = json.loads((bridge.home / 'mock-environment.json').read_text())
        assert json.loads((bridge.home / 'mock-startup.json').read_text()) == runtime_config(), 'The executor must be initialized at runtime startup, while search remains request-scoped'
        assert environment == {'home': str(bridge.home), 'cwd': str(bridge.cwd), 'openai_key': None, 'codex_thread': None}
        assert bridge.home != Path.home() / '.codex'
        assert bridge.home.stat().st_mode & 0o777 == 0o700
        assert_error(lambda: bridge.prepare({'input': 'Hello'}), 401)
        assert_error(lambda: bridge.prepare({'input': 'Hello', 'webSearch': 'true'}), 400, 'invalid_web_search')
        assert_error(lambda: bridge.models(), 401)
        login = bridge.login_start()
        assert login['authUrl'].startswith('https://auth.openai.com/') and bridge.login['pending']
        assert bridge.login_start() == login, 'Repeated clicks must reuse the pending login'
        assert 'authUrl' not in bridge.login
        assert bridge.cancel_login() == {'ok': True} and not bridge.login['pending']
        bridge.login_start()
        status = bridge.status()
        assert status['authenticated'] and not status['login']['pending']
        assert status['account'] == {'email': 'test@example.invalid', 'planType': 'plus'}
        assert 'must-not-leak' not in json.dumps(status)
        models = bridge.models()
        assert models['data'][0]['id'] == 'model-test'
        assert models['data'][0]['defaultReasoningEffort'] == 'medium'
        assert models['data'][0]['supportedReasoningEfforts'][0] == {'reasoningEffort': 'low', 'description': 'Official low'}
        assert models['data'][1]['defaultReasoningEffort'] == 'none'
        assert 'must-not-leak' not in json.dumps(models)
        assert_error(lambda: bridge.rpc('fake/error'), 502)

        for invalid in ('HIGH', 3, {}, 'high;run', ' xhigh'):
            assert_error(lambda: bridge.prepare({'model': 'model-test', 'input': 'Hello', 'effort': invalid}), 400, 'invalid_effort')
        for model_id, unsupported in (('model-lite', 'high'), ('model-test', 'minimal'), ('missing', 'medium'), ('model-test', 'invented')):
            assert_error(lambda: bridge.prepare({'model': model_id, 'input': 'Hello', 'effort': unsupported}), 400, 'unsupported_effort')
        for automatic in (None, '', 'auto'):
            assert bridge.prepare({'input': 'Hello', 'effort': automatic})[2] is None
        assert bridge.prepare({'input': 'Hello', 'effort': 'high'})[2] == 'high', 'Explicit strength resolves against the advertised default model'
        assert bridge.prepare({'model': 'model-lite', 'input': 'Hello', 'effort': 'none'})[2] == 'none'
        assert bridge.prepare({'model': 'model-lite', 'input': 'Hello', 'effort': 'minimal'})[2] == 'minimal'
        assert bridge.prepare({'model': 'model-test', 'input': 'Hello', 'effort': 'ultra'})[2] == 'ultra', 'Advertised model capabilities govern strength, not a stale hardcoded enum'

        model, inputs, effort = bridge.prepare({'model': 'model-test', 'input': 'Hello', 'effort': 'high'})
        events = list(bridge.respond(model, inputs, effort))
        assert ''.join(event.get('delta', '') for event in events) == 'Hello world'
        assert events[-1] == {'type': 'response.completed', 'response': {'output_text': 'Hello world'}}
        for mode in ('PHASES', 'LEGACY'):
            model, inputs, effort = bridge.prepare({'input': mode})
            events = list(bridge.respond(model, inputs, effort))
            answer = ''.join(event.get('delta', '') for event in events if event['type'] == 'response.output_text.delta')
            assert answer == '{"actions":[]}', 'Progress commentary must not corrupt structured output'
            assert json.loads(answer) == {'actions': []}
            assert 'RAW REASONING NEVER EXPOSE' not in json.dumps(events)
            if mode == 'PHASES': assert any(event.get('source') == 'commentary' for event in events)
            assert any(event.get('source') == 'summary' for event in events)
        model, inputs, effort = bridge.prepare({'input': 'HOLD'})
        stream = bridge.respond(model, inputs, effort)
        assert next(stream)['type'] == 'response.in_progress'
        assert next(stream)['type'] == 'response.in_progress'
        stream.close()
        audit = [json.loads(line) for line in (bridge.home / 'mock-audit.jsonl').read_text().splitlines()]
        assert any(entry.get('method') == 'turn/interrupt' for entry in audit)
        assert any(entry.get('id') == 'tool-request' and 'error' in entry for entry in audit)
        assert not any(entry.get('method') in ('command/exec', 'thread/shellCommand') for entry in audit)
        starts = [entry['params'] for entry in audit if entry.get('method') == 'thread/start']
        assert all(item['dynamicTools'] == [] and item['runtimeWorkspaceRoots'] == [] and item['selectedCapabilityRoots'] == [] for item in starts)
        assert all(item['config'] == SAFE_CONFIG for item in starts)
        assert all(item['allowProviderModelFallback'] is False for item in starts)
        assert all('knowledgeRequests' in item['developerInstructions'] and 'JSON requests are allowed' in item['developerInstructions'] for item in starts)
        assert all('No direct filesystem' in item['developerInstructions'] for item in starts)
        assert all('host executes only this final JSON' in item['developerInstructions'] for item in starts)
        turns = [entry['params'] for entry in audit if entry.get('method') == 'turn/start']
        assert all(item.get('summary') == 'auto' for item in turns), 'The local official channel must explicitly request public reasoning summaries'
        assert turns[0]['effort'] == 'high'
        assert all('effort' not in item for item in turns[1:]), 'Automatic requests must not pin a reasoning effort'
        model, inputs, effort = bridge.prepare({'input': 'WEB_SEARCH', 'webSearch': True})
        web_events = list(bridge.respond(model, inputs, effort, web_search=True))
        assert [event['status'] for event in web_events if event['type'] == 'response.tool_activity'] == ['running', 'completed']
        assert [event['sources'] for event in web_events if event['type'] == 'response.web_sources'] == [[{'url': 'https://developers.openai.com/example', 'title': 'Official source', 'type': 'web_source'}]]
        assert 'PRIVATE WEB RESULT' not in json.dumps(web_events) and 'javascript:' not in json.dumps(web_events)
        web_audit = [json.loads(line) for line in (bridge.home / 'mock-audit.jsonl').read_text().splitlines()]
        web_start = [entry['params'] for entry in web_audit if entry.get('method') == 'thread/start'][-1]
        assert web_start['config'] == request_config(True)
        assert web_start['environments'] == [] and web_start['dynamicTools'] == [] and web_start['sandbox'] == 'read-only'
        assert 'official hosted web search' in web_start['developerInstructions']
        assert 'No filesystem, shell, network' not in web_start['developerInstructions']
        list(bridge.respond(None, [{'type': 'text', 'text': 'After search without permission'}]))
        fresh_audit = [json.loads(line) for line in (bridge.home / 'mock-audit.jsonl').read_text().splitlines()]
        assert [entry['params'] for entry in fresh_audit if entry.get('method') == 'thread/start'][-1]['config'] == SAFE_CONFIG

        # Attach only this fake runtime to a real loopback HTTP server. All
        # user state remains untouched and every model response is simulated.
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': str(directory / 'http-store')}):
            import server
        old_bridge = server.CODEX_BRIDGE
        server.CODEX_BRIDGE = bridge
        class QuietHandler(server.Handler):
            def log_message(self, *args): pass
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        origin = f'http://127.0.0.1:{httpd.server_port}'
        try:
            assert request(origin, '/__auth/status')[0] == 200
            assert request(origin, '/__auth/status', headers={'Origin': 'https://evil.invalid'})[0] == 403
            host_result = request(origin, '/__auth/status', headers={'Host': 'evil.invalid'}); assert host_result[0] == 403, host_result
            assert request(origin, '/__auth/login', {})[0] == 403
            assert request(origin, '/__auth/login', {}, headers={'Origin': 'null'})[0] == 403
            assert request(origin, '/__auth/logout', {}, headers={'Origin': 'https://evil.invalid'})[0] == 403
            assert request(origin, '/__codex/respond', {'input': 'Hello'}, headers={'Origin': origin, 'Sec-Fetch-Site': 'cross-site'})[0] == 403
            code, _, data = request(origin, '/__codex/respond', {'input': 'Hello', 'webSearch': 1}, headers={'Origin': origin})
            assert code == 400 and json.loads(data)['error']['code'] == 'invalid_web_search'
            invalid_file = {'input': [{'role': 'user', 'content': [{'type': 'input_file', 'file_data': 'data:application/pdf;base64,AA=='}]}]}
            code, _, data = request(origin, '/__codex/respond', invalid_file, headers={'Origin': origin})
            assert code == 400 and json.loads(data)['error']['code'] == 'unsupported_file_input'
            code, _, data = request(origin, '/__auth/models')
            assert code == 200 and json.loads(data)['data'][0]['defaultReasoningEffort'] == 'medium'
            code, _, data = request(origin, '/__codex/respond', {'model': 'model-lite', 'effort': 'high', 'input': 'Hello'}, headers={'Origin': origin})
            assert code == 400 and json.loads(data)['error']['code'] == 'unsupported_effort'
            code, headers, data = request(origin, '/__codex/respond', {'input': 'Hello', 'model': 'model-test', 'effort': 'xhigh'}, headers={'Origin': origin})
            assert code == 200 and 'text/event-stream' in headers['Content-Type']
            assert 'response.output_text.delta' in data.decode() and 'response.completed' in data.decode()
            assert headers['Cache-Control'] == 'no-store'
            latest_audit = [json.loads(line) for line in (bridge.home / 'mock-audit.jsonl').read_text().splitlines()]
            assert [entry['params'] for entry in latest_audit if entry.get('method') == 'turn/start'][-1]['effort'] == 'xhigh'
            code, _, data = request(origin, '/__codex/respond', {'input': 'WEB_SEARCH', 'webSearch': True}, headers={'Origin': origin})
            assert code == 200 and b'response.tool_activity' in data and b'response.web_sources' in data
            latest_audit = [json.loads(line) for line in (bridge.home / 'mock-audit.jsonl').read_text().splitlines()]
            assert [entry['params'] for entry in latest_audit if entry.get('method') == 'thread/start'][-1]['config'] == request_config(True)
            # Reset a real HTTP stream and verify the running mock turn is
            # interrupted instead of continuing after a canceled fetch.
            socket_client = socket.create_connection(('127.0.0.1', httpd.server_port))
            body = json.dumps({'input': 'HOLD'}).encode()
            message = f'POST /__codex/respond HTTP/1.1\r\nHost: 127.0.0.1:{httpd.server_port}\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body
            interrupt_count = sum(entry.get('method') == 'turn/interrupt' for entry in audit)
            socket_client.sendall(message)
            socket_client.recv(8192)
            time.sleep(0.1)
            socket_client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
            socket_client.close()
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                entries = [json.loads(line) for line in (bridge.home / 'mock-audit.jsonl').read_text().splitlines()]
                if sum(entry.get('method') == 'turn/interrupt' for entry in entries) > interrupt_count: break
                time.sleep(0.1)
            else: raise AssertionError('HTTP disconnect did not cancel the model turn')
            assert request(origin, '/__auth/logout', {}, headers={'Origin': origin})[0] == 200
            assert not bridge.status()['authenticated']
        finally:
            httpd.shutdown(); httpd.server_close(); thread.join(timeout=3)
            server.CODEX_BRIDGE = old_bridge
    finally: bridge.close()

    unsafe = CodexBridge(directory / 'bad-login', command=[sys.executable, str(script), '--bad-login'])
    try: assert_error(unsafe.login_start, 502, 'invalid_login_url')
    finally: unsafe.close()
    absent = CodexBridge(directory / 'missing', command=[])
    assert absent.status()['available'] is False
    linked = CodexBridge(directory / 'linked-home', command=[sys.executable, str(script)])
    linked.home.parent.mkdir()
    external = directory / 'external-auth'
    external.mkdir()
    linked.home.symlink_to(external, target_is_directory=True)
    assert_error(linked.ensure, 503)
    assert not list(external.iterdir()), 'Linked external credentials directories must never be read or modified'

    for value in (None, [], [{'type': 'localImage', 'path': '/private/file'}], [{'type': 'skill', 'path': '/private/skill'}]):
        assert_error(lambda: convert_input(value), 400)
    image = convert_input([{'role': 'user', 'content': [{'type': 'input_text', 'text': 'Read this'}, {'type': 'input_image', 'image_url': 'data:image/png;base64,AA=='}]}])
    assert image == [{'type': 'text', 'text': 'Read this'}, {'type': 'image', 'url': 'data:image/png;base64,AA=='}]

    # Genuine installed runtime: initialize/account-read, schema generation,
    # and a local ephemeral thread. No login/start or turn/start is sent.
    command = runtime_command() if os.environ.get('AI_WORKSTATION_CODEX_RUNTIME_SMOKE') != '0' else None
    if command:
        real = CodexBridge(directory / 'genuine')
        try:
            status = real.status()
            assert status['available'] and not status.get('error'), status
            assert status['account'] is None and status['authenticated'] is False
            schema_dir = directory / 'schema'
            subprocess.run([*command, 'app-server', 'generate-json-schema', '--experimental', '--out', str(schema_dir)], env={**os.environ, 'CODEX_HOME': str(real.home)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=15)
            start = json.loads((schema_dir / 'v2' / 'ThreadStartParams.json').read_text())
            assert {'environments', 'dynamicTools', 'sandbox', 'ephemeral', 'config'} <= set(start['properties'])
            turn = json.loads((schema_dir / 'v2' / 'TurnStartParams.json').read_text())
            assert {'input', 'threadId', 'environments', 'sandboxPolicy', 'effort', 'summary'} <= set(turn['properties'])
            summary = turn['definitions']['ReasoningSummary']
            assert any('auto' in option.get('enum', []) for option in summary.get('oneOf', [])), 'Installed runtime must support public summary=auto'
            started = real.rpc('thread/start', {'modelProvider': 'openai', 'cwd': str(real.cwd), 'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True, 'environments': [], 'dynamicTools': [], 'runtimeWorkspaceRoots': [], 'selectedCapabilityRoots': [], 'config': SAFE_CONFIG})
            assert started['sandbox'] == {'type': 'readOnly', 'networkAccess': False}
            assert started['approvalPolicy'] == 'never'
            real.rpc('thread/unsubscribe', {'threadId': started['thread']['id']})
            live = real.rpc('thread/start', {'modelProvider': 'openai', 'cwd': str(real.cwd), 'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True, 'environments': [], 'dynamicTools': [], 'runtimeWorkspaceRoots': [], 'selectedCapabilityRoots': [], 'config': request_config(True)})
            assert live['sandbox'] == {'type': 'readOnly', 'networkAccess': False} and live['approvalPolicy'] == 'never'
            real.rpc('thread/unsubscribe', {'threadId': live['thread']['id']})
        finally: real.close()
    else: print('Genuine runtime smoke skipped: disabled or Codex CLI is not installed')

print('Codex auth isolation, lifecycle, model filtering, stream, cancellation, HTTP origins and runtime smoke tests passed')
