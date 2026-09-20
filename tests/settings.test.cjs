const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { settingKeys, validateSettings } = require('../out/settings');

function frame(values, port) {
  class Storage {
    constructor() {
      this.data = new Map();
    }
    setItem(k, v) {
      this.data.set(String(k), String(v));
    }
    getItem(k) {
      return this.data.get(k) ?? null;
    }
    removeItem(k) {
      this.data.delete(k);
    }
    clear() {
      this.data.clear();
    }
  }
  const localStorage = new Storage(),
    messages = [];
  vm.runInNewContext(
    fs
      .readFileSync('media/storage-frame.js', 'utf8')
      .replace(
        '__INSPECTOR_STORAGE__',
        JSON.stringify({
          values,
          keys: settingKeys,
          token: 'test',
          upstreamPort: '4723',
        }),
      )
      .replace('__BRIDGE_LANGUAGE__', '"ja"'),
    {
      Storage,
      window: { localStorage },
      location: { port },
      parent: { postMessage: (m) => messages.push(m) },
    },
  );
  return { localStorage, messages, Storage };
}

test('settings restore before app startup across relay ports; saved capabilities untouched', () => {
  const first = frame({}, '50001');
  const caps = [{ name: 'appium:password', value: '</script>secret' }];
  first.localStorage.setItem(
    'SAVED_SESSIONS',
    JSON.stringify([
      {
        name: 'Android',
        caps,
        server: {
          remote: { hostname: '127.0.0.1', port: '50001' },
          cloud: { port: '50001' },
        },
      },
    ]),
  );
  first.localStorage.setItem('PREFERRED_THEME', '"dark"');
  const stored = first.messages.at(-1).values;
  assert.equal(JSON.parse(stored.SAVED_SESSIONS)[0].server.remote.port, '4723');
  const second = frame(stored, '50002');
  const restored = JSON.parse(second.localStorage.getItem('SAVED_SESSIONS'))[0];
  assert.equal(restored.server.remote.port, '50002');
  assert.equal(restored.server.cloud.port, '50001');
  assert.deepEqual(restored.caps, caps);
  assert.equal(second.localStorage.getItem('PREFERRED_THEME'), '"dark"');
  assert.equal(second.messages.length, 0);
  second.localStorage.removeItem('PREFERRED_THEME');
  assert.equal(
    Object.hasOwn(second.messages.at(-1).values, 'PREFERRED_THEME'),
    false,
  );
  second.localStorage.clear();
  assert.equal(Object.keys(second.messages.at(-1).values).length, 0);
});

test('only approved localStorage keys persist; unrelated storage is ignored', () => {
  const page = frame({}, '50001');
  page.localStorage.setItem('session-id', 'do not persist');
  new page.Storage().setItem('PREFERRED_THEME', '"dark"');
  assert.equal(page.messages.length, 0);
  assert.throws(() => validateSettings({ unknown: '"value"' }));
  assert.throws(() => validateSettings({ PREFERRED_THEME: 'bad json' }));
  assert.throws(() => validateSettings({ PREFERRED_THEME: 42 }));
  assert.deepEqual(validateSettings({ PREFERRED_THEME: '"dark"' }), {
    PREFERRED_THEME: '"dark"',
  });
});
