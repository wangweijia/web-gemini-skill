const os = require('node:os');
const path = require('node:path');

function expandHomePath(value, homeDir = os.homedir()) {
  if (typeof value !== 'string') throw new Error('目录路径必须是字符串');
  const input = value.trim().replace(/^～/, '~');
  if (!input) throw new Error('目录路径不能为空');
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || (path.sep === '\\' && input.startsWith('~\\'))) {
    return path.join(homeDir, input.slice(2));
  }
  if (input.startsWith('~')) throw new Error('仅支持当前用户的 ~ 或 ~/目录，不支持 ~其他用户');
  if (/^\$(?:HOME\b|\{HOME\})/.test(input)) throw new Error('目录路径不支持 $HOME，请使用 ~ 或绝对路径');
  return input;
}

function resolveConfigPath(value, homeDir = os.homedir()) {
  return path.resolve(expandHomePath(value, homeDir));
}

module.exports = { expandHomePath, resolveConfigPath };
