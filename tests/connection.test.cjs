const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ConnectionMonitor,
  probeServer,
  serverKey,
} = require('../out/connection');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('status probes require Appium status JSON, preserve base path and reject redirects', async () => {
  assert.equal(
    serverKey('http://localhost:4723/wd/hub/'),
    'http://127.0.0.1:4723/wd/hub',
  );
  assert.throws(() => serverKey('http://example.org'));
  for (const ready of [true, false]) {
    assert.equal(
      await probeServer(
        'http://127.0.0.1:4723/wd/hub',
        async (url, options) => {
          assert.equal(url, 'http://127.0.0.1:4723/wd/hub/status');
          assert.equal(options.redirect, 'error');
          return { ok: true, json: async () => ({ value: { ready } }) };
        },
      ),
      true,
    );
  }
  assert.equal(
    await probeServer('http://localhost', async () => ({
      ok: true,
      json: async () => ({}),
    })),
    false,
  );
  assert.equal(
    await probeServer('http://localhost', async () => {
      throw Error('timeout');
    }),
    false,
  );
});

test('polling detects disconnection and recovery without overlap; disposal stops it', async () => {
  const states = [],
    pending = [];
  let owned = true;
  const monitor = new ConnectionMonitor(
    (s) => states.push(s),
    () => owned,
    () => new Promise((resolve) => pending.push(resolve)),
    5,
  );
  monitor.watch('http://localhost:4723');
  assert.equal(states.at(-1).status, 'checking');
  pending.shift()(true);
  await tick();
  assert.equal(states.at(-1).owner, 'managed');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(pending.length, 1);
  pending.shift()(false);
  await tick();
  assert.equal(states.at(-1).status, 'disconnected');
  owned = false;
  await new Promise((resolve) => setTimeout(resolve, 15));
  pending.shift()(true);
  await tick();
  assert.equal(states.at(-1).status, 'connected');
  assert.equal(states.at(-1).owner, 'external');
  monitor.dispose();
  const count = states.length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(states.length, count);
});

test('switching URL, invalid URL and disposal discard stale probe responses', async () => {
  const states = [],
    pending = [];
  const monitor = new ConnectionMonitor(
    (s) => states.push(s),
    () => false,
    () => new Promise((r) => pending.push(r)),
  );
  monitor.watch('http://localhost:4723');
  monitor.watch('http://localhost:4725');
  pending.shift()(true);
  await tick();
  assert.equal(states.length, 2);
  pending.shift()(false);
  await tick();
  assert.equal(states.at(-1).owner, 'unknown');
  assert.equal(states.at(-1).url, 'http://127.0.0.1:4725');
  monitor.watch('http://localhost:4723');
  assert.throws(() => monitor.watch('file:///tmp'));
  const count = states.length;
  pending.shift()(true);
  await tick();
  assert.equal(states.length, count);
  monitor.dispose();
});
