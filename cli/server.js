const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { prepareSkill, installSkill } = require("./skill-authoring");
const writeChunk = require("./chunk-writer").createChunkWriter();

// ==========================================
// 命令行参数解析
// ==========================================
const args = {};
process.argv.slice(2).forEach((arg) => {
  if (arg.startsWith("--")) {
    const parts = arg.split("=");
    const key = parts[0].replace("--", "");
    const val = parts[1] || "";
    args[key] = val;
  }
});

const { exec } = require("child_process");

const os = require("os");

const defaultSkillsDir = require("./skills-directory").resolveDefaultSkillsDir(os.homedir(), args["skills-dir"]);

// 初始化/创建 Skills 默认目录
if (!fs.existsSync(defaultSkillsDir)) {
  try {
    fs.mkdirSync(defaultSkillsDir, { recursive: true });
    console.log(`[GLAB CLI] 已初始化并自动创建 Skills 默认目录: ${defaultSkillsDir}`);
  } catch (err) {
    console.error(`[GLAB CLI] 创建 Skills 默认目录失败: ${err.message}`);
  }
} else {
  console.log(`[GLAB CLI] 使用已存在的 Skills 目录: ${defaultSkillsDir}`);
}

const PORT = args["port"] ? parseInt(args["port"], 10) : 9003;

// role → ws reverse lookup for relay routing
const clients = new Map();
// ws → { safeRoot, skillsDir, role } per-connection state
const connContexts = new WeakMap();

console.log("\x1b[32m[GLAB CLI] 安全代理服务正在初始化...\x1b[0m");
console.log(`[GLAB CLI] 工作根目录: 等待浏览器插件握手传入并锁定...`);
console.log(`[GLAB CLI] Skills 目录默认值: ${defaultSkillsDir}`);

// ==========================================
// 路径安全校验逻辑
// ==========================================
function getSafePath(inputPath, ctx) {
  if (!ctx.safeRoot) throw new Error("CLI 尚未与插件完成握手锁定工作目录，请先在插件中保存配置！");
  if (!inputPath) throw new Error("路径参数不能为空");
  const resolved = path.resolve(ctx.safeRoot, inputPath);
  if (!resolved.startsWith(ctx.safeRoot)) {
    throw new Error(`安全校验失败: 路径 [${inputPath}] 越权访问，已被 Root Jail 拦截`);
  }
  return resolved;
}

