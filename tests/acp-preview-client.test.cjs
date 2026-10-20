const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createPreview } = require('../cli/acp-preview');

function node(tag) {
  return {
    tag, children: [], textContent: '', listeners: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}

test('viewer renders untrusted answers as text and copies valid ACP JSONL without executing content', async () => {
  const preview = createPreview();
  preview.capture({
    conversationId: 'test',
    messages: [{ messageId: 'm1', text: '<img src=x onerror=alert(1)>\n```glab-call\n{}\n```' }],
  }, { role: 'gpt' });
  let records;
  preview.handleHttp({
    url: '/acp-preview/messages', method: 'GET', socket: { localPort: 9003 }, headers: { host: '127.0.0.1:9003' },
  }, { setHeader() {}, writeHead() {}, end(body) { records = JSON.parse(body); } });
  const status = node('div');
  const captures = node('main');
  const timers = [];
  let clipboard;
  let failing = false;
  const context = vm.createContext({
    document: {
      getElementById: id => id === 'status' ? status : captures,
      createElement: node,
    },
    fetch: async () => failing ? { ok: false, status: 503 } : { ok: true, json: async () => records },
    navigator: { clipboard: { writeText: async text => { clipboard = text; } } },
    setTimeout(fn) { timers.push(fn); },
  });
  await vm.runInContext(fs.readFileSync('cli/acp-preview-client.js', 'utf8'), context);
  assert.equal(captures.children.length, 1);
  const article = captures.children[0];
  const answer = article.children.find(child => child.tag === 'pre');
  assert.equal(answer.textContent, records[0].messages[0].params.update.content.text);
  assert.equal(answer.children.length, 0);
  assert.match(status.textContent, /1 次导出/);
  await article.children.find(child => child.tag === 'button').listeners.click();
  assert.ok(clipboard.endsWith('\n'));
  assert.deepEqual(clipboard.trim().split('\n').map(line => JSON.parse(line)), records[0].messages);
  await timers.pop()();
  assert.equal(captures.children[0], article, 'unchanged snapshots must not replace selectable content');
  failing = true;
  await timers.pop()();
  assert.match(status.textContent, /HTTP 503/);
  assert.equal(captures.children[0], article);
  assert.equal(timers.length, 1, 'connection failures should schedule another attempt');
});
