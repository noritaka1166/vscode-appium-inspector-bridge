const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

function host() {
  let provider,
    panel,
    dispose,
    choose = async () => undefined,
    spawned = false,
    kills = 0;
  const panels = [];
  const dialogs = [],
    events = [],
    requests = [];
  const child = new EventEmitter();
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    kill() {
      kills++;
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('close', 0);
      });
      return true;
    },
  });
  const view = () => ({
    asWebviewUri: (x) => x,
    cspSource: 'test:',
    onDidReceiveMessage(cb) {
      this.receive = cb;
    },
    postMessage: (m) => {
      events.push(m);
      return Promise.resolve(true);
    },
  });
  const vscode = {
    workspace: { isTrusted: true },
    commands: { registerCommand() {} },
    ViewColumn: { One: 1, Beside: 2 },
    Uri: {
      joinPath: (...parts) => ({
        fsPath: parts.join('/'),
        toString: () => parts.join('/'),
      }),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {} }),
      registerWebviewViewProvider: (_, p) => {
        provider = p;
      },
      createWebviewPanel: (_, title) => {
        panel = {
          title,
          active: true,
          webview: view(),
          reveal() {},
          onDidDispose(cb) {
            dispose = cb;
          },
        };
        panels.push(panel);
        return panel;
      },
      showWarningMessage: (...args) => {
        dialogs.push(args);
        return choose(...args);
      },
      showErrorMessage() {},
    },
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync('out/extension.js', 'utf8'), {
    exports,
    URL,
    AbortSignal,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      requests.push(String(url));
      return {
        ok: String(url).endsWith('/status') ? spawned : true,
        json: async () => ({ value: { ready: true } }),
        text: async () => 'Appium Inspector',
      };
    },
    require: (name) => {
      if (name === 'vscode') return vscode;
      if (name === './environment')
        return {
          checkEnvironment: async () => ({ canStart: true, items: [] }),
          resolveAppiumExecutable: async () => '/trusted/appium',
        };
      if (name === 'node:child_process')
        return {
          spawn: () => {
            spawned = true;
            return child;
          },
        };
      if (name === 'node:fs/promises') return { readFile: async () => '' };
      if (name === './inspector-proxy')
        return {
          startInspectorProxy: async () => ({
            url: new URL('http://127.0.0.1:5000/inspector'),
            token: 'token',
            close() {},
          }),
        };
      return name.startsWith('./')
        ? require(`../out/${name.slice(2)}`)
        : require(name);
    },
  });
  exports.activate({
    subscriptions: [],
    extensionUri: 'extension',
    secrets: { get: async () => undefined },
  });
  const sidebar = view();
  provider.resolveWebviewView({ webview: sidebar, onDidDispose() {} });
  return {
    events,
    dialogs,
    requests,
    kills: () => kills,
    choose: (cb) => {
      choose = cb;
    },
    reconnect: () =>
      sidebar.receive({
        type: 'reconnect',
        serverUrl: 'http://127.0.0.1:4723',
      }),
    open: (serverUrl = 'http://127.0.0.1:4723') =>
      sidebar.receive({ type: 'openOfficial', serverUrl }),
    panels: () => panels,
    html: () => panel.webview.html,
    start: () =>
      sidebar.receive({
        type: 'startOfficial',
        serverUrl: 'http://127.0.0.1:4723',
      }),
    stop: () => sidebar.receive({ type: 'stopServer' }),
    close: () => dispose(),
  };
}

test('Server stop cancellation preserves process; approval terminates it once', async () => {
  const h = host();
  await h.start();
  await h.stop();
  assert.equal(h.kills(), 0);
  assert.equal(h.dialogs[0][1].modal, true);
  assert.equal(h.events.at(-1).active, false);
  h.choose(async () => '停止する');
  await h.stop();
  assert.equal(h.kills(), 1);
});
test('reconnect preserves Inspector and session; unreachable server is not started', async () => {
  const offline = host();
  await offline.reconnect();
  assert.equal(
    offline.requests.some((url) => url.endsWith('/inspector')),
    false,
  );
  assert.ok(
    offline.events.some((m) => m.type === 'notice' && m.level === 'error'),
  );
  const online = host();
  await online.start();
  const html = online.html();
  await online.reconnect();
  assert.equal(online.html(), html);
  assert.equal(online.kills(), 0);
  assert.ok(
    online.events.some(
      (m) => m.type === 'notice' && m.text.includes('接続を確認'),
    ),
  );
  assert.equal(
    online.requests.some((url) => url.includes('/session')),
    false,
  );
});
test('opening an Inspector again creates an independent editor tab', async () => {
  const h = host();
  await h.start();
  const first = h.panels()[0];
  await h.open();
  assert.equal(h.panels().length, 2);
  assert.notEqual(h.panels()[1].webview, first.webview);
  assert.match(h.panels()[1].title, /Appium Inspector Bridge/);
});
