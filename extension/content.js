// ==========================================
// General Local Agent Bridge (GLAB) Content Script
// ==========================================

let socket = null;
let wsPort = 9003;
let isGenerating = false;
let generateTimer = null;
let autoRunDepth = 0;
let isAutoRunEnabled = true;
let isAutoVerifyEnabled = false;
let pendingAutoVerify = false; // one-shot flag set after queue completes, triggers verify on next idle AI turn
let currentCLIRootDir = ""; // 暂存由本地 CLI 握手发送过来的根工作目录
let currentConvId = ""; // 当前对话的唯一标识
let currentConvExecutedIds = new Set(); // 当前对话已执行过的指令 ID 强缓存 Set

// 分片写入状态跟踪相关变量
const approvedChunkPaths = new Set(); // 缓存已由用户手动确认的分片写入路径
const activeChunkWrites = new Map(); // 暂存执行中的分片指令 ID 到文件路径的映射

// 多流程任务队列控制变量
let activeTaskQueue = []; // 当前处于待执行状态的子任务队列
let queueResultsCollector = []; // 已执行完的子任务结果汇总
let isQueueModeActive = false; // 是否处于队列执行模式
let queueFilesToPaste = []; // 待粘贴的文件队列

// 将 Base64 解析还原为原生的 Blob 和 File 容器
async function base64ToFile(base64Data, mimeType, filename) {
  try {
    const res = await fetch(`data:${mimeType};base64,${base64Data}`);
    const blob = await res.blob();
    return new File([blob], filename, { type: mimeType });
  } catch (e) {
    console.error("[GLAB] base64ToFile conversion error:", e);
    // fallback using traditional atob if data URL fetch fails
    const binary = atob(base64Data);
    const array = [];
    for (let i = 0; i < binary.length; i++) {
      array.push(binary.charCodeAt(i));
    }
    const blob = new Blob([new Uint8Array(array)], { type: mimeType });
    return new File([blob], filename, { type: mimeType });
  }
}

// 安全读取存储 (防 context invalidated 崩溃)
function safeGetStorage(keys, callback) {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
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
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
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
  const path = window.location.pathname;
  // Gemini: /app/123456789
  const geminiMatch = path.match(/\/app\/([a-f0-9]+)/);
  if (geminiMatch) return geminiMatch[1];

  // ChatGPT: /c/6a607179-15a8-83ec-8295-09ebd30783e9
  const gptMatch = path.match(/\/c\/([a-f0-9-]+)/);
  if (gptMatch) return gptMatch[1];

  return "default_session";
}

let isStorageLoading = false;
let storageCallbacksQueue = [];

// 缓存与同步当前会话已执行 ID 列表
function syncConvExecutedIds(callback) {
  const convId = getConversationId();

  // 如果会话 ID 一致且不处于读取状态下，直接回调
  if (convId === currentConvId && !isStorageLoading) {
    if (callback) callback();
    return;
  }

  // 会话切换，重置加载状态与队列
  if (convId !== currentConvId) {
    currentConvId = convId;
    isStorageLoading = true;
    storageCallbacksQueue = [];
  }

  if (callback) {
    storageCallbacksQueue.push(callback);
  }

  // 如果当前已经在读取中，不再重复启动读取，只需加入回调队列等待即可
  if (storageCallbacksQueue.length > 1) {
    return;
  }

  const storageKey = `glab_history_${convId}`;
  safeGetStorage([storageKey], (res) => {
    const list = res[storageKey] || [];
    currentConvExecutedIds = new Set(list);
    console.log(`[GLAB] 已加载当前对话 [${convId}] 已执行指令黑名单:`, list);

    isStorageLoading = false;
    const queue = storageCallbacksQueue;
    storageCallbacksQueue = [];
    queue.forEach((cb) => cb());
  });
}

