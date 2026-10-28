// One account in Administration (route `adminAccount`, `/admin/accounts/:id`; spec §6.4), admins only.
//   Header: ‹ Administration (Back: the router returns to /admin with the account's row focused), the
//           name, the email (verified or not), when it joined, an Admin badge.
//   Storage: used of the effective limit, with a meter.
//   Access: a Segmented Active · Export only · Suspended (an administrator's own access cannot be
//           restricted: the other options are disabled with that reason).
//   Storage override (GB; blank = the plan's limit, 0 blocks new uploads) and private notes, each
//           with its own Save….
//   Computers: name, Online / Last seen … / Never seen, or who revoked it; Revoke… on active ones.
//   Jobs: the 30 newest, with Cancel… on queued, running and bot-check-waiting ones.
//   Audit history for this account with Load more.
// Every change opens the Reason dialog (askReason) and runs inside it; the page follows the live
// `admin.account` subscription, and the history reloads after each change.
//
//   mount(el, match, ctx) → Promise<{update(match), unmount()}>   resolves once the account arrived

import '../../styles/views/settings/admin.css';
import {h, reconcileList} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {Segmented} from '../../ui/segmented.js';
import {TextField, Textarea} from '../../ui/field.js';
import {InlineStatus} from '../../ui/status.js';
import {ProgressRail} from '../../ui/progress.js';
import {Skeleton} from '../../ui/skeleton.js';
import {store as appStore} from '../../app/store.js';
import {toast} from '../../app/feedback.js';
import {now as clockNow} from '../../app/clock.js';
import {isOnline} from '../../api/devices.js';
import * as adminApi from '../../api/admin.js';
import {relativeTime} from '../../library/song-labels.js';
import {askReason} from './reason-dialog.js';
import {AuditList, COPY as ADMIN_COPY, STATUS_LABELS, TICK_MS, formatBytes, gbText, loadError, parseGB, refreshTimes, statusLabel, timeEl} from './admin.js';

export const NOTES_MAX = 4000;
const LIVE_JOB = new Set(['queued', 'running']);

export const COPY = Object.freeze({
  back: 'Administration',
  joined: 'Joined',
  verified: 'Email verified',
  unverified: 'Email not verified',
  storage: 'Storage',
  usage: (used, limit) => `${used} of ${limit}`,
  usageMeter: 'Storage used',
  overLimit: 'Over the limit: new uploads are paused. Stored files are kept.',
  accessHeading: 'Access',
  access: 'Account access',
  accessOptions: Object.freeze([
    {value: 'active', label: STATUS_LABELS.active},
    {value: 'export_only', label: STATUS_LABELS.export_only},
    {value: 'suspended', label: STATUS_LABELS.suspended},
  ]),
  accessHelp: Object.freeze({
    active: 'Full access.',
    export_only: 'Can play and export the library, and change practice and settings. Can’t add songs, re-split, pair computers or share.',
    suspended: 'Can’t open Woodshed. Stored files are kept.',
  }),
  adminLocked: 'An administrator account can’t be restricted.',
  accessTitle: label => `Change access to ${label}?`,
  accessConfirm: 'Change access',
  accessSaved: label => `Access changed to ${label}.`,
  override: 'Storage override (GB)',
  overrideHint: 'Leave blank to use the plan’s limit. 0 blocks new uploads. The app ceiling always applies.',
  overridePlaceholder: 'Plan limit',
  saveOverride: 'Save override…',
  overrideTitle: 'Change the storage override?',
  overrideBody: (from, to) => `${from} → ${to}`,
  planLimit: 'Plan limit',
  overrideSaved: 'Storage override saved.',
  overrideConfirm: 'Save override',
  badSize: ADMIN_COPY.badSize,
  unchanged: 'Nothing has changed yet.',
  notesHeading: 'Notes',
  notes: 'Private notes',
  notesHint: 'Only administrators see these.',
  saveNotes: 'Save notes…',
  notesTitle: 'Save the notes?',
  notesConfirm: 'Save notes',
  notesSaved: 'Notes saved.',
  notesTooLong: `Notes can be at most ${NOTES_MAX} characters.`,
  computers: 'Computers',
  noComputers: 'No paired computers.',
  online: 'Online',
  lastSeen: when => `Last seen ${when}`,
  neverSeen: 'Never seen',
  revokedByAdmin: 'Revoked by an administrator',
  revokedByUser: 'Revoked by its owner',
  revoke: 'Revoke…',
  revokeName: name => `Revoke ${name}…`,
  revokeTitle: name => `Revoke “${name}”?`,
  revokeBody: 'It stops processing songs for this account and can’t connect again.',
  revokeConfirm: 'Revoke',
  revoked: name => `${name} revoked.`,
  jobs: 'Recent jobs',
  noJobs: 'No jobs.',
  jobStatus: Object.freeze({queued: 'Queued', running: 'Running', done: 'Done', error: 'Failed', canceled: 'Cancelled'}),
  waitingRetry: 'Waiting to retry',
  cancel: 'Cancel…',
  cancelName: label => `Cancel ${label}…`,
  cancelTitle: label => `Cancel “${label}”?`,
  cancelBody: 'Processing stops and its partial files are removed. The account can start it again.',
  cancelConfirm: 'Cancel job',
  keep: 'Keep it',
  cancelled: label => `${label} cancelled.`,
  untitledJob: 'Untitled job',
  history: 'History',
  notFound: 'Account not found',
  notFoundBody: 'It may have been deleted, or the link is wrong.',
});

