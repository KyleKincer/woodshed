// beforeinstallprompt fake (architecture §2.11 `install`, §11.2). Chromium
// fires the event only for an installable origin; the fixture fires it on
// demand. Controls (window.fixture.install):
//   offer()                 dispatch a BeforeInstallPromptEvent-like event on window; returns
//                           false when the page called preventDefault() (it kept it for later)
//   setOutcome(o)           what prompt() resolves to: 'accepted' (default, then `appinstalled`
//                           fires) or 'dismissed'
//   state()                 {offers, prompts, outcome, installed}
export function installInstallPrompt(win) {
  const state = {offers: 0, prompts: 0, outcome: 'accepted', installed: false};

  function offer() {
    state.offers++;
    let settle;
    const event = new win.Event('beforeinstallprompt', {cancelable: true});
    const userChoice = new Promise(resolve => { settle = resolve; });
    let prompted = false;
    Object.defineProperties(event, {
      platforms: {value: ['web']},
      userChoice: {value: userChoice},
      prompt: {value: async () => {
        if (prompted) throw new win.DOMException('The prompt() method can only be called once (fixture).', 'InvalidStateError');
        prompted = true;
        state.prompts++;
        const choice = {outcome: state.outcome, platform: state.outcome === 'accepted' ? 'web' : ''};
        settle(choice);
        if (choice.outcome === 'accepted') {
          state.installed = true;
          setTimeout(() => win.dispatchEvent(new win.Event('appinstalled')), 0);
        }
        return choice;
      }},
    });
    return win.dispatchEvent(event);
  }

  return {
    offer,
    setOutcome(outcome) {
      if (!['accepted', 'dismissed'].includes(outcome)) throw new TypeError(`fixture.install.setOutcome: 'accepted' or 'dismissed', got ${JSON.stringify(outcome)}`);
      state.outcome = outcome;
    },
    state: () => ({...state}),
  };
}
