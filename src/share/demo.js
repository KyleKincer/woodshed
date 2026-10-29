// The example song (architecture §2.18; D7, B8): a share link the server names in settings.demo.
//
//   demoToken({settings}?) → Promise<string|null>   settings.demo's token, cached for the page once it
//                                                    answers (a failed lookup is asked again next time)
//   openDemo(router, {settings, location, feedback}?) → Promise<boolean>
//     location.assign(`/share/${token}`): the Shared Stage is its own boot route, so leaving the app
//     goes through a full page load. The Shared Stage then applies Minus me from the viewer's profile
//     when it is set to open with their part out (src/share/shared-stage.js). With no demo
//     configured (or the lookup failing) it toasts "The example song isn't available right now."
//     and resolves false. `router` is accepted for the library.demo command's call shape; the
//     navigation never goes through it.
// The Library's first-run card and the library.demo command (global-commands.js) call openDemo.

import * as appSettings from '../api/settings.js';
import {isShareToken} from '../api/sharing.js';
import * as appFeedback from '../app/feedback.js';
import {COPY} from './share.copy.js';

let cached = null;   // Promise<string|null> once settings.demo has answered

/** The demo's share token, or null. See the header. */
export function demoToken({settings = appSettings} = {}) {
  if (cached) return cached;
  const pending = Promise.resolve()
    .then(() => settings.demo())
    .then((value) => (isShareToken(value?.token) ? value.token : null));
  cached = pending;
  pending.catch(() => { if (cached === pending) cached = null; });
  return pending;
}

/** Forgets the cached token (tests). */
export function resetDemoToken() { cached = null; }

/** Opens the example song on the Shared Stage. See the header. */
export async function openDemo(router, {settings = appSettings, location = globalThis.location, feedback = appFeedback} = {}) {
  void router;
  let token = null;
  try { token = await demoToken({settings}); } catch { token = null; }
  if (!token) {
    feedback.toast?.(COPY.demoMissing, {key: 'demo-missing'});
    return false;
  }
  location.assign(`/share/${token}`);
  return true;
}
