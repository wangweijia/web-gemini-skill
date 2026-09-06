const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChunkWriter } = require('../cli/chunk-writer');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'file.txt');
  fs.writeFileSync(target, 'original');
  const writer = createChunkWriter();
  const write = (chunkIndex, content, extra = {}) => writer(target, {
    path: 'file.txt', transferId: 'a', totalChunks: 2, chunkIndex, content, ...extra,
  });
  return { target, write, writer };
}
test('duplicates are idempotent, and target changes only after final chunk', t => {
  const { target, write } = setup(t);
  assert.equal(write(0, 'hello ').nextChunkIndex, 1);
  write(0, 'hello ');
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.equal(write(1, 'world').complete, true);
  assert.equal(write(1, 'world').complete, true);
  assert.equal(write(0, 'hello ').complete, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello world');
});
test('rejects missing sessions, out-of-order chunks, changed counts and conflicting retries', t => {
  const { write } = setup(t);
  assert.throws(() => write(1, 'x'), /找不到/);
  write(0, 'a', { totalChunks: 3 });
  assert.throws(() => write(2, 'c', { totalChunks: 3 }), /乱序/);
  assert.throws(() => write(1, 'b'), /不一致/);
  assert.throws(() => write(0, 'changed', { totalChunks: 3 }), /内容不一致/);
});
test('new transfer can repartition without preserving old fragments', t => {
  const { write, target } = setup(t);
  write(0, 'old');
  write(0, 'new', { transferId: 'b', totalChunks: 1 });
  assert.throws(() => write(1, 'tail'), /替代/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});
test('validates size, lines and indices before changing files', t => {
  const { write, target } = setup(t);
  for (const extra of [{ chunkIndex: -1 }, { chunkIndex: '0' }, { totalChunks: 0 }, { totalChunks: 1.5 }, { transferId: '' }]) {
    assert.throws(() => write(0, 'x', extra));
  }
  assert.throws(() => write(0, 'x'.repeat(2001)), /超过/);
  assert.throws(() => write(0, '\n'.repeat(40)), /超过/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});
test('after service restart, continuation fails explicitly instead of appending blindly', t => {
  const { write, target } = setup(t);
  write(0, 'a');
  assert.throws(() => createChunkWriter()(target, {
    transferId: 'a', chunkIndex: 1, totalChunks: 2, content: 'b',
  }), /CLI 已重启/);
});
