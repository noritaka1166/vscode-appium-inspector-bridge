const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const previous = vscode.getState();
if (previous?.serverUrl) $('server-url').value = previous.serverUrl;
$('server-url').onchange = () => { vscode.setState({ serverUrl: $('server-url').value }); send('watchServer'); };
function send(type) { vscode.postMessage({ type, serverUrl: $('server-url').value }); }
$('launch').onclick = () => send('startOfficial');
$('open').onclick = () => send('openOfficial');
$('reconnect').onclick = () => send('reconnect');
$('install').onclick = () => send('installOfficial');
$('stop').onclick = () => send('stopServer');
$('logs').onclick = () => send('showOutput');
$('check-environment').onclick = () => send('checkEnvironment');
$('list-devices').onclick = () => send('listDevices');
$('device-select').onchange = () => {
  $('device-caps').value = '';
  $('copy-caps').disabled = true;
  if ($('device-select').value) vscode.postMessage({ type: 'deviceCapabilities', deviceId: $('device-select').value });
};
$('copy-caps').onclick = () => vscode.postMessage({ type: 'copyCapabilities', deviceId: $('device-select').value });
window.addEventListener('message', ({ data }) => {
  if (data.type === 'devices') {
    const select = $('device-select');
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = data.report.devices.length ? '端末を選択してください' : '選択できる端末がありません';
    select.append(placeholder);
    for (const device of data.report.devices) {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = `${device.platform} · ${device.name} · ${device.state} · ${device.udid}`;
      select.append(option);
    }
    select.disabled = !data.report.devices.length;
    $('device-caps').value = ''; $('copy-caps').disabled = true;
    $('device-notes').textContent = data.report.notes.join('\n');
  }
  if (data.type === 'capabilitiesTemplate') { $('device-caps').value = data.text; $('copy-caps').disabled = false; }
  if (data.type === 'connection') {
    const status = { checking: '確認中', connected: '接続中', disconnected: '切断', invalid: 'URLを確認してください（ローカルHTTPのみ対応）' };
    const owner = { managed: '拡張管理', external: '外部起動', unknown: '起動元未確認' };
    $('connection-state').textContent = `${status[data.status]}（${owner[data.owner]}）\n${data.url}`;
    $('connection-state').dataset.status = data.status;
  }
  if (data.type === 'environment') {
    const results = $('environment-results');
    results.replaceChildren();
    const labels = { ok: '確認済み', warning: '注意', error: '要対応', skipped: '未確認' };
    for (const item of data.report.items) {
      const row = document.createElement('section');
      row.dataset.status = item.status;
      const title = document.createElement('strong');
      title.textContent = `${item.name}: ${labels[item.status]}`;
      const detail = document.createElement('p');
      detail.textContent = item.detail;
      row.append(title, detail);
      if (item.action) {
        const action = document.createElement('pre');
        action.textContent = item.action;
        row.append(action);
      }
      results.append(row);
    }
    $('environment').hidden = false;
    $('environment').open = true;
  }
  if (data.type === 'loading') { $('loading').hidden = !data.active; $('loading-label').textContent = data.label || '処理しています…'; document.querySelector('main').inert = data.active; }
  if (data.type === 'server') { $('server-state').textContent = `拡張管理プロセス: ${data.running ? '起動中 — ' + data.url : '停止中'}`; $('stop').disabled = !data.running; }
  if (data.type === 'notice') { $('notice').textContent = data.text; $('notice').dataset.level = data.level; }
});
send('ready');
send('watchServer');
