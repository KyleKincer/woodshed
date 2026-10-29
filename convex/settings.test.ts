/// <reference types="vite/client" />
/**
 * Account settings, presets and the demo token (architecture §6.5, BK4).
 */
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { anyApi } from 'convex/server';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  DEFAULT_SETTINGS,
  INSTRUMENTS,
  PRESETS,
  STEM_MODES,
  checkPatch,
  expectedStems,
  mergeSettings,
  processingSettings,
  resolveQuality,
  withDefaults,
} from './lib/presets';

const modules = import.meta.glob('./**/*.ts');
const quality = { model: 'htdemucs', shifts: 1, overlap: 0.25, format: 'opus' as const, bitrate: 192 };

/** The coded error a rejected call carries (ConvexError data), for `rejects.toMatchObject`. */
const coded = (code: string, extra: Record<string, unknown> = {}) => expect.objectContaining({ data: expect.objectContaining({ code, ...extra }) });

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity({ subject: 'alice' });
  const bob = t.withIdentity({ subject: 'bob' });
  const song = (userId: string, title: string) =>
    t.run(ctx => ctx.db.insert('songs', { userId, title, duration: 200, stems: [], stemMode: 'full', quality, addedAt: 1 }));
  const aliceSongs: Id<'songs'>[] = [];
  for (let i = 0; i < 14; i++) aliceSongs.push(await song('alice', `Song ${i}`));
  const bobSong = await song('bob', 'Bob’s song');
  const row = (userId = 'alice') =>
    t.run(ctx => ctx.db.query('userSettings').withIndex('by_user', q => q.eq('userId', userId)).unique());
  const settingsOf = async (caller = alice) => (await caller.query(api.settings.config, {})).settings;
  return { t, alice, bob, aliceSongs, bobSong, row, settingsOf };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('settings.config', () => {
  test('a new account gets every 2.0 default; a 1.9 row keeps its values, gains the new keys and loses format', async () => {
    const { t, alice, settingsOf } = await setup();
    const fresh = await settingsOf();
    expect(fresh).toEqual({
      preset: 'balanced', stemMode: 'full', bitrate: 192, custom: { model: 'htdemucs_ft', shifts: 10, overlap: 0.5 },
      autoBeats: true, autoSections: true, notifyReady: true,
      profile: { instruments: [], primary: null, openWithMyPart: 'in' },
      pins: [], onboarding: {},
      practice: { stop: 'cue', countIn: { on: false, length: 1, unit: 'bars' }, click: 'countin', eachPassCount: true, keepPitch: true, wake: 10 },
    });
    await t.run(ctx => ctx.db.insert('userSettings', {
      userId: 'alice',
      settings: { preset: 'studio', stemMode: 'drums', format: 'flac', bitrate: 256, custom: { model: 'htdemucs', shifts: 3 } },
    }));
    const legacy = await settingsOf(alice);
    expect(legacy).toMatchObject({ preset: 'studio', stemMode: 'drums', bitrate: 256, custom: { model: 'htdemucs', shifts: 3, overlap: 0.5 }, autoSections: true, pins: [] });
    expect(legacy).not.toHaveProperty('format');
    const { presets, stemModes, models, bitrates, defaultPreset } = await alice.query(api.settings.config, {});
    expect(Object.keys(presets).sort()).toEqual(['balanced', 'fast', 'studio']);
    expect(stemModes.six).toEqual({ id: 'six', label: 'Full band + guitar & piano · 6', twoStems: null });
    expect(models.map((m: { id: string }) => m.id)).toContain('htdemucs_6s');
    expect(bitrates.length).toBeGreaterThan(0);
    expect(defaultPreset).toBe('balanced');
  });

  test('signed out, the defaults and the catalogue still come back', async () => {
    const { t } = await setup();
    const out = await t.query(api.settings.config, {});
    expect(out.settings.practice.wake).toBe(10);
    expect(out.presets.balanced.label).toBe('Balanced');
  });

  test('settings.save is gone (D42): every write goes through settings.patch', async () => {
    const { alice, row } = await setup();
    expect(await import('./settings')).not.toHaveProperty('save');
    await expect(alice.mutation(anyApi.settings.save, { settings: { preset: 'fast' } })).rejects.toThrow();
    expect(await row()).toBeNull();
  });
});