// ==========================================
// UI 模块：注入 Glassmorphism 悬浮面板
// ==========================================
function injectGLABPanel() {
  if (document.getElementById("glab-panel-root")) return;

  const root = document.createElement("div");
  root.id = "glab-panel-root";

  // 悬浮球
  const floatBall = document.createElement("div");
  floatBall.id = "glab-float-ball";
  floatBall.className = "idle";
  floatBall.title = "GLAB Agent: 空闲中";
  floatBall.innerHTML = '<span class="ball-icon">🤖</span><span class="status-indicator"></span>';

  // 抽屉面板
  const drawer = document.createElement("div");
  drawer.id = "glab-drawer";
  drawer.innerHTML = `
    <div class="glab-header">
      <div class="glab-title-group">
        <span class="glab-logo">⚡</span>
        <h3>GLAB · 通用本地代理</h3>
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
        <div class="status-item">
          <span class="label">Auto-verify 校验</span>
          <label class="switch">
            <input type="checkbox" id="glab-autoverify-toggle">
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
          <div class="action-buttons" style="margin-top: 4px;">
            <button id="glab-verify-btn" class="glab-btn verify" disabled>🔍 发送校验</button>
            <button id="glab-report-output-btn" class="glab-btn primary">反馈输出中断</button>
          </div>
          <div id="glab-output-error" role="status" style="display: none; margin-top: 8px;">指令不完整或格式无效，本次扫描未执行指令。可点击“反馈输出中断”让 AI 缩短后重试。
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
  const style = document.createElement("style");
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
    .glab-btn.verify { background: #f59e0b; }
    .glab-btn.verify:hover:not(:disabled) { background: #d97706; }
    .glab-btn.verify:disabled { opacity: 0.5; cursor: not-allowed; }

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
  safeGetStorage(["workDir", "skillsDir", "wsPort"], (res) => {
    if (res.workDir) {
      document.getElementById("glab-input-workdir").value = res.workDir;
      document.getElementById("glab-init-prompt-btn").disabled = false;
      document.getElementById("glab-verify-btn").disabled = false;
    }
    if (res.skillsDir) {
      document.getElementById("glab-input-skillsdir").value = res.skillsDir;
    }
    wsPort = res.wsPort || 9003;
    document.getElementById("glab-input-wsport").value = wsPort;

    // 从本地存储读取真实配置端口后，再发起首次 WebSocket 连接
    connectSocket();
  });

  // ==========================================
  // 事件绑定
  // ==========================================
  floatBall.addEventListener("click", () => {
    drawer.classList.toggle("open");
  });

  document.getElementById("glab-close-drawer").addEventListener("click", () => {
    drawer.classList.remove("open");
  });

  document.getElementById("glab-autorun-toggle").addEventListener("change", (e) => {
    isAutoRunEnabled = e.target.checked;
    logToTerminal(`Auto-run 模式已${isAutoRunEnabled ? "开启" : "关闭"}`);
  });

  document.getElementById("glab-autoverify-toggle").addEventListener("change", (e) => {
    isAutoVerifyEnabled = e.target.checked;
    logToTerminal(`Auto-verify 模式已${isAutoVerifyEnabled ? "开启，队列执行完成后将自动触发校验" : "关闭"}`);
  });

  document.getElementById("glab-report-output-btn").addEventListener("click", () => {
    if (isPageGenerating() || isGenerating) {
      logToTerminal("请等待输出结束后再反馈中断。");
      return;
    }
    replyToChat("【GLAB 用户反馈】上一条命令输出可能被截断、消失或格式无效。请检查已有执行反馈，不要假定未收到成功反馈的操作已经完成，也不要盲目重跑有副作用的命令。普通短指令仍可批量发送。但对于一个过长命令拆出的各块，必须线性分轮：本轮只输出当前块，结束回复，等它执行成功后才生成并运行下一块，禁止一次输出该长命令的多个分块。文件 content 使用 write_file_chunk，每片缩短至之前的一半（最多 1000 字符且最多 20 行）。如果需要改变已有分片内容或总数，请用新的 transferId，从第 0 片重新发送整个文件；该长命令的后续分块必须等待当前块执行成功后再生成。", [], true);
  });

  document.getElementById("glab-verify-btn").addEventListener("click", () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      logToTerminal("错误：WebSocket 未连接，无法触发校验");
      return;
    }
    triggerVerifyPrompt();
    drawer.classList.remove("open");
  });

  // 通过 CLI 唤起原生文件夹选择框
  document.getElementById("glab-select-dir-btn").addEventListener("click", () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      alert("错误：请先保证 WebSocket 服务已成功连接！");
      return;
    }
    logToTerminal("正在通过 CLI 唤起本地系统文件夹选择器...");
    const selectId = `select_dir_${Date.now()}`;
    socket.send(
      JSON.stringify({
        id: selectId,
        action: "select_directory",
      }),
    );
  });

  document.getElementById("glab-save-config-btn").addEventListener("click", () => {
    const workDir = document.getElementById("glab-input-workdir").value.trim();
    const skillsDir = document.getElementById("glab-input-skillsdir").value.trim();
    const wsPortInput = document.getElementById("glab-input-wsport").value.trim();
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
      document.getElementById("glab-init-prompt-btn").disabled = false;
      document.getElementById("glab-verify-btn").disabled = false;
      if (socket) socket.close();
      connectSocket();
    });
  });

  document.getElementById("glab-init-prompt-btn").addEventListener("click", () => {
    safeGetStorage(["workDir", "skillsDir"], (res) => {
      if (!res.workDir) {
        alert("错误：请先设置工作目录！");
        return;
      }
      const prompt = generateInitPrompt(res.workDir, res.skillsDir);
      replyToChat(prompt);
      drawer.classList.remove("open");
    });
  });
}

function updatePanelState(stateClass, label) {
  const ball = document.getElementById("glab-float-ball");
  if (ball) {
    ball.className = stateClass;
    ball.title = `GLAB Agent: ${label}`;
  }
}

function logToTerminal(text) {
  const term = document.getElementById("glab-terminal-log");
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

  prompt += `3. **指令与任务队列**：允许单条 JSON 对象、JSON 数组或多个 glab-call 代码块。多条指令会按顺序串行执行并汇总反馈；普通短指令不限制数量，按内容长度决定是否分批；但一个过长命令拆出的各块必须遵守下面的线性分轮规则。依赖前一步返回值的指令应等待反馈再生成；一批指令输出完后停止，等待执行结果再继续。autoSend 默认为 true，设为 false 时等待用户手动发送反馈。单条格式：\n`;
  prompt += '\n```glab-call\n{"id":"唯一ID","action":"list_dir","params":{"path":"."},"autoSend":true}\n```\n\n';
  prompt += '多指令示例：\n```glab-call\n[{"id":"read_a","action":"read_file","params":{"path":"a.txt"}},{"id":"read_b","action":"read_file","params":{"path":"b.txt"},"autoSend":true}]\n```\n\n';
  prompt += `**创建 Skill 前置规则**：当用户要求生成或安装新的 Skill 时，必须先单独执行 prepare_skill，params: { "name": "技能目录名", "runtime": "python3|node|bash" }，等待返回当前目录、文件规范和运行条件后再生成文件。不得凭记忆猜测 Skill 格式。按返回的草稿路径写入 skill.json、SKILL.md 和入口脚本，完成后调用 install_skill，再用 list_skills 与 load_skill 验证；长文件仍按线性分轮规则生成。\n\n`;
  prompt += `**可用操作速查表**：\n`;
  prompt += `- \`prepare_skill\`：只读获取创建技能所需的当前条件。params: { "name": "...", "runtime": "python3" }\n`;
  prompt += `- \`install_skill\`：校验并安装工作目录 .glab-skill-drafts/<name> 下的技能草稿，不覆盖已有技能。params: { "name": "..." }\n`;
  prompt += `- \`list_dir\`：列目录。params: { "path": "..." }\n`;
  prompt += `- \`read_file\`：读文件. params: { "path": "..." }\n`;
  prompt += `- \`write_file\`：新建或覆盖文件。params: { "path": "...", "content": "..." }\n`;
  prompt += '- `write_file_chunk`：长文件分轮写入。params: { "path": "...", "transferId": "本次完整写入的唯一ID", "chunkIndex": 0, "totalChunks": 3, "content": "当前分片文本" }。每片最多 2000 字符且最多 40 行；同一次写入的 path、transferId、totalChunks 保持不变，编号从 0 开始。\n';
  prompt += `- \`update_file\` (覆盖)：整体覆盖写入。params: { "path": "...", "mode": "overwrite", "content": "完整新内容" }\n`;
  prompt += `- \`update_file\` (补丁)：局部替换。params: { "path": "...", "mode": "patch", "patches": [{ "find": "原文", "replace": "新文" }] }\n`;
  prompt += `- \`run_code\`：执行代码片段. params: { "code": "..." }\n`;
  prompt += `- \`run_command\`：执行本地 Shell 命令行指令（例如文件重命名、移动、新建等）。params: { "command": "..." }\n`;
  prompt += `- \`paste_file\`：自动读取本地文件并模拟粘贴上传至 AI 聊天输入框。params: { "path": "..." }\n`;
  if (skillsDir) {
    prompt += `- \`list_skills\` / \`load_skill\` / \`run_skill\`：Skills 相关操作。\n`;
  }
  prompt += `- \`relay_verify\`：将当前任务的问题、操作摘要和结论发送至另一个 AI 进行独立校验。params: { "target": "gpt"|"gemini", "question": "...", "actions_summary": "...", "conclusion": "...", "execution_log": [] (可选) }\n`;
  prompt += `- \`relay_result\`：（由校验方使用）将校验结论发回给提案方。params: { "target": "gemini"|"gpt", "verdict": "PASS|WARN|FAIL", "confidence": 0-100, "issues": [], "suggestion": "..." }\n`;
  prompt += `\n6. **跨模型校验规则**：当你完成一项重要任务后，如果需要确保结论的准确性，可以主动输出 \`relay_verify\` 指令将问题与结论发往另一个 AI 校验。校验结果返回后，你可以根据 verdict 决定是否需要修正方案。\n\n`;
  prompt += `\n4. **过长命令必须线性分轮**：当一个命令代码块过长时，把它拆成多个可顺序执行的短 glab-call 代码块，并跨回复逐块完成：生成当前块 → 结束回复 → GLAB 执行 → 收到成功反馈 → 才生成下一块。禁止在同一回答中输出该长命令的多个分块，也禁止把它们打包成数组；这条限制只针对过长命令的拆分，不禁止普通短指令批量执行。对于 write_file 或 update_file(overwrite)，content 超过 2000 字符或 40 行时使用 write_file_chunk，每片同时满足这两个上限。先规划 totalChunks，保持 path、transferId 和 totalChunks 一致；每轮只生成该文件当前的一片，设 autoSend: true，等成功反馈中的 nextChunkIndex 再生成下一片。长脚本应先按此方式分片写入文件，全部写入成功后再单独执行，不要把 Shell 语法或 JSON 从中间截断成无法运行的命令。全部分片到齐才会替换目标文件，中途不要读取或运行未完成的新文件。普通短指令批次的完整 JSON 合计建议控制在约 6000 字符以内；这是保守输出预算，不是平台精确上限，超过时也要分轮等待反馈。\n`;
  prompt += `5. **中断恢复**：若用户报告输出截断、消失或 JSON 无效，将后续每片长度减半。不要假定失败指令已执行。相同 transferId 和 chunkIndex 仅允许重发完全相同的内容；如需调整分片长度、内容或总数，使用新的 transferId，从第 0 片重新发送整个文件。CLI 重启后也应重新开始。收到 complete: true 才表示文件写入完成。\n\n`;
  prompt += `已准备就绪，工作目录已锁定为：${workDir}${skillsDir ? `，Skills 目录为：${skillsDir}` : ""}`;
  return prompt;
}

