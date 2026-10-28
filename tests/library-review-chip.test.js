// @vitest-environment happy-dom
// LB1b: the "Is this right?" chip and popover (spec §2.4, architecture §2.16, D43, BK7 handoff): shown on
// `reviewMetadata`; "Yes, that's it" confirms the shown details (metadata.confirm, or the suggestion applied
// with its MusicBrainz ids); "Find another" opens Edit · Details at #match.
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {installPopoverShim, restoreDomShims} from './helpers/dom.js';

vi.mock('../src/api/media.js', () => ({signKeys: vi.fn(async keys => Object.fromEntries(keys.map(k => [k, `https://cdn.example/${k}`])))}));

const {ReviewChip, acceptMatch, matchOf, suggestsOther, COPY} = await import('../src/library/review-chip.js');
const {CONTROLS} = await import('../src/library/jobs.copy.js');

const counting = {
  id: 'counting', title: 'Counting Stars Backwards', artist: 'Ada Moreno', album: 'Harbor Lights', coverUrl: 'data:image/png;base64,AA',
  metadataStatus: 'uncertain', reviewMetadata: true,
  suggestion: {title: 'Counting Stars Backwards', artist: 'Ada Moreno', album: 'Harbor Lights', releaseId: 'c0ffee00-0000-4000-8000-00000000beef'},
};
const other = {...counting, suggestion: {title: 'Counting Stars', artist: 'Ada Moreno & The Tide', album: 'Harbor Lights (Deluxe)', releaseId: 'c0ffee00-0000-4000-8000-0000000000bb'}};
const jam = {id: 'jam03', title: 'untitled_jam_03.wav', artist: '', album: '', reviewMetadata: true, suggestion: null, coverKey: 'covers/jam.png'};

let metadata, songs, router, chips;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const visibleText = el => {
  const clone = el.cloneNode(true);
  for (const n of clone.querySelectorAll('[aria-hidden=true]')) n.remove();
  return clone.textContent.replace(/\s+/g, ' ').trim();
};
const accName = el => el.getAttribute('aria-label')
  ?? (el.getAttribute('aria-labelledby') ? visibleText(document.getElementById(el.getAttribute('aria-labelledby'))) : visibleText(el));
const roleOf = el => el.getAttribute('role') ?? (el.matches('button') ? 'button' : null);
const byRole = (role, name) => [...document.querySelectorAll('button, [role]')]
  .filter(el => !el.closest('[hidden]') && roleOf(el) === role && (name === undefined || accName(el) === name));

function mount(song, opts = {}) {
  const card = document.createElement('article');
  const onCard = vi.fn();
  card.addEventListener('click', onCard);
  const chip = ReviewChip(song, {router, metadata, songs, ...opts});
  chips.push(chip);
  card.append(chip.el);
  document.body.append(card);
  return {chip, card, onCard, button: chip.el.querySelector('button')};
}

beforeEach(() => {
  installPopoverShim();
  metadata = {confirm: vi.fn(async () => null), update: vi.fn(async () => null)};
  songs = {get: vi.fn(async () => ({id: 'counting', metadataSuggestion: {recordingId: 'b6a1c0de-0000-4000-8000-0000000000aa',
    releaseId: 'c0ffee00-0000-4000-8000-0000000000bb', title: 'Counting Stars', artist: 'Ada Moreno & The Tide', album: 'Harbor Lights (Deluxe)', year: '2018'}}))};
  router = {navigate: vi.fn()};
  chips = [];
});

afterEach(() => {
  for (const chip of chips) chip.destroy();
  restoreDomShims();
  document.body.replaceChildren();
});

describe('matching', () => {
  test('a suggestion for the same title and artist is the song itself; another one is a suggestion', () => {
    expect(suggestsOther(counting)).toBe(false);
    expect(suggestsOther({...counting, suggestion: {...counting.suggestion, title: 'counting stars  backwards'}})).toBe(false);
    expect(suggestsOther(other)).toBe(true);
    expect(suggestsOther(jam)).toBe(false);
    expect(matchOf(counting)).toEqual({kind: 'current', title: 'Counting Stars Backwards', artist: 'Ada Moreno', album: 'Harbor Lights'});
    expect(matchOf(other)).toEqual({kind: 'suggestion', title: 'Counting Stars', artist: 'Ada Moreno & The Tide', album: 'Harbor Lights (Deluxe)'});
  });

  test('accepting the song’s own details is metadata.confirm', async () => {
    await acceptMatch(counting, {metadata, songs});
    expect(metadata.confirm).toHaveBeenCalledWith({id: 'counting'});
    expect(metadata.update).not.toHaveBeenCalled();
    await acceptMatch(jam, {metadata, songs});
    expect(metadata.confirm).toHaveBeenCalledWith({id: 'jam03'});
  });

  test('accepting another suggestion applies it with its recording and release ids', async () => {
    await acceptMatch(other, {metadata, songs});
    expect(songs.get).toHaveBeenCalledWith({id: 'counting'});
    expect(metadata.update).toHaveBeenCalledWith({
      ids: ['counting'],
      changes: {title: 'Counting Stars', artist: 'Ada Moreno & The Tide', album: 'Harbor Lights (Deluxe)', year: '2018'},
      match: {recordingId: 'b6a1c0de-0000-4000-8000-0000000000aa', releaseId: 'c0ffee00-0000-4000-8000-0000000000bb'},
    });
    expect(metadata.confirm).not.toHaveBeenCalled();
  });

  test('without a recording id the suggestion’s fields are applied, then confirmed', async () => {
    songs.get.mockResolvedValueOnce(null);
    await acceptMatch(other, {metadata, songs});
    expect(metadata.update).toHaveBeenCalledWith({ids: ['counting'], changes: {title: 'Counting Stars', artist: 'Ada Moreno & The Tide', album: 'Harbor Lights (Deluxe)'}});
    expect(metadata.confirm).toHaveBeenCalledWith({id: 'counting'});
  });
});

