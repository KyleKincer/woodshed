"""Exercise real CPU separation/encoding and beat inference on synthetic audio."""
import json, pathlib, tempfile, subprocess, sys, os
import numpy as np
import soundfile as sf
from process import process
from beats import detect
with tempfile.TemporaryDirectory(prefix='woodshed-audio-test-') as td:
    root=pathlib.Path(td)
    sr=44100; duration=8
    t=np.arange(sr*duration)/sr
    audio=0.12*np.sin(2*np.pi*220*t)+0.05*np.sin(2*np.pi*660*t)
    for start in range(0,len(audio),sr//2): audio[start:start+400]+=0.3*np.hanning(400)
    original=root/'input.wav';sf.write(original,np.column_stack([audio,audio]),sr)
    job={'kind':'separate','source':{'type':'upload','value':'fixture','filename':'fixture.wav'},'localSource':str(original),'quality':{'model':'htdemucs','shifts':0,'overlap':0.25,'format':'opus','bitrate':192},'settings':{'stemMode':'full'}}
    result=process(job,root)
    assert len([f for f in result['files'] if f.get('stem')])==4
    frames=[]
    for file in result['files']:
        if not file.get('stem'): continue
        decoded=root/(file['stem']+'-decoded.wav')
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(root/file['name']),'-ar',str(sr),str(decoded)],check=True)
        samples,rate=sf.read(decoded);frames.append(len(samples))
    assert len(set(frames))==1 and frames[0]==sr*duration,frames
    print('PASS: real Demucs produced four stems; all Opus round trips preserve 352800 frames.')
    assert process(job,root)==result
    print('PASS: completed result resumes without repeating separation.')
    beats=detect(original)
    assert isinstance(beats,list) and len(beats)>0
    print(f'PASS: BeatNet inference returned {len(beats)} beats.')
