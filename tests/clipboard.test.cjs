const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('clipboard adapter replaces selection and emits input for React; rejects foreign messages', () => {
  const messages = [],
    listeners = {},
    docListeners = {},
    dispatched = [];
  class Field {
    get value() {
      return this._value;
    }
    set value(v) {
      this._value = v;
    }
    focus() {}
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
    }
    dispatchEvent(event) {
      dispatched.push(event.type);
    }
  }
  const field = new Field();
  Object.assign(field, {
    value: '{}',
    selectionStart: 0,
    selectionEnd: 2,
    isConnected: true,
  });
  const parent = { postMessage: (m) => messages.push(m) };
  const window = {
    addEventListener: (name, cb) => {
      listeners[name] = cb;
    },
  };
  vm.runInNewContext(
    fs
      .readFileSync('media/clipboard-frame.js', 'utf8')
      .replace('__BRIDGE_TOKEN__', '"test-token"')
      .replace('__BRIDGE_LANGUAGE__', '"ja"'),
    {
      window,
      parent,
      navigator: {},
      setTimeout,
      clearTimeout,
      HTMLTextAreaElement: Field,
      HTMLInputElement: class {},
      Event: class {
        constructor(type) {
          this.type = type;
        }
      },
      document: {
        addEventListener: (name, cb) => {
          docListeners[name] = cb;
        },
        activeElement: field,
      },
    },
  );
  docListeners.focusin({ target: field });
  const payload = {
    bridge: 'test-token',
    type: 'pasteText',
    text: '{"platformName":"Android"}',
  };
  listeners.message({ source: {}, data: payload });
  assert.equal(field.value, '{}');
  listeners.message({ source: parent, data: payload });
  assert.equal(field.value, payload.text);
  assert.deepEqual(dispatched, ['input']);
  assert.equal(field.selectionStart, payload.text.length);
  field.readOnly = true;
  listeners.message({ source: parent, data: payload });
  assert.equal(messages.at(-1).type, 'error');
});

test('upstream writeText resolves only after host acknowledgement and propagates failure', async () => {
  const messages = [],
    listeners = {};
  const navigator = { clipboard: {} };
  const parent = { postMessage: (message) => messages.push(message) };
  vm.runInNewContext(
    fs
      .readFileSync('media/clipboard-frame.js', 'utf8')
      .replace('__BRIDGE_TOKEN__', '"copy-token"')
      .replace('__BRIDGE_LANGUAGE__', '"ja"'),
    {
      navigator,
      parent,
      setTimeout,
      clearTimeout,
      window: {
        addEventListener: (name, callback) => {
          listeners[name] = callback;
        },
      },
      document: { addEventListener() {} },
    },
  );
  let completed = false;
  const first = navigator.clipboard.writeText('android:id/content').then(() => {
    completed = true;
  });
  assert.equal(messages[0].text, 'android:id/content');
  await Promise.resolve();
  assert.equal(completed, false);
  const ack = { bridge: 'copy-token', type: 'copyResult', id: messages[0].id };
  listeners.message({ source: {}, data: ack });
  await Promise.resolve();
  assert.equal(completed, false);
  listeners.message({ source: parent, data: ack });
  await first;
  assert.equal(completed, true);
  const failed = navigator.clipboard.writeText('次の属性');
  const rejected = assert.rejects(failed, /コピーできません/);
  listeners.message({
    source: parent,
    data: { ...ack, id: messages[1].id, error: 'コピーできません' },
  });
  await rejected;
});
