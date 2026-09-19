(() => {
  const config = __INSPECTOR_STORAGE__;
  const keys = config.keys;
  const storage = window.localStorage;
  const proto = Storage.prototype;
  const set = proto.setItem, remove = proto.removeItem, clear = proto.clear;
  // Only rewrite the remote server endpoint, never capability values or cloud settings.
  function endpoint(key, text, from, to) {
    if (!['SAVED_SESSIONS', 'SESSION_SERVER_PARAMS'].includes(key)) return text;
    const value = JSON.parse(text);
    const servers = key === 'SAVED_SESSIONS' ? value.map(item => item.server) : [value];
    for (const server of servers) {
      const remote = server?.remote;
      if (remote && ['127.0.0.1', 'localhost', '::1', '[::1]', undefined, ''].includes(remote.hostname) && String(remote.port) === from) remote.port = to;
    }
    return JSON.stringify(value);
  }
  try {
    for (const key of keys) {
      if (Object.hasOwn(config.values, key)) set.call(storage, key, endpoint(key, config.values[key], config.upstreamPort, location.port));
      else remove.call(storage, key);
    }
    function save() {
      const values = {};
      for (const key of keys) {
        const value = storage.getItem(key);
        if (value !== null) values[key] = endpoint(key, value, location.port, config.upstreamPort);
      }
      parent.postMessage({ bridge: config.token, type: 'saveSettings', values }, '*');
    }
    proto.setItem = function(key, value) { set.call(this, key, value); if (this === storage && keys.includes(String(key))) save(); };
    proto.removeItem = function(key) { remove.call(this, key); if (this === storage && keys.includes(String(key))) save(); };
    proto.clear = function() { clear.call(this); if (this === storage) save(); };
  } catch {
    parent.postMessage({ bridge: config.token, type: 'error', text: 'Inspector の保存設定を復元できませんでした。' }, '*');
  }
})();
