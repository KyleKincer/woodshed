"""Exercise the distributed executable with real local audio, on every OS."""
import json, math, os, pathlib, struct, subprocess, tempfile, wave, sys
root=pathlib.Path(__file__).resolve().parent.parent
executable=root/'build/processor/woodshed-processor'/('woodshed-processor.exe' if os.name=='nt' else 'woodshed-processor')
env={**os.environ,'PATH':str(root/'build/bin')+os.pathsep+os.environ['PATH']}
command = [sys.executable, str(root/'companion/process.py')] if '--source' in sys.argv else [str(executable)]
with tempfile.TemporaryDirectory(prefix='woodshed-runtime-test-') as folder:
    work=pathlib.Path(folder);source=work/'input.wav';rate=44100;seconds=8
    with wave.open(str(source),'wb') as audio:
        audio.setnchannels(2);audio.setsampwidth(2);audio.setframerate(rate)
        samples=[]
        for i in range(rate*seconds):
            pulse=i%(rate//2)
            value=.12*math.sin(2*math.pi*220*i/rate)+(.3*math.sin(math.pi*pulse/400)**2 if pulse<400 else 0)
            samples.extend([int(32767*value)]*2)
        audio.writeframes(struct.pack('<'+'h'*len(samples),*samples))
    quality={'model':'htdemucs','shifts':0,'overlap':.25,'format':'opus','bitrate':192}
    job={'kind':'separate','source':{'type':'upload','value':'fixture','filename':'input.wav'},'localSource':str(source),'quality':quality,'settings':{'stemMode':'full'}}
    (work/'job.json').write_text(json.dumps(job))
    subprocess.run([*command,str(work)],env=env,check=True,timeout=600)
    runtime=json.loads((work/'separation-runtime.json').read_text())
    assert runtime['device'] in ('cpu','cuda','mps') and runtime['seconds'] > 0
    print('Separation runtime:', json.dumps(runtime), flush=True)
    if '--expect-cuda' in sys.argv:
        assert runtime['attempts'][0]['cuda'], 'Optional NVIDIA processor must include CUDA'
    result=json.loads((work/'result.json').read_text())
    stems=[f for f in result['files'] if f.get('stem')]
    assert len(stems)==4
    for stem in stems:
        decoded=work/'decoded.wav'
        subprocess.run([str(root/'build/bin'/('ffmpeg.exe' if os.name=='nt' else 'ffmpeg')),'-v','error','-y','-i',str(work/stem['name']),'-ar',str(rate),str(decoded)],env=env,check=True)
        with wave.open(str(decoded)) as audio: assert audio.getnframes()==rate*seconds
    # A completed job must not rerun inference or change the aligned outputs.
    before=(work/'separation-runtime.json').read_bytes()
    subprocess.run([*command,str(work)],env=env,check=True,timeout=60)
    assert (work/'separation-runtime.json').read_bytes()==before
    if '--skip-beats' in sys.argv:
        print('PASS: separation, concurrent encoding, frame alignment, and resume.')
        sys.exit(0)
    beat_dir=work/'beats';beat_dir.mkdir()
    (beat_dir/'job.json').write_text(json.dumps({'kind':'beats','quality':quality,'localStems':[str(source)]}))
    subprocess.run([*command,str(beat_dir)],env=env,check=True,timeout=300)
    beats=json.loads((beat_dir/'result.json').read_text())['beats']
    assert len(beats)>0, 'No beats detected in rhythmic fixture'
    print('PASS: frozen runtime separated, encoded four aligned stems, and detected beats.')
