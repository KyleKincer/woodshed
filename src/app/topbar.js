// The top bar of the Library, Settings and Admin places (architecture §2.13, spec §2.1): 56 px
// (60 on coarse pointers), left to right: the wordmark (Home), the search field with its ⌘K hint,
// the Jobs chip slot, ＋ Add song, and the avatar with the account menu.
//
//   mountTopbar(el, {router, store, desktop, registry}) → Topbar
//   Topbar = {
//     jobsSlot,                          the element src/library/jobs.js mountJobsChip(slot) fills (I1)
//     setJobsSlot(node|null),            replaces the slot's content
//     setSearch({value, onInput, onKeydown}|null),
//                                        the Library takes the search field over while it is mounted
//                                        (onInput(value, event), onKeydown(event)); null hands it back.
//                                        Without a handler, typing opens the Library filtered (?q=).
//     focusSearch(), clearSearch() → boolean, get searchValue,
//     openAccountMenu(), destroy(),
//   }
// The avatar menu: email; Settings (⌘, on the desktop app); Plan & storage; Keyboard shortcuts ?;
// App updates (desktop) or Get the desktop app (web); Administration (admins); Sign out. An 8 px dot
// on the avatar marks a desktop update that is ready to install (store.update).
//
// Copy is in COPY; CONTROLS lists each control's role and accessible name (the table test).

import '../styles/views/shell/topbar.css';
import {registry as appRegistry} from './commands.js';
import {effect} from './store.js';
import {Button} from '../ui/button.js';
import {h} from '../ui/h.js';
import {Kbd} from '../ui/kbd.js';
import {Menu} from '../ui/menu.js';

export const COPY = Object.freeze({
  wordmark: 'Woodshed',
  home: 'Woodshed, Library',
  search: 'Search songs',
  searchPlaceholder: 'Search songs, artists, sections…',
  add: 'Add song',
  account: 'Account',
  accountUpdate: 'Account, update ready',
  signedIn: 'Signed in',
});

export const CONTROLS = Object.freeze([
  {role: 'link', name: COPY.home},
  {role: 'searchbox', name: COPY.search},
  {role: 'button', name: COPY.add},
  {role: 'button', name: COPY.account},
]);

/** The avatar menu items (spec §2.1); command rows take their labels and state from the registry. */
export function accountMenuItems({session, desktopApp}) {
  const user = session?.user ?? null;
  return [
    {id: 'account.email', label: user?.email || user?.name || COPY.signedIn, icon: 'user', disabled: true},
    {type: 'separator'},
    {command: 'nav.settings', icon: 'settings', ...(desktopApp ? {kbd: 'Mod+,'} : {})},
    {command: 'nav.plan', icon: 'hard-drive'},
    {command: 'app.shortcuts', icon: 'keyboard'},
    desktopApp ? {command: 'app.updates', icon: 'download'} : {command: 'app.download', icon: 'external-link'},
    session?.admin ? {command: 'nav.admin', icon: 'sliders-horizontal'} : null,
    {type: 'separator'},
    {command: 'app.signOut', icon: 'log-out'},
  ].filter(Boolean);
}

/** Up to two initials for the avatar: from the name, else the email's local part. */
export function initialsOf(user) {
  const name = String(user?.name ?? '').trim();
  const words = name ? name.split(/\s+/) : [String(user?.email ?? '').split('@')[0]];
  const letters = words.filter(Boolean).slice(0, 2).map(w => [...w][0]?.toUpperCase() ?? '');
  return letters.join('') || '·';
}

