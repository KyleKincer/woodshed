// Stable geometric sleeves are a fallback underneath real album artwork.
const palettes = [['#174bd1','#f6f3e8'],['#ed763c','#192621'],['#d9df84','#263e35'],['#ead0cb','#843c3a'],['#172725','#f17b3b'],['#dce4e5','#1e4f71']];
export function artworkSeed(song) {
  return song.album ? `${song.artist || song.uploader || ''}\0${song.album}` : String(song.id || song.title || 'woodshed');
}
export function fallbackArtwork(seed) {
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const [bg, ink] = palettes[hash % palettes.length];
  const shapes = [
    '<circle cx="150" cy="150" r="92" fill="none" stroke-width="34"/>',
    '<path d="M-35 190 110 15 265 195" fill="none" stroke-width="34"/>',
    '<path d="M25 240 130 0h70L95 240Z" stroke="none"/>',
    '<circle cx="115" cy="120" r="89" fill="none" stroke-width="7"/><circle cx="115" cy="120" r="65" fill="none" stroke-width="17"/><circle cx="115" cy="120" r="30" stroke="none"/>',
    '<path d="M0 0h120v120H0zM120 120h120v120H120z" stroke="none"/>',
    '<path d="M35 0v240M92 0v240M149 0v240M206 0v240" fill="none" stroke-width="22"/>',
  ];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><path fill="${bg}" d="M0 0h240v240H0z"/><g fill="${ink}" stroke="${ink}">${shapes[(hash >>> 8) % shapes.length]}</g></svg>`)}`;
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function artworkMarkup(song, url, className) {
  const fallback = fallbackArtwork(artworkSeed(song));
  return `<div class="${className} artwork" style="background-image:url('${fallback}')" aria-hidden="true">${url ? `<img src="${escape(url)}" alt="" loading="lazy" decoding="async" data-artwork>` : ''}</div>`;
}
export function wireArtwork(root) {
  root.querySelectorAll('img[data-artwork]').forEach(img => {
    const failed = () => img.remove();
    img.addEventListener('error', failed, {once:true});
    if (img.complete && !img.naturalWidth) failed();
  });
}
export function setArtwork(element, song, url) {
  element.classList.add('artwork');
  element.style.backgroundImage = `url("${fallbackArtwork(artworkSeed(song))}")`;
  element.replaceChildren();
  if (!url) return;
  const img = new Image();
  img.alt = ''; img.decoding = 'async';
  img.addEventListener('error', () => img.remove(), {once:true});
  img.src = url;
  element.append(img);
}
