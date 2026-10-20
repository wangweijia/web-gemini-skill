const fs = require('node:fs');
const path = require('node:path');
const { resolveConfigPath } = require('./config-paths');

function resolveDefaultSkillsDir(homeDir, configuredDir) {
  if (configuredDir) return resolveConfigPath(configuredDir, homeDir);
  const preferred = path.join(homeDir, '.glab-skills');
  const legacy = path.join(homeDir, '.web-gemini-skill');
  // Keep existing installations working without moving users' files.
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) return legacy;
  return preferred;
}

module.exports = { resolveDefaultSkillsDir };