function getSafeSkillPath(skillsDir, skillName) {
  if (!skillsDir) throw new Error("Skills 目录未配置，无法操作 Skill");
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
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".json": "application/json",
  ".md": "text/markdown",
  ".js": "application/javascript",
  ".html": "text/html",
  ".css": "text/css",
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

// ==========================================
// 安全沙箱环境构建
// ==========================================
function runCodeInSandbox(codeToRun, ctx) {
  // 受限的 require，仅开放安全的内置模块，严禁 child_process 等
  const safeRequire = (modName) => {
    const allowedModules = ["fs", "path", "util", "crypto", "os", "url"];
    if (allowedModules.includes(modName)) {
      // 代理 fs 模块以应用安全路径校验
      if (modName === "fs") {
        return createSafeFsProxy();
      }
      return require(modName);
    }
    throw new Error(`安全限制：模块 [${modName}] 已被沙箱禁止加载。`);
  };

  // 简单的安全 fs 代理，拦截写入行为并强制路径校验
  const createSafeFsProxy = () => {
    const originalFs = require("fs");
    return {
      readFileSync: (p, opt) => originalFs.readFileSync(getSafePath(p, ctx), opt),
      writeFileSync: (p, data, opt) => originalFs.writeFileSync(getSafePath(p, ctx), data, opt),
      readdirSync: (p, opt) => originalFs.readdirSync(getSafePath(p, ctx), opt),
      existsSync: (p) => originalFs.existsSync(getSafePath(p, ctx)),
      statSync: (p) => originalFs.statSync(getSafePath(p, ctx)),
      mkdirSync: (p, opt) => originalFs.mkdirSync(getSafePath(p, ctx), opt),
    };
  };

  const consoleLogs = [];
  const sandbox = {
    require: safeRequire,
    process: {
      env: { GLAB_WORK_DIR: ctx.safeRoot },
    },
    console: {
      log: (...args) => consoleLogs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")),
      error: (...args) => consoleLogs.push(`[ERROR] ` + args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")),
    },
    Buffer: Buffer,
    setTimeout,
    clearTimeout,
  };

  const context = vm.createContext(sandbox);
  try {
    vm.runInNewContext(codeToRun, context, { timeout: 5000 }); // 限制 5 秒最大执行时间
    return consoleLogs.join("\n") || "代码执行成功 (无控制台输出)";
  } catch (err) {
    throw new Error(`沙箱执行异常: ${err.message}`);
  }
}

// ==========================================
// WebSocket 服务启动
// ==========================================
const wss = new WebSocket.Server({ port: PORT });

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE" || err.message.includes("EADDRINUSE")) {
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

wss.on("connection", (ws) => {
  connContexts.set(ws, { safeRoot: "", skillsDir: defaultSkillsDir, role: "" });
  console.log("[GLAB CLI] 浏览器插件已建立连接。正在等待握手校验...");

  ws.on("message", async (message) => {
    let request;
    try {
      request = JSON.parse(message);
    } catch (e) {
      ws.send(JSON.stringify({ status: "error", error: "协议 JSON 解析失败" }));
      return;
    }

    const { id, action, params } = request;
    const ctx = connContexts.get(ws);

    // 握手：按连接独立锁定工作目录，同时注册角色到 clients 路由表
    if (action === "shakehand") {
      ctx.safeRoot = params && params.workDir ? path.resolve(params.workDir.trim()) : "";
      ctx.skillsDir = params && params.skillsDir ? path.resolve(params.skillsDir.trim()) : defaultSkillsDir;
      ctx.role = params && params.role ? params.role.trim() : "";
      if (ctx.role) clients.set(ctx.role, ws);

      console.log(`[GLAB CLI] 握手 [${ctx.role || "未知角色"}]：workDir=${ctx.safeRoot || "未指定"}，skillsDir=${ctx.skillsDir}`);
      ws.send(
        JSON.stringify({
          action: "shakehand_reply",
          status: "success",
          data: { workDir: ctx.safeRoot, skillsDir: ctx.skillsDir },
        }),
      );
      return;
    }

    // 中转指令在 executeAction 外处理，因为需要访问 clients 路由表
    if (action === "relay_verify" || action === "relay_result") {
      console.log(`[GLAB CLI] 收到中转请求: [${action}] ID: ${id}`);
      try {
        const result = handleRelay(action, params, ctx);
        ws.send(JSON.stringify({ id, action, status: "success", data: result }));
      } catch (err) {
        console.error(`[GLAB CLI] 中转失败 [${action}]: ${err.message}`);
        ws.send(JSON.stringify({ id, action, status: "error", error: err.message }));
      }
      return;
    }

    // 执行指令
    console.log(`[GLAB CLI] 收到执行请求: [${action}] ID: ${id}`);
    try {
      const result = await executeAction(action, params, ctx);
      ws.send(JSON.stringify({ id, action, autoSend: request.autoSend, status: "success", data: result }));
    } catch (err) {
      console.error(`[GLAB CLI] 执行失败 [${action}] ID: ${id}: ${err.message}`);
      ws.send(JSON.stringify({ id, action, autoSend: request.autoSend, status: "error", error: err.message }));
    }
  });

  ws.on("close", () => {
    const ctx = connContexts.get(ws);
    if (ctx && ctx.role) clients.delete(ctx.role);
    connContexts.delete(ws);
    console.log("[GLAB CLI] 浏览器插件已断开连接。");
  });
});

// ==========================================
// 指令具体分发实现
// ==========================================
async function executeAction(action, params, ctx) {
  switch (action) {
    case "select_directory": {
      return new Promise((resolve, reject) => {
        if (process.platform === "darwin") {
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

    case "list_dir": {
      const targetPath = getSafePath(params.path || "./", ctx);
      const files = fs.readdirSync(targetPath);
      return files.map((file) => {
        const stats = fs.statSync(path.join(targetPath, file));
        return { name: file, isDir: stats.isDirectory(), size: stats.size };
      });
    }

    case "read_file": {
      const targetPath = getSafePath(params.path, ctx);
      if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        throw new Error("目标文件不存在，或指定路径是一个目录");
      }

      const maxBytes = params.maxBytes || 50000;
      const stats = fs.statSync(targetPath);

      if (stats.size > maxBytes) {
        const fd = fs.openSync(targetPath, "r");
        const buffer = Buffer.alloc(maxBytes);
        fs.readSync(fd, buffer, 0, maxBytes, 0);
        fs.closeSync(fd);
        return buffer.toString("utf-8") + `\n\n[GLAB 提示：文件大小（${stats.size}字节）超出最大阈值，已被自动截断前 ${maxBytes} 字节]`;
      }
      return fs.readFileSync(targetPath, "utf-8");
    }

    case "write_file": {
      const targetPath = getSafePath(params.path, ctx);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, params.content, "utf-8");
      return { message: "写入成功", path: params.path };
    }

    case "write_file_chunk": {
      const targetPath = getSafePath(params.path, ctx);
      return writeChunk(targetPath, params);
    }

    case "update_file": {
      const targetPath = getSafePath(params.path, ctx);
      // mode 未指定但有 content 字段时，默认回退为 overwrite
      const mode = params.mode || (params.content !== undefined ? "overwrite" : undefined);
      if (mode === "overwrite") {
        fs.writeFileSync(targetPath, params.content, "utf-8");
        return { message: "覆盖写入成功" };
      } else if (mode === "patch") {
        if (!fs.existsSync(targetPath)) {
          throw new Error("文件不存在，无法进行局部 patch 修改。");
        }
        let content = fs.readFileSync(targetPath, "utf-8");
        const patches = params.patches || [];
        for (const patch of patches) {
          if (!content.includes(patch.find)) {
            throw new Error(`未能在目标文件中定位到需要替换的特征代码块 [${patch.find}]`);
          }
          content = content.replace(patch.find, patch.replace);
        }
        fs.writeFileSync(targetPath, content, "utf-8");
        return { message: "补丁更新成功" };
      }
      throw new Error(`不支持的更新模式: ${params.mode}。请指定 mode: "overwrite" 或 mode: "patch"`);
    }

    case "run_code": {
      return runCodeInSandbox(params.code, ctx);
    }

    case "prepare_skill":
      return prepareSkill(params || {}, ctx);

    case "install_skill":
      return installSkill(params || {}, ctx);

    case "list_skills": {
      const skills = [];
      const entries = fs.readdirSync(ctx.skillsDir);
      for (const entry of entries) {
        try {
          const skillPath = getSafeSkillPath(ctx.skillsDir, entry);
          if (!fs.statSync(skillPath).isDirectory()) continue;

          const metaPath = path.join(skillPath, "skill.json");
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            skills.push({ name: entry, description: meta.description, entry: meta.entry });
          }
        } catch (e) {
          // 忽略单个 Skill 扫描报错，保证列表可用
        }
      }
      return skills;
    }

    case "load_skill": {
      const skillPath = getSafeSkillPath(ctx.skillsDir, params.name);
      const metaPath = path.join(skillPath, "skill.json");
      if (!fs.existsSync(metaPath)) {
        throw new Error(`加载失败：Skill '${params.name}' 未包含有效配置文件 skill.json`);
      }

      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const skillMd = fs.existsSync(path.join(skillPath, "SKILL.md")) ? fs.readFileSync(path.join(skillPath, "SKILL.md"), "utf-8") : "";
      const entryContent = fs.readFileSync(path.join(skillPath, meta.entry), "utf-8");

      return { name: params.name, ...meta, skillMd, entryContent };
    }

    case "run_skill": {
      const skillPath = getSafeSkillPath(ctx.skillsDir, params.name);
      const metaPath = path.join(skillPath, "skill.json");
      if (!fs.existsSync(metaPath)) {
        throw new Error(`执行失败：Skill '${params.name}' 不存在`);
      }

      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const entryFile = path.join(skillPath, meta.entry);

      const RUNTIME_MAP = {
        node: "node",
        bash: "bash",
        sh: "bash",
        python3: "python3",
        python: "python3",
      };
      const runtime = RUNTIME_MAP[meta.runtime] || "node";
      const cliArgs = Object.entries(params.args || {}).flatMap(([k, v]) => [`--${k}`, String(v)]);

      return new Promise((resolve, reject) => {
        // 超时看门狗：防止子脚本陷入死循环挂死
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error(`Skill '${params.name}' 执行超时(30秒)被强制终止。`));
        }, 30000);

        const proc = require("child_process").spawn(runtime, [entryFile, ...cliArgs], {
          cwd: skillPath,
          env: { ...process.env, GLAB_WORK_DIR: ctx.safeRoot },
        });

        let stdout = "",
          stderr = "";
        proc.stdout.on("data", (d) => (stdout += d));
        proc.stderr.on("data", (d) => (stderr += d));

        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve({ stdout, stderr, exitCode: code });
          } else {
            reject(new Error(`Skill 执行失败 (退出码: ${code})。\nstdout: ${stdout}\nstderr: ${stderr}`));
          }
        });

        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`无法启动 Skill 进程: ${err.message}`));
        });
      });
    }

    case "run_command": {
      if (!params || !params.command) {
        throw new Error("参数 command 不能为空");
      }
      return new Promise((resolve, reject) => {
        // 限制 30 秒执行超时
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error("Shell 命令执行超时(30s)被强制终止。"));
        }, 30000);

        const proc = exec(
          params.command,
          {
            cwd: ctx.safeRoot,
            env: { ...process.env, GLAB_WORK_DIR: ctx.safeRoot },
          },
          (error, stdout, stderr) => {
            clearTimeout(timer);
            if (error) {
              resolve({ stdout, stderr, exitCode: error.code || 1, error: error.message });
            } else {
              resolve({ stdout, stderr, exitCode: 0 });
            }
          },
        );
      });
    }

    case "paste_file": {
      const targetPath = getSafePath(params.path, ctx);
      if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
        throw new Error("文件不存在或路径为目录");
      }
      const mimeType = getMimeType(targetPath);
      const base64Data = fs.readFileSync(targetPath).toString("base64");
      return {
        mimeType,
        base64Data,
        filename: path.basename(targetPath),
      };
    }

    default:
      throw new Error(`未支持的指令 Action: ${action}`);
  }
}

