const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAndroid,
  parseSimulators,
  listDevices,
  capabilitiesFor,
} = require('../out/devices');
const { setLanguage } = require('../out/i18n');

test('Android includes ready devices only and explains unavailable states', () => {
  const report = parseAndroid(
    'List of devices attached\nserial1 device product:p model:Pixel_9 device:p\nemulator-5554 device model:SDK\na unauthorized\nb offline\nc no permissions (user)\n',
  );
  assert.equal(report.devices.length, 2);
  assert.equal(report.devices[0].name, 'Pixel 9');
  assert.match(report.devices[1].state, /エミュレーター/);
  assert.equal(report.notes.length, 3);
  assert.match(report.notes[0], /USBデバッグ/);
  assert.throws(() => parseAndroid('not adb output'));
  assert.equal(parseAndroid('List of devices attached\n').devices.length, 0);
});
test('iOS includes available iOS runtimes, including shutdown devices, but not tvOS', () => {
  const report = parseSimulators(
    JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
          { name: 'iPhone', udid: 'abc', state: 'Booted', isAvailable: true },
          { name: 'iPad', udid: 'def', state: 'Shutdown', isAvailable: true },
          { name: 'old', udid: 'old', state: 'Shutdown', isAvailable: false },
        ],
        'com.apple.CoreSimulator.SimRuntime.tvOS-18-5': [{ isAvailable: true }],
      },
    }),
  );
  assert.equal(report.devices.length, 2);
  assert.match(report.devices[0].state, /18.5・起動中/);
  assert.match(report.devices[1].state, /停止中/);
  assert.throws(() => parseSimulators('{}'));
});
test('partial enumeration failures preserve working platforms and provide guidance', async () => {
  const calls = [];
  const report = await listDevices(async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'adb')
      return 'List of devices attached\nx device model:Pixel\n';
    throw Error('missing xcrun');
  }, 'darwin');
  assert.equal(report.devices.length, 1);
  assert.match(report.notes[0], /Xcode/);
  assert.deepEqual(calls[0], ['adb', ['devices', '-l']]);
  assert.deepEqual(calls[1], [
    'xcrun',
    ['simctl', 'list', 'devices', 'available', '--json'],
  ]);
  const linux = await listDevices(async (cmd) => {
    assert.equal(cmd, 'adb');
    throw Error('missing');
  }, 'linux');
  assert.equal(linux.notes.length, 2);
  assert.match(linux.notes[0], /ANDROID_HOME/);
});
test('capability templates select driver and safely encode device names and ids', () => {
  for (const platform of ['Android', 'iOS']) {
    const result = JSON.parse(
      capabilitiesFor({
        platform,
        udid: 'id"\\',
        name: '<name>"',
        state: '',
        id: 'id',
      }),
    );
    assert.equal(result.platformName, platform);
    assert.equal(
      result['appium:automationName'],
      platform === 'Android' ? 'UiAutomator2' : 'XCUITest',
    );
    assert.equal(result['appium:udid'], 'id"\\');
    assert.equal(result['appium:deviceName'], '<name>"');
    assert.equal(Object.keys(result).length, 4);
  }
});

test('English device messages use English separators', () => {
  setLanguage('en');
  try {
    const android = parseAndroid('List of devices attached\na unauthorized\n');
    assert.match(android.notes[0], /^a: unauthorized\. Allow USB debugging/);
    const ios = parseSimulators(
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
            { name: 'iPhone', udid: 'abc', state: 'Booted', isAvailable: true },
          ],
        },
      }),
    );
    assert.equal(ios.devices[0].state, '18.5 · Booted');
  } finally {
    setLanguage('ja');
  }
});