function detectRole() {
  if (location.hostname.includes("gemini.google.com")) return "gemini";
  if (location.hostname.includes("chatgpt.com")) return "gpt";
  return "";
}

// ==========================================
// 通信模块：WebSocket 长连接
// ==========================================
function connectSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const url = `ws://localhost:${wsPort}`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    const statusVal = document.getElementById("glab-cli-status");
    if (statusVal) {
      statusVal.innerText = "已连接";
      statusVal.className = "status-val online";
    }
    updatePanelState("idle", "空闲中");
    logToTerminal("连接本地代理服务成功。");

    // 握手校验
    safeGetStorage(["workDir", "skillsDir"], (res) => {
      socket.send(
        JSON.stringify({
          action: "shakehand",
          params: {
            workDir: res.workDir || "",
            skillsDir: res.skillsDir || "",
            role: detectRole(),
          },
        }),
      );
    });
  };

  socket.onmessage = (event) => {
    try {
      const response = JSON.parse(event.data);

      // 处理系统选择目录回调
      if (response.id && response.id.startsWith("select_dir_")) {
        if (response.status === "success" && response.data.selectedPath) {
          const pathInput = document.getElementById("glab-input-workdir");
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
          currentCLIRootDir = response.data.workDir || "";

          // 同步从 CLI 获取到的 skillsDir 到 UI 面板和本地存储中
          const cliSkillsDir = response.data.skillsDir || "";
          const skillsDirInput = document.getElementById("glab-input-skillsdir");
          if (skillsDirInput && cliSkillsDir) {
            skillsDirInput.value = cliSkillsDir;
            safeSetStorage({ skillsDir: cliSkillsDir });
          }

          if (currentCLIRootDir) {
            document.getElementById("glab-init-prompt-btn").disabled = false;
            logToTerminal(`双端安全握手成功。工作根目录已锁定: ${currentCLIRootDir}`);

            // 【核心安全保护】只有握手锁定成功后，才挂载 Observer 开始监听页面消息
            observer.disconnect(); // 防止重复观察
            observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-state", "data-is-streaming", "aria-busy", "data-testid", "aria-label", "class"] });
            logToTerminal("网页消息监听（Observer）已成功激活工作。");
          } else {
            document.getElementById("glab-init-prompt-btn").disabled = true;
            logToTerminal("连接已建立，但本地工作目录尚未设置。请在面板中配置并保存或点击“选择”按钮。");
            observer.disconnect();
          }
        } else {
          logToTerminal(`双端安全握手失败：${response.error}`);
        }
        return;
      }

      if (response.action === "relay_incoming") {
        logToTerminal(`收到来自 [${response.from}] 的中转消息，正在回填...`);
        replyToChat(response.payload, [], response.autoSend !== false);
        return;
      }

      handleCLIResponse(response);
    } catch (e) {
      console.error("[GLAB] 解析本地消息失败:", e);
    }
  };

  socket.onclose = () => {
    const statusVal = document.getElementById("glab-cli-status");
    if (statusVal) {
      statusVal.innerText = "未连接";
      statusVal.className = "status-val offline";
    }
    document.getElementById("glab-init-prompt-btn").disabled = true;
    document.getElementById("glab-verify-btn").disabled = true;
    updatePanelState("error", "连接断开");
    logToTerminal("与本地代理连接断开，5秒后自动重连...");

    // 【核心安全保护】连接断开或未配置时，立刻注销监听器，停止执行任何动作
    observer.disconnect();
    currentCLIRootDir = "";

    setTimeout(connectSocket, 5000);
  };
}

