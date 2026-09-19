const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const previous = vscode.getState();
if (previous?.serverUrl) $('server-url').value = previous.serverUrl;
$('server-url').onchange = () => vscode.setState({ serverUrl: $('server-url').value });
function send(type) { vscode.postMessage({ type, serverUrl: $('server-url').value }); }
$('launch').onclick = () => send('startOfficial');
$('open').onclick = () => send('openOfficial');
$('install').onclick = () => send('installOfficial');
$('stop').onclick = () => send('stopServer');
$('logs').onclick = () => send('showOutput');
window.addEventListener('message', ({ data }) => {
  if (data.type === 'loading') { $('loading').hidden = !data.active; $('loading-label').textContent = data.label || '処理しています…'; document.querySelector('main').inert = data.active; }
  if (data.type === 'server') { $('server-state').textContent = `拡張管理サーバー: ${data.running ? '起動中' : '停止中'}`; $('stop').disabled = !data.running; }
  if (data.type === 'notice') { $('notice').textContent = data.text; $('notice').dataset.level = data.level; }
});
send('ready');
