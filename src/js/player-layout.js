// Reparent the existing controls without replacing their IDs or audio behavior.
export function arrangePlayerControls(root) {
  const player = root.querySelector('.player');
  const transport = root.querySelector('.transport');
  const primary = document.createElement('div');
  primary.className = 'transport-main';
  primary.setAttribute('role', 'group');
  primary.setAttribute('aria-label', 'Playback');
  const practice = document.createElement('div');
  practice.className = 'practice-strip';
  practice.setAttribute('role', 'group');
  practice.setAttribute('aria-label', 'Loop');
  const tools = document.createElement('div');
  tools.className = 'timeline-tools';
  tools.setAttribute('role', 'group');
  tools.setAttribute('aria-label', 'Timeline');
  const move = (selector, target, group = false) => {
    const element = root.querySelector(selector);
    if (element) target.append(group ? element.closest('.t-group') : element);
  };
  move('#play', primary); move('#time', primary); move('#speed', primary, true);
  move('#metro-btn', primary); move('#mixer-reset', primary); move('#help', primary);
  move('#loop-readout', practice);
  move('#zoom-fit', tools, true); move('#grid-toggle', tools, true);
  transport.replaceChildren(primary, practice);
  const ruler = document.createElement('div');
  ruler.className = 'time-ruler';
  ruler.innerHTML = '<span>Tracks</span><div class="ruler-scale" aria-label="Timeline times"></div>';
  player.prepend(tools, ruler);
  const labels = {play:'Play',speed:'Playback speed','grid-division':'Grid subdivision','m-bpm':'Tempo in beats per minute','m-sig':'Time signature','m-vol':'Metronome volume',help:'Keyboard shortcuts','zoom-in':'Zoom in','zoom-out':'Zoom out','zoom-fit':'Fit whole song','mini-toggle':'Song overview','mixer-reset':'Reset mixer'};
  for (const [id,label] of Object.entries(labels)) root.querySelector('#'+id)?.setAttribute('aria-label',label);
  const metro = root.querySelector('#metro-btn');
  metro.setAttribute('aria-controls','metro-pop');
  metro.setAttribute('aria-expanded','false');
  const popover = root.querySelector('#metro-pop');
  const close = document.createElement('button');
  close.className = 'toggle-btn metro-close'; close.textContent = 'Close';
  close.setAttribute('aria-label','Close metronome settings');
  close.onclick = () => { metro.click(); metro.focus(); };
  popover.prepend(close);
}