describe('ReviewChip', () => {
  test('shown only while the row needs review', () => {
    const {chip} = mount(counting);
    expect(chip.el.hidden).toBe(false);
    chip.update({...counting, reviewMetadata: false});
    expect(chip.el.hidden).toBe(true);
    chip.update(counting);
    expect(chip.el.hidden).toBe(false);
  });

  test('the chip opens an inline popover with the match; presses never reach the card', () => {
    const {button, onCard} = mount(counting);
    expect(accName(button)).toBe(COPY.chip);
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    button.click();
    expect(onCard).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const dialog = byRole('dialog', COPY.title)[0];
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector('.lib-review-lead').textContent).toBe(COPY.current);
    expect(dialog.querySelector('.lib-review-song').textContent).toBe('Counting Stars Backwards');
    expect(dialog.querySelector('.lib-review-artist').textContent).toBe('Ada Moreno');
    expect(dialog.querySelector('.lib-review-album').textContent).toBe('Harbor Lights');
    const img = dialog.querySelector('img');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AA');
    expect(img.alt).toBe(COPY.cover('Counting Stars Backwards'));
    button.click();
    expect(byRole('dialog', COPY.title)).toHaveLength(0);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('an untitled upload shows its file name, "Unknown artist" and its signed cover', async () => {
    const {chip} = mount(jam);
    chip.open();
    const dialog = byRole('dialog', COPY.title)[0];
    expect(dialog.querySelector('.lib-review-song').textContent).toBe('untitled_jam_03.wav');
    expect(dialog.querySelector('.lib-review-artist').textContent).toBe(COPY.unknownArtist);
    expect(dialog.querySelector('.lib-review-album')).toBeNull();
    await flush();
    expect(dialog.querySelector('img').getAttribute('src')).toBe('https://cdn.example/covers/jam.png');
  });

  test('a suggestion for another recording is shown as MusicBrainz’s match', () => {
    const {chip} = mount(other);
    chip.open();
    const dialog = byRole('dialog', COPY.title)[0];
    expect(dialog.querySelector('.lib-review-lead').textContent).toBe(COPY.suggested);
    expect(dialog.querySelector('.lib-review-song').textContent).toBe('Counting Stars');
    expect(dialog.querySelector('img').hidden).toBe(true);
  });

  test('"Yes, that\'s it" confirms and closes; the next row hides the chip', async () => {
    const {chip} = mount(counting);
    chip.open();
    byRole('button', COPY.yes)[0].click();
    await flush();
    expect(metadata.confirm).toHaveBeenCalledWith({id: 'counting'});
    expect(byRole('dialog', COPY.title)).toHaveLength(0);
    chip.update({...counting, reviewMetadata: false, metadataStatus: 'matched'});
    expect(chip.el.hidden).toBe(true);
  });

  test('a failed confirm keeps the popover open with the error sentence', async () => {
    metadata.confirm.mockRejectedValueOnce(Object.assign(new Error('Not your song.'), {code: 'not_owner'}));
    const {chip} = mount(counting);
    chip.open();
    const yes = byRole('button', COPY.yes)[0];
    yes.click();
    await flush();
    expect(byRole('dialog', COPY.title)).toHaveLength(1);
    const alert = document.querySelector('.lib-review-error');
    expect(alert.hidden).toBe(false);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('This belongs to another account.');
    expect(yes.getAttribute('aria-disabled')).not.toBe('true');
  });

  test('"Find another" opens Edit · Details at the match panel', () => {
    const {chip} = mount(counting);
    chip.open();
    byRole('button', COPY.findAnother)[0].click();
    expect(router.navigate).toHaveBeenCalledWith('/s/counting/edit/details#match');
    expect(byRole('dialog', COPY.title)).toHaveLength(0);
  });

  test.each(CONTROLS.filter(c => /^Needs review/.test(c.context)).map(c => [c.context, c.role, c.name]))('%s: %s "%s" renders', (context, role, name) => {
    const {chip} = mount(counting);
    if (/popover/.test(context)) chip.open();
    expect(byRole(role, name)).toHaveLength(1);
  });
});
