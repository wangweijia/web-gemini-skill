const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { serialize, extractReplies } = require('../extension/chat-export');

function element(tag, attrs = {}, ...children) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), id: attrs.id || '', className: attrs.class || '',
    hidden: Boolean(attrs.hidden),
    childNodes: children.flat().map(child => typeof child === 'string' ? { nodeType: 3, textContent: child } : child),
    getAttribute(name) { return attrs[name] ?? null; },
    contains(other) { return this.childNodes.some(child => child === other || child.contains?.(other)); },
    querySelectorAll(selector) {
      const result = [];
      for (const child of this.childNodes) {
        if (child.nodeType !== 1) continue;
        if (selector === '.markdown' ? child.className.split(' ').includes('markdown') : child.tagName === selector.toUpperCase()) result.push(child);
        result.push(...child.querySelectorAll(selector));
      }
      return result;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    closest(selector) {
      return selector === '.markdown' && this.className.split(' ').includes('markdown') ? this : this.parentElement?.closest(selector);
    },
  };
  node.childNodes.forEach(child => { child.parentElement = node; });
  Object.defineProperty(node, 'children', { get() { return this.childNodes.filter(child => child.nodeType === 1); } });
  Object.defineProperty(node, 'textContent', { get() { return this.childNodes.map(child => child.textContent).join(''); } });
  return node;
}

test('serializer preserves Markdown structure and code, excluding page controls', () => {
  const reply = element('div', {},
    element('h2', {}, 'Example'),
    element('p', {}, 'Use ', element('strong', {}, 'this'), ' ', element('a', { href: 'https://example.com/docs' }, 'reference')),
    element('pre', {}, element('button', {}, 'Copy code'), element('code', { class: 'language-js' }, '  const fence = "```";\n    run();\n')),
    element('ol', { start: '3' }, element('li', {}, 'First'), element('li', {}, 'Second')),
    element('blockquote', {}, element('p', {}, 'Note')),
    element('button', {}, 'Regenerate'), element('span', { 'aria-hidden': 'true' }, 'Hidden'),
    element('div', { id: 'glab-panel-root' }, 'GLAB log'),
    element('script', {}, 'alert(1)'));
  const markdown = serialize(reply).trim();
  assert.match(markdown, /## Example/);
  assert.match(markdown, /\*\*this\*\* \[reference\]\(<https:\/\/example.com\/docs>\)/);
  assert.match(markdown, /````js\n  const fence = "```";\n    run\(\);\n````/);
  assert.match(markdown, /3\. First\n4\. Second/);
  assert.match(markdown, /> Note/);
  assert.doesNotMatch(markdown, /Copy code|Regenerate|Hidden|GLAB log|alert/);
});

test('tables, nested lists, inline backticks and unsupported images remain explicit', () => {
  const reply = element('div', {},
    element('table', {}, element('tr', {}, element('th', {}, 'Name'), element('th', {}, 'Value')),
      element('tr', {}, element('td', {}, 'a|b'), element('td', {}, '2'))),
    element('ul', {}, element('li', {}, 'Outer', element('ul', {}, element('li', {}, 'Inner')))),
    element('p', {}, element('code', {}, 'a`b')),
    element('img', { alt: 'diagram' }),
    element('a', { href: 'javascript:alert(1)' }, 'unsafe'));
  const markdown = serialize(reply);
  assert.match(markdown, /\| Name \| Value \|\n\| --- \| --- \|\n\| a\\\|b \| 2 \|/);
  assert.match(markdown, /- Outer\n\s+- Inner/);
  assert.match(markdown, /``a`b``/);
  assert.match(markdown, /Image not exported: diagram/);
  assert.doesNotMatch(markdown, /javascript:/);
});

test('current GPT code blocks without pre elements preserve whitespace and omit toolbars', () => {
  const block = element('div', { 'data-markdown-copy': 'code-block' },
    element('div', {}, 'JavaScript', element('button', {}, 'Copy')),
    element('code', {}, '  first();\n    second();'));
  assert.equal(serialize(block).trim(), '```\n  first();\n    second();\n```');
});

test('modern assistant MarkdownRoot is included without requiring the old role attribute', () => {
  const reply = element('div', { 'data-markdown-text-style': 'assistant-message' }, element('p', {}, 'Modern reply'));
  const queried = [];
  const document = {
    querySelectorAll(selector) {
      queried.push(selector);
      return selector.includes('data-markdown-text-style') ? [reply] : [];
    },
  };
  assert.equal(extractReplies(document)[0].text, 'Modern reply');
  assert.equal(queried.length, 1);
});

test('extraction uses only assistant bodies, deduplicates nested containers and preserves order', () => {
  const nested = element('div', {}, element('div', { class: 'markdown' }, element('p', {}, 'First')));
  const first = element('div', { 'data-message-id': 'gpt_1' }, nested, element('button', {}, 'Copy'));
  const second = element('div', {}, element('div', { class: 'markdown' }, element('p', {}, 'Second')));
  const document = { querySelectorAll: selector => selector.includes('author-role') ? [first, nested, second] : [] };
  assert.deepEqual(extractReplies(document), [
    { messageId: 'gpt_1', text: 'First' }, { messageId: 'reply_2', text: 'Second' },
  ]);
  assert.deepEqual(extractReplies({ querySelectorAll: () => [] }), []);
});

function exportHarness({ generating = false, confirmed = true, latest = true, messages = [{ messageId: 'm1', text: 'One' }, { messageId: 'm2', text: 'Two' }] } = {}) {
  const sent = [];
  const nodes = {
    'glab-acp-latest': { checked: latest },
    'glab-acp-export-btn': { disabled: false },
    'glab-acp-export-status': { textContent: '' },
  };
  const context = vm.createContext({
    console, TextEncoder,
    document: { addEventListener() {}, getElementById: id => nodes[id] || null },
    window: { location: { pathname: '/c/abc' }, confirm: () => confirmed },
    location: { hostname: 'chatgpt.com' },
    WebSocket: { OPEN: 1 },
    GLABChatExport: { extractReplies: () => messages },
    setTimeout() { return 1; }, clearTimeout() {},
    MutationObserver: class {},
  });
  vm.runInContext(fs.readFileSync('extension/content.js', 'utf8'), context);
  context.sent = sent;
  vm.runInContext(`socket = { readyState: 1, send: text => sent.push(JSON.parse(text)) };
    logToTerminal = () => {}; isPageGenerating = () => ${generating};`, context);
  vm.runInContext('exportGPTToACP()', context);
  return { sent, nodes };
}

test('manual export sends only the selected snapshot and never an execution action', () => {
  const { sent, nodes } = exportHarness();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'acp_preview_capture');
  assert.equal(sent[0].params.conversationId, 'abc');
  assert.equal(sent[0].params.messages.length, 1);
  assert.equal(sent[0].params.messages[0].text, 'Two');
  assert.equal(nodes['glab-acp-export-btn'].disabled, true);
  assert.equal(exportHarness({ latest: false }).sent[0].params.messages.length, 2);
});

test('generation, missing replies, oversized content and declined consent do not export', () => {
  for (const options of [
    { generating: true }, { confirmed: false }, { messages: [] },
    { messages: [{ messageId: 'large', text: '中'.repeat(400000) }] },
  ]) {
    assert.equal(exportHarness(options).sent.length, 0);
  }
  assert.match(exportHarness({ generating: true }).nodes['glab-acp-export-status'].textContent, /等待/);
  assert.match(exportHarness({ messages: [] }).nodes['glab-acp-export-status'].textContent, /未找到/);
});
