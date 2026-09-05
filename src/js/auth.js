import googleSignInButton from '../assets/google-signin.png';
import { AuthClient, defaultStorage } from '@convex-dev/auth/browser';
// Alpha.1 exposes its framework-neutral OAuth setup through this entry point.
// Only oauth() is used; the UI remains plain DOM.
import { oauth } from '@convex-dev/auth/providers/oauth/react';
import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL;
export let convex = null;
let auth = null;
let currentUser = null;
let boot = null;

export function ensureSignedIn() {
  return (boot ??= initialize());
}

async function initialize() {
  if (!CONVEX_URL) {
    showFatal('Not configured', 'Set VITE_CONVEX_URL in .env.local and restart the website.');
    throw new Error('Missing VITE_CONVEX_URL.');
  }
  // Auth mutations prove possession of their own flow/refresh secrets. Keep
  // their transport independent of the authenticated realtime connection.
  const transport = new ConvexHttpClient(CONVEX_URL);
  convex = new ConvexClient(CONVEX_URL);
  auth = new AuthClient({
    mode: 'spa',
    storage: defaultStorage(),
    storageNamespace: CONVEX_URL,
    authApi: {
      refreshSession: (refreshToken) => transport.mutation(api.auth.refreshSession, { refreshToken }),
      signOut: async (refreshToken) => { await transport.mutation(api.auth.signOut, { refreshToken }); },
    },
    ambientSignIns: {
      signIns: [oauth()],
      signInApi: {
        mutation: (ref, args) => transport.mutation(ref, args),
        action: (ref, args) => transport.action(ref, args),
      },
    },
  });
  await auth.init();
  await waitForSession();
  // Wait for the backend's verdict before starting library subscriptions.
  await new Promise((resolve, reject) => {
    convex.setAuth(auth.fetchAccessToken, (authenticated) => {
      if (authenticated) resolve();
      else reject(new Error('Your session could not be verified. Sign in again.'));
    });
  }).catch(async (error) => {
    await auth.signOut();
    showFatal('Sign-in failed', error.message + ' Reload this page to try again.');
    throw error;
  });
  currentUser = await convex.query(api.users.me, {});
  if (!currentUser) throw new Error('Your account could not be loaded.');
  const checkAccount = user => {
    if (user?.status === 'suspended') {
      showFatal('Account suspended', 'Contact the app owner for help restoring access.');
      const button=document.createElement('button'); button.className='btn-ghost';button.textContent='Sign out';
      button.onclick=async()=>{await auth.signOut();location.reload();};
      document.querySelector('#signin .setup-card').append(button);
      return false;
    }
    return true;
  };
  if (!checkAccount(currentUser)) throw new Error('Account suspended');
  convex.onUpdate(api.users.me, {}, checkAccount);
  document.getElementById('signin')?.classList.add('hidden');
  // Signing out in another tab must also clear this tab's library UI.
  auth.subscribe(() => {
    const state = auth.getSnapshot();
    if (!state.isLoading && !state.isAuthenticated) window.location.reload();
  });
  return currentUser;
}