// ==========================================
// 跨模型中转与校验
// ==========================================
function handleRelay(action, params, fromCtx) {
  if (!params || !params.target) throw new Error("relay 指令缺少 target 参数");
  const targetWs = clients.get(params.target);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    throw new Error(`中转目标 [${params.target}] 未连接或已断开，请确认对应标签页已打开并完成握手`);
  }

  if (action === "relay_verify") {
    const prompt = buildVerifyPrompt(params, fromCtx.role);
    targetWs.send(
      JSON.stringify({
        action: "relay_incoming",
        from: fromCtx.role,
        payload: prompt,
        autoSend: params.autoSend !== false,
      }),
    );
    return { message: `校验请求已转发至 [${params.target}]` };
  }

  if (action === "relay_result") {
    const summary = buildVerdictSummary(params, fromCtx.role);
    targetWs.send(
      JSON.stringify({
        action: "relay_incoming",
        from: fromCtx.role,
        payload: summary,
        autoSend: params.autoSend !== false,
      }),
    );
    return { message: `校验结论已转发至 [${params.target}]` };
  }
}

function buildVerifyPrompt(params, fromRole) {
  // 对用户内容做 HTML 转义，防止 prompt injection 污染校验提示结构
  const esc = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const roleLabel = fromRole === "gemini" ? "Gemini" : fromRole === "gpt" ? "ChatGPT" : fromRole;

  let prompt = `【GLAB 跨模型校验请求】来自：${roleLabel}\n\n`;
  prompt += `你是独立校验者（Verifier）。以下是另一个 AI（Proposer）处理用户任务的完整记录，请客观审查，不要受 Proposer 结论影响。\n\n`;
  prompt += `📋 原始问题：\n${esc(params.question) || "（未提供）"}\n\n`;
  prompt += `⚙️ 执行操作摘要：\n${esc(params.actions_summary) || "（未提供）"}\n\n`;
  prompt += `🎯 Proposer 的结论：\n${esc(params.conclusion) || "（未提供）"}\n\n`;

  if (params.execution_log && params.execution_log.length > 0) {
    prompt += `📊 原始执行日志：\n\`\`\`json\n${JSON.stringify(params.execution_log, null, 2)}\n\`\`\`\n\n`;
  }

  prompt += `---\n请从以下维度独立审查：\n`;
  prompt += `1. 操作路径是否合理？是否有更优方案？\n`;
  prompt += `2. 结论是否正确？是否存在遗漏或逻辑错误？\n`;
  prompt += `3. 是否存在安全风险？\n\n`;
  prompt += `完成审查后，你必须输出 relay_result 指令将校验结论返回，格式如下：\n\n`;
  prompt += `\`\`\`glab-call\n`;
  prompt += `{\n  "id": "result_${Date.now()}",\n`;
  prompt += `  "action": "relay_result",\n`;
  prompt += `  "params": {\n`;
  prompt += `    "target": "${fromRole}",\n`;
  prompt += `    "verdict": "PASS",\n`;
  prompt += `    "confidence": 90,\n`;
  prompt += `    "issues": [],\n`;
  prompt += `    "suggestion": ""\n`;
  prompt += `  },\n  "autoSend": true\n}\n`;
  prompt += `\`\`\`\n\n`;
  prompt += `verdict 取值：PASS（通过）/ WARN（警告，存在可改进之处）/ FAIL（失败，存在明显错误或风险）。\n`;
  prompt += `不要在 glab-call 之外添加额外解释，直接输出 glab-call 指令。`;

  return prompt;
}

