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
  return { context, document, timers, intervals, mutate: target => observer([{ target: target || { nodeType: 1, closest() { return null; } } }]) };
}

test('completion timer rechecks generation before scanning', () => {
  const h = harness();
  h.document.querySelectorAll = () => [{ textContent: 'reply' }];
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

test('generation completion is scanned even without a final DOM mutation', () => {
  const h = harness();
  const reply = { textContent: 'complete reply' };
  let generating = true;
  h.document.querySelector = selector => generating && selector === 'button[data-testid="stop-button"]' ? {} : null;
  h.document.querySelectorAll = () => [reply];
  vm.runInContext('scanCount = 0; scanAndExecuteInstructions = () => scanCount++', h.context);
  h.mutate();
  generating = false;
  h.timers.pop()();
  assert.equal(h.context.scanCount, 0);
  h.timers.pop()();
  assert.equal(h.context.scanCount, 1);
});

test('busy indicators outside the latest assistant reply do not block scanning', () => {
  const h = harness();
  h.document.querySelector = selector => selector === '[aria-busy="true"]' ? {} : null;
  h.document.querySelectorAll = () => [{ textContent: 'new reply', querySelector() { return null; } }];
  assert.equal(vm.runInContext('isPageGenerating()', h.context), false);
});

test('a streaming marker inside the latest assistant reply blocks scanning', () => {
  const h = harness();
  h.document.querySelectorAll = () => [{ querySelector(selector) { return selector === '[data-state="streaming"]' ? {} : null; } }];
  assert.equal(vm.runInContext('getGeneratingSignal()', h.context), '[data-state="streaming"]');
});

test('visible start-voice button clears stale reply busy marker', () => {
  const h = harness();
  h.document.querySelector = selector => selector === 'button[aria-label="开始语音"]' ? {} : null;
  h.document.querySelectorAll = () => [{ querySelector(selector) { return selector === '[aria-busy="true"]' ? {} : null; } }];
  assert.equal(vm.runInContext('isPageGenerating()', h.context), false);
});

test('ChatGPT compact stop button takes precedence over start-voice button', () => {
  const h = harness();
  h.document.querySelector = selector => ['button[aria-label="开始语音"]', 'button[aria-label="停止"]'].includes(selector) ? {} : null;
  assert.equal(vm.runInContext('getGeneratingSignal()', h.context), 'button[aria-label="停止"]');
});

test('compact stop button prevents scanning until it is replaced by start-voice', () => {
  const h = harness();
  const reply = { textContent: 'partial reply' };
  let generating = true;
  h.document.querySelector = selector => generating && selector === 'button[aria-label="停止"]' ? {}
    : !generating && selector === 'button[aria-label="开始语音"]' ? {} : null;
  h.document.querySelectorAll = () => [reply];
  vm.runInContext('lastVoiceIdle = false; scanCount = 0; scanAndExecuteInstructions = () => scanCount++', h.context);
  h.mutate();
  h.timers.pop()();
  assert.equal(h.context.scanCount, 0);
  generating = false;
  reply.textContent = 'complete reply';
  h.timers.pop()();
  assert.equal(h.context.scanCount, 0);
  h.timers.pop()();
  assert.equal(h.context.scanCount, 1);
});

test('voice button transition is observed even inside an excluded composer subtree', () => {
  const h = harness();
  const reply = { textContent: 'new reply', querySelector(selector) { return selector === '[aria-busy="true"]' ? {} : null; } };
  h.document.querySelector = selector => selector === 'button[aria-label="开始语音"]' ? {} : null;
  h.document.querySelectorAll = () => [reply];
  vm.runInContext('lastVoiceIdle = false; scanCount = 0; scanAndExecuteInstructions = () => scanCount++', h.context);
  h.mutate({ nodeType: 1, closest() { return {}; } });
  h.timers.pop()();
  assert.equal(h.context.scanCount, 1);
});

test('an unchanged reply present at connection time is not scanned', () => {
  const h = harness();
  const reply = { textContent: 'older reply' };
  h.document.querySelectorAll = () => [reply];
  vm.runInContext('lastObservedReply = getLatestAssistantReply(); lastObservedReplyText = lastObservedReply.textContent; scanCount = 0; scanAndExecuteInstructions = () => scanCount++', h.context);
  h.mutate();
  assert.equal(h.timers.length, 0);
  assert.equal(h.context.scanCount, 0);
});

test('generation ending without a new assistant reply never scans history', () => {
  const h = harness();
  const reply = { textContent: 'older reply' };
  let generating = true;
  h.document.querySelector = selector => generating && selector === 'button[data-testid="stop-button"]' ? {} : null;
  h.document.querySelectorAll = () => [reply];
  vm.runInContext('lastObservedReply = getLatestAssistantReply(); lastObservedReplyText = lastObservedReply.textContent; scanCount = 0; scanAndExecuteInstructions = () => scanCount++', h.context);
  h.mutate();
  generating = false;
  h.timers.pop()();
  assert.equal(h.context.scanCount, 0);
  assert.equal(h.timers.length, 0);
});

test('stable assistant output is scanned even when no stop button was observed', () => {
  const h = harness();
  const reply = { textContent: 'new reply' };
  h.document.querySelectorAll = () => [reply];
  vm.runInContext('scanCount = 0; scanAndExecuteInstructions = () => scanCount++', h.context);
  h.mutate();
  h.timers.pop()();
  assert.equal(h.context.scanCount, 1);
  h.mutate();
  assert.equal(h.timers.length, 0);
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
    if (selector.includes('conversation-turn')) return [];
    assert.match(selector, /data-message-author-role="assistant"/);
    return [oldReply, latestReply];
  };
  vm.runInContext('syncConvExecutedIds = (callback) => callback(); scanAndExecuteInstructions()', h.context);
  assert.equal(calls.length, 2);
});

test('ChatGPT code block without pre or language class reaches local service', () => {
  const h = harness();
  const code = {
    textContent: '{"id":"health","action":"run_command","params":{"command":"uptime"},"autoSend":true}',
    classList: { contains() { return false; } },
    setAttribute() {},
    removeAttribute() {},
  };
  const reply = {
    textContent: `glab-call${code.textContent}`,
    querySelectorAll(selector) {
      return selector.includes('[data-markdown-copy="code-block"] code') ? [code] : [];
    },
  };
  h.document.querySelectorAll = selector => selector.includes('data-message-author-role') ? [reply]
    : selector.includes('[data-markdown-copy="code-block"] code') ? [code] : [];
  vm.runInContext('syncConvExecutedIds = callback => callback(); safeSetStorage = () => {}; sent = []; socket = {send: payload => sent.push(JSON.parse(payload))};', h.context);
  vm.runInContext('scanAndExecuteInstructions()', h.context);
  assert.equal(h.context.sent.length, 1);
  assert.equal(h.context.sent[0].id, 'health_seq_0');
  assert.equal(h.context.sent[0].params.command, 'uptime');
});

test('latest ChatGPT turn supplies the reply when the old assistant attribute is absent', () => {
  const h = harness();
  const code = {
    textContent: '{"id":"health","action":"run_command","params":{"command":"uptime"}}',
    classList: { contains() { return false; } }, setAttribute() {}, removeAttribute() {},
  };
  const turn = {
    textContent: `glab-call${code.textContent}`,
    getAttribute(name) { return name === 'data-testid' ? 'conversation-turn-2' : null; },
    matches(selector) { return selector === 'main article'; },
    querySelector(selector) { return selector.includes('[data-markdown-copy="code-block"]') ? {} : null; },
    querySelectorAll(selector) { return selector.includes('[data-markdown-copy="code-block"] code') ? [code] : []; },
  };
  h.document.querySelectorAll = selector => selector.includes('conversation-turn') ? [turn]
    : selector.includes('[data-markdown-copy="code-block"] code') ? [code] : [];
  vm.runInContext('syncConvExecutedIds = callback => callback(); safeSetStorage = () => {}; sent = []; socket = {send: payload => sent.push(JSON.parse(payload))};', h.context);
  vm.runInContext('scanAndExecuteInstructions()', h.context);
  assert.equal(h.context.sent.length, 1);
  assert.equal(h.context.sent[0].action, 'run_command');
});

test('ChatGPT assistant-message MarkdownRoot works with no conversation turns', () => {
  const h = harness();
  const oldCode = { textContent: '{"id":"old","action":"run_command","params":{"command":"false"}}', classList: { contains() { return false; } } };
  const newCode = {
    textContent: '{"id":"health","action":"run_command","params":{"command":"uptime"}}',
    classList: { contains() { return false; } }, setAttribute() {}, removeAttribute() {},
  };
  const oldReply = { textContent: oldCode.textContent, querySelectorAll() { throw Error('old reply scanned'); } };
  const newReply = {
    textContent: `glab-call${newCode.textContent}`,
    querySelectorAll(selector) { return selector.includes('[data-markdown-copy="code-block"] code') ? [newCode] : []; },
  };
  h.document.querySelectorAll = selector => selector.includes('conversation-turn') ? []
    : selector.includes('data-markdown-text-style="assistant-message"') ? [oldReply, newReply]
    : selector.includes('[data-markdown-copy="code-block"] code') ? [oldCode, newCode] : [];
  vm.runInContext('syncConvExecutedIds = callback => callback(); safeSetStorage = () => {}; sent = []; socket = {send: payload => sent.push(JSON.parse(payload))};', h.context);
  vm.runInContext('scanAndExecuteInstructions()', h.context);
  assert.equal(h.context.sent.length, 1);
  assert.equal(h.context.sent[0].id, 'health_seq_1');
  assert.equal(h.context.sent[0].params.command, 'uptime');
});

test('assistant-message MarkdownRoot already present at connection is not replayed', () => {
  const h = harness();
  const reply = { textContent: 'existing reply' };
  h.document.querySelectorAll = selector => selector.includes('data-markdown-text-style="assistant-message"') ? [reply] : [];
  vm.runInContext('lastObservedReply = getLatestAssistantReply(); lastObservedReplyText = lastObservedReply.textContent; scanCount = 0; scanAndExecuteInstructions = () => scanCount++', h.context);
  h.mutate();
  assert.equal(h.timers.length, 0);
  assert.equal(h.context.scanCount, 0);
});

test('latest user turn never falls back to an older assistant command', () => {
  const h = harness();
  const userTurn = {
    getAttribute(name) { return name === 'data-testid' ? 'conversation-turn-3' : null; },
    matches() { return false; },
    querySelector(selector) { return selector.includes('data-testid="user-message"') ? {} : null; },
  };
  h.document.querySelectorAll = selector => selector.includes('conversation-turn') ? [userTurn]
    : selector.includes('data-message-author-role="assistant"') ? [{ textContent: 'old reply' }] : [];
  assert.equal(vm.runInContext('getLatestAssistantReply()', h.context), null);
});

test('standalone plain JSON command executes once', () => {
  const h = harness();
  const reply = {
    textContent: '{"id":"health","action":"run_command","params":{"command":"uptime"}}',
    classList: { contains() { return false; } },
    querySelectorAll() { return []; },
    hasAttribute(name) { return this.processed === name; },
    setAttribute(name) { this.processed = name; },
    removeAttribute() { this.processed = null; },
  };
  h.document.querySelectorAll = selector => selector.includes('data-message-author-role') ? [reply] : [];
  vm.runInContext('syncConvExecutedIds = callback => callback(); safeSetStorage = () => {}; sent = []; socket = {send: payload => sent.push(JSON.parse(payload))};', h.context);
  vm.runInContext('scanAndExecuteInstructions(); scanAndExecuteInstructions()', h.context);
  assert.equal(h.context.sent.length, 1);
  assert.equal(h.context.sent[0].action, 'run_command');
  assert.equal(h.context.sent[0].id, 'health_seq_plain_0');
});

test('JSON embedded in prose is ignored', () => {
  const h = harness();
  const reply = {
    textContent: 'Example: {"id":"health","action":"run_command","params":{"command":"uptime"}}',
    querySelectorAll() { return []; },
  };
  h.document.querySelectorAll = selector => selector.includes('data-message-author-role') ? [reply] : [];
  vm.runInContext('syncConvExecutedIds = callback => callback(); handleInstructionFlow = () => { throw Error("must not execute"); }; scanAndExecuteInstructions()', h.context);
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
  assert.match(selected, /data-message-author-role="assistant"/);
  h.context.location.hostname = 'gemini.google.com';
  assert.equal(vm.runInContext('detectRole()', h.context), 'gemini');
  vm.runInContext('getLatestAssistantReply()', h.context);
  assert.equal(selected, 'model-response');
});
