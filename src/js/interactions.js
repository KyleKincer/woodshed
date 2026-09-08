// Pointer activation shouldn't leave an action armed for the next Space press.
// Keyboard/assistive-technology clicks (detail === 0) retain normal focus.
let pointerControls = new WeakSet();
const actionSelector = 'button,a[href],summary,[role="button"],input[type="checkbox"],input[type="radio"],input[type="range"],select';
const controlFor = target => target.matches(actionSelector) ? target : target.closest(actionSelector) || target.closest('label')?.control;
export const isPointerControl = target => !!target.closest && pointerControls.has(controlFor(target));
export function initializeInteractions() {
  const release = control => {
    if (control && control === document.activeElement && !control.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),textarea')) control.blur();
  };
  document.addEventListener('pointerdown', event => {
    const control = controlFor(event.target);
    if (control) pointerControls.add(control);
  }, true);
  document.addEventListener('keydown', event => {
    // Tab/keyboard activation retains normal control semantics and focus rings.
    if (event.key === 'Tab') pointerControls = new WeakSet();
  }, true);
  document.addEventListener('click', event => {
    if (event.detail === 0) return;
    const action = controlFor(event.target);
    if (action) pointerControls.add(action);
    if (action?.matches('select')) return; // keep the native picker open until selection
    release(action);
    // A label's default action focuses its input after the label click.
    queueMicrotask(() => release(action));
  }, true);
  document.addEventListener('change', event => {
    if (event.target.matches('select') && pointerControls.has(event.target)) release(event.target);
  });
  document.addEventListener('pointerup', event => {
    const control = controlFor(event.target) || document.activeElement;
    if (control?.matches('input[type="range"]')) queueMicrotask(() => release(control));
  }, true);
  document.addEventListener('dragstart', event => {
    if (event.target.closest('img') && !event.target.closest('[draggable="true"]')) event.preventDefault();
  });
}