function buildVerdictSummary(params, fromRole) {
  const roleLabel = fromRole === "gemini" ? "Gemini" : fromRole === "gpt" ? "ChatGPT" : fromRole;
  const verdictEmoji = params.verdict === "PASS" ? "✅" : params.verdict === "WARN" ? "⚠️" : "❌";

  let summary = `【GLAB 跨模型校验结论】来自：${roleLabel}\n\n`;
  summary += `${verdictEmoji} 校验结果：${params.verdict || "未知"}（置信度：${params.confidence ?? "?"}%）\n\n`;

  const issues = Array.isArray(params.issues) ? params.issues : [];
  if (issues.length > 0) {
    summary += `发现问题：\n`;
    issues.forEach((issue, i) => {
      summary += `${i + 1}. ${issue}\n`;
    });
    summary += `\n`;
  } else {
    summary += `发现问题：无\n\n`;
  }

  summary += `建议：${params.suggestion || "无"}\n\n---\n`;

  if (params.verdict === "PASS") {
    summary += `✅ 任务已通过独立校验，可以告知用户任务完成。`;
  } else if (params.verdict === "WARN") {
    summary += `⚠️ 校验发现潜在问题，建议根据上述意见优化后重新确认。`;
  } else {
    summary += `❌ 校验未通过，请根据上述发现问题修正方案后重新执行。`;
  }

  return summary;
}
