import test from 'node:test';
import assert from 'node:assert/strict';
import { artworkSeed, fallbackArtwork, artworkMarkup } from '../src/js/artwork.js';
test('songs on the same album share a stable fallback across renders', () => {
 const a={id:'one',title:'First',artist:'Band',album:'Record'};
 const b={...a,id:'two',title:'Second'};
 assert.equal(fallbackArtwork(artworkSeed(a)),fallbackArtwork(artworkSeed(b)));
 assert.notEqual(artworkSeed(a),artworkSeed({...a,artist:'Other band'}));
 assert.ok(fallbackArtwork(artworkSeed(a)).startsWith('data:image/svg+xml,'));
});
test('valid artwork remains a real image above fallback and URL attributes are escaped', () => {
 const html=artworkMarkup({id:'one'},'https://example.com/cover?x=" onerror="bad','cover');
 assert.match(html,/<img src="https:\/\/example.com\/cover\?x=&quot; onerror=&quot;bad"/);
 assert.match(html,/data:image\/svg\+xml/);
 assert.doesNotMatch(artworkMarkup({id:'one'},null,'cover'),/<img/);
});