export function mountTopbar(el, {router, store, desktop = {available: false}, registry = appRegistry} = {}) {
  const ac = new AbortController();
  const on = (target, type, fn) => target.addEventListener(type, fn, {signal: ac.signal});

  // ---- wordmark
  const wordmark = h('a', {class: 'shell-wordmark', href: '/', attrs: {'aria-label': COPY.home}}, COPY.wordmark);

  // ---- search
  const input = h('input', {class: 'shell-search-input', type: 'search', placeholder: COPY.searchPlaceholder,
    autocomplete: 'off', spellcheck: false, attrs: {'aria-label': COPY.search, enterkeyhint: 'search'}});
  const hint = Kbd({keys: 'Mod+KeyK', className: 'shell-search-kbd', attrs: {'aria-hidden': 'true'}});
  const search = h('div', {class: 'shell-search', attrs: {role: 'search'}}, input, hint.el);
  let handlers = null;

  function defaultInput(value) {
    const current = router?.current?.peek?.();
    if (current?.name === 'library') router.setQuery({q: value || null}, {debounceMs: 400});
    else if (value) router?.navigate?.(router.href('library', {}, {q: value}));
  }
  on(input, 'input', e => {
    if (handlers?.onInput) handlers.onInput(input.value, e);
    else defaultInput(input.value);
  });
  on(input, 'keydown', e => handlers?.onKeydown?.(e));

  // ---- jobs slot, add
  const jobsSlot = h('div', {class: 'shell-jobs', dataset: {jobsSlot: true}});
  const add = Button({label: COPY.add, icon: 'plus', variant: 'primary', className: 'shell-add', onClick: () => router?.navigate?.('/add')});

  // ---- avatar
  const picture = h('img', {class: 'shell-avatar-image', alt: '', attrs: {referrerpolicy: 'no-referrer', draggable: 'false'}});
  const initials = h('span', {class: 'shell-avatar-initials', attrs: {'aria-hidden': 'true'}});
  const dot = h('span', {class: 'shell-avatar-dot', attrs: {'aria-hidden': 'true'}});
  const avatar = h('button', {class: 'shell-avatar', type: 'button',
    attrs: {'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': COPY.account}}, picture, initials, dot);
  picture.addEventListener('error', () => { picture.hidden = true; initials.hidden = false; }, {signal: ac.signal});
  let menu = null;
  function openAccountMenu() {
    if (menu?.open) return menu;
    // Focus returns to the avatar when the menu closes (Safari does not focus a clicked button).
    if (avatar.ownerDocument.activeElement !== avatar) avatar.focus({preventScroll: true});
    avatar.setAttribute('aria-expanded', 'true');
    menu = Menu({
      items: accountMenuItems({session: store?.session?.peek?.(), desktopApp: !!desktop?.available}),
      anchor: avatar, placement: 'bottom', label: COPY.account, registry, className: 'shell-account-menu',
      onClose: () => { avatar.setAttribute('aria-expanded', 'false'); menu = null; },
    });
    return menu;
  }
  on(avatar, 'click', () => { if (menu?.open) menu.close('close'); else openAccountMenu(); });

  const right = h('div', {class: 'shell-topbar-end'}, jobsSlot, add.el, avatar);
  const bar = h('div', {class: 'shell-topbar'}, wordmark, search, right);
  el.classList.add('app-topbar');
  el.replaceChildren(bar);

  const disposers = [
    effect(() => {
      const user = store?.session?.value?.user ?? null;
      const src = user?.image || '';
      initials.textContent = initialsOf(user);
      if (src) {
        if (picture.getAttribute('src') !== src) picture.setAttribute('src', src);
        picture.hidden = false;
        initials.hidden = true;
      } else {
        picture.removeAttribute('src');
        picture.hidden = true;
        initials.hidden = false;
      }
    }),
    effect(() => {
      const ready = store?.update?.value?.status === 'ready';
      dot.hidden = !ready;
      avatar.setAttribute('aria-label', ready ? COPY.accountUpdate : COPY.account);
    }),
  ];

  const topbar = {
    jobsSlot,
    setJobsSlot(node) { jobsSlot.replaceChildren(...(node ? [node] : [])); },
    setSearch(next) {
      if (!next) {
        handlers = null;
        if (input.ownerDocument.activeElement !== input) input.value = '';
        return;
      }
      handlers = {onInput: next.onInput ?? null, onKeydown: next.onKeydown ?? null};
      if (next.value !== undefined && input.ownerDocument.activeElement !== input) input.value = next.value ?? '';
    },
    focusSearch() { input.focus(); input.select?.(); },
    clearSearch() {
      if (!input.value) return false;
      input.value = '';
      if (handlers?.onInput) handlers.onInput('', null);
      else defaultInput('');
      return true;
    },
    get searchValue() { return input.value; },
    get searchInput() { return input; },
    openAccountMenu,
    destroy() {
      ac.abort();
      for (const d of disposers) d();
      menu?.destroy?.();
      add.destroy();
      hint.destroy();
      bar.remove();
    },
  };
  return topbar;
}
