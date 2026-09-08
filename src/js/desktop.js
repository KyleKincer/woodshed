import {detectPlatform, normalizeRelease, formatSize} from './download-release.js';
export function showDesktopSetup(message = '') {
  let dialog=document.getElementById('desktop-dialog');
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='desktop-dialog';dialog.className='desktop-dialog';
    dialog.innerHTML=`<h2>Add songs with Woodshed for desktop</h2><p>The desktop app downloads and separates audio on your computer. Your songs sync here for practice on any device.</p><p id="desktop-status" class="hint"></p><div class="modal-actions"><button class="btn-ghost" id="desktop-close">Keep browsing</button><a class="btn-primary" href="/download">Download Woodshed</a></div>`;
    document.body.append(dialog);dialog.querySelector('#desktop-close').onclick=()=>dialog.close();
  }
  dialog.querySelector('#desktop-status').textContent=message;
  if(!dialog.open)dialog.showModal();
}
export async function renderDownload() {
  document.title='Woodshed — Desktop app';
  document.body.className='download-page';
  document.body.innerHTML=`
    <main class="download-content">
      <nav class="download-nav" aria-label="Main"><a class="brand" href="/">Woodshed</a><a href="/">Open web player <span aria-hidden="true">↗</span></a></nav>
      <section class="download-hero" aria-labelledby="download-title">
        <div class="download-hero-copy"><p class="eyebrow">YOUR PRACTICE SPACE. ON YOUR DESKTOP.</p><h1 id="download-title">Download<br>Woodshed.</h1>
          <p class="download-lead">Break a song into its parts. Slow it down. Loop the tricky bit. Everything you need to make it your own.</p>
          <div class="desktop-downloads"><a id="recommended-download" class="btn-primary" href="#all-downloads">See all downloads <span aria-hidden="true">↓</span></a><a class="download-all-link" href="#all-downloads">All platforms</a></div>
          <p id="recommended-detail" class="download-detail">macOS · Windows · Linux</p>
          <p id="download-status" class="download-status" role="status" aria-live="polite">Finding available downloads…</p>
        </div>
        <div class="download-icon-display"><img src="/woodshed-icon.svg" width="320" height="320" alt="Woodshed app icon"><span>BUILT FOR THE SHED.</span></div>
      </section>
      <section id="all-downloads" class="all-downloads" aria-labelledby="all-downloads-title">
        <div class="download-section-heading"><h2 id="all-downloads-title">All downloads</h2><span id="download-version">Desktop app</span></div>
        <div class="download-platforms" aria-busy="true">
          <article class="download-platform" data-platform="mac"><div><h3>macOS</h3><p>Apple Silicon · M1 or newer</p></div><div class="platform-files"><span class="download-file-placeholder">Loading installers…</span></div></article>
          <article class="download-platform" data-platform="windows"><div><h3>Windows</h3><p>64-bit · Intel &amp; AMD</p></div><div class="platform-files"><span class="download-file-placeholder">Loading installer…</span></div></article>
          <article class="download-platform" data-platform="linux"><div><h3>Linux</h3><p>64-bit · Intel &amp; AMD</p></div><div class="platform-files"><span class="download-file-placeholder">Loading installer…</span></div></article>
        </div>
        <button id="retry-downloads" class="btn-ghost hidden" type="button">Try again</button>
      </section>
      <div class="download-steps"><section><span class="step-number">01</span><h2>Install once.</h2><p>Open the installer and follow the prompts. Audio separation and beat detection are built in. No extra developer tools needed.</p><p class="hint">On macOS, drag Woodshed to Applications. Windows may show an unknown-publisher warning. On Linux, make the AppImage executable before opening it.</p></section><section><span class="step-number">02</span><h2>Bring your music.</h2><p>Sign in with Google and add a song. Woodshed handles the download and separates the instruments on your computer. Processing models download on first use.</p></section><section><span class="step-number">03</span><h2>Make time to play.</h2><p>Your library and practice settings sync to the web player, so you can pick up on your phone or another computer.</p></section></div>
      <footer class="download-footer"><span>Free &amp; open source.</span><div><a href="https://github.com/KyleKincer/woodshed/releases">Release notes</a><a href="https://github.com/KyleKincer/woodshed">View source</a></div></footer>
    </main>`;
  const root = document.querySelector('.download-content');
  const platform = detectPlatform();
  const primary = root.querySelector('#recommended-download');
  const detail = root.querySelector('#recommended-detail');
  const status = root.querySelector('#download-status');
  const retry = root.querySelector('#retry-downloads');
  const cards = root.querySelector('.download-platforms');
  const labels = {mac:'macOS',windows:'Windows',linux:'Linux'};
  if (platform === 'mobile' || platform === 'web') {
    primary.href = '/';primary.textContent = 'Open web player ↗';
    detail.textContent = platform === 'mobile' ? 'Practice in your browser. Add songs with the desktop app.' : 'Choose your desktop installer below, or practice in your browser.';
  }
  const connectDownload = (link, file) => {
    link.href = file.url;link.setAttribute('download',file.name);
    link.onclick = () => { status.textContent = 'Your download should start shortly. If it doesn’t, click the download again.'; };
  };
  async function load() {
    retry.classList.add('hidden');cards.setAttribute('aria-busy','true');
    status.textContent = 'Finding available downloads…';
    let release;
    for (const url of ['/api/downloads','/downloads.json']) {
      try {
        const response = await fetch(url,{signal:AbortSignal.timeout(10000)});
        if (!response.ok) throw Error('Download lookup failed');
        release = normalizeRelease(await response.json());break;
      } catch { /* The bundled manifest keeps verified downloads available during an API outage. */ }
    }
    if (!root.isConnected) return;
    cards.removeAttribute('aria-busy');
    if (!release) {
      status.textContent = 'Downloads couldn’t load. Check your connection and try again.';
      root.querySelectorAll('.platform-files').forEach(files => { files.textContent = 'Temporarily unavailable'; });
      retry.classList.remove('hidden');return;
    }
    root.querySelector('#download-version').textContent = `Version ${release.version}`;
    for (const [key, files] of Object.entries(release.downloads)) {
      const card = root.querySelector(`[data-platform="${key}"]`);
      const list = card.querySelector('.platform-files');list.replaceChildren();
      card.classList.toggle('recommended',key === platform);
      for (const file of files) {
        const link = document.createElement('a');link.className='download-file';
        link.innerHTML = '<span></span><small></small><b aria-hidden="true">↓</b>';
        link.querySelector('span').textContent = file.label;
        link.querySelector('small').textContent = formatSize(file.size);
        link.setAttribute('aria-label',`Download Woodshed for ${labels[key]}, ${file.label}, ${formatSize(file.size)}`);
        connectDownload(link,file);list.append(link);
      }
    }
    if (labels[platform]) {
      const file = release.downloads[platform][0];
      primary.textContent = `Download for ${labels[platform]} ↓`;connectDownload(primary,file);
      detail.textContent = `${platform === 'mac' ? 'Requires Apple Silicon (M1 or newer)' : '64-bit installer'} · ${formatSize(file.size)} · v${release.version}`;
    }
    status.textContent = '';
  }
  retry.onclick = load;
  await load();
}