function waitForSession() {
  const screen = document.getElementById('signin');
  const target = document.getElementById('signin-mount');
  screen?.classList.remove('hidden');
  if (!target) throw new Error('Missing sign-in screen.');
  target.replaceChildren();
  const card = document.createElement('div');
  card.className = 'setup-card';
  const title = document.createElement('h2');
  title.textContent = 'Your practice library, anywhere';
  const description = document.createElement('p');
  description.className = 'setup-desc';
  description.textContent = 'Sign in or create a free account to sync your songs and practice settings.';
  const button = document.createElement('button');
  button.className = 'btn btn-primary';
  button.setAttribute('aria-label', 'Sign in with Google');
  const googleImage = document.createElement('img');
  googleImage.src = googleSignInButton; googleImage.alt = 'Sign in with Google';
  googleImage.width = 180; googleImage.height = 40;
  button.append(googleImage);
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.className = 'setup-desc';
  card.append(title, description, button, message);
  target.append(card);
  const values = auth.ambientSignInValues('oauth');
  const showError = () => {
    const error = values.get('flowError');
    if (error) {
      message.textContent = error.message || (error.code === 'access_denied'
        ? 'Sign-in was canceled. You can try again.'
        : 'Sign-in could not finish. Please try again.');
      button.disabled = false;
    }
  };
  showError();
  const stopErrors = values.subscribe('flowError', showError);
  button.addEventListener('click', async () => {
    button.disabled = true;
    message.textContent = 'Opening Google…';
    try {
      await values.get('actions').signIn({
        providerName: 'google',
        startSignIn: api.auth.startSignInGoogle,
        completeSignIn: api.auth.completeSignInGoogle,
      }, { redirectTo: window.woodshedDesktop ? window.location.origin + '/oauth/callback' : window.location.origin + window.location.pathname });
    } catch {
      showError();
      button.disabled = false;
    }
  });
  return new Promise((resolve) => {
    let stop = () => {};
    const update = () => {
      const state = auth.getSnapshot();
      if (!state.isLoading && state.isAuthenticated) {
        stop();
        stopErrors();
        resolve();
      }
    };
    stop = auth.subscribe(update);
    update();
  });
}

export function mountUserButton({ admin = false, navigate = () => {} } = {}) {
  const el = document.getElementById('user-button');
  if (!el || !currentUser) return;
  const label = currentUser.name || currentUser.email || 'Account';
  const menu = document.createElement('details');
  menu.className = 'account-menu';
  const trigger = document.createElement('summary');
  trigger.className = 'account-trigger';
  trigger.setAttribute('aria-label', `Account: ${label}`);
  trigger.title = label;
  const avatar = document.createElement('span');
  avatar.className = 'account-avatar';
  avatar.textContent = (currentUser.name || 'Account').split(/\s+/).slice(0,2).map(part => part[0]).join('').toUpperCase();
  avatar.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'account-name'; name.textContent = label;
  trigger.append(avatar, name);
  const panel = document.createElement('div');
  panel.className = 'account-panel';
  const email = document.createElement('div');
  email.className = 'account-email'; email.textContent = currentUser.email || label;
  const button = document.createElement('button');
  button.className = 'account-signout'; button.textContent = 'Sign out';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await auth.signOut(); window.location.reload(); }
    catch { button.disabled = false; button.textContent = 'Retry sign out'; }
  });
  panel.append(email);
  const item = (label, action) => {
    const entry=document.createElement('button');entry.className='account-signout';entry.textContent=label;
    entry.onclick=()=>{menu.open=false;action();};panel.append(entry);
  };
  if (admin) item('Administration', () => navigate('admin'));
  if (window.woodshedDesktop) item('App updates', () => document.dispatchEvent(new Event('woodshed:show-updates')));
  if (!window.woodshedDesktop) item('Download desktop app', () => { location.href='/download'; });
  panel.append(button); menu.append(trigger, panel);
  const settings=document.createElement('button');settings.className='account-settings';settings.title='Settings';settings.setAttribute('aria-label','Settings');
  settings.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 2h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-2Z"/><circle cx="11" cy="11" r="3"/></svg>';
  settings.onclick=()=>{menu.open=false;navigate('settings');};
  el.replaceChildren(menu,settings);
  document.addEventListener('click', event => { if (!el.contains(event.target)) menu.open = false; });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; trigger.focus(); } });
}

export function showFatal(title, message) {
  const screen = document.getElementById('signin');
  if (!screen) return;
  screen.classList.remove('hidden');
  const card = document.createElement('div');
  card.className = 'setup-card';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const description = document.createElement('p');
  description.className = 'setup-desc';
  description.textContent = message;
  card.append(heading, description);
  screen.replaceChildren(card);
}
