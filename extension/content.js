// ==========================================
// Gemini Local Agent Bridge (GLAB) Content Script
// ==========================================

let socket = null;
let wsPort = 9003;
let isGenerating = false;
let generateTimer = null;
let autoRunDepth = 0;
let isAutoRunEnabled = true;
let currentCLIRootDir = ''; // 暂存由本地 CLI 握手发送过来的根工作目录
let currentConvId = ''; // 当前对话的唯一标识
let currentConvExecutedIds = new Set(); // 当前对话已执行过的指令 ID 强缓存 Set

// 多流程任务队列控制变量
let activeTaskQueue = []; // 当前处于待执行状态的子任务队列
let queueResultsCollector = []; // 已执行完的子任务结果汇总
let isQueueModeActive = false; // 是否处于队列执行模式

// 安全读取存储 (防 context invalidated 崩溃)
function safeGetStorage(keys, callback) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    try {
      chrome.storage.local.get(keys, callback);
      return;
    } catch (e) {
      // 捕获上下文失效错误
    }
  }
  console.warn("[GLAB] 扩展程序上下文已作废，请刷新当前网页。");
}

// 安全写入存储 (防 context invalidated 崩溃)
function safeSetStorage(data, callback) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    try {
      chrome.storage.local.set(data, callback);
      return;
    } catch (e) {
      // 捕获上下文失效错误
    }
  }
  console.warn("[GLAB] 扩展程序上下文已作废，请刷新当前网页。");
}

// 获取当前对话唯一 ID
function getConversationId() {
  const match = window.location.pathname.match(/\/app\/([a-f0-9]+)/);
  return match ? match[1] : 'default_session';
}

// 缓存与同步当前会话已执行 ID 列表
function syncConvExecutedIds(callback) {
  const convId = getConversationId();
  if (convId === currentConvId) {
    if (callback) callback();
    return;
  }
  currentConvId = convId;
  const storageKey = `glab_history_${convId}`;
  safeGetStorage([storageKey], (res) => {
    const list = res[storageKey] || [];
    currentConvExecutedIds = new Set(list);
    console.log(`[GLAB] 已加载当前对话 [${convId}] 已执行指令黑名单:`, list);
    if (callback) callback();
  });
}

