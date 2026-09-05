"""Exercise the distributed executable with real local audio, on every OS."""
import json, math, os, pathlib, struct, subprocess, tempfile, wave
root=pathlib.Path(__file__).resolve().parent.parent
executable=root/'build/processor/woodshed-processor'/('woodshed-processor.exe' if os.name=='nt' else 'woodshed-processor')
env={**os.environ,'PATH':str(root/'build/bin')+os.pathsep+os.environ['PATH'],'OMP_NUM_THREADS':'4'}
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
    subprocess.run([str(executable),str(work)],env=env,check=True,timeout=600)
    result=json.loads((work/'result.json').read_text())
    stems=[f for f in result['files'] if f.get('stem')]
    assert len(stems)==4
    for stem in stems:
        decoded=work/'decoded.wav'
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(work/stem['name']),'-ar',str(rate),str(decoded)],env=env,check=True)
        with wave.open(str(decoded)) as audio: assert audio.getnframes()==rate*seconds
    beat_dir=work/'beats';beat_dir.mkdir()
    (beat_dir/'job.json').write_text(json.dumps({'kind':'beats','quality':quality,'localStems':[str(source)]}))
    subprocess.run([str(executable),str(beat_dir)],env=env,check=True,timeout=300)
    beats=json.loads((beat_dir/'result.json').read_text())['beats']
    assert len(beats)>0, 'No beats detected in rhythmic fixture'
    print('PASS: frozen runtime separated, encoded four aligned stems, and detected beats.')
