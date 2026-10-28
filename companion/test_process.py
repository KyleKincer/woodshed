"""process.py: job kinds (beats, sections, separate), resume, meta and the error line."""
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import process

HAS_FFMPEG = bool(shutil.which('ffmpeg') and shutil.which('ffprobe'))


def tone(path: pathlib.Path, seconds=2, rate=44100, channels=2):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency=220:duration={seconds}:sample_rate={rate}',
                    '-ac', str(channels), '-f', 'wav', str(path)], check=True)


def stream_of(path: pathlib.Path) -> dict:
    out = subprocess.check_output(['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams', str(path)], text=True)
    return json.loads(out)['streams'][0]


def lines(out: io.StringIO):
    return [json.loads(line) for line in out.getvalue().splitlines()]


def beats_module(detect):
    module = types.ModuleType('beats')
    module.detect = detect
    return module


def sections_module(suggest):
    module = types.ModuleType('sections')
    module.suggest = suggest
    return module


class Workspace(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.root = pathlib.Path(self._td.name) / 'jobs' / 'j2'
        self.root.mkdir(parents=True)
        self.out = io.StringIO()

    def run_main(self, job):
        (self.root / 'job.json').write_text(json.dumps(job))
        return process.main(['process.py', str(self.root)], out=self.out)


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg is not installed')
class DetectionTests(Workspace):
    BEATS = [[0.5, 1], [1.0, 2], [1.5, 3], [2.0, 4], [2.5, 1], [3.0, 2]]

    def test_a_chained_beats_job_resamples_the_local_mix(self):
        source = pathlib.Path(self._td.name) / 'jobs' / 'j1' / 'source.wav'
        source.parent.mkdir(parents=True)
        tone(source)
        seen = []
        detect = lambda mix: seen.append(stream_of(mix)) or self.BEATS
        with patch.dict(sys.modules, {'beats': beats_module(detect)}):
            code = self.run_main({'kind': 'beats', 'localMix': str(source), 'chainedFrom': 'j1', 'settings': {}})
        self.assertEqual(code, 0)
        self.assertEqual(seen[0]['sample_rate'], '22050')
        self.assertEqual(seen[0]['channels'], 1)
        events = lines(self.out)
        self.assertEqual([(e['percent'], e['message']) for e in events if 'stage' in e],
                         [(20, 'Building a mix locally…'), (50, 'Finding bars…'), (95, 'Saving bars…')])
        self.assertEqual(events[-1], {'complete': True})
        result = json.loads((self.root / 'result.json').read_text())
        self.assertEqual(result, {'beats': self.BEATS})

    def test_without_a_local_mix_the_downloaded_stems_are_mixed(self):
        stems = []
        for i in range(2):
            stems.append(self.root / f'input-{i}.audio')
            tone(stems[-1], channels=1)
        seen = []
        with patch.dict(sys.modules, {'beats': beats_module(lambda mix: seen.append(stream_of(mix)) or self.BEATS)}):
            # A localMix that is not on disk falls back to the stems.
            code = self.run_main({'kind': 'beats', 'localMix': str(self.root / 'missing.wav'), 'localStems': [str(p) for p in stems], 'settings': {}})
        self.assertEqual(code, 0)
        self.assertEqual((seen[0]['sample_rate'], seen[0]['channels']), ('22050', 1))

    def test_sections_ride_on_a_beats_job_when_asked(self):
        source = self.root / 'source.wav'
        tone(source)
        calls = []

        def suggest(audio, rate, downbeats, *, duration):
            calls.append((audio, rate, downbeats, duration))
            return [{'t0': 0.5, 'label': 'Verse', 'confidence': 0.8}, {'t0': 'bad'}, {'t0': 2.5, 'label': 'Chorus', 'confidence': 1.7, 'extra': 1}]

        with patch.dict(sys.modules, {'beats': beats_module(lambda mix: self.BEATS), 'sections': sections_module(suggest)}), \
                patch.object(process, 'load_audio', lambda path: ('samples', 22050)):
            self.run_main({'kind': 'beats', 'localMix': str(source), 'settings': {'sections': True}, 'song': {'duration': 201.5}})
        self.assertEqual(calls, [('samples', 22050, [0.5, 2.5], 201.5)])
        result = json.loads((self.root / 'result.json').read_text())
        self.assertEqual(result['sections'], [{'t0': 0.5, 'label': 'Verse', 'confidence': 0.8}, {'t0': 2.5, 'label': 'Chorus', 'confidence': 1.0}])

    def test_until_sections_exists_a_beats_job_reports_no_sections(self):
        source = self.root / 'source.wav'
        tone(source)
        with patch.dict(sys.modules, {'beats': beats_module(lambda mix: self.BEATS)}), \
                patch.object(process, 'section_suggester', lambda: None):
            self.run_main({'kind': 'beats', 'localMix': str(source), 'settings': {'sections': True}})
        self.assertEqual(json.loads((self.root / 'result.json').read_text()), {'beats': self.BEATS, 'sections': []})

    def test_a_failing_suggester_never_costs_the_bars(self):
        source = self.root / 'source.wav'
        tone(source)

        def suggest(*args, **kwargs):
            raise ValueError('too short')

        stderr = io.StringIO()
        with patch.dict(sys.modules, {'beats': beats_module(lambda mix: self.BEATS), 'sections': sections_module(suggest)}), \
                patch.object(process, 'load_audio', lambda path: ('samples', 22050)), patch.object(sys, 'stderr', stderr):
            code = self.run_main({'kind': 'beats', 'localMix': str(source), 'settings': {'sections': True}})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads((self.root / 'result.json').read_text())['sections'], [])
        self.assertIn('Section suggestions unavailable: ValueError: too short', stderr.getvalue())

    def test_a_sections_job_uses_the_claimed_downbeats(self):
        source = self.root / 'source.wav'
        tone(source)
        calls = []
        suggest = lambda audio, rate, downbeats, *, duration: calls.append((downbeats, duration)) or [{'t0': 4, 'label': 'Part A', 'confidence': 0.4}]
        with patch.dict(sys.modules, {'sections': sections_module(suggest)}), patch.object(process, 'load_audio', lambda path: ('samples', 22050)):
            code = self.run_main({'kind': 'sections', 'localMix': str(source), 'downbeats': [0, 2, 4, 6], 'song': {'duration': 8}})
        self.assertEqual(code, 0)
        self.assertEqual(calls, [([0.0, 2.0, 4.0, 6.0], 8.0)])
        self.assertEqual(json.loads((self.root / 'result.json').read_text()), {'sections': [{'t0': 4.0, 'label': 'Part A', 'confidence': 0.4}]})

    def test_a_sections_job_without_the_module_reports_none(self):
        source = self.root / 'source.wav'
        tone(source)
        with patch.object(process, 'section_suggester', lambda: None):
            self.assertEqual(self.run_main({'kind': 'sections', 'localMix': str(source), 'downbeats': [0, 2]}), 0)
        self.assertEqual(json.loads((self.root / 'result.json').read_text()), {'sections': []})

    def test_bar_detection_not_installed_reports_beats_unavailable(self):
        source = self.root / 'source.wav'
        tone(source)

        def detect(mix):
            raise ModuleNotFoundError("No module named 'BeatNet'", name='BeatNet')

        with patch.dict(sys.modules, {'beats': beats_module(detect)}):
            code = self.run_main({'kind': 'beats', 'localMix': str(source), 'settings': {}})
        self.assertEqual(code, 1)
        self.assertEqual(lines(self.out)[-1], {'error': "ModuleNotFoundError: No module named 'BeatNet'", 'code': 'beats_unavailable'})
        self.assertFalse((self.root / 'result.json').exists())


