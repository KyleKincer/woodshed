// The fixture's first module (architecture §11.2): installed by the fixture's
// Vite plugin ahead of the app's entry (and of every harness page), after the
// classic early.js. It boots the fixture database and installs the fakes,
// then exposes their controls on window.fixture.
//
// Switches read here (the database and the fakes document their own):
//   fx-platform=ipad|mac|win       the navigator looks like that platform (fakes/platform.js)
//   fx-nofeature=<list>            remove features first; a removed feature is never faked (fakes/features.js)
//   fx-audio=manual                AudioContext time moves only through fixture.advance(ms) (fakes/manual-audio.js)
//   fx-desktop=1                   window.woodshedDesktop and the local processor (fakes/desktop-bridge.js, fakes/companion.js)
// Always installed (unless removed): wakeLock, requestMIDIAccess, the Media Session recorder,
// beforeinstallprompt on demand, navigator.share and navigator.clipboard recorders.
//
// window.fixture = {fx, db(), update(fn), reset(), freezeJobs(), changed(),       (db/index.js)
//   now(), platform, removed: [...],
//   advance(ms), audio,                                                        (fx-audio=manual)
//   wakeLock, midi, media, install, share, clipboard,
//   companion, upload, desktop}                                                (fx-desktop=1)
import {fx, installFixtureApi} from './db/index.js';
import {applyPlatform} from './fakes/platform.js';
import {parseFeatures, removeFeatures} from './fakes/features.js';
import {installManualAudio} from './fakes/manual-audio.js';
import {installWakeLock} from './fakes/wake-lock.js';
import {installMidi} from './fakes/midi.js';
import {installMediaSession} from './fakes/media-session.js';
import {installInstallPrompt} from './fakes/install-prompt.js';
import {installShare, installClipboard} from './fakes/share-clipboard.js';
import {createCompanion} from './fakes/companion.js';
import {installDesktopBridge} from './fakes/desktop-bridge.js';

export function installFixture(win, switches) {
  const fixture = installFixtureApi(win);
  fixture.now = () => win.Date.now();
  fixture.platform = applyPlatform(win, switches.platform);
  const removed = removeFeatures(win, parseFeatures(switches.nofeature, win));
  fixture.removed = [...removed];

  if (switches.audio === 'manual') {
    const manual = installManualAudio(win);
    if (manual) Object.assign(fixture, manual);
  } else if (switches.audio !== undefined) win.console.error(`[fixture] fx-audio must be "manual", got ${JSON.stringify(switches.audio)}`);
  if (!fixture.advance) fixture.advance = async () => { throw new Error('fixture.advance needs ?fx-audio=manual'); };

  if (!removed.has('wakelock')) fixture.wakeLock = installWakeLock(win);
  if (!removed.has('midi')) fixture.midi = installMidi(win);
  if (!removed.has('mediasession')) fixture.media = installMediaSession(win);
  fixture.install = installInstallPrompt(win);
  if (!removed.has('share')) fixture.share = installShare(win);
  if (!removed.has('clipboard')) fixture.clipboard = installClipboard(win);

  if (switches.desktop === '1') {
    const companion = createCompanion(win, switches);
    fixture.companion = companion;
    fixture.upload = {calls: companion.uploads};
    fixture.desktop = installDesktopBridge(win, switches);
  }
  return fixture;
}

if (typeof window !== 'undefined' && !globalThis.__FX_DB_MANUAL_BOOT__) installFixture(window, fx);