// 查找输入框容器 (适配 Gemini 与 ChatGPT)
function findInputElement() {
  // 1. ChatGPT #prompt-textarea 及其内部/层级 DOM
  const chatgptBox =
    document.querySelector("#prompt-textarea") ||
    document.querySelector('div[id="prompt-textarea"]') ||
    document.querySelector("textarea#prompt-textarea");
  if (chatgptBox) {
    if (chatgptBox.getAttribute("contenteditable") === "true" || chatgptBox.tagName.toLowerCase() === "textarea") {
      return chatgptBox;
    }
    const innerEditable = chatgptBox.querySelector('[contenteditable="true"]') || chatgptBox.querySelector("p");
    if (innerEditable) return innerEditable;
    return chatgptBox;
  }

  // 2. Gemini 可编辑框
  const geminiInput = document.querySelector('div[contenteditable="true"][role="textbox"]') || document.querySelector('div[contenteditable="true"]');
  if (geminiInput) return geminiInput;

  // 3. 通用兜底
  return document.querySelector("textarea");
}

// 查找发送按钮 (适配 Gemini 与 ChatGPT)
function findSendButton() {
  // 1. ChatGPT 特有按钮 (data-testid)
  const gptSendBtn = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[data-testid*="send"]');
  if (gptSendBtn) return gptSendBtn;

  // 2. Gemini 容器内按钮 (.send-button / gem-icon-button)
  const container = document.querySelector(".send-button") || document.querySelector('gem-icon-button[class*="send"]');
  const innerButton = container ? container.querySelector("button") : null;
  if (innerButton) return innerButton;

  // 3. 多语言/通用 aria-label 判定
  return (
    document.querySelector('button[aria-label="发送"]') ||
    document.querySelector('button[aria-label="发送消息"]') ||
    document.querySelector('button[aria-label="Send message"]') ||
    document.querySelector('button[aria-label="Send"]') ||
    document.querySelector('button[aria-label="Send prompt"]') ||
    document.querySelector('button[aria-label="发送 Prompt"]') ||
    document.querySelector('button[aria-label*="发送"]') ||
    document.querySelector('button[aria-label*="Send"]')
  );
}

