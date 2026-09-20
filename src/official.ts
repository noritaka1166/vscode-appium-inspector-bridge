import { randomUUID } from 'node:crypto';
import { t } from './i18n';
import { launcherMessageTypes } from './webview-protocol';

export interface UiText {
  selectDevice: string;
  noDevices: string;
  checking: string;
  connected: string;
  disconnected: string;
  invalidUrl: string;
  managed: string;
  external: string;
  unknown: string;
  verified: string;
  warning: string;
  actionRequired: string;
  notChecked: string;
  working: string;
  managedProcess: string;
  running: string;
  stopped: string;
  fix: string;
  installAppium: string;
  installOfficial: string;
  showDriverGuide: string;
  noSessions: string;
  attach: string;
  copied: string;
}
const japanese = (language?: string): boolean =>
  language?.toLowerCase().startsWith('ja') ?? false;

export function webviewText(language?: string): UiText {
  return japanese(language)
    ? {
        selectDevice: '端末を選択してください',
        noDevices: '選択できる端末がありません',
        checking: '確認中',
        connected: '接続中',
        disconnected: '切断',
        invalidUrl: 'URLを確認してください（ローカルHTTPのみ対応）',
        managed: '拡張管理',
        external: '外部起動',
        unknown: '起動元未確認',
        verified: '確認済み',
        warning: '注意',
        actionRequired: '要対応',
        notChecked: '未確認',
        working: '処理しています…',
        managedProcess: '拡張管理プロセス',
        running: '起動中',
        stopped: '停止中',
        fix: '対処する',
        installAppium: 'Appium 3 をインストール',
        installOfficial: 'Inspector プラグインをインストール',
        showDriverGuide: 'ドライバーの導入方法を表示',
        noSessions: '起動中セッションはありません',
        attach: 'Attach',
        copied: '✓ コピーしました',
      }
    : {
        selectDevice: 'Select a device',
        noDevices: 'No selectable devices found',
        checking: 'Checking',
        connected: 'Connected',
        disconnected: 'Disconnected',
        invalidUrl: 'Check the URL (local HTTP only)',
        managed: 'Extension-managed',
        external: 'External',
        unknown: 'Unknown origin',
        verified: 'Verified',
        warning: 'Warning',
        actionRequired: 'Action required',
        notChecked: 'Not checked',
        working: 'Working…',
        managedProcess: 'Extension-managed process',
        running: 'Running',
        stopped: 'Stopped',
        fix: 'Fix',
        installAppium: 'Install Appium 3',
        installOfficial: 'Install Inspector plugin',
        showDriverGuide: 'Show driver installation options',
        noSessions: 'No running sessions found',
        attach: 'Attach',
        copied: '✓ Copied',
      };
}

export function inspectorUrl(server: string): URL {
  const url = new URL(server);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      t(
        '公式 Inspector の埋め込みには http://127.0.0.1:4723 のようなローカル HTTP URL を指定してください。',
        'Use a local HTTP URL such as http://127.0.0.1:4723 to embed the official Inspector.',
      ),
    );
  }
  return new URL('/inspector', url.origin);
}

const htmlEntities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => htmlEntities[char] ?? char);

const serializeForScript = (value: unknown): string =>
  JSON.stringify(value).replaceAll('<', String.raw`\u003c`);

const inspectorFrameStyle = `
  html, body {
    width: 100%;
    height: 100%;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden;
    background: var(--vscode-editor-background);
  }
  iframe {
    display: block;
    width: 100%;
    height: 100%;
    margin: 0;
    border: 0;
    background: white;
  }
`;

const messagesFromInspector = [
  'paste',
  'copyText',
  'error',
  'saveSettings',
  'attachResult',
];

const messagesFromVsCode = ['pasteText', 'copy', 'copyResult'];

