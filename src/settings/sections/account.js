// Settings → Account (architecture §2.17, §2.23; spec §6.2): the signed-in email, the Google account
// it uses, Sign out (app.signOut) and, for administrators, the Administration link (nav.admin). The
// values come from store.session (boot step 4) and follow it.

import '../../styles/views/settings/sections.css';
import {h} from '../../ui/h.js';
import {Button} from '../../ui/button.js';
import {settingRow} from '../settings.js';
import {COPY, SECTION_TITLES} from '../settings.copy.js';

const A = COPY.account;

function render(el, ctx) {
  const {store, registry} = ctx;
  const emailValue = h('p', {class: 'settings-value'});
  const googleValue = h('p', {class: 'settings-value'});
  const email = settingRow({row: 'email', label: A.email, scope: 'info', controls: [emailValue]});
  const google = settingRow({row: 'google', label: A.google, scope: 'info', controls: [googleValue]});
  const signOut = Button({command: 'app.signOut', registry, label: A.signOut, icon: 'log-out', className: 'settings-signout'});
  const admin = Button({command: 'nav.admin', registry, label: A.admin, icon: 'sliders-horizontal', iconEnd: 'chevron-right'});
  const actions = h('div', {class: 'settings-row settings-actions', dataset: {scope: 'info', row: 'signOut'}}, signOut.el);
  const adminRow = settingRow({row: 'admin', hint: A.adminHint, scope: 'info', controls: [admin]});

  function show(session) {
    const user = session?.user ?? null;
    emailValue.textContent = user?.email || '—';
    googleValue.textContent = A.signedIn(user?.name ?? '');
    adminRow.el.hidden = !session?.admin;
  }
  show(store.session.peek());
  const off = store.session.subscribe(show);

  const page = h('div', {class: 'settings-section', dataset: {section: 'account'}},
    h('div', {class: 'settings-group'}, email.el, google.el, actions, adminRow.el));
  el.replaceChildren(page);

  return {
    destroy() {
      off();
      signOut.destroy();
      admin.destroy();
      page.remove();
    },
  };
}

export default Object.freeze({id: 'account', title: SECTION_TITLES.account, render});
