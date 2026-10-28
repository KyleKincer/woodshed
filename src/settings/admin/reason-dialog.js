// The required-Reason confirm Dialog (spec §6.4, architecture §2.17). Every administration change goes
// through it: window.prompt is gone.
//
//   askReason({title, body, confirmLabel, cancelLabel = 'Cancel', danger = false, run}) → Promise<string|null>
//     Opens a modal Dialog with one required "Reason" field (3–500 characters after trimming; the audit
//     log keeps it). Cancel, Esc or the backdrop resolve null.
//     run(reason) (optional, async): the change itself, run inside the dialog. While it runs the dialog
//     is busy; when it throws, the dialog stays open with the error inline (at the Reason field when the
//     server refused the reason) and the reason kept, so a retry is one press. When it resolves, the
//     dialog closes and askReason resolves the trimmed reason.
//
// Error copy comes from src/app/error-copy.js (context 'save'); the server's own message follows it,
// because an administrator needs the specific refusal ("An administrator account cannot be restricted.").

import {Dialog} from '../../ui/dialog.js';
import {describeError} from '../../app/error-copy.js';

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export const REASON_COPY = Object.freeze({
  label: 'Reason',
  hint: 'Required. Saved in the audit history with your change.',
  cancel: 'Cancel',
  confirm: 'Save',
});

/** The sentence an administrator sees for a failed change: the app's copy, then the server's detail. */
export function reasonError(err) {
  const {sentence} = describeError(err, {context: 'save'});
  const raw = typeof err?.message === 'string' ? err.message.trim() : '';
  return raw && raw !== sentence ? `${sentence} ${raw}` : sentence;
}

/** Asks for a reason, optionally running the change inside the dialog. See the header. */
export function askReason({title, body, confirmLabel = REASON_COPY.confirm, cancelLabel = REASON_COPY.cancel, danger = false, run} = {}) {
  let reason = null;
  const dialog = Dialog({
    title,
    body,
    danger,
    className: 'admin-reason-dialog',
    actions: [
      {label: cancelLabel, value: null},
      {label: confirmLabel, value: 'submit', variant: danger ? 'danger' : 'primary', submit: true},
    ],
    form: {
      fields: [{
        name: 'reason', label: REASON_COPY.label, kind: 'text', required: true,
        minLength: REASON_MIN, maxLength: REASON_MAX, hint: REASON_COPY.hint, autocomplete: 'off',
      }],
      onSubmit: async values => {
        const text = String(values.reason ?? '').trim();
        if (run) {
          try {
            await run(text);
          } catch (err) {
            const failure = new Error(reasonError(err));
            if (err?.data?.field === 'reason') failure.field = 'reason';
            throw failure;
          }
        }
        reason = text;
      },
    },
  });
  return dialog.closed.then(value => (value && reason != null ? reason : null));
}
