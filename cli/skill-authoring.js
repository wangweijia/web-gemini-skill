const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNTIMES = { node: 'node', bash: 'bash', sh: 'bash', python3: 'python3', python: 'python3' };
const ENTRIES = { node: 'scripts/main.js', bash: 'scripts/main.sh', python3: 'scripts/main.py' };

function validateName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error('Skill 名称须为 1–64 位字母、数字、下划线或连字符，且以字母或数字开头。');
  }
}

function resolveDraft(ctx, name) {
  if (!ctx.safeRoot) throw new Error('请先在插件中保存工作目录。');
  const root = fs.realpathSync(ctx.safeRoot);
  const parent = path.join(root, '.glab-skill-drafts');
  const draft = path.join(parent, name);
  // Authoring and installation must not follow staged symlinks outside the workspace.
  for (const p of [parent, draft]) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('Skill 草稿目录不能是符号链接。');
  }
  return draft;
}

function inspectRuntime(runtime) {
  const command = RUNTIMES[runtime];
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 3000, maxBuffer: 8192 });
  return {
    command,
    available: !result.error && result.status === 0,
    version: (result.stdout || result.stderr || '').trim().split('\n')[0],
  };
}

function prepareSkill(params, ctx) {
  const { name, runtime = 'python3' } = params;
  validateName(name);
  if (!Object.hasOwn(RUNTIMES, runtime)) throw new Error('runtime 仅支持 node、bash、sh、python3、python。');
  if (!ctx.skillsDir) throw new Error('Skills 目录未配置。');
  const command = RUNTIMES[runtime];
  const draft = resolveDraft(ctx, name);
  const destination = path.resolve(ctx.skillsDir, name);
  const entry = ENTRIES[command];
  return {
    name,
    workDir: ctx.safeRoot,
    skillsDir: ctx.skillsDir,
    destination,
    destinationExists: fs.existsSync(destination),
    draftPath: draft,
    draftRelativePath: `.glab-skill-drafts/${name}`,
    runtime: inspectRuntime(runtime),
    requiredFiles: ['skill.json', 'SKILL.md', entry],
    manifestTemplate: { description: '替换为该技能的用途说明', entry, runtime: command },
    manifestRules: ['skill.json 必须是合法 JSON 对象，description、entry、runtime 均为非空字符串。',
      'entry 必须是 Skill 目录内存在的普通文件的相对路径；禁止绝对路径、.. 和符号链接。',
      '只放 SKILL.md 不会被 list_skills 发现。'],
    documentation: ['SKILL.md 写明用途、参数、依赖安装方法、调用示例和输出格式。',
      'Python 依赖可列在 requirements.txt，Node 依赖可列在 package.json；GLAB 不会自动安装依赖。'],
    execution: {
      cwd: destination,
      workDirEnvironmentVariable: 'GLAB_WORK_DIR',
      arguments: 'args 对象转换为 --key String(value)；脚本必须显式解析参数，布尔值也会传为字符串。',
      example: { args: { output: 'result.txt', enabled: true }, argv: ['--output', 'result.txt', '--enabled', 'true'] },
      timeoutSeconds: 30,
      output: 'stdout/stderr 会回传；生成的项目文件应写入 GLAB_WORK_DIR，不要假定进程 cwd 是项目目录。',
    },
    workflow: [
      '先检查 runtime.available；不可用时先处理运行环境，不要声称技能可运行。',
      '用 write_file 等文件指令在 draftRelativePath 下创建所有必需文件。不要直接写 Skills 目录，它可能在工作目录之外。',
      '长文件使用 write_file_chunk，每片最多 2000 字符、40 行；当前片执行成功后才生成下一片。',
      '执行 install_skill，params: {name}。它校验并安装草稿，目标已存在时会报错，不覆盖已有技能。',
      '安装成功后执行 list_skills，再执行 load_skill，确认发现和加载正常。',
      '仅在依赖就绪且有合适的无副作用测试参数时执行 run_skill 验证；安装成功不代表运行测试通过。',
    ],
    nextAction: { action: 'install_skill', params: { name } },
  };
}

function validateTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new Error(`Skill 包含不支持的文件类型或符号链接: ${entry.name}`);
    }
    if (entry.isDirectory()) validateTree(file);
  }
}

function validatePackage(draft) {
  validateTree(draft);
  const meta = JSON.parse(fs.readFileSync(path.join(draft, 'skill.json'), 'utf8'));
  if (!meta || Array.isArray(meta) || typeof meta !== 'object' ||
      ['description', 'entry', 'runtime'].some(key => typeof meta[key] !== 'string' || !meta[key].trim())) {
    throw new Error('skill.json 必须包含非空的 description、entry 和 runtime 字符串。');
  }
  if (!Object.hasOwn(RUNTIMES, meta.runtime)) throw new Error('skill.json 的 runtime 不受支持。');
  if (path.isAbsolute(meta.entry) || meta.entry.includes('\\') || meta.entry.split('/').includes('..')) {
    throw new Error('skill.json 的 entry 必须是包内相对路径，不能包含 ..。');
  }
  for (const required of ['SKILL.md', meta.entry]) {
    if (!fs.statSync(path.join(draft, required)).isFile()) throw new Error(`${required} 必须是普通文件。`);
  }
  return meta;
}

function installSkill(params, ctx) {
  validateName(params.name);
  if (!ctx.skillsDir) throw new Error('Skills 目录未配置。');
  const draft = resolveDraft(ctx, params.name);
  const meta = validatePackage(draft);
  fs.mkdirSync(ctx.skillsDir, { recursive: true });
  const destination = path.resolve(ctx.skillsDir, params.name);
  // Exclusive directory reservation prevents overwriting existing skills.
  fs.mkdirSync(destination);
  try {
    fs.cpSync(draft, destination, { recursive: true, force: false, errorOnExist: true });
    validatePackage(destination);
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { name: params.name, destination, manifest: meta,
    message: 'Skill 已校验并安装，请执行 list_skills 和 load_skill 确认；依赖未自动安装，尚未执行运行测试。' };
}

module.exports = { prepareSkill, installSkill };