// ==========================================
// UI 模块：注入 Glassmorphism 悬浮面板
// ==========================================
function injectGLABPanel() {
  if (document.getElementById('glab-panel-root')) return;

  const root = document.createElement('div');
  root.id = 'glab-panel-root';

  // 悬浮球
  const floatBall = document.createElement('div');
  floatBall.id = 'glab-float-ball';
  floatBall.className = 'idle';
  floatBall.title = 'GLAB Agent: 空闲中';
  floatBall.innerHTML = '<span class="ball-icon">🤖</span><span class="status-indicator"></span>';

  // 抽屉面板
  const drawer = document.createElement('div');
  drawer.id = 'glab-drawer';
  drawer.innerHTML = `
    <div class="glab-header">
      <div class="glab-title-group">
        <span class="glab-logo">⚡</span>
        <h3>GLAB Agent Bridge</h3>
      </div>
      <button id="glab-close-drawer" title="收起面板">✕</button>
    </div>
    <div class="glab-body">
      <!-- CLI 状态与 Auto-run 控制 -->
      <div class="glab-section glab-status-card">
        <div class="status-item">
          <span class="label">服务状态</span>
          <span id="glab-cli-status" class="status-val offline"><span class="dot"></span>未连接</span>
        </div>
        <div class="status-item">
          <span class="label">Auto-run 模式</span>
          <label class="switch">
            <input type="checkbox" id="glab-autorun-toggle" checked>
            <span class="slider round"></span>
          </label>
        </div>
        <div class="status-item font-mono">
          <span class="label">连续步骤深度</span>
          <span id="glab-depth-counter" class="depth-val">0 / 10</span>
        </div>
      </div>

      <!-- 路径及初始化配置 -->
      <div class="glab-section">
        <div class="section-title">📁 本地目录配置</div>
        <div class="config-inputs">
          <div class="input-group">
            <label for="glab-input-workdir">工作根目录 (必填)</label>
            <div style="display: flex; gap: 8px; width: 100%;">
              <input type="text" id="glab-input-workdir" style="flex: 1;" placeholder="例如: /Users/username/project">
              <button id="glab-select-dir-btn" class="glab-btn primary" style="flex: 0 0 64px; padding: 0 8px; height: 28px; line-height: 28px;">📂 选择</button>
            </div>
          </div>
          <div class="input-group">
            <label for="glab-input-skillsdir">Skills 目录 (选填)</label>
            <input type="text" id="glab-input-skillsdir" placeholder="例如: /Users/username/.glab-skills">
          </div>
          <div class="input-group">
            <label for="glab-input-wsport">WS 服务端口</label>
            <input type="text" id="glab-input-wsport" placeholder="默认: 9003">
          </div>
          <div class="action-buttons">
            <button id="glab-save-config-btn" class="glab-btn primary">保存配置</button>
            <button id="glab-init-prompt-btn" class="glab-btn success" disabled>🚀 初始化对话规则</button>
          </div>
        </div>
      </div>

      <!-- 二次确认Diff展示区 -->
      <div id="glab-diff-container" class="glab-section diff-section" style="display: none;">
        <div class="section-title text-warning">⚠️ 敏感指令授权确认</div>
        <div id="glab-diff-meta" class="diff-meta"></div>
        <div id="glab-diff-view" class="diff-view font-mono"></div>
        <div class="diff-actions">
          <button id="glab-btn-approve" class="glab-btn success-pulse">✔️ 批准执行</button>
          <button id="glab-btn-reject" class="glab-btn danger">❌ 拒绝</button>
        </div>
      </div>

      <!-- 仿终端日志区 -->
      <div class="glab-section log-section">
        <div class="section-title">📊 本地运行日志</div>
        <div id="glab-terminal-log" class="terminal-view font-mono"></div>
      </div>
    </div>
  `;

  root.appendChild(floatBall);
  root.appendChild(drawer);
  document.body.appendChild(root);

  // 注入精细的 Glassmorphism 样式
  const style = document.createElement('style');
  style.textContent = `
    #glab-panel-root {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    .font-mono {
      font-family: ui-monospace, SFMono-Regular, SF Pro Mono, Menlo, Monaco, Consolas, monospace !important;
    }
    
    /* 悬浮球样式 */
    #glab-float-ball {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: rgba(30, 30, 30, 0.7);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1);
      transition: all 0.4s cubic-bezier(0.165, 0.84, 0.44, 1);
      position: relative;
    }
    #glab-float-ball:hover {
      transform: scale(1.08) translateY(-2px);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2);
    }
    .ball-icon {
      font-size: 24px;
    }
    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      position: absolute;
      right: 2px;
      bottom: 2px;
      border: 2px solid rgba(30, 30, 30, 0.8);
      background: #9ca3af;
      transition: background 0.3s;
    }

    /* 6 种状态动画 */
    #glab-float-ball.idle .status-indicator { background: #10b981; animation: glab-breathe-green 2s infinite; }
    #glab-float-ball.parsing { animation: glab-sweep-blue 1.5s infinite; }
    #glab-float-ball.parsing .status-indicator { background: #3b82f6; }
    #glab-float-ball.executing .ball-icon { display: inline-block; animation: glab-rotate-gear 1.5s infinite linear; }
    #glab-float-ball.executing .status-indicator { background: #8b5cf6; }
    #glab-float-ball.pending { animation: glab-shake-yellow 0.5s infinite; }
    #glab-float-ball.pending .status-indicator { background: #f59e0b; }
    #glab-float-ball.replying .status-indicator { background: #10b981; animation: glab-blink 0.8s infinite; }
    #glab-float-ball.error { animation: glab-blink-red 1s infinite; }
    #glab-float-ball.error .status-indicator { background: #ef4444; }

    /* 抽屉面板样式 */
    #glab-drawer {
      position: fixed;
      right: -360px;
      bottom: 96px;
      width: 330px;
      height: 520px;
      background: rgba(22, 22, 22, 0.75);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
      transition: right 0.4s cubic-bezier(0.165, 0.84, 0.44, 1);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      color: #e5e7eb;
    }
    #glab-drawer.open {
      right: 24px;
    }
    
    .glab-header {
      padding: 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .glab-title-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .glab-logo {
      font-size: 18px;
      color: #3b82f6;
    }
    .glab-header h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    #glab-close-drawer {
      background: none;
      border: none;
      color: #9ca3af;
      cursor: pointer;
      font-size: 18px;
      transition: color 0.2s;
    }
    #glab-close-drawer:hover {
      color: #fff;
    }

    .glab-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    
    .glab-section {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 10px;
      padding: 12px;
    }
    .section-title {
      font-size: 12px;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #9ca3af;
      margin-bottom: 10px;
    }
    .text-warning {
      color: #f59e0b !important;
    }

    /* 状态卡片 */
    .glab-status-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .status-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .status-item .label {
      color: #9ca3af;
    }
    .status-val {
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-val .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-val.online { color: #10b981; }
    .status-val.online .dot { background: #10b981; box-shadow: 0 0 8px #10b981; }
    .status-val.offline { color: #ef4444; }
    .status-val.offline .dot { background: #ef4444; }
    
    .depth-val {
      font-weight: 600;
      color: #3b82f6;
    }

    /* 配置输入框 */
    .config-inputs {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .input-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .input-group label {
      font-size: 11px;
      color: #9ca3af;
    }
    .path-display {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 6px 10px;
      color: #9ca3af;
      font-size: 11px;
      word-break: break-all;
      font-family: ui-monospace, SFMono-Regular, SF Pro Mono, Menlo, Monaco, Consolas, monospace;
    }
    .input-group input {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 6px 10px;
      color: #fff;
      font-size: 12px;
      transition: border-color 0.2s;
    }
    .input-group input:focus {
      border-color: #3b82f6;
      outline: none;
    }
    
    .action-buttons {
      display: flex;
      gap: 8px;
      margin-top: 6px;
    }
    .glab-btn {
      flex: 1;
      border: none;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .glab-btn.primary { background: #3b82f6; }
    .glab-btn.primary:hover { background: #2563eb; }
    .glab-btn.success { background: #10b981; }
    .glab-btn.success:hover:not(:disabled) { background: #059669; }
    .glab-btn.success:disabled { opacity: 0.5; cursor: not-allowed; }
    .glab-btn.danger { background: #ef4444; }
    .glab-btn.danger:hover { background: #dc2626; }
    .glab-btn.success-pulse {
      background: #10b981;
      animation: glab-pulse-green 1.5s infinite;
    }
    .glab-btn.success-pulse:hover { background: #059669; }

    /* Auto-run Toggle Switch */
    .switch {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 20px;
    }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #4b5563;
      transition: .3s;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 14px;
      width: 14px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .3s;
    }
    input:checked + .slider { background-color: #10b981; }
    input:checked + .slider:before { transform: translateX(16px); }
    .slider.round { border-radius: 20px; }
    .slider.round:before { border-radius: 50%; }

    /* 二次确认授权区 */
    .diff-section {
      border: 1px solid rgba(245, 158, 11, 0.3);
      background: rgba(245, 158, 11, 0.05);
    }
    .diff-meta {
      font-size: 11px;
      color: #e5e7eb;
      margin-bottom: 8px;
    }
    .diff-view {
      max-height: 120px;
      overflow-y: auto;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 6px;
      padding: 8px;
      font-size: 11px;
      color: #f3f4f6;
      border: 1px solid rgba(255, 255, 255, 0.05);
      margin-bottom: 10px;
      white-space: pre-wrap;
    }
    .diff-actions {
      display: flex;
      gap: 10px;
    }

    /* 终端日志区 */
    .log-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 120px;
    }
    .terminal-view {
      flex: 1;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 6px;
      padding: 8px;
      font-size: 11px;
      color: #10b981;
      overflow-y: auto;
      border: 1px solid rgba(255, 255, 255, 0.05);
      white-space: pre-wrap;
    }

    /* CSS 动画 Keyframes */
    @keyframes glab-breathe-green {
      0%, 100% { box-shadow: 0 0 6px rgba(16, 185, 129, 0.6); }
      50% { box-shadow: 0 0 16px rgba(16, 185, 129, 0.9); }
    }
    @keyframes glab-sweep-blue {
      0% { box-shadow: -10px 0 12px rgba(59, 130, 246, 0.5); }
      50% { box-shadow: 10px 0 12px rgba(59, 130, 246, 0.8); }
      100% { box-shadow: -10px 0 12px rgba(59, 130, 246, 0.5); }
    }
    @keyframes glab-rotate-gear {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes glab-shake-yellow {
      0%, 100% { transform: translateX(0) scale(1); box-shadow: 0 0 8px rgba(245, 158, 11, 0.6); }
      20%, 60% { transform: translateX(-4px) scale(1.02); }
      40%, 80% { transform: translateX(4px) scale(1.02); }
    }
    @keyframes glab-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    @keyframes glab-blink-red {
      0%, 100% { box-shadow: 0 0 6px rgba(239, 68, 68, 0.6); border-color: rgba(239, 68, 68, 0.8); }
      50% { box-shadow: 0 0 20px rgba(239, 68, 68, 0.9); border-color: rgba(239, 68, 68, 1); }
    }
    @keyframes glab-pulse-green {
      0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); }
      100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
  `;
  document.head.appendChild(style);

  // 初始化填入本地存储路径与配置
  safeGetStorage(['workDir', 'skillsDir', 'wsPort'], (res) => {
    if (res.workDir) {
      document.getElementById('glab-input-workdir').value = res.workDir;
      document.getElementById('glab-init-prompt-btn').disabled = false;
    }
    if (res.skillsDir) {
      document.getElementById('glab-input-skillsdir').value = res.skillsDir;
    }
    wsPort = res.wsPort || 9003;
    document.getElementById('glab-input-wsport').value = wsPort;
    
    // 从本地存储读取真实配置端口后，再发起首次 WebSocket 连接
    connectSocket();
  });

  // ==========================================
  // 事件绑定
  // ==========================================
  floatBall.addEventListener('click', () => {
    drawer.classList.toggle('open');
  });

  document.getElementById('glab-close-drawer').addEventListener('click', () => {
    drawer.classList.remove('open');
  });

  document.getElementById('glab-autorun-toggle').addEventListener('change', (e) => {
    isAutoRunEnabled = e.target.checked;
    logToTerminal(`Auto-run 模式已${isAutoRunEnabled ? '开启' : '关闭'}`);
  });

  // 通过 CLI 唤起原生文件夹选择框
  document.getElementById('glab-select-dir-btn').addEventListener('click', () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      alert("错误：请先保证 WebSocket 服务已成功连接！");
      return;
    }
    logToTerminal("正在通过 CLI 唤起本地系统文件夹选择器...");
    const selectId = `select_dir_${Date.now()}`;
    socket.send(JSON.stringify({
      id: selectId,
      action: "select_directory"
    }));
  });

  document.getElementById('glab-save-config-btn').addEventListener('click', () => {
    const workDir = document.getElementById('glab-input-workdir').value.trim();
    const skillsDir = document.getElementById('glab-input-skillsdir').value.trim();
    const wsPortInput = document.getElementById('glab-input-wsport').value.trim();
    const port = wsPortInput ? parseInt(wsPortInput, 10) : 9003;

    if (!workDir) {
      alert("错误：工作根目录不能为空！");
      return;
    }
    if (isNaN(port) || port <= 0 || port > 65535) {
      alert("错误：非法的端口号！");
      return;
    }

    wsPort = port;

    safeSetStorage({ workDir, skillsDir, wsPort }, () => {
      logToTerminal(`配置已保存！工作目录: ${workDir}, 端口: ${wsPort}`);
      document.getElementById('glab-init-prompt-btn').disabled = false;
      
      // 重新建立连接，以进行握手检查
      if (socket) socket.close();
      connectSocket();
    });
  });

  document.getElementById('glab-init-prompt-btn').addEventListener('click', () => {
    safeGetStorage(['workDir', 'skillsDir'], (res) => {
      if (!res.workDir) {
        alert("错误：请先设置工作目录！");
        return;
      }
      const prompt = generateInitPrompt(res.workDir, res.skillsDir);
      replyToGemini(prompt);
      drawer.classList.remove('open');
    });
  });
}

