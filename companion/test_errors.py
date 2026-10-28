"""Job error codes (errors.py) and the separator's output lines (pipeline.SeparationProgress).

yt-dlp failures go through the real pipeline.run with a stand-in `yt_dlp`
module that replays the stderr recorded in companion/fixtures/ytdlp/stderr.json
(the lookup tests use the same file); ffmpeg failures are produced by the real
ffmpeg when it is installed.
"""
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

import errors
import pipeline
from errors import classify, describe, failed_tool

HERE = pathlib.Path(__file__).resolve().parent
STDERR = json.loads((HERE / 'fixtures' / 'ytdlp' / 'stderr.json').read_text(encoding='utf-8'))


def ytdlp_failure(stderr: str) -> BaseException:
    """What pipeline.run raises when yt-dlp prints `stderr` and exits 1."""
    with tempfile.TemporaryDirectory() as td:
        (pathlib.Path(td) / 'yt_dlp.py').write_text(textwrap.dedent(f'''
            import sys
            sys.stderr.write({stderr!r})
            sys.exit(1)
        '''))
        env = {**os.environ, 'PYTHONPATH': td}
        try:
            pipeline.run([sys.executable, '-m', 'yt_dlp', '--', 'https://youtu.be/x'], env=env)
        except Exception as error:  # noqa: BLE001 - the failure is the subject
            return error
    raise AssertionError('yt-dlp stand-in did not fail')


class YtDlpClassificationTests(unittest.TestCase):
    def code(self, case, source_type='url'):
        error = ytdlp_failure(STDERR[case])
        return classify(describe(error), stage='download', source_type=source_type)

    def test_failures_name_the_tool(self):
        error = ytdlp_failure(STDERR['removed'])
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(failed_tool(str(error)), 'yt-dlp')
        self.assertTrue(str(error).startswith('yt-dlp exited with code 1\n'))
        self.assertIn('Video unavailable', str(error))

    def test_bot_checks_raise_bot_checked_and_classify_as_bot_check(self):
        for case in ('bot_check', 'bot_check_search'):
            with self.subTest(case=case):
                error = ytdlp_failure(STDERR[case])
                self.assertIsInstance(error, pipeline.BotChecked)
                self.assertEqual(classify(describe(error), stage='download', source_type='search'), 'bot_check')

    def test_age_gate_is_unavailable_not_a_bot_check(self):
        error = ytdlp_failure(STDERR['age_gate'])
        self.assertNotIsInstance(error, pipeline.BotChecked)
        self.assertEqual(self.code('age_gate'), 'unavailable')
        # One rule everywhere: pipeline, errors and lookup.mjs agree.
        self.assertEqual((pipeline.BOT_CHECK.pattern, pipeline.BOT_CHECK.flags), (errors.BOT_CHECK.pattern, errors.BOT_CHECK.flags))
        lookup = (HERE / 'lookup.mjs').read_text(encoding='utf-8')
        self.assertIn(f'export const BOT_CHECK = /{errors.BOT_CHECK.pattern}/i;', lookup)

    def test_unavailable_videos(self):
        for case in ('private', 'removed', 'region', 'premiere'):
            with self.subTest(case=case):
                self.assertEqual(self.code(case), 'unavailable')

    def test_not_found(self):
        for case in ('unsupported', 'sc_404'):
            with self.subTest(case=case):
                self.assertEqual(self.code(case), 'not_found')

    def test_network_and_missing_module_are_unknown(self):
        self.assertEqual(self.code('network'), 'unknown')
        self.assertEqual(self.code('missing_module'), 'unknown')

    def test_pipeline_raise_sites(self):
        for detail in ('No audio could be downloaded.', 'Could not resolve this Spotify link.'):
            with self.subTest(detail=detail):
                self.assertEqual(classify(detail, stage='download', source_type='spotify'), 'not_found')


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is not installed')
class FfmpegClassificationTests(unittest.TestCase):
    def test_an_upload_ffmpeg_cannot_read_is_unreadable(self):
        with tempfile.TemporaryDirectory() as td:
            raw = pathlib.Path(td) / 'song.mp3'
            raw.write_bytes(bytes(range(256)) * 80)
            with self.assertRaises(RuntimeError) as caught:
                pipeline.run(['ffmpeg', '-y', '-i', str(raw), '-vn', str(pathlib.Path(td) / 'source.wav')])
        detail = describe(caught.exception)
        self.assertEqual(failed_tool(detail), 'ffmpeg')
        self.assertEqual(classify(detail, stage='download', source_type='upload'), 'unreadable')
        # The same failure on a link is not the user's file being unreadable.
        self.assertEqual(classify(detail, stage='download', source_type='url'), 'unknown')

    @unittest.skipUnless(os.path.exists('/dev/full'), 'needs /dev/full')
    def test_a_full_disk_is_disk_full_whatever_runs(self):
        with self.assertRaises(RuntimeError) as caught:
            pipeline.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'sine=d=20', '-f', 'wav', '/dev/full'])
        detail = describe(caught.exception)
        self.assertIn('No space left on device', detail)
        for stage in ('download', 'separate', 'finalize', 'detect'):
            with self.subTest(stage=stage):
                self.assertEqual(classify(detail, stage=stage, source_type='upload'), 'disk_full')


