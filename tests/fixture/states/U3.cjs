// U3's states: the display primitives on their harness (/__harness/display).
//   u3-display           the desk gallery (4 variants): key-caps hidden on touch, platform labels,
//                        hint caps, target sizes, focus rings, determinate and shimmering rails
//   u3-display-reduced   reduced motion: the indeterminate rail rests at 90%, nothing animates
//   u3-tooltip           hover and keyboard focus show the tooltip after 400 ms in the top layer
//   u3-tabs-keys         roving tablists in Chromium: arrows, disabled skip, manual and auto activation
//   u3-stage             readouts and beat lamps on every Stage layout × Distance: computed sizes,
//                        minCh, lamp geometry (D15) and the --now dot
'use strict';

const {checkTargets} = require('../probes/probe-targets.cjs');
const {walkFocus} = require('../probes/probe-focus.cjs');

const DESK = '/__harness/display';
const STAGE = '/__harness/display?part=stage&place=stage';

const px = v => Math.round(parseFloat(v) * 10) / 10;
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

/** Runs in the page: the Kbd facts for this device. */
function kbdFacts() {
  const touchOnly = matchMedia('(hover: none) and (pointer: coarse)').matches;
  const caps = [...document.querySelectorAll('[data-testid=kbd-row] > kbd.ui-kbd')];
  const visible = el => el.checkVisibility();
  return {
    touchOnly,
    coarse: matchMedia('(pointer: coarse)').matches,
    labels: caps.map(k => k.textContent),
    hidden: caps.filter(k => !('force' in k.dataset)).map(k => !visible(k)),
    forcedVisible: visible(document.querySelector('[data-testid=kbd-forced]')),
    hint: (() => { const el = document.querySelector('[data-kbd-hints] kbd[data-hint]'); return {hidden: el.hidden, visible: visible(el)}; })(),
  };
}

/** Runs in the page: the rails' computed fill scale and running animations. */
function railFacts() {
  const out = {};
  for (const rail of document.querySelectorAll('.ui-progress-rail')) {
    const name = rail.getAttribute('aria-label');
    const fill = rail.querySelector('.ui-progress-rail-fill');
    const m = new DOMMatrixReadOnly(getComputedStyle(fill).transform);
    out[name] = {scale: Math.round(m.a * 100) / 100, motion: rail.dataset.motion ?? null, animations: fill.getAnimations().filter(a => a.playState === 'running').length, valuenow: rail.getAttribute('aria-valuenow')};
  }
  const ring = document.querySelector('[data-testid=ring-indeterminate]');
  out.ring = {motion: ring.dataset.motion, animations: ring.querySelector('svg').getAnimations().filter(a => a.playState === 'running').length};
  out.skeletonAnimations = [...document.querySelectorAll('.ui-skeleton-block')].reduce((n, b) => n + b.getAnimations().filter(a => a.playState === 'running').length, 0);
  return out;
}

