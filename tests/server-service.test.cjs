const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('../cli/node_modules/ws');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function connect(port, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('local server accepts ChatGPT and rejects unrelated browser origins', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-server-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve('cli/server.js'), `--port=${port}`, `--skills-dir=${root}`], {
    cwd: path.resolve('cli'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let ws;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { ws = await connect(port, 'https://chatgpt.com'); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(ws, 'server never opened its local port');
  t.after(() => ws.close());

  ws.send(JSON.stringify({ action: 'shakehand', params: { workDir: root, role: 'gpt' } }));
  const reply = await new Promise((resolve) => ws.once('message', (message) => resolve(JSON.parse(message))));
  assert.equal(reply.action, 'shakehand_reply');
  assert.equal(reply.status, 'success');

  await assert.rejects(connect(port, 'https://unrelated.example'), /403/);
});
