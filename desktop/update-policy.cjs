function canRestart({ playing, processing }) { return !playing && !processing; }
function publicUpdateState(status, info = {}) {
  return { status, version: typeof info.version === 'string' ? info.version : null,
    percent: Math.max(0, Math.min(100, Number(info.percent) || 0)),
    message: typeof info.message === 'string' ? info.message : '' };
}
module.exports = { canRestart, publicUpdateState };
