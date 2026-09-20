import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { inspectorUrl, officialHtml, launcherHtml } from './official';
import { startInspectorProxy } from './inspector-proxy';
import { readFile } from 'node:fs/promises';
import { settingKeys, validateSettings } from './settings';
import { checkEnvironment, EnvironmentReport } from './environment';
import { ConnectionMonitor, probeServer, serverKey } from './connection';
import { listDevices, capabilitiesFor, DeviceReport } from './devices';
import { setLanguage, t } from './i18n';

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
let displayLanguage = 'ja';

export function activate(context: vscode.ExtensionContext): void {
  displayLanguage = vscode.env?.language ?? 'ja';
  setLanguage(displayLanguage);
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
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'launcher.css')).toString(), webview.cspSource, displayLanguage);
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
  if (!vscode.workspace.isTrusted) throw new Error(t('端末一覧の取得には adb / xcrun を実行します。ワークスペースを信頼してから実行してください。', 'Trust this workspace before listing devices with adb or xcrun.'));
  deviceReport = await listDevices();
  post({ type: 'devices', report: deviceReport });
}

async function copyCapabilities(message: Extract<WebviewMessage, { type: 'deviceCapabilities' | 'copyCapabilities' }>): Promise<void> {
  const device = deviceReport?.devices.find(item => item.id === message.deviceId);
  if (!device) throw new Error(t('端末一覧を更新し、端末を選択してください。', 'Refresh the device list and select a device.'));
  const text = capabilitiesFor(device);
  post({ type: 'capabilitiesTemplate', text });
  if (message.type === 'copyCapabilities') {
    await vscode.env.clipboard.writeText(text);
    post({ type: 'notice', level: 'success', text: t('Capabilities をコピーしました。公式InspectorのJSON編集欄に貼り付けてください。', 'Capabilities copied. Paste them into the JSON editor in the official Inspector.') });
  }
}

async function reconnect(serverUrl: string): Promise<void> {
  const url = serverKey(serverUrl);
  connectionMonitor.watch(url);
  if (!(await probeServer(url, fetch))) throw new Error(t('Appium Server に接続できません。拡張管理サーバーは「起動して公式 Inspector を開く」、外部サーバーは起動元で起動後に再接続してください。', 'Cannot connect to Appium Server. Start an extension-managed server with “Start and Open Official Inspector”; start external servers at their original source, then reconnect.'));
  await openOfficial(serverUrl);
  post({ type: 'notice', level: 'success', text: t('サーバーへの接続を確認しました。セッションは自動復元しません。画面の再読込が必要な場合はInspector上部の「再読込」を使用してください。', 'Server connection verified. Sessions are not restored automatically; use Reload in the Inspector if needed.') });
}

async function installOfficial(): Promise<void> {
  if (serverProcess) throw new Error(t('プラグインのインストール前に Server を停止してください。', 'Stop the server before installing the plugin.'));
  await installOfficialPlugin();
  await inspectEnvironment();
  post({ type: 'notice', level: 'success', text: t('公式プラグインをインストールしました。「起動して公式 Inspector を開く」を押してください。', 'Official plugin installed. Select “Start and Open Official Inspector”.') });
}

async function startOfficial(serverUrl: string): Promise<void> {
  inspectorUrl(serverUrl);
  connectionMonitor.watch(serverUrl);
  if (await isServerReachable(normaliseServerUrl(serverUrl))) return openOfficial(serverUrl);
  const report = await inspectEnvironment();
  if (!report.canStart) throw new Error(t('起動前チェックで問題が見つかりました。環境チェック結果の対処方法を確認してください。', 'Preflight found an issue. Review the Environment Check results for next steps.'));
  post({ type: 'loading', active: true, label: t('Appium Server を起動しています…', 'Starting Appium Server…') });
  await startServer(serverUrl);
  await openOfficial(serverUrl);
}

function getLoadingLabel(message: WebviewMessage): string | undefined {
  switch (message.type) {
    case 'listDevices': return t('Android端末・iOSシミュレーターを確認しています…', 'Checking Android devices and iOS simulators…');
    case 'reconnect': return t('Appium Server に再接続しています…', 'Reconnecting to Appium Server…');
    case 'checkEnvironment': return t('Appium の導入状況を確認しています…', 'Checking Appium installation…');
    case 'installOfficial': return t('公式 Inspector プラグインをインストールしています…', 'Installing official Inspector plugin…');
    case 'startOfficial': return t('公式 Inspector を起動しています…', 'Starting official Inspector…');
    case 'openOfficial': return t('公式 Inspector の接続を確認しています…', 'Checking official Inspector connection…');
    case 'stopServer': return t('Appium Server を停止しています…', 'Stopping Appium Server…');
    default: return undefined;
  }
}

