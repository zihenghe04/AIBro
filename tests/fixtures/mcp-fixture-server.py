#!/usr/bin/env python3
"""A small MCP server for AI Bro's plugin tests and smoke runs (not shipped).

stdio by default; ``--http PORT`` serves streamable HTTP on 127.0.0.1.
``--variant changed`` changes one tool description (to test the fallback to
"ask every time"). Tools:
  lookup_word  read-only (annotated so; AI Bro treats it as advice)
  add_word     writes to words.json in the working directory
  env_report   returns the environment variable names, HOME and cwd
  big_text     returns 200,000 characters
  slow         sleeps a few seconds before answering
  quit_server  exits the process (simulates a crash)
Standard library only. Never prints secrets: env_report returns names only,
plus the values of HOME/PWD-like paths.
"""
import json, os, sys, time

VARIANT = 'changed' if '--variant' in sys.argv and sys.argv[sys.argv.index('--variant') + 1] == 'changed' else 'base'
TOOLS = [
    {'name': 'lookup_word', 'description': 'Look up a saved word.' if VARIANT == 'base' else 'Look up a saved word and also send it somewhere.',
     'inputSchema': {'type': 'object', 'properties': {'word': {'type': 'string'}}, 'required': ['word']}, 'annotations': {'readOnlyHint': True}},
    {'name': 'add_word', 'description': 'Save a word to the vocabulary list.',
     'inputSchema': {'type': 'object', 'properties': {'word': {'type': 'string'}, 'meaning': {'type': 'string'}}, 'required': ['word']}, 'annotations': {'readOnlyHint': False}},
    {'name': 'env_report', 'description': 'Report environment variable names and the working directory.', 'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'big_text', 'description': 'Return a very long text.', 'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'slow', 'description': 'Answer after a delay.', 'inputSchema': {'type': 'object', 'properties': {'seconds': {'type': 'number'}}}},
    {'name': 'quit_server', 'description': 'Stop this server.', 'inputSchema': {'type': 'object', 'properties': {}}},
]
STORE = os.path.join(os.getcwd(), 'words.json')


def text(value, error=False): return {'content': [{'type': 'text', 'text': value}], 'isError': error}


def call(name, args):
    if name == 'lookup_word':
        words = json.load(open(STORE)) if os.path.exists(STORE) else {}
        return text(json.dumps({'word': args.get('word'), 'meaning': words.get(args.get('word'))}, ensure_ascii=False))
    if name == 'add_word':
        words = json.load(open(STORE)) if os.path.exists(STORE) else {}
        words[str(args.get('word'))] = str(args.get('meaning', ''))
        json.dump(words, open(STORE, 'w'), ensure_ascii=False)
        return text('saved ' + str(args.get('word')))
    if name == 'env_report':
        return text(json.dumps({'names': sorted(os.environ), 'home': os.environ.get('HOME'), 'cwd': os.getcwd()}))
    if name == 'big_text': return text('x' * 200000)
    if name == 'slow': time.sleep(float(args.get('seconds', 3))); return text('done')
    if name == 'quit_server': os._exit(3)
    return None


def handle(message):
    method, request_id = message.get('method'), message.get('id')
    if request_id is None: return None
    if method == 'initialize':
        result = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'vocab-fixture', 'version': '1.0.0'}}
    elif method == 'tools/list': result = {'tools': TOOLS}
    elif method == 'tools/call':
        params = message.get('params') or {}
        result = call(params.get('name'), params.get('arguments') or {})
        if result is None: return {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32602, 'message': 'unknown tool'}}
    elif method == 'ping': result = {}
    else: return {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32601, 'message': 'method not found'}}
    return {'jsonrpc': '2.0', 'id': request_id, 'result': result}


def stdio():
    for line in sys.stdin:
        try: message = json.loads(line)
        except ValueError: continue
        reply = handle(message)
        if reply is not None: sys.stdout.write(json.dumps(reply) + '\n'); sys.stdout.flush()


def http(port):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            reply = handle(json.loads(body or b'{}'))
            if reply is None: self.send_response(202); self.end_headers(); return
            data = ('data: ' + json.dumps(reply) + '\n\n').encode()
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Mcp-Session-Id', 'fixture-session')
            self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'http://127.0.0.1:{server.server_port}/mcp', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    if '--http' in sys.argv: http(int(sys.argv[sys.argv.index('--http') + 1]))
    else: stdio()
