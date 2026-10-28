// Dialog (architecture §2.12, spec §7.9): native <dialog>.showModal() for confirms, forms and notices. feedback.js
// builds confirm() and form() on it; Library, Admin and Share dialogs use it directly.
//
//   Dialog({title, body, actions, danger = false, form, onClose, width = 480, error,
//           className, id, attrs, dataset, testid})
//     → {el, set(partial), close(value = null), destroy(), closed: Promise<value>, get open}
//   actions  [{label, variant: 'primary'|'secondary'|'quiet'|'danger', value, autofocus, submit}]
//            default: [OK] without a form, [Cancel] [Save] with one. Clicking an action closes with its value; the submit
//            action (the one marked `submit`, else the last primary or danger action of a form) submits the form instead.
//   form     {fields: FieldSpec[], onSubmit: async values => void}
//            FieldSpec {name, label, kind: 'text'|'textarea', required, minLength, maxLength, value, hint, placeholder,
//                       autocomplete, inputmode, rows}
//            Enter in a text field submits. Fields are validated first (required, minLength, maxLength) with the
//            message under the field. While onSubmit runs the dialog is busy (actions inert, Esc ignored); when it
//            throws, the dialog stays open and shows the error inline (role=alert), at the field when the error has a
//            matching `field`; when it resolves, the dialog closes with the values. A form without onSubmit closes
//            with the values.
//   danger   the destructive style for the confirm action only (spec §7.9); focus starts on the safe action.
//   Esc closes with null (through the dispatcher's overlay stack, as a modal overlay, D36). Opening a dialog closes open
//   menus; closing it closes every overlay opened inside it (reason 'dialog'). Focus returns to where it was. `onClose(value)` runs once; destroy() closes silently (closed resolves null).

import {pushOverlay} from '../app/dispatch.js';
import {h} from './h.js';
import {closeAllMenus} from './menu.js';
import {
  applyCommon, closeLayersInside, withDefaults, layerHost, pushModalHost, restoreFocus, setContent, trackLayer, trapTab,
} from './popover.js';
import '../styles/primitives/dialog.css';

const VARIANTS = new Set(['primary', 'secondary', 'quiet', 'danger']);
let dialogSeq = 0;

/** The copy for a field that fails validation, or null. */
export function validateField(spec, value) {
  const text = String(value ?? '');
  const trimmed = text.trim();
  if (spec.required && !trimmed) return `${spec.label} is required.`;
  if (trimmed && spec.minLength && trimmed.length < spec.minLength) return `${spec.label} needs at least ${spec.minLength} characters.`;
  if (spec.maxLength && text.length > spec.maxLength) return `${spec.label} can be at most ${spec.maxLength} characters.`;
  return null;
}

const errorText = err => {
  if (err == null) return 'Something went wrong.';
  if (typeof err === 'string') return err;
  return String(err.userMessage ?? err.message ?? err);
};

