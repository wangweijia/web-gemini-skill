const fs = require('node:fs');
const path = require('node:path');

function resolveDefaultSkillsDir(homeDir, configuredDir) {
  if (configuredDir) return path.resolve(configuredDir);
  const preferred = path.join(homeDir, '.glab-skills');
  const legacy = path.join(homeDir, '.web-gemini-skill');
  // Keep existing installations working without moving users' files.
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) return legacy;
  return preferred;
}

module.exports = { resolveDefaultSkillsDir };