function updatePanelState(stateClass, label) {
  const ball = document.getElementById('glab-float-ball');
  if (ball) {
    ball.className = stateClass;
    ball.title = `GLAB Agent: ${label}`;
  }
}

function logToTerminal(text) {
  const term = document.getElementById('glab-terminal-log');
  if (term) {
    const timeStr = new Date().toLocaleTimeString();
    term.textContent += `\n[${timeStr}] ${text}`;
    term.scrollTop = term.scrollHeight;
  }
}

// 生成初始化 Prompt
function generateInitPrompt(workDir, skillsDir) {
  let prompt = `你是我的本地文件操作 Agent。从现在起，请严格遵守以下规则：\n\n`;
  prompt += `1. **工作根目录**：你只能操作以下目录及其子目录中的文件：\n   \`${workDir}\`\n   严禁生成任何超出该目录范围的路径（如 ../、/etc/ 等）。\n\n`;
  
  if (skillsDir) {
    prompt += `2. **Skills 能力**：\n   我本地有一个 Skills 目录，存放了可以复用的技能脚本：\n   \`${skillsDir}\`\n   当我的任务可能需要某个技能时，你可以：\n`;
    prompt += `   - 使用 \`list_skills\` 指令列出该目录下所有可用 Skill 及其功能摘要；\n`;
    prompt += `   - 使用 \`load_skill\` 指令读取某个 Skill 的完整描述文件（SKILL.md）和入口脚本；\n`;
    prompt += `   - 使用 \`run_skill\` 指令执行该 Skill 的入口脚本，并传入所需参数。\n`;
    prompt += `   你应先 list_skills 了解有哪些可用技能，再决定是否加载和运行。\n\n`;
  }
  
  prompt += `3. **指令与任务队列格式**：当需要操作本地文件或运行 Skill 时，必须严格使用如下 \`\`\`glab-call 代码块格式输出。你可以选择以下两种方式之一：\n\n`;
  prompt += `   **A. 单步执行指令**（单条 JSON 对象）：\n`;
  prompt += `   \`\`\`glab-call\n   {\n     "id": "唯一ID",\n     "action": "<操作名>",\n     "params": { ... }\n   }\n   \`\`\`\n\n`;
  prompt += `   **B. 多步骤任务队列**（推荐！当任务需要多步才能完成时，例如先读目录再读文件，或同时修改/创建多个文件，你可以打包成 JSON 数组在单个代码块中发出，或者输出多个独立的 glab-call 代码块。它们会依次串行执行并统一汇总结果）：\n`;
  prompt += `   \`\`\`glab-call\n   [\n     {\n       "id": "唯一ID1",\n       "action": "<操作名1>",\n       "params": { ... }\n     },\n     {\n       "id": "唯一ID2",\n       "action": "<操作名2>",\n       "params": { ... }\n     }\n   ]\n   \`\`\`\n\n`;
  prompt += `**可用操作速查表**：\n`;
  prompt += `- \`list_dir\`：列目录。params: { "path": "..." }\n`;
  prompt += `- \`read_file\`：读文件. params: { "path": "..." }\n`;
  prompt += `- \`write_file\`：新建文件（若已存在则报错）。params: { "path": "...", "content": "..." }\n`;
  prompt += `- \`update_file\` (覆盖)：整体覆盖写入。params: { "path": "...", "mode": "overwrite", "content": "完整新内容" }\n`;
  prompt += `- \`update_file\` (补丁)：局部替换。params: { "path": "...", "mode": "patch", "patches": [{ "find": "原文", "replace": "新文" }] }\n`;
  prompt += `- \`run_code\`：执行代码片段。params: { "code": "..." }\n`;
  if (skillsDir) {
    prompt += `- \`list_skills\` / \`load_skill\` / \`run_skill\`：Skills 相关操作。\n`;
  }
  prompt += `\n4. **等待反馈**：每次输出 \`\`\`glab-call 指令（或指令列表）后，停止继续输出，等待我将本地执行结果（若为多步骤，则是汇总结果）回传给你，再根据执行结论继续完成后续任务。\n\n`;
  prompt += `已准备就绪，工作目录已锁定为：${workDir}${skillsDir ? `，Skills 目录为：${skillsDir}` : ''}`;
  return prompt;
}

