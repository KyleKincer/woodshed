/// <reference types="vite/client" />
// CPB: worker.progress lets a paused account fail its running job (§10.2
// account_paused). Every other worker call on a paused account stays refused.
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import { hashToken } from '../convex/devices';

const modules = import.meta.glob('../convex/**/*.ts');
const TOKEN = 'c'.repeat(64);

async function codeOf(promise) {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    return error.data.code;
  }
  throw new Error('expected a coded failure');
}

async function setup() {
  const t = convexTest(schema, modules);
  const deviceId = await t.withIdentity({ subject: 'alice' }).mutation(api.devices.pair, { tokenHash: await hashToken(TOKEN), name: 'Studio Mac' });
  let clock = 1_000;
  const job = (fields = {}) => t.run(ctx => {
    const now = clock++;
    return ctx.db.insert('jobs', {
      userId: 'alice', deviceId, kind: 'separate', label: 'Song', status: 'queued', stage: 'queued', percent: 0,
      attempts: 0, createdAt: now, updatedAt: now, ...fields,
    });
  });
  const getJob = id => t.run(ctx => ctx.db.get('jobs', id));
  const pause = status => t.run(ctx => ctx.db.insert('accountControls', { userId: 'alice', status, notes: '' }));
  return { t, deviceId, job, getJob, pause };
}

describe('CPB worker.progress on a paused account', () => {
  for (const [status, refused] of [['suspended', 'account_suspended'], ['export_only', 'account_export_only']]) {
    test(`${status}: the failure report lands as account_paused; progress and claim stay refused`, async () => {
      const s = await setup();
      const jobId = await s.job();
      await s.t.mutation(api.worker.claim, { token: TOKEN, jobId });
      await s.pause(status);
      expect(await codeOf(s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'separate', percent: 50 }))).toBe(refused);
      expect(await codeOf(s.t.mutation(api.worker.claim, { token: TOKEN, jobId }))).toBe(refused);
      expect(await s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'error', percent: 0, error: 'Your account is paused.', errorCode: 'account_paused' })).toBe(true);
      expect(await s.getJob(jobId)).toMatchObject({ status: 'error', errorCode: 'account_paused', error: 'Your account is paused.' });
    });
  }

  test('a bot check reported on a paused account is never scheduled for a retry', async () => {
    const s = await setup();
    const jobId = await s.job({ status: 'running' });
    await s.pause('export_only');
    await s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'error', percent: 0, error: 'bot', errorCode: 'bot_check' });
    const row = await s.getJob(jobId);
    expect(row).toMatchObject({ status: 'error', errorCode: 'bot_check' });
    expect(row.retryAt).toBeUndefined();
  });

  test('a revoked computer is refused even for a failure report on a paused account', async () => {
    const s = await setup();
    const jobId = await s.job({ status: 'running' });
    await s.pause('suspended');
    await s.t.run(ctx => ctx.db.patch('devices', s.deviceId, { revoked: true, revokedBy: 'user' }));
    expect(await codeOf(s.t.mutation(api.worker.progress, { token: TOKEN, jobId, stage: 'error', percent: 0, error: 'x' }))).toBe('device_unpaired');
    expect((await s.getJob(jobId)).status).toBe('running');
  });
});
