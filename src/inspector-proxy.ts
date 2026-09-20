import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';

// A loopback-only relay injects the clipboard adapter without changing installed plugin files.
export async function startInspectorProxy(
  upstream: URL,
  adapter: string,
  bootstrap?: (token: string) => string,
  unavailableMessage = 'Could not connect to Appium Server.',
): Promise<{ url: URL; token: string; close(): void }> {
  const token = randomUUID();
  const server = createServer((req, res) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      res.writeHead(503).end();
      return;
    }
    const host = `127.0.0.1:${address.port}`;
    if (
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)
    ) {
      res.writeHead(403).end();
      return;
    }
    const target = new URL(req.url || '/', `http://${host}`);
    if (target.origin !== `http://${host}`) {
      res.writeHead(403).end();
      return;
    }
    const headers = { ...req.headers, host: upstream.host };
    delete headers.origin;
    delete headers['accept-encoding'];
    const forward = request(
      new URL(target.pathname + target.search, upstream.origin),
      { method: req.method, headers },
      (incoming) => {
        const responseHeaders = { ...incoming.headers };
        delete responseHeaders['access-control-allow-origin'];
        const html =
          target.pathname === '/inspector' && incoming.statusCode === 200;
        if (html) {
          delete responseHeaders['content-length'];
          delete responseHeaders.etag;
          responseHeaders['cache-control'] = 'no-store';
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () => {
            const injection = `<script>${adapter.replace('__BRIDGE_TOKEN__', JSON.stringify(token))}</script>`;
            res.writeHead(200, responseHeaders);
            let html = Buffer.concat(chunks).toString('utf8');
            if (bootstrap)
              html = html.replace(
                /<head\b[^>]*>/i,
                (head) => `${head}<script>${bootstrap(token)}</script>`,
              );
            res.end(html.replace('</body>', `${injection}</body>`));
          });
        } else {
          res.writeHead(incoming.statusCode || 502, responseHeaders);
          incoming.pipe(res);
        }
      },
    );
    forward.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(unavailableMessage);
        return;
      }
      res.destroy();
    });
    forward.setTimeout(180000, () => forward.destroy());
    req.on('aborted', () => forward.destroy());
    req.pipe(forward);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Inspector relay failed');
  return {
    url: new URL(`http://127.0.0.1:${address.port}/inspector`),
    token,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
