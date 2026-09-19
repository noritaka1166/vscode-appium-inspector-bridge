import { setTimeout, clearTimeout } from 'node:timers';
import { inspectorUrl } from './official';

export function serverKey(raw: string): string {
  inspectorUrl(raw);
  const url = new URL(raw);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin + url.pathname.replace(/\/+$/, '');
}
export interface ConnectionState {
  url: string;
  status: 'checking' | 'connected' | 'disconnected';
  owner: 'managed' | 'external' | 'unknown';
}

export async function probeServer(url: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(`${url}/status`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!response.ok) return false;
    const body = await response.json() as { value?: { ready?: unknown } };
    // ready=false still means that the server is reachable (not session-ready).
    return typeof body?.value?.ready === 'boolean';
  } catch { return false; }
}

export class ConnectionMonitor {
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private state?: ConnectionState;
  constructor(private readonly publish: (state: ConnectionState) => void,
    private readonly managed: (url: string) => boolean,
    private readonly probe = probeServer, private readonly interval = 5000) {}

  watch(raw: string): void {
    this.dispose();
    const url = serverKey(raw);
    this.state = { url, status: 'checking', owner: this.managed(url) ? 'managed' : 'unknown' };
    this.publish({ ...this.state });
    void this.poll(this.generation);
  }
  private async poll(generation: number): Promise<void> {
    if (!this.state) return;
    const connected = await this.probe(this.state.url).catch(() => false);
    if (generation !== this.generation) return;
    const owner = this.managed(this.state.url) ? 'managed' : connected ? 'external' : this.state.owner;
    this.state = { ...this.state, status: connected ? 'connected' : 'disconnected', owner };
    this.publish({ ...this.state });
    this.timer = setTimeout(() => void this.poll(generation), this.interval);
    this.timer.unref();
  }
  dispose(): void { this.generation++; if (this.timer) clearTimeout(this.timer); }
}