class SuggesterImportTests(unittest.TestCase):
    def test_only_a_missing_sections_module_means_not_built(self):
        with patch.dict(sys.modules, {'sections': None}):
            # `None` in sys.modules makes `import sections` raise ModuleNotFoundError(name='sections').
            self.assertIsNone(process.section_suggester())
        real_import = __import__

        def broken(name, *args, **kwargs):
            if name == 'sections':
                raise ModuleNotFoundError("No module named 'librosa'", name='librosa')
            return real_import(name, *args, **kwargs)

        # A sections module that is there but cannot load is a real failure.
        with patch('builtins.__import__', broken), self.assertRaises(ModuleNotFoundError):
            process.section_suggester()


class SeparationJobTests(Workspace):
    def job(self, **extra):
        return {'kind': 'separate', 'source': {'type': 'search', 'value': 'harbor lights'}, 'settings': {'stemMode': 'full'},
                'quality': {'model': 'htdemucs', 'shifts': 1, 'overlap': 0.25, 'bitrate': 192}, **extra}

    def fakes(self, modes):
        root = self.root

        def acquire(job, tmp, rep):
            rep.progress('download', 100, 'Ready')
            wav = tmp / 'dl.wav'
            wav.write_bytes(b'RIFF')
            return wav, {'title': 'Harbor Lights', 'artist': 'Ada Moreno', 'uploader': 'Ada Moreno - Topic', 'album': '', 'duration': 221,
                         'cover': None, 'thumbnail': 'https://i.ytimg.com/vi/x/maxresdefault.jpg', 'provider': 'Youtube',
                         'resolvedUrl': 'https://www.youtube.com/watch?v=x'}

        def expected(mode, model):
            modes.append(mode)
            return ['drums', 'bass', 'other', 'vocals']

        def separate(wav, out, quality, mode, rep):
            folder = out / quality['model'] / wav.stem
            folder.mkdir(parents=True)
            for name in ['drums', 'bass', 'other', 'vocals']:
                (folder / f'{name}.wav').write_bytes(b'RIFF')

        def encode(src, dest, quality):
            dest.write_bytes(b'webm')

        return [patch.object(process, 'acquire', acquire), patch.object(process, 'expected_stems', expected),
                patch.object(process, 'separate', separate), patch.object(process, 'encode', encode),
                patch.object(process, 'fingerprint', lambda wav: None),
                patch.dict(sys.modules, {'separator': types.SimpleNamespace(cpu_budget=lambda: 2)})]

    def test_meta_is_emitted_after_acquisition_and_the_result_carries_where_it_landed(self):
        modes = []
        patches = self.fakes(modes)
        for p in patches: p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])
        self.assertEqual(self.run_main(self.job(settings={'stemMode': 'six'}, quality={'model': 'htdemucs_6s', 'shifts': 1})), 0)
        events = lines(self.out)
        metas = [e for e in events if 'meta' in e]
        self.assertEqual(metas, [{'meta': {'title': 'Harbor Lights', 'artist': 'Ada Moreno', 'uploader': 'Ada Moreno - Topic', 'provider': 'Youtube',
                                           'duration': 221, 'thumbnail': 'https://i.ytimg.com/vi/x/maxresdefault.jpg'}}])
        # The meta line follows acquisition and precedes the split.
        self.assertLess(events.index({'stage': 'download', 'percent': 100, 'message': 'Ready'}), events.index(metas[0]))
        result = json.loads((self.root / 'result.json').read_text())
        self.assertEqual(result['resolvedUrl'], 'https://www.youtube.com/watch?v=x')
        self.assertEqual(result['provider'], 'Youtube')
        self.assertEqual(result['quality']['format'], 'opus')
        # `six` never reaches expected_stems.
        self.assertEqual(modes, ['full'])
        self.assertEqual(result['stemMode'], 'full')

    def test_a_resumed_job_reuses_its_source_and_still_reports_meta(self):
        modes = []
        patches = self.fakes(modes)
        for p in patches: p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])
        (self.root / 'source.wav').write_bytes(b'RIFF')
        (self.root / 'source-meta.json').write_text(json.dumps({'title': 'Saved', 'duration': 100, 'fingerprint': None}))
        with patch.object(process, 'acquire', side_effect=AssertionError('acquired again')):
            self.assertEqual(self.run_main(self.job()), 0)
        self.assertIn({'meta': {'title': 'Saved', 'duration': 100}}, lines(self.out))

    def test_a_finished_job_returns_its_result(self):
        (self.root / 'result.json').write_text(json.dumps({'beats': [[1, 1]]}))
        with patch.object(process, 'detect_beats', side_effect=AssertionError('ran again')):
            self.assertEqual(self.run_main({'kind': 'beats'}), 0)
        self.assertEqual(lines(self.out), [{'complete': True}])

    def test_a_missing_upload_reports_source_missing(self):
        code = self.run_main(self.job(source={'type': 'upload', 'value': 'abc', 'filename': 'song.mp3'},
                                      localSource=str(self.root / 'gone')))
        self.assertEqual(code, 1)
        last = lines(self.out)[-1]
        self.assertEqual(last['code'], 'source_missing')
        self.assertIn('Original file is not on this computer', last['error'])


if __name__ == '__main__':
    unittest.main()