async function inspectEnvironment(): Promise<EnvironmentReport> {
  if (!vscode.workspace.isTrusted) throw new Error(t('環境チェックには Appium コマンドを実行します。このワークスペースを信頼してから実行してください。', 'Trust this workspace before checking the Appium environment.'));
  post({ type: 'loading', active: true, label: t('Appium・プラグイン・ドライバーを確認しています…', 'Checking Appium, plugins, and drivers…') });
  environmentReport = await checkEnvironment();
  post({ type: 'environment', report: environmentReport });
  for (const item of environmentReport.items) output.appendLine(`[環境チェック] ${item.name}: ${item.status}\n${item.detail}\n${item.action || ''}`);
  return environmentReport;
}

async function handleInspectorReload(panel: vscode.WebviewPanel, relay: Awaited<ReturnType<typeof startInspectorProxy>>, state: { pending: boolean }): Promise<void> {
  if (!panel.active || state.pending) return;
  state.pending = true;
  try {
    const reload = t('再読み込みする', 'Reload');
    const choice = await vscode.window.showWarningMessage(t('Inspector を再読み込みしますか？', 'Reload Inspector?'), {
      modal: true,
      detail: t('未保存の Capabilities・操作状態が失われ、操作中のセッションとの接続が切れる可能性があります。再読込ではサーバー側のセッションは終了しません。必要な設定を保存し、公式UIでセッションを終了してから続行してください。', 'Unsaved capabilities and in-progress state may be lost. Reloading does not end the server-side session. Save settings and end the session in the official UI before continuing.')
    }, reload);
    if (choice !== reload || officialPanel !== panel) return;
    await settingsWrites;
    if (officialPanel === panel) await panel.webview.postMessage({ bridge: relay.token, type: 'reloadConfirmed' });
  } catch {
    void vscode.window.showErrorMessage(t('Inspector を再読み込みできませんでした。', 'Could not reload Inspector.'));
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
    void vscode.window.showErrorMessage(t('Inspector の保存設定が不正、またはサイズ上限（5 MB）を超えています。', 'Inspector settings are invalid or exceed the 5 MB limit.'));
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
    if (message.type === 'copyText') await panel.webview.postMessage({ bridge: relay.token, type: 'copyResult', id: message.id, error: t('クリップボードへコピーできませんでした。', 'Could not copy to the clipboard.') });
    void vscode.window.showErrorMessage(t('クリップボードを操作できませんでした。', 'Could not access the clipboard.'));
  }
}

async function openOfficial(rawUrl: string): Promise<void> {
  const url = inspectorUrl(rawUrl);
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' }); }
  catch { throw new Error(t('Appium に接続できません。「起動して公式 Inspector を開く」を押すか、Server URL を確認してください。', 'Cannot connect to Appium. Start it with “Start and Open Official Inspector” or check the Server URL.')); }
  if (!response.ok || !(await response.text()).includes('Appium Inspector')) {
    throw new Error(t('公式 Inspector が有効になっていません。初回セットアップでプラグインを導入し、Server を --use-plugins=inspector 付きで再起動してください。外部で起動した Server はそのターミナルで停止してください。', 'Official Inspector is not enabled. Install the plugin in Initial Setup, then restart the server with --use-plugins=inspector. Stop externally started servers in their original terminal.'));
  }
  officialServer = rawUrl;
  if (officialPanel) {
    officialPanel.reveal();
    // Preserve the live iframe/session when the same server is opened again.
    if (officialPanel.title === `Appium Inspector · ${url.host}`) { return; }
    throw new Error(t('別サーバーを開く場合は、現在の公式 Inspector タブを閉じてから開いてください。', 'Close the current official Inspector tab before opening another server.'));
  }
  const bridgeLanguage = displayLanguage.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  const adapter = (await readFile(vscode.Uri.joinPath(extensionUri, 'media', 'clipboard-frame.js').fsPath, 'utf8'))
    .replace('__BRIDGE_LANGUAGE__', JSON.stringify(bridgeLanguage));
  const storageAdapter = (await readFile(vscode.Uri.joinPath(extensionUri, 'media', 'storage-frame.js').fsPath, 'utf8'))
    .replace('__BRIDGE_LANGUAGE__', JSON.stringify(bridgeLanguage));
  const settingsKey = `inspector.settings.v1:${normaliseServerUrl(rawUrl)}`;
  await settingsWrites;
  const saved = await secrets.get(settingsKey);
  let values = saved ? validateSettings(JSON.parse(saved)) : {};
  const relay = await startInspectorProxy(url, adapter, token => storageAdapter.replace('__INSPECTOR_STORAGE__', () =>
    JSON.stringify({ token, keys: settingKeys, values, upstreamPort: url.port || '80' }).replaceAll('<', String.raw`\u003c`)),
  t('Appium Server に接続できません。', 'Could not connect to Appium Server.'));
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
  panel.webview.html = officialHtml(relay.url, relay.token, displayLanguage);
  panel.onDidDispose(() => { relay.close(); clipboardRelay = undefined; officialPanel = undefined; });
}

