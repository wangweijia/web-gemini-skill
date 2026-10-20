const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPreview } = require('../cli/acp-preview');

function read(preview) {
  let body;
  preview.handleHttp({
    url: '/acp-preview/messages', method: 'GET', socket: { localPort: 9003 },
    headers: { host: '127.0.0.1:9003' },
  }, { setHeader() {}, writeHead() {}, end(value) { body = value; } });
  return JSON.parse(body);
}

const input = () => ({
  conversationId: 'conversation_a',
  messages: [{ messageId: 'source_1', text: '## Hello\n\n```js\nrun();\n```' }],
});

test('snapshots produce ACP output notifications, not fabricated prompt responses', () => {
  const preview = createPreview();
  const reply = preview.capture(input(), { role: 'gpt' });
  assert.equal(reply.messageCount, 1);
  const [record] = read(preview);
  assert.equal(record.id, reply.captureId);
  assert.match(record.sessionId, /^preview_/);
  assert.deepEqual(record.messages, [{
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId: record.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk', messageId: `${record.sessionId}_1`,
        content: { type: 'text', text: input().messages[0].text },
      },
    },
  }]);
  preview.capture(input(), { role: 'gpt' });
  assert.notEqual(read(preview)[0].sessionId, read(preview)[1].sessionId);
});

test('invalid or unhandshaken captures are explicitly rejected without storing records', () => {
  const preview = createPreview();
  for (const role of ['', 'gemini']) assert.throws(() => preview.capture(input(), { role }), /GPT/);
  for (const params of [null, {}, { ...input(), messages: [] }, { ...input(), conversationId: '' },
    { ...input(), messages: [{ messageId: 'x', text: ' ' }] },
    { ...input(), messages: Array(201).fill({ messageId: 'x', text: 'text' }) },
    { ...input(), messages: [{ messageId: 'x', text: '中'.repeat(400000) }] }]) {
    assert.throws(() => preview.capture(params, { role: 'gpt' }));
  }
  assert.deepEqual(read(preview), []);
});

test('history is bounded by both record count and total bytes and is not shared by instances', () => {
  const preview = createPreview();
  for (let index = 0; index < 25; index++) preview.capture({ ...input(), conversationId: `conv_${index}` }, { role: 'gpt' });
  assert.equal(read(preview).length, 20);
  assert.equal(read(preview)[0].source.conversationId, 'conv_5');
  const large = createPreview();
  for (let index = 0; index < 12; index++) large.capture({
    ...input(), messages: [{ messageId: 'x', text: 'x'.repeat(900000) }],
  }, { role: 'gpt' });
  const records = read(large);
  assert.ok(records.length < 12);
  assert.ok(Buffer.byteLength(JSON.stringify(records)) <= 8 * 1024 * 1024);
  assert.deepEqual(read(createPreview()), []);
});