class SeparatorAndProcessorClassificationTests(unittest.TestCase):
    # Recorded from Demucs 4.0.1 / torch 2.7 failures on the reference machines.
    CUDA_OOM = textwrap.dedent('''\
        separator exited with code 1
        WOODSHED_RUNTIME {"device": "cuda", "threads": 8}
        Separating track /jobs/j1/source.wav
        torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 7.79 GiB of which 1.13 GiB is free.''')
    KILLED = 'separator exited with code -9\nSeparating track /jobs/j1/source.wav'

    def test_any_separator_failure_is_separation_failed(self):
        self.assertEqual(classify(self.CUDA_OOM, stage='separate', source_type='url'), 'separation_failed')
        self.assertEqual(classify(self.KILLED, stage=None), 'separation_failed')
        self.assertEqual(classify(describe(MemoryError()), stage='separate', source_type='upload'), 'separation_failed')

    def test_the_separator_tool_name(self):
        self.assertEqual(pipeline.tool_name(pipeline.module_command('separator')), 'separator')
        self.assertEqual(pipeline.tool_name(['/app/woodshed-processor', '--module', 'separator', '-n', 'htdemucs']), 'separator')
        self.assertEqual(pipeline.tool_name(['/app/woodshed-processor', '--module', 'yt_dlp']), 'yt-dlp')
        self.assertEqual(pipeline.tool_name([sys.executable, '-m', 'yt_dlp', '--', 'x']), 'yt-dlp')
        self.assertEqual(pipeline.tool_name(['C:\\ffmpeg\\bin\\ffmpeg.exe', '-i', 'x']), 'ffmpeg')

    def test_missing_source_files(self):
        self.assertEqual(classify('Original file is not on this computer. Add it again.', stage='download', source_type='upload'), 'source_missing')

    def test_bar_detection_not_installed(self):
        error = ModuleNotFoundError("No module named 'BeatNet'", name='BeatNet')
        self.assertEqual(describe(error), "ModuleNotFoundError: No module named 'BeatNet'")
        self.assertEqual(classify(describe(error), stage='detect'), 'beats_unavailable')
        # A missing module while splitting is not about bars.
        self.assertEqual(classify(describe(error), stage='finalize'), 'unknown')

    def test_os_disk_full(self):
        self.assertEqual(classify(describe(OSError(28, 'No space left on device')), stage='finalize'), 'disk_full')

    def test_everything_else_is_unknown(self):
        self.assertEqual(classify('Missing stem: drums', stage='finalize'), 'unknown')
        self.assertEqual(classify('', stage=None), 'unknown')

    def test_codes_are_convex_job_error_codes(self):
        source = (HERE.parent / 'convex' / 'lib' / 'errors.ts').read_text(encoding='utf-8')
        block = re.search(r'JOB_ERROR_CODES = \[(.*?)\]', source, re.S).group(1)
        convex = set(re.findall(r"'([a-z_]+)'", block))
        self.assertTrue(set(errors.CODES) <= convex, set(errors.CODES) - convex)


