// SH1's harness (/__harness/share): the real Share dialog (src/share/share-dialog.js) over the fixture database
// through the real client, signed in as the fixture's user (main.js boot step 3). States: tests/fixture/states/SH1.cjs.
// Query:
//   song=<id>     the song to share (default glasshouse, which the seed already shares; lowtide has no link and
//                 no drum chart)
//   session=1     pass a session stand-in whose flush() is recorded, as the Stage's stage.share does
// The page shows a "Share…" button that opens the dialog again after it closes. window.__share = {opens, flushes,
// closed}: how many dialogs opened, the session flushes ({final}) in order, and how many dialogs closed.
import {openShareDialog} from '../../../src/share/share-dialog.js';
import {Button} from '../../../src/ui/button.js';

export default async function mount(el, {fixture, query, h}) {
  const auth = await import('/src/app/auth.js');
  const {startDispatcher} = await import('/src/app/dispatch.js');
  await auth.initialize();
  startDispatcher();
  const id = query.get('song') ?? 'glasshouse';
  const row = fixture.db().songs.find(s => s.id === id);
  const song = row ? {id: row.id, title: row.title, hasChart: !!row.hasChart} : {id, title: id};
  const state = {opens: 0, flushes: [], closed: 0};
  window.__share = state;
  const session = query.get('session') === '1' ? {flush: async opts => { state.flushes.push(opts ?? null); }} : null;

  const open = async () => {
    state.opens++;
    await openShareDialog({song, session});
    state.closed++;
  };
  const again = Button({label: 'Share…', icon: 'share-2', onClick: () => void open()});
  el.append(h('div', {class: 'share-harness', style: {padding: 'var(--s6)'}}, again.el));
  void open();
}