// ==========================================
// 通信模块：WebSocket 长连接
// ==========================================
function connectSocket() {
  safeGetStorage(['workDir'], (res) => {
    if (!res.workDir) {
      logToTerminal("配置挂起：尚未设置本地工作根目录，已静默断开代理连接。");
      updatePanelState('error', '未配置目录');
      return;
    }

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const url = `ws://localhost:${wsPort}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      const statusVal = document.getElementById('glab-cli-status');
      if (statusVal) {
        statusVal.innerText = '已连接';
        statusVal.className = 'status-val online';
      }
      updatePanelState('idle', '空闲中');
      logToTerminal("连接本地代理服务成功。");

      // 握手校验
      safeGetStorage(['workDir', 'skillsDir'], (res) => {
        socket.send(JSON.stringify({
          action: "shakehand",
          params: { workDir: res.workDir || '', skillsDir: res.skillsDir || '' }
        }));
      });
    };

    socket.onmessage = (event) => {
      try {
        const response = JSON.parse(event.data);
        
        // 处理系统选择目录回调
        if (response.id && response.id.startsWith('select_dir_')) {
          if (response.status === 'success' && response.data.selectedPath) {
            const pathInput = document.getElementById('glab-input-workdir');
            if (pathInput) {
              pathInput.value = response.data.selectedPath;
              logToTerminal(`已选择工作根目录: ${response.data.selectedPath}`);
            }
          } else {
            logToTerminal(`选择目录失败或已取消。`);
          }
          return;
        }

        if (response.action === "shakehand_reply") {
          if (response.status === "success") {
            currentCLIRootDir = response.data.workDir;
            document.getElementById('glab-init-prompt-btn').disabled = false;
            logToTerminal(`双端安全握手成功。工作根目录已锁定: ${currentCLIRootDir}`);
            
            // 【核心安全保护】只有握手锁定成功后，才挂载 Observer 开始监听页面消息
            observer.disconnect(); // 防止重复观察
            observer.observe(document.body, { childList: true, subtree: true });
            logToTerminal("网页消息监听（Observer）已成功激活工作。");
          } else {
            logToTerminal(`双端安全握手失败：${response.error}`);
          }
          return;
        }
        handleCLIResponse(response);
      } catch (e) {
        console.error("[GLAB] 解析本地消息失败:", e);
      }
    };

    socket.onclose = () => {
      const statusVal = document.getElementById('glab-cli-status');
      if (statusVal) {
        statusVal.innerText = '未连接';
        statusVal.className = 'status-val offline';
      }
      document.getElementById('glab-init-prompt-btn').disabled = true;
      updatePanelState('error', '连接断开');
      logToTerminal("与本地代理连接断开，5秒后自动重连...");
      
      // 【核心安全保护】连接断开或未配置时，立刻注销监听器，停止执行任何动作
      observer.disconnect();
      currentCLIRootDir = '';
      
      setTimeout(connectSocket, 5000);
    };
  });
}

// 模拟回填并自动发送
function replyToGemini(text) {
  const inputEl = document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (!inputEl) {
    logToTerminal("错误：未找到 Gemini 输入框，无法回填！");
    updatePanelState('error', '未找到输入框');
    return;
  }
  
  updatePanelState('replying', '回填并发送中');
  inputEl.focus();

  // 清空输入框
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  
  // 将换行符转为 <br>，并对其余 HTML 特殊字符进行安全转义，以防被解析为恶意 DOM 节点
  const htmlContent = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/\n/g, "<br>");

  // 必须使用 insertHTML 才能完整保留换行符，且确保 React 前端状态同步
  document.execCommand('insertHTML', false, htmlContent);
  
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));

  setTimeout(() => {
    const sendButton = document.querySelector('button[aria-label="发送消息"]') || 
                       document.querySelector('button.send-button');
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
    }
  }, 500);
}

// 处理 CLI 返回的数据
function handleCLIResponse(response) {
  const { id, status, data, error } = response;
  logToTerminal(`收到执行结果 [${id}]: ${status}`);

  if (isQueueModeActive) {
    // 队列模式：收集结果，触发串行队列中的下一项
    queueResultsCollector.push(response);
    
    // 如果子任务执行失败，直接熔断（停止后续执行）并汇总回填结果
    if (status === "error") {
      logToTerminal(`[队列调度] 子任务 [${id}] 执行失败，触发队列熔断。`);
      finishQueueExecution();
    } else {
      executeNextQueueTask();
    }
  } else {
    // 常规单步模式：直接反馈回填
    let feedbackText = `【GLAB 执行结果反馈】\n`;
    feedbackText += `指令ID: ${id}\n`;
    if (status === "success") {
      feedbackText += `执行状态: 成功\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
    } else {
      feedbackText += `执行状态: 失败\n原因: ${error}`;
    }
    replyToGemini(feedbackText);
  }
}

