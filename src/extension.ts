import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { inspectorUrl, officialHtml, launcherHtml } from './official';
import { startInspectorProxy } from './inspector-proxy';
import { readFile } from 'node:fs/promises';
import { settingKeys, validateSettings } from './settings';
import { checkEnvironment, EnvironmentReport } from './environment';
import { ConnectionMonitor, probeServer, serverKey } from './connection';
import { listDevices, capabilitiesFor, DeviceReport } from './devices';

let output: vscode.OutputChannel;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
const views = new Set<vscode.Webview>();
let busy = false;
let officialPanel: vscode.WebviewPanel | undefined;
let officialServer = 'http://127.0.0.1:4723';
let extensionUri: vscode.Uri;
let clipboardRelay: Awaited<ReturnType<typeof startInspectorProxy>> | undefined;
let secrets: vscode.SecretStorage;
let settingsWrites: Promise<void> = Promise.resolve();
let environmentReport: EnvironmentReport | undefined;
let connectionMonitor: ConnectionMonitor;
let managedServerUrl: string | undefined;
let deviceReport: DeviceReport | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  secrets = context.secrets;
  connectionMonitor = new ConnectionMonitor(state => post({ type: 'connection', ...state }),
    url => Boolean(serverProcess) && managedServerUrl === url, url => probeServer(url, fetch));
  output = vscode.window.createOutputChannel('Appium Inspector Lite');
  context.subscriptions.push(
    connectionMonitor,
    vscode.commands.registerCommand('appiumInspector.paste', async () => {
      if (officialPanel?.active && clipboardRelay) {
        await officialPanel.webview.postMessage({ bridge: clipboardRelay.token, type: 'pasteText', text: await vscode.env.clipboard.readText() });
      }
    }),
    vscode.commands.registerCommand('appiumInspector.copy', async () => {
      if (officialPanel?.active && clipboardRelay) await officialPanel.webview.postMessage({ bridge: clipboardRelay.token, type: 'copy' });
    }),
    output,
    vscode.window.registerWebviewViewProvider(
      'appiumInspector.sidebar',
      new InspectorSidebarProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('appiumInspector.open', openInspector),
    vscode.commands.registerCommand('appiumInspector.workspace', () => handleMessage({ type: 'openOfficial', serverUrl: officialServer }))
  );
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
      if (!views.size) connectionMonitor.dispose();
    });
  }
}

async function openInspector(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.appiumInspector');
}

type WebviewMessage =
  | { type: 'deviceCapabilities' | 'copyCapabilities'; deviceId: string }
  | { type: 'listDevices' }
  | { type: 'startOfficial' | 'openOfficial' | 'watchServer' | 'reconnect'; serverUrl: string }
  | { type: 'installOfficial' | 'checkEnvironment' | 'ready' | 'stopServer' | 'showOutput' };

interface InspectorMessage {
  bridge?: unknown;
  type?: unknown;
  values?: unknown;
  text?: unknown;
  id?: unknown;
}

