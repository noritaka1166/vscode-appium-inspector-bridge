import type { readFile as readFileType } from 'node:fs/promises';
import type * as vscode from 'vscode';
import type { startInspectorProxy } from './inspector-proxy';
import type { officialHtml } from './official';
import {
  type InspectorSettingsStore,
  settingKeys,
  withAttachServer,
} from './settings';

type InspectorRelay = Awaited<ReturnType<typeof startInspectorProxy>>;
type Post = (message: unknown) => void;

interface InspectorMessage {
  bridge?: unknown;
  type?: unknown;
  values?: unknown;
  text?: unknown;
  id?: unknown;
}

interface InspectorPanelState {
  relay: InspectorRelay;
  serverUrl: string;
}

export interface InspectorPanelDependencies {
  vscode: typeof vscode;
  extensionUri: vscode.Uri;
  language: string;
  readFile: typeof readFileType;
  startProxy: typeof startInspectorProxy;
  createHtml: typeof officialHtml;
  post: Post;
  onAttachResult: (result: unknown) => void;
  onInvalidSettings: () => void;
  onClipboardError: () => void;
  onWebviewWarning: (text: string) => void;
  copyFailureMessage: string;
}

/** Owns Inspector editor tabs, relays, clipboard bridge, and persisted Inspector settings. */
export class InspectorPanelManager implements vscode.Disposable {
  private readonly panels = new Map<vscode.WebviewPanel, InspectorPanelState>();

  constructor(
    private readonly dependencies: InspectorPanelDependencies,
    private readonly settings: InspectorSettingsStore,
  ) {}

  active():
    | { panel: vscode.WebviewPanel; state: InspectorPanelState }
    | undefined {
    for (const [panel, state] of this.panels) {
      if (panel.active) return { panel, state };
    }
    return undefined;
  }

  async open(
    upstream: URL,
    normalizedServerUrl: string,
    attachSessionId?: string,
    reuseExisting = false,
  ): Promise<void> {
    if (reuseExisting) {
      for (const [panel, state] of this.panels) {
        if (state.serverUrl === normalizedServerUrl) {
          panel.reveal();
          return;
        }
      }
    }
    const language = this.dependencies.language.toLowerCase().startsWith('ja')
      ? 'ja'
      : 'en';
    const adapter = (
      await this.dependencies.readFile(
        this.dependencies.vscode.Uri.joinPath(
          this.dependencies.extensionUri,
          'media',
          'clipboard-frame.js',
        ).fsPath,
        'utf8',
      )
    ).replace('__BRIDGE_LANGUAGE__', JSON.stringify(language));
    const storageAdapter = (
      await this.dependencies.readFile(
        this.dependencies.vscode.Uri.joinPath(
          this.dependencies.extensionUri,
          'media',
          'storage-frame.js',
        ).fsPath,
        'utf8',
      )
    ).replace('__BRIDGE_LANGUAGE__', JSON.stringify(language));
    const settingsKey = `appiumInspectorBridge.settings.v1:${normalizedServerUrl}`;
    const loaded = await this.settings.load(settingsKey);
    if (loaded.recovered) this.dependencies.onInvalidSettings();
    let values = attachSessionId
      ? withAttachServer(loaded.values, normalizedServerUrl)
      : loaded.values;
    const relay = await this.dependencies.startProxy(
      upstream,
      adapter,
      (token) =>
        storageAdapter.replace('__INSPECTOR_STORAGE__', () =>
          JSON.stringify({
            token,
            keys: settingKeys,
            values,
            upstreamPort: upstream.port || '80',
          }).replaceAll('<', String.raw`\u003c`),
        ),
      'Could not connect to Appium Server.',
    );
    const panel = this.dependencies.vscode.window.createWebviewPanel(
      'appiumInspectorBridge.official',
      `Appium Inspector Bridge · ${upstream.host}`,
      this.panels.size
        ? this.dependencies.vscode.ViewColumn.Beside
        : this.dependencies.vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    this.panels.set(panel, { relay, serverUrl: normalizedServerUrl });
    panel.webview.onDidReceiveMessage(async (message: InspectorMessage) => {
      if (message?.bridge !== relay.token) return;
      if (message.type === 'saveSettings') {
        try {
          values = await this.settings.save(settingsKey, message.values);
        } catch {
          this.dependencies.onInvalidSettings();
        }
        return;
      }
      if (message.type === 'attachResult') {
        this.dependencies.onAttachResult(message.text);
        return;
      }
      if (!panel.active) return;
      await this.handleClipboardMessage(message, panel, relay);
    });
    panel.webview.html = this.dependencies.createHtml(
      relay.url,
      relay.token,
      this.dependencies.language,
      attachSessionId,
    );
    panel.onDidDispose(() => {
      relay.close();
      this.panels.delete(panel);
    });
  }

  dispose(): void {
    for (const { relay } of this.panels.values()) relay.close();
    this.panels.clear();
  }

  private async handleClipboardMessage(
    message: InspectorMessage,
    panel: vscode.WebviewPanel,
    relay: InspectorRelay,
  ): Promise<void> {
    try {
      if (message.type === 'paste') {
        await panel.webview.postMessage({
          bridge: relay.token,
          type: 'pasteText',
          text: await this.dependencies.vscode.env.clipboard.readText(),
        });
      }
      if (message.type === 'copyText' && typeof message.text === 'string') {
        await this.dependencies.vscode.env.clipboard.writeText(message.text);
        await panel.webview.postMessage({
          bridge: relay.token,
          type: 'copyResult',
          id: message.id,
        });
      }
      if (message.type === 'error' && typeof message.text === 'string')
        this.dependencies.onWebviewWarning(message.text);
    } catch {
      if (message.type === 'copyText')
        await panel.webview.postMessage({
          bridge: relay.token,
          type: 'copyResult',
          id: message.id,
          error: this.dependencies.copyFailureMessage,
        });
      this.dependencies.onClipboardError();
    }
  }
}
