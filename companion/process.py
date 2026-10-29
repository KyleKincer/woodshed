"""One resumable local job. Emits JSON lines on stdout; keeps source and WAV stems.

Lines (read by companion/server.mjs):
  {"stage", "percent", "message"}   progress
  {"meta": {...}}                   early metadata after acquisition (once per run)
  {"error": detail, "code": code}   the failure: raw detail plus a job error code (errors.py)
  {"complete": true}                result.json is written

Every step that finished is kept on disk (result.json, source.wav with
source-meta.json, separation.complete), so a job interrupted by an app
update or a restart resumes where it stopped (D12).
"""
import json, pathlib, sys, shutil
from concurrent.futures import ThreadPoolExecutor
from errors import classify, describe
from fingerprint import fingerprint
from pipeline import Reporter, acquire, separate, encode, expected_stems, probe_duration, run

#: The sample rate detection works at: BeatNet's input rate, and the mix CPC's sections read.
DETECT_RATE = 22050


def stage_before_progress(job) -> str:
    """The stage a failure is attributed to when it happens before the first progress line."""
    return {'beats': 'detect', 'sections': 'detect', 'import': 'finalize'}.get(job.get('kind'), 'download')


def detection_mix(job, root, rep) -> pathlib.Path:
    """The mono 22.05 kHz mix detection runs on (B6).

    A chained job reuses the separation's local source (job.localMix, set by
    the companion when <account>/jobs/<chainedFrom>/source.wav exists);
    otherwise the downloaded stems (job.localStems) are mixed.
    """
    mix = root / 'mix.wav'
    rep.progress('detect', 20, 'Building a mix locally…')
    local = job.get('localMix')
    if local and pathlib.Path(local).is_file():
        run(['ffmpeg', '-y', '-i', str(local), '-vn', '-ar', str(DETECT_RATE), '-ac', '1', str(mix)])
    else:
        paths = job.get('localStems') or []
        if not paths:
            raise RuntimeError('No audio to analyse: the song has no stems.')
        inputs = [arg for path in paths for arg in ['-i', str(path)]]
        run(['ffmpeg', '-y', *inputs, '-filter_complex', f'amix=inputs={len(paths)}:normalize=0',
             '-ar', str(DETECT_RATE), '-ac', '1', str(mix)])
    return mix


def song_duration(job, mix) -> float:
    song = job.get('song') or {}
    duration = song.get('duration') if isinstance(song, dict) else None
    if isinstance(duration, (int, float)) and duration > 0:
        return float(duration)
    return float(probe_duration(mix))


def load_audio(path):
    """(samples, rate) of a mono WAV as float32 numpy, for sections.suggest."""
    try:
        import soundfile
    except ModuleNotFoundError:
        import librosa
        return librosa.load(str(path), sr=None, mono=True)
    audio, rate = soundfile.read(str(path), dtype='float32', always_2d=False)
    if getattr(audio, 'ndim', 1) > 1:
        audio = audio.mean(axis=1)
    return audio, rate


def clean_sections(raw) -> list:
    """The suggestion list in exactly worker.suggestedSectionValidator's shape: {t0, label, confidence}."""
    out = []
    for item in raw or []:
        try:
            t0, confidence = float(item['t0']), float(item.get('confidence', 0))
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if t0 != t0 or t0 < 0 or confidence != confidence:  # NaN
            continue
        out.append({'t0': round(t0, 4), 'label': str(item.get('label') or 'Section'), 'confidence': max(0.0, min(1.0, confidence))})
    return out


def suggest_sections(mix, downbeats, duration) -> list:
    """companion/sections.py's suggestions (B7) for the mix along these downbeats."""
    from sections import suggest
    audio, rate = load_audio(mix)
    return clean_sections(suggest(audio, rate, [float(t) for t in downbeats], duration=duration))


def detect_beats(job, root, rep) -> dict:
    """A beats job (B6): bars, then section suggestions when settings.sections (D47)."""
    mix = detection_mix(job, root, rep)
    rep.progress('detect', 50, 'Finding bars…')
    from beats import detect
    beats = detect(mix)
    result = {'beats': beats}
    if (job.get('settings') or {}).get('sections'):
        rep.progress('detect', 80, 'Finding sections…')
        # Suggestions are a bonus on a beats job: a failure there never costs the bars.
        try:
            downbeats = [t for t, beat in beats if round(beat) == 1]
            result['sections'] = suggest_sections(mix, downbeats, song_duration(job, mix))
        except Exception as error:
            print(f'Section suggestions unavailable: {describe(error)}', file=sys.stderr, flush=True)
            result['sections'] = []
    rep.progress('detect', 95, 'Saving bars…')
    return result


def detect_sections(job, root, rep) -> dict:
    """A sections job (D47): suggestions along the song's current bar starts (claim's downbeats)."""
    mix = detection_mix(job, root, rep)
    rep.progress('detect', 50, 'Finding sections…')
    sections = suggest_sections(mix, job.get('downbeats') or [], song_duration(job, mix))
    rep.progress('detect', 95, 'Saving sections…')
    return {'sections': sections}


