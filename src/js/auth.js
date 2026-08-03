// Clerk sign-in, and the Convex client that carries its token.
//
// Both SDKs have vanilla-JS builds, so the app stays framework-free: Clerk
// mounts its own components into a div, and ConvexClient is a plain object.

import { Clerk } from '@clerk/clerk-js';
// clerk-js v6 ships without its drop-in components; `mountSignIn` throws
// "Clerk was not loaded with Ui components" unless the UI bundle is handed to
// `load()`. Importing it from npm rather than Clerk's CDN keeps the app
// self-contained and avoids widening script-src in the CSP.
import { ClerkUI } from '@clerk/ui/entry';
import { dark } from '@clerk/ui/themes';
import { ConvexClient } from 'convex/browser';

// Clerk's default is a light card, which reads as a hole punched in a dark
// app. Start from its dark theme and pull the surface colours from our own
// palette so the form belongs to the same UI.
// Values mirror the custom properties in styles.css (--bg-2, --text, --accent,
// --bg-3, --border, --radius); Clerk can't read CSS variables here, so they
// have to be repeated literally.
const clerkAppearance = {
  baseTheme: dark,
  variables: {
    colorBackground: '#15171e',
    colorForeground: '#e6e8ee',
    colorPrimary: '#5b8cff',
    colorInput: '#1c1f29',
    colorBorder: '#2a2e3b',
    colorNeutral: '#8a90a2',
    borderRadius: '12px',
  },
};

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
  await clerk.load({ ui: { ClerkUI }, appearance: clerkAppearance });

  convex = new ConvexClient(CONVEX_URL);
  // Convex calls this whenever it needs a fresh token; `forceRefreshToken`
  // is passed through so it can recover from an expired one on its own.
  convex.setAuth(async ({ forceRefreshToken } = {}) => {
    if (!clerk.session) return null;
    try {
      return await clerk.session.getToken({
        template: JWT_TEMPLATE,
        skipCache: forceRefreshToken,
      });
    } catch (err) {
      // Swallowing this is how a missing JWT template turns into a bare
      // "Not signed in" from every Convex function — the one error message
      // that sends you looking in entirely the wrong place.
      console.error(
        `Clerk could not mint a "${JWT_TEMPLATE}" JWT. Convex calls will fail as unauthenticated.`,
        err
      );
      return null;
    }
  });

  const user = clerk.user || (await waitForSignIn());
  await assertConvexTokenWorks();
  hideSignIn();
  return user;
}

const JWT_TEMPLATE = 'convex';

/** Decode a JWT payload for diagnostics. Never used to make trust decisions. */
function claimsOf(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

/**
 * Fail loudly, once, at boot if Clerk can't mint the Convex JWT.
 *
 * Without this the app looks signed in — avatar and all — and only breaks
 * later, deep in an unrelated action, with a message that says nothing about
 * JWT templates.
 */
async function assertConvexTokenWorks() {
  let token = null;
  let err = null;
  try {
    token = await clerk.session?.getToken({ template: JWT_TEMPLATE });
  } catch (e) {
    err = e;
  }

  if (token) {
    // A template can exist and still be rejected: Convex matches the token's
    // `aud` against `applicationID` in auth.config.ts, and a template built
    // from a blank preset rather than the Convex one won't set it.
    const aud = claimsOf(token)?.aud;
    const audList = Array.isArray(aud) ? aud : [aud];
    if (audList.includes(JWT_TEMPLATE)) return;
    showFatal(
      'Clerk JWT is missing the Convex audience',
      `The <code>${JWT_TEMPLATE}</code> template issues a token with
       <code>aud = ${JSON.stringify(aud) ?? 'unset'}</code>. Convex matches that claim against
       <code>applicationID</code> in <code>auth.config.ts</code>, so it rejects every request.
       <br><br>
       In the <a href="https://dashboard.clerk.com" target="_blank" rel="noopener">Clerk dashboard</a>
       open <strong>Configure → JWT Templates → ${JWT_TEMPLATE}</strong> and put this in the
       <strong>Claims</strong> box, then save and reload:
       <br><br><code>{ "aud": "convex" }</code>`
    );
    throw new Error('Clerk JWT audience does not match applicationID.');
  }

  showFatal(
    'Clerk is missing the Convex JWT template',
    `Signed in, but Clerk can't issue a <code>${JWT_TEMPLATE}</code> token, so Convex sees every
     request as anonymous.<br><br>
     In the <a href="https://dashboard.clerk.com" target="_blank" rel="noopener">Clerk dashboard</a>
     go to <strong>Configure → JWT Templates → New template → Convex</strong>. Keep the name exactly
     <code>${JWT_TEMPLATE}</code>, save, then reload this page.
     ${err ? `<br><br><span class="setup-error">${String(err.message || err)}</span>` : ''}`
  );
  throw new Error('Clerk JWT template "convex" is missing.');
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
