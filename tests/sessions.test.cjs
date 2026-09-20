const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  listRunningSessions,
  SessionDiscoveryError,
} = require('../out/sessions');

test('lists and summarizes active Appium sessions without exposing all capabilities', async () => {
  const report = await listRunningSessions(
    'http://localhost:4723/wd/hub',
    async (url) => {
      assert.equal(url, 'http://127.0.0.1:4723/wd/hub/appium/sessions');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              id: 'older',
              created: 1,
              capabilities: {
                platformName: 'Android',
                'appium:deviceName': 'Pixel',
                password: 'must-not-be-exposed',
              },
            },
            {
              id: 'newer',
              created: 2,
              capabilities: { platform: 'iOS', automationName: 'XCUITest' },
            },
            { capabilities: {} },
          ],
        }),
      };
    },
  );
  assert.deepEqual(report, {
    serverUrl: 'http://127.0.0.1:4723/wd/hub',
    sessions: [
      {
        id: 'newer',
        created: 2,
        platformName: 'iOS',
        automationName: 'XCUITest',
      },
      { id: 'older', created: 1, platformName: 'Android', deviceName: 'Pixel' },
    ],
  });
});

test('explains when Appium 3 session discovery is disabled', async () => {
  await assert.rejects(
    listRunningSessions('http://127.0.0.1:4723', async () => ({
      ok: false,
      status: 403,
    })),
    (error) =>
      error instanceof SessionDiscoveryError &&
      error.message.includes('--allow-insecure=*:session_discovery'),
  );
});
