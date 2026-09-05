"""Frozen processing executable: job runner plus its isolated CLI subprocesses."""
import multiprocessing
import sys
import runpy

if __name__ == '__main__':
    multiprocessing.freeze_support()
    if sys.argv[1:2] == ['--module']:
        module = sys.argv[2]
        if module not in ('demucs.separate', 'yt_dlp'):
            raise SystemExit('Unsupported processing module')
        sys.argv = [module, *sys.argv[3:]]
        runpy.run_module(module, run_name='__main__')
    elif sys.argv[1:2] == ['--self-check']:
        import torch, torchaudio, demucs, yt_dlp, soundfile, librosa
        from beats import detect
        print('Woodshed processing runtime ready', flush=True)
    else:
        runpy.run_module('process', run_name='__main__')