describe('settings.patch', () => {
  test('merges onto the stored row, deep for practice and onboarding, and returns the merged settings', async () => {
    const { alice, row, settingsOf } = await setup();
    const merged = await alice.mutation(api.settings.patch, { patch: { practice: { stop: 'stay' }, onboarding: { coach: 1 } } });
    expect(merged.practice).toEqual({ ...DEFAULT_SETTINGS.practice, stop: 'stay' });
    await alice.mutation(api.settings.patch, { patch: { practice: { countIn: { on: true, length: 2, unit: 'beats' } }, onboarding: { whatDoYouPlay: 'done' } } });
    const s = await settingsOf();
    expect(s.practice).toMatchObject({ stop: 'stay', countIn: { on: true, length: 2, unit: 'beats' }, click: 'countin' });
    expect(s.onboarding).toEqual({ coach: 1, whatDoYouPlay: 'done' });
    expect((await row())!.settings).toEqual(s);
  });

  test('two stale clients patching disjoint keys, in sequence, both survive', async () => {
    const { t, aliceSongs, settingsOf } = await setup();
    // Two devices of the same account, each holding the config it read before either wrote.
    const laptop = t.withIdentity({ subject: 'alice' });
    const ipad = t.withIdentity({ subject: 'alice' });
    const staleLaptop = await settingsOf(laptop);
    const staleIpad = await settingsOf(ipad);
    expect(staleLaptop).toEqual(staleIpad);
    await laptop.mutation(api.settings.patch, { patch: { autoBeats: false, practice: { wake: 30 } } });
    await ipad.mutation(api.settings.patch, { patch: { pins: [aliceSongs[0]], practice: { keepPitch: false } } });
    await laptop.mutation(api.settings.patch, { patch: { profile: { instruments: ['drums'], primary: 'drums', openWithMyPart: 'out' } } });
    const s = await settingsOf();
    expect(s.autoBeats).toBe(false);
    expect(s.pins).toEqual([aliceSongs[0]]);
    expect(s.practice).toMatchObject({ wake: 30, keepPitch: false, stop: 'cue' });
    expect(s.profile).toEqual({ instruments: ['drums'], primary: 'drums', openWithMyPart: 'out' });
  });

  test('rewrites a 1.9 row in the 2.0 shape (format dropped) and skips a write that changes nothing', async () => {
    const { t, alice, row } = await setup();
    await t.run(ctx => ctx.db.insert('userSettings', { userId: 'alice', settings: { preset: 'fast', stemMode: 'full', format: 'opus', bitrate: 192, custom: { model: 'htdemucs_ft', shifts: 10, overlap: 0.5 } } }));
    await alice.mutation(api.settings.patch, { patch: { notifyReady: false } });
    const first = (await row())!;
    expect(first.settings).not.toHaveProperty('format');
    expect(first.settings).toMatchObject({ preset: 'fast', notifyReady: false, autoSections: true });
    await alice.mutation(api.settings.patch, { patch: { notifyReady: false } });
    const second = (await row())!;
    expect(second._creationTime).toBe(first._creationTime);
    expect(second.settings).toEqual(first.settings);
  });

  test('a patch that changes nothing does not write, whatever the stored key order', async () => {
    const { t, alice, row } = await setup();
    await alice.mutation(api.settings.patch, { patch: { notifyReady: false, practice: { stop: 'stay' } } });
    // The database hands back a document's fields in its own (sorted) order, never the
    // order `mergeSettings` built them in; the skip check must not depend on it.
    const id = (await row())!._id;
    const reverseKeys = (value: any): any =>
      Array.isArray(value) ? value.map(reverseKeys)
        : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(k => [k, reverseKeys(value[k])]))
          : value;
    await t.run(async ctx => {
      const doc = (await ctx.db.get('userSettings', id))!;
      await ctx.db.replace('userSettings', id, { userId: doc.userId, settings: reverseKeys(doc.settings) });
    });
    // Count document writes at the syscall layer the Convex runtime uses.
    const real = (globalThis as any).Convex;
    let writes = 0;
    const counted = (fn: (op: string, args: string) => any) => (op: string, args: string) => {
      if (/^1\.0\/(insert|replace|shallowMerge)$/.test(op)) writes += 1;
      return fn(op, args);
    };
    (globalThis as any).Convex = {
      get syscall() { return counted(real.syscall); },
      get asyncSyscall() { return counted(real.asyncSyscall); },
      get jsSyscall() { return real.jsSyscall; },
    };
    try {
      await alice.mutation(api.settings.patch, { patch: { notifyReady: false, practice: { stop: 'stay' } } });
      await alice.mutation(api.settings.patch, { patch: { onboarding: {} } });
      expect(writes).toBe(0);
      await alice.mutation(api.settings.patch, { patch: { notifyReady: true } });
      expect(writes).toBe(1);
    } finally {
      (globalThis as any).Convex = real;
    }
    expect((await row())!.settings.notifyReady).toBe(true);
  });

  test('enums are validated with coded errors naming the field', async () => {
    const { alice, row } = await setup();
    const bad: [Record<string, unknown>, string][] = [
      [{ preset: 'ultra' }, 'preset'],
      [{ stemMode: 'four' }, 'stemMode'],
      [{ bitrate: 320 }, 'bitrate'],
      [{ custom: { model: 'spleeter', shifts: 1, overlap: 0.25 } }, 'custom.model'],
      [{ custom: { model: 'htdemucs', shifts: 11, overlap: 0.25 } }, 'custom.shifts'],
      [{ custom: { model: 'htdemucs', shifts: 1.5, overlap: 0.25 } }, 'custom.shifts'],
      [{ custom: { model: 'htdemucs', shifts: 1, overlap: 0.9 } }, 'custom.overlap'],
      [{ practice: { countIn: { on: true, length: 0, unit: 'bars' } } }, 'practice.countIn.length'],
      [{ practice: { countIn: { on: true, length: 17, unit: 'bars' } } }, 'practice.countIn.length'],
      [{ practice: { countIn: { on: true, length: 2.5, unit: 'bars' } } }, 'practice.countIn.length'],
      [{ onboarding: { coach: 16 } }, 'onboarding.coach'],
      [{ onboarding: { coach: -1 } }, 'onboarding.coach'],
    ];
    for (const [patch, field] of bad) {
      await expect(alice.mutation(api.settings.patch, { patch: patch as never }), JSON.stringify(patch)).rejects.toMatchObject(coded('invalid', { field }));
    }
    // Wrong literals never reach the handler: the argument validators refuse them.
    for (const patch of [{ practice: { click: 'sometimes' } }, { practice: { wake: 15 } }, { practice: { stop: 'start' } }, { autoSections: 'yes' }, { onboarding: { whatDoYouPlay: 'later' } }, { profile: { instruments: ['kazoo'], primary: null, openWithMyPart: 'in' } }, { unknown: true }]) {
      await expect(alice.mutation(api.settings.patch, { patch: patch as never }), JSON.stringify(patch)).rejects.toThrow();
    }
    expect(await row()).toBeNull();
  });

  test('click, autoSections and the other new keys are stored', async () => {
    const { alice, settingsOf } = await setup();
    for (const click of ['off', 'countin', 'always'] as const) {
      await alice.mutation(api.settings.patch, { patch: { practice: { click } } });
      expect((await settingsOf()).practice.click).toBe(click);
    }
    await alice.mutation(api.settings.patch, { patch: { autoSections: false, autoBeats: false, notifyReady: false, addDefaultsSaved: true, stemMode: 'six', preset: 'fast', practice: { wake: 'always', eachPassCount: false } } });
    const s = await settingsOf();
    expect(s).toMatchObject({ autoSections: false, autoBeats: false, notifyReady: false, addDefaultsSaved: true, stemMode: 'six', preset: 'fast' });
    expect(s.practice).toMatchObject({ wake: 'always', eachPassCount: false });
    await alice.mutation(api.settings.patch, { patch: { onboarding: { desktopFirstRun: true, coach: 15 } } });
    expect((await settingsOf()).onboarding).toEqual({ desktopFirstRun: true, coach: 15 });
  });

  test('instruments: at most 6, deduplicated in order', async () => {
    const { alice, settingsOf } = await setup();
    await alice.mutation(api.settings.patch, { patch: { profile: { instruments: ['bass', 'drums', 'bass'], primary: 'drums', openWithMyPart: 'in' } } });
    expect((await settingsOf()).profile.instruments).toEqual(['bass', 'drums']);
    const all = [...INSTRUMENTS];
    await alice.mutation(api.settings.patch, { patch: { profile: { instruments: all, primary: null, openWithMyPart: 'in' } } });
    expect((await settingsOf()).profile.instruments).toEqual(all);
    // Duplicates are removed before the cap applies: 7 entries, 6 distinct, is accepted.
    await alice.mutation(api.settings.patch, { patch: { profile: { instruments: [...all, 'drums'], primary: null, openWithMyPart: 'in' } } });
    expect((await settingsOf()).profile.instruments).toEqual(all);
    await alice.mutation(api.settings.patch, { patch: { profile: { instruments: ['drums', 'drums', 'bass', 'bass', 'keys', 'vocals', 'other'], primary: 'drums', openWithMyPart: 'in' } } });
    expect((await settingsOf()).profile).toEqual({ instruments: ['drums', 'bass', 'keys', 'vocals', 'other'], primary: 'drums', openWithMyPart: 'in' });
  });

  test('a primary the profile does not list is normalised, not refused', async () => {
    const { alice, settingsOf } = await setup();
    // The primary chip was deselected but primary was sent unchanged: the first instrument left takes over.
    await alice.mutation(api.settings.patch, { patch: { profile: { instruments: ['bass', 'keys'], primary: 'drums', openWithMyPart: 'out' } } });
    expect((await settingsOf()).profile).toEqual({ instruments: ['bass', 'keys'], primary: 'bass', openWithMyPart: 'out' });
    await alice.mutation(api.settings.patch, { patch: { profile: { instruments: [], primary: 'bass', openWithMyPart: 'in' } } });
    expect((await settingsOf()).profile).toEqual({ instruments: [], primary: null, openWithMyPart: 'in' });
    await alice.mutation(api.settings.patch, { patch: { profile: { instruments: ['bass', 'keys'], primary: 'keys', openWithMyPart: 'in' } } });
    expect((await settingsOf()).profile.primary).toBe('keys');
  });

  test('pins: at most 12, deduplicated, owned; deleted songs drop out', async () => {
    const { t, alice, bob, aliceSongs, bobSong, settingsOf } = await setup();
    const twelve = aliceSongs.slice(0, 12);
    await alice.mutation(api.settings.patch, { patch: { pins: [...twelve, twelve[0], twelve[3]] } });
    expect((await settingsOf()).pins).toEqual(twelve);
    await expect(alice.mutation(api.settings.patch, { patch: { pins: aliceSongs.slice(0, 13) } })).rejects.toMatchObject(coded('pins_full', { field: 'pins' }));
    await expect(alice.mutation(api.settings.patch, { patch: { pins: [aliceSongs[0], bobSong] } })).rejects.toMatchObject(coded('not_owner', { field: 'pins' }));
    await expect(bob.mutation(api.settings.patch, { patch: { pins: [aliceSongs[0]] } })).rejects.toMatchObject(coded('not_owner'));
    expect((await settingsOf()).pins).toEqual(twelve);
    await t.run(ctx => ctx.db.delete('songs', aliceSongs[13]));
    await alice.mutation(api.settings.patch, { patch: { pins: [aliceSongs[13], aliceSongs[1]] } });
    expect((await settingsOf()).pins).toEqual([aliceSongs[1]]);
  });

  test('export-only accounts may patch; suspended and signed-out callers may not', async () => {
    const { t, alice, settingsOf } = await setup();
    await t.run(ctx => ctx.db.insert('accountControls', { userId: 'alice', status: 'export_only', notes: '' }));
    await alice.mutation(api.settings.patch, { patch: { practice: { stop: 'stay' } } });
    expect((await settingsOf()).practice.stop).toBe('stay');
    await expect(t.mutation(api.settings.patch, { patch: { autoBeats: false } })).rejects.toMatchObject(coded('not_signed_in'));
    await t.run(async ctx => {
      const control = await ctx.db.query('accountControls').withIndex('by_userId', q => q.eq('userId', 'alice')).unique();
      await ctx.db.patch('accountControls', control!._id, { status: 'suspended' });
    });
    await expect(alice.mutation(api.settings.patch, { patch: { autoBeats: false } })).rejects.toMatchObject(coded('account_suspended'));
  });

  test('settings belong to their account', async () => {
    const { alice, bob, settingsOf } = await setup();
    await alice.mutation(api.settings.patch, { patch: { autoBeats: false } });
    expect((await settingsOf(bob)).autoBeats).toBe(true);
    expect((await settingsOf(alice)).autoBeats).toBe(false);
  });
});

