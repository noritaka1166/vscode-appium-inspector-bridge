import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { AppiumServerController, normalizeServerUrl } from './appium-server';
import { ConnectionMonitor, probeServer, serverKey } from './connection';
import { capabilitiesFor, type DeviceReport, listDevices } from './devices';
import {
  checkEnvironment,
  type EnvironmentReport,
  resolveAppiumExecutable,
  resolveNpmExecutable,
} from './environment';
import { setLanguage, t } from './i18n';
import { startInspectorProxy } from './inspector-proxy';
import { inspectorUrl, launcherHtml, officialHtml } from './official';
import { settingKeys, validateSettings } from './settings';
import { type LauncherMessage, parseLauncherMessage } from './webview-protocol';

let output: vscode.OutputChannel;
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
let appiumServer: AppiumServerController;
let deviceReport: DeviceReport | undefined;
let displayLanguage = 'ja';

export function activate(context: vscode.ExtensionContext): void {
  displayLanguage = vscode.env?.language ?? 'ja';
  setLanguage(displayLanguage);
  extensionUri = context.extensionUri;
  secrets = context.secrets;
  output = vscode.window.createOutputChannel('Appium Inspector Bridge');
  appiumServer = new AppiumServerController(
    output,
    post,
    resolveAppiumExecutable,
    spawn,
    async (title, detail, accept) =>
      (await vscode.window.showWarningMessage(
        title,
        { modal: true, detail },
        accept,
      )) === accept,
    fetch,
  );
  connectionMonitor = new ConnectionMonitor(
    (state) => post({ type: 'connection', ...state }),
    (url) => appiumServer.manages(url),
    (url) => probeServer(url, fetch),
  );
  context.subscriptions.push(
    connectionMonitor,
    appiumServer,
    vscode.commands.registerCommand('appiumInspectorBridge.paste', async () => {
      if (officialPanel?.active && clipboardRelay) {
        await officialPanel.webview.postMessage({
          bridge: clipboardRelay.token,
          type: 'pasteText',
          text: await vscode.env.clipboard.readText(),
        });
      }
    }),
    vscode.commands.registerCommand('appiumInspectorBridge.copy', async () => {
      if (officialPanel?.active && clipboardRelay)
        await officialPanel.webview.postMessage({
          bridge: clipboardRelay.token,
          type: 'copy',
        });
    }),
    output,
    vscode.window.registerWebviewViewProvider(
      'appiumInspectorBridge.sidebar',
      new InspectorSidebarProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand(
      'appiumInspectorBridge.open',
      openInspector,
    ),
    vscode.commands.registerCommand('appiumInspectorBridge.workspace', () =>
      handleMessage({ type: 'openOfficial', serverUrl: officialServer }),
    ),
  );
}

class InspectorSidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;
    views.add(webview);
    webview.options = { enableScripts: true };
    webview.html = launcherHtml(
      webview
        .asWebviewUri(
          vscode.Uri.joinPath(this.extensionUri, 'media', 'launcher.js'),
        )
        .toString(),
      webview
        .asWebviewUri(
          vscode.Uri.joinPath(this.extensionUri, 'media', 'launcher.css'),
        )
        .toString(),
      webview.cspSource,
      displayLanguage,
    );
    webview.onDidReceiveMessage(
      (value: unknown): Thenable<void> | undefined => {
        const message = parseLauncherMessage(value);
        return message ? handleMessage(message) : undefined;
      },
    );
    webviewView.onDidDispose(() => {
      views.delete(webview);
      if (!views.size) connectionMonitor.dispose();
    });
  }
}

async function openInspector(): Promise<void> {
  await vscode.commands.executeCommand(
    'workbench.view.extension.appiumInspectorBridge',
  );
}

interface InspectorMessage {
  bridge?: unknown;
  type?: unknown;
  values?: unknown;
  text?: unknown;
  id?: unknown;
}

