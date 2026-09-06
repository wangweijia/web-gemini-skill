const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const timers = [];
  const intervals = [];
  let observer;
  const document = {
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
  };
  const context = vm.createContext({
    document, console,
    location: { hostname: 'chatgpt.com' },
    window: { location: { pathname: '/c/abc' } },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    Event: class {},
    MutationObserver: class { constructor(fn) { observer = fn; } },
  });
  vm.runInContext(fs.readFileSync('extension/content.js', 'utf8'), context);
  timers.length = 0;
  return { context, document, timers, intervals, mutate: () => observer([{ target: { nodeType: 1, closest() { return null; } } }]) };
}

test('completion timer rechecks generation before scanning', () => {
  const h = harness();
  vm.runInContext('isGenerating = true; scanCount = 0; scanAndExecuteInstructions = () => scanCount++', h.context);
  h.mutate();
  h.document.querySelector = () => ({}); // generation resumes before timer fires
  h.timers.pop()();
  assert.equal(h.context.scanCount, 0);
});

test('completion requires stable reply text', () => {
  const h = harness();
  const reply = { textContent: 'partial' };
  h.document.querySelectorAll = () => [reply];
  vm.runInContext('isGenerating = true; scanCount = 0; scanAndExecuteInstructions = () => scanCount++', h.context);
  h.mutate();
  reply.textContent = 'complete';
  h.timers.pop()();
  assert.equal(h.context.scanCount, 0);
  h.mutate();
  h.timers.pop()();
  assert.equal(h.context.scanCount, 1);
});

test('incoming feedback waits without touching the editor while generating', () => {
  const h = harness();
  h.document.querySelector = () => ({});
  vm.runInContext('replyToChat("feedback")', h.context);
  assert.equal(h.timers.length, 1);
});

test('scan queries only latest assistant reply for pending commands', () => {
  const h = harness();
  const calls = [];
  const oldReply = { querySelectorAll() { throw Error('historical reply scanned'); } };
  const latestReply = { querySelectorAll(selector) { calls.push(selector); return []; } };
  h.document.querySelectorAll = (selector) => {
    assert.equal(selector, '[data-message-author-role="assistant"]');
    return [oldReply, latestReply];
  };
  vm.runInContext('syncConvExecutedIds = (callback) => callback(); scanAndExecuteInstructions()', h.context);
  assert.equal(calls.length, 2);
});

test('switching conversations cancels delayed feedback', () => {
  const h = harness();
  h.document.querySelector = () => ({});
  vm.runInContext('replyToChat("feedback")', h.context);
  h.context.window.location.pathname = '/c/def';
  h.timers.pop()();
  assert.equal(h.timers.length, 0);
});

 test('send polling rejects stop buttons and uses the replacement send button', () => {
  const h = harness();
  const input = { tagName: 'TEXTAREA', isConnected: true, focus() {}, dispatchEvent() {} };
  let clicks = 0;
  let label = 'Stop generating';
  let button = {
    isConnected: true, disabled: false,
    getAttribute(name) { return name === 'aria-label' ? label : null; },
    hasAttribute() { return false; }, closest() { return null; },
    click() { throw Error('stale or stop button clicked'); },
  };
  h.context.findInputElement = () => input;
  h.context.findSendButton = () => button;
  vm.runInContext('replyToChat("feedback")', h.context);
  h.timers.pop()();
  h.intervals[0]();
  label = 'Send message';
  button = { ...button, click() { clicks++; } };
  h.intervals[0]();
  assert.equal(clicks, 1);
});

test('initialization allows multiple calls and limits content and batch length', () => {
  const h = harness();
  const prompt = vm.runInContext('generateInitPrompt("/project", "")', h.context);
  assert.match(prompt, /允许单条 JSON 对象、JSON 数组或多个 glab-call 代码块/);
  assert.match(prompt, /约 6000 字符/);
  assert.match(prompt, /收到成功反馈 → 才生成下一块/);
  assert.match(prompt, /禁止在同一回答中输出该长命令的多个分块/);
  assert.match(prompt, /transferId/);
  assert.match(prompt, /2000 字符或 40 行/);
  assert.doesNotMatch(prompt, /单轮单指令|每轮只发一片|禁止指令数组|>4KB|>80 行/);
});

