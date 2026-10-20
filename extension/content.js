// ==========================================
// General Local Agent Bridge (GLAB) Content Script
// ==========================================

let socket = null;
let wsPort = 9003;
let isGenerating = false;
let generateTimer = null;
let lastObservedReply = null;
let lastObservedReplyText = "";
let missingReplyLogged = false;
let lastVoiceIdle = null;
let autoRunDepth = 0;
let isAutoRunEnabled = true;
let isAutoVerifyEnabled = false;
let pendingAutoVerify = false; // one-shot flag set after queue completes, triggers verify on next idle AI turn
let currentCLIRootDir = ""; // 暂存由本地 CLI 握手发送过来的根工作目录
let currentCLISkillsDir = "";
let currentCLIHomeDir = "";
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
let panelState = "connecting";

function formatConfigPath(value) {
  const input = value.trim().replace(/^～/, "~");
  if (!currentCLIHomeDir) return input;
  const home = currentCLIHomeDir.replace(/\/+$/, "") || "/";
  if (input === home || input.replace(/\/+$/, "") === home) return "~";
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return input.startsWith(prefix) ? `~/${input.slice(prefix.length)}` : input;
}

function setConfigurationReady(ready) {
  for (const id of ["glab-init-prompt-btn", "glab-verify-btn"]) {
    const button = document.getElementById(id);
    if (button) button.disabled = !ready;
  }
}

const panelIcons = {
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  folder: '<path d="M3 7V5h6l2 2h10v12H3Z"/>',
  file: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
  skill: '<path d="m13 3-9 11h7l-1 7 10-12h-7Z"/>',
  relay: '<path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/>',
  send: '<path d="m3 3 18 9-18 9 4-9Zm4 9h14"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  alert: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v1"/>',
};

const taskPresentation = {
  list_dir: ["浏览目录", "folder"],
  read_file: ["读取文件", "file"],
  write_file: ["写入文件", "file"],
  write_file_chunk: ["写入分片", "file"],
  update_file: ["更新文件", "file"],
  run_code: ["运行代码", "code"],
  run_command: ["执行命令", "terminal"],
  paste_file: ["读取附件", "file"],
  prepare_skill: ["准备 Skill", "skill"],
  install_skill: ["安装 Skill", "skill"],
  list_skills: ["查找 Skills", "skill"],
  load_skill: ["加载 Skill", "skill"],
  run_skill: ["运行 Skill", "skill"],
  relay_verify: ["发送跨模型校验", "relay"],
  relay_result: ["返回校验结果", "relay"],
};

function panelIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${panelIcons[name] || panelIcons.clock}</svg>`;
}

function updateTaskState(request, awaitingApproval = false) {
  const [label, icon] = Object.hasOwn(taskPresentation, request.action)
    ? taskPresentation[request.action] : [request.action, "code"];
  const params = request.params || {};
  let detail = params.path || params.command || params.name || "";
  if (request.action === "write_file_chunk" && Number.isInteger(params.chunkIndex) && Number.isInteger(params.totalChunks)) {
    detail = `${detail} · 分片 ${params.chunkIndex + 1} / ${params.totalChunks}`;
  }
  if (request.action === "relay_verify" || request.action === "relay_result") {
    detail = `目标：${params.target === "gpt" ? "ChatGPT" : params.target === "gemini" ? "Gemini" : params.target || "未指定"}`;
  }
  updatePanelState(awaitingApproval ? "pending" : "executing", awaitingApproval ? `等待授权 · ${label}` : label, {
    icon,
    detail: detail || `指令：${request.action}`,
    progress: isQueueModeActive ? {
      completed: queueResultsCollector.length,
      total: queueResultsCollector.length + activeTaskQueue.length + 1,
    } : null,
  });
}

function positionGLABPanel() {
  const root = document.getElementById("glab-panel-root");
  const drawer = document.getElementById("glab-drawer");
  if (!root?.isConnected || !drawer) return;
  const margin = 12;
  const rect = root.getBoundingClientRect();
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(rect.top, window.innerHeight - rect.height - margin));
  root.style.right = `${window.innerWidth - left - rect.width}px`;
  root.style.bottom = `${window.innerHeight - top - rect.height}px`;

  const above = Math.max(0, top - margin - 8);
  const below = Math.max(0, window.innerHeight - top - rect.height - margin - 8);
  const openAbove = above >= 520 || above >= below;
  drawer.style.maxHeight = `${openAbove ? above : below}px`;
  const drawerLeft = Math.max(margin, Math.min(left + rect.width - drawer.offsetWidth, window.innerWidth - drawer.offsetWidth - margin));
  drawer.style.right = `${window.innerWidth - drawerLeft - drawer.offsetWidth}px`;
  drawer.style.bottom = openAbove
    ? `${window.innerHeight - top + 8}px`
    : `${window.innerHeight - top - rect.height - 8 - drawer.offsetHeight}px`;
}

function bindPanelDragging(root, ball, drawer) {
  let drag = null;
  let suppressClick = false;
  ball.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const rect = root.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.bottom, moved: false };
    suppressClick = false;
    ball.setPointerCapture(event.pointerId);
  });
  document.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    ball.setAttribute("data-dragging", "true");
    root.style.right = `${drag.right - dx}px`;
    root.style.bottom = `${drag.bottom - dy}px`;
    positionGLABPanel();
  });
  const finishDrag = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved;
    if (drag.moved) {
      safeSetStorage({ glabPanelPosition: { right: parseFloat(root.style.right), bottom: parseFloat(root.style.bottom) } });
    }
    drag = null;
    ball.removeAttribute("data-dragging");
    if (ball.hasPointerCapture(event.pointerId)) ball.releasePointerCapture(event.pointerId);
  };
  document.addEventListener("pointerup", finishDrag);
  document.addEventListener("pointercancel", finishDrag);
  ball.addEventListener("lostpointercapture", finishDrag);
  ball.addEventListener("click", (event) => {
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    suppressClick = false;
    drawer.classList.toggle("open");
    positionGLABPanel();
  });
  window.addEventListener("resize", positionGLABPanel);
}

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
  const floatBall = document.createElement("button");
  floatBall.id = "glab-float-ball";
  floatBall.type = "button";
  floatBall.setAttribute("aria-controls", "glab-drawer");
  floatBall.setAttribute("aria-expanded", "false");
  floatBall.innerHTML = `
    <span class="glab-activity-icon" id="glab-float-icon"></span>
    <span class="glab-float-copy">
      <span id="glab-float-label"></span>
      <span id="glab-float-detail"></span>
    </span>
    <span id="glab-float-progress" class="glab-queue-count" hidden></span>
  `;

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
      <div id="glab-activity-card" class="glab-section" role="status" aria-live="polite" aria-atomic="true">
        <div class="glab-activity-heading">
          <span id="glab-activity-icon" class="glab-activity-icon"></span>
          <div class="glab-activity-copy">
            <div class="glab-activity-eyebrow">GLAB · 当前活动</div>
            <div id="glab-activity-label"></div>
          </div>
          <span id="glab-activity-progress" class="glab-queue-count" hidden></span>
        </div>
        <div id="glab-activity-detail"></div>
        <div class="glab-flow" aria-hidden="true">
          <span data-stage="output">AI 输出</span><span class="glab-flow-arrow">›</span>
          <span data-stage="execute">本地执行</span><span class="glab-flow-arrow">›</span>
          <span data-stage="feedback">结果反馈</span>
        </div>
        <div id="glab-queue-track" hidden><div id="glab-queue-fill"></div></div>
      </div>
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
              <input type="text" id="glab-input-workdir" style="flex: 1;" placeholder="例如: ~/project">
              <button id="glab-select-dir-btn" class="glab-btn primary" style="flex: 0 0 64px; padding: 0 8px; height: 28px; line-height: 28px;">📂 选择</button>
            </div>
          </div>
          <div class="input-group">
            <label for="glab-input-skillsdir">Skills 目录 (选填)</label>
            <input type="text" id="glab-input-skillsdir" placeholder="留空使用 CLI 默认目录，例如 ~/.glab-skills">
            <span class="glab-path-hint">~ 表示当前用户主目录，也支持绝对路径。</span>
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
    
    #glab-panel-root { --glab-accent: #94a3b8; }
    #glab-panel-root[data-state="idle"] { --glab-accent: #6ee7b7; }
    #glab-panel-root[data-state="thinking"],
    #glab-panel-root[data-state="parsing"],
    #glab-panel-root[data-state="connecting"] { --glab-accent: #93c5fd; }
    #glab-panel-root[data-state="executing"] { --glab-accent: #c4b5fd; }
    #glab-panel-root[data-state="pending"],
    #glab-panel-root[data-state="waiting"] { --glab-accent: #fcd34d; }
    #glab-panel-root[data-state="replying"] { --glab-accent: #6ee7b7; }
    #glab-panel-root[data-state="error"] { --glab-accent: #fca5a5; }
    #glab-panel-root [hidden] { display: none !important; }

    /* 可读的悬浮状态胶囊 */
    #glab-float-ball {
      box-sizing: border-box;
      width: 204px;
      max-width: calc(100vw - 24px);
      min-height: 48px;
      padding: 7px 10px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      background: rgba(22, 26, 34, 0.94);
      color: #f1f5f9;
      font: inherit;
      text-align: left;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: grab;
      touch-action: none;
      user-select: none;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
      transition: background 0.2s, border-color 0.2s;
      position: relative;
    }
    #glab-float-ball:hover {
      background: rgba(30, 35, 45, 0.98);
      border-color: var(--glab-accent);
    }
    #glab-float-ball:focus-visible {
      outline: 2px solid var(--glab-accent);
      outline-offset: 4px;
    }
    #glab-float-ball[data-dragging="true"] { cursor: grabbing; }
    #glab-panel-root[data-state="idle"] #glab-float-ball {
      width: 44px;
      min-height: 44px;
      padding: 7px;
      border-radius: 50%;
    }
    #glab-panel-root[data-state="idle"] .glab-float-copy,
    #glab-panel-root[data-state="idle"] #glab-float-progress { display: none; }
    #glab-panel-root .glab-activity-icon {
      width: 36px;
      height: 36px;
      flex: 0 0 36px;
      display: grid;
      place-items: center;
      position: relative;
      color: var(--glab-accent);
      background: rgba(255, 255, 255, 0.04);
      border-radius: 50%;
    }
    #glab-panel-root .glab-activity-icon svg { width: 19px; height: 19px; }
    #glab-panel-root #glab-float-icon { width: 28px; height: 28px; flex-basis: 28px; }
    #glab-panel-root #glab-float-icon svg { width: 16px; height: 16px; }
    #glab-panel-root .glab-activity-icon::after {
      content: "";
      position: absolute;
      inset: -1px;
      border: 1.5px solid rgba(255, 255, 255, 0.09);
      border-radius: 50%;
    }
    #glab-panel-root[data-state="connecting"] .glab-activity-icon::after,
    #glab-panel-root[data-state="thinking"] .glab-activity-icon::after,
    #glab-panel-root[data-state="parsing"] .glab-activity-icon::after,
    #glab-panel-root[data-state="executing"] .glab-activity-icon::after,
    #glab-panel-root[data-state="replying"] .glab-activity-icon::after {
      border-top-color: var(--glab-accent);
      animation: glab-orbit 1.2s linear infinite;
    }
    #glab-panel-root .glab-float-copy,
    #glab-panel-root .glab-activity-copy { flex: 1; min-width: 0; }
    #glab-float-label { display: block; font-size: 12px; font-weight: 600; line-height: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #glab-float-detail {
      display: block;
      color: #a5afbf;
      font-size: 10px;
      line-height: 16px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #glab-panel-root .glab-queue-count {
      flex-shrink: 0;
      font: 11px ui-monospace, monospace;
      color: var(--glab-accent);
      background: rgba(255, 255, 255, 0.06);
      padding: 4px 6px;
      border-radius: 6px;
    }
    #glab-panel-root .glab-activity-heading { display: flex; align-items: center; gap: 10px; }
    #glab-panel-root .glab-activity-eyebrow { color: #94a3b8; font-size: 10px; margin-bottom: 3px; }
    #glab-activity-label { color: #f1f5f9; font-size: 13px; font-weight: 600; }
    #glab-activity-detail {
      margin-top: 10px;
      color: #a5afbf;
      font-size: 12px;
      line-height: 1.6;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      max-height: 80px;
      overflow-y: auto;
    }
    #glab-panel-root .glab-flow { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: #8894a7; font-size: 10px; }
    #glab-panel-root .glab-flow [data-stage] { padding: 4px 6px; border-radius: 5px; }
    #glab-panel-root[data-state="thinking"] [data-stage="output"],
    #glab-panel-root[data-state="parsing"] [data-stage="output"],
    #glab-panel-root[data-state="executing"] [data-stage="execute"],
    #glab-panel-root[data-state="pending"] [data-stage="execute"],
    #glab-panel-root[data-state="replying"] [data-stage="feedback"],
    #glab-panel-root[data-state="waiting"] [data-stage="feedback"] {
      color: var(--glab-accent);
      background: rgba(255, 255, 255, 0.06);
    }
    #glab-queue-track { height: 3px; background: rgba(255, 255, 255, 0.08); border-radius: 3px; margin-top: 12px; overflow: hidden; }
    #glab-queue-fill { height: 100%; background: var(--glab-accent); transition: width 0.3s ease; }

    /* 抽屉面板样式 */
    #glab-drawer {
      position: fixed;
      box-sizing: border-box;
      right: 24px;
      bottom: 96px;
      width: 330px;
      max-width: calc(100vw - 24px);
      height: 520px;
      max-height: calc(100dvh - 24px);
      background: rgba(22, 22, 22, 0.75);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(6px);
      transition: opacity 0.18s, transform 0.18s, visibility 0.18s;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      color: #e5e7eb;
    }
    #glab-drawer.open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translateY(0);
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
    #glab-panel-root .glab-path-hint { font-size: 10px; color: #9ca3af; line-height: 1.5; }
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
    @keyframes glab-orbit {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      #glab-panel-root *, #glab-panel-root *::after { animation: none !important; transition: none !important; }
    }
  `;
  document.head.appendChild(style);
  updatePanelState("connecting", "正在连接本地服务");

  // 初始化填入本地存储路径与配置
  safeGetStorage(["workDir", "skillsDir", "wsPort", "glabPanelPosition"], (res) => {
    const position = res.glabPanelPosition;
    if (position && Number.isFinite(position.right) && Number.isFinite(position.bottom)) {
      root.style.right = `${position.right}px`;
      root.style.bottom = `${position.bottom}px`;
      positionGLABPanel();
    }
    if (res.workDir) {
      document.getElementById("glab-input-workdir").value = formatConfigPath(res.workDir);
    }
    if (res.skillsDir) {
      document.getElementById("glab-input-skillsdir").value = formatConfigPath(res.skillsDir);
    }
    wsPort = res.wsPort || 9003;
    document.getElementById("glab-input-wsport").value = wsPort;

    // 从本地存储读取真实配置端口后，再发起首次 WebSocket 连接
    connectSocket();
  });

  // ==========================================
  // 事件绑定
  // ==========================================
  bindPanelDragging(root, floatBall, drawer);
  const drawerObserver = new MutationObserver(() => {
    floatBall.setAttribute("aria-expanded", String(drawer.classList.contains("open")));
    positionGLABPanel();
  });
  drawerObserver.observe(drawer, { attributes: true, attributeFilter: ["class"] });

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
    updatePanelState("waiting", "等待选择工作目录", { detail: "请在系统文件夹选择器中选择目录", icon: "folder" });
    const selectId = `select_dir_${Date.now()}`;
    socket.send(
      JSON.stringify({
        id: selectId,
        action: "select_directory",
      }),
    );
  });

  document.getElementById("glab-save-config-btn").addEventListener("click", () => {
    const workDir = formatConfigPath(document.getElementById("glab-input-workdir").value);
    const skillsDir = formatConfigPath(document.getElementById("glab-input-skillsdir").value);
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
    document.getElementById("glab-input-workdir").value = workDir;
    document.getElementById("glab-input-skillsdir").value = skillsDir;
    setConfigurationReady(false);

    safeSetStorage({ workDir, skillsDir, wsPort }, () => {
      logToTerminal(`配置已保存！工作目录: ${workDir}, 端口: ${wsPort}`);
      if (socket) socket.close();
      connectSocket();
    });
  });

  document.getElementById("glab-init-prompt-btn").addEventListener("click", () => {
    if (!currentCLIRootDir || !socket || socket.readyState !== WebSocket.OPEN) {
      logToTerminal("请先连接本地服务，并保存配置完成工作目录校验。");
      updatePanelState("error", "工作目录尚未就绪", { detail: "连接 CLI 并保存配置后，再初始化对话规则" });
      return;
    }
    const prompt = generateInitPrompt(currentCLIRootDir, currentCLISkillsDir);
    replyToChat(prompt);
    drawer.classList.remove("open");
  });
}

