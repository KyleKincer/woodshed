import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {ConvexError} from 'convex/values';

const fake = vi.hoisted(() => ({client: null}));
// src/app/auth.js arrives with AU1 (wave 0B); see tests/api-client.test.js for why both specifiers are mocked.
vi.mock('../src/app/auth.js', () => ({client: () => fake.client}));
vi.mock('../app/auth.js', () => ({client: () => fake.client}));

const {ApiError} = await import('../src/api/client.js');
const metadata = await import('../src/api/metadata.js');

const make = () => ({
  query: vi.fn(async () => null), mutation: vi.fn(async () => null), action: vi.fn(async () => null),
  onUpdate: vi.fn(() => vi.fn()), close: vi.fn(async () => {}),
});

beforeEach(() => { fake.client = make(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('wrappers', () => {
  test.each([
    ['update', 'mutation', 'metadata:update', {ids: ['s1'], changes: {genre: 'Jazz'}, unlock: ['genre'], match: {recordingId: 'r'}}],
    ['updateEach', 'mutation', 'metadata:updateEach', {items: [{id: 's1', changes: {genre: ''}, unlock: ['genre']}]}],
    ['confirm', 'mutation', 'metadata:confirm', {id: 's1'}],
    ['find', 'action', 'metadataLookup:find', {id: 's1', title: 'Song', artist: 'Artist'}],
    ['detail', 'action', 'metadataLookup:detail', {id: 's1', recordingId: 'r', releaseId: 'l'}],
    ['retry', 'action', 'metadataLookup:retry', {id: 's1'}],
  ])('%s calls %s %s with its arguments unchanged', async (name, kind, fn, args) => {
    fake.client[kind].mockResolvedValueOnce('ok');
    expect(await metadata[name](args)).toBe('ok');
    expect(fake.client[kind]).toHaveBeenCalledWith(fn, args);
  });

  test('a field error arrives as ApiError invalid with the field and labelled copy', async () => {
    fake.client.mutation.mockRejectedValueOnce(new ConvexError({code: 'invalid', message: 'Album artist is too long (500 characters max).', field: 'albumArtist'}));
    const error = await metadata.update({ids: ['s1'], changes: {albumArtist: 'x'.repeat(501)}}).catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({code: 'invalid', message: 'Album artist is too long (500 characters max).', data: {field: 'albumArtist'}});
  });

  test('lookup errors keep their codes', async () => {
    fake.client.action.mockRejectedValueOnce(new ConvexError({code: 'lookup_busy', message: 'Metadata lookup is busy. Try again shortly.'}));
    expect(await metadata.retry({id: 's1'}).catch(e => e.code)).toBe('lookup_busy');
  });
});

describe('uploadArtwork', () => {
  const file = (type = 'image/png', bytes = 4) => new Blob([new Uint8Array(bytes).fill(7)], {type});

  async function expectedChecksum(blob) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    return btoa(String.fromCharCode(...digest));
  }

  test('reserves, PUTs the bytes with their checksum, verifies and returns the key', async () => {
    const blob = file();
    const checksum = await expectedChecksum(blob);
    fake.client.action.mockImplementation(async name => (name === 'artworkUpload:prepare' ? {url: 'https://r2.test/put', objectId: 'o1'} : 'users/u/artwork/k/cover.png'));
    const put = vi.fn(async () => new Response(null, {status: 200}));
    vi.stubGlobal('fetch', put);
    expect(await metadata.uploadArtwork({id: 's1', file: blob})).toBe('users/u/artwork/k/cover.png');
    expect(fake.client.action).toHaveBeenNthCalledWith(1, 'artworkUpload:prepare', {id: 's1', bytes: 4, mime: 'image/png', checksum});
    expect(put).toHaveBeenCalledWith('https://r2.test/put', expect.objectContaining({
      method: 'PUT', body: blob, headers: {'Content-Type': 'image/png', 'x-amz-checksum-sha256': checksum},
    }));
    expect(fake.client.action).toHaveBeenNthCalledWith(2, 'artworkUpload:complete', {objectId: 'o1'});
  });

  test('refuses other types and oversize images before any request, with the server copy', async () => {
    for (const blob of [file('image/gif'), file('image/png', 0), file('image/jpeg', 2_000_001)]) {
      const error = await metadata.uploadArtwork({id: 's1', file: blob}).catch(e => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({code: 'invalid', message: 'Choose a JPEG, PNG or WebP image under 2 MB.', data: {field: 'artwork'}});
    }
    expect(fake.client.action).not.toHaveBeenCalled();
  });

  test('a failed PUT is an ApiError and nothing is verified', async () => {
    fake.client.action.mockResolvedValueOnce({url: 'https://r2.test/put', objectId: 'o1'});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', {status: 403})));
    const error = await metadata.uploadArtwork({id: 's1', file: file('image/webp')}).catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Could not upload artwork. Try again.');
    expect(fake.client.action).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    fake.client.action.mockResolvedValueOnce({url: 'https://r2.test/put', objectId: 'o2'});
    expect(await metadata.uploadArtwork({id: 's1', file: file()}).catch(e => e.message)).toBe('Could not upload artwork. Try again.');
  });

  test('an abort rejects with the abort reason and skips verification', async () => {
    const controller = new AbortController();
    fake.client.action.mockResolvedValueOnce({url: 'https://r2.test/put', objectId: 'o1'});
    vi.stubGlobal('fetch', vi.fn(async (_url, {signal}) => {
      controller.abort();
      throw signal.reason;
    }));
    const error = await metadata.uploadArtwork({id: 's1', file: file(), signal: controller.signal}).catch(e => e);
    expect(error.name).toBe('AbortError');
    expect(fake.client.action).toHaveBeenCalledTimes(1);
  });

  test('a coded prepare failure (export-only, storage full) passes through', async () => {
    fake.client.action.mockRejectedValueOnce(new ConvexError({code: 'storage_full_user', message: 'There is not enough cloud storage for this image.'}));
    expect(await metadata.uploadArtwork({id: 's1', file: file()}).catch(e => e.code)).toBe('storage_full_user');
  });
});
