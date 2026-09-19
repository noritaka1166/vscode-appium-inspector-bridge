import { randomUUID } from 'node:crypto';

export function inspectorUrl(server: string): URL {
  const url = new URL(server);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('公式 Inspector の埋め込みには http://127.0.0.1:4723 のようなローカル HTTP URL を指定してください。');
  }
  // The upstream plugin is always at /inspector, regardless of Appium base-path.
  return new URL('/inspector', url.origin);
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export function officialHtml(url: URL, bridgeToken = ''): string {
  const nonce = randomUUID();
  const origin = escapeHtml(url.origin), href = escapeHtml(url.href);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:12px var(--vscode-font-family)}body{display:grid;grid-template-rows:30px 1fr}header{display:flex;align-items:center;gap:12px;padding:0 12px;border-bottom:1px solid var(--vscode-panel-border)}span{opacity:.7}iframe{border:0;width:100%;height:100%;background:white}button{margin-left:auto;border:0;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}</style></head>
<body><header>Appium Inspector <span>${href}</span><button id="select-all">全選択</button><button id="copy">コピー</button><button id="paste">貼り付け</button><button id="reload">再読込</button></header>
<iframe id="inspector" title="公式 Appium Inspector" src="${href}" allow="clipboard-read; clipboard-write; fullscreen" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi(), token = ${JSON.stringify(bridgeToken)}, frame = document.getElementById('inspector'), origin = ${JSON.stringify(url.origin)};
const send = type => vscode.postMessage({type, bridge:token});
document.getElementById('paste').onclick=()=>send('paste');
document.getElementById('select-all').onclick=()=>frame.contentWindow.postMessage({bridge:token,type:'selectAll'},origin);
document.getElementById('copy').onclick=()=>frame.contentWindow.postMessage({bridge:token,type:'copy'},origin);
document.getElementById('reload').onclick=()=>send('requestReload');
window.addEventListener('message',event=>{
  const m=event.data;
  if(!m || m.bridge!==token) return;
  if(event.source!==frame.contentWindow && m.type==='reloadConfirmed') { frame.src=frame.src; return; }
  if(event.source===frame.contentWindow && event.origin===origin){
    if(['paste','copyText','error','saveSettings'].includes(m.type)) vscode.postMessage(m);
  } else if(event.source!==frame.contentWindow && ['pasteText','copy','copyResult'].includes(m.type)) {
    frame.contentWindow.postMessage(m,origin);
  }
});
</script></body></html>`;
}

export function launcherHtml(script: string, style: string, cspSource: string): string {
  const nonce = randomUUID();
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head>
<body><main><h1>Appium Inspector</h1><p>公式 Inspector を VS Code の中で。</p>
<label>Appium Server URL<input id="server-url" value="http://127.0.0.1:4723" spellcheck="false"></label>
<button id="launch">起動して公式 Inspector を開く</button><button id="open">起動済みの Inspector を開く</button>
<div class="row"><button id="stop">Server 停止</button><button id="logs">ログ</button></div>
<p id="server-state">拡張管理サーバー: 停止中</p>
<button id="check-environment">環境チェック</button>
<details id="environment" hidden><summary>環境チェック結果</summary><p>VS Code が使用するローカル Appium 環境の導入状況です。端末・SDK の動作や、起動済みサーバーの環境は検証しません。</p><div id="environment-results" role="status" aria-live="polite"></div></details>
<details><summary>初回セットアップ</summary><p>Appium 3 と Inspector プラグインが必要です。下のボタンは現在の Appium 環境に公式プラグインをインストールします。</p><button id="install">公式プラグインをインストール</button><p>Android / iOS ドライバーは別途必要です。</p></details>
<details><summary>使い方</summary><p>Capabilities の編集・セッションの開始／終了は、開いた公式 Inspector 内で行います。Server を停止する前にセッションを終了してください。</p></details>
<p id="notice" role="status"></p></main>
<div id="loading" hidden role="status"><span id="loading-label">処理しています…</span></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}