/** Controls of an account page (role, accessible name) for the table test (§9.0). */
export const CONTROLS = Object.freeze([
  {role: 'button', name: COPY.back},
  {role: 'radiogroup', name: COPY.access},
  {role: 'textbox', name: COPY.override},
  {role: 'button', name: COPY.saveOverride},
  {role: 'textbox', name: COPY.notes},
  {role: 'button', name: COPY.saveNotes},
  {role: 'heading', name: COPY.computers},
  {role: 'heading', name: COPY.jobs},
  {role: 'heading', name: COPY.history},
]);

const deviceName = d => (typeof d?.name === 'string' && d.name.trim() ? d.name.trim() : d?.id ?? '');
const jobLabel = j => (typeof j?.label === 'string' && j.label.trim() ? j.label.trim() : COPY.untitledJob);
/** A job an administrator can still cancel (admin.cancelJob's rule). */
export const isLiveJob = j => LIVE_JOB.has(j?.status) || (j?.status === 'error' && j?.retryAt != null);

/** The presence line of a computer row. */
export function deviceLine(device, now) {
  if (device?.revoked) return device.revokedBy === 'admin' ? COPY.revokedByAdmin : COPY.revokedByUser;
  if (isOnline(device, now)) return COPY.online;
  if (typeof device?.lastSeenAt === 'number') return COPY.lastSeen(relativeTime(device.lastSeenAt, now));
  return COPY.neverSeen;
}

/** The status line of a job row: 'Running · separate', 'Waiting to retry', 'Failed · download'. */
export function jobLine(job) {
  if (job?.status === 'error' && job?.retryAt != null) return COPY.waitingRetry;
  const status = COPY.jobStatus[job?.status] ?? String(job?.status ?? '');
  const stage = typeof job?.stage === 'string' && job.stage && job.stage !== job.status && job.status !== 'done' ? job.stage : '';
  return stage ? `${status} · ${stage}` : status;
}

