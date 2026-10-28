// The Administration place (route `admin`, `/admin`; spec §6.4, architecture §2.17), admins only (the
// route guard). Calm, built from the same primitives as Settings:
//   1. Storage: overview cards (cloud storage used of the ceiling, the default per account, the
//      ceiling's base and paid capacity) and the Storage policy form (default account limit, base
//      ceiling, in GB). Saving opens the Reason dialog.
//   2. Accounts: search by exact email (mirrored to `?email=` with replace), the account list with
//      Load more; each row links to /admin/accounts/:id and carries data-focus-key="account:<id>", so
//      Back from an account page refocuses it.
//   3. Audit history: every administration change, newest first, with Load more.
// Every mutation goes through askReason (reason-dialog.js); there is no window.prompt.
//
//   mount(el, match, ctx) → Promise<{update(match), unmount()}>   resolves once the first data arrived, or
//     after FIRST_DATA_MS with the skeletons showing: navigation never waits on a slow or offline backend.
//
// Also exported for account.js and the tests: COPY, CONTROLS, formatBytes, gbText, parseGB,
// statusLabel, describeAudit and AuditList.

import '../../styles/views/settings/admin.css';
import {h, reconcileList} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {TextField} from '../../ui/field.js';
import {InlineStatus} from '../../ui/status.js';
import {ProgressRail} from '../../ui/progress.js';
import {Skeleton} from '../../ui/skeleton.js';
import {store as appStore} from '../../app/store.js';
import {toast} from '../../app/feedback.js';
import {now as clockNow} from '../../app/clock.js';
import {relativeTime} from '../../library/song-labels.js';
import * as adminApi from '../../api/admin.js';
import {adminError, askReason} from './reason-dialog.js';

const GB = 1e9;
const MB = 1e6;
/** How often relative times ("5 min ago") are refreshed while a page is mounted. */
export const TICK_MS = 30_000;
/** The longest a page's mount waits for its first data (the router's focus restore wants the rows). */
export const FIRST_DATA_MS = 1500;

/** Resolves when `promise` settles or after `ms`, whichever is first. */
export function firstData(promise, ms = FIRST_DATA_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise(resolve => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => clearTimeout(timer));
}

export const STATUS_LABELS = Object.freeze({active: 'Active', export_only: 'Export only', suspended: 'Suspended'});

export const COPY = Object.freeze({
  title: 'Administration',
  lead: 'Storage, accounts and the audit history.',
  storage: 'Storage',
  cloud: 'Cloud storage',
  cloudOf: (used, total) => `${used} of ${total}`,
  cloudMeter: 'Cloud storage used',
  cloudNote: 'Includes uploads still in progress.',
  perAccount: 'Default per account',
  perAccountNote: 'Plus accounts get their plan’s allowance when it is larger.',
  ceiling: 'Ceiling',
  ceilingNote: (base, funded) => `${base} base + ${funded} paid capacity from Plus subscriptions.`,
  policy: 'Storage policy',
  userLimit: 'Default account limit (GB)',
  appLimit: 'Base app ceiling (GB)',
  policyHint: 'Lowering a limit pauses new uploads for anyone above it. Stored files are kept. Account overrides take precedence over the default.',
  savePolicy: 'Save policy…',
  policyTitle: 'Change the storage policy?',
  policyBody: (user, app) => `Default account limit ${user} · base app ceiling ${app}.`,
  policySaved: 'Storage policy saved.',
  policyUnchanged: 'Change a limit to save the policy.',
  badSize: 'Enter a size in GB, like 2 or 0.25.',
  accounts: 'Accounts',
  searchLabel: 'Find an account by exact email',
  searchPlaceholder: 'name@example.com',
  search: 'Search',
  showAll: 'Show all',
  noAccounts: 'No accounts yet.',
  noMatch: email => `No account uses ${email}.`,
  admin: 'Admin',
  unnamed: 'Unnamed account',
  usage: (used, limit) => `${used} of ${limit}`,
  over: 'Over limit',
  loadMore: 'Load more',
  loading: 'Loading…',
  retry: 'Retry',
  loadFailed: 'This couldn’t be loaded.',
  history: 'Audit history',
  noHistory: 'No administration changes yet.',
  noAccountHistory: 'No changes to this account yet.',
  by: 'by',
  you: 'you',
  policyTarget: 'Storage policy',
  account: 'Account',
  actions: Object.freeze({
    'account.update': 'Account changed',
    'policy.update': 'Storage policy changed',
    'device.revoke': 'Computer revoked',
    'job.cancel': 'Job cancelled',
  }),
  change: Object.freeze({
    status: (from, to) => `Access: ${from} → ${to}`,
    byteLimit: (from, to) => `Storage override: ${from} → ${to}`,
    notes: 'Notes edited',
    userBytes: (from, to) => `Default account limit: ${from} → ${to}`,
    appBytes: (from, to) => `Base app ceiling: ${from} → ${to}`,
    device: name => `Computer: ${name}`,
    job: (label, status) => `Job: ${label} (was ${status})`,
  }),
  defaultLimit: 'default',
  reasonQuote: reason => `“${reason}”`,
});