async function handleMessage(message: WebviewMessage): Promise<void> {
  if (handlePassiveMessage(message)) return;
  if (busy) { return; }
  busy = true;
  const loadingLabel = getLoadingLabel(message);
  if (loadingLabel) post({ type: 'loading', active: true, label: loadingLabel });
  try {
    await dispatchMessage(message);
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

function handlePassiveMessage(message: WebviewMessage): boolean {
  if (message.type === 'watchServer') {
    try { connectionMonitor.watch(message.serverUrl); }
    catch { post({ type: 'connection', url: message.serverUrl, status: 'invalid', owner: 'unknown' }); }
    return true;
  }
  if (message.type !== 'ready') return false;
  postServerState();
  if (environmentReport) post({ type: 'environment', report: environmentReport });
  if (deviceReport) post({ type: 'devices', report: deviceReport });
  post({ type: 'loading', active: busy });
  return true;
}

async function dispatchMessage(message: WebviewMessage): Promise<void> {
  switch (message.type) {
    case 'listDevices': return loadDevices();
    case 'deviceCapabilities':
    case 'copyCapabilities': return copyCapabilities(message);
    case 'reconnect': return reconnect(message.serverUrl);
    case 'checkEnvironment': return inspectEnvironment().then(() => undefined);
    case 'installOfficial': return installOfficial();
    case 'startOfficial': return startOfficial(message.serverUrl);
    case 'openOfficial': connectionMonitor.watch(message.serverUrl); return openOfficial(message.serverUrl);
    case 'stopServer': return stopServer();
    case 'showOutput': output.show(true); return;
  }
}

async function loadDevices(): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error('端末一覧の取得には adb / xcrun を実行します。ワークスペースを信頼してから実行してください。');
  deviceReport = await listDevices();
  post({ type: 'devices', report: deviceReport });
}

async function copyCapabilities(message: Extract<WebviewMessage, { type: 'deviceCapabilities' | 'copyCapabilities' }>): Promise<void> {
  const device = deviceReport?.devices.find(item => item.id === message.deviceId);
  if (!device) throw new Error('端末一覧を更新し、端末を選択してください。');
  const text = capabilitiesFor(device);
  post({ type: 'capabilitiesTemplate', text });
  if (message.type === 'copyCapabilities') {
    await vscode.env.clipboard.writeText(text);
    post({ type: 'notice', level: 'success', text: 'Capabilities をコピーしました。公式InspectorのJSON編集欄に貼り付けてください。' });
  }
}

async function reconnect(serverUrl: string): Promise<void> {
  const url = serverKey(serverUrl);
  connectionMonitor.watch(url);
  if (!(await probeServer(url, fetch))) throw new Error('Appium Server に接続できません。拡張管理サーバーは「起動して公式 Inspector を開く」、外部サーバーは起動元で起動後に再接続してください。');
  await openOfficial(serverUrl);
  post({ type: 'notice', level: 'success', text: 'サーバーへの接続を確認しました。セッションは自動復元しません。画面の再読込が必要な場合はInspector上部の「再読込」を使用してください。' });
}

async function installOfficial(): Promise<void> {
  if (serverProcess) throw new Error('プラグインのインストール前に Server を停止してください。');
  await installOfficialPlugin();
  await inspectEnvironment();
  post({ type: 'notice', level: 'success', text: '公式プラグインをインストールしました。「起動して公式 Inspector を開く」を押してください。' });
}

async function startOfficial(serverUrl: string): Promise<void> {
  inspectorUrl(serverUrl);
  connectionMonitor.watch(serverUrl);
  if (await isServerReachable(normaliseServerUrl(serverUrl))) return openOfficial(serverUrl);
  const report = await inspectEnvironment();
  if (!report.canStart) throw new Error('起動前チェックで問題が見つかりました。環境チェック結果の対処方法を確認してください。');
  post({ type: 'loading', active: true, label: 'Appium Server を起動しています…' });
  await startServer(serverUrl);
  await openOfficial(serverUrl);
}

function getLoadingLabel(message: WebviewMessage): string | undefined {
  switch (message.type) {
    case 'listDevices': return 'Android端末・iOSシミュレーターを確認しています…';
    case 'reconnect': return 'Appium Server に再接続しています…';
    case 'checkEnvironment': return 'Appium の導入状況を確認しています…';
    case 'installOfficial': return '公式 Inspector プラグインをインストールしています…';
    case 'startOfficial': return '公式 Inspector を起動しています…';
    case 'openOfficial': return '公式 Inspector の接続を確認しています…';
    case 'stopServer': return 'Appium Server を停止しています…';
    default: return undefined;
  }
}

async function inspectEnvironment(): Promise<EnvironmentReport> {
  if (!vscode.workspace.isTrusted) throw new Error('環境チェックには Appium コマンドを実行します。このワークスペースを信頼してから実行してください。');
  post({ type: 'loading', active: true, label: 'Appium・プラグイン・ドライバーを確認しています…' });
  environmentReport = await checkEnvironment();
  post({ type: 'environment', report: environmentReport });
  for (const item of environmentReport.items) output.appendLine(`[環境チェック] ${item.name}: ${item.status}\n${item.detail}\n${item.action || ''}`);
  return environmentReport;
}

async function handleInspectorReload(panel: vscode.WebviewPanel, relay: Awaited<ReturnType<typeof startInspectorProxy>>, state: { pending: boolean }): Promise<void> {
  if (!panel.active || state.pending) return;
  state.pending = true;
  try {
    const choice = await vscode.window.showWarningMessage('Inspector を再読み込みしますか？', {
      modal: true,
      detail: '未保存の Capabilities・操作状態が失われ、操作中のセッションとの接続が切れる可能性があります。再読込ではサーバー側のセッションは終了しません。必要な設定を保存し、公式UIでセッションを終了してから続行してください。'
    }, '再読み込みする');
    if (choice !== '再読み込みする' || officialPanel !== panel) return;
    await settingsWrites;
    if (officialPanel === panel) await panel.webview.postMessage({ bridge: relay.token, type: 'reloadConfirmed' });
  } catch {
    void vscode.window.showErrorMessage('Inspector を再読み込みできませんでした。');
  } finally {
    state.pending = false;
  }
}

async function handleInspectorSettings(message: InspectorMessage, settingsKey: string, current: Record<string, string>): Promise<Record<string, string>> {
  try {
    const values = validateSettings(message.values);
    const snapshot = JSON.stringify(values);
    const write = settingsWrites.then(() => secrets.store(settingsKey, snapshot));
    settingsWrites = write.catch(() => undefined);
    await write;
    return values;
  } catch {
    void vscode.window.showErrorMessage('Inspector の保存設定が不正、またはサイズ上限（5 MB）を超えています。');
    return current;
  }
}

async function handleInspectorClipboard(message: InspectorMessage, panel: vscode.WebviewPanel, relay: Awaited<ReturnType<typeof startInspectorProxy>>): Promise<void> {
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
  const storageAdapter = await readFile(vscode.Uri.joinPath(extensionUri, 'media', 'storage-frame.js').fsPath, 'utf8');
  const settingsKey = `inspector.settings.v1:${normaliseServerUrl(rawUrl)}`;
  await settingsWrites;
  const saved = await secrets.get(settingsKey);
  let values = saved ? validateSettings(JSON.parse(saved)) : {};
  const relay = await startInspectorProxy(url, adapter, token => storageAdapter.replace('__INSPECTOR_STORAGE__', () =>
    JSON.stringify({ token, keys: settingKeys, values, upstreamPort: url.port || '80' }).replaceAll('<', String.raw`\u003c`)));
  clipboardRelay = relay;
  const panel = vscode.window.createWebviewPanel('appiumInspector.official', `Appium Inspector · ${url.host}`, vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  officialPanel = panel;
  const reloadState = { pending: false };
  panel.webview.onDidReceiveMessage(async (message: InspectorMessage) => {
    if (!message || message.bridge !== relay.token) return;
    if (message.type === 'requestReload') {
      await handleInspectorReload(panel, relay, reloadState);
      return;
    }
    if (message.type === 'saveSettings') {
      values = await handleInspectorSettings(message, settingsKey, values);
      return;
    }
    if (!panel.active) return;
    await handleInspectorClipboard(message, panel, relay);
  });
  panel.webview.html = officialHtml(relay.url, relay.token);
  panel.onDidDispose(() => { relay.close(); clipboardRelay = undefined; officialPanel = undefined; });
}

async function installOfficialPlugin(): Promise<void> {
  if (!vscode.workspace.isTrusted) { throw new Error('このワークスペースを信頼してから実行してください。'); }
  output.show(true);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('appium', ['plugin', 'install', 'inspector'], { shell: false });
    child.stdout.on('data', data => output.append(data.toString()));
    child.stderr.on('data', data => output.append(data.toString()));
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
  const args = [
    '--address', address, '--port', port,
    '--use-plugins=inspector',
    ...(basePath && basePath !== '/' ? ['--base-path', basePath] : [])
  ];

  output.appendLine(`Appium Server を起動します: appium ${args.join(' ')}`);
  const child = spawn('appium', args, { shell: false });
  serverProcess = child;
  managedServerUrl = serverKey(serverUrl);
  child.stdout.on('data', data => output.append(data.toString()));
  child.stderr.on('data', data => output.append(data.toString()));
  child.on('error', (error: Error & { code?: string }) => {
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
  const choice = await vscode.window.showWarningMessage('Appium Server を停止しますか？', {
    modal: true,
    detail: 'このサーバー上で実行中のすべてのセッションが利用できなくなります。他のテストにも影響する可能性があります。必要な設定を保存し、公式UIでセッションを終了してから続行してください。'
  }, '停止する');
  if (choice !== '停止する' || serverProcess !== child) return;
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
  let url = value.trim();
  while (url.endsWith('/')) url = url.slice(0, -1);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Appium Server URL は http:// または https:// で始めてください。');
  }
  return url;
}

function post(message: unknown): void {
  for (const view of views) { void view.postMessage(message); }
}

function postServerState(): void {
  post({ type: 'server', running: Boolean(serverProcess), url: managedServerUrl });
}

export async function deactivate(): Promise<void> {
  connectionMonitor?.dispose();
  clipboardRelay?.close();
  serverProcess?.kill('SIGTERM');
  await settingsWrites;
}
