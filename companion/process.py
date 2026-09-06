"""One resumable local job. Emits JSON progress; keeps source and WAV stems."""
import json, pathlib, sys, shutil
from fingerprint import fingerprint
from pipeline import Reporter, acquire, separate, encode, expected_stems, probe_duration, run


def process(job, root):
    rep = Reporter()
    result_file = root / 'result.json'
    if result_file.exists():
        return json.loads(result_file.read_text())
    quality = job['quality']
    # Cloud sync always uses compressed audio; WAVs are retained for local export.
    quality['format'] = 'opus'
    mode = job.get('settings', {}).get('stemMode', 'full')
    if job['kind'] == 'import':
        old = job['legacySong']
        meta = {k: old.get(k, '') for k in ['title','artist','album','uploader']}
        meta['duration'] = old.get('duration', 0)
        sources = [(s['name'], pathlib.Path(s['path'])) for s in old['stems']]
        cover = pathlib.Path(old['coverPath']) if old.get('coverPath') else None
        if cover and cover.is_file(): shutil.copyfile(cover, root / 'cover.jpg')
        mode = old.get('stemMode', 'full')
    elif job['kind'] == 'beats':
        paths = job['localStems']
        mix = root / 'mix.wav'
        inputs = [arg for path in paths for arg in ['-i', path]]
        rep.progress('detect', 20, 'Building a mix locally…')
        run(['ffmpeg','-y',*inputs,'-filter_complex',f'amix=inputs={len(paths)}:normalize=0','-ar','22050','-ac','1',str(mix)])
        rep.progress('detect', 50, 'Detecting beats locally…')
        from beats import detect
        return {'beats': detect(mix)}
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
    files = []
    for name, src in sources:
        if not src.is_file(): raise RuntimeError(f'Missing stem: {name}')
        dest = root / f'{name}.webm'
        encode(src, dest, quality)
        files.append({'name': dest.name, 'stem': name, 'mime': 'audio/webm'})
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
    result.update(duration=float(meta.get('duration') or probe_duration(sources[0][1])), stemMode=mode, quality=quality, files=files)
    result_file.write_text(json.dumps(result))
    return result

if __name__ == '__main__':
    root = pathlib.Path(sys.argv[1]).resolve()
    job = json.loads((root / 'job.json').read_text())
    try:
        result = process(job, root)
        (root / 'result.json').write_text(json.dumps(result))
        print(json.dumps({'complete': True}), flush=True)
    except Exception as error:
        print(json.dumps({'error':str(error)}), flush=True)
        sys.exit(1)