/** Mounts /admin/accounts/:id. See the header. */
export async function mount(el, match, ctx = {}) {
  const store = ctx.store ?? appStore;
  const router = ctx.router ?? null;
  const selfId = store.session?.peek?.()?.user?.id ?? null;
  let id = String(match?.params?.id ?? '');
  let tick = clockNow();
  let data = null;
  let destroyed = false;

  const scroller = h('div', {class: 'admin-scroller', attrs: {'data-scroller': ''}});
  const content = h('div', {class: 'app-content admin-page admin-account-page'});
  scroller.append(content);
  el.replaceChildren(scroller);

  const back = Button({label: COPY.back, icon: 'chevron-left', variant: 'quiet', size: 'sm', className: 'admin-back',
    onClick: () => (router?.back ? router.back({fallback: '/admin'}) : router?.navigate?.('/admin'))});

  // Header
  const title = h('h1', {class: 'admin-title selectable'});
  const meta = h('p', {class: 'admin-meta'});
  const header = h('header', {class: 'admin-header'}, back.el, title, meta);

  // Storage
  const usage = h('p', {class: 'admin-card-value tabular'});
  const rail = ProgressRail({value: 0, label: COPY.usageMeter, className: 'admin-meter'});
  const overNote = h('p', {class: 'admin-warn', hidden: true}, COPY.overLimit);

  // Access
  const accessHelp = h('p', {class: 'admin-note', id: 'admin-access-help'});
  const access = Segmented({label: COPY.access, options: COPY.accessOptions, value: 'active', className: 'admin-access',
    attrs: {'aria-describedby': 'admin-access-help'}, onChange: value => changeAccess(value)});

  // Override
  const override = TextField({label: COPY.override, hint: COPY.overrideHint, inputmode: 'decimal', autocomplete: 'off',
    placeholder: COPY.overridePlaceholder, className: 'admin-override-field', onInput: () => override.set({error: undefined})});
  const saveOverride = Button({label: COPY.saveOverride, variant: 'secondary', type: 'submit'});
  const overrideNote = InlineStatus({tone: 'info', text: COPY.unchanged});
  overrideNote.el.hidden = true;
  const overrideForm = h('form', {class: 'admin-field-form', novalidate: true},
    override.el, h('div', {class: 'admin-actions'}, saveOverride.el, overrideNote.el));

  // Notes
  const notes = Textarea({label: COPY.notes, hint: COPY.notesHint, rows: 4, maxLength: NOTES_MAX, debounceMs: 0,
    className: 'admin-notes-field', onInput: () => notes.set({error: undefined})});
  const saveNotes = Button({label: COPY.saveNotes, variant: 'secondary', type: 'submit'});
  const notesNote = InlineStatus({tone: 'info', text: COPY.unchanged});
  notesNote.el.hidden = true;
  const notesForm = h('form', {class: 'admin-field-form', novalidate: true},
    notes.el, h('div', {class: 'admin-actions'}, saveNotes.el, notesNote.el));

  const section = (key, heading, ...children) => h('section', {class: 'admin-section', attrs: {'aria-labelledby': `admin-account-${key}`}},
    h('h2', {class: 'admin-section-title', id: `admin-account-${key}`}, heading), ...children);
  const accessSection = section('access', COPY.accessHeading, h('div', {class: 'admin-field-group'}, access.el, accessHelp));
  const storageSection = section('storage', COPY.storage, h('div', {class: 'admin-card admin-usage'}, usage, rail.el, overNote), overrideForm);
  const notesSection = section('notes', COPY.notesHeading, notesForm);

  // Computers and jobs
  const deviceList = h('ul', {class: 'admin-items', attrs: {'aria-labelledby': 'admin-computers-title'}});
  const noDevices = h('p', {class: 'admin-empty', hidden: true}, COPY.noComputers);
  const devicesSection = h('section', {class: 'admin-section', attrs: {'aria-labelledby': 'admin-computers-title'}},
    h('h2', {class: 'admin-section-title', id: 'admin-computers-title'}, COPY.computers), deviceList, noDevices);
  const jobList = h('ul', {class: 'admin-items', attrs: {'aria-labelledby': 'admin-jobs-title'}});
  const noJobs = h('p', {class: 'admin-empty', hidden: true}, COPY.noJobs);
  const jobsSection = h('section', {class: 'admin-section', attrs: {'aria-labelledby': 'admin-jobs-title'}},
    h('h2', {class: 'admin-section-title', id: 'admin-jobs-title'}, COPY.jobs), jobList, noJobs);

  let audit = null;
  const historyHost = h('div', {class: 'admin-history-host'});
  const historySection = h('section', {class: 'admin-section', attrs: {'aria-labelledby': 'admin-account-history'}},
    h('h2', {class: 'admin-section-title', id: 'admin-account-history'}, COPY.history), historyHost);

  const body = h('div', {class: 'admin-account-body', hidden: true}, accessSection, storageSection, notesSection, devicesSection, jobsSection, historySection);
  const skeleton = Skeleton({shape: 'text', count: 6, label: ADMIN_COPY.loading});
  const loadStatus = InlineStatus({tone: 'error', text: '', className: 'admin-load-error'});
  loadStatus.el.hidden = true;
  // An id that does not exist: the h1 says so, the header's Back leads out.
  const missing = h('p', {class: 'admin-lead admin-missing', hidden: true}, COPY.notFoundBody);
  content.append(header, missing, skeleton.el, loadStatus.el, body);

  const rowButtons = new Set();
  // The server text last put in each field: a field whose text differs has the administrator's edit,
  // which a live update never overwrites (the field's own commit-on-blur baseline would let it).
  const applied = {override: '', notes: ''};
  function syncField(field, last, next) {
    if (field.input.value === last) { field.set({value: next}); field.input.value = next; }
    return next;
  }

  // ---------- rendering ----------

  const names = () => Object.fromEntries([
    ...(data?.devices ?? []).map(d => [d.id, deviceName(d)]),
    ...(data?.jobs ?? []).map(j => [j.id, jobLabel(j)]),
  ]);

  function renderHeader(a) {
    title.textContent = a.name?.trim() || a.email || ADMIN_COPY.unnamed;
    meta.replaceChildren(
      ...[
        a.name?.trim() && a.email ? h('span', {class: 'selectable'}, a.email) : null,
        a.email ? h('span', {}, a.emailVerified ? COPY.verified : COPY.unverified) : null,
        Number.isFinite(a.createdAt) ? h('span', {}, COPY.joined, ' ', timeEl(a.createdAt, tick)) : null,
        h('span', {class: 'admin-status', dataset: {status: a.status ?? 'active'}}, statusLabel(a.status)),
        a.admin ? h('span', {class: 'admin-badge'}, ADMIN_COPY.admin) : null,
      ].filter(Boolean));
  }

  function renderStorage(a) {
    const over = Number(a.usedBytes) > Number(a.limitBytes);
    usage.textContent = COPY.usage(formatBytes(a.usedBytes), formatBytes(a.limitBytes));
    rail.set({value: a.limitBytes > 0 ? Math.min(1, a.usedBytes / a.limitBytes) : 1, dataset: {tone: over ? 'warn' : 'ok'}});
    overNote.hidden = !over;
    access.set({
      value: a.status ?? 'active',
      options: COPY.accessOptions.map(o => (a.admin && o.value !== 'active' ? {...o, disabled: true, reason: COPY.adminLocked} : o)),
    });
    accessHelp.textContent = COPY.accessHelp[a.status ?? 'active'] ?? '';
    applied.override = syncField(override, applied.override, a.byteLimit == null ? '' : gbText(a.byteLimit));
    applied.notes = syncField(notes, applied.notes, a.notes ?? '');
  }

  function deviceRow(device) {
    const line = h('span', {class: 'admin-item-meta'});
    const name = h('span', {class: 'admin-item-title selectable'});
    const revoke = Button({label: COPY.revoke, variant: 'secondary', size: 'sm', className: 'admin-item-action',
      onClick: () => revokeDevice(entry.device)});
    rowButtons.add(revoke);
    const li = h('li', {class: 'admin-item'}, h('div', {class: 'admin-item-text'}, name, line), revoke.el);
    const entry = {
      el: li, device,
      update(next) {
        entry.device = next;
        name.textContent = deviceName(next);
        line.textContent = deviceLine(next, tick);
        line.dataset.state = next.revoked ? 'revoked' : isOnline(next, tick) ? 'online' : 'offline';
        if (!next.revoked && typeof next.lastSeenAt === 'number') line.dataset.volatile = ''; else delete line.dataset.volatile;
        revoke.el.hidden = !!next.revoked;
        revoke.set({attrs: {'aria-label': COPY.revokeName(deviceName(next))}});
      },
      destroy() { rowButtons.delete(revoke); revoke.destroy(); },
    };
    entry.update(device);
    return entry;
  }

  function jobRow(job) {
    const name = h('span', {class: 'admin-item-title selectable'});
    const line = h('span', {class: 'admin-item-meta'});
    const error = h('span', {class: 'admin-item-error selectable'});
    const when = h('span', {class: 'admin-item-when'});
    const cancel = Button({label: COPY.cancel, variant: 'secondary', size: 'sm', className: 'admin-item-action',
      onClick: () => cancelJob(entry.job)});
    rowButtons.add(cancel);
    const li = h('li', {class: 'admin-item'}, h('div', {class: 'admin-item-text'}, name, line, error, when), cancel.el);
    const entry = {
      el: li, job,
      update(next) {
        entry.job = next;
        name.textContent = jobLabel(next);
        line.textContent = jobLine(next);
        line.dataset.status = next.status ?? '';
        error.textContent = next.error ?? '';
        error.hidden = !next.error;
        when.replaceChildren(timeEl(next.createdAt, tick) ?? '');
        cancel.el.hidden = !isLiveJob(next);
        cancel.set({attrs: {'aria-label': COPY.cancelName(jobLabel(next))}});
      },
      destroy() { rowButtons.delete(cancel); cancel.destroy(); },
    };
    entry.update(job);
    return entry;
  }

  function render(a) {
    data = a;
    renderHeader(a);
    renderStorage(a);
    const devices = Array.isArray(a.devices) ? a.devices : [];
    reconcileList(deviceList, devices, {key: d => String(d.id), create: deviceRow});
    noDevices.hidden = devices.length > 0;
    const jobs = Array.isArray(a.jobs) ? a.jobs : [];
    reconcileList(jobList, jobs, {key: j => String(j.id), create: jobRow});
    noJobs.hidden = jobs.length > 0;
  }

  function showMissing() {
    body.hidden = true;
    skeleton.el.hidden = true;
    title.textContent = COPY.notFound;
    meta.replaceChildren();
    missing.hidden = false;
  }

  // ---------- changes (each behind the Reason dialog) ----------

  const changeAccount = (patch, why) => adminApi.updateAccount({
    id, status: data.status ?? 'active', byteLimit: data.byteLimit ?? null, notes: data.notes ?? '', ...patch, reason: why,
  });
  const reloadHistory = () => audit?.reload();

  async function changeAccess(value) {
    if (!data || value === (data.status ?? 'active')) return;
    const label = statusLabel(value);
    const reason = await askReason({
      title: COPY.accessTitle(label), body: COPY.accessHelp[value], confirmLabel: COPY.accessConfirm, danger: value !== 'active',
      run: why => changeAccount({status: value}, why),
    });
    if (destroyed) return;
    if (reason == null) { access.set({value: data.status ?? 'active'}); return; }
    data = {...data, status: value};
    access.set({value});
    accessHelp.textContent = COPY.accessHelp[value] ?? '';
    toast(COPY.accessSaved(label), {tone: 'ok'});
    reloadHistory();
  }

  overrideForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!data) return;
    overrideNote.el.hidden = true;
    const bytes = parseGB(override.input.value);
    if (Number.isNaN(bytes)) { override.set({error: COPY.badSize}); override.input.focus(); return; }
    const current = data.byteLimit ?? null;
    // Text left as shown keeps the stored bytes (the GB text rounds to 1 MB).
    const next = bytes !== null && current !== null && override.input.value.trim() === gbText(current) ? current : bytes;
    if (next === current) { overrideNote.el.hidden = false; return; }
    const reason = await askReason({
      title: COPY.overrideTitle,
      body: COPY.overrideBody(current == null ? COPY.planLimit : formatBytes(current), next == null ? COPY.planLimit : formatBytes(next)),
      confirmLabel: COPY.overrideConfirm,
      run: why => changeAccount({byteLimit: next}, why),
    });
    if (destroyed || reason == null) return;
    data = {...data, byteLimit: next};
    applied.override = next == null ? '' : gbText(next);
    override.set({value: applied.override}); override.input.value = applied.override;
    toast(COPY.overrideSaved, {tone: 'ok'});
    reloadHistory();
  });

  notesForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!data) return;
    notesNote.el.hidden = true;
    const text = notes.input.value;
    if (text.length > NOTES_MAX) { notes.set({error: COPY.notesTooLong}); notes.input.focus(); return; }
    if (text === (data.notes ?? '')) { notesNote.el.hidden = false; return; }
    const reason = await askReason({title: COPY.notesTitle, confirmLabel: COPY.notesConfirm, run: why => changeAccount({notes: text}, why)});
    if (destroyed || reason == null) return;
    data = {...data, notes: text};
    applied.notes = text;
    notes.set({value: text});
    toast(COPY.notesSaved, {tone: 'ok'});
    reloadHistory();
  });

  async function revokeDevice(device) {
    const name = deviceName(device);
    const reason = await askReason({
      title: COPY.revokeTitle(name), body: COPY.revokeBody, confirmLabel: COPY.revokeConfirm, danger: true,
      run: why => adminApi.revokeDevice({id: device.id, reason: why}),
    });
    if (destroyed || reason == null) return;
    toast(COPY.revoked(name), {tone: 'ok'});
    reloadHistory();
  }

  async function cancelJob(job) {
    const label = jobLabel(job);
    const reason = await askReason({
      title: COPY.cancelTitle(label), body: COPY.cancelBody, confirmLabel: COPY.cancelConfirm, cancelLabel: COPY.keep, danger: true,
      run: why => adminApi.cancelJob({id: job.id, reason: why}),
    });
    if (destroyed || reason == null) return;
    toast(COPY.cancelled(label), {tone: 'ok'});
    reloadHistory();
  }

  // ---------- data ----------

  let off = () => {};
  function subscribe() {
    off();
    let first = true;
    return new Promise(resolve => {
      off = adminApi.subscribeAccount({id}, value => {
        if (destroyed) return;
        skeleton.el.hidden = true;
        loadStatus.el.hidden = true;
        missing.hidden = true;
        body.hidden = false;
        render(value);
        if (first) {
          first = false;
          audit ??= AuditList({targetId: id, labelledBy: 'admin-account-history', names, selfId, now: () => tick});
          if (!audit.el.isConnected) historyHost.append(audit.el);
          audit.ready.then(resolve);
        }
      }, err => {
        if (destroyed) return;
        skeleton.el.hidden = true;
        if (err?.code === 'not_found') showMissing();
        else {
          loadStatus.set({text: loadError(err), action: {label: ADMIN_COPY.retry, run: () => { loadStatus.el.hidden = true; skeleton.el.hidden = false; subscribe(); }}});
          loadStatus.el.hidden = false;
        }
        resolve();
      });
    });
  }

  const timer = setInterval(() => {
    tick = clockNow();
    refreshTimes(content, tick);
    // Presence lines ("Online", "Last seen …") are re-evaluated against the new time.
    if (data) reconcileList(deviceList, data.devices ?? [], {key: d => String(d.id), create: deviceRow});
  }, TICK_MS);

  await subscribe();

  return {
    update(next) {
      const nextId = String(next?.params?.id ?? '');
      if (nextId === id) return;
      id = nextId;
      data = null;
      audit?.destroy(); audit = null;
      body.hidden = true; skeleton.el.hidden = false;
      subscribe();
    },
    unmount() {
      destroyed = true;
      clearInterval(timer);
      off();
      audit?.destroy();
      for (const b of [...rowButtons]) b.destroy();
      for (const p of [back, rail, access, override, saveOverride, overrideNote, notes, saveNotes, notesNote, skeleton, loadStatus]) p.destroy();
      el.replaceChildren();
    },
  };
}