class SeparationOutputTests(unittest.TestCase):
    """The separator's tqdm output: first-run downloads are not passes; bags count every model."""

    def feed(self, model, shifts, lines):
        out = io.StringIO()
        progress = pipeline.SeparationProgress(model, shifts, pipeline.Reporter(out))
        for line in lines:
            progress.feed(line)
        return [json.loads(line) for line in out.getvalue().splitlines()], progress

    @staticmethod
    def bars(*percents):
        return [f'{p:3d}%|{"█" * (p // 10):<10}| {p * 2}/200 [00:01<00:01, 9.9seconds/s]' for p in percents]

    @staticmethod
    def download(signature):
        return f'Downloading: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/{signature}.th" to /models/hub/checkpoints/{signature}.th'

    def test_first_run_download_lines_are_reported_as_the_download_not_passes(self):
        events, progress = self.feed('htdemucs', 1, [
            'WOODSHED_RUNTIME {"device": "cpu", "threads": 8}',
            self.download('955717e8-8726e21a'),
            *self.bars(0, 40, 100),
            'Separating track /jobs/j1/source.wav',
            *self.bars(0, 50, 100),
        ])
        self.assertEqual(events[0], {'stage': 'separate', 'percent': 0, 'message': 'Loading model… (CPU · 8 threads)'})
        self.assertEqual(events[1], {'stage': 'separate', 'percent': 0, 'message': pipeline.DOWNLOAD_MESSAGE})
        downloading = [e for e in events if e['message'] == pipeline.DOWNLOAD_MESSAGE]
        self.assertEqual([e['percent'] for e in downloading], [0, 40, 99])
        separating = events[len(downloading) + 1:]
        self.assertEqual(separating[0], {'stage': 'separate', 'percent': 1, 'message': 'Separating stems…'})
        # The download's 0 → 100 bar did not count as a pass: the split is still pass 1 of 1.
        self.assertEqual([e['message'] for e in separating[1:]], ['Separating stems… (CPU · 8 threads, pass 1/1)'] * 3)
        self.assertEqual([round(e['percent']) for e in separating[1:]], [0, 50, 99])
        self.assertEqual(progress.done, 0)

    def test_a_bag_download_covers_every_model_file(self):
        events, _ = self.feed('htdemucs_ft', 0, [
            'WOODSHED_RUNTIME {"device": "mps", "threads": 8}',
            *[line for sig in ('f7e0c4bc-ba3fe64a', 'd12395a8-e57c48e6', '92cfc3b6-ef3bcb9c', '04573f0d-f3cf25b2')
              for line in (self.download(sig), *self.bars(0, 100))],
            'Separating track /jobs/j1/source.wav',
        ])
        percents = [e['percent'] for e in events if e['message'] == pipeline.DOWNLOAD_MESSAGE]
        self.assertEqual(percents, [0, 25, 25, 50, 50, 75, 75, 99])
        self.assertEqual(events[-1], {'stage': 'separate', 'percent': 1, 'message': 'Separating stems…'})

    def test_mdx_extra_counts_four_models(self):
        lines = ['WOODSHED_RUNTIME {"device": "cuda", "threads": 8}', 'Separating track /jobs/j1/source.wav']
        for _ in range(4):
            lines += self.bars(0, 50, 100)
        events, progress = self.feed('mdx_extra', 1, lines)
        self.assertEqual(progress.total_passes, 4)
        passes = [e for e in events if 'pass' in e['message']]
        self.assertEqual(passes[0]['message'], 'Separating stems… (NVIDIA GPU, pass 1/4)')
        self.assertEqual(passes[-1]['message'], 'Separating stems… (NVIDIA GPU, pass 4/4)')
        self.assertEqual(round(passes[3]['percent']), 25)  # the first model's full bar is a quarter
        self.assertTrue(all(e['percent'] <= 99 for e in events))
        self.assertEqual(round(passes[-1]['percent']), 99)

    def test_shifts_multiply_passes_and_single_models_stay_one(self):
        self.assertEqual(pipeline.SeparationProgress('htdemucs_ft', 2, pipeline.Reporter(io.StringIO())).total_passes, 8)
        self.assertEqual(pipeline.SeparationProgress('htdemucs_6s', 0, pipeline.Reporter(io.StringIO())).total_passes, 1)

    def test_a_cpu_fallback_restarts_the_count(self):
        events, progress = self.feed('htdemucs', 1, [
            'WOODSHED_RUNTIME {"device": "mps", "threads": 8}',
            'Separating track /jobs/j1/source.wav',
            *self.bars(0, 60),
            'WOODSHED_FALLBACK {"device": "mps", "reason": "out of memory"}',
            'WOODSHED_RUNTIME {"device": "cpu", "threads": 4}',
            'Separating track /jobs/j1/source.wav',
            *self.bars(0, 30),
        ])
        self.assertIn({'stage': 'separate', 'percent': 0, 'message': 'GPU unavailable; continuing on CPU…'}, events)
        self.assertEqual(events[-1]['message'], 'Separating stems… (CPU · 4 threads, pass 1/1)')
        self.assertEqual(progress.runtime['fallbacks'], [{'device': 'mps', 'reason': 'out of memory'}])


class ReporterTests(unittest.TestCase):
    def test_repeats_are_dropped_but_message_changes_at_the_same_percent_are_not(self):
        out = io.StringIO()
        rep = pipeline.Reporter(out)
        rep.progress('separate', 0, 'Loading model…')
        rep.progress('separate', 0.4, 'Loading model…')
        rep.progress('separate', 0, 'GPU unavailable; continuing on CPU…')
        lines = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([e['message'] for e in lines], ['Loading model…', 'GPU unavailable; continuing on CPU…'])
        self.assertEqual(rep.stage, 'separate')

    def test_meta_keeps_only_usable_fields(self):
        out = io.StringIO()
        pipeline.Reporter(out).meta({'title': ' Harbor Lights ', 'artist': '', 'uploader': 'Ada Moreno', 'duration': 221,
                                     'thumbnail': 'http://insecure.example/x.jpg', 'provider': 'Youtube', 'cover': '/tmp/cover.jpg'})
        self.assertEqual(json.loads(out.getvalue()), {'meta': {'title': 'Harbor Lights', 'uploader': 'Ada Moreno', 'provider': 'Youtube', 'duration': 221}})
        silent = io.StringIO()
        pipeline.Reporter(silent).meta({'title': '', 'duration': 0})
        self.assertEqual(silent.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
