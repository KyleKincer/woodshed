/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, test, vi } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { CODES, JOB_ERROR_CODES, codeOf, fail, isCode, isJobErrorCode, type Code } from './lib/errors';
import { getUserId, requireAdmin, requireUserId, requireWritableUserId, assertAccountAccess } from './lib/auth';

const modules = import.meta.glob('./**/*.ts');
afterEach(() => vi.unstubAllEnvs());

/** Runs `fn` and returns what it threw (failing the test when it returns). */
async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function dataOf(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(ConvexError);
  return (error as ConvexError<any>).data as Record<string, unknown>;
}

describe('error codes (§6.1)', () => {
  test('the code list is exactly the contract list', () => {
    const contract = [
      'not_signed_in', 'account_suspended', 'account_export_only', 'not_found', 'not_owner', 'invalid',
      'device_unpaired', 'device_revoked_admin', 'device_other_account', 'device_limit', 'queue_full',
      'storage_full_user', 'storage_full_app', 'resplit_no_source', 'resplit_wrong_device', 'retry_wrong_device',
      'job_live', 'job_not_failed', 'practice_too_large', 'setlist_limit', 'setlist_full', 'pins_full',
      'lookup_unavailable', 'lookup_busy', 'artwork_expired',
    ];
    expect([...CODES].sort()).toEqual([...contract].sort());
    expect(new Set(CODES).size).toBe(CODES.length);
  });

  test('job error codes are exactly the companion list', () => {
    expect([...JOB_ERROR_CODES]).toEqual([
      'bot_check', 'unavailable', 'not_found', 'unreadable', 'source_missing', 'disk_full', 'separation_failed',
      'storage_full', 'account_paused', 'sync_failed', 'beats_unavailable', 'playlist', 'unknown',
    ]);
  });

  test('isCode and isJobErrorCode accept only listed strings', () => {
    for (const code of CODES) expect(isCode(code)).toBe(true);
    for (const code of JOB_ERROR_CODES) expect(isJobErrorCode(code)).toBe(true);
    for (const bad of ['', 'Not_signed_in', 'bot_check', 42, null, undefined, {}]) expect(isCode(bad)).toBe(false);
    for (const bad of ['', 'invalid', 'BOT_CHECK', 0, null]) expect(isJobErrorCode(bad)).toBe(false);
  });
});

describe('fail', () => {
  test('throws a ConvexError whose data carries the code and the original message', async () => {
    const error = await caught(() => fail('queue_full', 'This computer already has 20 songs waiting.'));
    expect(dataOf(error)).toEqual({ code: 'queue_full', message: 'This computer already has 20 songs waiting.' });
    // The thrown message still contains the original text, so message assertions keep working.
    expect((error as Error).message).toContain('This computer already has 20 songs waiting.');
    expect(codeOf(error)).toBe('queue_full');
  });

  test('extra data rides along but can never replace the code or the message', async () => {
    const extra = await caught(() => fail('resplit_wrong_device', 'Re-split on the studio Mac.', { deviceName: 'Studio Mac' }));
    expect(dataOf(extra)).toEqual({ code: 'resplit_wrong_device', message: 'Re-split on the studio Mac.', deviceName: 'Studio Mac' });
    const field = await caught(() => fail('invalid', 'Album artist is too long (500 characters max).', { field: 'albumArtist' }));
    expect(dataOf(field).field).toBe('albumArtist');
    const sneaky = await caught(() => fail('not_found', 'Song unavailable.', { code: 'not_owner', message: 'other' }));
    expect(dataOf(sneaky)).toEqual({ code: 'not_found', message: 'Song unavailable.' });
    const holes = await caught(() => fail('resplit_wrong_device', 'Re-split on its computer.', { deviceName: undefined, jobs: 2 }));
    expect(dataOf(holes)).toEqual({ code: 'resplit_wrong_device', message: 'Re-split on its computer.', jobs: 2 });
    expect('deviceName' in dataOf(holes)).toBe(false);
  });

  test('every code round-trips through codeOf', async () => {
    for (const code of CODES) expect(codeOf(await caught(() => fail(code, `m ${code}`)))).toBe(code);
  });

  test('codeOf is null for anything that is not a coded failure', () => {
    expect(codeOf(new Error('Not signed in.'))).toBeNull();
    expect(codeOf(new ConvexError('Song unavailable.'))).toBeNull();
    expect(codeOf(new ConvexError({ code: 'made_up', message: 'x' }))).toBeNull();
    expect(codeOf(new ConvexError({ message: 'no code' }))).toBeNull();
    expect(codeOf({ data: { code: 'not_found' } })).toBeNull();
    expect(codeOf(null)).toBeNull();
    expect(codeOf('not_found')).toBeNull();
  });
});

