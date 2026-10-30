"""sections.py (B7, D47): section suggestions from bar-synchronous features.

Run with the other companion tests:  python -m unittest discover -s companion -p 'test_*.py'

The bar grid, the structure stage, boundaries, names, confidence and the
recorded-fixture checks need only numpy. The audio tests (feature extraction on
synthetic recordings, runtime) and the checks that the numpy matrices equal
librosa's and scipy's need the processor's runtime (librosa, scipy) and are
skipped without it.

Recorded fixtures (companion/fixtures/sections/*.npz) hold the bar features
`sections.bar_features` computes for three real recordings with hand-annotated
structure: songs 1–3 of the Sargon set in msaf-data
(https://github.com/urinieto/msaf-data, Sargon/, annotations by Oriol Nieto).
Only features are kept, never audio. The downbeats come from librosa's beat
tracker grouped in fours (the beat with the strongest low-frequency onsets
starts the bar), standing in for BeatNet, which needs torch. Rebuild them with

    python companion/test_sections.py --build-fixtures <msaf-data>/Sargon
"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

if importlib.util.find_spec('numpy') is None:
    # The release workflow runs these before the processor's requirements are installed.
    raise unittest.SkipTest('numpy is not installed (the processor runtime: pip install -r companion/requirements.txt)')

import numpy as np

import sections
from sections import bar_grid, kmeans, merge_segments, name_segments, runs, suggest, suggest_from_features

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE / 'fixtures' / 'sections'
HAS_LIBROSA = importlib.util.find_spec('librosa') is not None
HAS_SCIPY = importlib.util.find_spec('scipy') is not None
NEEDS_LIBROSA = 'librosa is not installed (the processor runtime: pip install -r companion/requirements.txt)'

RATE = 22050
BAR = 2.0  # 120 bpm in 4/4
NAMES = {'Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'}


def downbeats(bars, bar=BAR, start=0.0):
    return [start + i * bar for i in range(bars)]


def boundaries(result):
    """Suggested section starts after the first, in seconds."""
    return [s['t0'] for s in result[1:]]


def assert_near_bars(case, found, expected, bar=BAR):
    """Every expected boundary is found within ±1 bar, and nothing else is."""
    case.assertEqual(len(found), len(expected), f'boundaries {found}, expected {expected}')
    for got, want in zip(found, expected):
        case.assertLessEqual(abs(got - want), bar + 1e-6, f'boundary {got} s is not within a bar of {want} s')


# ---- Synthetic material ---------------------------------------------------------------------------

#: The A-B-A-B-C-B form, eight bars a section; B is the loud one.
FORM = [('A', 8), ('B', 8), ('A', 8), ('B', 8), ('C', 8), ('B', 8)]
FORM_BOUNDARIES = [8 * BAR, 16 * BAR, 24 * BAR, 32 * BAR, 40 * BAR]
FORM_LABELS = ['Verse', 'Chorus', 'Verse', 'Chorus', 'Bridge', 'Chorus']


def synthetic_features(form, seed=0, noise=0.35):
    """(chroma, mfcc, rms, starts, ends): one prototype per section letter plus per-bar noise."""
    rng = np.random.RandomState(seed)
    letters = sorted({letter for letter, _ in form})
    proto_rng = np.random.RandomState(1234)
    chroma_proto = {k: proto_rng.rand(12) for k in letters}
    mfcc_proto = {k: proto_rng.randn(13) * 3 for k in letters}
    loud = {k: 0.1 + 0.05 * i for i, k in enumerate(letters)}
    loud['B'] = loud.get('B', 0) + 0.3
    chroma, mfcc, rms = [], [], []
    for letter, bars in form:
        for _ in range(bars):
            chroma.append(chroma_proto[letter] + noise * rng.rand(12) * 0.5)
            mfcc.append(mfcc_proto[letter] + noise * rng.randn(13))
            rms.append(loud[letter] * (1 + 0.05 * rng.randn()))
    n = len(rms)
    starts = np.arange(n) * BAR
    return np.array(chroma).T, np.array(mfcc).T, np.array(rms), starts, starts + BAR


def with_silence(form_features, silent_bars, after):
    """Bar features with a run of identical (digitally silent) bars and then `after` appended."""
    chroma, mfcc, rms, _, _ = form_features
    tail = synthetic_features(after, seed=9)
    floor = np.full(mfcc.shape[0], -40.0)  # every silent bar has the same timbre: the floor
    chroma = np.concatenate([chroma, np.zeros((12, silent_bars)), tail[0]], axis=1)
    mfcc = np.concatenate([mfcc, np.repeat(floor[:, None], silent_bars, axis=1), tail[1]], axis=1)
    rms = np.concatenate([rms, np.zeros(silent_bars), tail[2]])
    starts = np.arange(rms.size) * BAR
    return chroma, mfcc, rms, starts, starts + BAR


def _chord(freqs, t, harmonics=1):
    out = np.zeros_like(t)
    for f in freqs:
        for h in range(1, harmonics + 1):
            out += np.sin(2 * np.pi * f * h * t) / h
    return out / len(freqs)


def _bursts(rng, seconds, rate, beats_at, length, gain, smooth=1):
    """Noise bursts with a fast decay at each beat time (seconds within the bar)."""
    out = np.zeros(int(seconds * rate))
    n = int(length * rate)
    env = np.exp(-np.linspace(0, 8, n))
    for b in beats_at:
        i = int(b * rate)
        burst = rng.randn(n)
        if smooth > 1:
            burst = np.convolve(burst, np.ones(smooth) / smooth, mode='same')
        out[i:i + n] += gain * env * burst[: max(0, min(n, out.size - i))]
    return out


def synthetic_audio(form, seed=0, rate=RATE, bar=BAR):
    """A recording of `form` built from tones and noise bursts, one timbre per section letter:

    - A: a soft C major triad of pure tones with a closed hi-hat (short bright bursts) on every beat;
    - B: a loud bright F major triad (rich harmonics) with snare-like noise bursts on beats 2 and 4;
    - C: a low D drone with a minor third and a steady wash of dark noise;
    - any other letter: a tone cluster of its own.
    """
    rng = np.random.RandomState(seed)
    beat = bar / 4
    t = np.arange(int(bar * rate)) / rate
    pieces = []
    for letter, bars in form:
        for _ in range(bars):
            if letter == 'A':
                y = 0.25 * _chord([261.63, 329.63, 392.0], t) + _bursts(rng, bar, rate, [0, beat, 2 * beat, 3 * beat], 0.04, 0.08)
            elif letter == 'B':
                y = 0.5 * _chord([349.23, 440.0, 523.25], t, harmonics=6) + _bursts(rng, bar, rate, [beat, 3 * beat], 0.15, 0.5, smooth=3)
            elif letter == 'C':
                y = 0.35 * _chord([73.42, 87.31, 146.83], t, harmonics=3) + 0.06 * np.convolve(rng.randn(t.size), np.ones(32) / 32, mode='same')
            else:
                base = 110.0 * 2 ** ((ord(letter) - ord('A')) / 12)
                y = 0.3 * _chord([base, base * 1.5, base * 2.25], t, harmonics=2)
            pieces.append(y)
    return np.concatenate(pieces).astype(np.float32)


# ---- Bars ----------------------------------------------------------------------------------------

class BarGridTests(unittest.TestCase):
    def test_downbeats_are_sorted_deduplicated_and_kept_inside_the_song(self):
        starts, ends = bar_grid([4.0, 0.0, 2.0, 2.0, -1.0, float('nan'), 6.0, 9.5], 8.0)
        self.assertEqual(starts.tolist(), [0.0, 2.0, 4.0, 6.0])
        self.assertEqual(ends.tolist(), [2.0, 4.0, 6.0, 8.0])

    def test_the_last_bar_is_no_longer_than_the_median_bar(self):
        starts, ends = bar_grid(np.array([0.0, 2.0, 4.0]), 30.0)
        self.assertEqual(ends.tolist(), [2.0, 4.0, 6.0])

    def test_no_downbeats(self):
        for value in (None, [], np.array([])):
            starts, ends = bar_grid(value, 10.0)
            self.assertEqual((starts.size, ends.size), (0, 0))


class TooShortTests(unittest.TestCase):
    """Fewer than 16 bars, or nothing to listen to: no suggestion (and no feature work)."""

    def test_fewer_than_16_bars_returns_nothing(self):
        audio = np.zeros(int(40 * RATE), dtype=np.float32)
        self.assertEqual(suggest(audio, RATE, downbeats(15), duration=40.0), [])
        chroma, mfcc, rms, starts, ends = synthetic_features([('A', 8), ('B', 7)])
        self.assertEqual(suggest_from_features(chroma, mfcc, rms, starts, ends), [])

    def test_downbeats_past_the_end_do_not_count(self):
        audio = np.zeros(int(20 * RATE), dtype=np.float32)
        # 30 downbeats, but only 10 bars fit in the 20 s song.
        self.assertEqual(suggest(audio, RATE, downbeats(30), duration=60.0), [])

    def test_empty_input_returns_nothing(self):
        self.assertEqual(suggest(np.zeros(0, dtype=np.float32), RATE, downbeats(32), duration=64.0), [])
        self.assertEqual(suggest([], RATE, [], duration=0), [])
        self.assertEqual(suggest(np.zeros(RATE, dtype=np.float32), 0, downbeats(32), duration=64.0), [])

    def test_a_single_segment_is_no_structure(self):
        # The structure stage finding one part is what every input without structure comes to
        # (NoStructureTests); here it is forced.
        chroma, mfcc, rms, starts, ends = synthetic_features(FORM)
        one_cluster = lambda features, mfcc: (np.zeros(features.shape[0], dtype=int), np.ones((features.shape[0], 3)))
        with patch.object(sections, 'segment', one_cluster):
            self.assertEqual(suggest_from_features(chroma, mfcc, rms, starts, ends), [])


# ---- Structure (numpy only) ------------------------------------------------------------------------

class NoStructureTests(unittest.TestCase):
    """Input without parts gets no suggestion, rather than invented sections."""

    def test_identical_bars_give_nothing(self):
        starts = np.arange(60) * BAR
        self.assertEqual(suggest_from_features(np.zeros((12, 60)), np.zeros((13, 60)), np.zeros(60), starts, starts + BAR), [])
        self.assertEqual(suggest_from_features(np.ones((12, 60)), np.full((13, 60), -40.0), np.full(60, .2), starts, starts + BAR), [])

    def test_one_section_throughout_gives_nothing(self):
        for seed in range(5):
            for letter in 'ABC':
                with self.subTest(seed=seed, letter=letter):
                    self.assertEqual(suggest_from_features(*synthetic_features([(letter, 48)], seed=seed)), [])

    def test_songs_with_parts_are_far_from_the_threshold(self):
        """The Fiedler value of every structured input here stays under half MAX_FIEDLER."""
        def fiedler(chroma, mfcc, *_):
            features = sections.stack_features(chroma, mfcc)
            rec = sections.lag_median_filter(sections.recurrence_affinity(features), sections.LAG_FILTER_BARS)
            graph = sections.balance(0.5 * (rec + rec.T), sections.sequence_affinity(sections._zblock(mfcc).T))
            return float(np.linalg.eigvalsh(sections.normalized_laplacian(graph))[1])
        structured = [synthetic_features(FORM, seed=s, noise=n) for s in range(3) for n in (0.35, 0.8)]
        structured += [with_silence(synthetic_features(FORM), 40, FORM[:2])]
        for path in fixture_paths():
            with np.load(path) as d:
                structured.append((d['chroma'], d['mfcc']))
        for features in structured:
            self.assertLess(fiedler(*features), sections.MAX_FIEDLER / 2)
        for seed in range(3):
            self.assertGreater(fiedler(*synthetic_features([('A', 48)], seed=seed)), sections.MAX_FIEDLER * 1.5)

    def test_a_run_of_identical_bars_is_one_section(self):
        """Digital silence between a song and a hidden track: the song keeps its sections, the
        silence is one section, however long."""
        for silent in (30, 60, 100):
            with self.subTest(silent=silent):
                features = with_silence(synthetic_features(FORM), silent, FORM[:2])
                result = suggest_from_features(*features)
                end = 48 * BAR
                assert_near_bars(self, boundaries(result), FORM_BOUNDARIES + [end, end + silent * BAR, end + (silent + 8) * BAR])
                self.assertEqual([s['label'] for s in result], FORM_LABELS + ['Part A', 'Verse', 'Chorus'])

    def test_identical_bars_link_along_their_run(self):
        """Every bar of a run of identical bars keeps recurrence links (ties do not all go to
        the run's first bars), and their sequence links stay strong while the edges of the
        run stay weak."""
        features = with_silence(synthetic_features(FORM), 60, FORM[:2])
        stacked = sections.stack_features(features[0], features[1])
        degree = (sections.recurrence_affinity(stacked) > 0).sum(axis=1)
        self.assertTrue((degree[48:108] > 0).all(), degree[48:108].tolist())
        seq = sections.sequence_affinity(sections._zblock(features[1]).T)
        self.assertAlmostEqual(seq[60, 61], 1.0)
        self.assertLess(seq[47, 48], 0.01)  # music → silence
        self.assertLess(seq[107, 108], 0.01)  # silence → music



class StructureTests(unittest.TestCase):
    def test_the_synthetic_form_gives_its_boundaries_and_names(self):
        for seed in range(5):
            with self.subTest(seed=seed):
                result = suggest_from_features(*synthetic_features(FORM, seed=seed))
                assert_near_bars(self, boundaries(result), FORM_BOUNDARIES)
                self.assertEqual([s['label'] for s in result], FORM_LABELS)

    def test_starts_are_downbeats_and_confidence_is_a_fraction(self):
        chroma, mfcc, rms, starts, ends = synthetic_features(FORM)
        result = suggest_from_features(chroma, mfcc, rms, starts, ends)
        self.assertEqual(result[0]['t0'], starts[0])
        for s in result:
            self.assertIn(s['t0'], starts.tolist())
            self.assertGreaterEqual(s['confidence'], 0.0)
            self.assertLessEqual(s['confidence'], 1.0)
            self.assertEqual(set(s), {'t0', 'label', 'confidence'})
        # Clean, well separated clusters are confident.
        self.assertGreater(min(s['confidence'] for s in result), 0.5)

    def test_deterministic(self):
        features = synthetic_features(FORM, seed=3, noise=0.8)
        first = suggest_from_features(*features)
        for _ in range(3):
            self.assertEqual(suggest_from_features(*features), first)

    def test_a_pickup_before_the_first_downbeat_is_not_a_section(self):
        chroma, mfcc, rms, starts, ends = synthetic_features(FORM)
        result = suggest_from_features(chroma, mfcc, rms, starts + 0.75, ends + 0.75)
        self.assertEqual(result[0]['t0'], 0.75)
        assert_near_bars(self, boundaries(result), [t + 0.75 for t in FORM_BOUNDARIES])

    def test_at_most_24_sections(self):
        # 30 alternating 4-bar sections of three kinds.
        form = [('ABC'[i % 3], 4) for i in range(30)]
        result = suggest_from_features(*synthetic_features(form, noise=0.1))
        self.assertLessEqual(len(result), sections.MAX_SEGMENTS)
        self.assertGreaterEqual(len(result), 2)

    def test_eigengap_choice_stays_in_three_to_eight_and_one_per_four_bars(self):
        evals = np.array([0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.5, 0.9, 1.0])
        self.assertEqual(sections.eigengap_k(evals, 100), 8)
        # The biggest gap, after two eigenvalues, is out of range; the best in 3–8 wins.
        evals = np.array([0, 0.01, 0.8, 0.82, 0.9, 0.92, 0.95, 0.97, 0.99, 1.0])
        self.assertEqual(sections.eigengap_k(evals, 100), 4)
        evals = np.array([0, 0.01, 0.02, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1])
        self.assertEqual(sections.eigengap_k(evals, 100), 3)
        evals = np.array([0, 0.01, 0.02, 0.03, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
        self.assertEqual(sections.eigengap_k(evals, 100), 4)
        evals = np.array([0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.9, 1.0, 1.1, 1.2])
        self.assertEqual(sections.eigengap_k(evals, 16), 4)  # 16 bars: at most 4 clusters

    def test_kmeans_is_seeded_and_numbers_clusters_by_first_appearance(self):
        rng = np.random.RandomState(7)
        points = np.vstack([rng.randn(10, 2) * 0.1 + c for c in ([5, 5], [0, 0], [-5, 5])])
        labels = kmeans(points, 3)
        self.assertEqual(labels.tolist(), [0] * 10 + [1] * 10 + [2] * 10)
        self.assertEqual(kmeans(points, 3).tolist(), labels.tolist())

    def test_silhouettes(self):
        points = np.array([[0.0, 0], [0, 0.1], [10, 10], [10, 10.1], [20, 0]])
        scores = sections.cluster_silhouettes(points, np.array([0, 0, 1, 1, 2]))
        self.assertGreater(scores[0], 0.9)
        self.assertGreater(scores[1], 0.9)
        self.assertEqual(scores[2], 0.0)  # a one-bar cluster
        self.assertEqual(sections.cluster_silhouettes(points, np.zeros(5, dtype=int)), {0: 0.0})


class BoundaryTests(unittest.TestCase):
    def embedding(self, labels):
        """A 2-D embedding where each cluster sits on its own corner."""
        corners = {0: [0.0, 0.0], 1: [1.0, 0.0], 2: [0.0, 1.0], 3: [1.0, 1.0]}
        return np.array([corners[c] for c in labels])

    def test_runs(self):
        self.assertEqual(runs([0, 0, 1, 1, 1, 0]), [[0, 2, 0], [2, 5, 1], [5, 6, 0]])

    def test_a_short_segment_joins_its_more_similar_neighbour(self):
        labels = [0] * 8 + [2] * 2 + [1] * 8
        emb = self.embedding(labels)
        emb[8:10] = [0.9, 0.1]  # the two bars sound like cluster 1
        self.assertEqual(merge_segments(runs(labels), emb), [(0, 8, 0), (8, 18, 1)])
        emb[8:10] = [0.1, 0.1]  # … or like cluster 0
        self.assertEqual(merge_segments(runs(labels), emb), [(0, 10, 0), (10, 18, 1)])

    def test_short_first_and_last_segments_join_their_only_neighbour(self):
        labels = [2] * 3 + [0] * 8 + [1] * 8 + [3] * 1
        self.assertEqual(merge_segments(runs(labels), self.embedding(labels)), [(0, 11, 0), (11, 20, 1)])

    def test_every_segment_ends_up_at_least_four_bars(self):
        labels = [0, 1, 0, 1, 2, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 1, 1, 3, 3]
        merged = merge_segments(runs(labels), self.embedding(labels))
        self.assertTrue(all(last - first >= sections.MIN_SEGMENT_BARS for first, last, _ in merged))
        self.assertEqual(merged[0][0], 0)
        self.assertEqual(merged[-1][1], len(labels))
        self.assertTrue(all(a[1] == b[0] for a, b in zip(merged, merged[1:])))

    def test_more_than_24_segments_are_merged_down(self):
        labels = [i % 2 for i in range(30) for _ in range(4)]  # 30 four-bar segments
        merged = merge_segments(runs(labels), self.embedding(labels))
        self.assertLessEqual(len(merged), sections.MAX_SEGMENTS)


# ---- Names ---------------------------------------------------------------------------------------

def named(spec, *, bar=BAR):
    """name_segments over [(cluster, bars, rms), …] with `bar`-second bars."""
    segs, rms, at = [], [], 0
    for cluster, bars, loud in spec:
        segs.append((at, at + bars, cluster))
        rms += [loud] * bars
        at += bars
    starts = np.arange(at) * bar
    return name_segments(segs, np.array(rms, dtype=float), starts, starts + bar)


class NamingTableTests(unittest.TestCase):
    """The naming heuristic of architecture §6.10, row by row."""

    TABLE = [
        ('A-B-A-B-C-B: the loudest most-repeated cluster is the Chorus; what precedes it, the Verse; '
         'a unique segment between two Choruses, the Bridge',
         [(0, 8, .2), (1, 8, .5), (0, 8, .2), (1, 8, .5), (2, 8, .3), (1, 8, .5)],
         ['Verse', 'Chorus', 'Verse', 'Chorus', 'Bridge', 'Chorus']),
        ('a unique first segment under 25 s is the Intro; a unique last segment, the Outro',
         [(0, 4, .1), (1, 8, .2), (2, 8, .5), (1, 8, .2), (2, 8, .5), (3, 16, .1)],
         ['Intro', 'Verse', 'Chorus', 'Verse', 'Chorus', 'Outro']),
        ('a unique first segment of 25 s or more is not an Intro',
         [(0, 13, .1), (1, 8, .2), (2, 8, .5), (1, 8, .2), (2, 8, .5)],
         ['Part A', 'Verse', 'Chorus', 'Verse', 'Chorus']),
        ('equally repeated clusters: the louder one is the Chorus',
         [(0, 8, .6), (1, 8, .3), (0, 8, .6), (1, 8, .3)],
         ['Chorus', 'Verse', 'Chorus', 'Verse']),
        ('the most-repeated cluster wins over a louder one',
         [(0, 8, .2), (1, 8, .9), (0, 8, .2), (1, 8, .9), (0, 8, .2)],
         ['Chorus', 'Verse', 'Chorus', 'Verse', 'Chorus']),
        ('any cluster that precedes the Chorus can be the Verse; on a tie, the earlier one',
         [(0, 8, .5), (1, 8, .2), (0, 8, .5), (2, 8, .3), (0, 8, .5)],
         ['Chorus', 'Verse', 'Chorus', 'Bridge', 'Chorus']),
        ('on a tie for the Verse, the cluster that occurs more often wins',
         [(1, 8, .3), (0, 8, .6), (2, 8, .2), (0, 8, .6), (2, 8, .2), (3, 8, .1), (0, 8, .6)],
         ['Intro', 'Chorus', 'Verse', 'Chorus', 'Verse', 'Part A', 'Chorus']),
        ('the Verse is the cluster that most often directly precedes the Chorus',
         [(0, 8, .2), (1, 8, .3), (2, 8, .6), (1, 8, .3), (2, 8, .6), (0, 8, .2), (2, 8, .6)],
         ['Part A', 'Verse', 'Chorus', 'Verse', 'Chorus', 'Part A', 'Chorus']),
        ('a unique segment that is not between two Choruses is a Part',
         [(0, 8, .2), (1, 8, .6), (2, 8, .3), (0, 8, .2), (1, 8, .6), (3, 8, .3), (1, 8, .6)],
         ['Verse', 'Chorus', 'Part A', 'Verse', 'Chorus', 'Bridge', 'Chorus']),
        ('nothing repeats: the loudest cluster is the Chorus, what precedes it the Verse',
         [(2, 13, .2), (0, 8, .5), (1, 8, .3)],
         ['Verse', 'Chorus', 'Outro']),
        ('equally repeated and equally loud: the earlier cluster is the Chorus',
         [(0, 8, .3), (1, 8, .3), (0, 8, .3), (1, 8, .3)],
         ['Chorus', 'Verse', 'Chorus', 'Verse']),
        ('Part letters follow first appearance, whatever the cluster ids',
         [(5, 13, .2), (3, 8, .9), (4, 8, .1), (3, 8, .9), (4, 8, .1), (6, 8, .2), (7, 8, .2), (6, 8, .2), (7, 8, .2)],
         ['Part A', 'Chorus', 'Verse', 'Chorus', 'Verse', 'Part B', 'Part C', 'Part B', 'Part C']),
    ]

    def test_table(self):
        for title, spec, expected in self.TABLE:
            with self.subTest(title):
                self.assertEqual(named(spec), expected)

    def test_many_parts_get_two_letters(self):
        self.assertEqual([sections._letter(i) for i in (0, 25, 26, 27)], ['A', 'Z', 'AA', 'AB'])


# ---- Recorded fixtures (numpy only) ------------------------------------------------------------------

def fixture_paths():
    return sorted(FIXTURES.glob('*.npz'))


def hit_rates(result, starts, ends, ref_times, ref_labels):
    """(precision, recall) of the suggested boundaries against the hand annotation, ±1 bar.

    Precision: the share of suggested boundaries within a bar of an annotated boundary.
    Recall: the share of annotated boundaries between differently labelled sections that a
    suggested boundary lies within a bar of (a repeat of the same section need not be split).
    Annotated boundaries within half a bar of the song's first or last bar are its edges.
    """
    est = np.array(boundaries(result))
    bar = float(np.median(np.diff(starts)))
    lo, hi = starts[0] + bar / 2, ends[-1] - bar / 2
    labels = [str(x).strip() for x in ref_labels]
    inner = [(t, labels[i - 1] != labels[i]) for i, t in enumerate(ref_times) if i > 0 and lo < t < hi]
    every = np.array([t for t, _ in inner])
    changes = np.array([t for t, change in inner if change])
    tol = bar + 1e-6
    precision = float(np.mean([np.min(np.abs(every - e)) <= tol for e in est])) if est.size else 0.0
    recall = float(np.mean([est.size > 0 and np.min(np.abs(est - r)) <= tol for r in changes])) if changes.size else 1.0
    return precision, recall


@unittest.skipUnless(fixture_paths(), 'no recorded section fixtures')
class RecordedFixtureTests(unittest.TestCase):
    """Three real recordings, measured against their hand annotations at ±1 bar.

    Unsupervised structure analysis does not place every boundary within a bar of an
    annotated one, nor find every annotated change (published systems reach an F-measure
    around 0.5–0.6 at ±3 s), so this checks hit rates, not every boundary: at least
    MIN_PRECISION of the suggested boundaries lie within a bar of an annotated boundary,
    and at least MIN_RECALL of the annotated changes of section have a suggested boundary
    within a bar (measured: precision 0.67–0.82, recall 0.53–0.56). The strict "every
    boundary within ±1 bar" holds on the synthetic form (StructureTests, AudioTests).
    """

    #: Precision floor: at least this share of suggested boundaries are annotated ones.
    MIN_PRECISION = 0.6
    #: Recall floor over boundaries between differently labelled sections.
    MIN_RECALL = 0.4

    def load(self, path):
        with np.load(path, allow_pickle=False) as data:
            return {key: data[key] for key in data.files}

    def test_there_are_three_recordings(self):
        self.assertEqual(len(fixture_paths()), 3)

    def test_suggested_boundaries_match_the_hand_annotations(self):
        for path in fixture_paths():
            with self.subTest(path.stem):
                d = self.load(path)
                result = suggest_from_features(d['chroma'], d['mfcc'], d['rms'], d['starts'], d['ends'])
                precision, recall = hit_rates(result, d['starts'], d['ends'], d['ref_times'], d['ref_labels'])
                self.assertGreaterEqual(precision, self.MIN_PRECISION, f'{path.stem}: precision {precision:.2f}')
                self.assertGreaterEqual(recall, self.MIN_RECALL, f'{path.stem}: recall {recall:.2f}')

    def test_suggestions_are_well_formed(self):
        for path in fixture_paths():
            with self.subTest(path.stem):
                d = self.load(path)
                result = suggest_from_features(d['chroma'], d['mfcc'], d['rms'], d['starts'], d['ends'])
                self.assertGreaterEqual(len(result), 2)
                self.assertLessEqual(len(result), sections.MAX_SEGMENTS)
                self.assertEqual(result[0]['t0'], float(d['starts'][0]))
                bars = d['starts'].tolist()
                t0s = [s['t0'] for s in result]
                self.assertEqual(t0s, sorted(t0s))
                for s in result:
                    self.assertIn(s['t0'], bars)
                    self.assertTrue(s['label'] in NAMES or s['label'].startswith('Part '), s['label'])
                    self.assertTrue(0.0 <= s['confidence'] <= 1.0)
                # Every section is at least four bars long.
                index = [bars.index(t) for t in t0s] + [len(bars)]
                self.assertTrue(all(b - a >= sections.MIN_SEGMENT_BARS for a, b in zip(index, index[1:])))
                self.assertEqual(suggest_from_features(d['chroma'], d['mfcc'], d['rms'], d['starts'], d['ends']), result)


# ---- Against librosa and scipy -------------------------------------------------------------------

@unittest.skipUnless(HAS_LIBROSA and HAS_SCIPY, NEEDS_LIBROSA)
class LibrosaEquivalenceTests(unittest.TestCase):
    """The numpy structure stage computes the matrices librosa and scipy would."""

    def features(self, n=60, seed=0):
        return sections.stack_features(*synthetic_features([('A', n // 3), ('B', n // 3), ('C', n - 2 * (n // 3))], seed=seed, noise=1.0)[:2])

    def test_recurrence_affinity_is_librosas(self):
        import librosa
        for width in (1, 2, 3):
            with self.subTest(width=width):
                x = self.features(seed=width)
                ours = sections.recurrence_affinity(x, width=width)
                theirs = librosa.segment.recurrence_matrix(x.T, width=width, mode='affinity', sym=True)
                np.testing.assert_allclose(ours, theirs, atol=1e-9)

    def test_lag_median_filter_is_librosas_timelag_filter(self):
        import librosa
        import scipy.ndimage
        x = self.features()
        rec = librosa.segment.recurrence_matrix(x.T, width=1, mode='affinity', sym=True)
        theirs = librosa.segment.timelag_filter(scipy.ndimage.median_filter)(rec, size=(1, sections.LAG_FILTER_BARS))
        np.testing.assert_allclose(sections.lag_median_filter(rec, sections.LAG_FILTER_BARS), theirs, atol=1e-12)

    def test_normalized_laplacian_is_scipys(self):
        import scipy.sparse.csgraph
        rng = np.random.RandomState(0)
        a = rng.rand(20, 20)
        a = (a + a.T) / 2
        np.fill_diagonal(a, 0)
        a[3, :] = a[:, 3] = 0  # an isolated bar
        np.testing.assert_allclose(sections.normalized_laplacian(a), scipy.sparse.csgraph.laplacian(a, normed=True), atol=1e-12)


# ---- Audio (librosa) -----------------------------------------------------------------------------

@unittest.skipUnless(HAS_LIBROSA, NEEDS_LIBROSA)
class AudioTests(unittest.TestCase):
    def test_a_synthetic_recording_gives_its_boundaries_and_names(self):
        audio = synthetic_audio(FORM)
        result = suggest(audio, RATE, downbeats(48), duration=audio.size / RATE)
        assert_near_bars(self, boundaries(result), FORM_BOUNDARIES)
        self.assertEqual([s['label'] for s in result], FORM_LABELS)
        self.assertEqual(suggest(audio, RATE, downbeats(48), duration=audio.size / RATE), result)

    def test_the_label_pattern_is_stable_across_renditions(self):
        for seed in (1, 2):
            with self.subTest(seed=seed):
                audio = synthetic_audio(FORM, seed=seed)
                result = suggest(audio, RATE, downbeats(48), duration=audio.size / RATE)
                assert_near_bars(self, boundaries(result), FORM_BOUNDARIES)
                self.assertEqual([s['label'] for s in result], FORM_LABELS)

    def test_stereo_int_like_and_any_layout_audio_is_accepted(self):
        mono = synthetic_audio(FORM)
        expected = suggest(mono, RATE, downbeats(48), duration=mono.size / RATE)
        stereo = np.stack([mono, mono], axis=1)  # soundfile's (samples, channels)
        self.assertEqual(suggest(stereo, RATE, downbeats(48), duration=mono.size / RATE), expected)
        self.assertEqual(suggest(stereo.T, RATE, downbeats(48), duration=mono.size / RATE), expected)

    def test_recordings_without_parts_give_nothing(self):
        silence = np.zeros(64 * RATE, dtype=np.float32)
        noise = (0.1 * np.random.RandomState(0).randn(64 * RATE)).astype(np.float32)
        cases = {f'one section ({letter})': synthetic_audio([(letter, 48)]) for letter in 'ABC'}
        cases.update({'silence': silence, 'steady noise': noise})
        for name, audio in cases.items():
            with self.subTest(name):
                bars = int(audio.size / RATE / BAR)
                self.assertEqual(suggest(audio, RATE, downbeats(bars), duration=audio.size / RATE), [])

    def test_silence_before_a_hidden_track_is_one_section(self):
        song, hidden = synthetic_audio(FORM), synthetic_audio(FORM[:2], seed=5)
        for silent in (30, 60, 100):
            with self.subTest(silent=silent):
                audio = np.concatenate([song, np.zeros(int(silent * BAR * RATE), dtype=np.float32), hidden])
                result = suggest(audio, RATE, downbeats(48 + silent + 16), duration=audio.size / RATE)
                end = 48 * BAR
                assert_near_bars(self, boundaries(result), FORM_BOUNDARIES + [end, end + silent * BAR, end + (silent + 8) * BAR])
                self.assertEqual([s['label'] for s in result], FORM_LABELS + ['Part A', 'Verse', 'Chorus'])

    def test_bar_features_shape(self):
        audio = synthetic_audio([('A', 4), ('B', 4)])
        starts, ends = bar_grid(downbeats(8), audio.size / RATE)
        chroma, mfcc, rms = sections.bar_features(audio, RATE, starts, ends)
        self.assertEqual((chroma.shape, mfcc.shape, rms.shape), ((12, 8), (sections.N_MFCC, 8), (8,)))
        # B (bars 4–7) is the louder section.
        self.assertGreater(rms[4:].mean(), rms[:4].mean())


@unittest.skipUnless(HAS_LIBROSA, NEEDS_LIBROSA)
class RuntimeTests(unittest.TestCase):
    #: architecture §9.8: under 10 s for a 5-minute song in the container.
    BUDGET_SECONDS = 10.0

    FORM = [('D', 8), ('A', 16), ('B', 16), ('A', 16), ('B', 16), ('C', 16), ('B', 16), ('A', 16), ('B', 16), ('E', 14)]

    def test_a_five_minute_song_takes_under_ten_seconds_from_a_cold_start(self):
        """A sections job imports sections (and so librosa) on its first call: the budget
        covers that import too, timed in a fresh interpreter."""
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'song.npy'
            np.save(path, synthetic_audio(self.FORM))
            script = (
                'import json, sys, time\n'
                'import numpy as np\n'
                'audio = np.load(sys.argv[1])\n'
                'started = time.perf_counter()\n'
                'import sections\n'
                f'result = sections.suggest(audio, {RATE}, [i * {BAR} for i in range(150)], duration=audio.size / {RATE})\n'
                'print(json.dumps({"elapsed": time.perf_counter() - started, "sections": len(result)}))\n')
            out = subprocess.run([sys.executable, '-c', script, str(path)], cwd=HERE, capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        report = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertLess(report['elapsed'], self.BUDGET_SECONDS, f"{report['elapsed']:.1f} s for a 5-minute song, cold")
        self.assertGreaterEqual(report['sections'], 2)

    def test_a_five_minute_song_takes_under_ten_seconds(self):
        audio = synthetic_audio(self.FORM)
        seconds = audio.size / RATE
        self.assertAlmostEqual(seconds, 300.0)
        started = time.perf_counter()
        result = suggest(audio, RATE, downbeats(150), duration=seconds)
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, self.BUDGET_SECONDS, f'{elapsed:.1f} s for a 5-minute song')
        self.assertGreaterEqual(len(result), 2)


# ---- Fixture builder -----------------------------------------------------------------------------

#: The recordings and their hand annotations, relative to msaf-data's Sargon/ folder.
SARGON = ['01-Sargon-Mindless', '02-Sargon-Shattered World', '03-Sargon-Waiting For Silence']


def estimate_downbeats(audio, rate):
    """librosa's beats grouped in fours, starting on the beat with the strongest low-frequency onsets."""
    import librosa
    _tempo, beats = librosa.beat.beat_track(y=audio, sr=rate, hop_length=512, units='time')
    onset = librosa.onset.onset_strength(y=audio, sr=rate, hop_length=512, n_mels=64, fmax=200)
    frames = np.clip(librosa.time_to_frames(beats, sr=rate, hop_length=512), 0, onset.size - 1)
    phase = int(np.argmax([onset[frames[p::4]].mean() if frames[p::4].size else 0 for p in range(4)]))
    return beats[phase::4]


def build_fixtures(sargon: pathlib.Path, out: pathlib.Path = FIXTURES):
    """Write companion/fixtures/sections/<song>.npz from msaf-data's Sargon audio and references."""
    import json
    import subprocess
    out.mkdir(parents=True, exist_ok=True)
    for name in SARGON:
        audio_path = sargon / 'audio' / f'{name}.mp3'
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(audio_path), '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'],
                             capture_output=True, check=True).stdout
        audio = np.frombuffer(raw, dtype=np.float32).copy()
        duration = audio.size / RATE
        starts, ends = bar_grid(estimate_downbeats(audio, RATE), duration)
        chroma, mfcc, rms = sections.bar_features(audio, RATE, starts, ends)
        reference = json.loads((sargon / 'references' / f'{name}.jams').read_text())['annotations'][0]['data']
        np.savez_compressed(
            out / f'{name.split("-", 1)[0]}-{name.split("-", 2)[2].lower().replace(" ", "-")}.npz',
            chroma=chroma.astype(np.float32), mfcc=mfcc.astype(np.float32), rms=rms.astype(np.float32),
            starts=starts, ends=ends, duration=np.float64(duration),
            ref_times=np.array([float(o['time']) for o in reference]),
            ref_labels=np.array([str(o['value']).strip() for o in reference]),
            source=np.array(f'msaf-data Sargon/audio/{name}.mp3; Sargon/references/{name}.jams (Oriol Nieto)'))
        print(f'{name}: {starts.size} bars', flush=True)


if __name__ == '__main__':
    if sys.argv[1:2] == ['--build-fixtures'] and len(sys.argv) == 3:
        build_fixtures(pathlib.Path(sys.argv[2]))
    else:
        unittest.main()
