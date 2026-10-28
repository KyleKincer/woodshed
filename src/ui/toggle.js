// Toggle (architecture §2.12, spec §8.4): a Button with aria-pressed. The label names the
// feature ("Count-in"), never the state ("On"); development builds throw on a state word.
//
//   Toggle({label, pressed, onChange(pressed, event), command, sublabel, icon, size, variant, …Button props})
//     → {el, pressed, set(partial), destroy()}
//
// Without `command` the toggle keeps its own pressed state: a click flips it and calls
// onChange(pressed); `set({pressed})` overrides it. With `command`, the registry's `checked`
// drives aria-pressed live, a click runs the command, and onChange receives the command's new
// `checked` state.

import '../styles/primitives/toggle.css';
import {registry as appRegistry} from '../app/commands.js';
import {Button, isDev} from './button.js';

const STATE_WORDS = /^(on|off|enabled|disabled|yes|no)$/i;

function checkLabel(label) {
  if (isDev() && typeof label === 'string' && STATE_WORDS.test(label.trim())) {
    throw new TypeError(`Toggle: label "${label}" is a state word; name the feature instead (spec §8.4).`);
  }
}

export function Toggle(props = {}) {
  let p = {...props};
  checkLabel(p.label);
  let pressed = !!p.pressed;

  const view = () => ({
    ...p,
    className: ['ui-toggle', p.className].filter(Boolean).join(' '),
    // A command toggle shows the registry's checked state unless the caller pins `pressed`.
    pressed: p.command && p.pressed === undefined ? undefined : pressed,
    onClick,
  });

  function onClick(e) {
    if (p.command) {
      p.onChange?.(!!(p.registry ?? appRegistry).state(p.command)?.checked, e);
    } else {
      pressed = !pressed;
      button.set({pressed});
      p.onChange?.(pressed, e);
    }
    p.onClick?.(e);
  }

  const button = Button(view());

  return {
    el: button.el,
    get pressed() { return button.el.getAttribute('aria-pressed') === 'true'; },
    set(partial = {}) {
      if ('label' in partial) checkLabel(partial.label);
      p = {...p, ...partial};
      if ('pressed' in partial) pressed = !!partial.pressed;
      button.set(view());
    },
    destroy() { button.destroy(); },
  };
}
