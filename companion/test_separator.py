import json
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from separator import select_device, thread_count, run_with_fallback
import pipeline


def torch_with(cuda=False, mps=False):
    return SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: cuda),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps)),
    )


class RuntimeTests(unittest.TestCase):
    def test_device_selection_and_explicit_cpu(self):
        self.assertEqual(select_device(torch_with(cuda=True, mps=True)), 'cuda')
        self.assertEqual(select_device(torch_with(mps=True)), 'mps')
        self.assertEqual(select_device(torch_with()), 'cpu')
        self.assertEqual(select_device(torch_with(cuda=True), 'cpu'), 'cpu')
        with self.assertRaises(ValueError): select_device(torch_with(), 'typo')

    def test_thread_budget_and_operator_overrides(self):
        self.assertEqual(thread_count(8, {}), 8)
        self.assertEqual(thread_count(2, {}), 2)
        self.assertEqual(thread_count(32, {}), 16)
        self.assertEqual(thread_count(8, {'OMP_NUM_THREADS': '3'}), 3)
        self.assertEqual(thread_count(8, {'OMP_NUM_THREADS': '3', 'MKL_NUM_THREADS': '2'}), 2)
        self.assertEqual(thread_count(8, {'WOODSHED_CPU_THREADS': '12', 'MKL_NUM_THREADS': '2'}), 12)
        with self.assertRaises(ValueError): thread_count(8, {'WOODSHED_CPU_THREADS': '0'})

    def test_accelerator_failure_retries_once_on_cpu(self):
        calls, failures = [], []
        def run(device):
            calls.append(device)
            if device != 'cpu': raise RuntimeError('MPS backend out of memory')
            return 'complete'
        result = run_with_fallback(run, 'mps', lambda *args: failures.append(args))
        self.assertEqual(result, 'complete')
        self.assertEqual(calls, ['mps', 'cpu'])
        self.assertEqual(len(failures), 1)

    def test_file_errors_and_cpu_failures_are_not_retried(self):
        for device, message in [('cuda', 'Unable to open output file'), ('cpu', 'out of memory')]:
            calls = []
            def run(selected):
                calls.append(selected)
                raise RuntimeError(message)
            with self.assertRaisesRegex(RuntimeError, message):
                run_with_fallback(run, device, lambda *_: self.fail('Unexpected retry'))
            self.assertEqual(calls, [device])

    def test_pipeline_preserves_quality_and_records_actual_backend(self):
        quality = {'model': 'htdemucs_ft', 'shifts': 2, 'overlap': .25}
        def run(args, on_line):
            self.assertEqual(args[args.index('-n') + 1], 'htdemucs_ft')
            self.assertEqual(args[args.index('--shifts') + 1], '2')
            self.assertIn('--two-stems=drums', args)
            for line in [
                'WOODSHED_RUNTIME {"device":"mps","threads":8}',
                '50%|',
                'WOODSHED_FALLBACK {"device":"mps","reason":"out of memory"}',
                'WOODSHED_RUNTIME {"device":"cpu","threads":8}',
                'WOODSHED_TIMING {"device":"cpu","seconds":12.5}',
            ]: on_line(line)
        with tempfile.TemporaryDirectory() as td, patch.object(pipeline, 'run', run):
            root = pathlib.Path(td)
            pipeline.separate(root / 'source.wav', root / 'separated', quality, 'drums', pipeline.Reporter())
            info = json.loads((root / 'separation-runtime.json').read_text())
            self.assertEqual(info['device'], 'cpu')
            self.assertEqual(info['seconds'], 12.5)
            self.assertEqual(len(info['fallbacks']), 1)
        self.assertEqual(quality, {'model': 'htdemucs_ft', 'shifts': 2, 'overlap': .25})

    def test_source_wrapper_is_resolved_independently_of_working_directory(self):
        command = pipeline.module_command('separator')
        self.assertTrue(pathlib.Path(command[-1]).is_absolute())
        self.assertTrue(pathlib.Path(command[-1]).is_file())


if __name__ == '__main__':
    unittest.main()
