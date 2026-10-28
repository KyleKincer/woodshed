"""Frozen processing executable: job runner plus its isolated CLI subprocesses."""
import multiprocessing
import sys
import runpy


def self_check():
    """Run by scripts/build-processor.py after PyInstaller: a build that is missing
    a module or bundled data fails there, not on a user's first job."""
    # pipeline first: it loads the shared yt-dlp arguments at import and only
    # warns when ytdlp-args.json was not bundled, so the check makes that fatal.
    import pipeline
    if pipeline.ytdlp_args_file() is None:
        raise SystemExit('Processor self-check failed: ytdlp-args.json is not bundled '
                         '(scripts/build-processor.py must --add-data companion/ytdlp-args.json).')
    import torch, torchaudio, demucs, yt_dlp, soundfile, librosa
    from beats import detect
    print('Woodshed processing runtime ready', flush=True)


if __name__ == '__main__':
    multiprocessing.freeze_support()
    if sys.argv[1:2] == ['--module']:
        module = sys.argv[2]
        if module not in ('separator', 'gpu_runtime', 'demucs.separate', 'yt_dlp'):
            raise SystemExit('Unsupported processing module')
        sys.argv = [module, *sys.argv[3:]]
        runpy.run_module(module, run_name='__main__')
    elif sys.argv[1:2] == ['--self-check']:
        self_check()
    else:
        runpy.run_module('process', run_name='__main__')