describe('settings.demo (B8, D7)', () => {
  const token = 'a1b2c3d4'.repeat(8);
  test('returns the token when DEMO_SHARE_TOKEN is 64 lowercase hex characters', async () => {
    const { t, alice } = await setup();
    vi.stubEnv('DEMO_SHARE_TOKEN', token);
    expect(await t.query(api.settings.demo, {})).toEqual({ token });
    expect(await alice.query(api.settings.demo, {})).toEqual({ token });
  });
  test('returns null when the variable is unset or malformed', async () => {
    const { t } = await setup();
    expect(await t.query(api.settings.demo, {})).toBeNull();
    for (const value of ['', 'abc', token.toUpperCase(), `${token}0`, token.slice(1), `${token.slice(0, 63)}g`, ` ${token}`]) {
      vi.stubEnv('DEMO_SHARE_TOKEN', value);
      expect(await t.query(api.settings.demo, {}), value).toBeNull();
    }
  });
});

describe('lib/presets', () => {
  test('six resolves to htdemucs_6s with the preset’s shifts and overlap', () => {
    for (const id of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      const p = PRESETS[id];
      expect(resolveQuality({ preset: id, stemMode: 'six' })).toMatchObject({ model: 'htdemucs_6s', shifts: p.shifts, overlap: p.overlap, format: 'opus' });
      expect(resolveQuality(id, 'six')).toMatchObject({ model: 'htdemucs_6s', shifts: p.shifts, overlap: p.overlap });
    }
    expect(resolveQuality({ preset: 'custom', stemMode: 'six', custom: { model: 'mdx_extra', shifts: 4, overlap: 0.3 } }))
      .toMatchObject({ model: 'htdemucs_6s', shifts: 4, overlap: 0.3 });
    expect(resolveQuality({ preset: 'studio', stemMode: 'full' }).model).toBe('htdemucs_ft');
    expect(resolveQuality('fast', 'drums')).toMatchObject({ model: 'htdemucs', shifts: 0 });
    // A stem mode argument overrides the settings' own.
    expect(resolveQuality({ preset: 'balanced', stemMode: 'full' }, 'six').model).toBe('htdemucs_6s');
  });

  test('stems are always Opus, whatever a 1.9 row stored', () => {
    expect(resolveQuality({ format: 'flac' }).format).toBe('opus');
    expect(resolveQuality({ bitrate: 256 }).bitrate).toBe(256);
    expect(resolveQuality({ bitrate: 999 }).bitrate).toBe(192);
    expect(DEFAULT_SETTINGS).not.toHaveProperty('format');
  });

  test('expectedStems', () => {
    expect(expectedStems('six')).toEqual(['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']);
    expect(expectedStems('full')).toEqual(['drums', 'bass', 'other', 'vocals']);
    expect(expectedStems('full', 'htdemucs_6s')).toHaveLength(6);
    expect(expectedStems('vocals', 'htdemucs')).toEqual(['vocals', 'no_vocals']);
    expect(STEM_MODES.six.twoStems).toBeNull();
  });

  test('withDefaults returns fresh objects and tolerates junk', () => {
    const a = withDefaults(undefined), b = withDefaults(null);
    a.pins.push('x'); a.practice.countIn.on = true; a.profile.instruments.push('drums');
    expect(b.pins).toEqual([]);
    expect(DEFAULT_SETTINGS.pins).toEqual([]);
    expect(DEFAULT_SETTINGS.practice.countIn.on).toBe(false);
    expect(DEFAULT_SETTINGS.profile.instruments).toEqual([]);
    expect(withDefaults({ practice: 'loud', profile: [1], pins: 'none', custom: 3 })).toMatchObject({ practice: DEFAULT_SETTINGS.practice, profile: DEFAULT_SETTINGS.profile, pins: [], custom: DEFAULT_SETTINGS.custom });
    expect(withDefaults({ practice: { countIn: { length: 4 } } }).practice.countIn).toEqual({ on: false, length: 4, unit: 'bars' });
  });

  test('processingSettings keeps only what a separation job needs', () => {
    expect(processingSettings({ preset: 'fast', stemMode: 'six', format: 'flac', pins: ['a'], practice: { stop: 'stay' } }))
      .toEqual({ preset: 'fast', stemMode: 'six', bitrate: 192, custom: DEFAULT_SETTINGS.custom });
  });

  test('mergeSettings merges plain objects, replaces arrays and never mutates', () => {
    const base = { pins: ['a', 'b'], practice: { stop: 'cue', countIn: { on: false, length: 1, unit: 'bars' } }, x: 1 };
    const out = mergeSettings(base, { pins: ['c'], practice: { countIn: { on: true, length: 2, unit: 'beats' } }, x: undefined });
    expect(out).toEqual({ pins: ['c'], practice: { stop: 'cue', countIn: { on: true, length: 2, unit: 'beats' } }, x: 1 });
    expect(base.pins).toEqual(['a', 'b']);
    expect(base.practice.countIn.on).toBe(false);
  });

  test('checkPatch refuses unknown keys and wrong types (the fixture relies on it)', () => {
    expect(checkPatch({ format: 'opus' })).toMatchObject({ ok: false, code: 'invalid', field: 'format' });
    expect(checkPatch({ practice: { volume: 1 } })).toMatchObject({ ok: false, field: 'practice.volume' });
    expect(checkPatch({ onboarding: { tour: 'done' } })).toMatchObject({ ok: false, field: 'onboarding.tour' });
    expect(checkPatch({ practice: { click: 'sometimes' } })).toMatchObject({ ok: false, field: 'practice.click' });
    expect(checkPatch({ practice: { wake: 15 } })).toMatchObject({ ok: false, field: 'practice.wake' });
    expect(checkPatch({ autoSections: 'yes' })).toMatchObject({ ok: false, field: 'autoSections' });
    expect(checkPatch({ pins: [1] })).toMatchObject({ ok: false, field: 'pins' });
    expect(checkPatch(null)).toMatchObject({ ok: false, field: 'patch' });
    expect(checkPatch({ pins: Array.from({ length: 13 }, (_, i) => `s${i}`) })).toMatchObject({ ok: false, code: 'pins_full' });
    expect(checkPatch({ pins: ['a', 'a', 'b'], autoBeats: undefined })).toEqual({ ok: true, patch: { pins: ['a', 'b'] } });
  });
});
