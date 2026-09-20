import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { AppiumServerController, normalizeServerUrl } from './appium-server';
import { runLoggedCommand } from './command-runner';
import { ConnectionMonitor, probeServer, serverKey } from './connection';
import { capabilitiesFor, type DeviceReport, listDevices } from './devices';
import {
  checkEnvironment,
  type EnvironmentReport,
  resolveAppiumExecutable,
  resolveNpmExecutable,
} from './environment';
import { setLanguage, t } from './i18n';
import { InspectorPanelManager } from './inspector-panel-manager';
import { startInspectorProxy } from './inspector-proxy';
import { LauncherController } from './launcher-controller';
import { inspectorUrl, launcherHtml, officialHtml } from './official';
import { listRunningSessions, type SessionReport } from './sessions';
import { InspectorSettingsStore } from './settings';
import { type LauncherMessage, parseLauncherMessage } from './webview-protocol';

let output: vscode.OutputChannel;
const views = new Set<vscode.Webview>();
let officialServer = 'http://127.0.0.1:4723';
let extensionUri: vscode.Uri;
let environmentReport: EnvironmentReport | undefined;
let connectionMonitor: ConnectionMonitor;
let appiumServer: AppiumServerController;
let deviceReport: DeviceReport | undefined;
let sessionReport: SessionReport | undefined;
let displayLanguage = 'ja';
let launcherController: LauncherController;
let inspectorPanels: InspectorPanelManager;
let settings: InspectorSettingsStore;

