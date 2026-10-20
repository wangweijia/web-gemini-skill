#!/usr/bin/env node

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { expandHomePath } = require("./config-paths");

const LABEL = "com.glab.local-agent";
const DEFAULT_PORT = 9003;
const BUNDLE_FILES = ["server.js", "service.js", "origins.js", "chunk-writer.js", "skill-authoring.js", "skills-directory.js", "config-paths.js", "package.json"];

function servicePaths(homeDir = os.homedir()) {
  const supportDir = path.join(homeDir, "Library", "Application Support", "GLAB");
  const installDir = path.join(supportDir, "cli");
  const logsDir = path.join(homeDir, "Library", "Logs", "GLAB");
  return {
    supportDir,
    installDir,
    nodePath: path.join(installDir, "bin", "node"),
    serverPath: path.join(installDir, "server.js"),
    logsDir,
    stdoutPath: path.join(logsDir, "cli.out.log"),
    stderrPath: path.join(logsDir, "cli.err.log"),
    agentDir: path.join(homeDir, "Library", "LaunchAgents"),
    plistPath: path.join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`),
  };
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildPlist(paths, options = {}) {
  const port = options.port || DEFAULT_PORT;
  const args = [paths.nodePath, paths.serverPath, `--port=${port}`];
  if (options.skillsDir) args.push(`--skills-dir=${options.skillsDir}`);
  const executablePath = options.environmentPath || process.env.PATH || "";
  const searchPath = [...new Set([...executablePath.split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])]
    .filter(Boolean).join(path.delimiter);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(paths.installDir)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(searchPath)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.stderrPath)}</string>
</dict>
</plist>
`;
}

function parseOptions(argv) {
  const [command, ...flags] = argv;
  if (!command || !["install", "start", "stop", "restart", "status", "uninstall"].includes(command)) {
    throw new Error("用法: node service.js <install|start|stop|restart|status|uninstall> [--port=9003] [--skills-dir=/绝对路径]");
  }
  const options = { command, port: DEFAULT_PORT, skillsDir: "" };
  for (const flag of flags) {
    if (flag.startsWith("--port=")) {
      options.port = Number(flag.slice(7));
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("无效的服务端口");
    } else if (flag.startsWith("--skills-dir=")) {
      options.skillsDir = expandHomePath(flag.slice(13));
      if (!path.isAbsolute(options.skillsDir)) throw new Error("Skills 目录必须是绝对路径");
    } else {
      throw new Error(`未知参数: ${flag}`);
    }
  }
  if (command !== "install" && flags.length) throw new Error("端口和 Skills 目录仅在 install 时设置");
  return options;
}

function stageBundle(sourceDir, supportDir, nodeExecutable = process.execPath) {
  if (!fs.existsSync(path.join(sourceDir, "node_modules", "ws", "package.json"))) {
    throw new Error("缺少 ws 依赖，请先在 cli 目录运行 npm ci");
  }
  fs.mkdirSync(supportDir, { recursive: true, mode: 0o700 });
  const stageDir = fs.mkdtempSync(path.join(supportDir, ".cli-stage-"));
  try {
    for (const filename of BUNDLE_FILES) fs.copyFileSync(path.join(sourceDir, filename), path.join(stageDir, filename));
    fs.mkdirSync(path.join(stageDir, "bin"), { mode: 0o700 });
    fs.copyFileSync(nodeExecutable, path.join(stageDir, "bin", "node"));
    fs.chmodSync(path.join(stageDir, "bin", "node"), 0o700);
    fs.cpSync(path.join(sourceDir, "node_modules"), path.join(stageDir, "node_modules"), { recursive: true });
    return stageDir;
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function launchctl(args, allowFailure = false) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`launchctl ${args[0]} 失败: ${(result.stderr || result.stdout || "未知错误").trim()}`);
  }
  return result;
}

function target() {
  return `gui/${process.getuid()}/${LABEL}`;
}

function domain() {
  return `gui/${process.getuid()}`;
}

