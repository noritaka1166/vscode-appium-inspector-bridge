const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LauncherController } = require('../out/launcher-controller');

test('launcher serializes duplicate operations but permits independent ones', async () => {
  const events = [];
  const pending = [];
  const controller = new LauncherController(
    (message) => events.push(message),
    { appendLine: () => {} },
    () => false,
    async (message) => {
      await new Promise((resolve) =>
        pending.push({ type: message.type, resolve }),
      );
    },
    (message) => `Loading ${message.type}`,
  );
  const first = controller.handle({ type: 'listDevices' });
  const duplicate = controller.handle({ type: 'listDevices' });
  const separate = controller.handle({
    type: 'listSessions',
    serverUrl: 'http://127.0.0.1:4723',
  });
  assert.equal(pending.length, 2);
  assert.equal(controller.isBusy, true);
  pending.splice(0).forEach(({ resolve }) => {
    resolve();
  });
  await Promise.all([first, duplicate, separate]);
  assert.equal(controller.isBusy, false);
  assert.equal(events.filter((event) => event.active === true).length, 3);
  assert.equal(events.filter((event) => event.active === false).length, 1);
});
