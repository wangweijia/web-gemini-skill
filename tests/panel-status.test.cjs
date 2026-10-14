const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const elements = new Map();
  const timers = [];
  const intervals = [];
  let observer;
  const ids = [
    'panel-root', 'float-ball', 'queue-track', 'queue-fill', 'depth-counter',
    'diff-container', 'diff-meta', 'diff-view', 'drawer', 'btn-approve', 'btn-reject',
    ...['float', 'activity'].flatMap(prefix => ['label', 'detail', 'icon', 'progress'].map(part => `${prefix}-${part}`)),
  ];
  for (const id of ids) {
    const attributes = new Map();
    const classes = new Set();
    elements.set(`glab-${id}`, {
      textContent: '', innerHTML: '', title: '', hidden: false, style: {},
      writes: 0,
      setAttribute(name, value) { attributes.set(name, value); this.writes++; },
      getAttribute(name) { return attributes.get(name) ?? null; },
      classList: {
        add(value) { classes.add(value); },
        contains(value) { return classes.has(value); },
      },
    });
  }
  const input = {
    tagName: 'TEXTAREA', textContent: '', value: '', isConnected: true,
    focus() {}, dispatchEvent() {}, getAttribute() { return null; },
  };
  const document = {
    addEventListener() {},
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({
    document, console, location: { hostname: 'chatgpt.com' },
    window: { location: { pathname: '/c/abc' } },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    Event: class {},
    MutationObserver: class { constructor(fn) { observer = fn; } },
  });
  vm.runInContext(fs.readFileSync('extension/content.js', 'utf8'), context);
  context.input = input;
  vm.runInContext('findInputElement = () => input; sent = []; socket = { send: payload => sent.push(JSON.parse(payload)) }', context);
  timers.length = 0;
  return {
    context, document, timers, intervals,
    element: id => elements.get(`glab-${id}`),
    run: code => vm.runInContext(code, context),
    mutate: () => observer([{ target: { nodeType: 1, closest() { return null; } } }]),
  };
}

function draggingHarness() {
  const h = harness();
  const root = h.element('panel-root');
  const ball = h.element('float-ball');
  const drawer = h.element('drawer');
  const listeners = new Map();
  const classes = new Set();
  const captures = new Set();
  h.context.window.innerWidth = 1000;
  h.context.window.innerHeight = 800;
  h.context.window.addEventListener = (name, fn) => listeners.set(name, fn);
  h.document.addEventListener = (name, fn) => listeners.set(name, fn);
  root.isConnected = true;
  root.getBoundingClientRect = () => {
    const idle = root.getAttribute('data-state') === 'idle';
    const width = idle ? 44 : 204;
    const height = idle ? 44 : 49;
    const right = 1000 - (parseFloat(root.style.right) || 24);
    const bottom = 800 - (parseFloat(root.style.bottom) || 24);
    return { left: right - width, top: bottom - height, right, bottom, width, height };
  };
  drawer.offsetWidth = 330;
  Object.defineProperty(drawer, 'offsetHeight', {
    get() { return Math.min(520, parseFloat(drawer.style.maxHeight) || 520); },
  });
  drawer.classList = {
    toggle(value) { classes.has(value) ? classes.delete(value) : classes.add(value); },
    contains(value) { return classes.has(value); },
  };
  ball.addEventListener = (name, fn) => listeners.set(name, fn);
  ball.removeAttribute = name => ball.setAttribute(name, null);
  ball.setPointerCapture = id => captures.add(id);
  ball.hasPointerCapture = id => captures.has(id);
  ball.releasePointerCapture = id => captures.delete(id);
  h.context.root = root;
  h.context.ball = ball;
  h.context.drawer = drawer;
  h.run('savedPositions = []; safeSetStorage = data => savedPositions.push(data); bindPanelDragging(root, ball, drawer); updatePanelState("executing", "执行命令")');
  h.fire = (name, props = {}) => listeners.get(name)({
    pointerId: 1, isPrimary: true, button: 0, clientX: 850, clientY: 750,
    detail: 1, preventDefault() {}, ...props,
  });
  return h;
}

test('dragging repositions the widget, saves its position and never opens the drawer', () => {
  const h = draggingHarness();
  h.fire('pointerdown');
  h.fire('pointermove', { clientX: 550, clientY: 250 });
  h.fire('pointerup');
  h.fire('click');
  assert.equal(h.element('panel-root').style.right, '324px');
  assert.equal(h.element('panel-root').style.bottom, '524px');
  assert.equal(h.element('drawer').classList.contains('open'), false);
  assert.equal(h.context.savedPositions.length, 1);
  assert.equal(h.context.savedPositions[0].glabPanelPosition.right, 324);
  assert.equal(h.context.savedPositions[0].glabPanelPosition.bottom, 524);
  h.fire('click');
  assert.equal(h.element('drawer').classList.contains('open'), true);
});