// ==========================================
// 队列调度核心函数
// ==========================================
function executeNextQueueTask() {
  if (activeTaskQueue.length === 0) {
    finishQueueExecution();
    return;
  }

  const currentTask = activeTaskQueue.shift();
  logToTerminal(`[队列调度] 启动子任务 [${currentTask.action}] ID: ${currentTask.id}`);
  handleInstructionFlow(currentTask);
}

function finishQueueExecution() {
  logToTerminal("多流程任务队列执行结束，正在汇总结果并自动回填...");
  
  let feedbackText = `【GLAB 多流程任务执行结果汇总反馈】\n\n`;
  
  // 汇总已执行子任务结果
  queueResultsCollector.forEach((res, index) => {
    feedbackText += `### [子任务 ${index + 1}] ID: ${res.id} (${res.status === 'success' ? '🟢 成功' : '🔴 失败'})\n`;
    if (res.status === "success") {
      feedbackText += `执行状态: 成功\n\`\`\`json\n${JSON.stringify(res.data, null, 2)}\n\`\`\`\n\n`;
    } else {
      feedbackText += `执行状态: 失败\n原因: ${res.error}\n\n`;
    }
  });

  // 如果队列中还有未执行的任务（因为前一步失败熔断或被用户拒绝），把它们也列出并标为“跳过”
  if (activeTaskQueue.length > 0) {
    feedbackText += `### 未执行子任务（由于前置任务失败或被用户拒绝而被跳过）：\n`;
    activeTaskQueue.forEach((skippedTask, index) => {
      feedbackText += `- 子任务 ID: ${skippedTask.id} (${skippedTask.action})\n`;
    });
    feedbackText += `\n`;
  }

  feedbackText += `【继续执行提示】请根据上述所有子任务的汇总执行结果，继续进行下一阶段的本地文件操作或完成后续任务。`;

  // 重置队列缓存
  isQueueModeActive = false;
  activeTaskQueue = [];
  queueResultsCollector = [];

  replyToGemini(feedbackText);
}

