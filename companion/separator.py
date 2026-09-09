"""Hardware-aware entry point for the pinned Demucs CLI.

Keep Demucs' models, normalization, overlap-add and WAV output unchanged. This
module only chooses execution resources; an accelerator failure retries on CPU.
"""
from __future__ import annotations

import gc
import json
import os
import pathlib
import subprocess
import sys
import time

# Must precede the first torch import, including imports from Demucs.
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')


def cpu_budget():
    import psutil
    physical = psutil.cpu_count(logical=False) or os.cpu_count() or 1
    if sys.platform == 'darwin':
        # Apple efficiency cores can make synchronous tensor operations slower.
        try:
            physical = int(subprocess.check_output(
                ['sysctl', '-n', 'hw.perflevel0.physicalcpu'], text=True,
                stderr=subprocess.DEVNULL, timeout=2))
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    try:
        physical = min(physical, len(psutil.Process().cpu_affinity()))
    except (AttributeError, OSError, psutil.Error):
        pass
    # Respect container quotas as well as affinity during source/CI runs.
    try:
        quota, period = pathlib.Path('/sys/fs/cgroup/cpu.max').read_text().split()
        if quota != 'max':
            physical = min(physical, max(1, int(quota) // int(period)))
    except (OSError, ValueError):
        pass
    return max(1, physical)


def thread_count(budget, environ=None):
    env = os.environ if environ is None else environ
    for key in ('WOODSHED_CPU_THREADS', 'MKL_NUM_THREADS', 'OMP_NUM_THREADS'):
        if env.get(key):
            try:
                value = int(env[key])
            except ValueError:
                raise ValueError(f'{key} must be a positive integer') from None
            if value < 1:
                raise ValueError(f'{key} must be a positive integer')
            return min(value, 64)
    # Avoid oversubscribing SMT threads or very large workstation CPUs. The
    # override above remains available for machine-specific benchmark results.
    return min(budget, 16)


def select_device(torch, requested='auto'):
    if requested not in ('auto', 'cpu', 'cuda', 'mps'):
        raise ValueError('WOODSHED_DEVICE must be auto, cpu, cuda, or mps')
    if requested != 'auto':
        return requested
    if torch.cuda.is_available():
        return 'cuda'
    if torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


def accelerator_failure(error, device):
    if device == 'cpu':
        return False
    if isinstance(error, NotImplementedError):
        return True
    message = str(error).lower()
    return any(term in message for term in (
        'cuda', 'cudnn', 'cublas', 'cufft', 'mps', 'metal',
        'out of memory', 'not implemented for', 'not compiled with',
        'not linked with', 'same device',
    ))


def run_with_fallback(run, device, on_fallback):
    try:
        return run(device)
    except (RuntimeError, NotImplementedError) as error:
        if not accelerator_failure(error, device):
            raise
        # Leave the exception scope first so its traceback cannot retain GPU
        # tensors throughout the CPU retry.
        reason = str(error)
    on_fallback(device, reason)
    return run('cpu')


def main(argv=None):
    import torch
    import demucs.separate

    argv = list(sys.argv[1:] if argv is None else argv)
    threads = thread_count(cpu_budget())
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    device = select_device(torch, os.environ.get('WOODSHED_DEVICE', 'auto'))
    if device == 'cuda':
        # Convolution shapes repeat across song chunks. Keep FP32 math and the
        # selected model quality; only cache the best cuDNN implementation.
        torch.backends.cudnn.benchmark = True
        torch.backends.cudnn.allow_tf32 = False
        torch.backends.cuda.matmul.allow_tf32 = False

    def execute(selected):
        print('WOODSHED_RUNTIME ' + json.dumps({
            'device': selected, 'threads': threads,
            'torch': torch.__version__, 'cuda': torch.version.cuda,
        }), flush=True)
        start = time.perf_counter()
        with torch.inference_mode():
            demucs.separate.main([*argv, '--device', selected])
        print('WOODSHED_TIMING ' + json.dumps({
            'device': selected, 'seconds': round(time.perf_counter() - start, 3),
        }), flush=True)

    def fallback(selected, reason):
        print('WOODSHED_FALLBACK ' + json.dumps({
            'device': selected, 'reason': reason[:1000],
        }), flush=True)
        gc.collect()
        try:
            if selected == 'cuda':
                torch.cuda.empty_cache()
            elif selected == 'mps':
                torch.mps.empty_cache()
        except RuntimeError:
            pass

    run_with_fallback(execute, device, fallback)


if __name__ == '__main__':
    main()