function loaded() {
  return launchctl(["print", target()], true).status === 0;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(400);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function waitForPortFree(port) {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (!(await portOpen(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function install(options, paths) {
  const wasLoaded = loaded();
  if (!wasLoaded && await portOpen(options.port)) {
    throw new Error(`端口 ${options.port} 已被占用。请先停止原先在终端运行的服务，再安装后台服务。`);
  }
  const backupDir = `${paths.installDir}.previous`;
  const backupPlist = `${paths.plistPath}.previous`;
  if (fs.existsSync(backupDir) || fs.existsSync(backupPlist)) {
    throw new Error("检测到上次安装的备份文件，请先检查 .previous 文件，避免覆盖现有数据");
  }
  const stageDir = stageBundle(__dirname, paths.supportDir);
  let movedBundle = false;
  let movedPlist = false;
  let installedBundle = false;
  let installedPlist = false;
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.agentDir, { recursive: true });
    if (wasLoaded) {
      launchctl(["bootout", target()]);
      if (!(await waitForPortFree(options.port))) throw new Error(`端口 ${options.port} 仍被占用，无法切换服务`);
    }
    if (fs.existsSync(paths.installDir)) { fs.renameSync(paths.installDir, backupDir); movedBundle = true; }
    if (fs.existsSync(paths.plistPath)) { fs.renameSync(paths.plistPath, backupPlist); movedPlist = true; }
    fs.renameSync(stageDir, paths.installDir);
    installedBundle = true;
    installedPlist = true;
    fs.writeFileSync(paths.plistPath, buildPlist(paths, options), { mode: 0o600 });
    launchctl(["bootstrap", domain(), paths.plistPath]);
    if (movedBundle) fs.rmSync(backupDir, { recursive: true, force: true });
    if (movedPlist) fs.rmSync(backupPlist, { force: true });
    console.log(`GLAB 后台服务已安装并启动。登录后会自动运行。\n日志: ${paths.stdoutPath}\n错误日志: ${paths.stderrPath}`);
  } catch (error) {
    if (loaded()) launchctl(["bootout", target()], true);
    if (installedBundle) fs.rmSync(paths.installDir, { recursive: true, force: true });
    if (movedBundle) fs.renameSync(backupDir, paths.installDir);
    if (installedPlist) fs.rmSync(paths.plistPath, { force: true });
    if (movedPlist) fs.renameSync(backupPlist, paths.plistPath);
    if (wasLoaded && fs.existsSync(paths.plistPath)) launchctl(["bootstrap", domain(), paths.plistPath], true);
    throw error;
  } finally {
    if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function status(paths) {
  const result = launchctl(["print", target()], true);
  if (result.status !== 0) {
    console.log(fs.existsSync(paths.plistPath) ? "GLAB 后台服务已停止。" : "GLAB 后台服务尚未安装。");
    return;
  }
  const pid = result.stdout.match(/\bpid = (\d+)/)?.[1];
  console.log(`GLAB 后台服务已加载${pid ? `，PID ${pid}` : "，等待启动"}。\n日志: ${paths.stdoutPath}\n错误日志: ${paths.stderrPath}`);
}

async function main(argv = process.argv.slice(2)) {
  if (process.platform !== "darwin") throw new Error("后台服务安装目前支持 macOS；其他系统仍可用 npm start 前台运行");
  const options = parseOptions(argv);
  const paths = servicePaths();
  switch (options.command) {
    case "install": await install(options, paths); break;
    case "start":
      if (!fs.existsSync(paths.plistPath)) throw new Error("服务尚未安装，请先运行 service:install");
      if (!loaded()) launchctl(["bootstrap", domain(), paths.plistPath]);
      status(paths);
      break;
    case "stop":
      if (loaded()) launchctl(["bootout", target()]);
      status(paths);
      break;
    case "restart":
      if (!fs.existsSync(paths.plistPath)) throw new Error("服务尚未安装，请先运行 service:install");
      if (loaded()) launchctl(["kickstart", "-k", target()]);
      else launchctl(["bootstrap", domain(), paths.plistPath]);
      status(paths);
      break;
    case "status": status(paths); break;
    case "uninstall":
      if (loaded()) launchctl(["bootout", target()]);
      if (fs.existsSync(paths.plistPath)) fs.rmSync(paths.plistPath);
      if (fs.existsSync(paths.installDir)) fs.rmSync(paths.installDir, { recursive: true });
      console.log("GLAB 后台服务已卸载；日志和 Skills 目录已保留。");
      break;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`GLAB 服务管理失败: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { servicePaths, buildPlist, parseOptions, stageBundle };