// ==========================================
// 核心逻辑：指令提取与控制分流
// ==========================================
function scanAndExecuteInstructions() {
  logToTerminal("开始扫描页面中的待执行指令...");

  // 先同步加载当前 URL 对应会话下的已执行 ID 记录
  syncConvExecutedIds(() => {
    const codeBlocks = document.querySelectorAll('pre code:not([data-glab-processed])');
    let pendingTasks = [];
    let isTaskArrayParsed = false; // 是否解析到了显式的多任务数组

    codeBlocks.forEach((codeEl) => {
      const text = codeEl.textContent.trim();
      const isGlabClass = codeEl.classList.contains('language-glab-call');
      const hasInstructionKeywords = text.includes('"action"') && text.includes('"params"');

      if (isGlabClass || hasInstructionKeywords) {
        codeEl.setAttribute('data-glab-processed', 'true');
        
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            isTaskArrayParsed = true;
            parsed.forEach((task) => {
              if (task.id) {
                if (!currentConvExecutedIds.has(task.id)) {
                  pendingTasks.push(task);
                } else {
                  logToTerminal(`提示：多任务子项 [${task.id}] 已执行过，自动忽略。`);
                }
              } else {
                logToTerminal("警告：多任务子项未包含有效 ID，安全起见拒绝执行。");
              }
            });
          } else {
            const instructionId = parsed.id;
            if (!instructionId) {
              logToTerminal("警告：指令未包含有效 ID，安全起见拒绝执行。");
              return;
            }

            if (currentConvExecutedIds.has(instructionId)) {
              logToTerminal(`提示：指令 ID [${instructionId}] 在当前对话中已执行过，已自动跳过。`);
              return;
            }
            pendingTasks.push(parsed);
          }
        } catch (e) {
          console.error("[GLAB] 指令 JSON 解析失败:", e);
          updatePanelState('error', '指令解析错误');
          logToTerminal(`指令 JSON 解析失败: ${e.message}`);
        }
      }
    });

    if (pendingTasks.length > 0) {
      // 写入存储强缓存
      pendingTasks.forEach(task => currentConvExecutedIds.add(task.id));
      const storageKey = `glab_history_${currentConvId}`;
      const updatedList = Array.from(currentConvExecutedIds);
      if (updatedList.length > 300) {
        updatedList.splice(0, updatedList.length - 200);
        currentConvExecutedIds = new Set(updatedList);
      }
      const saveObj = {};
      saveObj[storageKey] = updatedList;
      safeSetStorage(saveObj);

      // 判断是否启动多流程队列模式：
      // 如果解析到了数组，或者在同一个生成流中发现了多个待执行指令
      if (isTaskArrayParsed || pendingTasks.length > 1) {
        isQueueModeActive = true;
        queueResultsCollector = [];
        activeTaskQueue = pendingTasks;
        
        logToTerminal(`启动多流程队列模式，共 [${activeTaskQueue.length}] 个任务待执行。`);
        
        // 队列占用整体 1 个步骤深度
        autoRunDepth++;
        updateDepthCounter();
        
        executeNextQueueTask();
      } else {
        // 单步模式
        isQueueModeActive = false;
        const singleTask = pendingTasks[0];
        logToTerminal(`解析指令: [${singleTask.action}] ID: ${singleTask.id}`);
        handleInstructionFlow(singleTask);
      }
    } else {
      if (!isQueueModeActive) {
        autoRunDepth = 0;
        updateDepthCounter();
        updatePanelState('idle', '已就绪');
        logToTerminal("未发现新指令，步骤深度已重置。");
      }
    }
  });
}