module.exports = [
  {
    name: 'u3-display',
    url: DESK,
    async fn(page, t) {
      const k = await page.evaluate(kbdFacts);
      const ipad = t.device === 'ipad';
      t.expect(k.coarse === ipad, `pointer: coarse is ${k.coarse} on ${t.device}`);
      t.expect(k.touchOnly === ipad, `the touch-only query is ${k.touchOnly} on ${t.device}`);
      t.expect(k.hidden.every(h => h === ipad), `key-caps hidden=${ipad} on ${t.device}: ${JSON.stringify(k.hidden)}`);
      t.expect(k.forcedVisible, 'a forced key-cap stays visible');
      t.expect(k.hint.visible === !ipad && k.hint.hidden === ipad, `a hint cap under [data-kbd-hints] shows only on fine pointers: ${JSON.stringify(k.hint)}`);
      const search = ipad ? '⌘K' : 'Ctrl+K';
      t.expect(k.labels[0] === search, `Mod+KeyK reads ${search} on ${t.device} (got ${k.labels[0]})`);
      t.expect(k.labels[1] === (ipad ? '⇧Space' : 'Shift+Space'), `Shift+Space label on ${t.device} (got ${k.labels[1]})`);

      const rails = await page.evaluate(railFacts);
      t.expect(rails.Uploading.scale === 0.39 && rails.Uploading.valuenow === '39', `determinate rail at 39%: ${JSON.stringify(rails.Uploading)}`);
      t.expect(rails.Done.scale === 1, 'a finished rail is full');
      t.expect(rails.Finishing.motion === 'animate' && rails.Finishing.animations === 1 && rails.Finishing.valuenow === null, `an indeterminate rail shimmers: ${JSON.stringify(rails.Finishing)}`);
      t.expect(rails.ring.motion === 'animate' && rails.ring.animations === 1, 'an indeterminate ring turns');
      t.expect(rails.skeletonAnimations > 0, 'skeletons shimmer');

      const targets = await checkTargets(page);
      t.expect(!targets.length, `targets: ${targets.join('; ')}`);
      if (!ipad) {
        const focus = await walkFocus(page, {stops: 40});
        t.expect(!focus.length, focus.join('; '));
      }
      // Captures: the top (the runner's own) and the lower half (empty states, skeletons).
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.evaluate(() => { const main = document.getElementById('harness'); main.scrollTop = main.scrollHeight; });
      await t.capture('lower');
      await page.evaluate(() => { document.getElementById('harness').scrollTop = 0; });
    },
  },
  {
    name: 'u3-display-reduced',
    url: DESK,
    async fn(page, t) {
      const rails = await page.evaluate(railFacts);
      t.expect(rails.Finishing.motion === 'static', `reduced motion: data-motion=static (${rails.Finishing.motion})`);
      t.expect(rails.Finishing.scale === 0.9, `reduced motion: the indeterminate rail rests at 90% (${rails.Finishing.scale})`);
      t.expect(rails.Finishing.animations === 0, 'reduced motion: the rail does not animate');
      t.expect(rails.Finishing.valuenow === null, 'reduced motion: still indeterminate for assistive tech');
      t.expect(rails.ring.motion === 'static' && rails.ring.animations === 0, 'reduced motion: the ring holds still');
      t.expect(rails.skeletonAnimations === 0, 'reduced motion: skeletons do not shimmer');
    },
    opts: {reducedMotion: 'reduce', devices: ['laptop'], themes: ['light']},
  },
  {
    name: 'u3-tooltip',
    url: DESK,
    async fn(page, t) {
      const zoom = page.getByRole('button', {name: 'Zoom in'});
      await zoom.scrollIntoViewIfNeeded();
      await zoom.hover();
      const early = await page.evaluate(() => !!document.querySelector('[role=tooltip]'));
      t.expect(!early, 'no tooltip before the delay');
      const tip = page.getByRole('tooltip');
      await tip.waitFor({state: 'visible', timeout: 3000});
      const facts = await page.evaluate(() => {
        const tipEl = document.querySelector('[role=tooltip]');
        const b = document.querySelector('[data-testid=tip-zoom-in]');
        const tr = tipEl.getBoundingClientRect(), br = b.getBoundingClientRect();
        return {
          text: tipEl.textContent, open: tipEl.matches(':popover-open'), placement: tipEl.dataset.placement,
          above: tr.bottom <= br.top, inside: tr.left >= 0 && tr.right <= innerWidth && tr.top >= 0,
          describedby: b.getAttribute('aria-describedby') === tipEl.id, count: document.querySelectorAll('[role=tooltip]').length,
        };
      });
      t.expect(facts.text === 'Zoom the chart in=', `tooltip text with its key-cap (${facts.text})`);
      t.expect(facts.open, 'the tooltip is in the top layer');
      t.expect(facts.placement === 'top' && facts.above && facts.inside, `placed above the anchor inside the viewport: ${JSON.stringify(facts)}`);
      t.expect(facts.describedby && facts.count === 1, 'one tooltip, describing its anchor');
      await t.capture('hover');
      await page.mouse.move(2, 2);
      await tip.waitFor({state: 'detached', timeout: 2000});
      // Keyboard: focus the next button with Tab from the first, then Escape.
      await page.getByRole('button', {name: 'Zoom in'}).focus();
      await page.keyboard.press('Tab');
      await page.getByRole('tooltip').waitFor({state: 'visible', timeout: 3000});
      t.expect(await page.getByRole('tooltip').textContent() === 'Loop this sectionL', 'keyboard focus shows the Loop tooltip');
      await page.keyboard.press('Escape');
      await page.getByRole('tooltip').waitFor({state: 'detached', timeout: 2000});
    },
    opts: {devices: ['laptop'], capture: false},
  },
  {
    name: 'u3-tabs-keys',
    url: DESK,
    async fn(page, t) {
      const posture = page.getByRole('tablist', {name: 'Edit'});
      await posture.getByRole('tab', {name: 'Map'}).focus();
      await page.keyboard.press('ArrowRight');
      const focused = () => page.evaluate(() => document.activeElement?.textContent);
      t.expect(await focused() === 'Chart', 'ArrowRight moves focus to Chart');
      t.expect(await posture.getByRole('tab', {name: 'Map'}).getAttribute('aria-selected') === 'true', 'manual activation: Map stays selected');
      await page.keyboard.press('Enter');
      t.expect(await posture.getByRole('tab', {name: 'Chart'}).getAttribute('aria-selected') === 'true', 'Enter selects Chart');
      t.expect(await page.getByTestId('tab-panel').textContent() === 'Chart', 'the panel follows');
      await page.keyboard.press('End');
      t.expect(await focused() === 'Details', 'End goes to Details');
      await page.keyboard.press('ArrowRight');
      t.expect(await focused() === 'Map', 'ArrowRight wraps');
      const tabStops = await posture.locator('[role=tab][tabindex="0"]').count();
      t.expect(tabStops === 1, 'one tab stop per tablist');

      const settings = page.getByRole('tablist', {name: 'Settings'});
      await settings.getByRole('tab', {name: 'Audio'}).focus();
      await page.keyboard.press('ArrowRight');
      t.expect(await focused() === 'This device', 'the disabled Pedals tab is skipped');
      t.expect(await settings.getByRole('tab', {name: 'This device'}).getAttribute('aria-selected') === 'true', 'auto activation selects on arrow');
      await page.keyboard.press('Shift+Tab');
      t.expect(!(await page.evaluate(() => document.activeElement?.closest('[role=tablist][aria-label=Settings]'))), 'Shift+Tab leaves the tablist in one step');
    },
    opts: {devices: ['laptop'], capture: false},
  },
  {
    name: 'u3-stage',
    url: STAGE,
    async fn(page, t) {
      const facts = await page.evaluate(() => {
        const out = {};
        for (const block of document.querySelectorAll('[data-stage-layout][data-distance][data-testid^=stage-]')) {
          const key = `${block.dataset.stageLayout}-${block.dataset.distance}`;
          const size = id => getComputedStyle(block.querySelector(`[data-testid=${id}-${key}] .ui-readout-value`)).fontSize;
          const pos = block.querySelector(`[data-testid=position-${key}]`);
          const value = pos.querySelector('.ui-readout-value');
          const probe = document.createElement('span');
          probe.textContent = '0000000';
          probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
          value.append(probe);
          const sevenCh = probe.getBoundingClientRect().width;
          probe.remove();
          const lamps = block.querySelector(`[data-testid=lamps-78-${key}]`);
          const dots = [...lamps.querySelectorAll('.ui-beat-lamp')].map(d => d.getBoundingClientRect());
          const groups = [...lamps.querySelectorAll('.ui-beat-lamps-group')].map(g => g.getBoundingClientRect());
          const now = lamps.querySelector('[data-state=now]');
          const big = block.querySelector(`[data-testid=lamps-1516-${key}]`);
          out[key] = {
            position: size('position'), section: size('section'), speed: size('speed'),
            positionSub: getComputedStyle(pos.querySelector('.ui-readout-sub')).fontSize,
            minWidth: value.getBoundingClientRect().width, sevenCh,
            mono: getComputedStyle(value).fontFamily, tabular: getComputedStyle(value).fontVariantNumeric,
            downbeat: dots[0].width, beat: dots[2].width, unit: dots[1].width,
            innerGap: dots[1].left - dots[0].right, groupGap: groups[1].left - groups[0].right,
            nowBg: getComputedStyle(now).backgroundColor, nowToken: getComputedStyle(block).getPropertyValue('--now').trim(),
            nowIndex: [...lamps.querySelectorAll('.ui-beat-lamp')].indexOf(now),
            bigDots: big.querySelectorAll('.ui-beat-lamp').length, bigMode: big.dataset.mode,
          };
        }
        const count = document.querySelector('[data-testid=count] .ui-readout-value');
        out.count = {size: getComputedStyle(count).fontSize, color: getComputedStyle(count).color};
        return out;
      });
      const POSITION = {band: {near: 44, stand: 56, kit: 72}, rail: {near: 52, stand: 64, kit: 84}};
      const SECTION = {near: 32, stand: 40, kit: 52};
      const DIST = {near: 0.8, stand: 1, kit: 1.3};
      const LAMP = {band: 18, rail: 20};
      for (const layout of ['band', 'rail']) {
        for (const distance of ['near', 'stand', 'kit']) {
          const f = facts[`${layout}-${distance}`];
          const at = `${layout}/${distance}`;
          t.expect(px(f.position) === POSITION[layout][distance], `${at}: Position ${f.position}, want ${POSITION[layout][distance]}px`);
          t.expect(px(f.section) === SECTION[distance], `${at}: Section ${f.section}, want ${SECTION[distance]}px`);
          t.expect(near(px(f.speed), 40 * DIST[distance]), `${at}: Speed ${f.speed}, want ${40 * DIST[distance]}px`);
          t.expect(near(px(f.positionSub), Math.max(15, 15 * DIST[distance])), `${at}: Position sub ${f.positionSub}`);
          t.expect(f.minWidth + 0.5 >= f.sevenCh, `${at}: Position minCh 7 holds ${f.minWidth}px ≥ 7ch (${f.sevenCh}px)`);
          t.expect(/Atkinson Hyperlegible Mono/.test(f.mono) && /tabular-nums/.test(f.tabular), `${at}: mono tabular numerals (${f.mono}; ${f.tabular})`);
          const lamp = LAMP[layout] * DIST[distance];
          t.expect(near(f.beat, lamp, 0.8), `${at}: a counted-beat lamp is ${f.beat}px, want ${lamp}px`);
          t.expect(f.downbeat > f.beat && f.beat > f.unit, `${at}: downbeat > beat > unit (${f.downbeat}, ${f.beat}, ${f.unit})`);
          t.expect(f.groupGap > f.innerGap + 2, `${at}: groups have a wider gap (${f.groupGap} vs ${f.innerGap})`);
          t.expect(f.nowIndex === 3, `${at}: the playhead dot is lit (${f.nowIndex})`);
          t.expect(f.bigDots === 5 && f.bigMode === 'groups', `${at}: 15/16 shows one dot per group`);
        }
      }
      t.expect(px(facts.count.size) === 120, `count-in at Stand is 120px (${facts.count.size})`);
      const f = facts['band-stand'];
      t.expect(f.nowBg !== 'rgba(0, 0, 0, 0)' && f.nowBg === facts.count.color, `the lit lamp and the count-in share --now (${f.nowBg} vs ${facts.count.color})`);
      // Captures: band (the runner's own, at the top), then the rail blocks and the count-in.
      for (const key of ['rail-near', 'rail-kit']) {
        await page.evaluate(k => document.querySelector(`[data-testid=stage-${k}]`).scrollIntoView({block: 'start'}), key);
        await t.capture(key);
      }
      await page.evaluate(() => { document.getElementById('harness').scrollTop = 0; });
    },
  },
];
