const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startInspectorProxy } = require('../out/inspector-proxy');

test('relay injects only Inspector HTML, forwards session bodies, rejects other origins', async () => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ path: req.url, body });
    res.setHeader('Content-Type', req.url === '/inspector' ? 'text/html' : 'application/json');
    res.end(req.url === '/inspector' ? '<html><head><script src="app.js"></script></head><body>Appium Inspector</body></html>' : JSON.stringify({ value: 'ok' }));
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  let relay;
  try {
    let theme = 'dark';
    relay = await startInspectorProxy(new URL(`http://127.0.0.1:${upstream.address().port}/inspector`), 'const token = __BRIDGE_TOKEN__;', () => `const theme = '${theme}';`);
    const html = await (await fetch(relay.url)).text();
    assert.ok(html.includes(relay.token));
    assert.ok(html.indexOf("const theme = 'dark'") < html.indexOf('src="app.js"'));
    theme = 'light';
    assert.match(await (await fetch(relay.url)).text(), /const theme = 'light'/);
    const body = '{"capabilities":{}}';
    const response = await fetch(new URL('/session', relay.url), { method: 'POST', headers: { origin: relay.url.origin }, body });
    assert.equal(response.status, 200);
    assert.equal(seen.at(-1).body, body);
    assert.equal(seen.at(-1).path, '/session');
    const blocked = await fetch(relay.url, { headers: { origin: 'http://example.org' } });
    assert.equal(blocked.status, 403);
  } finally {
    relay?.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});
