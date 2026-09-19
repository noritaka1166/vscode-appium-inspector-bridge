const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ trusted = true, reachable = false, canStart = false } = {}) {
  let provider, checks = 0, spawns = 0, scans = 0, copied;
  const events = [], requests = [];
  const report = { canStart, items: [{ name: 'Appium', status: canStart ? 'ok' : 'error', detail: 'test' }] };
  const vscode = {
    env: { clipboard: { writeText: async text => { copied = text; } } },
    workspace: { isTrusted: trusted },
    window: {
      createOutputChannel: () => ({ appendLine() {} }),
      registerWebviewViewProvider: (_, p) => { provider = p; }
    },
    commands: { registerCommand() {} },
    Uri: { joinPath: (...parts) => parts.join('/') }
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync('out/extension.js', 'utf8'), {
    exports, URL, AbortSignal,
    fetch: async url => { requests.push(String(url)); return { ok: String(url).endsWith('/status') && reachable, text: async () => '' }; },
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === './devices') return { ...require('../out/devices'), listDevices: async () => { scans++; return { devices: [{ id: 'Android:test', udid: 'test', name: 'Pixel', platform: 'Android', state: 'device' }], notes: [] }; } };
      if (name === './environment') return { checkEnvironment: async () => { checks++; return report; } };
      if (name === 'node:child_process') return { spawn: () => { spawns++; throw Error('test: stop before real spawn'); } };
      return name.startsWith('./') ? require('../out/' + name.slice(2)) : require(name);
    }
  });
  exports.activate({ extensionUri: 'extension', subscriptions: [] });
  const view = { cspSource: 'test:', asWebviewUri: x => x, postMessage: m => events.push(m), onDidReceiveMessage(cb) { this.receive = cb; } };
  provider.resolveWebviewView({ webview: view, onDidDispose() {} });
  return { view, events, requests, checks: () => checks, spawns: () => spawns, scans: () => scans, copied: () => copied };
}
test('manual check posts results, replays them on ready, and clears loading', async () => {
  const host = setup();
  assert.match(host.view.html, /check-environment/);
  await host.view.receive({ type: 'checkEnvironment' });
  assert.equal(host.checks(), 1);
  assert.ok(host.events.some(m => m.type === 'environment'));
  assert.equal(host.events.at(-1).active, false);
  await host.view.receive({ type: 'ready' });
  assert.equal(host.events.filter(m => m.type === 'environment').length, 2);
});
test('failed preflight prevents spawn; successful preflight proceeds to spawn', async () => {
  for (const canStart of [false, true]) {
    const host = setup({ canStart });
    await host.view.receive({ type: 'startOfficial', serverUrl: 'http://127.0.0.1:4723' });
    assert.equal(host.checks(), 1);
    assert.equal(host.spawns(), canStart ? 1 : 0);
    assert.equal(host.events.at(-1).active, false);
  }
});
test('existing server bypasses local preflight and tries Inspector endpoint', async () => {
  const host = setup({ reachable: true });
  await host.view.receive({ type: 'startOfficial', serverUrl: 'http://127.0.0.1:4723' });
  assert.equal(host.checks(), 0);
  assert.equal(host.spawns(), 0);
  assert.ok(host.requests.some(url => url.endsWith('/inspector')));
});
test('untrusted workspace never executes diagnostic or server commands', async () => {
  const host = setup({ trusted: false });
  await host.view.receive({ type: 'checkEnvironment' });
  await host.view.receive({ type: 'listDevices' });
  assert.equal(host.scans(), 0);
  await host.view.receive({ type: 'startOfficial', serverUrl: 'http://127.0.0.1:4723' });
  assert.equal(host.checks(), 0);
  assert.equal(host.spawns(), 0);
  assert.ok(host.events.some(m => m.type === 'notice' && m.text.includes('信頼')));
});
test('device selection generates and copies only enumerated device capabilities', async () => {
  const host = setup();
  await host.view.receive({ type: 'listDevices' });
  assert.equal(host.scans(), 1);
  assert.ok(host.events.some(m => m.type === 'devices'));
  await host.view.receive({ type: 'deviceCapabilities', deviceId: 'Android:test' });
  const template = host.events.find(m => m.type === 'capabilitiesTemplate').text;
  assert.equal(JSON.parse(template)['appium:udid'], 'test');
  assert.equal(host.copied(), undefined);
  await host.view.receive({ type: 'copyCapabilities', deviceId: 'invalid' });
  assert.equal(host.copied(), undefined);
  await host.view.receive({ type: 'copyCapabilities', deviceId: 'Android:test' });
  assert.equal(host.copied(), template);
  assert.equal(host.spawns(), 0);
});