function handleInstructionFlow(request) {
  const readOnlyActions = ['list_dir', 'read_file', 'list_skills', 'load_skill'];

  if (autoRunDepth >= 10) {
    updatePanelState('error', '步骤超限锁定');
    logToTerminal("警告：连续步骤已达上限 10 步，强行终止，请手动继续。");
    return;
  }

  if (readOnlyActions.includes(request.action)) {
    if (!isQueueModeActive) {
      autoRunDepth++;
      updateDepthCounter();
    }
    updatePanelState('executing', 'CLI 执行中');
    logToTerminal(`自动投递 [只读]: [${request.action}] ID: ${request.id}`);
    socket.send(JSON.stringify(request));
  } else {
    if (isAutoRunEnabled) {
      if (!isQueueModeActive) {
        autoRunDepth++;
        updateDepthCounter();
      }
      updatePanelState('executing', 'CLI 自动执行中');
      logToTerminal(`自动投递 [写入]: [${request.action}] ID: ${request.id}`);
      socket.send(JSON.stringify(request));
    } else {
      updatePanelState('pending', '等待授权确认');
      logToTerminal(`指令挂起等待授权: [${request.action}] ID: ${request.id}`);
      showConfirmUI(request);
    }
  }
}

function updateDepthCounter() {
  const counter = document.getElementById('glab-depth-counter');
  if (counter) {
    counter.innerText = `${autoRunDepth} / 10`;
  }
}

