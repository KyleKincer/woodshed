// Clerk sign-in, and the Convex client that carries its token.
//
// Both SDKs have vanilla-JS builds, so the app stays framework-free: Clerk
// mounts its own components into a div, and ConvexClient is a plain object.

import { Clerk } from '@clerk/clerk-js';
import { ConvexClient } from 'convex/browser';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const CONVEX_URL = import.meta.env.VITE_CONVEX_URL;

export let clerk = null;
export let convex = null;

function missingEnv() {
  const missing = [];
  if (!CLERK_KEY) missing.push('VITE_CLERK_PUBLISHABLE_KEY');
  if (!CONVEX_URL) missing.push('VITE_CONVEX_URL');
  return missing;
}

/**
 * Boot auth and block until there's a signed-in session.
 * Resolves with the Clerk user once signed in.
 */
export async function ensureSignedIn() {
  const missing = missingEnv();
  if (missing.length) {
    showFatal(
      'Not configured',
      `Missing ${missing.join(' and ')}. Copy .env.local.example to .env.local and fill it in.`
    );
    return new Promise(() => {}); // never resolves; the app stays on this screen
  }

  clerk = new Clerk(CLERK_KEY);
  await clerk.load();

  convex = new ConvexClient(CONVEX_URL);
  // Convex calls this whenever it needs a fresh token; `forceRefreshToken`
  // is passed through so it can recover from an expired one on its own.
  convex.setAuth(async ({ forceRefreshToken } = {}) => {
    if (!clerk.session) return null;
    try {
      return await clerk.session.getToken({
        template: 'convex',
        skipCache: forceRefreshToken,
      });
    } catch {
      return null;
    }
  });

  if (clerk.user) {
    hideSignIn();
    return clerk.user;
  }
  return waitForSignIn();
}

function waitForSignIn() {
  return new Promise((resolve) => {
    const screen = document.getElementById('signin');
    const target = document.getElementById('signin-mount');
    screen.classList.remove('hidden');
    target.innerHTML = '';
    clerk.mountSignIn(target);

    // Clerk fires this on every auth state change, including the one that
    // lands after a redirect back from an OAuth provider.
    const stop = clerk.addListener(({ user }) => {
      if (!user) return;
      stop?.();
      hideSignIn();
      resolve(user);
    });
  });
}

function hideSignIn() {
  const screen = document.getElementById('signin');
  screen?.classList.add('hidden');
  const target = document.getElementById('signin-mount');
  if (target) target.innerHTML = '';
}

/** Mount the avatar / account menu into the sidebar. */
export function mountUserButton() {
  const el = document.getElementById('user-button');
  if (el && clerk?.user) {
    el.innerHTML = '';
    clerk.mountUserButton(el, { afterSignOutUrl: window.location.origin });
  }
}

export function showFatal(title, message) {
  const screen = document.getElementById('signin');
  if (!screen) return;
  screen.classList.remove('hidden');
  screen.innerHTML = `<div class="setup-card">
    <div class="brand" style="padding:0 0 8px"><span class="logo">◐</span><span class="brand-name">Woodshed</span></div>
    <h2>${title}</h2>
    <p class="setup-desc">${message}</p>
  </div>`;
}