// 模拟回填并自动发送，支持携带待粘贴的文件列表与是否自动发送标记
function replyToChat(text, filesToPaste = [], autoSend = true, conversationId = getConversationId(), deadline = Date.now() + 120000) {
  if (getConversationId() !== conversationId) {
    logToTerminal("对话已切换，取消旧对话的回填。");
    return;
  }
  if (isPageGenerating() || isGenerating) {
    if (Date.now() >= deadline) {
      logToTerminal("等待生成结束超时，已取消回填。");
      return;
    }
    setTimeout(() => replyToChat(text, filesToPaste, autoSend, conversationId, deadline), 500);
    return;
  }
  const inputEl = findInputElement();
  if (!inputEl) {
    logToTerminal("错误：未找到当前聊天页面的输入框，无法回填！");
    updatePanelState("error", "未找到输入框");
    return;
  }

  updatePanelState("replying", autoSend ? "回填并发送中" : "回填完成，等待发送");
  inputEl.focus();

  const isTextarea = inputEl.tagName.toLowerCase() === "textarea";

  // 将换行符转为 <br>，并对其余 HTML 特殊字符进行安全转义，以防被解析为恶意 DOM 节点
  const htmlContent = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/\n/g, "<br>");

  const textBeforeInsert = inputEl.textContent;

  if (isTextarea) {
    inputEl.value = text;
  } else {
    // 清空输入框
    // 将选区明确限定在输入框内，避免焦点失效时选中聊天正文。
    if (document.activeElement !== inputEl && !inputEl.contains(document.activeElement)) {
      logToTerminal("输入框未获得焦点，已取消回填。");
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    selection.removeAllRanges();
    selection.addRange(range);

    // 必须优先尝试 insertHTML 才能完整保留换行符，且确保 React / ProseMirror 前端状态同步
    const inserted = document.execCommand("insertHTML", false, htmlContent);

    // 兜底策略 1：如果 insertHTML 写入失效，尝试 insertText
    if ((!inserted || inputEl.textContent === textBeforeInsert) && text.trim() !== "") {
      document.execCommand("insertText", false, text);
    }

    // 兜底策略 2：如果依旧没有生效，通过 innerHTML 强行改写
    if (inputEl.textContent === textBeforeInsert && text.trim() !== "") {
      logToTerminal("警告：execCommand 写入失效，触发 innerHTML 强行回填机制...");
      inputEl.innerHTML = htmlContent;
    }
  }

  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  inputEl.dispatchEvent(new Event("change", { bubbles: true }));

  // 如果有待粘贴的文件，逐个进行模拟粘贴
  if (filesToPaste && filesToPaste.length > 0) {
    logToTerminal(`准备在输入框中粘贴 ${filesToPaste.length} 个文件...`);
    for (const file of filesToPaste) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      });
      inputEl.dispatchEvent(pasteEvent);
      logToTerminal(`文件 [${file.name}] 已完成粘贴。`);
    }
  }

  if (autoSend) {
    const sendDelay = filesToPaste && filesToPaste.length > 0 ? 1000 : 500;
    setTimeout(() => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (getConversationId() !== conversationId || !inputEl.isConnected) {
          clearInterval(interval);
          logToTerminal("页面或输入框已切换，自动发送已取消。");
          return;
        }
        // 每次重新查询：SPA 可能替换按钮，也可能把原按钮改成停止按钮。
        const sendButton = findSendButton();
        const label = sendButton?.getAttribute("aria-label") || "";
        const testId = sendButton?.getAttribute("data-testid") || "";
        const container = sendButton?.closest("gem-icon-button, .send-button");
        const canSend = sendButton && sendButton.isConnected &&
          !sendButton.disabled && !sendButton.hasAttribute("disabled") &&
          sendButton.getAttribute("aria-disabled") !== "true" &&
          container?.getAttribute("aria-disabled") !== "true" &&
          !container?.classList.contains("disabled") &&
          !/stop|停止/i.test(label + " " + testId);
        if (!isPageGenerating() && !isGenerating && canSend) {
          clearInterval(interval);
          sendButton.click();
          logToTerminal("已点击发送按钮。");
          autoRunDepth = 0;
          updateDepthCounter();
        } else if (attempts >= 150) {
          clearInterval(interval);
          logToTerminal("30 秒内未满足安全发送条件，请手动发送。");
        }
      }, 200);
    }, sendDelay);
  } else {
    setTimeout(() => {
      updatePanelState("idle", "已就绪");
      logToTerminal("回填完毕，根据指令 autoSend: false 挂起，等待用户手动确认发送...");
    }, 500);
  }
}

// 处理 CLI 返回的数据
async function handleCLIResponse(response) {
  const { id, action, status, data, error, autoSend } = response;
  logToTerminal(`收到执行结果 [${id}]: ${status} (autoSend: ${autoSend})`);

  // 分片写入自动授权缓存的清理
  if (action === "write_file_chunk") {
    const path = activeChunkWrites.get(id);
    if (path) {
      activeChunkWrites.delete(id);
      if (status === "error" || (status === "success" && data && data.message === "全部分片写入完成")) {
        approvedChunkPaths.delete(path);
        logToTerminal(`分片写入结束或出错，清理缓存授权路径: ${path}`);
      }
    }
  }

  if (isQueueModeActive) {
    // 如果是 paste_file 成功，我们将其解析并暂存在 queueFilesToPaste 中
    if (status === "success" && action === "paste_file" && data) {
      try {
        const file = await base64ToFile(data.base64Data, data.mimeType, data.filename);
        queueFilesToPaste.push(file);
        logToTerminal(`文件 [${file.name}] 成功解码并加入待粘贴列表。`);

        // 缩减大体积 Base64 数据以防填充到页面输入框中
        response.data = {
          ...data,
          base64Data: `[Base64 Data: ${data.base64Data.length} chars, automatically hidden in text prompt]`,
        };
      } catch (e) {
        logToTerminal(`文件解码失败: ${e.message}`);
      }
    }

    // 队列模式：收集结果，触发串行队列中的下一项
    queueResultsCollector.push(response);

    // 如果子任务执行失败，直接熔断（停止后续执行）并汇总回填结果
    if (status === "error") {
      logToTerminal(`[队列调度] 子任务 [${id}] 执行失败，触发队列熔断。`);
      finishQueueExecution(autoSend);
    } else {
      executeNextQueueTask();
    }
  } else {
    // 常规单步模式：直接反馈回填
    let feedbackText = `【GLAB 执行结果反馈】\n`;
    feedbackText += `指令ID: ${id}\n`;
    const shouldAutoSend = autoSend !== false && autoSend !== "false";
    if (status === "success") {
      let displayData = data;
      if (action === "paste_file" && data) {
        displayData = {
          ...data,
          base64Data: `[Base64 Data: ${data.base64Data.length} chars, automatically hidden in text prompt]`,
        };
      }
      feedbackText += `执行状态: 成功\n\`\`\`json\n${JSON.stringify(displayData, null, 2)}\n\`\`\``;
      if (action === "paste_file" && data) {
        try {
          const file = await base64ToFile(data.base64Data, data.mimeType, data.filename);
          replyToChat(feedbackText, [file], shouldAutoSend);
        } catch (e) {
          logToTerminal(`文件解码失败: ${e.message}`);
          replyToChat(feedbackText + `\n解码失败: ${e.message}`, [], shouldAutoSend);
        }
      } else {
        replyToChat(feedbackText, [], shouldAutoSend);
      }
    } else {
      feedbackText += `执行状态: 失败\n原因: ${error}`;
      replyToChat(feedbackText, [], shouldAutoSend);
    }
  }
}

