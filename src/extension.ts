import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { inspectorUrl, officialHtml, launcherHtml } from './official';
import { startInspectorProxy } from './inspector-proxy';
import { readFile } from 'node:fs/promises';

let output: vscode.OutputChannel;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
const views = new Set<vscode.Webview>();
let busy = false;
let officialPanel: vscode.WebviewPanel | undefined;
let officialServer = 'http://127.0.0.1:4723';
let extensionUri: vscode.Uri;
let clipboardRelay: Awaited<ReturnType<typeof startInspectorProxy>> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  context.subscriptions.push(vscode.commands.registerCommand('appiumInspector.paste', async () => {
    if (officialPanel?.active && clipboardRelay) {
      await officialPanel.webview.postMessage({ bridge: clipboardRelay.token, type: 'pasteText', text: await vscode.env.clipboard.readText() });
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('appiumInspector.copy', async () => {
    if (officialPanel?.active && clipboardRelay) await officialPanel.webview.postMessage({ bridge: clipboardRelay.token, type: 'copy' });
  }));
  output = vscode.window.createOutputChannel('Appium Inspector Lite');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'appiumInspector.sidebar',
    new InspectorSidebarProvider(context.extensionUri),
    { webviewOptions: { retainContextWhenHidden: true } }
  ));
  context.subscriptions.push(vscode.commands.registerCommand('appiumInspector.open', openInspector));
  context.subscriptions.push(vscode.commands.registerCommand('appiumInspector.workspace', () => handleMessage({ type: 'openOfficial', serverUrl: officialServer })));
}

class InspectorSidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;
    views.add(webview);
    webview.options = { enableScripts: true };
    webview.html = launcherHtml(
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'launcher.js')).toString(),
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'launcher.css')).toString(), webview.cspSource);
    webview.onDidReceiveMessage((message: WebviewMessage) => handleMessage(message));
    webviewView.onDidDispose(() => {
      views.delete(webview);
    });
  }
}

async function openInspector(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.appiumInspector');
}

type WebviewMessage =
  | { type: 'startOfficial' | 'openOfficial'; serverUrl: string }
  | { type: 'installOfficial' | 'ready' | 'stopServer' | 'showOutput' };

async function handleMessage(message: WebviewMessage): Promise<void> {
  if (message.type === 'ready') {
    postServerState();
    post({ type: 'loading', active: busy });
    return;
  }
  if (busy) { return; }
  busy = true;
  const loadingLabel = getLoadingLabel(message) ?? '処理しています…';
  if (loadingLabel) {
    post({ type: 'loading', active: true, label: loadingLabel });
  }
  try {
    switch (message.type) {
      case 'installOfficial':
        if (serverProcess) { throw new Error('プラグインのインストール前に Server を停止してください。'); }
        await installOfficialPlugin();
        post({ type: 'notice', level: 'success', text: '公式プラグインをインストールしました。「起動して公式 Inspector を開く」を押してください。' });
        break;
      case 'startOfficial':
        inspectorUrl(message.serverUrl);
        if (!(await isServerReachable(normaliseServerUrl(message.serverUrl)))) {
          await startServer(message.serverUrl);
        }
        await openOfficial(message.serverUrl);
        break;
      case 'openOfficial':
        await openOfficial(message.serverUrl);
        break;
      case 'stopServer':
        await stopServer();
        break;
      case 'showOutput':
        output.show(true);
        break;
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    output.appendLine(text);
    post({ type: 'notice', level: 'error', text });
  } finally {
    busy = false;
    if (loadingLabel) {
      post({ type: 'loading', active: false });
    }
  }
}

function getLoadingLabel(message: WebviewMessage): string | undefined {
  switch (message.type) {
    case 'installOfficial': return '公式 Inspector プラグインをインストールしています…';
    case 'startOfficial': return '公式 Inspector を起動しています…';
    case 'openOfficial': return '公式 Inspector の接続を確認しています…';
    case 'stopServer': return 'Appium Server を停止しています…';
    default: return undefined;
  }
}

async function openOfficial(rawUrl: string): Promise<void> {
  const url = inspectorUrl(rawUrl);
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' }); }
  catch { throw new Error('Appium に接続できません。「起動して公式 Inspector を開く」を押すか、Server URL を確認してください。'); }
  if (!response.ok || !(await response.text()).includes('Appium Inspector')) {
    throw new Error('公式 Inspector が有効になっていません。初回セットアップでプラグインを導入し、Server を --use-plugins=inspector 付きで再起動してください。外部で起動した Server はそのターミナルで停止してください。');
  }
  officialServer = rawUrl;
  if (officialPanel) {
    officialPanel.reveal();
    // Preserve the live iframe/session when the same server is opened again.
    if (officialPanel.title === `Appium Inspector · ${url.host}`) { return; }
    throw new Error('別サーバーを開く場合は、現在の公式 Inspector タブを閉じてから開いてください。');
  }
  const adapter = await readFile(vscode.Uri.joinPath(extensionUri, 'media', 'clipboard-frame.js').fsPath, 'utf8');
  const relay = await startInspectorProxy(url, adapter);
  clipboardRelay = relay;
  const panel = vscode.window.createWebviewPanel('appiumInspector.official', `Appium Inspector · ${url.host}`, vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  officialPanel = panel;
  panel.webview.onDidReceiveMessage(async message => {
    if (!panel.active || message?.bridge !== relay.token) return;
    try {
      if (message.type === 'paste') await panel.webview.postMessage({ bridge: relay.token, type: 'pasteText', text: await vscode.env.clipboard.readText() });
      if (message.type === 'copyText' && typeof message.text === 'string') {
        await vscode.env.clipboard.writeText(message.text);
        await panel.webview.postMessage({ bridge: relay.token, type: 'copyResult', id: message.id });
      }
      if (message.type === 'error' && typeof message.text === 'string') void vscode.window.showWarningMessage(message.text);
    } catch {
      if (message.type === 'copyText') await panel.webview.postMessage({ bridge: relay.token, type: 'copyResult', id: message.id, error: 'クリップボードへコピーできませんでした。' });
      void vscode.window.showErrorMessage('クリップボードを操作できませんでした。');
    }
  });
  panel.webview.html = officialHtml(relay.url, relay.token);
  panel.onDidDispose(() => { relay.close(); clipboardRelay = undefined; officialPanel = undefined; });
}

async function installOfficialPlugin(): Promise<void> {
  if (!vscode.workspace.isTrusted) { throw new Error('このワークスペースを信頼してから実行してください。'); }
  output.show(true);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('appium', ['plugin', 'install', 'inspector'], { shell: false });
    child.stdout.on('data', (data: Buffer) => output.append(data.toString()));
    child.stderr.on('data', (data: Buffer) => output.append(data.toString()));
    child.once('error', (error) => reject(new Error(`Appium を実行できません: ${error.message}`)));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('プラグイン導入に失敗しました。ログを確認してください。導入済みの場合はそのまま起動できます。')));
  });
}

