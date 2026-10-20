const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { expandHomePath, resolveConfigPath } = require('../cli/config-paths');

test('configuration paths expand only the current user home, including full-width tilde and spaces', () => {
  const home = path.resolve('/Users/Test User');
  assert.equal(resolveConfigPath('~', home), home);
  assert.equal(resolveConfigPath(' ～ ', home), home);
  assert.equal(resolveConfigPath(' ~/Project Space ', home), path.join(home, 'Project Space'));
  assert.equal(resolveConfigPath('～/.glab-skills', home), path.join(home, '.glab-skills'));
  assert.equal(resolveConfigPath('~/projects/../demo', home), path.join(home, 'demo'));
});

test('absolute paths and legacy relative path resolution are preserved', () => {
  const absolute = path.resolve('/Volumes/Shared Projects');
  assert.equal(resolveConfigPath(absolute, '/Users/Test'), absolute);
  assert.equal(resolveConfigPath('relative', '/Users/Test'), path.resolve('relative'));
  assert.equal(expandHomePath('relative', '/Users/Test'), 'relative');
  assert.equal(expandHomePath('/path/~/literal', '/Users/Test'), '/path/~/literal');
});

test('unsupported home expressions and malformed paths fail explicitly', () => {
  for (const input of ['~someone/project', '～someone/project', '$HOME/project', '${HOME}/project', '', '  ', 12, {}, null]) {
    assert.throws(() => resolveConfigPath(input, '/Users/Test'), /目录路径|仅支持/);
  }
});
