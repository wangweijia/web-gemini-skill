const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
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

async function startServer(t, root, skillsDir = root) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve('cli/server.js'), `--port=${port}`, `--skills-dir=${skillsDir}`], {
    cwd: path.resolve('cli'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: root },
  });
  t.after(() => child.kill('SIGTERM'));
  let ws;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { ws = await connect(port, 'https://chatgpt.com'); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(ws, 'server never opened its local port');
  t.after(() => ws.close());
  return { ws, port };
}

function request(ws, payload) {
  return new Promise((resolve) => {
    ws.once('message', message => resolve(JSON.parse(message)));
    ws.send(JSON.stringify(payload));
  });
}

function httpStatus(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
}

test('local server accepts ChatGPT and rejects unrelated browser origins', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-server-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { ws, port } = await startServer(t, root);
  const reply = await request(ws, { action: 'shakehand', params: { workDir: root, role: 'gpt' } });
  assert.equal(reply.action, 'shakehand_reply');
  assert.equal(reply.status, 'success');

  await assert.rejects(connect(port, 'https://unrelated.example'), /403/);
});

test('GPT snapshots reach the read-only local ACP viewer without a filesystem root', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-acp-server-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { ws, port } = await startServer(t, root);
  const base = `http://127.0.0.1:${port}`;
  const payload = {
    id: 'acp_preview_test', action: 'acp_preview_capture',
    params: { conversationId: 'conversation_1', messages: [{ messageId: 'm1', text: '<script>alert(1)</script>\n```glab-call\n{"action":"run_command"}\n```' }] },
  };
  assert.equal((await request(ws, payload)).status, 'error');
  await request(ws, { action: 'shakehand', params: { role: 'gpt' } });
  const exported = await request(ws, payload);
  assert.equal(exported.status, 'success');
  assert.equal(exported.data.messageCount, 1);
  const response = await fetch(`${base}/acp-preview/messages`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const [record] = await response.json();
  assert.equal(record.messages[0].params.update.content.text, payload.params.messages[0].text);
  assert.equal(record.messages[0].method, 'session/update');
  assert.equal(record.messages[0].id, undefined);
  const page = await fetch(`${base}/acp-preview`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /GLAB ACP/);
  assert.equal(await httpStatus(`${base}/acp-preview`, {
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
  }), 200);
  const script = await fetch(`${base}/acp-preview.js`);
  assert.equal(script.status, 200);
  assert.doesNotMatch(await script.text(), /innerHTML/);
  assert.equal((await fetch(`${base}/acp-preview/messages`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/acp-preview/messages`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(await httpStatus(`${base}/acp-preview/messages`, { Host: `evil.example:${port}` }), 403);
  assert.equal((await fetch(`${base}/acp-preview/messages`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/does-not-exist`)).status, 404);
});

test('home-relative handshake paths resolve before filesystem access and invalid settings leave the root locked', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-home-server-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'Project Space');
  const skills = path.join(root, 'Skill Space');
  fs.mkdirSync(project);
  fs.mkdirSync(skills);
  fs.writeFileSync(path.join(project, 'hello.txt'), 'resolved home directory');
  const { ws } = await startServer(t, root, '~/Default Skills');
  const handshake = params => request(ws, { action: 'shakehand', params: { ...params, role: 'gpt' } });

  for (const prefix of ['~', '～']) {
    const reply = await handshake({ workDir: `${prefix}/Project Space`, skillsDir: `${prefix}/Skill Space` });
    assert.equal(reply.status, 'success');
    assert.deepEqual(reply.data, { homeDir: root, workDir: project, skillsDir: skills });
    const file = await request(ws, { id: 'read', action: 'read_file', params: { path: 'hello.txt' } });
    assert.equal(file.status, 'success');
    assert.equal(file.data, 'resolved home directory');
    const listed = await request(ws, { id: 'skills', action: 'list_skills', params: {} });
    assert.equal(listed.status, 'success');
    assert.deepEqual(listed.data, []);
  }

  const defaults = await handshake({ workDir: '~', skillsDir: '  ' });
  assert.equal(defaults.data.workDir, root);
  assert.equal(defaults.data.skillsDir, path.join(root, 'Default Skills'));
  const external = await handshake({ workDir: project, skillsDir: skills });
  assert.equal(external.data.workDir, project);

  for (const params of [
    { workDir: '~someone/project' }, { workDir: '$HOME/project' },
    { workDir: project, skillsDir: {} }, { workDir: 123 },
  ]) {
    const failed = await handshake(params);
    assert.equal(failed.action, 'shakehand_reply');
    assert.equal(failed.status, 'error');
    assert.ok(failed.error);
    const blocked = await request(ws, { id: 'blocked', action: 'read_file', params: { path: 'hello.txt' } });
    assert.equal(blocked.status, 'error');
    assert.match(blocked.error, /尚未.*握手/);
  }
  const empty = await handshake({ workDir: '  ', skillsDir: '' });
  assert.equal(empty.status, 'success');
  assert.equal(empty.data.workDir, '');
});