// ==========================================
// 队列调度核心函数
// ==========================================
function executeNextQueueTask() {
  if (activeTaskQueue.length === 0) {
    const lastResponse = queueResultsCollector[queueResultsCollector.length - 1];
    const lastAutoSend = lastResponse ? lastResponse.autoSend : undefined;
    finishQueueExecution(lastAutoSend);
    return;
  }

  const currentTask = activeTaskQueue.shift();
  logToTerminal(`[队列调度] 启动子任务 [${currentTask.action}] ID: ${currentTask.id}`);
  handleInstructionFlow(currentTask);
}

function finishQueueExecution(autoSend) {
  logToTerminal("多流程任务队列执行结束，正在汇总结果并自动回填...");

  let feedbackText = `【GLAB 多流程任务执行结果汇总反馈】\n\n`;

  // 汇总已执行子任务结果
  queueResultsCollector.forEach((res, index) => {
    feedbackText += `### [子任务 ${index + 1}] ID: ${res.id} (${res.status === "success" ? "🟢 成功" : "🔴 失败"})\n`;
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

  // 保存待粘贴的文件列表并重置队列缓存
  const filesToPaste = [...queueFilesToPaste];

  // mark for one-shot auto-verify on the next AI idle turn
  if (isAutoVerifyEnabled) pendingAutoVerify = true;

  isQueueModeActive = false;
  activeTaskQueue = [];
  queueResultsCollector = [];
  queueFilesToPaste = [];

  const shouldAutoSend = autoSend !== false && autoSend !== "false";
  replyToChat(feedbackText, filesToPaste, shouldAutoSend);
}

// ==========================================
// 核心逻辑：指令提取与控制分流
// ==========================================
function scanAndExecuteInstructions() {
  if (isPageGenerating() || isGenerating || isQueueModeActive) return;
  const scanConversationId = getConversationId();
  logToTerminal("开始扫描最新回复中的待执行指令...");

  // 先同步加载当前 URL 对应会话下的已执行 ID 记录
  syncConvExecutedIds(() => {
    if (getConversationId() !== scanConversationId || isPageGenerating() || isGenerating || isQueueModeActive) return;
    const latestReply = getLatestAssistantReply();
    if (!latestReply) return;
    // 兼容 ChatGPT 无 <pre> 包裹的代码块（使用 Set 去重避免重复处理）
    const unprocessedBlocks = Array.from(
      new Set([
        ...latestReply.querySelectorAll("pre code:not([data-glab-processed])"),
        ...latestReply.querySelectorAll("code.language-glab-call:not([data-glab-processed])"),
      ]),
    );
    if (unprocessedBlocks.length === 0) return;

    // 获取页面中所有的 GLAB 代码块，以便建立稳定的序号序列（保证页面刷新后历史任务 ID 映射的稳定性）
    const allCodeBlocks = Array.from(new Set([...document.querySelectorAll("pre code"), ...document.querySelectorAll("code.language-glab-call")]));
    const glabBlocks = allCodeBlocks.filter((codeEl) => {
      const text = codeEl.textContent.trim();
      const isGlabClass = codeEl.classList.contains("language-glab-call");
      const hasInstructionKeywords = text.includes('"action"') && text.includes('"params"');
      return isGlabClass || hasInstructionKeywords;
    });

    let hasInvalidInstruction = false;
    let pendingTasks = [];
    let isTaskArrayParsed = false; // 是否解析到了显式的多任务数组

    unprocessedBlocks.forEach((codeEl) => {
      const text = codeEl.textContent.trim();
      const isGlabClass = codeEl.classList.contains("language-glab-call");
      const hasInstructionKeywords = text.includes('"action"') && text.includes('"params"');

      if (isGlabClass || hasInstructionKeywords) {
        codeEl.setAttribute("data-glab-processed", "true");
        const blockIndex = glabBlocks.indexOf(codeEl);

        try {
          const parsed = JSON.parse(text);
          const tasks = Array.isArray(parsed) ? parsed : [parsed];
          if (!tasks.length || tasks.some(task => !task || typeof task !== "object" ||
              typeof task.id !== "string" || !task.id.trim() || typeof task.action !== "string" ||
              !task.action.trim() || !task.params || typeof task.params !== "object" || Array.isArray(task.params))) {
            throw new Error("指令必须包含有效的 id、action 和 params 对象");
          }
          if (Array.isArray(parsed)) {
            isTaskArrayParsed = true;
            parsed.forEach((task, index) => {
              const originalId = task.id;
              if (originalId) {
                // 重写 ID 附加稳定序号后缀，确保重复内容 ID 的唯一性
                const uniqueId = `${originalId}_seq_${blockIndex}_${index}`;
                task.id = uniqueId;

                // 兼容性校验：检查 uniqueId 或原始 originalId 是否已执行过
                const alreadyExecuted = currentConvExecutedIds.has(uniqueId) || currentConvExecutedIds.has(originalId);
                if (!alreadyExecuted) {
                  pendingTasks.push(task);
                } else {
                  logToTerminal(`提示：多任务子项 [${uniqueId}] 已执行过，自动忽略。`);
                }
              } else {
                logToTerminal("警告：多任务子项未包含有效 ID，安全起见拒绝执行。");
              }
            });
          } else {
            const originalId = parsed.id;
            if (!originalId) {
              logToTerminal("警告：指令未包含有效 ID，安全起见拒绝执行。");
              return;
            }

            // 重写 ID 附加稳定序号后缀，确保重复内容 ID 的唯一性
            const uniqueId = `${originalId}_seq_${blockIndex}`;
            parsed.id = uniqueId;

            // 兼容性校验：检查 uniqueId 或原始 originalId 是否已执行过
            const alreadyExecuted = currentConvExecutedIds.has(uniqueId) || currentConvExecutedIds.has(originalId);
            if (alreadyExecuted) {
              logToTerminal(`提示：指令 ID [${uniqueId}] 在当前对话中已执行过，已自动跳过。`);
              return;
            }
            pendingTasks.push(parsed);
          }
        } catch (e) {
          hasInvalidInstruction = true;
          // 保留重试机会，但不会把错误自动发送给模型，避免重试循环。
          codeEl.removeAttribute("data-glab-processed");
          console.error("[GLAB] 指令 JSON 解析失败:", e);
          logToTerminal(`指令 JSON 解析失败（内容可能未输出完）: ${e.message}`);
        }
      }
    });

    const outputError = document.getElementById("glab-output-error");
    if (hasInvalidInstruction) {
      unprocessedBlocks.forEach(block => block.removeAttribute("data-glab-processed"));
      if (outputError) outputError.style.display = "block";
      document.getElementById("glab-drawer")?.classList.add("open");
      logToTerminal("本次回复含无效指令，未执行本次扫描中的任何指令。可点击“反馈输出中断”请求缩短重试。");
      return;
    }
    if (outputError) outputError.style.display = "none";
    if (pendingTasks.length > 0) {
      // 写入存储强缓存
      pendingTasks.forEach((task) => currentConvExecutedIds.add(task.id));
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
        queueFilesToPaste = [];

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
        updatePanelState("idle", "已就绪");
        logToTerminal("未发现新指令，步骤深度已重置。");
        if (pendingAutoVerify) {
          pendingAutoVerify = false;
          triggerVerifyPrompt();
        }
      }
    }
  });
}

// 向 CLI 发送指令，并在发送分片写入时暂存映射关系
function sendRequestToCLI(request) {
  if (request.action === "write_file_chunk" && request.params) {
    activeChunkWrites.set(request.id, request.params.path);
  }
  socket.send(JSON.stringify(request));
}

function handleInstructionFlow(request) {
  const readOnlyActions = ["prepare_skill", "list_dir", "read_file", "list_skills", "load_skill", "paste_file", "relay_verify", "relay_result"];

  if (autoRunDepth >= 10) {
    updatePanelState("error", "步骤超限锁定");
    logToTerminal("警告：连续步骤已达上限 10 步，强行终止，请手动继续。");
    return;
  }

  // 检查是否是已被用户手动授权的后续分片（chunkIndex > 0 且路径已批准）
  const isApprovedChunk =
    request.action === "write_file_chunk" && request.params && request.params.chunkIndex > 0 && approvedChunkPaths.has(request.params.path);

  if (readOnlyActions.includes(request.action)) {
    if (!isQueueModeActive) {
      autoRunDepth++;
      updateDepthCounter();
    }
    updatePanelState("executing", "CLI 执行中");
    logToTerminal(`自动投递 [只读]: [${request.action}] ID: ${request.id}`);
    sendRequestToCLI(request);
  } else {
    if (isAutoRunEnabled || isApprovedChunk) {
      if (!isQueueModeActive) {
        autoRunDepth++;
        updateDepthCounter();
      }
      updatePanelState("executing", isApprovedChunk ? "CLI 自动执行中 (分片追加)" : "CLI 自动执行中");
      logToTerminal(`自动投递 [写入${isApprovedChunk ? "分片" : ""}]: [${request.action}] ID: ${request.id}`);
      sendRequestToCLI(request);
    } else {
      updatePanelState("pending", "等待授权确认");
      logToTerminal(`指令挂起等待授权: [${request.action}] ID: ${request.id}`);
      showConfirmUI(request);
    }
  }
}

function updateDepthCounter() {
  const counter = document.getElementById("glab-depth-counter");
  if (counter) {
    counter.innerText = `${autoRunDepth} / 10`;
  }
}

function triggerVerifyPrompt() {
  const myRole = detectRole();
  const targetRole = myRole === "gemini" ? "gpt" : "gemini";
  const targetLabel = targetRole === "gpt" ? "ChatGPT" : "Gemini";
  const verifyMsg = `请将你对用户最近一个问题的完整回答发往 ${targetLabel} 进行独立校验。请提取原始问题和你的结论，立刻输出 relay_verify 指令（不要额外解释）。`;
  replyToChat(verifyMsg, [], true);
  logToTerminal(`校验触发提示已发送 → 目标: ${targetRole}`);
}

function showConfirmUI(request) {
  const diffContainer = document.getElementById("glab-diff-container");
  const diffMeta = document.getElementById("glab-diff-meta");
  const diffView = document.getElementById("glab-diff-view");

  if (!diffContainer || !diffMeta || !diffView) return;

  diffMeta.innerText = `指令: ${request.action} (ID: ${request.id})`;
  diffView.textContent = JSON.stringify(request.params, null, 2);
  diffContainer.style.display = "block";

  // 展开抽屉，确保用户能看到
  const drawer = document.getElementById("glab-drawer");
  if (drawer) drawer.classList.add("open");

  document.getElementById("glab-btn-approve").onclick = () => {
    diffContainer.style.display = "none";
    updatePanelState("executing", "授权指令执行中");
    logToTerminal(`用户已批准指令: ${request.id}`);

    // 如果是分片写入的第 0 片被批准，将路径记录到 approvedChunkPaths 中
    if (request.action === "write_file_chunk" && request.params && request.params.chunkIndex === 0) {
      approvedChunkPaths.add(request.params.path);
      logToTerminal(`分片写入被授权，路径已加入缓存: ${request.params.path}`);
    }

    if (!isQueueModeActive) {
      autoRunDepth++;
      updateDepthCounter();
    }
    sendRequestToCLI(request);
  };

  document.getElementById("glab-btn-reject").onclick = () => {
    diffContainer.style.display = "none";
    updatePanelState("idle", "已拒绝");
    logToTerminal(`用户已拒绝指令: ${request.id}`);

    // 如果用户拒绝，且是分片写入，清理对应路径的授权缓存
    if (request.action === "write_file_chunk" && request.params) {
      approvedChunkPaths.delete(request.params.path);
    }

    if (isQueueModeActive) {
      queueResultsCollector.push({
        id: request.id,
        status: "error",
        error: "用户拒绝授权执行该敏感操作",
      });
      finishQueueExecution();
    }
  };
}

// 监听手动发送：点击发送按钮（用 closest 兼容子元素点击）
document.addEventListener("click", (e) => {
  if (
    e.target.closest('button[data-testid="send-button"]') ||
    e.target.closest('button[data-testid*="send"]') ||
    e.target.closest('button[aria-label="发送"]') ||
    e.target.closest('button[aria-label="发送消息"]') ||
    e.target.closest('button[aria-label="Send message"]') ||
    e.target.closest('button[aria-label="Send"]') ||
    e.target.closest('button[aria-label="Send prompt"]') ||
    e.target.closest('button[aria-label="发送 Prompt"]') ||
    e.target.closest('button[aria-label*="发送"]') ||
    e.target.closest('button[aria-label*="Send"]') ||
    e.target.closest("button.send-button") ||
    e.target.closest(".send-button") ||
    e.target.closest('gem-icon-button[class*="send"]')
  ) {
    autoRunDepth = 0;
    updateDepthCounter();
  }
});

// 监听手动发送：回车键（兼容 prompt-textarea, textbox, contenteditable 和 textarea）
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  const target = e.target;
  const isInInputBox =
    target &&
    (target.id === "prompt-textarea" ||
      target.getAttribute("contenteditable") === "true" ||
      target.getAttribute("role") === "textbox" ||
      target.tagName === "TEXTAREA" ||
      !!target.closest("#prompt-textarea") ||
      !!target.closest('[contenteditable="true"]') ||
      !!target.closest('[role="textbox"]'));
  if (isInInputBox) {
    autoRunDepth = 0;
    updateDepthCounter();
  }
});