function updatePanelState(stateClass, label, { detail, icon, progress = null } = {}) {
  const defaults = {
    connecting: ["连接本地代理，请稍候", "relay"],
    idle: ["等待 AI 的下一条指令", "check"],
    thinking: ["AI 正在生成回复，完成后解析指令", "clock"],
    parsing: ["检查最新回复中的 glab-call 指令", "code"],
    executing: ["本地代理正在处理任务", "terminal"],
    pending: ["请在面板中批准或拒绝此操作", "pause"],
    replying: ["将消息回填到当前对话", "send"],
    waiting: ["内容已回填，请检查后手动发送", "pause"],
    error: ["打开面板查看详情和运行日志", "alert"],
  };
  const [defaultDetail, defaultIcon] = defaults[stateClass] || defaults.idle;
  const description = detail ?? defaultDetail;
  const queueLabel = progress ? `${progress.completed + 1} / ${progress.total}` : "";
  panelState = stateClass;
  const root = document.getElementById("glab-panel-root");
  if (root && root.getAttribute("data-state") !== stateClass) root.setAttribute("data-state", stateClass);
  const ball = document.getElementById("glab-float-ball");
  if (ball) {
    const accessibleLabel = `GLAB · ${label}${queueLabel ? ` · 任务 ${queueLabel}` : ""} · ${description}`;
    if (ball.title !== accessibleLabel) {
      ball.title = accessibleLabel;
      ball.setAttribute("aria-label", accessibleLabel);
    }
  }
  for (const prefix of ["float", "activity"]) {
    const labelEl = document.getElementById(`glab-${prefix}-label`);
    const detailEl = document.getElementById(`glab-${prefix}-detail`);
    const iconEl = document.getElementById(`glab-${prefix}-icon`);
    const progressEl = document.getElementById(`glab-${prefix}-progress`);
    if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
    if (detailEl && detailEl.textContent !== description) detailEl.textContent = description;
    if (iconEl && iconEl.getAttribute("data-icon") !== (icon || defaultIcon)) {
      iconEl.innerHTML = panelIcon(icon || defaultIcon);
      iconEl.setAttribute("data-icon", icon || defaultIcon);
    }
    if (progressEl) {
      progressEl.hidden = !progress;
      if (progressEl.textContent !== queueLabel) progressEl.textContent = queueLabel;
    }
  }
  const track = document.getElementById("glab-queue-track");
  const fill = document.getElementById("glab-queue-fill");
  if (track) track.hidden = !progress;
  if (fill) fill.style.width = progress ? `${progress.completed / progress.total * 100}%` : "0%";
  positionGLABPanel();
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

  currentCLIRootDir = "";
  currentCLISkillsDir = "";
  currentCLIHomeDir = "";
  setConfigurationReady(false);
  observer.disconnect();
  if (generateTimer) clearTimeout(generateTimer);
  generateTimer = null;
  isGenerating = false;
  const url = `ws://127.0.0.1:${wsPort}`;
  updatePanelState("connecting", "正在连接本地服务", { detail: `127.0.0.1:${wsPort}` });
  const connection = new WebSocket(url);
  socket = connection;
  let requestedHomePaths = false;

  connection.onopen = () => {
    if (socket !== connection) return;
    const statusVal = document.getElementById("glab-cli-status");
    if (statusVal) {
      statusVal.innerText = "已连接";
      statusVal.className = "status-val online";
    }
    updatePanelState("connecting", "正在校验工作目录");
    logToTerminal("连接本地代理服务成功。");

    // 握手校验
    safeGetStorage(["workDir", "skillsDir"], (res) => {
      if (socket !== connection || connection.readyState !== WebSocket.OPEN) return;
      const workDir = formatConfigPath(res.workDir || "");
      const skillsDir = formatConfigPath(res.skillsDir || "");
      requestedHomePaths = workDir.startsWith("~") || skillsDir.startsWith("~");
      connection.send(
        JSON.stringify({
          action: "shakehand",
          params: {
            workDir,
            skillsDir,
            role: detectRole(),
          },
        }),
      );
    });
  };

  connection.onmessage = (event) => {
    if (socket !== connection) return;
    try {
      const response = JSON.parse(event.data);

      // 处理系统选择目录回调
      if (response.id && response.id.startsWith("select_dir_")) {
        if (response.status === "success" && response.data.selectedPath) {
          const pathInput = document.getElementById("glab-input-workdir");
          if (pathInput) {
            pathInput.value = formatConfigPath(response.data.selectedPath);
            pathInput.title = response.data.selectedPath;
            logToTerminal(`已选择工作根目录: ${response.data.selectedPath}`);
            updatePanelState("idle", "工作目录已选择", { detail: "点击「保存配置」完成连接配置", icon: "folder" });
          }
        } else {
          logToTerminal(`选择目录失败或已取消。`);
          updatePanelState(response.status === "error" ? "error" : "idle", "目录选择未完成", {
            detail: response.error || "未选择目录，可重新点击「选择」",
            icon: "folder",
          });
        }
        return;
      }

      if (response.action === "shakehand_reply") {
        currentCLIRootDir = "";
        currentCLISkillsDir = "";
        setConfigurationReady(false);
        observer.disconnect();
        if (response.status === "success") {
          if (requestedHomePaths && !response.data.homeDir) {
            logToTerminal("当前 CLI 不支持 ~ 路径，请更新并重启本地服务后重新连接。");
            updatePanelState("error", "本地服务需要更新", { detail: "当前 CLI 不支持 ~ 路径，请更新并重启服务" });
            return;
          }
          currentCLIHomeDir = response.data.homeDir || "";
          currentCLIRootDir = response.data.workDir || "";
          currentCLISkillsDir = response.data.skillsDir || "";
          const config = {
            workDir: formatConfigPath(currentCLIRootDir),
            skillsDir: formatConfigPath(currentCLISkillsDir),
          };
          for (const [key, id, resolved] of [
            ["workDir", "glab-input-workdir", currentCLIRootDir],
            ["skillsDir", "glab-input-skillsdir", currentCLISkillsDir],
          ]) {
            const input = document.getElementById(id);
            if (input) {
              input.value = config[key];
              input.title = resolved;
            }
          }
          safeSetStorage(config);

          if (currentCLIRootDir) {
            updatePanelState("idle", "已就绪");
            setConfigurationReady(true);
            logToTerminal(`双端安全握手成功。工作根目录已锁定: ${currentCLIRootDir}`);

            // 【核心安全保护】只有握手锁定成功后，才挂载 Observer 开始监听页面消息
            lastObservedReply = getLatestAssistantReply();
            lastObservedReplyText = lastObservedReply?.textContent || "";
            lastVoiceIdle = isChatGPTVoiceIdle();
            observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-state", "data-is-streaming", "aria-busy", "data-testid", "aria-label", "class"] });
            logToTerminal("网页消息监听（Observer）已成功激活工作。");
            if (detectRole() === "gpt") logToTerminal(`GPT 输入区“开始语音”按钮：${lastVoiceIdle ? "可见" : "未出现"}。`);
          } else {
            updatePanelState("waiting", "等待配置工作目录", { detail: "打开面板，选择工作目录并保存", icon: "folder" });
            document.getElementById("glab-init-prompt-btn").disabled = true;
            logToTerminal("连接已建立，但本地工作目录尚未设置。请在面板中配置并保存或点击“选择”按钮。");
          }
        } else {
          logToTerminal(`双端安全握手失败：${response.error}`);
          updatePanelState("error", "工作目录校验失败", { detail: response.error });
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

  connection.onclose = () => {
    if (socket !== connection) return;
    const statusVal = document.getElementById("glab-cli-status");
    if (statusVal) {
      statusVal.innerText = "未连接";
      statusVal.className = "status-val offline";
    }
    setConfigurationReady(false);
    updatePanelState("error", "本地服务已断开", { detail: "5 秒后自动重连，请确认本地服务已启动" });
    logToTerminal("与本地代理连接断开，5秒后自动重连...");

    // 【核心安全保护】连接断开或未配置时，立刻注销监听器，停止执行任何动作
    observer.disconnect();
    if (generateTimer) clearTimeout(generateTimer);
    generateTimer = null;
    isGenerating = false;
    currentCLIRootDir = "";
    currentCLISkillsDir = "";

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
    updatePanelState("idle", "旧对话回填已取消", { detail: "当前对话已切换" });
    return;
  }
  if (isPageGenerating() || isGenerating) {
    if (Date.now() >= deadline) {
      logToTerminal("等待生成结束超时，已取消回填。");
      updatePanelState("error", "等待 AI 输出超时", { detail: "本次结果未回填，请查看运行日志" });
      return;
    }
    updatePanelState("thinking", "等待 AI 输出后回填", { detail: "执行结果已收到，等待输入框可用" });
    setTimeout(() => replyToChat(text, filesToPaste, autoSend, conversationId, deadline), 500);
    return;
  }
  const inputEl = findInputElement();
  if (!inputEl) {
    logToTerminal("错误：未找到当前聊天页面的输入框，无法回填！");
    updatePanelState("error", "未找到输入框");
    return;
  }

  updatePanelState("replying", filesToPaste.length ? "回填消息与附件" : "正在回填对话", {
    detail: filesToPaste.length ? `${filesToPaste.length} 个附件 · ${autoSend ? "完成后自动发送" : "完成后等待手动发送"}` : autoSend ? "完成后自动发送给 AI" : "完成后等待手动发送",
  });
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
      updatePanelState("error", "回填已取消", { detail: "输入框未获得焦点，请检查当前页面" });
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
    updatePanelState("replying", "等待发送消息", { detail: "内容已回填，等待页面发送按钮就绪" });
    const sendDelay = filesToPaste && filesToPaste.length > 0 ? 1000 : 500;
    setTimeout(() => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (getConversationId() !== conversationId || !inputEl.isConnected) {
          clearInterval(interval);
          logToTerminal("页面或输入框已切换，自动发送已取消。");
          updatePanelState("error", "自动发送已取消", { detail: "页面或输入框已切换，请检查结果是否需要手动发送" });
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
          updatePanelState("thinking", "等待 AI 回复", { detail: "消息已发送，等待 AI 继续处理" });
          autoRunDepth = 0;
          updateDepthCounter();
        } else if (attempts >= 150) {
          clearInterval(interval);
          logToTerminal("30 秒内未满足安全发送条件，请手动发送。");
          updatePanelState("waiting", "自动发送超时", { detail: "结果已回填，30 秒内发送按钮未就绪，请手动发送" });
        }
      }, 200);
    }, sendDelay);
  } else {
    updatePanelState("waiting", "等待手动发送");
    logToTerminal("回填完毕，根据指令 autoSend: false 挂起，等待用户手动确认发送...");
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
  updatePanelState("parsing", "正在解析指令");
  const scanConversationId = getConversationId();
  logToTerminal("开始扫描最新回复中的待执行指令...");

  // 先同步加载当前 URL 对应会话下的已执行 ID 记录
  syncConvExecutedIds(() => {
    if (getConversationId() !== scanConversationId || isPageGenerating() || isGenerating || isQueueModeActive) return;
    const latestReply = getLatestAssistantReply();
    if (!latestReply) {
      updatePanelState("idle", "等待 AI 回复");
      logToTerminal(`未找到当前页面的 AI 回复容器（轮次: ${document.querySelectorAll('[data-testid^="conversation-turn-"]').length}，代码块: ${document.querySelectorAll('[data-markdown-copy="code-block"]').length}），无法扫描指令。`);
      return;
    }
    // ChatGPT 的新版代码块使用 data-markdown-copy 容器，code 不再带语言 class 或 pre 父元素。
    const codeBlockSelector = 'pre code, code.language-glab-call, [data-markdown-copy="code-block"] code';
    const unprocessedBlocks = Array.from(latestReply.querySelectorAll(
      'pre code:not([data-glab-processed]), code.language-glab-call:not([data-glab-processed]), [data-markdown-copy="code-block"] code:not([data-glab-processed])',
    ));
    // ChatGPT 有时把指令作为普通文本输出。仅接受整条回复就是 JSON 的情形，
    // 避免从解释文字或引用示例中误执行命令。
    const replyContent = latestReply.querySelector?.(".markdown, .prose, [data-message-content]") || latestReply;
    const plainText = replyContent.textContent?.trim() || "";
    if (!unprocessedBlocks.length && !latestReply.querySelectorAll(codeBlockSelector).length &&
        !replyContent.hasAttribute?.("data-glab-processed") &&
        (plainText.startsWith("{") || plainText.startsWith("[")) &&
        plainText.includes('"action"') && plainText.includes('"params"')) {
      unprocessedBlocks.push(replyContent);
    }
    if (unprocessedBlocks.length === 0) {
      updatePanelState("idle", "已就绪");
      logToTerminal("最新 AI 回复中未发现可扫描的新指令代码块。");
      return;
    }

    // 获取页面中所有的 GLAB 代码块，以便建立稳定的序号序列（保证页面刷新后历史任务 ID 映射的稳定性）
    const allCodeBlocks = Array.from(document.querySelectorAll(codeBlockSelector));
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
        const blockIndex = codeEl === replyContent
          ? `plain_${Array.from(document.querySelectorAll(detectRole() === "gpt" ? '[data-message-author-role="assistant"]' : 'model-response')).indexOf(latestReply)}`
          : glabBlocks.indexOf(codeEl);

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
      updatePanelState("error", "指令格式不完整", { detail: "本次扫描未执行，请在面板中点击「反馈输出中断」" });
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
    updateTaskState(request);
    logToTerminal(`自动投递 [只读]: [${request.action}] ID: ${request.id}`);
    sendRequestToCLI(request);
  } else {
    if (isAutoRunEnabled || isApprovedChunk) {
      if (!isQueueModeActive) {
        autoRunDepth++;
        updateDepthCounter();
      }
      updateTaskState(request);
      logToTerminal(`自动投递 [写入${isApprovedChunk ? "分片" : ""}]: [${request.action}] ID: ${request.id}`);
      sendRequestToCLI(request);
    } else {
      updateTaskState(request, true);
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
    updateTaskState(request);
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
  if (detectRole() === "gpt") {
    // 先看最后一个对话轮次，避免在用户刚发送消息时回退到上一条 AI 回复。
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"], main article'))
      .filter((element) => element.getAttribute?.("data-testid")?.startsWith("conversation-turn-") ||
        element.matches?.("main article"));
    if (turns.length) {
      const latestTurn = turns[turns.length - 1];
      const userSelector = '[data-message-author-role="user"], [data-testid="user-message"]';
      if (latestTurn.matches?.(userSelector) || latestTurn.querySelector?.(userSelector)) return null;
      const assistantSelector = '[data-message-author-role="assistant"], [data-testid="assistant-message"]';
      if (latestTurn.matches?.(assistantSelector)) return latestTurn;
      const markedAssistant = latestTurn.querySelector?.(assistantSelector);
      if (markedAssistant) return markedAssistant;
      if (latestTurn.querySelector?.('.markdown, .prose, [data-markdown-copy="code-block"]')) return latestTurn;
      return null;
    }
  }
  const selector = detectRole() === "gpt"
    ? '[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"], [data-testid="assistant-message"]'
    : 'model-response';
  const replies = document.querySelectorAll(selector);
  return replies.length ? replies[replies.length - 1] : null;
}

function isChatGPTVoiceIdle() {
  if (detectRole() !== "gpt") return false;
  const selectors = ['button[aria-label="开始语音"]', 'button[aria-label="Start voice"]',
    'button[aria-label="Start voice mode"]'];
  return selectors.some((selector) => {
    const button = document.querySelector(selector);
    return button && !button.disabled && button.getAttribute?.("aria-hidden") !== "true" &&
      (button.getClientRects?.().length ?? 1) > 0;
  });
}

function noteVoiceIdleState() {
  if (detectRole() !== "gpt") return false;
  const visible = isChatGPTVoiceIdle();
  if (visible === lastVoiceIdle) return false;
  lastVoiceIdle = visible;
  logToTerminal(`GPT 输入区“开始语音”按钮${visible ? "已出现" : "已消失"}。`);
  return true;
}

function getGeneratingSignal() {
  const stopSelectors = [
    'button[data-testid="stop-button"]',
    'button[aria-label="停止"]',
    'button[aria-label="停止回复"]',
    'button[aria-label="停止生成"]',
    'button[aria-label="停止响应"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop"]',
  ];
  for (const selector of stopSelectors) {
    const button = document.querySelector(selector);
    if (button && !button.disabled && button.getAttribute?.("aria-hidden") !== "true" &&
        (button.getClientRects?.().length ?? 1) > 0) return selector;
  }

  // ChatGPT 恢复“开始语音”按钮时，回复区遗留的 busy 标记不能继续阻止扫描。
  if (isChatGPTVoiceIdle()) return "";

  // 通用 busy/streaming 标记可能常驻在侧栏或输入区，只检查当前 AI 回复。
  const reply = getLatestAssistantReply();
  if (!reply) return "";
  const loadingSelectors = [".loading-indicator", ".result-streaming", '[aria-busy="true"]',
    '[data-state="streaming"]', ".streaming", '[data-is-streaming="true"]'];
  for (const selector of loadingSelectors) {
    if (reply.matches?.(selector) || reply.querySelector?.(selector)) return selector;
  }
  return "";
}

function isPageGenerating() {
  return !!getGeneratingSignal();
}

function scheduleReplyScan(reply, snapshot, conversationId, waitForCompletion = false) {
  if (generateTimer) clearTimeout(generateTimer);
  generateTimer = setTimeout(() => {
    generateTimer = null;
    if (getConversationId() !== conversationId) return;
    noteVoiceIdleState();
    const currentReply = getLatestAssistantReply();
    if (isPageGenerating()) {
      isGenerating = true;
      scheduleReplyScan(currentReply, currentReply?.textContent, conversationId, true);
      return;
    }
    if (waitForCompletion) {
      if (currentReply === lastObservedReply && currentReply?.textContent === lastObservedReplyText) {
        isGenerating = false;
        if (panelState === "thinking" || panelState === "parsing") updatePanelState("idle", "已就绪");
        logToTerminal("页面输出已结束，但未发现新的 AI 回复；不会扫描旧回复。");
        return;
      }
      lastObservedReply = currentReply;
      lastObservedReplyText = currentReply?.textContent || "";
      scheduleReplyScan(currentReply, currentReply?.textContent, conversationId);
      return;
    }
    if (!currentReply) {
      isGenerating = false;
      if (panelState === "thinking" || panelState === "parsing") updatePanelState("idle", "等待 AI 回复");
      logToTerminal(`页面输出已结束，但未找到 AI 回复容器（轮次: ${document.querySelectorAll('[data-testid^="conversation-turn-"]').length}，代码块: ${document.querySelectorAll('[data-markdown-copy="code-block"]').length}）。`);
      return;
    }
    if (currentReply !== reply || currentReply.textContent !== snapshot) {
      lastObservedReply = currentReply;
      lastObservedReplyText = currentReply.textContent;
      scheduleReplyScan(currentReply, currentReply.textContent, conversationId);
      return;
    }
    isGenerating = false;
    scanAndExecuteInstructions();
  }, 2000);
}

const observer = new MutationObserver((mutations) => {
  // 面板日志和输入框回填不属于模型输出，不能影响流式结束计时。
  const voiceChanged = noteVoiceIdleState();
  const relevant = voiceChanged || mutations.some(({ target }) => {
    const element = target.nodeType === 1 ? target : target.parentElement;
    return element && !element.closest('#glab-panel-root, #prompt-textarea, [contenteditable="true"], textarea');
  });
  if (!relevant) return;

  const generatingSignal = getGeneratingSignal();
  if (generatingSignal) {
    if (!isGenerating) logToTerminal(`检测到 AI 正在生成回复（标记: ${generatingSignal}），等待输出完成。`);
    isGenerating = true;
    if (!["executing", "pending", "replying", "error"].includes(panelState)) {
      updatePanelState("thinking", "AI 正在生成回复");
    }
    const reply = getLatestAssistantReply();
    scheduleReplyScan(reply, reply?.textContent, getConversationId(), true);
    return;
  }
  const reply = getLatestAssistantReply();
  if (!reply) {
    if (!missingReplyLogged) logToTerminal("页面发生变化，但未找到 AI 回复容器。");
    missingReplyLogged = true;
    return;
  }
  missingReplyLogged = false;
  const snapshot = reply?.textContent;
  if (!isGenerating && reply === lastObservedReply && snapshot === lastObservedReplyText) return;
  if (reply !== lastObservedReply) logToTerminal("检测到新的 AI 回复，等待内容稳定。");
  lastObservedReply = reply;
  lastObservedReplyText = snapshot;
  scheduleReplyScan(reply, snapshot, getConversationId());
});

// ==========================================
// 初始化流程
// ==========================================
setTimeout(() => {
  injectGLABPanel();
}, 1000);