export function activate(context: vscode.ExtensionContext): void {
  displayLanguage = vscode.env?.language ?? 'ja';
  setLanguage(displayLanguage);
  extensionUri = context.extensionUri;
  output = vscode.window.createOutputChannel('Appium Inspector Bridge');
  settings = new InspectorSettingsStore(
    context.secrets ?? {
      get: async () => undefined,
      store: async () => {},
    },
  );
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
  inspectorPanels = new InspectorPanelManager(
    {
      vscode,
      extensionUri,
      language: displayLanguage,
      readFile,
      startProxy: startInspectorProxy,
      createHtml: officialHtml,
      post,
      onAttachResult: postAttachResult,
      onInvalidSettings: () =>
        void vscode.window.showErrorMessage(
          t(
            'Inspector の保存設定が不正、またはサイズ上限（5 MB）を超えています。初期設定で開きます。',
            'Inspector settings are invalid or exceed the 5 MB limit. Opening with defaults.',
          ),
        ),
      onClipboardError: () =>
        void vscode.window.showErrorMessage(
          t(
            'クリップボードを操作できませんでした。',
            'Could not access the clipboard.',
          ),
        ),
      onWebviewWarning: (text) => void vscode.window.showWarningMessage(text),
      copyFailureMessage: t(
        'クリップボードへコピーできませんでした。',
        'Could not copy to the clipboard.',
      ),
    },
    settings,
  );
  launcherController = new LauncherController(
    post,
    output,
    handlePassiveMessage,
    dispatchMessage,
    getLoadingLabel,
  );
  context.subscriptions.push(
    connectionMonitor,
    appiumServer,
    vscode.commands.registerCommand('appiumInspectorBridge.paste', async () => {
      const inspector = inspectorPanels.active();
      if (inspector) {
        await inspector.panel.webview.postMessage({
          bridge: inspector.state.relay.token,
          type: 'pasteText',
          text: await vscode.env.clipboard.readText(),
        });
      }
    }),
    vscode.commands.registerCommand('appiumInspectorBridge.copy', async () => {
      const inspector = inspectorPanels.active();
      if (inspector)
        await inspector.panel.webview.postMessage({
          bridge: inspector.state.relay.token,
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
      launcherController.handle({
        type: 'openOfficial',
        serverUrl: officialServer,
      }),
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
        return message ? launcherController.handle(message) : undefined;
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
  if (sessionReport) post({ type: 'sessions', report: sessionReport });
  post({ type: 'loading', active: launcherController.isBusy });
  return true;
}

async function dispatchMessage(message: LauncherMessage): Promise<void> {
  switch (message.type) {
    case 'listDevices':
      return loadDevices();
    case 'listSessions':
      return loadSessions(message.serverUrl);
    case 'attachSession':
      return attachSession(message);
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

async function loadSessions(serverUrl: string): Promise<void> {
  if (!vscode.workspace.isTrusted)
    throw new Error(
      t(
        '起動中セッションの一覧にはセッションIDが含まれます。ワークスペースを信頼してから実行してください。',
        'Running session lists include session IDs. Trust this workspace before continuing.',
      ),
    );
  sessionReport = await listRunningSessions(serverUrl);
  officialServer = serverUrl;
  post({ type: 'sessions', report: sessionReport });
}

async function attachSession(
  message: Extract<LauncherMessage, { type: 'attachSession' }>,
): Promise<void> {
  if (!vscode.workspace.isTrusted)
    throw new Error(
      t(
        '既存セッションへの接続にはワークスペースを信頼してください。',
        'Trust this workspace before attaching to an existing session.',
      ),
    );
  await vscode.env.clipboard.writeText(message.sessionId);
  connectionMonitor.watch(message.serverUrl);
  await openOfficial(message.serverUrl, false, message.sessionId);
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
    post({ type: 'capabilitiesCopied' });
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
  await openOfficial(serverUrl, true);
  post({
    type: 'notice',
    level: 'success',
    text: t(
      'サーバーへの接続を確認しました。セッションは自動復元しません。',
      'Server connection verified. Sessions are not restored automatically.',
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
  await runLoggedCommand(npm, ['install', '-g', 'appium@3'], {
    output,
    failure: t(
      'Appium 3 の導入に失敗しました。出力パネルのログを確認してください。',
      'Appium 3 installation failed. Check Logs.',
    ),
  });
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
    case 'listSessions':
      return t(
        'Appium Server の起動中セッションを確認しています…',
        'Checking running Appium sessions…',
      );
    case 'attachSession':
      return t(
        '既存セッションへ接続しています…',
        'Attaching to the existing session…',
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

async function openOfficial(
  rawUrl: string,
  reuseExisting = false,
  attachSessionId?: string,
): Promise<void> {
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
  const normalizedServerUrl = normalizeServerUrl(rawUrl);
  await inspectorPanels.open(
    url,
    normalizedServerUrl,
    attachSessionId,
    reuseExisting,
  );
}

function postAttachResult(result: unknown): void {
  let message: string;
  if (result === 'attached') {
    message = t(
      '既存セッションへ接続しています。公式 Inspector の表示を確認してください。',
      'Attaching to the existing session. Check the official Inspector.',
    );
  } else if (result === 'prepared') {
    message = t(
      'Attach タブにセッションIDを入力しました。Attach を押して接続してください。',
      'The session ID is entered in the Attach tab. Select Attach to connect.',
    );
  } else {
    message = t(
      'セッションIDをクリップボードにコピーしました。公式 Inspector の Attach to Session タブへ貼り付けて Attach を押してください。',
      'The session ID was copied to the clipboard. Paste it into Attach to Session in the official Inspector, then select Attach.',
    );
  }
  post({
    type: 'notice',
    level: result === 'manual' ? 'warning' : 'success',
    text: message,
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
  await runLoggedCommand(appium, ['plugin', 'install', 'inspector'], {
    output,
    failure: t(
      'プラグイン導入に失敗しました。ログを確認してください。導入済みの場合はそのまま起動できます。',
      'Plugin installation failed. Check Logs; if it is already installed, you can start normally.',
    ),
    startFailure: (error) =>
      new Error(
        t(
          `Appium を実行できません: ${error.message}`,
          `Cannot run Appium: ${error.message}`,
        ),
      ),
  });
}

function post(message: unknown): void {
  for (const view of views) {
    void view.postMessage(message);
  }
}

export async function deactivate(): Promise<void> {
  connectionMonitor?.dispose();
  inspectorPanels?.dispose();
  appiumServer?.dispose();
  await settings?.flush();
}
