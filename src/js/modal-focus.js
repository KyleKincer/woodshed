// Focus management for the app's existing modal surfaces.
export function focusModal(modal, dismiss) {
  const previous = document.activeElement;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const heading = modal.querySelector('h2');
  if (heading) {
    heading.id ||= `dialog-${crypto.randomUUID()}`;
    modal.setAttribute('aria-labelledby', heading.id);
  }
  const focusable = () => [...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    if (event.key !== 'Tab') return;
    const elements = focusable(), first = elements[0], last = elements.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  };
  modal.addEventListener('keydown', onKey);
  const observer = new MutationObserver(() => { if (!modal.isConnected || modal.classList.contains('hidden')) cleanup(); });
  observer.observe(document.body, {childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  const cleanup = () => {
    observer.disconnect(); modal.removeEventListener('keydown', onKey);
    if (previous?.isConnected) previous.focus();
  };
  focusable()[0]?.focus();
  return cleanup;
}
