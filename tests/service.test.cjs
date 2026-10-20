const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { servicePaths, buildPlist, parseOptions, stageBundle } = require('../cli/service.js');

test('launch agent starts a private, persistent bundled service', () => {
  const paths = servicePaths('/Users/Test & User');
  const plist = buildPlist(paths, {
    port: 9004,
    skillsDir: '/Users/Test & User/Skills',
    environmentPath: '/custom/bin:/usr/bin',
  });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(plist, /<string>--port=9004<\/string>/);
  assert.match(plist, /--skills-dir=\/Users\/Test &amp; User\/Skills/);
  assert.match(plist, /\/Application Support\/GLAB\/cli\/bin\/node/);
  assert.match(plist, /\/opt\/homebrew\/bin/);
  if (process.platform === 'darwin') {
    const checked = spawnSync('/usr/bin/plutil', ['-lint', '-'], { input: plist, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  }
});

test('service options reject invalid ports and relative skill paths', () => {
  assert.deepEqual(parseOptions(['install', '--port=9004']), { command: 'install', port: 9004, skillsDir: '' });
  assert.throws(() => parseOptions(['install', '--port=0']), /无效/);
  assert.throws(() => parseOptions(['install', '--skills-dir=relative']), /绝对路径/);
  assert.throws(() => parseOptions(['status', '--port=9004']), /仅在 install/);
  assert.equal(parseOptions(['install', '--skills-dir=~/Custom Skills']).skillsDir, path.join(os.homedir(), 'Custom Skills'));
  assert.equal(parseOptions(['install', '--skills-dir=～/Custom Skills']).skillsDir, path.join(os.homedir(), 'Custom Skills'));
  assert.throws(() => parseOptions(['install', '--skills-dir=~someone/Skills']), /仅支持/);
});

test('installed bundle contains its own runtime, code and dependency', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-service-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const support = path.join(root, 'support');
  const runtime = path.join(root, 'node-runtime');
  fs.mkdirSync(path.join(source, 'node_modules', 'ws'), { recursive: true });
  for (const name of ['server.js', 'service.js', 'origins.js', 'chunk-writer.js', 'skill-authoring.js', 'skills-directory.js', 'config-paths.js', 'package.json']) {
    fs.writeFileSync(path.join(source, name), name);
  }
  fs.writeFileSync(path.join(source, 'node_modules', 'ws', 'package.json'), '{}');
  fs.writeFileSync(runtime, 'runtime');
  const stage = stageBundle(source, support, runtime);
  fs.rmSync(source, { recursive: true });
  assert.equal(fs.readFileSync(path.join(stage, 'bin', 'node'), 'utf8'), 'runtime');
  assert.equal(fs.readFileSync(path.join(stage, 'server.js'), 'utf8'), 'server.js');
  assert.equal(fs.readFileSync(path.join(stage, 'config-paths.js'), 'utf8'), 'config-paths.js');
  assert.equal(fs.readFileSync(path.join(stage, 'node_modules', 'ws', 'package.json'), 'utf8'), '{}');
});
