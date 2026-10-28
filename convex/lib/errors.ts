import { ConvexError, type Value } from 'convex/values';

/**
 * Coded errors (architecture §6.1).
 *
 * Every user-reachable failure throws `fail(code, message)`. The code travels in
 * `ConvexError.data`, which survives production redaction (a plain `Error`'s
 * message does not), so the client can pick its copy from the code alone
 * (`src/app/error-copy.js`) and still show the original message behind Details.
 */
export const CODES = [
  'not_signed_in',
  'account_suspended',
  'account_export_only',
  'not_found',
  'not_owner',
  'invalid',
  'device_unpaired',
  'device_revoked_admin',
  'device_other_account',
  'device_limit',
  'queue_full',
  'storage_full_user',
  'storage_full_app',
  'resplit_no_source',
  'resplit_wrong_device',
  'retry_wrong_device',
  'job_live',
  'job_not_failed',
  'practice_too_large',
  'setlist_limit',
  'setlist_full',
  'pins_full',
  'lookup_unavailable',
  'lookup_busy',
  'artwork_expired',
] as const;

export type Code = (typeof CODES)[number];

/** The payload every coded error carries: the code, the original message, and any extra fields. */
export type ErrorData = { code: Code; message: string } & Record<string, unknown>;

/**
 * Job `errorCode` values. These are set by the companion and its Python
 * pipeline (§6.10) on failed jobs, not thrown by Convex functions.
 */
export const JOB_ERROR_CODES = [
  'bot_check',
  'unavailable',
  'not_found',
  'unreadable',
  'source_missing',
  'disk_full',
  'separation_failed',
  'storage_full',
  'account_paused',
  'sync_failed',
  'beats_unavailable',
  'playlist',
  'unknown',
] as const;

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

const codeSet: ReadonlySet<string> = new Set(CODES);
const jobCodeSet: ReadonlySet<string> = new Set(JOB_ERROR_CODES);

export function isCode(value: unknown): value is Code {
  return typeof value === 'string' && codeSet.has(value);
}

export function isJobErrorCode(value: unknown): value is JobErrorCode {
  return typeof value === 'string' && jobCodeSet.has(value);
}

/**
 * Throws `ConvexError({code, message, ...data})`. Extra fields ride along
 * (for example `{field}` for `invalid`, `{deviceName}` for
 * `resplit_wrong_device`); they can never replace the code or the message.
 */
export function fail(code: Code, message: string, data: Record<string, unknown> = {}): never {
  // `undefined` is not a Convex value; drop such fields so the error always serialises.
  const extra = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
  throw new ConvexError({ ...extra, code, message } as unknown as Record<string, Value>);
}

/** The code of an error thrown by `fail`, else null. Lets server code catch one code and rethrow the rest. */
export function codeOf(error: unknown): Code | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (!data || typeof data !== 'object') return null;
  const code = (data as { code?: unknown }).code;
  return isCode(code) ? code : null;
}
