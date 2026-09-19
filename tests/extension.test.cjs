const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

test('official-only launcher and failed connection clears loading', async () => {
  let provider, receive, fail = false;
  const events = [], calls = [], commands = new Map();
  function webview() {
    return { options: {}, cspSource: 'test:', asWebviewUri: x => x, postMessage: m => { events.push(m); return Promise.resolve(true); }, onDidReceiveMessage: cb => { receive = cb; } };
  }
  const vscode = {
    window: {
      createOutputChannel: () => ({ appendLine() {}, append() {}, dispose() {} }),
      registerWebviewViewProvider: (_, p) => { provider = p; return {}; },
      createWebviewPanel: () => ({ webview: webview(), onDidDispose() {}, reveal() {} })
    },
    commands: { registerCommand: (name, cb) => { commands.set(name, cb); return {}; }, executeCommand: name => commands.get(name)?.() },
    Uri: { joinPath: (...parts) => parts.join('/') }, ViewColumn: { One: 1 }
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync('out/extension.js', 'utf8'), {
    exports, require: name => name === 'vscode' ? vscode : name.startsWith('./') ? require('../out/' + name.slice(2)) : require(name),
    crypto, Buffer, URL, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return { ok: !fail, status: fail ? 500 : 200, text: async () => 'Appium Inspector' };
    }
  });
  exports.activate({ subscriptions: [], extensionUri: 'extension' });
  const view = webview(); provider.resolveWebviewView({ webview: view, onDidDispose() {} });
  assert.match(view.html, /公式 Inspector/);
  assert.match(view.html, /初回セットアップ/);
  assert.doesNotMatch(view.html, /legacy|簡易 Inspector/);
  assert.equal(commands.has('appiumInspector.legacy'), false);
  assert.equal(require('../package.json').contributes.commands.some(c => c.command === 'appiumInspector.legacy'), false);
  await receive({ type: 'ready' });
  assert.ok(events.some(m => m.type === 'server' && !m.running));
  fail = true;
  await receive({ type: 'openOfficial', serverUrl: 'http://127.0.0.1:4723' });
  assert.ok(events.some(m => m.type === 'notice' && m.level === 'error'));
  assert.ok(events.some(m => m.type === 'loading' && m.active));
  assert.equal(events.at(-1).active, false);
  exports.deactivate();
});
