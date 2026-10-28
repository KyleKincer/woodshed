// LB2a: the Add sheet's pure model (architecture §2.16, spec §3.1–3.2): classify, badges, findDuplicate,
// describeDefaults (through profile.addDefaults, §2.22), removesMyStem, and the file and layout helpers.
import {describe, expect, test} from 'vitest';
import {
  AUDIO_EXTENSIONS, COPY, STEM_MODES, audioFiles, badges, canonicalUrl, classify, defaultsParts, describeDefaults,
  findDuplicate, isAudioFile, jobSettings, removesMyStem, removesMyStemLine, stemCount, stemsFor,
} from '../src/library/add-model.js';
import {addDefaults} from '../src/app/profile.js';

const profile = (instruments, primary = instruments[0] ?? null) => ({instruments, primary, openWithMyPart: 'in'});

describe('classify', () => {
  test.each([
    // [input, kind, value]
    ['', 'empty', ''],
    ['   \n\t ', 'empty', ''],
    [null, 'empty', ''],
    [undefined, 'empty', ''],
    [42, 'empty', ''],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['  https://youtu.be/dQw4w9WgXcQ  ', 'url', 'https://youtu.be/dQw4w9WgXcQ'],
    ['http://soundcloud.com/ada/harbor-lights', 'url', 'http://soundcloud.com/ada/harbor-lights'],
    ['HTTPS://Example.com/Song', 'url', 'https://example.com/Song'],
    ['youtu.be/dQw4w9WgXcQ', 'url', 'https://youtu.be/dQw4w9WgXcQ'],
    ['youtube.com/watch?v=abc123def45', 'url', 'https://youtube.com/watch?v=abc123def45'],
    ['www.example.com', 'url', 'https://www.example.com/'],
    ['soundcloud.com/ada/harbor-lights', 'url', 'https://soundcloud.com/ada/harbor-lights'],
    ['music.youtube.com', 'url', 'https://music.youtube.com/'],
    ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc', 'spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc'],
    ['open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify', 'https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC'],
    ['https://spotify.link/AbCdEf', 'spotify', 'https://spotify.link/AbCdEf'],
    ['spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
    ['SPOTIFY:Track:4uLU6hMCjMI75M1A2tKUQC', 'spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'spotify', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
    ['harbor lights ada moreno', 'search', 'harbor lights ada moreno'],
    ['  harbor   lights\n ada  ', 'search', 'harbor lights ada'],
    ['AC/DC Thunderstruck', 'search', 'AC/DC Thunderstruck'],
    ['AC/DC', 'search', 'AC/DC'],
    ['Mr.Brightside', 'search', 'Mr.Brightside'],
    ['st. vincent', 'search', 'st. vincent'],
    ['mailto:someone@example.com', 'search', 'mailto:someone@example.com'],
    ['ftp://example.com/song.mp3', 'search', 'ftp://example.com/song.mp3'],
    ['https://', 'search', 'https://'],
    ['https://www.youtube.com/watch?v=a b', 'search', 'https://www.youtube.com/watch?v=a b'],
  ])('%j → %s', (input, kind, value) => {
    expect(classify(input)).toEqual({kind, value});
  });

  test('over-long input is a search (the server refuses it with a coded error)', () => {
    const long = `https://example.com/${'a'.repeat(2100)}`;
    expect(classify(long).kind).toBe('search');
  });
});

describe('badges', () => {
  test.each([
    ['Harbor Lights (Official Audio)', ['Official']],
    ['Harbor Lights (Official Music Video)', ['Official']],
    ['Harbor Lights — Live at the Roundhouse', ['Live']],
    ['Harbor Lights (Live)', ['Live']],
    ['Harbor Lights [LIVE]', ['Live']],
    ['Harbor Lights - Live', ['Live']],
    ['Harbor Lights live session', ['Live']],
    ['Harbor Lights (Official Live Video)', ['Official', 'Live']],
    ['Harbor Lights (Drum Cover)', ['Cover']],
    ['Harbor Lights (Lyrics)', ['Lyrics']],
    ['Harbor Lights (Official Lyric Video)', ['Official', 'Lyrics']],
    ['Harbor Lights lyric', ['Lyrics']],
    ['Harbor Lights - Live Cover with Lyrics (Official)', ['Official', 'Live', 'Cover', 'Lyrics']],
    ['Live Forever', []],
    ['Live and Let Die', []],
    // Video titles in the "Artist - Title" form: a song name that starts or ends with Live or Cover gets no badge.
    ['Oasis - Live Forever (Official Video)', ['Official']],
    ['Oasis - Live Forever', []],
    ['Wings - Live and Let Die', []],
    ['Paul McCartney & Wings - Live And Let Die', []],
    ['I Want to Live', []],
    ['Ada Moreno - I Want to Live', []],
    ['Portugal. The Man - Live in the Moment', []],
    ['The Strokes - Under Cover of Darkness (Official Video)', ['Official']],
    ['Bruce Springsteen - Cover Me', []],
    ['Bruce Springsteen - Cover Me (Official Audio)', ['Official']],
    ['Ada Moreno - Discover', []],
    // … while a performance or cover marked after the song name still counts.
    ['Oasis - Live Forever (Live at Knebworth)', ['Live']],
    ['Oasis - Live Forever - Live in Paris', ['Live']],
    ['Oasis - Live Forever | Live', ['Live']],
    ['Ada Moreno - Harbor Lights - Live', ['Live']],
    ['Ada Moreno - Harbor Lights (Live from Austin)', ['Live']],
    ['Ada Moreno - Harbor Lights live at KEXP', ['Live']],
    ['Ada Moreno - Harbor Lights | Drum Cover', ['Cover']],
    ['Harbor Lights - Cover', ['Cover']],
    ['Harbor Lights (Ada Moreno cover)', ['Cover']],
    ['Harbor Lights cover by StickWorks', ['Cover']],
    ['StickWorks - Harbor Lights - Ada Moreno cover', ['Cover']],
    ['Harbor Lights acoustic cover', ['Cover']],
    ['Bruce Springsteen - Cover Me (Live 1984)', ['Live']],
    ['Undercover Martyn', []],
    ['Officially Missing You', []],
    ['Harbor Lights', []],
    ['', []],
    [null, []],
  ])('%j → %j', (title, expected) => {
    expect(badges(title)).toEqual(expected);
  });
});

describe('findDuplicate', () => {
  const harbor = {id: 's1', title: 'Harbor Lights', artist: 'Ada Moreno', uploader: 'Ada Moreno', duration: 221, source: {type: 'url', value: 'https://www.youtube.com/watch?v=HARBOR12345'}};
  const upload = {id: 's2', title: 'Night Bus', artist: '', uploader: 'Uploaded file', duration: 184.4, source: {type: 'upload', value: 'u1', filename: 'Night Bus.mp3'}};
  const searched = {id: 's3', title: 'Second Wind', artist: 'The Gales', albumArtist: 'The Gales', duration: 250, source: {type: 'search', value: 'second wind gales'}};
  const spotify = {id: 's4', title: 'Copper', artist: 'Lumen', duration: 199, source: {type: 'spotify', value: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'}};
  const resolved = {id: 's5', title: 'Fault Lines', artist: 'Ora', duration: 300, source: {type: 'search', value: 'fault lines'}, resolvedUrl: 'https://www.youtube.com/watch?v=FAULT123456'};
  const songs = new Map([harbor, upload, searched, spotify, resolved].map(s => [s.id, s]));

  test.each([
    // [label, candidate, expected id | null]
    ['same link', {url: 'https://www.youtube.com/watch?v=HARBOR12345'}, 's1'],
    ['same video, short link', {url: 'https://youtu.be/HARBOR12345?si=xyz'}, 's1'],
    ['same video, mobile and extra params', {url: 'https://m.youtube.com/watch?feature=share&v=HARBOR12345&t=30'}, 's1'],
    ['same video, music.youtube.com', {url: 'https://music.youtube.com/watch?v=HARBOR12345&list=RD1'}, 's1'],
    ['another video', {url: 'https://www.youtube.com/watch?v=OTHER123456'}, null],
    ['same Spotify track, as URI', {url: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'}, 's4'],
    ['same Spotify track, intl link', {url: 'https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC?si=1'}, 's4'],
    ['a search that resolved to this link', {url: 'https://youtu.be/FAULT123456'}, 's5'],
    ['title + artist, duration inside ±2 s', {title: 'harbor lights', artist: 'ADA MORENO', duration: 223}, 's1'],
    ['title + artist, duration at −2 s', {title: 'Harbor Lights', artist: 'Ada Moreno', duration: 219}, 's1'],
    ['title + artist, duration outside ±2 s', {title: 'Harbor Lights', artist: 'Ada Moreno', duration: 223.5}, null],
    ['title + artist without a duration', {title: 'Harbor Lights', artist: 'Ada Moreno'}, null],
    ['a video title with decorations, channel as artist', {title: 'Harbor Lights (Official Audio)', artist: 'Ada Moreno - Topic', duration: 221.4}, 's1'],
    ['"Artist - Title" video title from a VEVO channel', {title: 'Ada Moreno - Harbor Lights (Official Video)', artist: 'AdaMorenoVEVO', duration: 222}, 's1'],
    ['a live version is a different title', {title: 'Harbor Lights (Live at the Roundhouse)', artist: 'Ada Moreno', duration: 221}, null],
    ['other artist, same title', {title: 'Harbor Lights', artist: 'StickWorks', duration: 221}, null],
    ['accents and case fold', {title: 'SECOND WÍND', artist: 'the gales', duration: 249}, 's3'],
    ['album artist matches', {title: 'Second Wind', artist: 'The Gales', duration: 251.9}, 's3'],
    ['an upload: uploader counts as artist', {title: 'Night Bus', artist: 'Uploaded file', duration: 185}, 's2'],
    ['no artist on either side: title + duration match (an untagged file added twice)', {title: 'Night Bus', artist: '', duration: 184}, 's2'],
    ['no artist on either side, no artist field at all', {title: 'Night Bus', duration: 186}, 's2'],
    ['no artist on either side, duration outside ±2 s', {title: 'Night Bus', duration: 187}, null],
    ['no artist on the candidate, the song has one', {title: 'Harbor Lights', duration: 221}, null],
    ['an empty candidate', {}, null],
  ])('%s', (_, candidate, expected) => {
    expect(findDuplicate(candidate, songs)?.id ?? null).toBe(expected);
  });

  test('takes a list as well as the store Map, and returns the song row itself', () => {
    expect(findDuplicate({url: 'https://youtu.be/HARBOR12345'}, [upload, harbor])).toBe(harbor);
    expect(findDuplicate({url: 'https://youtu.be/HARBOR12345'}, [])).toBeNull();
    expect(findDuplicate({url: 'https://youtu.be/HARBOR12345'}, null)).toBeNull();
    expect(findDuplicate(null, songs)).toBeNull();
  });

  test('the link match wins over a title match on another song', () => {
    const twin = {...harbor, id: 's9', source: {type: 'upload', value: 'u9'}};
    expect(findDuplicate({url: 'https://youtu.be/HARBOR12345', title: 'Harbor Lights', artist: 'Ada Moreno', duration: 221}, [twin, harbor]).id).toBe('s1');
  });

  test('an untagged file added twice is a duplicate; an artist on one side only is not', () => {
    const take = {id: 'u', title: 'garage-take-4', artist: '', duration: 180, source: {type: 'upload', value: 'abc', filename: 'garage-take-4.wav'}};
    expect(findDuplicate({title: 'garage-take-4', duration: 180}, [take])).toBe(take);
    expect(findDuplicate({title: 'garage-take-4', artist: '', duration: 181.5}, [take])).toBe(take);
    expect(findDuplicate({title: 'garage-take-4', artist: 'StickWorks', duration: 180}, [take])).toBeNull();
    expect(findDuplicate({title: 'garage-take-4'}, [take])).toBeNull();
  });

  test('canonicalUrl', () => {
    expect(canonicalUrl('https://www.youtube.com/shorts/HARBOR12345')).toBe('youtube:HARBOR12345');
    expect(canonicalUrl('https://www.youtube.com/embed/HARBOR12345')).toBe('youtube:HARBOR12345');
    expect(canonicalUrl('https://SoundCloud.com/Ada/Harbor-Lights/?utm_source=x')).toBe('soundcloud.com/ada/harbor-lights');
    expect(canonicalUrl('soundcloud.com/ada/harbor-lights')).toBe('soundcloud.com/ada/harbor-lights');
    expect(canonicalUrl('https://example.com/a?b=2&a=1')).toBe('example.com/a?a=1&b=2');
    expect(canonicalUrl('ftp://example.com/a')).toBeNull();
    expect(canonicalUrl('')).toBeNull();
    expect(canonicalUrl(null)).toBeNull();
  });
});

describe('describeDefaults (through profile.addDefaults)', () => {
  const stock = {preset: 'balanced', stemMode: 'full', bitrate: 192};
  test.each([
    // [label, profile, settings, line]
    ['drummer', profile(['drums']), stock, 'Split for drums · Balanced quality · 4 stems'],
    ['bassist', profile(['bass']), stock, 'Split for bass · Balanced quality · 4 stems'],
    ['singer', profile(['vocals']), stock, 'Split for vocals · Balanced quality · 4 stems'],
    ['guitarist: 6 stems', profile(['guitar']), stock, 'Split for guitar · Balanced quality · 6 stems'],
    ['keys player: 6 stems', profile(['keys']), stock, 'Split for keys · Balanced quality · 6 stems'],
    ['drums primary with guitar: 6 stems, split for the primary', profile(['guitar', 'drums'], 'drums'), stock, 'Split for drums · Balanced quality · 6 stems'],
    ['no primary: the first instrument', profile(['bass', 'guitar'], null), stock, 'Split for bass · Balanced quality · 6 stems'],
    ['other: no instrument word', profile(['other']), stock, 'Balanced quality · 4 stems'],
    ['no profile', null, stock, 'Balanced quality · 4 stems'],
    ['no profile, no settings', undefined, undefined, 'Balanced quality · 4 stems'],
    ['studio preset', profile(['drums']), {...stock, preset: 'studio'}, 'Split for drums · Studio quality · 4 stems'],
    ['fast preset', profile(['drums']), {...stock, preset: 'fast'}, 'Split for drums · Fast quality · 4 stems'],
    ['custom preset', profile(['drums']), {...stock, preset: 'custom'}, 'Split for drums · Custom quality · 4 stems'],
    ['saved full for a guitarist', profile(['guitar']), {...stock, addDefaultsSaved: true}, 'Split for guitar · Balanced quality · 4 stems'],
    ['saved six for a drummer', profile(['drums']), {...stock, stemMode: 'six', addDefaultsSaved: true}, 'Split for drums · Balanced quality · 6 stems'],
    ['a stored two-part mode is never the default', profile(['drums']), {...stock, stemMode: 'drums', addDefaultsSaved: true}, 'Split for drums · Balanced quality · 4 stems'],
    ['custom 6-stem model on a saved full split: 6 stems', profile(['guitar']), {...stock, preset: 'custom', custom: {model: 'htdemucs_6s'}, addDefaultsSaved: true}, 'Split for guitar · Custom quality · 6 stems'],
    ['custom 4-stem model on a saved full split: 4 stems', profile(['guitar']), {...stock, preset: 'custom', custom: {model: 'htdemucs_ft'}, addDefaultsSaved: true}, 'Split for guitar · Custom quality · 4 stems'],
    ['a 6-stem custom model off the Custom preset does not count', profile(['drums']), {...stock, preset: 'balanced', custom: {model: 'htdemucs_6s'}}, 'Split for drums · Balanced quality · 4 stems'],
  ])('%s', (_, p, settings, line) => {
    expect(describeDefaults(p, settings)).toBe(line);
  });

  test('the stem count always follows addDefaults (the only definition)', () => {
    for (const p of [profile(['drums']), profile(['guitar']), profile(['keys', 'vocals']), null]) {
      for (const settings of [{}, {stemMode: 'six'}, {stemMode: 'full', addDefaultsSaved: true}, {stemMode: 'bass'}]) {
        const {stemMode} = addDefaults(p, settings);
        expect(describeDefaults(p, settings).endsWith(`${stemCount(stemMode)} stems`)).toBe(true);
      }
    }
  });

  test('defaultsParts marks the emphasised words and takes the Change choice', () => {
    expect(defaultsParts(profile(['drums']), stock)).toEqual([
      {text: 'Split for ', strong: false}, {text: 'drums', strong: true}, {text: ' · ', strong: false},
      {text: 'Balanced', strong: true}, {text: ' quality · ', strong: false}, {text: '4 stems', strong: false},
    ]);
    const chosen = defaultsParts(profile(['drums']), stock, {stemMode: 'drums', preset: 'fast'}).map(p => p.text).join('');
    expect(chosen).toBe('Split for drums · Fast quality · 2 stems');
    const unknown = defaultsParts(profile(['drums']), stock, {stemMode: 'nope'}).map(p => p.text).join('');
    expect(unknown).toBe('Split for drums · Balanced quality · 4 stems');
  });
});

describe('removesMyStem', () => {
  test.each([
    // [profile, stemMode, instrument | null]
    [profile(['drums']), 'full', null],
    [profile(['drums']), 'six', null],
    [profile(['drums']), 'drums', null],
    [profile(['drums']), 'vocals', 'drums'],
    [profile(['drums']), 'bass', 'drums'],
    [profile(['bass']), 'bass', null],
    [profile(['bass']), 'drums', 'bass'],
    [profile(['vocals']), 'vocals', null],
    [profile(['vocals']), 'full', null],
    [profile(['guitar']), 'six', null],
    [profile(['guitar']), 'full', 'guitar'],
    [profile(['guitar']), 'drums', 'guitar'],
    [profile(['keys']), 'six', null],
    [profile(['keys']), 'full', 'keys'],
    [profile(['other']), 'full', null],
    [profile(['other']), 'six', null],
    [profile(['other']), 'vocals', 'other'],
    [profile(['drums', 'guitar'], 'drums'), 'full', 'guitar'],
    [profile(['drums', 'vocals'], 'vocals'), 'drums', 'vocals'],
    [profile(['vocals', 'drums'], 'drums'), 'drums', 'vocals'],
    [profile(['guitar', 'keys'], 'keys'), 'full', 'keys'],
    [profile([]), 'drums', null],
    [null, 'full', null],
    [profile(['drums']), 'nope', null],
  ])('%j on %s → %s', (p, stemMode, expected) => {
    expect(removesMyStem(p, stemMode)).toBe(expected);
  });

  test('a full split on the Custom 6-stem model keeps guitar and keys separate', () => {
    const six = {preset: 'custom', custom: {model: 'htdemucs_6s'}, stemMode: 'full'};
    expect(removesMyStem(profile(['guitar']), 'full', six)).toBeNull();
    expect(removesMyStem(profile(['keys']), 'full', six)).toBeNull();
    expect(removesMyStem(profile(['guitar']), 'full', {...six, preset: 'studio'})).toBe('guitar');
    expect(removesMyStem(profile(['guitar']), 'full', {...six, custom: {model: 'htdemucs'}})).toBe('guitar');
    expect(removesMyStem(profile(['guitar']), 'drums', six)).toBe('guitar');
  });

  test('the warning line names the instrument', () => {
    expect(removesMyStemLine('guitar')).toBe('Your guitar won’t be a separate track with this layout.');
    expect(removesMyStemLine('keys')).toBe('Your keys won’t be a separate track with this layout.');
    expect(removesMyStemLine('other')).toBe('Your part won’t be a separate track with this layout.');
  });
});

describe('stem layouts', () => {
  test('every layout, in the Change panel order', () => {
    expect(STEM_MODES).toEqual(['full', 'six', 'drums', 'vocals', 'bass']);
    expect(STEM_MODES.map(stemCount)).toEqual([4, 6, 2, 2, 2]);
    expect(stemsFor('six')).toEqual(['drums', 'bass', 'guitar', 'piano', 'vocals', 'other']);
    expect(stemsFor('vocals')).toEqual(['vocals', 'no_vocals']);
    expect(stemsFor('nope')).toEqual([]);
    expect(stemCount('nope')).toBe(0);
  });

  test('a full split on the Custom 6-stem model makes six stems (convex/lib/presets.ts expectedStems)', () => {
    const custom6 = {preset: 'custom', custom: {model: 'htdemucs_6s'}};
    expect(stemCount('full', custom6)).toBe(6);
    expect(stemsFor('full', custom6)).toEqual(stemsFor('six'));
    expect(stemCount('full', custom6, 'balanced')).toBe(4);   // the Change panel chose another preset
    expect(stemCount('full', {preset: 'balanced', custom: {model: 'htdemucs_6s'}}, 'custom')).toBe(6);
    expect(stemCount('drums', custom6)).toBe(2);
    expect(stemCount('full', {preset: 'custom', custom: {model: 'htdemucs'}})).toBe(4);
  });
});

describe('jobSettings', () => {
  const stored = {preset: 'studio', stemMode: 'drums', bitrate: 256, custom: {model: 'htdemucs', shifts: 1, overlap: 0.25}};
  test('the stored settings with the Add defaults: a stored two-part split is never sent', () => {
    expect(jobSettings(profile(['drums']), stored)).toEqual({...stored, stemMode: 'full', preset: 'studio'});
    expect(jobSettings(profile(['guitar']), {...stored, stemMode: 'full'})).toEqual({...stored, stemMode: 'six', preset: 'studio'});
    expect(jobSettings(null, undefined)).toEqual({stemMode: 'full', preset: 'balanced'});
  });
  test('the Change choice wins; an unknown layout is ignored', () => {
    expect(jobSettings(profile(['drums']), stored, {stemMode: 'drums'})).toMatchObject({stemMode: 'drums', preset: 'studio'});
    expect(jobSettings(profile(['drums']), stored, {preset: 'fast'})).toMatchObject({stemMode: 'full', preset: 'fast'});
    expect(jobSettings(profile(['drums']), stored, {stemMode: 'nope'})).toMatchObject({stemMode: 'full'});
  });
});

describe('files', () => {
  const file = (name, type = '') => ({name, type, size: 1});
  test.each([
    ['song.mp3', '', true],
    ['SONG.WAV', '', true],
    ['take.flac', 'audio/flac', true],
    ['a.m4a', '', true],
    ['a.aac', '', true],
    ['a.ogg', '', true],
    ['a.opus', '', true],
    ['a.aif', '', true],
    ['a.aiff', '', true],
    ['a.wma', '', true],
    ['no-extension', 'audio/mpeg', true],
    ['notes.pdf', 'application/pdf', false],
    ['cover.jpg', 'image/jpeg', false],
    ['video.mp4', 'video/mp4', false],
    ['song.xyz', '', false],
    ['song.mka', 'audio/x-matroska', true],
    ['', '', false],
  ])('%s (%s) → %s', (name, type, expected) => {
    expect(isAudioFile(file(name, type))).toBe(expected);
  });

  test('audioFiles keeps the order and the non-audio flag copy names the file', () => {
    const list = [file('a.mp3'), file('notes.pdf'), file('b.flac')];
    const {audio, other} = audioFiles(list);
    expect(audio.map(f => f.name)).toEqual(['a.mp3', 'b.flac']);
    expect(other.map(f => f.name)).toEqual(['notes.pdf']);
    expect(COPY.notAudio('notes.pdf')).toBe('notes.pdf isn’t audio. Woodshed accepts MP3, WAV, FLAC, M4A, AAC, OGG, Opus, AIFF and WMA.');
    expect(isAudioFile(null)).toBe(false);
    expect(AUDIO_EXTENSIONS).toContain('opus');
  });
});
