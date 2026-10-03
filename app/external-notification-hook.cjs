#!/usr/bin/env node
'use strict';
// Manual, opt-in adapter. Never edits agent configuration, reads transcripts,
// chains another executable, or sends contents outside numeric loopback.
// Protocol reference: TO-DO Panel 1deb3cac (MIT; docs/licenses/to-do-panel-MIT.txt).
// node external-notification-hook.cjs --endpoint /absolute/endpoint.json --source codex '<hook JSON>'
// Claude Stop can pipe its JSON to the same command with --source claude.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const LIMIT = 64 * 1024;

function endpoint(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('invalid endpoint file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 4096 || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('unprotected endpoint');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const url = new URL(value.url);
    if (value.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
        !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        typeof value.token !== 'string' || !/^[0-9a-f]{64}$/.test(value.token)) throw new Error('invalid endpoint');
    return { port: Number(url.port), token: value.token };
  } finally { fs.closeSync(fd); }
}

function normalize(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.agent_id || payload['agent-id'] || payload.agentId || payload.is_subagent === true || payload.isSubagent === true) return null;
  const result = {};
  for (const key of ['event_id','event-id','eventId','turn_id','turn-id','turnId','thread_id','thread-id','threadId',
    'session_id','session-id','sessionId','hook_event_name','hook-event-name','hookEventName','type','event','status',
    'title','task_title','task-title','taskTitle','last_assistant_message','last-assistant-message','lastAssistantMessage',
    'message','detail','summary','project','project_name','project-name','projectName']) {
    if (typeof payload[key] === 'string') result[key] = payload[key];
  }
  // A display basename is sufficient. No full source path leaves this hook.
  const cwd = payload.cwd || payload.working_directory || payload['working-directory'];
  if (!result.project && typeof cwd === 'string' && path.isAbsolute(cwd)) result.project = path.basename(cwd);
  return result;
}

function readStdin(stream = process.stdin) {
  return new Promise(resolve => {
    if (stream.isTTY) return resolve(null);
    let chunks = [], size = 0, settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); stream.pause(); resolve(value); };
    const timer = setTimeout(() => finish(null), 1000);
    stream.on('data', chunk => { size += chunk.length; if (size > LIMIT) finish(null); else if (!settled) chunks.push(chunk); });
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => finish(null));
  });
}

function post(target, source, payload) {
  return new Promise(resolve => {
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length > LIMIT) return resolve(false);
    let request, settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true; clearTimeout(deadline); resolve(ok);
      if (request && !request.destroyed) request.destroy();
    };
    // A socket inactivity timeout alone is extended by a slow-drip response.
    const deadline = setTimeout(() => finish(false), 900);
    request = http.request({ hostname:'127.0.0.1', port:target.port, path:'/notify/'+source, method:'POST',
      headers:{ 'Content-Type':'application/json', 'Content-Length':body.length, 'X-AIBro-Notification-Token':target.token } }, response => {
      response.resume(); response.on('end', () => finish(response.statusCode === 202));
    });
    request.setTimeout(900, () => finish(false));
    request.on('error', () => finish(false)); request.on('close', () => finish(false)); request.end(body);
  });
}

async function main(args = process.argv.slice(2)) {
  if (args.length < 4 || args[0] !== '--endpoint' || args[2] !== '--source' || !['codex','claude','gpt'].includes(args[3])) return;
  if (args[3] === 'claude' && String(process.env.CLAUDE_CODE_REMOTE || '').toLowerCase() === 'true') return;
  if (args.length > 5) return;
  const raw = args.length === 5 ? args[4] : await readStdin();
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMIT) return;
  const payload = normalize(JSON.parse(raw));
  if (payload) await post(endpoint(args[1]),args[3],payload);
}
module.exports = { endpoint, normalize, readStdin, post, main };
if (require.main === module) main().then(() => process.exit(0), () => process.exit(0));
