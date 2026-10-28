// S2's harness (/__harness/feedback): the ⌘K palette, the ? sheet, toasts and the status-line bus, with the real
// registry and dispatcher, over the fixture's rehearsal song (glasshouse: 64 mapped bars at 120 bpm, 2 s per bar).
//   ?demo=palette [&q=<query>]   opens the palette at load (q: '', '57', '75%', 'loop 41-48', 're-split', 'harb', …)
//   ?demo=shortcuts              opens the ? sheet at load (the Stage chain)
//   ?demo=toast                  shows a toast with an action at load
//   ?layout=band                 the Stage band layout (store.stage.layout = 'band', [data-stage-layout=band])
//   ?song=none                   no open song (the palette's In this song group disappears)
// window.__feedback = {open(name, opts), calls, state(), play(on)} lets states open overlays and read what ran:
//   calls  [[name, ...args]]: commands run (with their args) and transport methods called
//   state()  {palette: {open, items, active}, shortcuts: {open}, toast: toastState(), status: statusLine.value, playing}
import {get as getCommand, provide, registerMany} from '/src/app/commands.js';
import {startDispatcher} from '/src/app/dispatch.js';
import {attachStatusLine, status, statusLine, toast, toastState} from '/src/app/feedback.js';
import {setPlatform} from '/src/app/keys.js';
import {openPalette} from '/src/app/palette.js';
import {platform} from '/src/app/platform.js';
import {openShortcuts} from '/src/app/shortcuts-sheet.js';
import {effect, signal, store} from '/src/app/store.js';
import {SongMapStore} from '/src/js/song-map.js';

const calls = [];
const record = (name, ...args) => { calls.push([name, ...args]); };

function demoCommands() {
  const cmd = (id, title, group, extra = {}) => ({id, title, group, run: (c, args) => record(id, args ?? null), ...extra});
  const withSong = c => !!c.session;
  const defs = [
    cmd('transport.playStop', 'Play / Stop', 'Transport', {keys: ['Space'], scopes: ['stage'], icon: 'play', when: withSong,
      run: () => setPlaying(!store.stage.peek()?.playing)}),
    cmd('transport.again', 'Start again', 'Transport', {keys: ['Enter'], scopes: ['stage'], icon: 'rotate-ccw', when: withSong,
      palette: {keywords: ['repeat', 'restart', 'from the top']}}),
    cmd('transport.loopToggle', 'Loop', 'Loop', {keys: ['KeyL'], scopes: ['stage'], icon: 'repeat', when: withSong}),
    cmd('nav.prevSection', 'Previous section', 'Navigate', {keys: ['[', 'PageUp'], scopes: ['stage'], when: withSong}),
    cmd('nav.nextSection', 'Next section', 'Navigate', {keys: [']', 'PageDown'], scopes: ['stage'], when: withSong}),
    cmd('nav.goTo', 'Go to bar or time…', 'Navigate', {when: withSong}),
    cmd('speed.down', 'Slower (−5%)', 'Speed', {keys: [','], scopes: ['stage'], when: withSong}),
    cmd('speed.up', 'Faster (+5%)', 'Speed', {keys: ['.'], scopes: ['stage'], when: withSong}),
    cmd('speed.set', 'Set speed…', 'Speed', {when: withSong}),
    cmd('trainer.toggle', 'Start / stop trainer', 'Speed', {when: withSong, icon: 'trainer'}),
    cmd('click.countIn', 'Count-in', 'Click', {keys: ['KeyC'], scopes: ['stage'], when: withSong, icon: 'count-in'}),
    cmd('click.toggle', 'Click (continuous)', 'Click', {keys: ['KeyK'], scopes: ['stage'], when: withSong, icon: 'metronome'}),
    cmd('mix.minusMe', 'Minus me', 'Mix', {keys: ['KeyM'], scopes: ['stage'], when: withSong, icon: 'minus-me'}),
    cmd('mix.onlyMe', 'Only me', 'Mix', {keys: ['Shift+KeyM'], scopes: ['stage'], when: withSong}),
    cmd('spot.save', 'Save spot', 'Practice', {keys: ['KeyB'], scopes: ['stage'], when: withSong, icon: 'bookmark'}),
    cmd('spot.open', 'Open spot', 'Practice', {when: withSong}),
    cmd('stage.tapBeat', 'Tap the beat…', 'Practice', {when: withSong, icon: 'hand'}),
    cmd('view.focus', 'Focus', 'View', {keys: ['KeyF'], scopes: ['stage'], when: withSong, icon: 'maximize-2'}),
    cmd('edit.map', 'Edit map', 'Edit', {when: withSong, icon: 'pencil'}),
    cmd('stage.share', 'Share…', 'App', {when: withSong, icon: 'share-2'}),
    cmd('song.resplit', 'Re-split…', 'Library', {icon: 'layers', disabledReason: () => 'Re-split from Woodshed for desktop.'}),
    cmd('app.palette', 'Command palette', 'App', {keys: ['Mod+KeyK'], scopes: ['global'], icon: 'search', run: () => openPalette()}),
    cmd('app.shortcuts', 'Keyboard shortcuts', 'App', {keys: ['?'], scopes: ['global'], icon: 'keyboard', run: () => openShortcuts()}),
    cmd('nav.library', 'Library', 'App', {icon: 'list-music'}),
    cmd('nav.settings', 'Settings…', 'App', {icon: 'settings'}),
    cmd('nav.settings.practice', 'Settings: Practice', 'App', {icon: 'settings'}),
    cmd('nav.settings.appearance', 'Settings: Appearance', 'App', {icon: 'settings'}),
    cmd('library.add', 'Add song…', 'Library', {keys: ['KeyN'], scopes: ['library'], icon: 'plus'}),
    cmd('library.search', 'Search', 'Library', {keys: ['/'], scopes: ['library'], icon: 'search'}),
  ];
  registerMany(defs.filter(d => !getCommand(d.id)));
}

