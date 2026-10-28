// navigator.share and navigator.clipboard recorders (architecture §11.2). The
// real APIs need a user gesture, focus and permissions that a headless run
// does not have; the recorders resolve at once and remember every call.
//   window.fixture.share:      calls(), reject(name = 'AbortError') (the next share rejects, as when the
//                              person closes the sheet), state()
//   window.fixture.clipboard:  text(), writes(), set(text) (what readText returns), deny() / allow()
export function installShare(win) {
  const calls = [];
  let rejectNext = null;
  const share = async (data = {}) => {
    const call = {title: data.title, text: data.text, url: data.url, files: [...(data.files ?? [])].map(f => ({name: f.name, type: f.type, size: f.size}))};
    calls.push(call);
    if (!call.title && !call.text && !call.url && !call.files.length) throw new TypeError('No known share data fields supplied (fixture).');
    if (rejectNext) { const name = rejectNext; rejectNext = null; throw new win.DOMException('Share canceled (fixture).', name); }
  };
  const canShare = (data = {}) => !!(data.title || data.text || data.url || data.files?.length);
  Object.defineProperty(win.navigator, 'share', {configurable: true, writable: true, value: share});
  Object.defineProperty(win.navigator, 'canShare', {configurable: true, writable: true, value: canShare});
  return {
    calls: () => structuredClone(calls),
    reject(name = 'AbortError') { rejectNext = name; },
    state: () => ({count: calls.length, last: calls.length ? structuredClone(calls[calls.length - 1]) : null}),
  };
}

export function installClipboard(win) {
  const writes = [];
  let current = '', denied = false;
  const guard = () => { if (denied) throw new win.DOMException('Clipboard access was denied (fixture).', 'NotAllowedError'); };
  const clipboard = Object.assign(new win.EventTarget(), {
    async writeText(text) { guard(); current = String(text); writes.push({type: 'text/plain', text: current}); },
    async readText() { guard(); return current; },
    async write(items = []) {
      guard();
      for (const item of items) {
        const types = [...(item.types ?? [])];
        const entry = {types};
        if (types.includes('text/plain') && item.getType) entry.text = current = await (await item.getType('text/plain')).text();
        writes.push(entry);
      }
    },
    async read() { guard(); return []; },
  });
  Object.defineProperty(win.navigator, 'clipboard', {configurable: true, get: () => clipboard});
  return {
    text: () => current,
    writes: () => structuredClone(writes),
    set(text) { current = String(text); },
    deny() { denied = true; },
    allow() { denied = false; },
  };
}
