// Pointer activation shouldn't leave an action armed for the next Space press.
// Keyboard/assistive-technology clicks (detail === 0) retain normal focus.
export function initializeInteractions() {
  document.addEventListener('click', event => {
    if (event.detail === 0) return;
    const action = event.target.closest('button, a[href], summary, [role="button"]');
    if (action && action === document.activeElement) action.blur();
  }, true);
  document.addEventListener('dragstart', event => {
    if (event.target.closest('img') && !event.target.closest('[draggable="true"]')) event.preventDefault();
  });
}