function setPlaying(on) {
  const stage = store.stage.peek();
  if (stage) store.stage.value = {...stage, playing: !!on};
}

function makeTransport(stems) {
  const snapshot = signal({mix: {tracks: stems.map(name => ({name, volume: 1, muted: false, soloed: false}))}});
  const method = name => (...args) => record(`transport.${name}`, ...args);
  return {
    snapshot,
    jump: method('jump'), loopRange: method('loopRange'), loopBars: method('loopBars'), setCountIn: method('setCountIn'),
    setSoloed: method('setSoloed'),
    setMuted: (name, on) => {
      record('transport.setMuted', name, on);
      snapshot.value = {mix: {tracks: snapshot.peek().mix.tracks.map(t => (t.name === name ? {...t, muted: on} : t))}};
    },
  };
}

export default async function mount(el, {fixture, query, h}) {
  setPlatform(platform);            // as boot does (fx-platform=ipad gives ⌘)
  demoCommands();
  const db = fixture.db();
  const song = db.songs.find(s => s.id === 'glasshouse');
  store.library.songs.value = new Map(db.songs.map(s => [s.id, s]));
  store.library.loaded.value = true;

  const band = query.get('layout') === 'band';
  const withSong = query.get('song') !== 'none';
  const map = SongMapStore.fromTempo(structuredClone(song.tempo), song.duration);
  const practice = signal({
    spots: [
      {id: 'sp-bridge', name: 'Bridge fill', a: 72, b: 80, rate: 0.75, passes: 6, updatedAt: 0},
      {id: 'sp-ride', name: 'Ride bell triplets', a: 88, b: 96, rate: 0.85, passes: 2, updatedAt: 0},
    ],
    markers: [{id: 'mk-flam', t: 23.5, label: 'Flam into the chorus', updatedAt: 0}],
    trainer: {start: 0.7, end: 1, step: 0.05, passes: 2},
  });
  const session = withSong ? {id: song.id, readOnly: false, shareToken: null, map, practice: {value: practice}} : null;
  const transport = withSong ? makeTransport((song.stems ?? []).map(s => s.name)) : null;
  const router = {navigate: path => record('router.navigate', path)};
  const offs = [
    provide('session', () => session),
    provide('transport', () => transport),
    provide('router', () => router),
  ];
  document.documentElement.dataset.posture = withSong ? 'stage' : '';
  if (!withSong) document.documentElement.dataset.place = 'library';
  store.stage.value = withSong ? {songId: song.id, layout: band ? 'band' : 'rail', surface: 'chart', playing: false, focus: false} : null;
  const stopDispatcher = startDispatcher();

  const button = (label, onClick, props = {}) => h('button', {
    type: 'button', on: {click: onClick}, ...props,
    style: {minBlockSize: 'var(--h-md)', paddingInline: 'var(--s4)', borderRadius: 'var(--r-control)',
      border: '1px solid var(--line-strong)', background: 'var(--surface-2)', color: 'var(--ink)'},
  }, label);
  const statusEl = h('p', {id: 'fb-status', role: 'status', style: {minBlockSize: 'var(--h-md)', margin: 0, color: 'var(--ink-2)'}});
  const offStatus = attachStatusLine();
  const stopStatus = effect(() => {
    const entry = statusLine.value;
    statusEl.textContent = entry ? entry.text : '';
  });
  const playButton = button('Play', () => setPlaying(!store.stage.peek()?.playing), {id: 'fb-play', 'aria-pressed': 'false'});
  const stopPlay = effect(() => {
    const playing = !!store.stage.value?.playing;
    playButton.setAttribute('aria-pressed', String(playing));
    playButton.textContent = playing ? 'Stop' : 'Play';
  });

  const content = h('div', {
    id: 'fb-content', dataset: withSong ? {stageLayout: band ? 'band' : 'rail'} : {},
    style: {display: 'grid', gap: 'var(--s5)', padding: 'var(--s6)', maxInlineSize: '880px'},
  },
  h('h1', {style: {margin: 0, fontSize: 'var(--fs-24)'}}, withSong ? `${song.title} · ${song.artist}` : 'Library'),
  h('p', {style: {margin: 0, color: 'var(--ink-2)'}}, 'Press ⌘K (Ctrl+K) for the palette and ? for the shortcut sheet.'),
  h('div', {style: {display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)'}},
    button('Command palette', () => openPalette(), {id: 'fb-palette'}),
    button('Keyboard shortcuts', () => openShortcuts(), {id: 'fb-shortcuts'}),
    button('Toast', () => toast('Harbor Lights is ready', {tone: 'ok', action: {label: 'Practice', run: () => record('toast.practice')}}), {id: 'fb-toast'}),
    button('Error toast', () => toast('Couldn’t save the practice. Check your connection.', {tone: 'error', action: {label: 'Try again', run() {}}}), {id: 'fb-error'}),
    button('Status line', () => status('Played 4 times'), {id: 'fb-status-btn'}),
    playButton),
  statusEl);
  el.append(content);

  window.__feedback = {
    calls,
    open(name, opts = {}) {
      if (name === 'palette') return openPalette(opts);
      if (name === 'shortcuts') return openShortcuts(opts);
      throw new Error(`unknown overlay ${name}`);
    },
    play: setPlaying,
    state() {
      const palette = document.querySelector('dialog.app-palette');
      const input = palette?.querySelector('input');
      const active = input?.getAttribute('aria-activedescendant');
      return {
        palette: {
          open: !!palette?.open,
          items: palette ? [...palette.querySelectorAll('[role=option]')].map(o => ({
            title: o.querySelector('.app-palette-title').textContent, group: o.dataset.group, disabled: o.getAttribute('aria-disabled') === 'true',
            reason: o.querySelector('.app-palette-reason')?.textContent ?? null,
          })) : [],
          active: active ? document.getElementById(active)?.querySelector('.app-palette-title')?.textContent ?? null : null,
        },
        shortcuts: {open: !!document.querySelector('dialog.app-shortcuts')?.open},
        toast: toastState(),
        status: statusLine.value,
        playing: !!store.stage.peek()?.playing,
      };
    },
  };

  const demo = query.get('demo');
  if (demo === 'palette') openPalette({query: query.get('q') ?? ''});
  else if (demo === 'shortcuts') openShortcuts();
  else if (demo === 'toast') toast('Adding Harbor Lights', {action: {label: 'Undo', run: () => record('toast.undo')}, durationMs: Infinity});

  return () => {
    stopPlay();
    stopStatus();
    offStatus();
    stopDispatcher();
    for (const off of offs) off();
  };
}