/** Opens a modal dialog. See the header. */
export function Dialog(props = {}) {
  let p = withDefaults({danger: false, width: 480}, props);
  const doc = globalThis.document;
  const seq = ++dialogSeq;
  const ids = {title: `ui-dialog-${seq}-title`, body: `ui-dialog-${seq}-body`, error: `ui-dialog-${seq}-error`};
  const previous = doc.activeElement;

  const title = h('h2', {class: 'ui-dialog-title', id: ids.title});
  const body = h('div', {class: 'ui-dialog-body', id: ids.body});
  const fieldsBox = h('div', {class: 'ui-dialog-fields'});
  const error = h('p', {class: 'ui-dialog-error', id: ids.error, role: 'alert', hidden: true});
  const actionsBox = h('div', {class: 'ui-dialog-actions'});
  const formEl = h('form', {class: 'ui-dialog-form', novalidate: true}, title, body, fieldsBox, error, actionsBox);
  const el = h('dialog', {class: 'ui-dialog', 'aria-labelledby': ids.title}, formEl);

  let open = true;
  let busy = false;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let fields = [];            // [{spec, input, error}]
  let buttons = [];           // [{action, el}]
  const cleanups = [];

  const actionsOf = next => {
    if (Array.isArray(next.actions) && next.actions.length) return next.actions;
    if (next.form) return [{label: 'Cancel', value: null}, {label: 'Save', value: 'submit', variant: next.danger ? 'danger' : 'primary', submit: true}];
    return [{label: 'OK', value: true, variant: 'primary'}];
  };
  const submitActionOf = list => {
    const marked = list.find(a => a.submit);
    if (marked) return marked;
    if (!p.form) return null;
    return [...list].reverse().find(a => a.variant === 'primary' || a.variant === 'danger') ?? null;
  };

  const renderFields = () => {
    fields = [];
    const specs = p.form?.fields ?? [];
    fieldsBox.hidden = !specs.length;
    fieldsBox.replaceChildren(...specs.map((spec, i) => {
      if (!spec?.name || !spec?.label) throw new TypeError('Dialog: every form field needs a name and a label');
      const id = `ui-dialog-${seq}-f${i}`;
      const hintId = `${id}-hint`, errId = `${id}-error`;
      const multiline = spec.kind === 'textarea';
      const input = h(multiline ? 'textarea' : 'input', {
        id, name: spec.name, class: 'ui-dialog-input',
        type: multiline ? undefined : 'text',
        rows: multiline ? spec.rows ?? 4 : undefined,
        value: spec.value ?? '',
        placeholder: spec.placeholder ?? undefined,
        autocomplete: spec.autocomplete ?? 'off',
        inputMode: spec.inputmode ?? undefined,
        maxLength: spec.maxLength ?? undefined,
        required: !!spec.required,
        'aria-describedby': spec.hint ? hintId : undefined,
      });
      const fieldError = h('p', {class: 'ui-dialog-field-error', id: errId, hidden: true});
      const entry = {spec, input, error: fieldError, errId, hintId};
      fields.push(entry);
      input.addEventListener('input', () => { if (!fieldError.hidden) setFieldError(entry, null); });
      return h('div', {class: 'ui-dialog-field'},
        h('label', {class: 'ui-dialog-label', for: id}, spec.label),
        input,
        spec.hint ? h('p', {class: 'ui-dialog-hint', id: hintId}, spec.hint) : null,
        fieldError);
    }));
  };

  const setFieldError = (entry, message) => {
    entry.error.textContent = message ?? '';
    entry.error.hidden = !message;
    const described = [entry.spec.hint ? entry.hintId : null, message ? entry.errId : null].filter(Boolean).join(' ');
    if (described) entry.input.setAttribute('aria-describedby', described); else entry.input.removeAttribute('aria-describedby');
    if (message) entry.input.setAttribute('aria-invalid', 'true'); else entry.input.removeAttribute('aria-invalid');
  };

  const setError = message => {
    error.textContent = message ?? '';
    error.hidden = !message;
  };

  const renderActions = () => {
    const list = actionsOf(p);
    const submit = submitActionOf(list);
    buttons = list.map(action => {
      const variant = VARIANTS.has(action.variant) ? action.variant : 'secondary';
      const isSubmit = action === submit;
      const button = h('button', {
        type: isSubmit ? 'submit' : 'button', class: 'ui-dialog-action', text: action.label,
      });
      button.dataset.variant = variant;
      button.addEventListener('click', e => {
        if (busy) { e.preventDefault(); return; }
        if (!isSubmit) close(action.value ?? null);
      });
      return {action, el: button, isSubmit};
    });
    actionsBox.replaceChildren(...buttons.map(b => b.el));
  };

  const setBusy = value => {
    busy = value;
    el.toggleAttribute('data-busy', value);
    formEl.setAttribute('aria-busy', String(value));
    for (const b of buttons) {
      if (value) b.el.setAttribute('aria-disabled', 'true'); else b.el.removeAttribute('aria-disabled');
    }
    for (const f of fields) f.input.readOnly = value;
  };

  const applyProps = (next, prev = {}) => {
    applyCommon(el, next, prev);
    title.textContent = next.title ?? '';
    const hasBody = next.body != null && next.body !== '';
    body.hidden = !hasBody;
    if (next.body !== prev.body) setContent(body, next.body);
    if (hasBody) el.setAttribute('aria-describedby', ids.body); else el.removeAttribute('aria-describedby');
    if (next.danger) el.dataset.tone = 'danger'; else delete el.dataset.tone;
    el.style.setProperty('--ui-dialog-w', typeof next.width === 'number' ? `${next.width}px` : String(next.width));
    if (next.error !== prev.error) setError(next.error ? errorText(next.error) : null);
  };

  const values = () => Object.fromEntries(fields.map(f => [f.spec.name, f.input.value]));

  const onSubmit = async e => {
    e.preventDefault();
    if (busy || !open) return;
    const submit = buttons.find(b => b.isSubmit);
    if (!submit && !p.form) return;
    setError(null);
    let firstInvalid = null;
    for (const f of fields) {
      const message = validateField(f.spec, f.input.value);
      setFieldError(f, message);
      if (message && !firstInvalid) firstInvalid = f.input;
    }
    if (firstInvalid) { firstInvalid.focus(); return; }
    const result = values();
    if (!p.form?.onSubmit) { close(p.form ? result : submit?.action.value ?? null); return; }
    setBusy(true);
    try {
      await p.form.onSubmit(result);
    } catch (err) {
      if (!open) return;
      setBusy(false);
      const at = err && typeof err === 'object' && err.field ? fields.find(f => f.spec.name === err.field) : null;
      if (at) { setFieldError(at, errorText(err)); at.input.focus(); }
      else setError(errorText(err));
      return;
    }
    if (!open) return;
    setBusy(false);
    close(result);
  };

  function close(value = null, {silent = false} = {}) {
    if (!open) return;
    open = false;
    // Overlays opened inside the dialog (a menu, a popover) close with it rather than being removed with it.
    closeLayersInside(el, 'dialog');
    for (const fn of cleanups.splice(0).reverse()) fn();
    restoreFocus(previous, el);
    if (el.open) el.close();
    el.remove();
    if (!silent) p.onClose?.(value);
    resolveClosed(silent ? null : value);
  }

  el.__uiClose = () => close(null);
  applyProps(p);
  renderFields();
  renderActions();
  formEl.addEventListener('submit', onSubmit);

  // Open. Menus close first (spec §7.7).
  closeAllMenus('dialog');
  layerHost(doc).append(el);
  el.showModal();
  cleanups.push(pushModalHost(el), trackLayer(el), trapTab(el));
  cleanups.push(pushOverlay({el, modal: true, onEscape: () => { if (!busy) close(null); }}));
  const onCancel = e => { e.preventDefault(); if (!busy) close(null); };
  const onKeydown = e => {
    if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) { e.preventDefault(); if (!busy) close(null); }
  };
  el.addEventListener('cancel', onCancel);
  el.addEventListener('keydown', onKeydown);
  cleanups.push(() => { el.removeEventListener('cancel', onCancel); el.removeEventListener('keydown', onKeydown); });

  const initialFocus = () => {
    const marked = buttons.find(b => b.action.autofocus);
    if (marked) return marked.el;
    if (fields.length) return fields[0].input;
    if (p.danger) return buttons.find(b => !b.isSubmit && b.action.variant !== 'danger')?.el ?? buttons[0]?.el;
    return buttons.find(b => b.isSubmit)?.el ?? buttons.find(b => b.action.variant === 'primary')?.el ?? buttons[0]?.el;
  };
  initialFocus()?.focus({preventScroll: true});

  return {
    el,
    closed,
    get open() { return open; },
    set(partial = {}) {
      if (!open) return;
      const prev = p;
      p = {...p, ...partial};
      applyProps(p, prev);
      if (p.form !== prev.form) renderFields();
      if (p.actions !== prev.actions || p.form !== prev.form || p.danger !== prev.danger) renderActions();
    },
    close: value => close(value ?? null),
    destroy() { close(null, {silent: true}); },
  };
}
