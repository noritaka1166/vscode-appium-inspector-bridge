import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { serverKey } from './connection';
import { resolveAppiumExecutable } from './environment';
import { t } from './i18n';

type Post = (message: unknown) => void;
type Output = { append(data: string): void; appendLine(data: string): void };
type ConfirmStop = (
  title: string,
  detail: string,
  accept: string,
) => Promise<boolean>;

export function normalizeServerUrl(value: string): string {
  let url = value.trim();
  while (url.endsWith('/')) url = url.slice(0, -1);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      t(
        'Appium Server URL は http:// または https:// で始めてください。',
        'Appium Server URL must start with http:// or https://.',
      ),
    );
  }
  return url;
}

/** Owns only the Appium process started by this extension. */
export class AppiumServerController {
  private process: ChildProcessWithoutNullStreams | undefined;
  private managedUrl: string | undefined;

  constructor(
    private readonly output: Output,
    private readonly post: Post,
    private readonly executable = resolveAppiumExecutable,
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly confirmStop: ConfirmStop = async () => false,
    private readonly request: typeof fetch = fetch,
  ) {}

  get isRunning(): boolean {
    return Boolean(this.process);
  }

  get url(): string | undefined {
    return this.managedUrl;
  }

  manages(url: string): boolean {
    return Boolean(this.process) && this.managedUrl === url;
  }

  async isReachable(serverUrl: string): Promise<boolean> {
    try {
      const response = await this.request(`${serverUrl}/status`, {
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async start(rawServerUrl: string): Promise<void> {
    if (this.process) {
      throw new Error(
        t(
          'この拡張機能から起動した Appium Server はすでに動作しています。',
          'An Appium Server started by this extension is already running.',
        ),
      );
    }
    const serverUrl = normalizeServerUrl(rawServerUrl);
    const url = new URL(serverUrl);
    const permittedHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    if (!permittedHosts.has(url.hostname)) {
      throw new Error(
        t(
          '拡張機能から起動できるのはローカル Appium Server のみです。localhost または 127.0.0.1 を指定してください。',
          'This extension can start only a local Appium Server. Use localhost or 127.0.0.1.',
        ),
      );
    }
    if (await this.isReachable(serverUrl)) {
      throw new Error(
        t(
          '指定した URL ではすでに Appium Server が応答しています。既存のサーバーへ接続してください。',
          'An Appium Server is already responding at this URL. Connect to the existing server instead.',
        ),
      );
    }

    const port = url.port || '4723';
    const address =
      url.hostname === 'localhost'
        ? '127.0.0.1'
        : url.hostname.replace(/^\[|\]$/g, '');
    const basePath = url.pathname.replace(/\/$/, '');
    const args = [
      '--address',
      address,
      '--port',
      port,
      '--use-plugins=inspector',
      ...(basePath && basePath !== '/' ? ['--base-path', basePath] : []),
    ];
    this.output.appendLine(
      t(
        `Appium Server を起動します: appium ${args.join(' ')}`,
        `Starting Appium Server: appium ${args.join(' ')}`,
      ),
    );
    const child = this.spawnProcess(await this.appiumExecutable(), args, {
      shell: false,
    });
    this.process = child;
    this.managedUrl = serverKey(serverUrl);
    child.stdout.on('data', (data) => this.output.append(data.toString()));
    child.stderr.on('data', (data) => this.output.append(data.toString()));
    child.on('error', (error: Error & { code?: string }) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.postState();
      const message =
        error.code === 'ENOENT'
          ? t(
              'appium コマンドが見つかりません。`npm install -g appium` を実行してから、VS Code を再起動してください。',
              'appium command was not found. Run `npm install -g appium`, then restart VS Code.',
            )
          : t(
              `Appium Server を起動できませんでした: ${error.message}`,
              `Could not start Appium Server: ${error.message}`,
            );
      this.output.appendLine(message);
      this.post({ type: 'notice', level: 'error', text: message });
    });
    child.on('close', (code, signal) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.postState();
      const detail = signal
        ? t(`シグナル ${signal}`, `signal ${signal}`)
        : t(`終了コード ${code ?? '不明'}`, `exit code ${code ?? 'unknown'}`);
      this.post({
        type: 'notice',
        level: code === 0 ? 'success' : 'error',
        text: t(
          `Appium Server が停止しました（${detail}）。`,
          `Appium Server stopped (${detail}).`,
        ),
      });
    });

    await this.waitForServer(serverUrl, child);
    this.postState();
    this.post({
      type: 'notice',
      level: 'success',
      text: t(
        `Appium Server を起動しました: ${serverUrl}`,
        `Appium Server started: ${serverUrl}`,
      ),
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      throw new Error(
        t(
          'この拡張機能から起動した Appium Server はありません。',
          'No Appium Server started by this extension is running.',
        ),
      );
    }
    const child = this.process;
    const stop = t('停止する', 'Stop');
    const confirmed = await this.confirmStop(
      t('Appium Server を停止しますか？', 'Stop Appium Server?'),
      t(
        'このサーバー上で実行中のすべてのセッションが利用できなくなります。他のテストにも影響する可能性があります。必要な設定を保存し、公式UIでセッションを終了してから続行してください。',
        'All sessions on this server will become unavailable and other tests may be affected. Save settings and end sessions in the official UI before continuing.',
      ),
      stop,
    );
    if (!confirmed || this.process !== child) return;
    this.output.appendLine(
      t('Appium Server を停止します。', 'Stopping Appium Server.'),
    );
    const closed = this.waitForProcessExit(child);
    if (!child.kill('SIGTERM')) {
      throw new Error(
        t(
          'Appium Server の停止要求を送信できませんでした。',
          'Could not send the Appium Server stop request.',
        ),
      );
    }
    await closed;
    this.post({
      type: 'notice',
      level: 'success',
      text: t('Appium Server を停止しました。', 'Appium Server stopped.'),
    });
  }

  dispose(): void {
    this.process?.kill('SIGTERM');
  }

  private postState(): void {
    this.post({
      type: 'server',
      running: this.isRunning,
      url: this.managedUrl,
    });
  }

  private appiumExecutable(): Promise<string> {
    return this.executable().catch(() => {
      throw new Error(
        t(
          'appium コマンドが見つかりません。`npm install -g appium` を実行してから、VS Code を再起動してください。',
          'appium command was not found. Run `npm install -g appium`, then restart VS Code.',
        ),
      );
    });
  }

  private waitForProcessExit(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            t(
              'Appium Server の停止がタイムアウトしました。出力パネルのログを確認してください。',
              'Stopping Appium Server timed out. Check Logs.',
            ),
          ),
        );
      }, 10_000);
      const onClose = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.off('close', onClose);
      };
      child.once('close', onClose);
    });
  }

  private async waitForServer(
    serverUrl: string,
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    const timeoutAt = Date.now() + 15_000;
    while (Date.now() < timeoutAt) {
      if (this.process !== child || child.exitCode !== null) {
        throw new Error(
          t(
            'Appium Server が起動直後に停止しました。出力パネルの Appium Inspector Bridge ログを確認してください。',
            'Appium Server stopped immediately after starting. Check the Appium Inspector Bridge output log.',
          ),
        );
      }
      if (await this.isReachable(serverUrl)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      t(
        'Appium Server の起動がタイムアウトしました。出力パネルのログを確認してください。',
        'Starting Appium Server timed out. Check Logs.',
      ),
    );
  }
}
