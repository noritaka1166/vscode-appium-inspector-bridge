const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkEnvironment } = require('../out/environment');

function runner({
  version = '3.6.0',
  plugins = { inspector: { installed: true, version: '2026.7.1' } },
  drivers = { uiautomator2: { installed: true, version: '6.0.0' } },
} = {}) {
  return async (args) =>
    args[0] === '--version'
      ? version
      : JSON.stringify(args[0] === 'plugin' ? plugins : drivers);
}
test('Appium, Inspector and installed drivers are reported', async () => {
  const report = await checkEnvironment(runner(), 'darwin');
  assert.equal(report.canStart, true);
  assert.deepEqual(
    report.items.map((x) => x.status),
    ['ok', 'ok', 'ok'],
  );
  assert.match(report.items[2].detail, /uiautomator2 6.0.0/);
});
test('missing Appium stops checks and provides PATH and installation guidance', async () => {
  let calls = 0;
  const report = await checkEnvironment(async () => {
    calls++;
    throw Error('appium コマンドが見つかりません。');
  }, 'darwin');
  assert.equal(calls, 1);
  assert.equal(report.canStart, false);
  assert.match(report.items[0].action, /PATH/);
  assert.deepEqual(
    report.items.map((x) => x.status),
    ['error', 'skipped', 'skipped'],
  );
});
test('missing Inspector blocks launch; missing drivers warn but permit Inspector', async () => {
  const missingPlugin = await checkEnvironment(
    runner({ plugins: {} }),
    'darwin',
  );
  assert.equal(missingPlugin.canStart, false);
  assert.match(
    missingPlugin.items[1].action,
    /appium plugin install inspector/,
  );
  const noDrivers = await checkEnvironment(runner({ drivers: {} }), 'darwin');
  assert.equal(noDrivers.canStart, true);
  assert.equal(noDrivers.items[2].status, 'warning');
  assert.match(noDrivers.items[2].action, /uiautomator2/);
});
test('old or invalid version is rejected', async () => {
  for (const version of ['2.19.0', 'not a version']) {
    assert.equal(
      (await checkEnvironment(runner({ version }), 'darwin')).canStart,
      false,
    );
  }
});
test('malformed JSON and execution failures remain unknown, not missing', async () => {
  for (const output of ['bad json', '[]', '{"inspector":{}}']) {
    const report = await checkEnvironment(
      async (args) => (args[0] === '--version' ? '3.6.0' : output),
      'darwin',
    );
    assert.equal(report.canStart, false);
    assert.match(report.items[1].detail, /未導入とは限りません/);
  }
  const report = await checkEnvironment(async (args) => {
    if (args[0] === '--version') return '3.6.0';
    throw Error('permission denied');
  }, 'darwin');
  assert.match(report.items[2].action, /APPIUM_HOME/);
});
test('Windows provides external-server alternative without spawning', async () => {
  const report = await checkEnvironment(async () => {
    throw Error('must not run');
  }, 'win32');
  assert.equal(report.canStart, false);
  assert.match(report.items[0].action, /起動済み/);
});
