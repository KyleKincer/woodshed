// A single shell stays in place until the first complete library snapshot.
export function showStartup() {
  document.documentElement.dataset.startup = 'loading';
  document.getElementById('signin')?.classList.add('hidden');
}
export function showSignIn() {
  document.documentElement.dataset.startup = 'signin';
  document.getElementById('signin')?.classList.remove('hidden');
}
export function finishStartup() {
  document.getElementById('signin')?.classList.add('hidden');
  document.documentElement.dataset.startup = 'ready';
  document.getElementById('content')?.removeAttribute('inert');
  document.getElementById('app-header')?.removeAttribute('inert');
  document.getElementById('startup-status')?.remove();
}

// Never render sign-in while credentials are being restored or refreshed.
export function waitForAuthSession(auth, {onSignedOut, onLoading}) {
  return new Promise(resolve => {
    let stop = () => {}, settled = false;
    const update = () => {
      const state = auth.getSnapshot();
      if (state.isLoading) { onLoading(); return; }
      if (!state.isAuthenticated) { onSignedOut(); return; }
      settled = true; stop(); onLoading(); resolve();
    };
    stop = auth.subscribe(update);
    update();
    if (settled) stop();
  });
}
