import { inspectorUrl } from './official';

export function serverKey(raw: string): string {
  inspectorUrl(raw);
  const url = new URL(raw);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  let pathname = url.pathname;
  while (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return url.origin + pathname;
}
export interface ConnectionState {
  url: string;
  status: 'checking' | 'connected' | 'disconnected';
  owner: 'managed' | 'external' | 'unknown';
}

export async function probeServer(
  url: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await request(`${url}/status`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
        : AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { value?: { ready?: unknown } };
    // ready=false still means that the server is reachable (not session-ready).
    return typeof body?.value?.ready === 'boolean';
  } catch {
    return false;
  }
}

export class ConnectionMonitor {
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private generation = 0;
  private state?: ConnectionState;
  constructor(
    private readonly publish: (state: ConnectionState) => void,
    private readonly managed: (url: string) => boolean,
    private readonly probe: (
      url: string,
      signal?: AbortSignal,
    ) => Promise<boolean> = (url, signal) => probeServer(url, fetch, signal),
    private readonly interval = 5000,
  ) {}

  watch(raw: string): void {
    this.dispose();
    const url = serverKey(raw);
    this.state = {
      url,
      status: 'checking',
      owner: this.managed(url) ? 'managed' : 'unknown',
    };
    this.publish({ ...this.state });
    void this.poll(this.generation);
  }
  private async poll(generation: number): Promise<void> {
    if (!this.state) return;
    const controller = new AbortController();
    this.controller = controller;
    const connected = await this.probe(this.state.url, controller.signal).catch(
      () => false,
    );
    if (generation !== this.generation) return;
    this.controller = undefined;
    let owner = this.state.owner;
    if (this.managed(this.state.url)) owner = 'managed';
    else if (connected) owner = 'external';
    this.state = {
      ...this.state,
      status: connected ? 'connected' : 'disconnected',
      owner,
    };
    this.publish({ ...this.state });
    this.timer = setTimeout(() => void this.poll(generation), this.interval);
    // Extension hosts run on Node.js. Do not keep VS Code or the test process alive
    // solely for a background health check.
    const timer = this.timer;
    timer.unref?.();
  }
  dispose(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
