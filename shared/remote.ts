/**
 * The phone remote's shared vocabulary (convex/remote.ts, src/remote). A remote can only ask a host to run
 * one of these registry commands: the transport, section, loop, speed, click and mix commands that are also
 * foot-pedal commands (`pedal: true`), none of which takes arguments.
 */
export const REMOTE_COMMANDS = [
  'transport.playStop', 'transport.pause', 'transport.again', 'transport.stop',
  'transport.loopToggle', 'transport.loopSection',
  'nav.prevSection', 'nav.nextSection', 'nav.barBack', 'nav.barFwd',
  'speed.down', 'speed.up', 'speed.toggle100', 'trainer.toggle',
  'click.countIn', 'click.toggle',
  'mix.minusMe', 'mix.onlyMe', 'mix.full',
  'setlist.prev', 'setlist.next',
] as const;
export type RemoteCommand = (typeof REMOTE_COMMANDS)[number];
export const isRemoteCommand = (value: unknown): value is RemoteCommand =>
  typeof value === 'string' && (REMOTE_COMMANDS as readonly string[]).includes(value);

/** A device's stable id for its remote presence: 8–64 of A–Z a–z 0–9 _ -. */
export const isHostId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);

/**
 * A remote host counts as there while its `seenAt` is this recent (it heartbeats every HEARTBEAT_MS). Clients
 * judge it by the server's clock: `announce` and `watch` return the server's time.
 */
export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 75_000;
/**
 * A host runs a command only while its `sentAt` is this recent by the server's clock. Older ones (sent while the
 * host slept or was offline) are acked without running, so they never fire long after the tap.
 */
export const COMMAND_TTL_MS = 10_000;
/** At most this many commands wait for one host; more are dropped (a remote that cannot reach its host). */
export const MAX_PENDING = 16;
/** At most this many hosts per account; announcing another drops the one seen longest ago. */
export const MAX_HOSTS = 8;