async function installOfficialPlugin(): Promise<void> {
  if (!vscode.workspace.isTrusted) { throw new Error(t('このワークスペースを信頼してから実行してください。', 'Trust this workspace before running this command.')); }
  output.show(true);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('appium', ['plugin', 'install', 'inspector'], { shell: false });
    child.stdout.on('data', data => output.append(data.toString()));
    child.stderr.on('data', data => output.append(data.toString()));
    child.once('error', (error) => reject(new Error(t(`Appium を実行できません: ${error.message}`, `Cannot run Appium: ${error.message}`))));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(t('プラグイン導入に失敗しました。ログを確認してください。導入済みの場合はそのまま起動できます。', 'Plugin installation failed. Check Logs; if it is already installed, you can start normally.'))));
  });
}

async function startServer(rawServerUrl: string): Promise<void> {
  if (serverProcess) {
    throw new Error(t('この拡張機能から起動した Appium Server はすでに動作しています。', 'An Appium Server started by this extension is already running.'));
  }

  const serverUrl = normaliseServerUrl(rawServerUrl);
  const url = new URL(serverUrl);
  const permittedHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (!permittedHosts.has(url.hostname)) {
    throw new Error(t('拡張機能から起動できるのはローカル Appium Server のみです。localhost または 127.0.0.1 を指定してください。', 'This extension can start only a local Appium Server. Use localhost or 127.0.0.1.'));
  }
  if (await isServerReachable(serverUrl)) {
    throw new Error(t('指定した URL ではすでに Appium Server が応答しています。既存のサーバーへ接続してください。', 'An Appium Server is already responding at this URL. Connect to the existing server instead.'));
  }

  const port = url.port || '4723';
  const address = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, '');
  const basePath = url.pathname.replace(/\/$/, '');
  const args = [
    '--address', address, '--port', port,
    '--use-plugins=inspector',
    ...(basePath && basePath !== '/' ? ['--base-path', basePath] : [])
  ];

  output.appendLine(t(`Appium Server を起動します: appium ${args.join(' ')}`, `Starting Appium Server: appium ${args.join(' ')}`));
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
      ? t('appium コマンドが見つかりません。`npm install -g appium` を実行してから、VS Code を再起動してください。', 'appium command was not found. Run `npm install -g appium`, then restart VS Code.')
      : t(`Appium Server を起動できませんでした: ${error.message}`, `Could not start Appium Server: ${error.message}`);
    output.appendLine(message);
    post({ type: 'notice', level: 'error', text: message });
  });
  child.on('close', (code, signal) => {
    if (serverProcess === child) {
      serverProcess = undefined;
      postServerState();
      const detail = signal ? t(`シグナル ${signal}`, `signal ${signal}`) : t(`終了コード ${code ?? '不明'}`, `exit code ${code ?? 'unknown'}`);
      post({ type: 'notice', level: code === 0 ? 'success' : 'error', text: t(`Appium Server が停止しました（${detail}）。`, `Appium Server stopped (${detail}).`) });
    }
  });

  await waitForServer(serverUrl, child);
  postServerState();
  post({ type: 'notice', level: 'success', text: t(`Appium Server を起動しました: ${serverUrl}`, `Appium Server started: ${serverUrl}`) });
}

async function stopServer(): Promise<void> {
  if (!serverProcess) {
    throw new Error(t('この拡張機能から起動した Appium Server はありません。', 'No Appium Server started by this extension is running.'));
  }
  const child = serverProcess;
  const stop = t('停止する', 'Stop');
  const choice = await vscode.window.showWarningMessage(t('Appium Server を停止しますか？', 'Stop Appium Server?'), {
    modal: true,
    detail: t('このサーバー上で実行中のすべてのセッションが利用できなくなります。他のテストにも影響する可能性があります。必要な設定を保存し、公式UIでセッションを終了してから続行してください。', 'All sessions on this server will become unavailable and other tests may be affected. Save settings and end sessions in the official UI before continuing.')
  }, stop);
  if (choice !== stop || serverProcess !== child) return;
  output.appendLine(t('Appium Server を停止します。', 'Stopping Appium Server.'));
  const closed = waitForProcessExit(child);
  if (!child.kill('SIGTERM')) {
    throw new Error(t('Appium Server の停止要求を送信できませんでした。', 'Could not send the Appium Server stop request.'));
  }
  await closed;
  post({ type: 'notice', level: 'success', text: t('Appium Server を停止しました。', 'Appium Server stopped.') });
}

function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(t('Appium Server の停止がタイムアウトしました。出力パネルのログを確認してください。', 'Stopping Appium Server timed out. Check Logs.')));
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
      throw new Error(t('Appium Server が起動直後に停止しました。出力パネルの Appium Inspector Lite ログを確認してください。', 'Appium Server stopped immediately after starting. Check the Appium Inspector Lite output log.'));
    }
    if (await isServerReachable(serverUrl)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(t('Appium Server の起動がタイムアウトしました。出力パネルの Appium Inspector Lite ログを確認してください。', 'Starting Appium Server timed out. Check the Appium Inspector Lite output log.'));
}

function normaliseServerUrl(value: string): string {
  let url = value.trim();
  while (url.endsWith('/')) url = url.slice(0, -1);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(t('Appium Server URL は http:// または https:// で始めてください。', 'Appium Server URL must start with http:// or https://.'));
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
