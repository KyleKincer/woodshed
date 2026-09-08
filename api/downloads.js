import {normalizeRelease} from '../src/js/download-release.js';

// Keep browser requests same-origin and share the public GitHub lookup through
// the CDN cache. No credentials or private repository data are involved.
export default async function downloads(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({error:'Method not allowed'});
  }
  try {
    const response = await fetch('https://api.github.com/repos/KyleKincer/woodshed/releases/latest', {
      headers: {'Accept':'application/vnd.github+json','User-Agent':'Woodshed-Downloads'},
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error('Release lookup unavailable');
    const release = await response.json();
    normalizeRelease(release);
    res.setHeader('Cache-Control','public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({tag_name:release.tag_name,assets:release.assets.map(({name,size,browser_download_url})=>({name,size,browser_download_url}))});
  } catch {
    res.setHeader('Cache-Control','no-store');
    return res.status(503).json({error:'Release lookup unavailable'});
  }
}