test('ordinary clicks and keyboard activation open the drawer without saving a drag', () => {
  const h = draggingHarness();
  h.fire('pointerdown');
  h.fire('pointermove', { clientX: 852, clientY: 752 });
  h.fire('pointerup');
  h.fire('click');
  assert.equal(h.element('drawer').classList.contains('open'), true);
  assert.equal(h.context.savedPositions.length, 0);
  h.fire('click', { detail: 0 });
  assert.equal(h.element('drawer').classList.contains('open'), false);
});

test('dragging clamps to viewport edges and anchors the drawer below a top-edge widget', () => {
  const h = draggingHarness();
  h.fire('pointerdown');
  h.fire('pointermove', { clientX: -1000, clientY: -1000 });
  h.fire('pointerup');
  const rect = h.element('panel-root').getBoundingClientRect();
  assert.equal(rect.left, 12);
  assert.equal(rect.top, 12);
  assert.equal(h.element('drawer').style.right, '658px');
  assert.equal(h.element('drawer').style.bottom, '211px');
  h.fire('pointerdown');
  h.fire('pointermove', { clientX: 3000, clientY: 3000 });
  h.fire('pointercancel');
  const moved = h.element('panel-root').getBoundingClientRect();
  assert.equal(moved.right, 988);
  assert.equal(moved.bottom, 788);
  assert.equal(h.element('drawer').style.bottom, '69px');
});

test('switching between compact idle and expanded task states stays inside the window', () => {
  const h = draggingHarness();
  h.element('panel-root').style.right = '944px';
  h.run('updatePanelState("idle", "已就绪")');
  assert.equal(h.element('panel-root').getBoundingClientRect().width, 44);
  h.run('updatePanelState("executing", "执行命令")');
  assert.equal(h.element('panel-root').getBoundingClientRect().left, 12);
});

test('task labels and icons describe every supported local operation', () => {
  const h = harness();
  const expected = {
    list_dir: ['浏览目录', 'folder'], read_file: ['读取文件', 'file'],
    write_file: ['写入文件', 'file'], write_file_chunk: ['写入分片', 'file'],
    update_file: ['更新文件', 'file'], run_code: ['运行代码', 'code'],
    run_command: ['执行命令', 'terminal'], paste_file: ['读取附件', 'file'],
    prepare_skill: ['准备 Skill', 'skill'], install_skill: ['安装 Skill', 'skill'],
    list_skills: ['查找 Skills', 'skill'], load_skill: ['加载 Skill', 'skill'],
    run_skill: ['运行 Skill', 'skill'], relay_verify: ['发送跨模型校验', 'relay'],
    relay_result: ['返回校验结果', 'relay'],
  };
  for (const [action, [label, icon]] of Object.entries(expected)) {
    h.run(`handleInstructionFlow({ id: "task", action: ${JSON.stringify(action)}, params: {} }); autoRunDepth = 0`);
    assert.equal(h.element('panel-root').getAttribute('data-state'), 'executing');
    assert.equal(h.element('float-label').textContent, label);
    assert.equal(h.element('activity-label').textContent, label);
    assert.equal(h.element('float-icon').getAttribute('data-icon'), icon);
  }
  assert.equal(h.context.sent.length, Object.keys(expected).length);
});

test('targets render as text in both surfaces and full hover/accessibility labels', () => {
  const h = harness();
  const target = './src/<img onerror=alert(1)>.js';
  h.run(`updateTaskState({ action: "read_file", params: { path: ${JSON.stringify(target)} } })`);
  assert.equal(h.element('float-detail').textContent, target);
  assert.equal(h.element('activity-detail').textContent, target);
  assert.equal(h.element('float-detail').innerHTML, '');
  assert.ok(h.element('float-ball').title.includes(target));
  assert.equal(h.element('float-ball').getAttribute('aria-label'), h.element('float-ball').title);
  h.run('updateTaskState({ action: "run_command", params: { command: "npm run build" } })');
  assert.equal(h.element('float-detail').textContent, 'npm run build');
  h.run('updateTaskState({ action: "run_skill", params: { name: "image-tools" } })');
  assert.equal(h.element('float-detail').textContent, 'image-tools');
  h.run('updateTaskState({ action: "relay_verify", params: { target: "gpt" } })');
  assert.equal(h.element('float-detail').textContent, '目标：ChatGPT');
});

test('unknown actions still reach the service without presentation lookup errors', () => {
  const h = harness();
  for (const action of ['custom_action', 'constructor', '__proto__']) {
    h.run(`handleInstructionFlow({ id: "unknown", action: ${JSON.stringify(action)}, params: {} }); autoRunDepth = 0`);
    assert.equal(h.element('float-label').textContent, action);
    assert.equal(h.element('float-icon').getAttribute('data-icon'), 'code');
  }
  assert.equal(h.context.sent.length, 3);
});

