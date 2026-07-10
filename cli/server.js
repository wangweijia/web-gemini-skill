const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ==========================================
// 命令行参数解析
// ==========================================
const args = {};
process.argv.slice(2).forEach(arg => {
  if (arg.startsWith('--')) {
    const parts = arg.split('=');
    const key = parts[0].replace('--', '');
    const val = parts[1] || '';
    args[key] = val;
  }
});

const { exec } = require('child_process');

// safeRoot 与 skillsDir 改为动态变量，握手时根据插件配置锁定路径
let safeRoot = '';
let skillsDir = '';
const PORT = args['port'] ? parseInt(args['port'], 10) : 9003;

console.log("\x1b[32m[GLAB CLI] 安全代理服务正在初始化...\x1b[0m");
console.log(`[GLAB CLI] 工作根目录: 等待浏览器插件握手传入并锁定...`);
console.log(`[GLAB CLI] Skills 目录: 等待浏览器插件握手传入并锁定...`);

// ==========================================
// 路径安全校验逻辑
// ==========================================
function getSafePath(inputPath) {
  if (!safeRoot) throw new Error('CLI 尚未与插件完成握手锁定工作目录，请先在插件中保存配置！');
  if (!inputPath) throw new Error('路径参数不能为空');
  const resolved = path.resolve(safeRoot, inputPath);
  if (!resolved.startsWith(safeRoot)) {
    throw new Error(`安全校验失败: 路径 [${inputPath}] 越权访问，已被 Root Jail 拦截`);
  }
  return resolved;
}

function getSafeSkillPath(skillsDir, skillName) {
  if (!skillsDir) throw new Error('Skills 目录未配置，无法操作 Skill');
  if (!skillName || /[/\\]/.test(skillName)) {
    throw new Error(`安全校验失败: 非法的 Skill 名称 [${skillName}]`);
  }
  const resolved = path.resolve(skillsDir, skillName);
  if (!resolved.startsWith(path.resolve(skillsDir))) {
    throw new Error(`安全校验失败: Skill 路径 [${skillName}] 越权访问`);
  }
  return resolved;
}

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.js': 'application/javascript',
  '.html': 'text/html',
  '.css': 'text/css'
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ==========================================
// 安全沙箱环境构建
// ==========================================
function runCodeInSandbox(codeToRun) {
  // 受限的 require，仅开放安全的内置模块，严禁 child_process 等
  const safeRequire = (modName) => {
    const allowedModules = ['fs', 'path', 'util', 'crypto', 'os', 'url'];
    if (allowedModules.includes(modName)) {
      // 代理 fs 模块以应用安全路径校验
      if (modName === 'fs') {
        return createSafeFsProxy();
      }
      return require(modName);
    }
    throw new Error(`安全限制：模块 [${modName}] 已被沙箱禁止加载。`);
  };

  // 简单的安全 fs 代理，拦截写入行为并强制路径校验
  const createSafeFsProxy = () => {
    const originalFs = require('fs');
    return {
      readFileSync: (p, opt) => originalFs.readFileSync(getSafePath(p), opt),
      writeFileSync: (p, data, opt) => originalFs.writeFileSync(getSafePath(p), data, opt),
      readdirSync: (p, opt) => originalFs.readdirSync(getSafePath(p), opt),
      existsSync: (p) => originalFs.existsSync(getSafePath(p)),
      statSync: (p) => originalFs.statSync(getSafePath(p)),
      mkdirSync: (p, opt) => originalFs.mkdirSync(getSafePath(p), opt)
    };
  };

  const consoleLogs = [];
  const sandbox = {
    require: safeRequire,
    process: {
      env: { GLAB_WORK_DIR: safeRoot }
    },
    console: {
      log: (...args) => consoleLogs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
      error: (...args) => consoleLogs.push(`[ERROR] ` + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
    },
    Buffer: Buffer,
    setTimeout,
    clearTimeout
  };

  const context = vm.createContext(sandbox);
  try {
    vm.runInNewContext(codeToRun, context, { timeout: 5000 }); // 限制 5 秒最大执行时间
    return consoleLogs.join('\n') || '代码执行成功 (无控制台输出)';
  } catch (err) {
    throw new Error(`沙箱执行异常: ${err.message}`);
  }
}

// ==========================================
// WebSocket 服务启动
// ==========================================
const wss = new WebSocket.Server({ port: PORT });

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE' || err.message.includes('EADDRINUSE')) {
    console.error(`\n\x1b[31m[错误] 端口 ${PORT} 已被占用，无法启动服务。\x1b[0m`);
    console.error(`请使用 --port=XXXX 命令行参数指定一个不同的空闲端口。`);
    console.error(`例如: node server.js --port=9004`);
    console.error(`并确保您在 Chrome 插件 GLAB 控制面板上的“WS 服务端口”也配置为相应的端口。`);
  } else {
    console.error(`\n\x1b[31m[错误] WebSocket 服务发生异常: ${err.message}\x1b[0m`);
  }
  process.exit(1);
});