function inspectorBridgeScript(
  bridgeToken: string,
  origin: string,
  attachSessionId: string | undefined,
): string {
  return `
    const vscode = acquireVsCodeApi();
    const token = ${serializeForScript(bridgeToken)};
    const frame = document.getElementById('inspector');
    const origin = ${serializeForScript(origin)};
    const attachSessionId = ${serializeForScript(attachSessionId ?? '')};
    const messagesFromInspector = new Set(${serializeForScript(messagesFromInspector)});
    const messagesFromVsCode = new Set(${serializeForScript(messagesFromVsCode)});

    if (attachSessionId) {
      frame.addEventListener('load', () => {
        frame.contentWindow.postMessage(
          { bridge: token, type: 'prepareAttach', sessionId: attachSessionId },
          origin,
        );
      });
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.bridge !== token) return;

      if (event.source === frame.contentWindow && event.origin === origin) {
        if (messagesFromInspector.has(message.type)) vscode.postMessage(message);
        return;
      }
      if (event.source !== frame.contentWindow && messagesFromVsCode.has(message.type)) {
        frame.contentWindow.postMessage(message, origin);
      }
    });
  `;
}

function inspectorCsp(origin: string, nonce: string): string {
  return [
    "default-src 'none'",
    `frame-src ${origin}`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

export function officialHtml(
  url: URL,
  bridgeToken = '',
  language?: string,
  attachSessionId?: string,
): string {
  const nonce = randomUUID();
  const origin = escapeHtml(url.origin);
  const documentLanguage = japanese(language) ? 'ja' : 'en';
  const csp = inspectorCsp(origin, nonce);
  const bridge = inspectorBridgeScript(
    bridgeToken,
    url.origin,
    attachSessionId,
  );
  return `<!doctype html>
<html lang="${documentLanguage}">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <style nonce="${nonce}">${inspectorFrameStyle}</style>
  </head>
  <body>
    <iframe
      id="inspector"
      title="Appium Inspector"
      src="${escapeHtml(url.href)}"
      allow="clipboard-read; clipboard-write; fullscreen"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups"
    ></iframe>
    <script nonce="${nonce}">${bridge}</script>
  </body>
</html>`;
}

export function launcherHtml(
  script: string,
  style: string,
  cspSource: string,
  language?: string,
): string {
  const nonce = randomUUID(),
    ja = japanese(language),
    text = webviewText(language);
  const serializedText = JSON.stringify(text).replaceAll(
    '<',
    String.raw`\u003c`,
  );
  const serializedProtocol = JSON.stringify(launcherMessageTypes).replaceAll(
    '<',
    String.raw`\u003c`,
  );
  const labels = ja
    ? {
        launch: '起動して新しい Inspector タブを開く',
        open: '新しい Inspector タブで開く',
        stop: 'Server 停止',
        logs: 'ログ',
        state: '拡張管理プロセス: 停止中',
        connection: '接続状態: 未確認',
        reconnect: '再接続',
        check: '環境チェック',
        devices: '端末・Capabilities',
        sessions: '起動中セッション',
        sessionHelp:
          '選択したセッションを新しい公式 Inspector タブへ接続します。',
        refreshSessions: 'セッション一覧を更新',
        deviceHelp:
          'ローカル端末を選んでJSONを生成します。端末の自動起動は行いません。',
        refresh: '端末一覧を更新',
        device: '端末',
        update: '端末一覧を更新してください',
        copyJson: 'JSONをコピー',
        environment: '環境チェック結果',
        setup: '初回セットアップ',
        install: '公式プラグインをインストール',
        usage: '使い方',
      }
    : {
        launch: 'Start and Open a New Inspector Tab',
        open: 'Open in a New Inspector Tab',
        stop: 'Stop Server',
        logs: 'Logs',
        state: 'Extension-managed process: Stopped',
        connection: 'Connection: Not checked',
        reconnect: 'Reconnect',
        check: 'Check Environment',
        devices: 'Devices & Capabilities',
        sessions: 'Running Sessions',
        sessionHelp:
          'Attach the selected session in a new official Inspector tab.',
        refreshSessions: 'Refresh Sessions',
        deviceHelp:
          'Generate JSON from a local device. This does not start devices.',
        refresh: 'Refresh Devices',
        device: 'Device',
        update: 'Refresh devices first',
        copyJson: 'Copy JSON',
        environment: 'Environment Check Results',
        setup: 'Initial Setup',
        install: 'Install Official Plugin',
        usage: 'Usage',
      };
  const details = ja
    ? {
        device:
          '公式InspectorのJSON Representationの鉛筆を押し、全選択して貼り付けてください。対象アプリに応じて appium:app、Androidの appium:appPackage / appium:appActivity、iOSの appium:bundleId を追加します。保存は公式UIのSave Asを使用してください。',
        env: 'VS Code が使用するローカル Appium 環境の導入状況です。端末・SDK の動作や、起動済みサーバーの環境は検証しません。',
        setup:
          'Appium 3 と Inspector プラグインが必要です。下のボタンは現在の Appium 環境に公式プラグインをインストールします。',
        drivers: 'Android / iOS ドライバーは別途必要です。',
        usage:
          'Capabilities の編集・セッションの開始／終了は、開いた公式 Inspector 内で行います。「新しい Inspector タブで開く」を使うと複数セッションを並べて確認できます。Server を停止する前にセッションを終了してください。',
      }
    : {
        device:
          'In the official Inspector, click the JSON Representation pencil, select all, and paste. Add appium:app, Android appium:appPackage / appium:appActivity, or iOS appium:bundleId as needed. Use Save As in the official UI to save.',
        env: 'This checks the local Appium environment used by VS Code. It does not validate devices, SDKs, or a running external server.',
        setup:
          'Appium 3 and the Inspector plugin are required. This installs the official plugin in the current Appium environment.',
        drivers: 'Install Android / iOS drivers separately.',
        usage:
          'Edit capabilities and start or end sessions in the official Inspector. Use Open in a New Inspector Tab to inspect multiple sessions side by side. End sessions before stopping the server.',
      };
  return `<!doctype html><html lang="${ja ? 'ja' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><main><h1>Appium Inspector Bridge</h1><label>Appium Server URL<input id="server-url" value="http://127.0.0.1:4723" spellcheck="false"></label><button id="launch">${labels.launch}</button><button id="open">${labels.open}</button><div class="row"><button id="stop">${labels.stop}</button><button id="logs">${labels.logs}</button></div><p id="server-state">${labels.state}</p><p id="connection-state" role="status" aria-live="polite">${labels.connection}</p><button id="reconnect">${labels.reconnect}</button><button id="check-environment">${labels.check}</button><details id="running-sessions"><summary>${labels.sessions}</summary><p>${labels.sessionHelp}</p><button id="list-sessions">${labels.refreshSessions}</button><div id="session-list" role="status" aria-live="polite"></div></details><details id="device-tools"><summary>${labels.devices}</summary><p>${labels.deviceHelp}</p><button id="list-devices">${labels.refresh}</button><p id="device-notes" role="status"></p><label>${labels.device}<select id="device-select" disabled><option value="">${labels.update}</option></select></label><label>Capabilities JSON<textarea id="device-caps" rows="8" readonly spellcheck="false"></textarea></label><button id="copy-caps" disabled>${labels.copyJson}</button><p>${details.device}</p></details><details id="environment" hidden><summary>${labels.environment}</summary><p>${details.env}</p><div id="environment-results" role="status" aria-live="polite"></div></details><details><summary>${labels.setup}</summary><p>${details.setup}</p><button id="install">${labels.install}</button><p>${details.drivers}</p></details><details><summary>${labels.usage}</summary><p>${details.usage}</p></details><p id="notice" role="status"></p></main><div id="loading" hidden role="status"><span id="loading-label">${text.working}</span></div><script nonce="${nonce}">window.appiumInspectorBridgeText=${serializedText};window.appiumInspectorBridgeProtocol=${serializedProtocol};</script><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
