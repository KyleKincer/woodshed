const releases = 'https://github.com/KyleKincer/woodshed/releases';
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
export function renderDownload() {
  document.title='Woodshed — Desktop app';
  document.body.className='download-page';
  document.body.innerHTML=`<main class="download-content"><a class="brand" href="/">◐ Woodshed</a><h1>Download Woodshed</h1><p class="download-lead">The full Woodshed app, with downloading, instrument separation, and beat detection built in. Sign in with the same Google account to sync your library and practice on your phone.</p><div class="desktop-downloads"><a class="btn-primary" href="${releases}/latest">Download Woodshed</a><a class="btn-ghost" href="https://github.com/KyleKincer/woodshed">View source</a></div><p class="hint">macOS · Windows · Linux · Free and open source</p><div class="download-steps"><section><h2>1. Install Woodshed</h2><p>Choose the installer for your computer on GitHub Releases. macOS uses a DMG, Windows uses an EXE, and Linux uses an AppImage. No separate Python, Node.js, or FFmpeg installation is needed.</p><p class="hint">Windows may show an unknown-publisher warning while our app is unsigned. On Linux, make the AppImage executable before opening it.</p></section><section><h2>2. Sign in and add a song</h2><p>Google sign-in opens in your browser, then returns you to Woodshed. Downloading and audio processing happen on your computer. Processing models download on first use.</p></section><section><h2>3. Open your library</h2><p>Your library syncs to the web player. Desktop updates appear in the app: download when convenient, then restart when playback and processing are finished.</p></section></div><p class="download-lead">Your synced library also works in the browser.</p><a class="btn-ghost" href="/">Open web player</a></main>`;
}
