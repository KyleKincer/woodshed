// The fixture's own harness (/__harness/fixture-smoke): a read-only summary of
// the seed, so the smoke state (tests/fixture/states/FX1.cjs) captures a harness
// page end to end: host, preamble, db, styles and masking.
// ?demo=overflow|overlap|clip|placeholder renders one structural problem on
// purpose, so the runner's structural checks can be proven against a real page;
// placeholder-nested (the text next to an icon and a code span), overlap-below
// (2000 px below the fold) and focus-shadow (a resting shadow, no focus ring)
// are the harder cases, and chip-row (a scrolling row of chips) must pass.
const mapLabel = song => {
  const t = song.tempo;
  if (!t) return 'no tempo';
  if (t.songMap?.origin) return `mapped · ${t.songMap.origin}`;
  if (t.songMap) return t.songMap.pins.length > 1 || t.songMap.measures.some((m, i) => m.label && !(i === 0 && m.label === 'Pickup')) ? 'mapped · 1.9 (no origin)' : 'placeholder map';
  if (t.source === 'detected' && t.detected?.length) return 'legacy detected beats';
  if (t.map?.length) return 'legacy sections';
  return 'no map';
};

export default async function mount(el, {fixture, query, h}) {
  const db = fixture.db(), now = new Date(fixture.now()).toISOString();
  const practiced = new Set(db.songPractice.map(p => p.songId));
  const practiceLabel = song => (practiced.has(song.id) ? 'practice v2' : song.practice ? 'practice v1' : 'no practice');
  const deviceName = id => db.devices.find(d => d.id === id)?.displayName ?? db.devices.find(d => d.id === id)?.name ?? '—';
  const presence = id => db.devicePresence.find(p => p.deviceId === id)?.state ?? 'unknown';

  const section = (title, ...children) => h('section', {'aria-labelledby': `fx-${title.toLowerCase()}`}, h('h2', {id: `fx-${title.toLowerCase()}`}, title), ...children);
  const list = (items, render) => h('ul', {}, ...items.map(item => h('li', {}, render(item))));

  el.append(
    h('h1', {}, 'Fixture'),
    h('p', {}, `Seed v${db.meta.seedVersion} · `, h('time', {'data-volatile': '', datetime: now}, now)),
    section('Songs', list(db.songs, s => `${s.title} — ${mapLabel(s)} · ${practiceLabel(s)}${s.hasChart ? ' · drum part' : ''}`)),
    section('Jobs', list(db.jobs, j => `${j.label} — ${j.kind} · ${j.status}${j.status === 'running' ? ` · ${j.stage}` : ''}${j.errorCode ? ` · ${j.errorCode}` : ''}`)),
    section('Devices', list(db.devices, d => `${deviceName(d.id)} — ${presence(d.id)}`)),
    section('Setlists', list(db.setlists, s => `${s.name} — ${s.songIds.length} songs`)),
  );

  // Inline geometry is set through style.cssText, so any h() (src/ui/h.js or the host's fallback) works.
  const styled = (node, css) => { node.style.cssText = css; return node; };
  const demo = query.get('demo');
  // Demos go first, so they are inside the viewport (overlap is checked where it can be hit-tested).
  if (demo === 'overflow') el.prepend(styled(h('div', {'data-scroller': ''}, styled(h('div', {}, 'Too wide for its scroller'), 'width: 400px')), 'overflow: auto; width: 200px'));
  if (demo === 'overlap') el.prepend(styled(h('div', {},
    styled(h('button', {type: 'button'}, 'First'), 'position: absolute; left: 0; top: 0; width: 120px; height: 40px'),
    styled(h('button', {type: 'button'}, 'Second'), 'position: absolute; left: 60px; top: 10px; width: 120px; height: 40px')), 'position: relative; height: 60px'));
  if (demo === 'clip') el.prepend(styled(h('button', {type: 'button'}, 'A label that does not fit'), 'width: 48px; overflow: hidden; white-space: nowrap'));
  if (demo === 'placeholder') el.prepend(h('p', {}, 'Not built yet'));
  if (demo === 'placeholder-nested') {
    const p = h('p', {}, h('span', {'aria-hidden': 'true'}, '◆'), ' Not built yet · ', h('code', {}, '/s/x/edit'));
    el.prepend(p);
  }
  if (demo === 'overlap-below') el.append(styled(h('div', {},
    styled(h('button', {type: 'button'}, 'Third'), 'position: absolute; left: 0; top: 0; width: 120px; height: 40px'),
    styled(h('button', {type: 'button'}, 'Fourth'), 'position: absolute; left: 60px; top: 10px; width: 120px; height: 40px')), 'position: relative; height: 60px; margin-top: 2000px'));
  if (demo === 'chip-row') el.prepend(styled(h('div', {class: 'chips'}, ...Array.from({length: 8}, (_, i) => styled(h('button', {type: 'button', class: 'chip'}, `Section ${i}`), 'flex: none; white-space: nowrap'))), 'display: flex; gap: 8px; overflow-x: auto; width: 200px'));
  if (demo === 'focus-shadow') el.prepend(h('div', {},
    h('style', {}, '.fx-flat:focus { outline: none !important; } .fx-ring:focus-visible { outline: 3px solid rgb(23, 75, 209); outline-offset: 2px; }'),
    styled(h('button', {type: 'button', class: 'fx-flat'}, 'Raised'), 'box-shadow: 0 1px 2px rgba(0,0,0,.2); margin: 8px'),
    styled(h('button', {type: 'button', class: 'fx-ring'}, 'Ringed'), 'margin: 8px')));

  return {unmount() { el.replaceChildren(); }};
}
