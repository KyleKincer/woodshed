// PV1's states: the playthrough video (shared/video.ts) in the app on the fixture database, with the fixture's
// fake YouTube player (fakes/youtube.js).
//   pv1-add          ⋯ › Playthrough video…: a YouTube link (t=14) is added and saved with the song; the video sits
//                    beside the chart on the rail (above it on the band), the chart keeps the rest; axe on the sheet
//   pv1-follow       playing: the video plays along, the song's time + 14 s; paused, it waits on the song's frame;
//                    a nudge moves it at once
//   pv1-hide         ✕ Hide video gives the music its whole width back; ⋯ › Show video brings it back
//   pv1-blocked      a video its owner won't let play elsewhere: the sentence and Open on YouTube
'use strict';

const {checkAxe} = require('../probes/probe-axe.cjs');

const APP = (query = '') => `/s/glasshouse?fx-reset=1&fx-jobs=0&fx-now=2026-10-28T12:00:00Z${query ? `&${query}` : ''}`;
const LINK = 'https://youtu.be/dQw4w9WgXcQ?t=14';

async function addVideo(page, t) {
  await t.loadPhase('ready');
  await page.getByRole('button', {name: 'More…'}).click();
  await page.getByRole('menuitem', {name: 'Playthrough video…'}).click();
  const sheet = page.locator('[data-sheet="video"]');
  await sheet.locator('.sheet-video-input').waitFor({timeout: 10_000});
  await sheet.locator('.sheet-video-input').fill(LINK);
  await sheet.getByRole('button', {name: 'Add video'}).click();
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
      await page.getByRole('button', {name: 'Hide video'}).click();
      await page.waitForFunction(() => document.querySelector('.stage-video')?.hidden === true);
      const after = await box(page, '.stage-music');
      t.expect(after.w > before.w + 200, `the music gets its width back (${before.w} → ${after.w})`);
      await page.getByRole('button', {name: 'More…'}).click();
      await page.getByRole('menuitemcheckbox', {name: 'Show video'}).click();
      await page.waitForSelector('.stage-video-panel');
      t.expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ws.prefs')).video.show) === true, 'Show video is this device\'s');
      await settleChart(page);
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