async function startServer(rawServerUrl: string): Promise<void> {
  if (serverProcess) {
    throw new Error('この拡張機能から起動した Appium Server はすでに動作しています。');
  }

  const serverUrl = normaliseServerUrl(rawServerUrl);
  const url = new URL(serverUrl);
  const permittedHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (!permittedHosts.has(url.hostname)) {
    throw new Error('拡張機能から起動できるのはローカル Appium Server のみです。localhost または 127.0.0.1 を指定してください。');
  }
  if (await isServerReachable(serverUrl)) {
    throw new Error('指定した URL ではすでに Appium Server が応答しています。既存のサーバーへ接続してください。');
  }

  const port = url.port || '4723';
  const address = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, '');
  const basePath = url.pathname.replace(/\/$/, '');
  const args = ['--address', address, '--port', port];
  args.push('--use-plugins=inspector');
  if (basePath && basePath !== '/') {
    args.push('--base-path', basePath);
  }

  output.appendLine(`Appium Server を起動します: appium ${args.join(' ')}`);
  const child = spawn('appium', args, { shell: false });
  serverProcess = child;
  child.stdout.on('data', (data: Buffer) => output.append(data.toString()));
  child.stderr.on('data', (data: Buffer) => output.append(data.toString()));
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (serverProcess === child) {
      serverProcess = undefined;
      postServerState();
    }
    const message = error.code === 'ENOENT'
      ? 'appium コマンドが見つかりません。`npm install -g appium` を実行してから、VS Code を再起動してください。'
      : `Appium Server を起動できませんでした: ${error.message}`;
    output.appendLine(message);
    post({ type: 'notice', level: 'error', text: message });
  });
  child.on('close', (code, signal) => {
    if (serverProcess === child) {
      serverProcess = undefined;
      postServerState();
      const detail = signal ? `シグナル ${signal}` : `終了コード ${code ?? '不明'}`;
      post({ type: 'notice', level: code === 0 ? 'success' : 'error', text: `Appium Server が停止しました（${detail}）。` });
    }
  });

  await waitForServer(serverUrl, child);
  postServerState();
  post({ type: 'notice', level: 'success', text: `Appium Server を起動しました: ${serverUrl}` });
}

async function stopServer(): Promise<void> {
  if (!serverProcess) {
    throw new Error('この拡張機能から起動した Appium Server はありません。');
  }
  const child = serverProcess;
  output.appendLine('Appium Server を停止します。');
  const closed = waitForProcessExit(child);
  if (!child.kill('SIGTERM')) {
    throw new Error('Appium Server の停止要求を送信できませんでした。');
  }
  await closed;
  post({ type: 'notice', level: 'success', text: 'Appium Server を停止しました。' });
}

function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Appium Server の停止がタイムアウトしました。出力パネルのログを確認してください。'));
    }, 10_000);
    const onClose = (): void => { cleanup(); resolve(); };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('close', onClose);
    };
    child.once('close', onClose);
  });
}

async function isServerReachable(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/status`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(serverUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const timeoutAt = Date.now() + 15_000;
  while (Date.now() < timeoutAt) {
    if (serverProcess !== child || child.exitCode !== null) {
      throw new Error('Appium Server が起動直後に停止しました。出力パネルの Appium Inspector Lite ログを確認してください。');
    }
    if (await isServerReachable(serverUrl)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Appium Server の起動がタイムアウトしました。出力パネルの Appium Inspector Lite ログを確認してください。');
}

function normaliseServerUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Appium Server URL は http:// または https:// で始めてください。');
  }
  return url;
}

function post(message: unknown): void {
  for (const view of views) { void view.postMessage(message); }
}

function postServerState(): void {
  post({ type: 'server', running: Boolean(serverProcess) });
}

export function deactivate(): void {
  clipboardRelay?.close();
  serverProcess?.kill('SIGTERM');
}
