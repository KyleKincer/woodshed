// Library first run (spec §2.7 and §6.6.3–4; architecture §2.16): two cards side by side (stacked
// on iPad), shown while the library has no songs.
//
//   mountFirstRun(el, {demo, desktop, navigate}) → {update({demo}), destroy()}
//     demo      {token} from settings.demo, or null: the Demo card is hidden without a token (B8, D7)
//     desktop   true in the desktop app: "Add your first song" + ＋ Add song (/add); on the web and
//               iPad: "Add songs from your computer" + Get Woodshed for desktop ↗ (/download, new
//               tab) + I already have it, which reveals the sign-in hint
//     navigate  router.navigate (Add song → /add; Open example → /share/<token>, which boots the
//               Shared Stage)

import '../styles/views/library/first-run.css';
import {h} from '../ui/h.js';
import {icon} from '../ui/icon.js';
import {Button} from '../ui/button.js';
import {COPY} from './home.copy.js';

const DEMO_TOKEN_RE = /^[a-f0-9]{64}$/;

export function mountFirstRun(el, {demo = null, desktop = false, navigate = () => {}} = {}) {
  const buttons = [];
  const button = props => { const b = Button(props); buttons.push(b); return b.el; };

  // ---- the demo card
  const demoTitle = h('h2', {class: 'lib-first-title', id: 'lib-first-demo'}, COPY.demoTitle);
  const demoArt = h('div', {class: 'lib-first-art', attrs: {'aria-hidden': 'true'}}, icon('music', {size: 32}));
  let token = null;
  const openExample = button({label: COPY.openExample, icon: 'play', variant: 'primary', size: 'lg', className: 'lib-first-primary',
    onClick: () => { if (token) navigate(`/share/${token}`); }});
  const demoCard = h('section', {class: 'lib-first-card lib-first-demo', attrs: {'aria-labelledby': demoTitle.id}},
    demoArt, h('div', {class: 'lib-first-text'}, demoTitle, h('p', {class: 'lib-first-body'}, COPY.demoBody), h('div', {class: 'lib-first-actions'}, openExample)));

  // ---- the add card
  const addTitle = h('h2', {class: 'lib-first-title', id: 'lib-first-add'}, desktop ? COPY.addFirstTitle : COPY.webAddTitle);
  const addArt = h('div', {class: 'lib-first-art', attrs: {'aria-hidden': 'true'}}, icon(desktop ? 'plus' : 'monitor', {size: 32}));
  let actions;
  if (desktop) {
    actions = h('div', {class: 'lib-first-actions'},
      button({label: COPY.addSong, icon: 'plus', variant: 'primary', size: 'lg', className: 'lib-first-primary', onClick: () => navigate('/add')}));
  } else {
    const hint = h('p', {class: 'lib-first-hint', attrs: {role: 'status'}});
    hint.hidden = true;
    const download = h('a', {class: 'lib-first-link', href: '/download', target: '_blank', rel: 'noopener', attrs: {'data-native': ''}},
      h('span', {}, COPY.getDesktop), icon('external-link', {size: 20}), h('span', {class: 'sr-only'}, ` ${COPY.newTab}`));
    let already;
    already = Button({label: COPY.alreadyHave, variant: 'quiet', attrs: {'aria-expanded': 'false'},
      onClick: () => {
        hint.textContent = COPY.alreadyHaveBody;
        hint.hidden = false;
        already.el.setAttribute('aria-expanded', 'true');
      }});
    buttons.push(already);
    actions = h('div', {class: 'lib-first-actions'}, download, already.el, hint);
  }
  const addCard = h('section', {class: 'lib-first-card lib-first-add', attrs: {'aria-labelledby': addTitle.id}},
    addArt, h('div', {class: 'lib-first-text'}, addTitle, h('p', {class: 'lib-first-body'}, desktop ? COPY.addFirstBody : COPY.webAddBody), actions));

  const root = h('div', {class: 'lib-first-run', dataset: {desktop: desktop ? 'true' : 'false'}}, demoCard, addCard);
  el.append(root);

  function update({demo: next} = {}) {
    token = next && typeof next.token === 'string' && DEMO_TOKEN_RE.test(next.token) ? next.token : null;
    demoCard.hidden = !token;
    root.dataset.cards = token ? '2' : '1';
  }
  update({demo});

  return {
    el: root,
    update,
    destroy() {
      for (const b of buttons) b.destroy();
      root.remove();
    },
  };
}