def process(job, root, rep=None):
    rep = rep or Reporter()
    result_file = root / 'result.json'
    if result_file.exists():
        return json.loads(result_file.read_text())
    if job['kind'] == 'beats':
        return detect_beats(job, root, rep)
    if job['kind'] == 'sections':
        return detect_sections(job, root, rep)
    quality = dict(job['quality'])
    # Cloud sync always uses compressed audio; WAVs are retained for local export.
    quality['format'] = 'opus'
    mode = (job.get('settings') or {}).get('stemMode', 'full')
    # `six` is the 6-stem model on the full layout; worker.claim already sends 'full'.
    if mode == 'six': mode = 'full'
    if job['kind'] == 'import':
        old = job['legacySong']
        meta = {k: old.get(k, '') for k in ['title','artist','album','uploader']}
        meta['duration'] = old.get('duration', 0)
        sources = [(s['name'], pathlib.Path(s['path'])) for s in old['stems']]
        cover = pathlib.Path(old['coverPath']) if old.get('coverPath') else None
        if cover and cover.is_file(): shutil.copyfile(cover, root / 'cover.jpg')
        mode = old.get('stemMode', 'full')
    else:
        meta_file = root / 'source-meta.json'
        if meta_file.exists() and (root / 'source.wav').exists():
            meta = json.loads(meta_file.read_text()); wav = root / 'source.wav'
        else:
            wav, meta = acquire(job, root, rep)
            if wav != root / 'source.wav': shutil.copyfile(wav, root / 'source.wav')
            wav = root / 'source.wav'
            meta['cover'] = str(meta['cover']) if meta.get('cover') else None
            meta_file.write_text(json.dumps(meta))
        # The job card shows the real title as soon as it is known (B4, §6.10 item 6).
        rep.meta(meta)
        if 'fingerprint' not in meta:
            meta['fingerprint'] = fingerprint(wav)
            meta_file.write_text(json.dumps(meta))
        out = root / 'separated'
        model_dir = out / quality['model'] / wav.stem
        wanted = expected_stems(mode, quality['model'])
        # Only reuse a completed separation, never partially written stems.
        if not (root / 'separation.complete').exists():
            separate(wav, out, quality, mode, rep)
            (root / 'separation.complete').touch()
        sources = [(name, model_dir / f'{name}.wav') for name in wanted]
    rep.progress('finalize', 90, 'Encoding sync copies locally…')
    # Join every independent encoder before committing result.json.
    for name, src in sources:
        if not src.is_file(): raise RuntimeError(f'Missing stem: {name}')
    def encode_stem(item):
        name, src = item
        dest = root / f'{name}.webm'
        encode(src, dest, quality)
        return {'name': dest.name, 'stem': name, 'mime': 'audio/webm'}
    from separator import cpu_budget
    with ThreadPoolExecutor(max_workers=min(4, cpu_budget(), max(1, len(sources)))) as pool:
        files = list(pool.map(encode_stem, sources))
    cover = root / 'cover.jpg'
    if cover.is_file() and 0 < cover.stat().st_size <= 2_000_000:
        files.append({'name':'cover.jpg','mime':'image/jpeg'})
    result = {k:str(meta.get(k) or '') for k in ['title','uploader','artist','album']}
    if meta.get('fingerprint'): result['fingerprint'] = meta['fingerprint']
    for key in ['albumArtist','year','genre','trackNumber','discNumber','musicalKey']:
        value = str(meta.get(key) or '').strip()[:500]
        if key == 'year' and (len(value) != 4 or not value.isdigit()): value = ''
        if key in ['trackNumber','discNumber'] and (not value.isdigit() or not 0 < int(value) < 10000): value = ''
        if value: result[key] = value
    # B4: where a link or search landed, and the site that served it (yt-dlp extractor_key).
    for key in ['resolvedUrl', 'provider']:
        value = str(meta.get(key) or '').strip()
        if value: result[key] = value[:2000]
    result.update(duration=float(meta.get('duration') or probe_duration(sources[0][1])), stemMode=mode, quality=quality, files=files)
    result_file.write_text(json.dumps(result))
    return result


def main(argv=None, out=None) -> int:
    argv = sys.argv if argv is None else argv
    root = pathlib.Path(argv[1]).resolve()
    job = json.loads((root / 'job.json').read_text())
    rep = Reporter(out)
    emit = lambda payload: print(json.dumps(payload), file=out or sys.stdout, flush=True)
    try:
        result = process(job, root, rep)
        (root / 'result.json').write_text(json.dumps(result))
        emit({'complete': True})
        return 0
    except Exception as error:
        detail = describe(error)
        source_type = (job.get('source') or {}).get('type') if job.get('kind') == 'separate' else None
        code = classify(detail, stage=rep.stage or stage_before_progress(job), source_type=source_type)
        emit({'error': detail, 'code': code})
        return 1


if __name__ == '__main__':
    sys.exit(main())
