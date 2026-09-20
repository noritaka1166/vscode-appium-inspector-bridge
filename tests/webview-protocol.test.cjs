const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  launcherMessageTypes,
  parseLauncherMessage,
} = require('../out/webview-protocol');

test('launcher protocol accepts only complete known messages', () => {
  assert.deepEqual(parseLauncherMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(
    parseLauncherMessage({
      type: 'openOfficial',
      serverUrl: 'http://127.0.0.1:4723',
      ignored: true,
    }),
    { type: 'openOfficial', serverUrl: 'http://127.0.0.1:4723' },
  );
  assert.equal(parseLauncherMessage({ type: 'openOfficial' }), undefined);
  assert.equal(parseLauncherMessage({ type: 'copyCapabilities' }), undefined);
  assert.deepEqual(
    parseLauncherMessage({
      type: 'attachSession',
      serverUrl: 'http://127.0.0.1:4723',
      sessionId: 'session-1',
    }),
    {
      type: 'attachSession',
      serverUrl: 'http://127.0.0.1:4723',
      sessionId: 'session-1',
    },
  );
  assert.equal(parseLauncherMessage({ type: 'attachSession' }), undefined);
  assert.equal(parseLauncherMessage({ type: 'unknown' }), undefined);
  assert.equal(parseLauncherMessage(null), undefined);
  assert.ok(launcherMessageTypes.includes('listDevices'));
  assert.ok(launcherMessageTypes.includes('listSessions'));
  assert.deepEqual(parseLauncherMessage({ type: 'installAppium' }), {
    type: 'installAppium',
  });
  assert.deepEqual(parseLauncherMessage({ type: 'showDriverGuide' }), {
    type: 'showDriverGuide',
  });
});
