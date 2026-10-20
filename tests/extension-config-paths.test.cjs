const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(initialStorage = {}) {
  const elements = new Map();
  const storage = { ...initialStorage };
  const observers = [];
  const sockets = [];
  const feedback = [];
  const alerts = [];
  class Element {
    constructor() {
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = {};
      this.value = '';
      this.textContent = '';
      this.title = '';
      this.disabled = false;
      const classes = new Set();
      this.classList = {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name); },
        contains(name) { return classes.has(name); },
      };
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    set value(value) { this._value = String(value); }
    get value() { return this._value; }
    set innerHTML(value) {
      for (const match of value.matchAll(/\bid="([^"]+)"/g)) {
        const element = new Element();
        element.id = match[1];
      }
    }
    appendChild() {}
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    click() { this.listeners.get('click')?.({ detail: 0 }); }
  }
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen(); }
    send(payload) { this.sent.push(JSON.parse(payload)); }
    message(payload) { this.onmessage({ data: JSON.stringify(payload) }); }
    close() { this.readyState = 2; }
    finishClose() { this.readyState = 3; this.onclose(); }
  }
  const document = {
    createElement() { return new Element(); },
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, head: new Element(), body: new Element(),
  };
  const context = vm.createContext({
    document, console, WebSocket: Socket, alert: message => alerts.push(message),
    location: { hostname: 'chatgpt.com' },
    window: { location: { pathname: '/c/abc' }, addEventListener() {} },
    chrome: {
      runtime: { id: 'test' },
      storage: { local: {
        get(keys, callback) { callback(Object.fromEntries(keys.filter(key => key in storage).map(key => [key, storage[key]]))); },
        set(data, callback) { Object.assign(storage, data); callback?.(); },
      } },
    },
    setTimeout() { return 1; }, clearTimeout() {},
    MutationObserver: class {
      constructor() { this.active = false; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    feedback,
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync('extension/content.js', 'utf8'));
  run('injectGLABPanel(); replyToChat = text => feedback.push(text)');
  return {
    storage, sockets, feedback, alerts, observers, run,
    element: id => elements.get(`glab-${id}`),
    get socket() { return sockets.at(-1); },
    handshake(data) { this.socket.open(); this.socket.message({ action: 'shakehand_reply', status: 'success', data }); },
  };
}

test('existing absolute configurations migrate to home shorthand only after the CLI supplies its home', () => {
  const h = harness({ workDir: '/Users/test/Project Space', skillsDir: '/Users/test/.glab-skills' });
  h.handshake({ homeDir: '/Users/test', workDir: '/Users/test/Project Space', skillsDir: '/Users/test/.glab-skills' });
  assert.equal(h.socket.sent[0].params.workDir, '/Users/test/Project Space');
  assert.equal(h.storage.workDir, '~/Project Space');
  assert.equal(h.storage.skillsDir, '~/.glab-skills');
  assert.equal(h.element('input-workdir').value, '~/Project Space');
  assert.equal(h.element('input-workdir').title, '/Users/test/Project Space');
  assert.equal(h.element('input-skillsdir').value, '~/.glab-skills');
  assert.equal(h.element('init-prompt-btn').disabled, false);
  assert.equal(h.element('verify-btn').disabled, false);
  h.element('init-prompt-btn').click();
  assert.ok(h.feedback[0].includes('`/Users/test/Project Space`'));
  assert.ok(h.feedback[0].includes('`/Users/test/.glab-skills`'));
  assert.equal(h.feedback[0].includes('~/'), false);
});

test('home abbreviation respects directory boundaries and never substitutes unrelated path segments', () => {
  const h = harness();
  h.run('currentCLIHomeDir = "/Users/test/"');
  for (const [input, expected] of [
    ['/Users/test', '~'], ['/Users/test/', '~'], ['/Users/test/with spaces', '~/with spaces'],
    ['/Users/test-other/project', '/Users/test-other/project'],
    ['/Volumes/Users/test/project', '/Volumes/Users/test/project'],
    ['/Users/other/project', '/Users/other/project'],
    ['  ～/project  ', '~/project'],
  ]) {
    assert.equal(h.run(`formatConfigPath(${JSON.stringify(input)})`), expected);
  }
});

test('directory selection and save consistently format paths and normalize full-width tilde', () => {
  const h = harness();
  h.handshake({ homeDir: '/Users/test', workDir: '', skillsDir: '/Users/test/.glab-skills' });
  assert.equal(h.element('init-prompt-btn').disabled, true);
  h.socket.message({ id: 'select_dir_test', status: 'success', data: { selectedPath: '/Users/test/Chosen Project' } });
  assert.equal(h.element('input-workdir').value, '~/Chosen Project');
  h.element('input-skillsdir').value = ' ～/Custom Skills ';
  h.element('save-config-btn').click();
  assert.equal(h.storage.workDir, '~/Chosen Project');
  assert.equal(h.storage.skillsDir, '~/Custom Skills');
  assert.equal(h.element('input-skillsdir').value, '~/Custom Skills');
  assert.equal(h.element('init-prompt-btn').disabled, true);
  h.socket.open();
  assert.equal(h.socket.sent[0].params.skillsDir, '~/Custom Skills');
});

test('blank Skills configuration still uses the CLI effective default and external paths stay absolute', () => {
  const h = harness({ workDir: '/Volumes/Project', skillsDir: '' });
  h.socket.open();
  assert.equal(h.socket.sent[0].params.skillsDir, '');
  h.socket.message({
    action: 'shakehand_reply', status: 'success',
    data: { homeDir: '/Users/test', workDir: '/Volumes/Project', skillsDir: '/Users/test/.web-gemini-skill' },
  });
  assert.equal(h.storage.workDir, '/Volumes/Project');
  assert.equal(h.storage.skillsDir, '~/.web-gemini-skill');
  h.element('input-skillsdir').value = '/Volumes/Shared Skills';
  h.element('save-config-btn').click();
  assert.equal(h.storage.skillsDir, '/Volumes/Shared Skills');
  h.element('input-workdir').value = ' ';
  h.element('save-config-btn').click();
  assert.match(h.alerts.at(-1), /工作根目录不能为空/);
});

test('handshake errors and old CLIs cannot initialize rules using unresolved home paths', () => {
  for (const response of [
    { status: 'error', error: 'unsupported directory' },
    { status: 'success', data: { workDir: '/service/~/project', skillsDir: '/service/~/skills' } },
  ]) {
    const h = harness({ workDir: '~/project', skillsDir: '~/skills' });
    h.socket.open();
    h.socket.message({ action: 'shakehand_reply', ...response });
    assert.equal(h.element('init-prompt-btn').disabled, true);
    assert.equal(h.element('verify-btn').disabled, true);
    assert.equal(h.observers[0].active, false);
    h.element('init-prompt-btn').click();
    assert.equal(h.feedback.length, 0);
  }
});

test('a replaced connection closing late cannot discard the newly resolved directories', () => {
  const h = harness({ workDir: '/Users/test/project' });
  h.handshake({ homeDir: '/Users/test', workDir: '/Users/test/project', skillsDir: '/Users/test/skills' });
  const previous = h.socket;
  h.element('input-workdir').value = '~/next';
  h.element('save-config-btn').click();
  assert.equal(h.observers[0].active, false);
  h.handshake({ homeDir: '/Users/test', workDir: '/Users/test/next', skillsDir: '/Users/test/skills' });
  previous.finishClose();
  assert.equal(h.element('init-prompt-btn').disabled, false);
  h.element('init-prompt-btn').click();
  assert.ok(h.feedback[0].includes('`/Users/test/next`'));
});
