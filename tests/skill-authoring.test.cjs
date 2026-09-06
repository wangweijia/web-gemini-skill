const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareSkill, installSkill } = require('../cli/skill-authoring');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-author-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = { safeRoot: path.join(root, 'project'), skillsDir: path.join(root, 'custom-skills') };
  fs.mkdirSync(ctx.safeRoot);
  const draft = path.join(ctx.safeRoot, '.glab-skill-drafts', 'demo');
  function populate(meta = { description: 'Demo', runtime: 'node', entry: 'scripts/main.js' }) {
    fs.mkdirSync(path.join(draft, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(draft, 'skill.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(draft, 'SKILL.md'), '# Demo\nUsage and dependencies');
    fs.writeFileSync(path.join(draft, 'scripts/main.js'), 'console.log("ok");');
  }
  return { ctx, draft, populate };
}

test('preparation reflects configured directories and runtime without creating files', t => {
  const { ctx, draft } = setup(t);
  const result = prepareSkill({ name: 'demo', runtime: 'node' }, ctx);
  assert.equal(result.skillsDir, ctx.skillsDir);
  assert.equal(result.destination, path.join(ctx.skillsDir, 'demo'));
  assert.equal(result.draftPath, path.join(fs.realpathSync(ctx.safeRoot), '.glab-skill-drafts', 'demo'));
  assert.equal(result.runtime.available, true);
  assert.deepEqual(result.requiredFiles, ['skill.json', 'SKILL.md', 'scripts/main.js']);
  assert.equal(result.execution.timeoutSeconds, 30);
  assert.equal(fs.existsSync(draft), false);
  assert.equal(fs.existsSync(ctx.skillsDir), false);
});

test('installation creates a discoverable package in configured skills directory without running it', t => {
  const { ctx, populate } = setup(t);
  populate();
  const result = installSkill({ name: 'demo' }, ctx);
  assert.equal(result.destination, path.join(ctx.skillsDir, 'demo'));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.destination, 'skill.json')));
  assert.equal(manifest.runtime, 'node');
  assert.equal(fs.readFileSync(path.join(result.destination, manifest.entry), 'utf8'), 'console.log("ok");');
});

test('missing manifest is rejected before any installation', t => {
  const { ctx, draft } = setup(t);
  fs.mkdirSync(draft, { recursive: true });
  fs.writeFileSync(path.join(draft, 'SKILL.md'), '# Documentation only');
  assert.throws(() => installSkill({ name: 'demo' }, ctx), /skill.json/);
  assert.equal(fs.existsSync(path.join(ctx.skillsDir, 'demo')), false);
});

test('missing documentation, missing entry, invalid runtime and escaping entry fail validation', t => {
  const { ctx, draft, populate } = setup(t);
  for (const change of [{ entry: '../outside.js' }, { entry: '/tmp/outside.js' }, { entry: 'missing.js' }, { runtime: 'invalid' }, { description: '' }]) {
    populate({ description: 'Demo', runtime: 'node', entry: 'scripts/main.js', ...change });
    assert.throws(() => installSkill({ name: 'demo' }, ctx));
    assert.equal(fs.existsSync(path.join(ctx.skillsDir, 'demo')), false);
  }
  populate();
  fs.unlinkSync(path.join(draft, 'SKILL.md'));
  assert.throws(() => installSkill({ name: 'demo' }, ctx), /SKILL.md/);
});

test('existing skills are preserved', t => {
  const { ctx, populate } = setup(t);
  populate();
  const installed = installSkill({ name: 'demo' }, ctx);
  fs.writeFileSync(path.join(installed.destination, 'SKILL.md'), 'keep me');
  assert.throws(() => installSkill({ name: 'demo' }, ctx), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(installed.destination, 'SKILL.md'), 'utf8'), 'keep me');
});

test('rejects traversal names and symlinked drafts or package files', t => {
  const { ctx, draft, populate } = setup(t);
  for (const name of ['..', '../escape', '/absolute', 'a/b']) {
    assert.throws(() => prepareSkill({ name }, ctx));
    assert.throws(() => installSkill({ name }, ctx));
  }
  populate();
  fs.symlinkSync(path.join(draft, 'SKILL.md'), path.join(draft, 'linked.md'));
  assert.throws(() => installSkill({ name: 'demo' }, ctx), /符号链接/);
  fs.rmSync(draft, { recursive: true });
  fs.symlinkSync(ctx.safeRoot, draft);
  assert.throws(() => installSkill({ name: 'demo' }, ctx), /符号链接/);
});
