const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDefaultSkillsDir } = require('../cli/skills-directory');

test('new installations use generic directory, old installations retain skills, explicit paths take priority', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const preferred = path.join(home, '.glab-skills');
  const legacy = path.join(home, '.web-gemini-skill');
  assert.equal(resolveDefaultSkillsDir(home), preferred);
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'existing.txt'), 'preserved');
  assert.equal(resolveDefaultSkillsDir(home), legacy);
  fs.mkdirSync(preferred);
  assert.equal(resolveDefaultSkillsDir(home), preferred);
  assert.equal(resolveDefaultSkillsDir(home, legacy), legacy);
  assert.equal(fs.readFileSync(path.join(legacy, 'existing.txt'), 'utf8'), 'preserved');
});
