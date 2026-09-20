(() => {
  const token = __BRIDGE_TOKEN__;
  // VS Code normally supplies the parent Webview URL as referrer. Some hosts omit it;
  // in that case, source + unguessable bridge token still authenticate replies.
  const targetOrigin = document.referrer ? new URL(document.referrer).origin : '*';
  const writes = new Map();
  let sequence = 0;
  function writeText(text) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { writes.delete(id); reject(new Error('クリップボード書き込みがタイムアウトしました。')); }, 5000);
      writes.set(id, { resolve, reject, timer });
      parent.postMessage({ bridge: token, type: 'copyText', text: String(text), id }, targetOrigin);
    });
  }
  // Upstream Selected Element rows call this API, independently of keyboard events.
  if (navigator.clipboard) {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText });
  } else {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  }
  let field = null;
  const editable = node => node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'password', 'email'].includes(node.type));
  document.addEventListener('focusin', event => { if (editable(event.target)) field = event.target; });
  function notify(type, text) { parent.postMessage({ bridge: token, type, text }, targetOrigin); }
  document.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if (event.key.toLowerCase() === 'v' && editable(event.target)) { event.preventDefault(); event.stopPropagation(); notify('paste'); }
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); event.stopPropagation(); copy(); }
    if (event.key.toLowerCase() === 'a' && editable(event.target)) { event.preventDefault(); event.target.select(); }
  }, true);
  function copy() {
    const active = document.activeElement;
    const text = editable(active) ? active.value.slice(active.selectionStart, active.selectionEnd) : window.getSelection()?.toString();
    if (text) writeText(text).catch(error => notify('error', error.message));
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || (targetOrigin !== '*' && event.origin !== targetOrigin) || event.data?.bridge !== token) return;
    if (event.data.type === 'copyResult') {
      const pending = writes.get(event.data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      writes.delete(event.data.id);
      event.data.error ? pending.reject(new Error(event.data.error)) : pending.resolve();
      return;
    }
    if (event.data.type === 'selectAll') { if (field?.isConnected) { field.focus(); field.select(); } return; }
    if (event.data.type === 'copy') { copy(); return; }
    if (event.data.type !== 'pasteText' || typeof event.data.text !== 'string') return;
    if (!field?.isConnected || field.disabled || field.readOnly) { notify('error', '鉛筆アイコンを押し、編集する入力欄をクリックしてから貼り付けてください。'); return; }
    field.focus();
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    const value = field.value.slice(0, start) + event.data.text + field.value.slice(end);
    // Call the native setter so React's controlled TextArea sees a genuine value change.
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
    field.setSelectionRange(start + event.data.text.length, start + event.data.text.length);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
})();