console.log(`\x1b[32m[GLAB CLI] 服务已启动。正在尝试监听端口: ${PORT}\x1b[0m`);

wss.on('connection', (ws) => {
  console.log('[GLAB CLI] 浏览器插件已建立连接。正在等待握手校验...');

  ws.on('message', async (message) => {
    let request;
    try {
      request = JSON.parse(message);
    } catch (e) {
      ws.send(JSON.stringify({ status: "error", error: "协议 JSON 解析失败" }));
      return;
    }

    const { id, action, params } = request;

    // 握手：插件连接后，CLI 根据插件传入的工作目录进行锁定
    if (action === "shakehand") {
      if (params && params.workDir) {
        safeRoot = path.resolve(params.workDir);
        if (params.skillsDir) {
          skillsDir = path.resolve(params.skillsDir);
          console.log(`[GLAB CLI] 握手成功！工作根目录已锁定: ${safeRoot}，Skills 目录已锁定: ${skillsDir}`);
        } else {
          skillsDir = '';
          console.log(`[GLAB CLI] 握手成功！工作根目录已锁定: ${safeRoot}，Skills 目录未配置`);
        }
        ws.send(JSON.stringify({
          action: "shakehand_reply",
          status: "success",
          data: { workDir: safeRoot, skillsDir }
        }));
      } else {
        console.warn(`[GLAB CLI] 握手失败！未传入工作根目录。`);
        ws.send(JSON.stringify({
          action: "shakehand_reply",
          status: "error",
          error: "未传入工作根目录"
        }));
      }
      return;
    }

    // 执行指令
    console.log(`[GLAB CLI] 收到执行请求: [${action}] ID: ${id}`);
    try {
      const result = await executeAction(action, params);
      ws.send(JSON.stringify({ id, action, autoSend: request.autoSend, status: "success", data: result }));
    } catch (err) {
      console.error(`[GLAB CLI] 执行失败 [${action}] ID: ${id}: ${err.message}`);
      ws.send(JSON.stringify({ id, action, autoSend: request.autoSend, status: "error", error: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('[GLAB CLI] 浏览器插件已断开连接。');
  });
});

// ==========================================
// 指令具体分发实现
// ==========================================
async function executeAction(action, params) {
  switch (action) {
    case 'select_directory': {
      return new Promise((resolve, reject) => {
        if (process.platform === 'darwin') {
          const script = `osascript -e 'POSIX path of (choose folder with prompt "请选择 GLAB 本地工作根目录")'`;
          exec(script, (err, stdout, stderr) => {
            if (err) {
              reject(new Error("用户取消了目录选择"));
              return;
            }
            resolve({ selectedPath: stdout.trim() });
          });
        } else {
          reject(new Error(`目前原生文件夹选择弹窗仅支持 macOS 平台。Windows 或其他系统请在插件面板中手动填写绝对路径。`));
        }
      });
    }

    case 'list_dir': {
      const targetPath = getSafePath(params.path || './');
      const files = fs.readdirSync(targetPath);
      return files.map(file => {
        const stats = fs.statSync(path.join(targetPath, file));
        return { name: file, isDir: stats.isDirectory(), size: stats.size };
      });
    }

    case 'read_file': {
      const targetPath = getSafePath(params.path);
      if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        throw new Error('目标文件不存在，或指定路径是一个目录');
      }
      
      const maxBytes = params.maxBytes || 50000;
      const stats = fs.statSync(targetPath);
      
      if (stats.size > maxBytes) {
        const fd = fs.openSync(targetPath, 'r');
        const buffer = Buffer.alloc(maxBytes);
        fs.readSync(fd, buffer, 0, maxBytes, 0);
        fs.closeSync(fd);
        return buffer.toString('utf-8') + `\n\n[GLAB 提示：文件大小（${stats.size}字节）超出最大阈值，已被自动截断前 ${maxBytes} 字节]`;
      }
      return fs.readFileSync(targetPath, 'utf-8');
    }

    case 'write_file': {
      const targetPath = getSafePath(params.path);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, params.content, 'utf-8');
      return { message: "写入成功", path: params.path };
    }

    case 'write_file_chunk': {
      const targetPath = getSafePath(params.path);
      const tmpPath = targetPath + '.tmp';
      const chunkIndex = parseInt(params.chunkIndex, 10);
      const totalChunks = parseInt(params.totalChunks, 10);

      if (chunkIndex === 0) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(tmpPath, params.content || '', 'utf-8');
      } else {
        if (!fs.existsSync(tmpPath)) {
          throw new Error(`分片写入错误：未找到初始分片生成的临时缓存文件 [${tmpPath}]`);
        }
        fs.appendFileSync(tmpPath, params.content || '', 'utf-8');
      }

      if (chunkIndex === totalChunks - 1) {
        fs.renameSync(tmpPath, targetPath);
        return { message: "全部分片写入完成", path: params.path };
      }

      return { message: `分片 ${chunkIndex + 1}/${totalChunks} 写入成功`, path: params.path };
    }

    case 'update_file': {
      const targetPath = getSafePath(params.path);
      // mode 未指定但有 content 字段时，默认回退为 overwrite
      const mode = params.mode || (params.content !== undefined ? 'overwrite' : undefined);
      if (mode === 'overwrite') {
        fs.writeFileSync(targetPath, params.content, 'utf-8');
        return { message: "覆盖写入成功" };
      } else if (mode === 'patch') {
        if (!fs.existsSync(targetPath)) {
          throw new Error('文件不存在，无法进行局部 patch 修改。');
        }
        let content = fs.readFileSync(targetPath, 'utf-8');
        const patches = params.patches || [];
        for (const patch of patches) {
          if (!content.includes(patch.find)) {
            throw new Error(`未能在目标文件中定位到需要替换的特征代码块 [${patch.find}]`);
          }
          content = content.replace(patch.find, patch.replace);
        }
        fs.writeFileSync(targetPath, content, 'utf-8');
        return { message: "补丁更新成功" };
      }
      throw new Error(`不支持的更新模式: ${params.mode}。请指定 mode: "overwrite" 或 mode: "patch"`);
    }

    case 'run_code': {
      return runCodeInSandbox(params.code);
    }

    case 'list_skills': {
      const skills = [];
      const entries = fs.readdirSync(skillsDir);
      for (const entry of entries) {
        try {
          const skillPath = getSafeSkillPath(skillsDir, entry);
          if (!fs.statSync(skillPath).isDirectory()) continue;
          
          const metaPath = path.join(skillPath, 'skill.json');
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            skills.push({ name: entry, description: meta.description, entry: meta.entry });
          }
        } catch (e) {
          // 忽略单个 Skill 扫描报错，保证列表可用
        }
      }
      return skills;
    }

    case 'load_skill': {
      const skillPath = getSafeSkillPath(skillsDir, params.name);
      const metaPath = path.join(skillPath, 'skill.json');
      if (!fs.existsSync(metaPath)) {
        throw new Error(`加载失败：Skill '${params.name}' 未包含有效配置文件 skill.json`);
      }
      
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const skillMd = fs.existsSync(path.join(skillPath, 'SKILL.md'))
        ? fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf-8') : '';
      const entryContent = fs.readFileSync(path.join(skillPath, meta.entry), 'utf-8');
      
      return { name: params.name, ...meta, skillMd, entryContent };
    }

    case 'run_skill': {
      const skillPath = getSafeSkillPath(skillsDir, params.name);
      const metaPath = path.join(skillPath, 'skill.json');
      if (!fs.existsSync(metaPath)) {
        throw new Error(`执行失败：Skill '${params.name}' 不存在`);
      }

      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const entryFile = path.join(skillPath, meta.entry);

      const RUNTIME_MAP = {
        'node': 'node',
        'bash': 'bash',
        'sh': 'bash',
        'python3': 'python3',
        'python': 'python3'
      };
      const runtime = RUNTIME_MAP[meta.runtime] || 'node';
      const cliArgs = Object.entries(params.args || {}).flatMap(([k, v]) => [`--${k}`, String(v)]);

      return new Promise((resolve, reject) => {
        // 超时看门狗：防止子脚本陷入死循环挂死
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error(`Skill '${params.name}' 执行超时(30秒)被强制终止。`));
        }, 30000);

        const proc = require('child_process').spawn(runtime, [entryFile, ...cliArgs], {
          cwd: skillPath,
          env: { ...process.env, GLAB_WORK_DIR: safeRoot }
        });

        let stdout = '', stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);

        proc.on('close', code => {
          clearTimeout(timer);
          if (code === 0) {
            resolve({ stdout, stderr, exitCode: code });
          } else {
            reject(new Error(`Skill 执行失败 (退出码: ${code})。\nstdout: ${stdout}\nstderr: ${stderr}`));
          }
        });
        
        proc.on('error', err => {
          clearTimeout(timer);
          reject(new Error(`无法启动 Skill 进程: ${err.message}`));
        });
      });
    }

    case 'run_command': {
      if (!params || !params.command) {
        throw new Error('参数 command 不能为空');
      }
      return new Promise((resolve, reject) => {
        // 限制 30 秒执行超时
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error('Shell 命令执行超时(30s)被强制终止。'));
        }, 30000);

        const proc = exec(params.command, {
          cwd: safeRoot,
          env: { ...process.env, GLAB_WORK_DIR: safeRoot }
        }, (error, stdout, stderr) => {
          clearTimeout(timer);
          if (error) {
            resolve({ stdout, stderr, exitCode: error.code || 1, error: error.message });
          } else {
            resolve({ stdout, stderr, exitCode: 0 });
          }
        });
      });
    }

    case 'paste_file': {
      const targetPath = getSafePath(params.path);
      if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        throw new Error('文件不存在或路径为目录');
      }
      const mimeType = getMimeType(targetPath);
      const base64Data = fs.readFileSync(targetPath).toString('base64');
      return {
        mimeType,
        base64Data,
        filename: path.basename(targetPath)
      };
    }

    default:
      throw new Error(`未支持的指令 Action: ${action}`);
  }
}
