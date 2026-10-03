const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { post } = require('../app/external-notification-hook.cjs');

test('slow-drip loopback response cannot extend the hook total deadline', {timeout:5000}, async () => {
  let chunks=0;
  const sockets=new Set();
  const server=http.createServer((request,response) => {
    request.resume();response.writeHead(202, {'Content-Type':'application/json'});
    const timer=setInterval(() => { chunks++;response.write(' '); },80);
    response.on('close', () => clearInterval(timer));
  });
  server.on('connection',socket => { sockets.add(socket);socket.on('close',()=>sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const began=performance.now();
    const result=await post({port:server.address().port,token:'a'.repeat(64)},'codex',{title:'Synthetic'});
    const elapsed=performance.now()-began;
    assert.equal(result,false);
    assert.ok(chunks>=3,'server actually sent a live stream');
    assert.ok(elapsed>=850 && elapsed<1700,`bounded total deadline ${elapsed}ms`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve=>server.close(resolve));
  }
});
