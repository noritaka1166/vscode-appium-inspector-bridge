const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { officialHtml } = require('../out/official');

function host() {
  let provider, panel, dispose, choose = async () => undefined, spawned = false, kills = 0;
  const dialogs = [], events = [], requests = [];
  const child = new EventEmitter();
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null,
    kill() { kills++; queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); }); return true; } });
  const view = () => ({ asWebviewUri: x => x, cspSource: 'test:', onDidReceiveMessage(cb) { this.receive = cb; }, postMessage: m => { events.push(m); return Promise.resolve(true); } });
  const vscode = {
    workspace: { isTrusted: true }, commands: { registerCommand() {} }, ViewColumn: { One: 1 },
    Uri: { joinPath: (...parts) => ({ fsPath: parts.join('/'), toString: () => parts.join('/') }) },
    window: {
      createOutputChannel: () => ({ appendLine() {} }),
      registerWebviewViewProvider: (_, p) => { provider = p; },
      createWebviewPanel: (_, title) => (panel = { title, active: true, webview: view(), reveal() {}, onDidDispose(cb) { dispose = cb; } }),
      showWarningMessage: (...args) => { dialogs.push(args); return choose(...args); },
      showErrorMessage() {}
    }
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync('out/extension.js', 'utf8'), {
    exports, URL, AbortSignal, setTimeout, clearTimeout,
    fetch: async url => { requests.push(String(url)); return { ok: String(url).endsWith('/status') ? spawned : true, json: async () => ({ value: { ready: true } }), text: async () => 'Appium Inspector' }; },
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === './environment') return { checkEnvironment: async () => ({ canStart: true, items: [] }) };
      if (name === 'node:child_process') return { spawn: () => { spawned = true; return child; } };
      if (name === 'node:fs/promises') return { readFile: async () => '' };
      if (name === './inspector-proxy') return { startInspectorProxy: async () => ({ url: new URL('http://127.0.0.1:5000/inspector'), token: 'token', close() {} }) };
      return name.startsWith('./') ? require('../out/' + name.slice(2)) : require(name);
    }
  });
  exports.activate({ subscriptions: [], extensionUri: 'extension', secrets: { get: async () => undefined } });
  const sidebar = view(); provider.resolveWebviewView({ webview: sidebar, onDidDispose() {} });
  return { events, dialogs, requests, kills: () => kills, choose: cb => { choose = cb; },
    reconnect: () => sidebar.receive({ type: 'reconnect', serverUrl: 'http://127.0.0.1:4723' }),
    html: () => panel.webview.html,
    start: () => sidebar.receive({ type: 'startOfficial', serverUrl: 'http://127.0.0.1:4723' }),
    stop: () => sidebar.receive({ type: 'stopServer' }),
    reload: (bridge = 'token') => panel.webview.receive({ type: 'requestReload', bridge }),
    close: () => dispose() };
}

test('Server stop cancellation preserves process; approval terminates it once', async () => {
  const h = host(); await h.start();
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
  assert.equal(offline.requests.some(url => url.endsWith('/inspector')), false);
  assert.ok(offline.events.some(m => m.type === 'notice' && m.level === 'error'));
  const online = host(); await online.start();
  const html = online.html();
  await online.reconnect();
  assert.equal(online.html(), html);
  assert.equal(online.kills(), 0);
  assert.equal(online.events.some(m => m.type === 'reloadConfirmed'), false);
  assert.ok(online.events.some(m => m.type === 'notice' && m.text.includes('接続を確認')));
  assert.equal(online.requests.some(url => url.includes('/session')), false);
});
test('reload requires approval, rejects foreign token, and ignores duplicate requests', async () => {
  const h = host(); await h.start();
  await h.reload('foreign');
  assert.equal(h.dialogs.length, 0);
  await h.reload();
  assert.equal(h.events.some(m => m.type === 'reloadConfirmed'), false);
  let resolve;
  h.choose(() => new Promise(r => { resolve = r; }));
  const pending = h.reload();
  await h.reload();
  assert.equal(h.dialogs.length, 2);
  resolve('再読み込みする'); await pending;
  assert.equal(h.events.filter(m => m.type === 'reloadConfirmed').length, 1);
  const closing = h.reload(); h.close(); resolve('再読み込みする'); await closing;
  assert.equal(h.events.filter(m => m.type === 'reloadConfirmed').length, 1);
});
test('reload button sends request; only host acknowledgement reloads iframe', () => {
  const html = officialHtml(new URL('http://127.0.0.1:5000/inspector'), 'token');
  const elements = {}, sent = []; let listener, reloads = 0;
  const frame = { contentWindow: {}, get src() { return 'url'; }, set src(v) { reloads++; } };
  elements.inspector = frame;
  vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ postMessage: m => sent.push(m) }),
    document: { getElementById: id => elements[id] ||= {} },
    window: { addEventListener: (_, cb) => { listener = cb; } }
  });
  elements.reload.onclick(); assert.equal(sent[0].type, 'requestReload'); assert.equal(reloads, 0);
  listener({ source: frame.contentWindow, origin: 'http://127.0.0.1:5000', data: { bridge: 'token', type: 'reloadConfirmed' } });
  assert.equal(reloads, 0);
  listener({ source: {}, data: { bridge: 'token', type: 'reloadConfirmed' } });
  assert.equal(reloads, 1);
});
