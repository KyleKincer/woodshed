// PV1's states: the playthrough video (shared/video.ts) in the app on the fixture database, with the fixture's
// fake YouTube player (fakes/youtube.js).
//   pv1-add          ⋯ › Add a playthrough video…: a YouTube link (t=14) is added and saved with the song; the video sits
//                    beside the chart on the rail (above it on the band), the chart keeps the rest; axe on the sheet
//   pv1-follow       playing: the video plays along, the song's time + 14 s; paused, it waits on the song's frame;
//                    a nudge moves it at once
//   pv1-hide         the video's ⋯ › Hide video gives the music its whole width back; ⋯ › Show video and Y bring it back
//   pv1-crop         YouTube's title bar and pause overlays stay outside the picture: the frame overhangs the 16:9 box
//   pv1-angles       two angles: a thumbnail beside the music, ⇧Y switches, Show all angles plays both in step
//   pv1-float        Floating: a corner window over the music (which keeps its whole area); dragged, it snaps to a corner
//   pv1-wide         a 2560×1440 screen: the divider widens the video, remembered
//   pv1-phone        a phone: the video above the music at the full width (or half the height), its controls on it
//   pv1-blocked      a video its owner won't let play elsewhere: the sentence and Open on YouTube
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');

const APP = (query = '') => `/s/glasshouse?fx-reset=1&fx-jobs=0&fx-now=2026-10-28T12:00:00Z${query ? `&${query}` : ''}`;
const LINK = 'https://youtu.be/dQw4w9WgXcQ?t=14';

async function addVideo(page, t, link = LINK, {menu = 'Add a playthrough video…'} = {}) {
  await t.loadPhase('ready');
  await page.getByRole('button', {name: 'More…'}).click();
  await page.getByRole('menuitem', {name: menu}).click();
  const sheet = page.locator('[data-sheet="video"]');
  await sheet.locator('.sheet-video-input[type=url]').waitFor({timeout: 10_000});
  await sheet.locator('.sheet-video-input[type=url]').fill(link);
  await sheet.getByRole('button', {name: /^Add (video|another angle)$/}).click();
  await page.waitForSelector('.stage-video-panel', {timeout: 10_000});
  return sheet;
}

/** The chart re-engraves for its new width 250 ms after the video column comes or goes (chart.js RESIZE_SETTLE_MS). */
const settleChart = (page) => page.waitForFunction(() => {
  const el = document.querySelector('.chart-scroll');
  return !el || el.scrollWidth <= el.clientWidth + 1;
}, null, {timeout: 5_000});

const box = (page, sel) => page.evaluate((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return r ? {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)} : null;
}, sel);