test('malformed command prevents execution of valid sibling commands and offers feedback', () => {
  const h = harness();
  const blocks = ['{"id":"ok","action":"list_dir","params":{}}', '{"id":"broken","action":'].map(textContent => ({
    textContent, classList: { contains() { return true; } }, setAttribute() {}, removeAttribute() {},
  }));
  const reply = { querySelectorAll() { return blocks; } };
  const error = { style: { display: 'none' } };
  h.document.getElementById = id => id === 'glab-output-error' ? error : null;
  h.document.querySelectorAll = selector => selector.includes('data-message-author-role') ? [reply] : blocks;
  vm.runInContext('syncConvExecutedIds = callback => callback(); handleInstructionFlow = () => { throw Error("must not execute"); }; scanAndExecuteInstructions()', h.context);
  assert.equal(error.style.display, 'block');
  assert.equal(vm.runInContext('currentConvExecutedIds.size', h.context), 0);
});

for (const format of ['array', 'blocks']) {
  test(`multiple short commands still enter the queue in order (${format})`, () => {
    const h = harness();
    const tasks = [0, 1].map(index => ({ id: `part_${index}`, action: 'read_file', params: { path: `short_${index}.txt` } }));
    const texts = format === 'array' ? [JSON.stringify(tasks)] : tasks.map(task => JSON.stringify(task));
    const blocks = texts.map(textContent => ({
      textContent, classList: { contains() { return true; } }, setAttribute() {}, removeAttribute() {},
    }));
    const reply = { querySelectorAll() { return blocks; } };
    h.document.querySelectorAll = selector => selector.includes('data-message-author-role') ? [reply] : blocks;
    vm.runInContext('syncConvExecutedIds = callback => callback(); safeSetStorage = () => {}; executeNextQueueTask = () => {}; scanAndExecuteInstructions()', h.context);
    assert.equal(vm.runInContext('isQueueModeActive', h.context), true);
    assert.equal(vm.runInContext('activeTaskQueue.length', h.context), 2);
    assert.equal(vm.runInContext('activeTaskQueue[0].params.path', h.context), 'short_0.txt');
    assert.equal(vm.runInContext('activeTaskQueue[1].params.path', h.context), 'short_1.txt');
  });
}

test('skill creation instructions require preparation and installation before discovery checks', () => {
  const h = harness();
  const prompt = vm.runInContext('generateInitPrompt("/project", "/custom-skills")', h.context);
  assert.match(prompt, /必须先单独执行 prepare_skill/);
  assert.match(prompt, /等待返回当前目录、文件规范和运行条件后再生成文件/);
  assert.match(prompt, /skill.json、SKILL.md 和入口脚本/);
  assert.match(prompt, /完成后调用 install_skill，再用 list_skills 与 load_skill 验证/);
});

test('prepare_skill is read-only while install_skill requires approval with Auto-run off', () => {
  const h = harness();
  vm.runInContext('isAutoRunEnabled = false; sent = []; approvals = []; sendRequestToCLI = request => sent.push(request.action); showConfirmUI = request => approvals.push(request.action);', h.context);
  vm.runInContext('handleInstructionFlow({id:"prepare", action:"prepare_skill", params:{name:"demo"}}); handleInstructionFlow({id:"install", action:"install_skill", params:{name:"demo"}});', h.context);
  assert.deepEqual(Array.from(h.context.sent), ['prepare_skill']);
  assert.deepEqual(Array.from(h.context.approvals), ['install_skill']);
});

test('generic naming retains model-specific role and response selection', () => {
  const h = harness();
  let selected;
  h.document.querySelectorAll = selector => { selected = selector; return []; };
  assert.equal(vm.runInContext('detectRole()', h.context), 'gpt');
  vm.runInContext('getLatestAssistantReply()', h.context);
  assert.equal(selected, '[data-message-author-role="assistant"]');
  h.context.location.hostname = 'gemini.google.com';
  assert.equal(vm.runInContext('detectRole()', h.context), 'gemini');
  vm.runInContext('getLatestAssistantReply()', h.context);
  assert.equal(selected, 'model-response');
});