/** Controls of the /admin page (role, accessible name) for the table test (§9.0). */
export const CONTROLS = Object.freeze([
  {role: 'heading', name: COPY.title},
  {role: 'textbox', name: COPY.userLimit},
  {role: 'textbox', name: COPY.appLimit},
  {role: 'button', name: COPY.savePolicy},
  {role: 'searchbox', name: COPY.searchLabel},
  {role: 'button', name: COPY.search},
  {role: 'heading', name: COPY.history},
]);

// ---------------------------------------------------------------------------------------------- formatting

/** '412 MB', '1.2 GB', '61.2 GB', '200 GB' (decimal units, as the storage meter in Settings). */
export function formatBytes(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '0 MB';
  // Sizes that would round to 1000 MB read as GB.
  if (b < GB && Math.round(b / MB) < 1000) {
    const mb = b / MB;
    return `${mb < 10 ? Number(mb.toFixed(1)) : Math.round(mb)} MB`;
  }
  const gb = b / GB;
  return `${gb < 100 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/** The GB text a field shows for a byte count: '1', '0.25', '150' (up to 3 decimals). */
export function gbText(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b < 0) return '';
  return String(Number((b / GB).toFixed(3)));
}

/** Parses a GB field: whole bytes, null for blank, NaN for anything that is not a size ≥ 0. */
export function parseGB(text) {
  const t = String(text ?? '').trim().replace(/\s*gb$/i, '');
  if (!t) return null;
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return NaN;
  const bytes = Math.round(Number(t) * GB);
  return Number.isSafeInteger(bytes) ? bytes : NaN;
}

export const statusLabel = status => STATUS_LABELS[status] ?? STATUS_LABELS.active;

const dateFormat = ms => {
  try { return new Date(ms).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}); }
  catch { return new Date(ms).toISOString(); }
};

/** <time> with the relative text, the absolute time as its title (volatile in captures). */
export function timeEl(ms, now, className = 'admin-time') {
  if (!Number.isFinite(ms)) return null;
  return h('time', {class: className, dateTime: new Date(ms).toISOString(), title: dateFormat(ms), dataset: {volatile: '', at: String(ms)}},
    relativeTime(ms, now));
}

/** Re-renders the relative text of every timeEl under `root`. */
export function refreshTimes(root, now) {
  for (const t of root.querySelectorAll('time[data-at]')) t.textContent = relativeTime(Number(t.dataset.at), now);
}

const limitText = bytes => (bytes == null ? COPY.defaultLimit : formatBytes(bytes));

/**
 * The title and change lines of an audit row. `names` maps device and job ids to their names
 * (the account page knows them); unknown ids read as the id.
 */
export function describeAudit(row, {names = {}} = {}) {
  const title = COPY.actions[row?.action] ?? String(row?.action ?? '');
  const before = row?.before && typeof row.before === 'object' ? row.before : {};
  const after = row?.after && typeof row.after === 'object' ? row.after : {};
  const changes = [];
  switch (row?.action) {
    case 'account.update': {
      const fromStatus = before.status ?? 'active';
      if (after.status && after.status !== fromStatus) changes.push(COPY.change.status(statusLabel(fromStatus), statusLabel(after.status)));
      const fromLimit = before.byteLimit ?? null, toLimit = after.byteLimit ?? null;
      if (fromLimit !== toLimit) changes.push(COPY.change.byteLimit(limitText(fromLimit), limitText(toLimit)));
      if ((before.notes ?? '') !== (after.notes ?? '')) changes.push(COPY.change.notes);
      break;
    }
    case 'policy.update':
      if (before.userBytes !== after.userBytes) changes.push(COPY.change.userBytes(formatBytes(before.userBytes), formatBytes(after.userBytes)));
      if ((before.baseAppBytes ?? before.appBytes) !== after.appBytes) {
        changes.push(COPY.change.appBytes(formatBytes(before.baseAppBytes ?? before.appBytes), formatBytes(after.appBytes)));
      }
      break;
    case 'device.revoke':
      if (before.id) changes.push(COPY.change.device(names[before.id] ?? before.id));
      break;
    case 'job.cancel':
      if (before.id) changes.push(COPY.change.job(names[before.id] ?? before.id, String(before.status ?? '').replace('_', ' ')));
      break;
    default:
  }
  return {title, changes};
}

/** The sentence for a failed load, with the server's detail. */
export const loadError = err => adminError(err, {context: 'load', fallback: COPY.loadFailed});

/** A link styled as text that the app frame's router.link delegate navigates. */
const accountLink = (id, text, className = 'admin-link') => h('a', {class: className, href: `/admin/accounts/${encodeURIComponent(id)}`}, text);

// ---------------------------------------------------------------------------------------------- audit history

/**
 * The audit history list with Load more. `targetId` narrows it to one account.
 *   AuditList({targetId, labelledBy, names: () => ({id: name}), selfId, now: () => ms})
 *     → {el, ready: Promise, reload(): Promise, refreshTimes(), destroy()}
 */
export function AuditList({targetId = null, labelledBy, names = () => ({}), selfId = null, now = clockNow} = {}) {
  const list = h('ol', {class: 'admin-audit', attrs: {'aria-labelledby': labelledBy}});
  const empty = h('p', {class: 'admin-empty', hidden: true}, targetId ? COPY.noAccountHistory : COPY.noHistory);
  const status = InlineStatus({tone: 'error', text: '', className: 'admin-load-error'});
  status.el.hidden = true;
  const skeleton = Skeleton({shape: 'row', count: 3});
  const more = Button({label: COPY.loadMore, variant: 'secondary', className: 'admin-more', onClick: () => loadPage()});
  more.el.hidden = true;
  const el = h('div', {class: 'admin-audit-box', attrs: {'aria-busy': 'true'}}, skeleton.el, list, empty, status.el, more.el);

  let rows = [];
  let cursor = null;
  let generation = 0;
  let destroyed = false;

  const actorText = actorId => (selfId && actorId === selfId ? COPY.you : actorId);

  function renderRow(row) {
    const entry = {el: h('li', {class: 'admin-audit-row'}), update(next) { fill(entry.el, next); }};
    fill(entry.el, row);
    return entry;
  }

  function fill(li, row) {
    const {title, changes} = describeAudit(row, {names: names()});
    const target = targetId ? null
      : row.targetId === 'app' ? h('span', {class: 'admin-audit-target'}, COPY.policyTarget)
        : h('span', {class: 'admin-audit-target'}, `${COPY.account} `, accountLink(row.targetId, row.targetId, 'admin-link admin-mono'));
    const actor = row.actorId
      ? h('span', {class: 'admin-audit-actor'}, `${COPY.by} `,
        selfId && row.actorId === selfId ? actorText(row.actorId) : accountLink(row.actorId, row.actorId, 'admin-link admin-mono'))
      : null;
    li.replaceChildren(
      h('div', {class: 'admin-audit-head'},
        h('span', {class: 'admin-audit-title'}, title),
        target,
        timeEl(row.at, now())),
      changes.length ? h('ul', {class: 'admin-audit-changes'}, changes.map(c => h('li', {}, c))) : null,
      h('p', {class: 'admin-audit-reason selectable'}, COPY.reasonQuote(row.reason ?? ''), actor ? ' ' : null, actor),
    );
  }

  function render() {
    reconcileList(list, rows, {key: keyOf, create: renderRow});
    empty.hidden = rows.length > 0;
  }

  const keyOf = r => String(r._id ?? `${r.at}:${r.action}:${r.targetId}`);

  // A failed load keeps the rows and the cursor it started from; Retry repeats exactly that request.
  async function loadPage({reset = false} = {}) {
    const gen = reset ? ++generation : generation;
    const from = reset ? null : cursor;
    more.set({busy: !reset ? COPY.loading : false, disabled: true});
    el.setAttribute('aria-busy', 'true');
    try {
      const result = await adminApi.history({targetId: targetId ?? undefined, cursor: from});
      if (destroyed || gen !== generation) return;
      const page = Array.isArray(result?.page) ? result.page : [];
      // A page that overlaps the rows shown (a row added since) does not repeat them.
      const seen = new Set(reset ? [] : rows.map(keyOf));
      rows = reset ? page : [...rows, ...page.filter(r => !seen.has(keyOf(r)))];
      cursor = result?.continueCursor ?? null;
      status.el.hidden = true;
      more.el.hidden = !!result?.isDone || !cursor;
      render();
    } catch (err) {
      if (destroyed || gen !== generation) return;
      status.set({text: loadError(err), action: {label: COPY.retry, run: () => loadPage({reset})}});
      status.el.hidden = false;
    } finally {
      if (!destroyed && gen === generation) {
        skeleton.el.hidden = true;
        el.setAttribute('aria-busy', 'false');
        more.set({busy: false, disabled: false});
      }
    }
  }

  const ready = loadPage({reset: true});
  return {
    el,
    ready,
    reload: () => loadPage({reset: true}),
    refreshTimes() { refreshTimes(list, now()); },
    destroy() { destroyed = true; more.destroy(); status.destroy(); skeleton.destroy(); el.remove(); },
  };
}

// ---------------------------------------------------------------------------------------------- the page

function OverviewCards() {
  const cloudValue = h('p', {class: 'admin-card-value tabular'});
  const rail = ProgressRail({value: 0, label: COPY.cloudMeter, className: 'admin-meter'});
  const perValue = h('p', {class: 'admin-card-value tabular'});
  const ceilValue = h('p', {class: 'admin-card-value tabular'});
  const ceilNote = h('p', {class: 'admin-note'});
  const card = (title, value, ...rest) => h('article', {class: 'admin-card'}, h('h3', {class: 'admin-card-title'}, title), value, ...rest);
  const el = h('div', {class: 'admin-cards'},
    card(COPY.cloud, cloudValue, rail.el, h('p', {class: 'admin-note'}, COPY.cloudNote)),
    card(COPY.perAccount, perValue, h('p', {class: 'admin-note'}, COPY.perAccountNote)),
    card(COPY.ceiling, ceilValue, ceilNote));
  return {
    el,
    set(o) {
      cloudValue.textContent = COPY.cloudOf(formatBytes(o.usedBytes), formatBytes(o.appBytes));
      rail.set({value: o.appBytes > 0 ? Math.min(1, o.usedBytes / o.appBytes) : 1, dataset: {tone: o.usedBytes >= o.appBytes ? 'warn' : 'ok'}});
      perValue.textContent = formatBytes(o.userBytes);
      ceilValue.textContent = formatBytes(o.appBytes);
      ceilNote.textContent = COPY.ceilingNote(formatBytes(o.baseAppBytes), formatBytes(o.fundedBytes ?? Math.max(0, o.appBytes - o.baseAppBytes)));
    },
    destroy() { rail.destroy(); },
  };
}

function PolicyForm({onSaved, signal}) {
  let overview = null;
  const user = TextField({label: COPY.userLimit, inputmode: 'decimal', autocomplete: 'off', className: 'admin-policy-field', onInput: () => validate()});
  const app = TextField({label: COPY.appLimit, inputmode: 'decimal', autocomplete: 'off', className: 'admin-policy-field', onInput: () => validate()});
  const save = Button({label: COPY.savePolicy, variant: 'primary', type: 'submit', className: 'admin-policy-save'});
  const note = InlineStatus({tone: 'info', text: COPY.policyUnchanged, className: 'admin-policy-note'});
  note.el.hidden = true;
  const titleId = 'admin-policy-title';
  const form = h('form', {class: 'admin-policy', novalidate: true, attrs: {'aria-labelledby': titleId}},
    h('h3', {class: 'admin-subtitle', id: titleId}, COPY.policy),
    h('div', {class: 'admin-policy-fields'}, user.el, app.el),
    h('p', {class: 'admin-note'}, COPY.policyHint),
    h('div', {class: 'admin-actions'}, save.el, note.el));

  // A field left as shown keeps the stored bytes (the GB text rounds to 1 MB).
  const valueOf = (field, stored) => (field.value.trim() === gbText(stored) ? stored : parseGB(field.value));
  const values = () => ({userBytes: valueOf(user, overview?.userBytes), appBytes: valueOf(app, overview?.baseAppBytes)});
  const fieldError = v => (v === null || Number.isNaN(v) ? COPY.badSize : undefined);

  // While typing, only a non-empty bad value is flagged; submitting flags a blank one too.
  function validate({submitting = false} = {}) {
    const v = values();
    user.set({error: submitting || user.value.trim() ? fieldError(v.userBytes) : undefined});
    app.set({error: submitting || app.value.trim() ? fieldError(v.appBytes) : undefined});
    note.el.hidden = true;
    const valid = Number.isSafeInteger(v.userBytes) && Number.isSafeInteger(v.appBytes);
    const changed = !!overview && (v.userBytes !== overview.userBytes || v.appBytes !== overview.baseAppBytes);
    if (submitting && valid && !changed) note.el.hidden = false;
    return valid && changed ? v : null;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!overview) return;
    const v = validate({submitting: true});
    if (!v) {
      (user.input.getAttribute('aria-invalid') === 'true' ? user.input : app.input.getAttribute('aria-invalid') === 'true' ? app.input : null)?.focus();
      return;
    }
    const reason = await askReason({
      title: COPY.policyTitle,
      body: COPY.policyBody(formatBytes(v.userBytes), formatBytes(v.appBytes)),
      confirmLabel: 'Save policy',
      run: why => adminApi.updatePolicy({...v, reason: why}),
      signal,
    });
    if (reason == null || signal?.aborted) return;
    overview = {...overview, userBytes: v.userBytes, baseAppBytes: v.appBytes};
    user.set({value: gbText(v.userBytes)}); user.input.value = gbText(v.userBytes);
    app.set({value: gbText(v.appBytes)}); app.input.value = gbText(v.appBytes);
    validate();
    toast(COPY.policySaved, {tone: 'ok'});
    onSaved?.();
  });

  return {
    el: form,
    set(next) {
      const dirtyUser = overview && user.value.trim() !== gbText(overview.userBytes);
      const dirtyApp = overview && app.value.trim() !== gbText(overview.baseAppBytes);
      overview = next;
      // Keep what the administrator is typing; refresh untouched fields from the server.
      if (!dirtyUser) { user.set({value: gbText(next.userBytes)}); user.input.value = gbText(next.userBytes); }
      if (!dirtyApp) { app.set({value: gbText(next.baseAppBytes)}); app.input.value = gbText(next.baseAppBytes); }
      validate();
    },
    destroy() { user.destroy(); app.destroy(); save.destroy(); note.destroy(); },
  };
}

function AccountRow(account) {
  const li = h('li', {class: 'admin-account-row'});
  const entry = {el: li, update(next) { fill(next); }};
  function fill(a) {
    const over = Number(a.usedBytes) > Number(a.limitBytes);
    const name = a.name?.trim() || a.email || COPY.unnamed;
    li.replaceChildren(h('a', {class: 'admin-account-link', href: `/admin/accounts/${encodeURIComponent(a.id)}`, dataset: {focusKey: `account:${a.id}`}},
      h('span', {class: 'admin-account-name'}, name, a.admin ? h('span', {class: 'admin-badge'}, COPY.admin) : null),
      a.name?.trim() && a.email ? h('span', {class: 'admin-account-email'}, a.email) : null,
      h('span', {class: 'admin-account-meta'},
        h('span', {class: 'admin-status', dataset: {status: a.status ?? 'active'}}, statusLabel(a.status)),
        h('span', {class: 'admin-account-usage tabular', dataset: {tone: over ? 'warn' : ''}},
          COPY.usage(formatBytes(a.usedBytes), formatBytes(a.limitBytes)), over ? ` · ${COPY.over}` : null))));
  }
  fill(account);
  return entry;
}

function AccountSearch({initialEmail = '', onEmail}) {
  const titleId = 'admin-accounts-title';
  const field = TextField({label: COPY.searchLabel, type: 'search', value: initialEmail, placeholder: COPY.searchPlaceholder,
    inputmode: 'email', autocomplete: 'off', className: 'admin-search-field'});
  const submit = Button({label: COPY.search, icon: 'search', variant: 'secondary', type: 'submit'});
  const showAll = Button({label: COPY.showAll, variant: 'quiet', onClick: () => { field.set({value: ''}); field.input.value = ''; run(''); }});
  const form = h('form', {class: 'admin-search', role: 'search', novalidate: true, attrs: {'aria-label': COPY.searchLabel}},
    field.el, h('div', {class: 'admin-search-actions'}, submit.el, showAll.el));
  const list = h('ul', {class: 'admin-account-list', attrs: {'aria-labelledby': titleId}});
  const empty = h('p', {class: 'admin-empty', role: 'status', hidden: true});
  const status = InlineStatus({tone: 'error', text: '', className: 'admin-load-error'});
  status.el.hidden = true;
  const skeleton = Skeleton({shape: 'row', count: 4});
  const more = Button({label: COPY.loadMore, variant: 'secondary', className: 'admin-more', onClick: () => load()});
  more.el.hidden = true;
  const box = h('div', {class: 'admin-accounts-box', attrs: {'aria-busy': 'true'}}, skeleton.el, list, empty, status.el, more.el);

  let email = initialEmail.trim();
  let rows = [], cursor = null, generation = 0, destroyed = false;

  async function load({reset = false} = {}) {
    const gen = reset ? ++generation : generation;
    if (reset) { cursor = null; rows = []; }
    more.set({busy: reset ? false : COPY.loading, disabled: true});
    box.setAttribute('aria-busy', 'true');
    try {
      const result = await adminApi.accounts({email: email || undefined, cursor});
      if (destroyed || gen !== generation) return;
      const page = Array.isArray(result?.page) ? result.page : [];
      const seen = new Set(rows.map(a => String(a.id)));
      rows = reset ? page : [...rows, ...page.filter(a => !seen.has(String(a.id)))];
      cursor = result?.continueCursor ?? null;
      reconcileList(list, rows, {key: a => String(a.id), create: AccountRow});
      empty.textContent = rows.length ? '' : email ? COPY.noMatch(email) : COPY.noAccounts;
      empty.hidden = rows.length > 0;
      status.el.hidden = true;
      more.el.hidden = !!result?.isDone || !cursor;
    } catch (err) {
      if (destroyed || gen !== generation) return;
      status.set({text: loadError(err), action: {label: COPY.retry, run: () => load({reset})}});
      status.el.hidden = false;
    } finally {
      if (!destroyed && gen === generation) {
        skeleton.el.hidden = true;
        box.setAttribute('aria-busy', 'false');
        more.set({busy: false, disabled: false});
      }
    }
  }

  function run(next) {
    email = next.trim();
    showAll.el.hidden = !email;
    onEmail?.(email);
    return load({reset: true});
  }

  form.addEventListener('submit', e => { e.preventDefault(); run(field.input.value); });
  showAll.el.hidden = !email;

  return {
    form, box, titleId,
    ready: load({reset: true}),
    get email() { return email; },
    search(next) { field.set({value: next}); field.input.value = next; return run(next); },
    destroy() { destroyed = true; field.destroy(); submit.destroy(); showAll.destroy(); more.destroy(); status.destroy(); skeleton.destroy(); },
  };
}

/** Mounts /admin. See the header. */
export async function mount(el, match, ctx = {}) {
  const store = ctx.store ?? appStore;
  const router = ctx.router ?? null;
  const selfId = store.session?.peek?.()?.user?.id ?? null;
  let tick = clockNow();

  const scroller = h('div', {class: 'admin-scroller', attrs: {'data-scroller': ''}});
  const content = h('div', {class: 'app-content admin-page'});
  scroller.append(content);
  el.replaceChildren(scroller);

  // Storage
  const cards = OverviewCards();
  const overviewError = InlineStatus({tone: 'error', text: '', className: 'admin-load-error'});
  overviewError.el.hidden = true;
  const cardsSkeleton = Skeleton({shape: 'text', count: 3});
  cards.el.hidden = true;
  const audit = AuditList({labelledBy: 'admin-history-title', selfId, now: () => tick});
  // Leaving the page closes a Reason dialog it opened.
  const leaving = new AbortController();
  const policy = PolicyForm({onSaved: () => audit.reload(), signal: leaving.signal});
  const storageSection = h('section', {class: 'admin-section', attrs: {'aria-labelledby': 'admin-storage-title'}},
    h('h2', {class: 'admin-section-title', id: 'admin-storage-title'}, COPY.storage),
    cardsSkeleton.el, cards.el, overviewError.el, policy.el);

  // Accounts
  const search = AccountSearch({
    initialEmail: String(match?.query?.email ?? ''),
    onEmail: email => router?.setQuery?.({email: email || null}),
  });
  const accountsSection = h('section', {class: 'admin-section', attrs: {'aria-labelledby': search.titleId}},
    h('h2', {class: 'admin-section-title', id: search.titleId}, COPY.accounts), search.form, search.box);

  // History
  const historySection = h('section', {class: 'admin-section', attrs: {'aria-labelledby': 'admin-history-title'}},
    h('h2', {class: 'admin-section-title', id: 'admin-history-title'}, COPY.history), audit.el);

  content.append(
    h('header', {class: 'admin-header'}, h('h1', {class: 'admin-title'}, COPY.title), h('p', {class: 'admin-lead'}, COPY.lead)),
    storageSection, accountsSection, historySection);

  let resolveOverview;
  const overviewReady = new Promise(resolve => { resolveOverview = resolve; });
  const off = adminApi.subscribeOverview(value => {
    cardsSkeleton.el.hidden = true;
    overviewError.el.hidden = true;
    cards.el.hidden = false;
    cards.set(value);
    policy.set(value);
    resolveOverview();
  }, err => {
    cardsSkeleton.el.hidden = true;
    overviewError.set({text: loadError(err)});
    overviewError.el.hidden = false;
    resolveOverview();
  });

  const timer = setInterval(() => { tick = clockNow(); audit.refreshTimes(); }, TICK_MS);

  await firstData(Promise.all([overviewReady, search.ready, audit.ready]));

  return {
    update(next) {
      const email = String(next?.query?.email ?? '');
      if (email.trim() !== search.email) search.search(email);
    },
    unmount() {
      leaving.abort();
      clearInterval(timer);
      off();
      cards.destroy(); policy.destroy(); search.destroy(); audit.destroy();
      overviewError.destroy(); cardsSkeleton.destroy();
      el.replaceChildren();
    },
  };
}