test('queue progress reflects completed tasks and chunk numbering is one-based', () => {
  const h = harness();
  h.run(`
    isQueueModeActive = true;
    queueResultsCollector = [{ status: "success" }];
    activeTaskQueue = [{ id: "last" }];
    updateTaskState({ action: "write_file_chunk", params: { path: "a.txt", chunkIndex: 2, totalChunks: 5 } });
  `);
  assert.equal(h.element('float-progress').textContent, '2 / 3');
  assert.equal(h.element('activity-progress').textContent, '2 / 3');
  assert.equal(h.element('queue-track').hidden, false);
  assert.ok(Math.abs(parseFloat(h.element('queue-fill').style.width) - 100 / 3) < 0.001);
  assert.equal(h.element('activity-detail').textContent, 'a.txt · 分片 3 / 5');
  h.run('isQueueModeActive = false; updateTaskState({ action: "list_dir", params: {} })');
  assert.equal(h.element('float-progress').hidden, true);
  assert.equal(h.element('activity-progress').hidden, true);
  assert.equal(h.element('queue-track').hidden, true);
});

test('authorization keeps task context and switches to execution only after approval', () => {
  const h = harness();
  h.run('isAutoRunEnabled = false; handleInstructionFlow({ id: "write", action: "write_file", params: { path: "a.txt" } })');
  assert.equal(h.element('panel-root').getAttribute('data-state'), 'pending');
  assert.equal(h.element('float-label').textContent, '等待授权 · 写入文件');
  assert.equal(h.element('float-detail').textContent, 'a.txt');
  assert.equal(h.context.sent.length, 0);
  h.element('btn-approve').onclick();
  assert.equal(h.element('panel-root').getAttribute('data-state'), 'executing');
  assert.equal(h.element('float-label').textContent, '写入文件');
  assert.equal(h.context.sent.length, 1);
});

test('manual feedback remains in a non-loading state instead of becoming idle', () => {
  const h = harness();
  h.run('replyToChat("feedback", [], false)');
  assert.equal(h.element('panel-root').getAttribute('data-state'), 'waiting');
  assert.equal(h.element('float-label').textContent, '等待手动发送');
  assert.equal(h.timers.length, 0);
});

test('sending switches to AI waiting while a timeout stops loading', () => {
  const h = harness();
  h.context.sendButton = {
    isConnected: true, disabled: false, hasAttribute() { return false; },
    getAttribute() { return ''; }, closest() { return null; }, click() {},
  };
  h.run('findSendButton = () => sendButton; replyToChat("feedback")');
  assert.equal(h.element('float-label').textContent, '等待发送消息');
  h.timers.pop()();
  h.intervals.pop()();
  assert.equal(h.element('panel-root').getAttribute('data-state'), 'thinking');
  assert.equal(h.element('float-label').textContent, '等待 AI 回复');

  h.run('findSendButton = () => null; replyToChat("feedback")');
  h.timers.pop()();
  const poll = h.intervals.pop();
  for (let i = 0; i < 150; i++) poll();
  assert.equal(h.element('panel-root').getAttribute('data-state'), 'waiting');
  assert.equal(h.element('float-label').textContent, '自动发送超时');
});

test('ordinary assistant output without commands clears the loading state', () => {
  const h = harness();
  h.document.querySelectorAll = () => [{ textContent: 'Done', querySelectorAll() { return []; } }];
  h.run('syncConvExecutedIds = callback => callback(); updatePanelState("thinking", "AI 正在生成回复"); scanAndExecuteInstructions()');
  assert.equal(h.element('panel-root').getAttribute('data-state'), 'idle');
  assert.equal(h.element('float-label').textContent, '已就绪');
});

test('streaming signals do not conceal a local task or pending authorization', () => {
  const h = harness();
  h.document.querySelector = selector => selector === 'button[data-testid="stop-button"]' ? {} : null;
  for (const state of ['executing', 'pending', 'replying', 'error']) {
    h.run(`updatePanelState("${state}", "任务状态")`);
    h.mutate();
    assert.equal(h.element('panel-root').getAttribute('data-state'), state);
  }
});

test('repeated streaming updates do not rewrite icons or labels', () => {
  const h = harness();
  h.run('updatePanelState("thinking", "AI 正在生成回复")');
  const rootWrites = h.element('panel-root').writes;
  const iconWrites = h.element('float-icon').writes;
  const ballWrites = h.element('float-ball').writes;
  h.run('updatePanelState("thinking", "AI 正在生成回复")');
  assert.equal(h.element('panel-root').writes, rootWrites);
  assert.equal(h.element('float-icon').writes, iconWrites);
  assert.equal(h.element('float-ball').writes, ballWrites);
});
