const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const text = window.appiumInspectorText || { selectDevice: 'Select a device', noDevices: 'No selectable devices found', checking: 'Checking', connected: 'Connected', disconnected: 'Disconnected', invalidUrl: 'Check the URL (local HTTP only)', managed: 'Extension-managed', external: 'External', unknown: 'Unknown origin', verified: 'Verified', warning: 'Warning', actionRequired: 'Action required', notChecked: 'Not checked', working: 'Working…', managedProcess: 'Extension-managed process', running: 'Running', stopped: 'Stopped' };
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
function showDevices(data) {
  const select = $('device-select');
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = data.report.devices.length ? text.selectDevice : text.noDevices;
  select.append(placeholder);
  for (const device of data.report.devices) {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = `${device.platform} · ${device.name} · ${device.state} · ${device.udid}`;
    select.append(option);
  }
  select.disabled = !data.report.devices.length;
  $('device-caps').value = '';
  $('copy-caps').disabled = true;
  $('device-notes').textContent = data.report.notes.join('\n');
}

function showCapabilities(data) {
  $('device-caps').value = data.text;
  $('copy-caps').disabled = false;
}

function showConnection(data) {
  const status = { checking: text.checking, connected: text.connected, disconnected: text.disconnected, invalid: text.invalidUrl };
  const owner = { managed: text.managed, external: text.external, unknown: text.unknown };
  $('connection-state').textContent = `${status[data.status]}（${owner[data.owner]}）\n${data.url}`;
  $('connection-state').dataset.status = data.status;
}

function showEnvironment(data) {
  const results = $('environment-results');
  results.replaceChildren();
  const labels = { ok: text.verified, warning: text.warning, error: text.actionRequired, skipped: text.notChecked };
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

function showLoading(data) {
  $('loading').hidden = !data.active;
  $('loading-label').textContent = data.label || text.working;
  document.querySelector('main').inert = data.active;
}

function showServer(data) {
  $('server-state').textContent = `${text.managedProcess}: ${data.running ? text.running + ' — ' + data.url : text.stopped}`;
  $('stop').disabled = !data.running;
}

function showNotice(data) {
  $('notice').textContent = data.text;
  $('notice').dataset.level = data.level;
}

const messageHandlers = {
  devices: showDevices,
  capabilitiesTemplate: showCapabilities,
  connection: showConnection,
  environment: showEnvironment,
  loading: showLoading,
  server: showServer,
  notice: showNotice
};

window.addEventListener('message', ({ data }) => messageHandlers[data.type]?.(data));
send('ready');
send('watchServer');