// ==========================================
// 页面 Observer 与流式检测
// ==========================================
function getLatestAssistantReply() {
  const selector = detectRole() === "gpt"
    ? '[data-message-author-role="assistant"]'
    : 'model-response';
  const replies = document.querySelectorAll(selector);
  return replies.length ? replies[replies.length - 1] : null;
}

function isPageGenerating() {
  const hasStopBtn =
    !!document.querySelector('button[data-testid="stop-button"]') ||
    !!document.querySelector('button[data-testid*="stop"]') ||
    !!document.querySelector('button[aria-label="停止回复"]') ||
    !!document.querySelector('button[aria-label="停止生成"]') ||
    !!document.querySelector('button[aria-label="停止响应"]') ||
    !!document.querySelector('button[aria-label="Stop generating"]') ||
    !!document.querySelector('button[aria-label="Stop streaming"]') ||
    !!document.querySelector('button[aria-label*="Stop"]') ||
    !!document.querySelector('button[aria-label*="停止"]');

  const hasLoading =
    !!document.querySelector(".loading-indicator") ||
    !!document.querySelector(".result-streaming") ||
    !!document.querySelector('[aria-busy="true"]') ||
    !!document.querySelector('[data-state="streaming"]') ||
    !!document.querySelector(".streaming") ||
    !!document.querySelector('[data-is-streaming="true"]');

  return hasStopBtn || hasLoading;
}

const observer = new MutationObserver((mutations) => {
  // 面板日志和输入框回填不属于模型输出，不能影响流式结束计时。
  const relevant = mutations.some(({ target }) => {
    const element = target.nodeType === 1 ? target : target.parentElement;
    return element && !element.closest('#glab-panel-root, #prompt-textarea, [contenteditable="true"], textarea');
  });
  if (!relevant) return;
  if (generateTimer) clearTimeout(generateTimer);

  if (isPageGenerating()) {
    isGenerating = true;
    updatePanelState("parsing", "等待输出完成");
    return;
  }
  if (!isGenerating) return;
  const reply = getLatestAssistantReply();
  const snapshot = reply?.textContent;
  const conversationId = getConversationId();
  generateTimer = setTimeout(() => {
    generateTimer = null;
    if (isPageGenerating() || getConversationId() !== conversationId ||
        getLatestAssistantReply() !== reply || reply?.textContent !== snapshot) return;
    isGenerating = false;
    scanAndExecuteInstructions();
  }, 2000);
});

// ==========================================
// 初始化流程
// ==========================================
setTimeout(() => {
  injectGLABPanel();
}, 1000);
