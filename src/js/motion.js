let activeTransition;
let revision = 0;

// Keep DOM commits synchronous: signing artwork and loading audio must never
// hold the browser's captured frame on screen. Latest intent wins if a user
// navigates again before the browser has run the previous update callback.
export function transitionView(update, { interrupt = true } = {}) {
  // A late library render must not supersede an explicit navigation.
  if (activeTransition && !interrupt) {
    update();
    return;
  }
  const current = ++revision;
  activeTransition?.skipTransition();
  activeTransition = undefined;
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  const transition = document.startViewTransition(() => {
    if (current === revision) update();
  });
  activeTransition = transition;
  // Skips (rapid navigation, hidden tabs, etc.) reject ready, not the update.
  transition.ready.catch(() => {});
  transition.finished.catch(error => console.error('View update failed:', error)).finally(() => {
    if (activeTransition === transition) activeTransition = undefined;
  });
}