describe('lib/auth coded errors', () => {
  const setup = () => convexTest(schema, modules);
  const control = (t: ReturnType<typeof setup>, status: 'active' | 'export_only' | 'suspended') =>
    t.run(ctx => ctx.db.insert('accountControls', { userId: 'alice', status, notes: '' }));
  const codeFrom = async (fn: () => unknown): Promise<Code | null> => codeOf(await caught(fn));

  test('anonymous callers get not_signed_in from requireUserId and null from getUserId', async () => {
    const t = setup();
    expect(await t.run(ctx => getUserId(ctx))).toBeNull();
    const error = await caught(() => t.run(ctx => requireUserId(ctx)));
    expect(codeOf(error)).toBe('not_signed_in');
    expect(dataOf(error).message).toBe('Not signed in.');
    expect(await codeFrom(() => t.run(ctx => requireWritableUserId(ctx)))).toBe('not_signed_in');
  });

  test('active accounts pass every check', async () => {
    const t = setup();
    await control(t, 'active');
    const alice = t.withIdentity({ subject: 'alice' });
    expect(await alice.run(ctx => requireUserId(ctx))).toBe('alice');
    expect(await alice.run(ctx => requireWritableUserId(ctx))).toBe('alice');
    // No accountControls row at all is also active.
    expect(await t.withIdentity({ subject: 'bob' }).run(ctx => requireWritableUserId(ctx))).toBe('bob');
  });

  test('suspended accounts get account_suspended on every read and write path', async () => {
    const t = setup();
    await control(t, 'suspended');
    const alice = t.withIdentity({ subject: 'alice' });
    for (const fn of [
      () => alice.run(ctx => getUserId(ctx)),
      () => alice.run(ctx => requireUserId(ctx)),
      () => alice.run(ctx => requireWritableUserId(ctx)),
      () => alice.run(ctx => assertAccountAccess(ctx, 'alice')),
    ]) expect(await codeFrom(fn)).toBe('account_suspended');
    const error = await caught(() => alice.run(ctx => requireUserId(ctx)));
    expect(dataOf(error).message).toBe('Your account is suspended. Contact the app owner for help.');
  });

  test('export-only accounts may read and change personal state but not write new media', async () => {
    const t = setup();
    await control(t, 'export_only');
    const alice = t.withIdentity({ subject: 'alice' });
    expect(await alice.run(ctx => getUserId(ctx))).toBe('alice');
    expect(await alice.run(ctx => requireUserId(ctx))).toBe('alice');
    const error = await caught(() => alice.run(ctx => requireWritableUserId(ctx)));
    expect(codeOf(error)).toBe('account_export_only');
    expect(dataOf(error).message).toBe('Your account is in export-only mode. Playback and library export remain available.');
  });

  test('non-admins get not_owner from requireAdmin; listed admins pass', async () => {
    const t = setup();
    const alice = t.withIdentity({ subject: 'alice' });
    expect(await codeFrom(() => alice.run(ctx => requireAdmin(ctx)))).toBe('not_owner');
    expect(await codeFrom(() => t.run(ctx => requireAdmin(ctx)))).toBe('not_signed_in');
    vi.stubEnv('ADMIN_USER_IDS', 'zed, alice');
    expect(await alice.run(ctx => requireAdmin(ctx))).toBe('alice');
  });

  test('the owner Google account is an admin through its users row', async () => {
    const t = setup();
    vi.stubEnv('OWNER_GOOGLE_ACCOUNT_ID', 'google-owner');
    const ownerId = await t.run(ctx => ctx.db.insert('users', { googleAccountId: 'google-owner', emailVerified: true, createdAt: 1 }));
    const otherId = await t.run(ctx => ctx.db.insert('users', { googleAccountId: 'google-other', emailVerified: true, createdAt: 1 }));
    expect(await t.withIdentity({ subject: ownerId }).run(ctx => requireAdmin(ctx))).toBe(ownerId);
    expect(await codeFrom(() => t.withIdentity({ subject: otherId }).run(ctx => requireAdmin(ctx)))).toBe('not_owner');
  });

  test('the code survives a real function call, as a client sees it', async () => {
    const t = setup();
    await control(t, 'suspended');
    const error = await caught(() => t.withIdentity({ subject: 'alice' }).query(api.songs.list, {}));
    expect(codeOf(error)).toBe('account_suspended');
  });
});
