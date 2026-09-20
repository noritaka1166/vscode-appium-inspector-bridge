const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('extension persists hidden-panel settings in secrets and reloads after activation', async () => {
  const data = new Map();
  let writeCount = 0;
  function host() {
    let provider, panel, bootstrap;
    const messages = [];
    const webview = () => ({
      asWebviewUri: (x) => x,
      cspSource: 'test:',
      postMessage() {},
      onDidReceiveMessage(cb) {
        this.receive = cb;
      },
    });
    const vscode = {
      window: {
        createOutputChannel: () => ({ appendLine() {} }),
        registerWebviewViewProvider: (_, p) => {
          provider = p;
        },
        createWebviewPanel: (_, title) =>
          (panel = {
            title,
            active: false,
            webview: webview(),
            onDidDispose() {},
          }),
        showErrorMessage: (m) => messages.push(m),
      },
      commands: { registerCommand() {} },
      ViewColumn: { One: 1 },
      Uri: {
        joinPath: (...parts) => ({
          fsPath: parts.join('/'),
          toString: () => parts.join('/'),
        }),
      },
    };
    const exports = {};
    vm.runInNewContext(fs.readFileSync('out/extension.js', 'utf8'), {
      exports,
      URL,
      AbortSignal,
      fetch: async () => ({ ok: true, text: async () => 'Appium Inspector' }),
      require: (name) => {
        if (name === 'vscode') return vscode;
        if (name === 'node:fs/promises')
          return {
            readFile: async (path) =>
              path.includes('storage-frame') ? '__INSPECTOR_STORAGE__' : '',
          };
        if (name === './inspector-proxy')
          return {
            startInspectorProxy: async (_, _adapter, callback) => {
              bootstrap = callback;
              return {
                url: new URL('http://127.0.0.1:51000/inspector'),
                token: 'secret-token',
                close() {},
              };
            },
          };
        return name.startsWith('./')
          ? require(`../out/${name.slice(2)}`)
          : require(name);
      },
    });
    exports.activate({
      extensionUri: 'extension',
      subscriptions: [],
      secrets: {
        get: async (key) => data.get(key),
        store: async (key, value) => {
          writeCount++;
          await Promise.resolve();
          data.set(key, value);
        },
      },
    });
    const view = webview();
    provider.resolveWebviewView({ webview: view, onDidDispose() {} });
    return {
      open: (url) => view.receive({ type: 'openOfficial', serverUrl: url }),
      receive: (m) => panel.webview.receive(m),
      config: () => JSON.parse(bootstrap('secret-token')),
      stop: exports.deactivate,
      messages,
    };
  }
  const first = host();
  await first.open('http://127.0.0.1:4723');
  const payload = {
    type: 'saveSettings',
    bridge: 'secret-token',
    values: {
      PREFERRED_THEME: '"dark"',
      SAVED_SESSIONS: '[{"name":"</script>"}]',
    },
  };
  await first.receive({ ...payload, bridge: 'wrong' });
  assert.equal(writeCount, 0);
  await first.receive(payload);
  assert.equal(writeCount, 1);
  assert.equal(first.config().values.PREFERRED_THEME, '"dark"');
  await first.stop();
  const restarted = host();
  await restarted.open('http://127.0.0.1:4723');
  assert.deepEqual(restarted.config().values, payload.values);
  await restarted.receive({ ...payload, values: { unexpected: '{}' } });
  assert.equal(writeCount, 1);
  assert.equal(restarted.messages.length, 1);
  await restarted.stop();
  const different = host();
  await different.open('http://127.0.0.1:4725');
  assert.deepEqual(different.config().values, {});
  await different.stop();
});