async function handleMessage(message: LauncherMessage): Promise<void> {
  if (handlePassiveMessage(message)) return;
  if (busy) {
    return;
  }
  busy = true;
  const loadingLabel = getLoadingLabel(message);
  if (loadingLabel)
    post({ type: 'loading', active: true, label: loadingLabel });
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

function handlePassiveMessage(message: LauncherMessage): boolean {
  if (message.type === 'watchServer') {
    try {
      connectionMonitor.watch(message.serverUrl);
    } catch {
      post({
        type: 'connection',
        url: message.serverUrl,
        status: 'invalid',
        owner: 'unknown',
      });
    }
    return true;
  }
  if (message.type !== 'ready') return false;
  post({
    type: 'server',
    running: appiumServer.isRunning,
    url: appiumServer.url,
  });
  if (environmentReport)
    post({ type: 'environment', report: environmentReport });
  if (deviceReport) post({ type: 'devices', report: deviceReport });
  post({ type: 'loading', active: busy });
  return true;
}

async function dispatchMessage(message: LauncherMessage): Promise<void> {
  switch (message.type) {
    case 'listDevices':
      return loadDevices();
    case 'deviceCapabilities':
    case 'copyCapabilities':
      return copyCapabilities(message);
    case 'reconnect':
      return reconnect(message.serverUrl);
    case 'checkEnvironment':
      return inspectEnvironment().then(() => undefined);
    case 'installOfficial':
      return installOfficial();
    case 'installAppium':
      return installAppium();
    case 'showDriverGuide':
      return showDriverGuide();
    case 'startOfficial':
      return startOfficial(message.serverUrl);
    case 'openOfficial':
      connectionMonitor.watch(message.serverUrl);
      return openOfficial(message.serverUrl);
    case 'stopServer':
      return appiumServer.stop();
    case 'showOutput':
      output.show(true);
      return;
  }
}

async function loadDevices(): Promise<void> {
  if (!vscode.workspace.isTrusted)
    throw new Error(
      t(
        '端末一覧の取得には adb / xcrun を実行します。ワークスペースを信頼してから実行してください。',
        'Trust this workspace before listing devices with adb or xcrun.',
      ),
    );
  deviceReport = await listDevices();
  post({ type: 'devices', report: deviceReport });
}

async function copyCapabilities(
  message: Extract<
    LauncherMessage,
    { type: 'deviceCapabilities' | 'copyCapabilities' }
  >,
): Promise<void> {
  const device = deviceReport?.devices.find(
    (item) => item.id === message.deviceId,
  );
  if (!device)
    throw new Error(
      t(
        '端末一覧を更新し、端末を選択してください。',
        'Refresh the device list and select a device.',
      ),
    );
  const text = capabilitiesFor(device);
  post({ type: 'capabilitiesTemplate', text });
  if (message.type === 'copyCapabilities') {
    await vscode.env.clipboard.writeText(text);
    post({
      type: 'notice',
      level: 'success',
      text: t(
        'Capabilities をコピーしました。公式InspectorのJSON編集欄に貼り付けてください。',
        'Capabilities copied. Paste them into the JSON editor in the official Inspector.',
      ),
    });
  }
}

async function reconnect(serverUrl: string): Promise<void> {
  const url = serverKey(serverUrl);
  connectionMonitor.watch(url);
  if (!(await probeServer(url, fetch)))
    throw new Error(
      t(
        'Appium Server に接続できません。拡張管理サーバーは「起動して公式 Inspector を開く」、外部サーバーは起動元で起動後に再接続してください。',
        'Cannot connect to Appium Server. Start an extension-managed server with “Start and Open Official Inspector”; start external servers at their original source, then reconnect.',
      ),
    );
  await openOfficial(serverUrl);
  post({
    type: 'notice',
    level: 'success',
    text: t(
      'サーバーへの接続を確認しました。セッションは自動復元しません。画面の再読込が必要な場合はInspector上部の「再読込」を使用してください。',
      'Server connection verified. Sessions are not restored automatically; use Reload in the Inspector if needed.',
    ),
  });
}

async function installOfficial(): Promise<void> {
  if (appiumServer.isRunning)
    throw new Error(
      t(
        'プラグインのインストール前に Server を停止してください。',
        'Stop the server before installing the plugin.',
      ),
    );
  await installOfficialPlugin();
  await inspectEnvironment();
  post({
    type: 'notice',
    level: 'success',
    text: t(
      '公式プラグインをインストールしました。「起動して公式 Inspector を開く」を押してください。',
      'Official plugin installed. Select “Start and Open Official Inspector”.',
    ),
  });
}

async function installAppium(): Promise<void> {
  if (!vscode.workspace.isTrusted)
    throw new Error(
      t(
        'Appium の導入には npm を実行します。このワークスペースを信頼してから実行してください。',
        'Trust this workspace before installing Appium with npm.',
      ),
    );
  if (appiumServer.isRunning)
    throw new Error(
      t(
        'Appium の更新前に Server を停止してください。',
        'Stop the server before updating Appium.',
      ),
    );
  const install = t('インストールする', 'Install');
  const choice = await vscode.window.showWarningMessage(
    t(
      'Appium 3 をグローバルにインストールしますか？',
      'Install Appium 3 globally?',
    ),
    {
      modal: true,
      detail: t(
        '`npm install -g appium@3` を実行し、現在のNode.js環境のグローバルパッケージを変更します。既存のAppiumやテストへの影響を確認してから続行してください。',
        '`npm install -g appium@3` will change global packages in the current Node.js environment. Check the impact on existing Appium installations and tests before continuing.',
      ),
    },
    install,
  );
  if (choice !== install) return;
  output.show(true);
  output.appendLine(t('Appium 3 を導入します。', 'Installing Appium 3.'));
  let npm: string;
  try {
    npm = await resolveNpmExecutable();
  } catch {
    throw new Error(
      t(
        'npm コマンドが見つかりません。Node.js 24 を導入し、npm が PATH にある環境から VS Code を再起動してください。',
        'npm command was not found. Install Node.js 24, then restart VS Code from an environment where npm is on PATH.',
      ),
    );
  }
  await runCommand(
    npm,
    ['install', '-g', 'appium@3'],
    t(
      'Appium 3 の導入に失敗しました。出力パネルのログを確認してください。',
      'Appium 3 installation failed. Check Logs.',
    ),
  );
  await inspectEnvironment();
  post({
    type: 'notice',
    level: 'success',
    text: t(
      'Appium 3 を導入しました。環境チェック結果を確認してから起動してください。',
      'Appium 3 installed. Review Environment Check results before starting.',
    ),
  });
}

async function showDriverGuide(): Promise<void> {
  const choices = [
    {
      label: t('Android（UiAutomator2）', 'Android (UiAutomator2)'),
      description: 'appium driver install uiautomator2',
    },
    ...(process.platform === 'darwin'
      ? [
          {
            label: t('iOS（XCUITest）', 'iOS (XCUITest)'),
            description: 'appium driver install xcuitest',
          },
        ]
      : []),
  ];
  const choice = await vscode.window.showQuickPick(choices, {
    placeHolder: t(
      '導入する対象プラットフォームを選択してください',
      'Choose the target platform to install',
    ),
  });
  if (!choice) return;
  await vscode.env.clipboard.writeText(choice.description);
  output.appendLine(
    `${t('ドライバー導入コマンド', 'Driver installation command')}: ${choice.description}`,
  );
  post({
    type: 'notice',
    level: 'success',
    text: t(
      `コマンドをクリップボードへコピーしました: ${choice.description}`,
      `Command copied to clipboard: ${choice.description}`,
    ),
  });
}

async function startOfficial(serverUrl: string): Promise<void> {
  inspectorUrl(serverUrl);
  connectionMonitor.watch(serverUrl);
  if (await appiumServer.isReachable(normalizeServerUrl(serverUrl)))
    return openOfficial(serverUrl);
  const report = await inspectEnvironment();
  if (!report.canStart)
    throw new Error(
      t(
        '起動前チェックで問題が見つかりました。環境チェック結果の対処方法を確認してください。',
        'Preflight found an issue. Review the Environment Check results for next steps.',
      ),
    );
  post({
    type: 'loading',
    active: true,
    label: t('Appium Server を起動しています…', 'Starting Appium Server…'),
  });
  await appiumServer.start(serverUrl);
  await openOfficial(serverUrl);
}

function getLoadingLabel(message: LauncherMessage): string | undefined {
  switch (message.type) {
    case 'listDevices':
      return t(
        'Android端末・iOSシミュレーターを確認しています…',
        'Checking Android devices and iOS simulators…',
      );
    case 'reconnect':
      return t(
        'Appium Server に再接続しています…',
        'Reconnecting to Appium Server…',
      );
    case 'checkEnvironment':
      return t(
        'Appium の導入状況を確認しています…',
        'Checking Appium installation…',
      );
    case 'installOfficial':
      return t(
        '公式 Inspector プラグインをインストールしています…',
        'Installing official Inspector plugin…',
      );
    case 'installAppium':
      return t('Appium 3 をインストールしています…', 'Installing Appium 3…');
    case 'showDriverGuide':
      return t(
        'ドライバーの導入方法を準備しています…',
        'Preparing driver options…',
      );
    case 'startOfficial':
      return t(
        '公式 Inspector を起動しています…',
        'Starting official Inspector…',
      );
    case 'openOfficial':
      return t(
        '公式 Inspector の接続を確認しています…',
        'Checking official Inspector connection…',
      );
    case 'stopServer':
      return t('Appium Server を停止しています…', 'Stopping Appium Server…');
    default:
      return undefined;
  }
}

async function inspectEnvironment(): Promise<EnvironmentReport> {
  if (!vscode.workspace.isTrusted)
    throw new Error(
      t(
        '環境チェックには Appium コマンドを実行します。このワークスペースを信頼してから実行してください。',
        'Trust this workspace before checking the Appium environment.',
      ),
    );
  post({
    type: 'loading',
    active: true,
    label: t(
      'Appium・プラグイン・ドライバーを確認しています…',
      'Checking Appium, plugins, and drivers…',
    ),
  });
  environmentReport = await checkEnvironment();
  post({ type: 'environment', report: environmentReport });
  for (const item of environmentReport.items)
    output.appendLine(
      `[環境チェック] ${item.name}: ${item.status}\n${item.detail}\n${item.action || ''}`,
    );
  return environmentReport;
}

async function handleInspectorReload(
  panel: vscode.WebviewPanel,
  relay: Awaited<ReturnType<typeof startInspectorProxy>>,
  state: { pending: boolean },
): Promise<void> {
  if (!panel.active || state.pending) return;
  state.pending = true;
  try {
    const reload = t('再読み込みする', 'Reload');
    const choice = await vscode.window.showWarningMessage(
      t('Inspector を再読み込みしますか？', 'Reload Inspector?'),
      {
        modal: true,
        detail: t(
          '未保存の Capabilities・操作状態が失われ、操作中のセッションとの接続が切れる可能性があります。再読込ではサーバー側のセッションは終了しません。必要な設定を保存し、公式UIでセッションを終了してから続行してください。',
          'Unsaved capabilities and in-progress state may be lost. Reloading does not end the server-side session. Save settings and end the session in the official UI before continuing.',
        ),
      },
      reload,
    );
    if (choice !== reload || officialPanel !== panel) return;
    await settingsWrites;
    if (officialPanel === panel)
      await panel.webview.postMessage({
        bridge: relay.token,
        type: 'reloadConfirmed',
      });
  } catch {
    void vscode.window.showErrorMessage(
      t(
        'Inspector を再読み込みできませんでした。',
        'Could not reload Inspector.',
      ),
    );
  } finally {
    state.pending = false;
  }
}

async function handleInspectorSettings(
  message: InspectorMessage,
  settingsKey: string,
  current: Record<string, string>,
): Promise<Record<string, string>> {
  try {
    const values = validateSettings(message.values);
    const snapshot = JSON.stringify(values);
    const write = settingsWrites.then(() =>
      secrets.store(settingsKey, snapshot),
    );
    settingsWrites = write.catch(() => undefined);
    await write;
    return values;
  } catch {
    void vscode.window.showErrorMessage(
      t(
        'Inspector の保存設定が不正、またはサイズ上限（5 MB）を超えています。',
        'Inspector settings are invalid or exceed the 5 MB limit.',
      ),
    );
    return current;
  }
}

async function handleInspectorClipboard(
  message: InspectorMessage,
  panel: vscode.WebviewPanel,
  relay: Awaited<ReturnType<typeof startInspectorProxy>>,
): Promise<void> {
  try {
    if (message.type === 'paste')
      await panel.webview.postMessage({
        bridge: relay.token,
        type: 'pasteText',
        text: await vscode.env.clipboard.readText(),
      });
    if (message.type === 'copyText' && typeof message.text === 'string') {
      await vscode.env.clipboard.writeText(message.text);
      await panel.webview.postMessage({
        bridge: relay.token,
        type: 'copyResult',
        id: message.id,
      });
    }
    if (message.type === 'error' && typeof message.text === 'string')
      void vscode.window.showWarningMessage(message.text);
  } catch {
    if (message.type === 'copyText')
      await panel.webview.postMessage({
        bridge: relay.token,
        type: 'copyResult',
        id: message.id,
        error: t(
          'クリップボードへコピーできませんでした。',
          'Could not copy to the clipboard.',
        ),
      });
    void vscode.window.showErrorMessage(
      t(
        'クリップボードを操作できませんでした。',
        'Could not access the clipboard.',
      ),
    );
  }
}

async function openOfficial(rawUrl: string): Promise<void> {
  const url = inspectorUrl(rawUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
  } catch {
    throw new Error(
      t(
        'Appium に接続できません。「起動して公式 Inspector を開く」を押すか、Server URL を確認してください。',
        'Cannot connect to Appium. Start it with “Start and Open Official Inspector” or check the Server URL.',
      ),
    );
  }
  if (!response.ok || !(await response.text()).includes('Appium Inspector')) {
    throw new Error(
      t(
        '公式 Inspector が有効になっていません。初回セットアップでプラグインを導入し、Server を --use-plugins=inspector 付きで再起動してください。外部で起動した Server はそのターミナルで停止してください。',
        'Official Inspector is not enabled. Install the plugin in Initial Setup, then restart the server with --use-plugins=inspector. Stop externally started servers in their original terminal.',
      ),
    );
  }
  officialServer = rawUrl;
  if (officialPanel) {
    officialPanel.reveal();
    // Preserve the live iframe/session when the same server is opened again.
    if (officialPanel.title === `Appium Inspector Bridge · ${url.host}`) {
      return;
    }
    throw new Error(
      t(
        '別サーバーを開く場合は、現在の公式 Inspector タブを閉じてから開いてください。',
        'Close the current official Inspector tab before opening another server.',
      ),
    );
  }
  const bridgeLanguage = displayLanguage.toLowerCase().startsWith('ja')
    ? 'ja'
    : 'en';
  const adapter = (
    await readFile(
      vscode.Uri.joinPath(extensionUri, 'media', 'clipboard-frame.js').fsPath,
      'utf8',
    )
  ).replace('__BRIDGE_LANGUAGE__', JSON.stringify(bridgeLanguage));
  const storageAdapter = (
    await readFile(
      vscode.Uri.joinPath(extensionUri, 'media', 'storage-frame.js').fsPath,
      'utf8',
    )
  ).replace('__BRIDGE_LANGUAGE__', JSON.stringify(bridgeLanguage));
  const settingsKey = `appiumInspectorBridge.settings.v1:${normalizeServerUrl(rawUrl)}`;
  await settingsWrites;
  const saved = await secrets.get(settingsKey);
  let values = saved ? validateSettings(JSON.parse(saved)) : {};
  const relay = await startInspectorProxy(
    url,
    adapter,
    (token) =>
      storageAdapter.replace('__INSPECTOR_STORAGE__', () =>
        JSON.stringify({
          token,
          keys: settingKeys,
          values,
          upstreamPort: url.port || '80',
        }).replaceAll('<', String.raw`\u003c`),
      ),
    t(
      'Appium Server に接続できません。',
      'Could not connect to Appium Server.',
    ),
  );
  clipboardRelay = relay;
  const panel = vscode.window.createWebviewPanel(
    'appiumInspectorBridge.official',
    `Appium Inspector Bridge · ${url.host}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );
  officialPanel = panel;
  const reloadState = { pending: false };
  panel.webview.onDidReceiveMessage(async (message: InspectorMessage) => {
    if (message?.bridge !== relay.token) return;
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
  panel.onDidDispose(() => {
    relay.close();
    clipboardRelay = undefined;
    officialPanel = undefined;
  });
}

async function installOfficialPlugin(): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      t(
        'このワークスペースを信頼してから実行してください。',
        'Trust this workspace before running this command.',
      ),
    );
  }
  output.show(true);
  const appium = await resolveAppiumExecutable();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(appium, ['plugin', 'install', 'inspector'], {
      shell: false,
    });
    child.stdout.on('data', (data) => output.append(data.toString()));
    child.stderr.on('data', (data) => output.append(data.toString()));
    child.once('error', (error) =>
      reject(
        new Error(
          t(
            `Appium を実行できません: ${error.message}`,
            `Cannot run Appium: ${error.message}`,
          ),
        ),
      ),
    );
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              t(
                'プラグイン導入に失敗しました。ログを確認してください。導入済みの場合はそのまま起動できます。',
                'Plugin installation failed. Check Logs; if it is already installed, you can start normally.',
              ),
            ),
          ),
    );
  });
}

async function runCommand(
  command: string,
  args: string[],
  failure: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    child.stdout.on('data', (data) => output.append(data.toString()));
    child.stderr.on('data', (data) => output.append(data.toString()));
    child.once('error', (error) => reject(error));
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(failure)),
    );
  });
}

function post(message: unknown): void {
  for (const view of views) {
    void view.postMessage(message);
  }
}

export async function deactivate(): Promise<void> {
  connectionMonitor?.dispose();
  clipboardRelay?.close();
  appiumServer?.dispose();
  await settingsWrites;
}