function showConfirmUI(request) {
  const diffContainer = document.getElementById('glab-diff-container');
  const diffMeta = document.getElementById('glab-diff-meta');
  const diffView = document.getElementById('glab-diff-view');

  if (!diffContainer || !diffMeta || !diffView) return;

  diffMeta.innerText = `指令: ${request.action} (ID: ${request.id})`;
  diffView.textContent = JSON.stringify(request.params, null, 2);
  diffContainer.style.display = 'block';

  // 展开抽屉，确保用户能看到
  const drawer = document.getElementById('glab-drawer');
  if (drawer) drawer.classList.add('open');

  document.getElementById('glab-btn-approve').onclick = () => {
    diffContainer.style.display = 'none';
    updatePanelState('executing', '授权指令执行中');
    logToTerminal(`用户已批准指令: ${request.id}`);
    
    if (!isQueueModeActive) {
      autoRunDepth++;
      updateDepthCounter();
    }
    socket.send(JSON.stringify(request));
  };

  document.getElementById('glab-btn-reject').onclick = () => {
    diffContainer.style.display = 'none';
    updatePanelState('idle', '已拒绝');
    logToTerminal(`用户已拒绝指令: ${request.id}`);
    
    if (isQueueModeActive) {
      queueResultsCollector.push({
        id: request.id,
        status: "error",
        error: "用户拒绝授权执行该敏感操作"
      });
      finishQueueExecution();
    }
  };
}

// 监听手动发送：点击发送按钮（用 closest 兼容子元素点击）
document.addEventListener('click', (e) => {
  if (e.target.closest('button[aria-label="发送消息"]') ||
      e.target.closest('button.send-button')) {
    autoRunDepth = 0;
    updateDepthCounter();
  }
});

// 监听手动发送：回车键（兼容 textbox 和 contenteditable）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  const target = e.target;
  const isInInputBox = target && (
    target.getAttribute('contenteditable') === 'true' ||
    target.getAttribute('role') === 'textbox' ||
    !!target.closest('[contenteditable="true"]') ||
    !!target.closest('[role="textbox"]')
  );
  if (isInInputBox) {
    autoRunDepth = 0;
    updateDepthCounter();
  }
});

// ==========================================
// 页面 Observer 与流式检测
// ==========================================
const observer = new MutationObserver(() => {
  if (generateTimer) clearTimeout(generateTimer);

  const hasStopBtn = !!document.querySelector('button[aria-label="停止回复"]') ||
                     !!document.querySelector('button[aria-label="停止生成"]');
  const hasLoading = !!document.querySelector('.loading-indicator') || 
                     !!document.querySelector('[aria-busy="true"]');

  const isCurrentlyGenerating = hasStopBtn || hasLoading;

  if (isCurrentlyGenerating) {
    isGenerating = true;
    updatePanelState('parsing', '解析指令中');
  } else {
    // 只有经历过生成状态后停止，才触发扫描，防止 DOM 其他变化引发死循环
    generateTimer = setTimeout(() => {
      if (isGenerating) {
        isGenerating = false;
        console.log('[GLAB Timer] AI 流结束，触发 scanAndExecuteInstructions()');
        scanAndExecuteInstructions();
      }
    }, 500);
  }
});

// ==========================================
// 初始化流程
// ==========================================
setTimeout(() => {
  injectGLABPanel();
}, 1000);