module.exports = [
  {
    name: 'pv1-add', url: APP(), opts: {ready: 'stage'},
    async fn(page, t) {
      const sheet = await addVideo(page, t);
      await page.waitForFunction(() => window.fixture.db().songs.find((s) => s.id === 'glasshouse')?.videos?.length === 1, null, {timeout: 5_000});
      const saved = await page.evaluate(() => window.fixture.db().songs.find((s) => s.id === 'glasshouse').videos[0]);
      t.expect(saved.videoId === 'dQw4w9WgXcQ' && saved.offset === 14, `saved with the song: the recording starts at 0:14 in the video (${JSON.stringify(saved)})`);
      t.expect(await sheet.locator('.sheet-video-time').inputValue() === '0:14.0', 'the start time shows 0:14.0');
      const problems = await checkAxe(page, {include: ['[data-sheet="video"]']});
      t.expect(!problems.length, `axe on the sheet: ${problems.join('; ')}`);
      await t.capture('sheet');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const music = await box(page, '.stage-music'), video = await box(page, '.stage-video');
      const layout = await page.evaluate(() => document.querySelector('.stage').dataset.stageLayout);
      if (layout === 'rail') t.expect(video.x >= music.x + music.w - 1 && video.w >= 280, `rail: the video beside the music (${JSON.stringify({music, video})})`);
      else t.expect(video.y + video.h <= music.y + 1, `band: the video above the music (${JSON.stringify({music, video})})`);
      const frame = await box(page, '.stage-video-box');
      t.expect(Math.abs(frame.w / frame.h - 16 / 9) < 0.05, `16:9 (${JSON.stringify(frame)})`);
    },
  },
  {
    name: 'pv1-follow', url: APP(), opts: {ready: 'stage', devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await addVideo(page, t);
      await page.keyboard.press('Escape');
      const facts = () => page.evaluate(() => {
        const s = window.__woodshed.activeSession();
        return {song: s.transport.position(), video: window.fixture.youtube.players()[0]};
      });
      // Stopped: paused on the song's frame.
      await page.waitForFunction(() => window.fixture.youtube.players()[0]?.seeks.length > 0, null, {timeout: 5_000});
      let f = await facts();
      t.expect(!f.video.playing && Math.abs(f.video.time - (f.song + 14)) < 0.06, `stopped: the video waits at the song's time + 14 s (${JSON.stringify(f)})`);
      await page.evaluate(() => window.__woodshed.commands.run('transport.playStop', {source: 'pointer'}));
      await page.waitForTimeout(3000);
      f = await facts();
      t.expect(f.video.playing && Math.abs(f.video.time - (f.song + 14)) < 0.3, `playing: the video plays along (${JSON.stringify(f)})`);
      await t.capture('playing');
      // A nudge moves it while it plays.
      await page.evaluate(() => window.__woodshed.commands.run('stage.video', {source: 'pointer'}));
      await page.locator('[data-sheet="video"]').getByRole('button', {name: 'Later by 1 s'}).click();
      await page.waitForTimeout(2000);
      f = await facts();
      t.expect(Math.abs(f.video.time - (f.song + 15)) < 0.4, `a nudge moves it at once (${JSON.stringify(f)})`);
      await page.evaluate(() => window.__woodshed.commands.run('transport.playStop', {source: 'pointer'}));
      await page.waitForTimeout(600);
      f = await facts();
      t.expect(!f.video.playing, 'stopped again: the video pauses');
      await page.keyboard.press('Escape');
      await settleChart(page);
    },
  },
  {
    name: 'pv1-hide', url: APP(), opts: {ready: 'stage', devices: ['laptop'], themes: ['light']},
    async fn(page, t) {
      await addVideo(page, t);
      await page.keyboard.press('Escape');
      const before = await box(page, '.stage-music');
      await page.locator('.stage-video-box').hover();
      await page.getByRole('button', {name: 'Video options'}).click();
      await page.getByRole('menuitem', {name: /Hide video/}).click();
      await page.waitForFunction(() => document.querySelector('.stage-video')?.hidden === true);
      const after = await box(page, '.stage-music');
      t.expect(after.w > before.w + 200, `the music gets its width back (${before.w} → ${after.w})`);
      await page.getByRole('button', {name: 'More…'}).click();
      await page.getByRole('menuitemcheckbox', {name: 'Show video'}).click();
      await page.waitForSelector('.stage-video-panel');
      t.expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ws.prefs')).video.show) === true, 'Show video is this device\'s');
      // Y hides it and brings it back.
      await page.keyboard.press('y');
      await page.waitForFunction(() => document.querySelector('.stage-video')?.hidden === true);
      await page.keyboard.press('y');
      await page.waitForSelector('.stage-video-panel');
      await settleChart(page);
    },
  },
  {
    // YouTube's chrome stays outside the picture: the frame is taller than the box by a band above and below.
    name: 'pv1-crop', url: APP(), opts: {ready: 'stage', devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await addVideo(page, t);
      await page.keyboard.press('Escape');
      const f = await page.evaluate(() => {
        const box = document.querySelector('.stage-video-box').getBoundingClientRect();
        const frame = document.querySelector('.stage-video-frame').getBoundingClientRect();
        return {box: {top: box.top, h: box.height, w: box.width}, frame: {top: frame.top, h: frame.height}};
      });
      t.expect(f.frame.top <= f.box.top - 60 && f.frame.h >= f.box.h + 120, `the frame overhangs the box above and below (${JSON.stringify(f)})`);
      t.expect(Math.abs(f.box.w / f.box.h - 16 / 9) < 0.05, 'the picture is 16:9');
      await settleChart(page);
    },
  },
  {
    // Two angles: beside the music the other waits as a thumbnail; Show all angles plays both; above the music, chips.
    name: 'pv1-angles', url: APP(), opts: {ready: 'stage', devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await addVideo(page, t);
      const sheet = page.locator('[data-sheet="video"]');
      await sheet.locator('.sheet-video-input[type=url]').fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
      await sheet.getByRole('button', {name: 'Add another angle'}).click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelectorAll('.stage-video-thumb').length === 1, null, {timeout: 5_000});
      t.expect(await page.evaluate(() => document.querySelector('.stage-video-panel').dataset.videoId) === 'aqz-KE-bpKQ', 'the angle just added is shown');
      await t.capture('thumbs');
      await page.locator('.stage-video-thumb').click();
      await page.waitForFunction(() => document.querySelector('.stage-video-panel').dataset.videoId === 'dQw4w9WgXcQ');
      await page.keyboard.press('Shift+Y');
      await page.waitForFunction(() => document.querySelector('.stage-video-panel').dataset.videoId === 'aqz-KE-bpKQ');
      await page.locator('.stage-video-box').first().hover();
      await page.getByRole('button', {name: 'Video options'}).click();
      await page.getByRole('menuitemcheckbox', {name: 'Show all angles'}).click();
      await page.waitForFunction(() => document.querySelectorAll('.stage-video-box').length === 2);
      const players = await page.evaluate(() => window.fixture.youtube.players().length);
      t.expect(players === 2, `both angles play (${players} players)`);
      await t.capture('all');
      await page.evaluate(() => window.__woodshed.commands.run('transport.playStop', {source: 'pointer'}));
      await page.waitForTimeout(2000);
      const times = await page.evaluate(() => window.fixture.youtube.players().map((p) => p.time));
      // Each plays at the song's time plus its own offset (14 s and 0 s): 14 s apart, in step.
      t.expect(Math.abs(Math.abs(times[0] - times[1]) - 14) < 0.3, `the angles play in step (${times})`);
      await page.evaluate(() => window.__woodshed.commands.run('transport.playStop', {source: 'pointer'}));
      await settleChart(page);
    },
  },
  {
    // Floating: a window in a corner of the music, which keeps its whole width; dragged to another corner, it snaps there.
    name: 'pv1-float', url: APP(), opts: {ready: 'stage', devices: ['laptop', 'ipad'], themes: ['dark']},
    async fn(page, t) {
      await addVideo(page, t);
      await page.locator('[data-sheet="video"]').getByRole('radio', {name: 'Floating'}).click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('.stage-video')?.dataset.dock === 'float');
      await settleChart(page);
      const music = await box(page, '.stage-music'), body = await box(page, '.stage-body'), video = await box(page, '.stage-video');
      t.expect(music.w >= body.w - 1 && music.h >= body.h - 1, `the music keeps the whole area (${JSON.stringify({music, body})})`);
      t.expect(video.x + video.w <= body.x + body.w && video.y + video.h <= body.y + body.h && video.x > body.x + body.w / 2, `bottom-right corner (${JSON.stringify(video)})`);
      await t.capture('float');
      const shield = await box(page, '.stage-video-shield');
      await page.mouse.move(shield.x + shield.w / 2, shield.y + shield.h / 2);
      await page.mouse.down();
      await page.mouse.move(body.x + 60, body.y + 60, {steps: 8});
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('.stage-video').dataset.corner === 'tl');
      t.expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ws.prefs')).video.float.corner) === 'tl', 'dragged to the top-left corner and remembered');
    },
  },
  {
    // A 1440p monitor: beside the music, sized by dragging the divider.
    name: 'pv1-wide', url: APP(), opts: {ready: 'stage', devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await page.setViewportSize({width: 2560, height: 1440});
      await addVideo(page, t);
      await page.keyboard.press('Escape');
      await settleChart(page);
      const before = await box(page, '.stage-video');
      const divider = await box(page, '.stage-video-divider');
      await page.mouse.move(divider.x + divider.w / 2, divider.y + divider.h / 2);
      await page.mouse.down();
      await page.mouse.move(divider.x - 300, divider.y + divider.h / 2, {steps: 6});
      await page.mouse.up();
      await settleChart(page);
      const after = await box(page, '.stage-video');
      t.expect(after.w > before.w + 250, `the divider widens the video (${before.w} → ${after.w})`);
      t.expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ws.prefs')).video.side) > 0.4, 'the size is remembered');
      await t.capture('wide');
    },
  },
  {
    // A phone: above the music, the full width, the controls on the video.
    name: 'pv1-phone', url: APP('fx-platform=ipad'), opts: {ready: 'stage', devices: ['ipad'], themes: ['dark']},
    async fn(page, t) {
      await page.setViewportSize({width: 393, height: 852});
      await addVideo(page, t);
      await page.keyboard.press('Escape');
      await settleChart(page);
      const video = await box(page, '.stage-video-box'), body = await box(page, '.stage-body'), dock = await box(page, '.stage-video');
      // The full width, unless that would take more than half the music's height (TOP_AUTO_MAX_NARROW).
      t.expect(video.w >= body.w - 24 || dock.h >= body.h * 0.5 - 4, `the full width, or half the height (${video.w} of ${body.w}; ${dock.h} of ${body.h})`);
      const tools = await page.evaluate(() => getComputedStyle(document.querySelector('.stage-video-overlay')).opacity);
      t.expect(tools === '1', `touch: the controls stay on the video (${tools})`);
      await t.capture('phone');
    },
  },
  {
    name: 'pv1-blocked', url: APP('fx-video=blocked'), opts: {ready: 'stage', devices: ['laptop'], themes: ['dark']},
    async fn(page, t) {
      await addVideo(page, t);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('.stage-video-panel')?.dataset.status === 'error', null, {timeout: 5_000});
      const text = await page.locator('.stage-video-status').innerText();
      t.expect(text.includes('doesn’t allow it to play in other apps') && text.includes('Open on YouTube'), `the sentence and the link (${text})`);
      await settleChart(page);
      await t.capture('blocked');
    },
  },
];
