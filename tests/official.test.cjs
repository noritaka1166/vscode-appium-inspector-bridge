const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectorUrl, officialHtml, launcherHtml } = require('../out/official');

test('plugin endpoint ignores Appium base path', () => {
  assert.equal(inspectorUrl('http://127.0.0.1:4723/wd/hub').href, 'http://127.0.0.1:4723/inspector');
  assert.equal(inspectorUrl('http://[::1]:4723/').href, 'http://[::1]:4723/inspector');
});
test('embedded UI rejects credentials, remote hosts and unsafe URL schemes', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'http://example.org', 'http://user:pass@localhost:4723', 'http://localhost:4723/?foo=bar', 'http://localhost:4723/#fragment']) {
    assert.throws(() => inspectorUrl(url));
  }
});
test('official iframe isolates origin and gates clipboard messages', () => {
  const html = officialHtml(inspectorUrl('http://localhost:4723'));
  assert.match(html, /frame-src http:\/\/localhost:4723;/);
  assert.match(html, /src="http:\/\/localhost:4723\/inspector"/);
  assert.match(html, /allow-downloads/);
  assert.doesNotMatch(html, /allow-top-navigation/);
  assert.match(html, /event.origin===origin/);
  assert.match(html, /m.bridge!==token/);
  const launcher = launcherHtml('launcher.js', 'launcher.css', 'test:');
  assert.match(launcher, /初回セットアップ/);
  assert.match(launcher, /install/);
});
