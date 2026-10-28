"""Section suggestions (B7, D47): where a song's sections start, and a guess at their names.

``suggest(audio, sr, downbeats, *, duration)`` returns ``[{t0, label, confidence}]``,
one entry per suggested section, ``t0`` on a downbeat. process.py runs it after
beat detection on a beats job (``settings.sections``) and on its own for a
``sections`` job (the song's current bar starts). Nothing here is ever written
into the map: the app shows the result as dashed blocks until the user keeps it.

The method is McFee & Ellis (2014), "Analyzing song structure with spectral
clustering" (ISMIR), on bar-synchronous features:

1. **Features** (``bar_features``, the only part that needs librosa): CQT chroma
   and MFCC averaged over each bar (downbeat to downbeat), each block z-scored
   and weighted by its size (harmony a little above timbre), then stacked. Frames
   60 dB below the loudest are silence: every silent bar gets the same features.
2. **Structure** (``segment``, numpy only): a mutual k-nearest-neighbour
   affinity recurrence matrix (the same matrix as
   ``librosa.segment.recurrence_matrix(mode='affinity', sym=True)``, except that
   identical bars always link) smoothed along its diagonals in time-lag space,
   combined with a sequence matrix of bar-to-bar timbre continuity. A graph with
   no clean two-way cut (one section throughout, noise, silence) has no structure
   and gets no suggestion. Otherwise the first eigenvectors of its normalised
   Laplacian, with k picked by the largest eigengap in 3–8, are clustered with
   k-means.
3. **Boundaries:** every change of cluster, on a downbeat; segments shorter than
   4 bars merge into their more similar neighbour; at most 24 segments.
4. **Names** (``name_segments``): a heuristic the app never presents as certain.

Deterministic: no unseeded randomness (k-means uses a fixed seed), CPU only.
The structure stage is numpy only so its tests run wherever numpy does.
"""
from __future__ import annotations

import contextlib

import numpy as np

#: Fewer bars than this and there is no structure worth suggesting.
MIN_BARS = 16
#: A segment shorter than this merges into a neighbour.
MIN_SEGMENT_BARS = 4
#: The most sections a suggestion carries.
MAX_SEGMENTS = 24
#: The number of clusters is chosen from this range by the largest eigengap.
K_MIN, K_MAX = 3, 8
#: Above this second-smallest eigenvalue of the normalised Laplacian the song has no
#: structure to suggest. Songs with parts sit below 0.05; one section, noise or a drone
#: throughout, above 0.15.
MAX_FIEDLER = 0.1
#: A unique first segment shorter than this is the Intro.
INTRO_MAX_SECONDS = 25.0

#: Feature frame hop: about 93 ms at the detection rate (22.05 kHz), some 20 frames a bar.
HOP_LENGTH = 2048
#: CQT chroma from C1 over six octaves (to B6): the bass and the harmony, without the
#: costly top octave.
CHROMA_OCTAVES = 6
N_MFCC = 13
#: Frames this many dB below the song's loudest frame are silence.
SILENCE_DB = 60.0
#: Harmony counts this much more than timbre in the recurrence features.
CHROMA_WEIGHT = 1.5
#: Recurrence links closer than this many bars are dropped (librosa's `width`; 1 drops
#: only a bar's link to itself).
RECURRENCE_WIDTH = 1
#: Diagonal (time-lag) median filter of the recurrence matrix, in bars.
LAG_FILTER_BARS = 3
#: k-means restarts; the seed makes them reproducible.
KMEANS_INIT = 10
KMEANS_SEED = 0
#: Feature distances (and squared bar-to-bar steps) below this are zero: identical bars.
TIE_TOLERANCE = 1e-6


def suggest(audio, sr: int, downbeats, *, duration: float) -> list[dict]:
    """Suggested sections for a mono recording with known downbeats (seconds).

    Returns ``[]`` when there are fewer than 16 bars, no audio, or no structure
    (``has_structure``, or a single segment after merging).
    """
    samples = _mono(audio)
    rate = int(sr)
    if rate <= 0 or samples.size == 0:
        return []
    length = samples.size / rate
    total = float(duration) if duration and np.isfinite(duration) and duration > 0 else length
    starts, ends = bar_grid(downbeats, min(total, length))
    if starts.size < MIN_BARS:
        return []
    chroma, mfcc, rms = bar_features(samples, rate, starts, ends)
    return suggest_from_features(chroma, mfcc, rms, starts, ends)


def suggest_from_features(chroma, mfcc, rms, starts, ends) -> list[dict]:
    """The structure, boundary and naming stages on bar features.

    ``chroma`` is (12, bars), ``mfcc`` (n, bars), ``rms`` (bars,); ``starts`` and
    ``ends`` are each bar's start and end in seconds.
    """
    starts = np.asarray(starts, dtype=float)
    ends = np.asarray(ends, dtype=float)
    if starts.size < MIN_BARS:
        return []
    features = stack_features(chroma, mfcc)
    with _one_blas_thread():
        labels, embedding = segment(features, np.asarray(mfcc, dtype=float))
    segments = merge_segments(runs(labels), embedding)
    if len(segments) < 2:
        return []
    bar_labels = np.empty(starts.size, dtype=int)
    for first, last, cluster in segments:
        bar_labels[first:last] = cluster
    scores = cluster_silhouettes(embedding, bar_labels)
    names = name_segments(segments, np.asarray(rms, dtype=float), starts, ends)
    return [{'t0': float(starts[first]), 'label': name, 'confidence': float(np.clip(scores[cluster], 0.0, 1.0))}
            for (first, _last, cluster), name in zip(segments, names)]


@contextlib.contextmanager
def _one_blas_thread():
    """Run the small dense linear algebra on one BLAS thread.

    The matrices are a few hundred bars square: threads cannot speed them up, and on
    a busy machine a threaded eigendecomposition can take seconds instead of
    milliseconds. threadpoolctl comes with the processor runtime (scikit-learn,
    through librosa); without it the BLAS default stands.
    """
    try:
        from threadpoolctl import threadpool_limits
    except ImportError:
        yield
        return
    with threadpool_limits(limits=1, user_api='blas'):
        yield


# ---- Bars and features ---------------------------------------------------------------------------

def _mono(audio) -> np.ndarray:
    samples = np.asarray(audio, dtype=np.float32)
    if samples.ndim > 1:
        # (samples, channels) from soundfile, or (channels, samples) from librosa.
        samples = samples.mean(axis=1 if samples.shape[0] >= samples.shape[1] else 0)
    return np.nan_to_num(samples.reshape(-1))


def bar_grid(downbeats, duration: float):
    """(starts, ends) of every bar in seconds: sorted, deduplicated downbeats inside the song.

    The last bar runs to the end of the song, but no longer than the median bar.
    """
    times = np.asarray([] if downbeats is None else downbeats, dtype=float).reshape(-1)
    times = np.sort(times[np.isfinite(times) & (times >= 0) & (times < duration)])
    if times.size:
        times = times[np.concatenate(([True], np.diff(times) > 1e-3))]
    if times.size < 2:
        return times, times.copy()
    ends = np.append(times[1:], min(duration, times[-1] + float(np.median(np.diff(times)))))
    keep = ends - times > 1e-3
    return times[keep], ends[keep]


def bar_features(samples: np.ndarray, sr: int, starts: np.ndarray, ends: np.ndarray):
    """(chroma (12, bars), mfcc (13, bars), rms (bars,)): frame features averaged over each bar."""
    import librosa

    y = np.ascontiguousarray(samples, dtype=np.float32)
    # tuning=0: A440. Estimating the tuning (piptrack) costs more than the whole CQT, and
    # three bins a semitone folded into chroma already absorb a detuned recording.
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP_LENGTH, n_octaves=CHROMA_OCTAVES, tuning=0.0)
    mel_db = librosa.power_to_db(librosa.feature.melspectrogram(y=y, sr=sr, hop_length=HOP_LENGTH), ref=np.max, top_db=80.0)
    rms = librosa.feature.rms(y=y, hop_length=HOP_LENGTH)
    frames = min(chroma.shape[1], mel_db.shape[1], rms.shape[1])
    chroma, mel_db, rms = chroma[:, :frames], mel_db[:, :frames], rms[:, :frames]
    # Silence gate: chroma is normalised frame by frame, so the faint tail of a note ringing
    # into digital silence (or the pre-roll of a hidden track) would read as a full chord.
    # Frames this far below the loudest are silence: no chroma, and the floor of the mel
    # spectrum, so every silent bar is the same bar.
    peak = float(rms.max()) if rms.size else 0.0
    silent = rms[0] <= peak * 10.0 ** (-SILENCE_DB / 20.0) if peak > 0 else np.ones(frames, dtype=bool)
    chroma[:, silent] = 0.0
    mel_db[:, silent] = -80.0
    mfcc = librosa.feature.mfcc(S=mel_db, n_mfcc=N_MFCC)
    return (bar_average(chroma, sr, starts, ends),
            bar_average(mfcc, sr, starts, ends),
            bar_average(rms, sr, starts, ends)[0])


def bar_average(frames: np.ndarray, sr: int, starts: np.ndarray, ends: np.ndarray, hop: int = HOP_LENGTH) -> np.ndarray:
    """The mean of each bar's frames: (dims, frames) → (dims, bars)."""
    count = frames.shape[1]
    first = np.clip(np.floor(np.asarray(starts) * sr / hop).astype(int), 0, count - 1)
    last = np.clip(np.ceil(np.asarray(ends) * sr / hop).astype(int), first + 1, count)
    return np.stack([frames[:, a:b].mean(axis=1) for a, b in zip(first, last)], axis=1)


def stack_features(chroma, mfcc) -> np.ndarray:
    """(bars, dims): each block z-scored per dimension and weighted by 1/√dims (chroma by
    CHROMA_WEIGHT/√dims), side by side."""
    return np.concatenate([CHROMA_WEIGHT * _zblock(chroma), _zblock(mfcc)], axis=0).T


def _zblock(block) -> np.ndarray:
    """(dims, bars) z-scored per dimension and scaled by 1/√dims, so every block weighs the same."""
    block = np.asarray(block, dtype=float)
    mean = block.mean(axis=1, keepdims=True)
    std = block.std(axis=1, keepdims=True)
    return ((block - mean) / np.where(std > 1e-9, std, 1.0)) / np.sqrt(block.shape[0])


# ---- Structure -----------------------------------------------------------------------------------

def segment(features: np.ndarray, mfcc: np.ndarray):
    """(cluster per bar, row-normalised spectral embedding per bar)."""
    n = features.shape[0]
    width = max(1, min(RECURRENCE_WIDTH, (n - 1) // 2 - 1))
    recurrence = lag_median_filter(recurrence_affinity(features, width=width), LAG_FILTER_BARS)
    # The filter is shift-equivariant along each diagonal except at the edges; keep the graph undirected.
    recurrence = 0.5 * (recurrence + recurrence.T)
    sequence = sequence_affinity(_zblock(mfcc).T)
    graph = balance(recurrence, sequence)
    evals, evecs = np.linalg.eigh(normalized_laplacian(graph))
    if not has_structure(features, evals):
        return np.zeros(n, dtype=int), np.ones((n, 1))
    k = eigengap_k(evals, n)
    embedding = row_normalize(evecs[:, :k])
    return kmeans(embedding, k), embedding


def has_structure(features: np.ndarray, evals: np.ndarray) -> bool:
    """Whether the bars fall into parts at all.

    No, when every bar is the same bar (silence), or when the graph has no clean
    two-way cut: its second-smallest Laplacian eigenvalue (the Fiedler value) is above
    MAX_FIEDLER. One section played throughout, steady noise or a drone links every bar
    to bars all over the song, and any partition of it would be invented. A song with
    parts that recur keeps its value near 0.
    """
    if features.size == 0 or float(np.ptp(features, axis=0).max()) < TIE_TOLERANCE:
        return False
    return evals.size > 1 and float(evals[1]) <= MAX_FIEDLER


def pairwise_distances(x: np.ndarray) -> np.ndarray:
    """Euclidean distances between the rows of x."""
    sq = np.sum(x * x, axis=1)
    d2 = sq[:, None] + sq[None, :] - 2.0 * (x @ x.T)
    np.maximum(d2, 0.0, out=d2)
    np.fill_diagonal(d2, 0.0)
    return np.sqrt(d2)


def recurrence_affinity(x: np.ndarray, *, width: int = 1, k: int | None = None) -> np.ndarray:
    """Mutual k-NN affinity recurrence matrix, as librosa.segment.recurrence_matrix(
    x.T, width=width, k=k, mode='affinity', sym=True) computes it (bandwidth 'med_k_scalar').

    Links between bars closer than ``width`` are dropped; each bar keeps its k
    nearest remaining bars; a link survives only when it is mutual; its weight is
    exp(-distance / median distance to the k-th neighbour). One difference: identical
    bars (distance 0, such as a run of digital silence) are all linked to each other
    with weight 1, where librosa's sparse matrix loses the link and its neighbour search
    breaks the ties arbitrarily.
    """
    n = x.shape[0]
    if k is None:
        k = int(2 * np.ceil(np.sqrt(n - 2 * width + 1)))
    dist = pairwise_distances(x)
    idx = np.arange(n)
    banned = np.abs(idx[:, None] - idx[None, :]) < width
    dist = np.where(dist < TIE_TOLERANCE, 0.0, dist)
    # Distances within TIE_TOLERANCE of each other are equal (identical bars, such as a run of
    # digital silence, differ only by rounding). Ties go to the nearer bar in time, then the
    # earlier one, so a run of identical bars links along itself instead of every bar piling
    # onto the run's first k bars and leaving the rest unlinked.
    lag = np.abs(idx[:, None] - idx[None, :])
    tied = np.where(banned, np.inf, np.round(dist / TIE_TOLERANCE))
    order = np.lexsort((np.broadcast_to(idx, (n, n)), lag, tied), axis=1)[:, :k]
    keep = np.zeros((n, n), dtype=bool)
    keep[idx[:, None], order] = True
    keep &= ~banned
    keep &= keep.T
    # Identical bars are always each other's neighbours: a run of them is one block, not a chain.
    keep |= (dist == 0.0) & ~banned
    if not keep.any():
        return np.zeros((n, n))
    kth = np.array([dist[i, keep[i]].max() if keep[i].any() else 0.0 for i in range(n)])
    # Rows linked only to identical bars do not set the scale: a long silence must not
    # shrink it to nothing.
    kth = kth[kth > 0]
    bandwidth = float(np.median(kth)) if kth.size else 1.0
    return np.where(keep, np.exp(-dist / bandwidth), 0.0)


def lag_median_filter(rec: np.ndarray, size: int) -> np.ndarray:
    """Median filter along the diagonals (librosa.segment.timelag_filter of a
    scipy.ndimage.median_filter of size (1, size), padded lag space)."""
    n = rec.shape[0]
    if size <= 1 or n < 2:
        return rec.copy()
    padded = np.concatenate([rec, np.zeros_like(rec)], axis=0)  # (2n, n): no wraparound
    rows = np.arange(2 * n)[:, None]
    cols = np.arange(n)[None, :]
    lag = padded[(rows + cols) % (2 * n), cols]  # lag[l, j] = rec[l + j, j]
    filtered = _median_axis1(lag, size)
    back = filtered[(rows - cols) % (2 * n), cols]  # rec[i, j] = lag[i - j, j]
    return back[:n]


def _median_axis1(x: np.ndarray, size: int) -> np.ndarray:
    """Median over a centred window along axis 1, reflecting at the edges (scipy 'reflect')."""
    before = size // 2
    after = size - 1 - before
    padded = np.pad(x, [(0, 0), (before, after)], mode='symmetric')
    windows = np.lib.stride_tricks.sliding_window_view(padded, size, axis=1)
    return np.median(windows, axis=-1)


def sequence_affinity(x: np.ndarray) -> np.ndarray:
    """Links between neighbouring bars, weighted by how little the sound changes between them."""
    n = x.shape[0]
    steps = np.sum(np.diff(x, axis=0) ** 2, axis=1)
    steps = np.where(steps < TIE_TOLERANCE, 0.0, steps)
    # The scale is the typical change between bars that differ at all: a long run of identical
    # bars (silence) must not drive it to zero and so erase the edges where the sound changes.
    moving = steps[steps > 0]
    sigma = float(np.median(moving)) if moving.size else 0.0
    weights = np.exp(-steps / sigma) if sigma > 0 else np.ones_like(steps)
    seq = np.zeros((n, n))
    seq[np.arange(n - 1), np.arange(1, n)] = weights
    seq[np.arange(1, n), np.arange(n - 1)] = weights
    return seq


def balance(recurrence: np.ndarray, sequence: np.ndarray) -> np.ndarray:
    """μ·R + (1 − μ)·S, μ balancing the two graphs' degrees in the least-squares sense (McFee & Ellis, eq. 7)."""
    deg_seq = sequence.sum(axis=1)
    deg_rec = recurrence.sum(axis=1)
    total = deg_seq + deg_rec
    denom = float(np.sum(total ** 2))
    mu = float(deg_seq.dot(total) / denom) if denom > 0 else 0.5
    return mu * recurrence + (1.0 - mu) * sequence


def normalized_laplacian(a: np.ndarray) -> np.ndarray:
    """I − D^-1/2 A D^-1/2 (scipy.sparse.csgraph.laplacian(normed=True); isolated bars get 0)."""
    a = a.copy()
    np.fill_diagonal(a, 0.0)
    degree = a.sum(axis=1)
    isolated = degree <= 0
    scale = np.where(isolated, 1.0, np.sqrt(np.where(isolated, 1.0, degree)))
    lap = -a / scale[:, None] / scale[None, :]
    np.fill_diagonal(lap, np.where(isolated, 0.0, 1.0))
    return lap


def eigengap_k(evals: np.ndarray, n: int) -> int:
    """The k in 3–8 (and at most one cluster per 4 bars) after which the eigenvalues jump most."""
    hi = int(min(K_MAX, max(K_MIN, n // MIN_SEGMENT_BARS), evals.size - 1))
    candidates = range(K_MIN, hi + 1)
    gaps = [evals[k] - evals[k - 1] for k in candidates]
    return int(list(candidates)[int(np.argmax(gaps))]) if gaps else K_MIN


def row_normalize(x: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    return x / np.where(norms > 1e-12, norms, 1.0)


def kmeans(x: np.ndarray, k: int, *, n_init: int = KMEANS_INIT, seed: int = KMEANS_SEED, iters: int = 300) -> np.ndarray:
    """Lloyd's k-means with k-means++ seeding from a fixed seed: the best of n_init runs.

    Cluster ids are renumbered in order of first appearance, so equal partitions
    always give equal ids.
    """
    n = x.shape[0]
    k = max(1, min(k, n))
    rng = np.random.RandomState(seed)
    best, best_inertia = None, np.inf
    for _ in range(n_init):
        centers = _kmeans_pp(x, k, rng)
        labels = np.zeros(n, dtype=int)
        for step in range(iters):
            d2 = ((x[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
            new = d2.argmin(axis=1)
            if step and np.array_equal(new, labels):
                break
            labels = new
            for c in range(k):
                members = x[labels == c]
                if members.size:
                    centers[c] = members.mean(axis=0)
                else:
                    # An empty cluster takes the point farthest from its centre.
                    far = int(d2[np.arange(n), labels].argmax())
                    centers[c] = x[far]
                    labels[far] = c
        inertia = float(((x - centers[labels]) ** 2).sum())
        if inertia < best_inertia - 1e-12:
            best, best_inertia = labels.copy(), inertia
    return _first_appearance(best)


def _kmeans_pp(x: np.ndarray, k: int, rng: np.random.RandomState) -> np.ndarray:
    n = x.shape[0]
    centers = [x[rng.randint(n)]]
    closest = ((x - centers[0]) ** 2).sum(axis=1)
    for _ in range(1, k):
        total = closest.sum()
        pick = int(rng.choice(n, p=closest / total)) if total > 0 else int(rng.randint(n))
        centers.append(x[pick])
        closest = np.minimum(closest, ((x - x[pick]) ** 2).sum(axis=1))
    return np.array(centers, dtype=float)


def _first_appearance(labels: np.ndarray) -> np.ndarray:
    mapping: dict[int, int] = {}
    return np.array([mapping.setdefault(int(c), len(mapping)) for c in labels], dtype=int)


def cluster_silhouettes(x: np.ndarray, labels: np.ndarray) -> dict[int, float]:
    """The mean silhouette of each cluster's bars (a one-bar cluster, or a single cluster, scores 0)."""
    dist = pairwise_distances(x)
    clusters = sorted(set(int(c) for c in labels))
    if len(clusters) < 2:
        return {c: 0.0 for c in clusters}
    members = {c: labels == c for c in clusters}
    scores = np.zeros(labels.size)
    for i, own in enumerate(labels):
        mask = members[int(own)].copy()
        mask[i] = False
        if not mask.any():
            continue
        a = dist[i, mask].mean()
        b = min(dist[i, members[c]].mean() for c in clusters if c != own)
        top = max(a, b)
        scores[i] = (b - a) / top if top > 0 else 0.0
    return {c: float(scores[members[c]].mean()) for c in clusters}


# ---- Boundaries ----------------------------------------------------------------------------------

def runs(labels) -> list[list[int]]:
    """[[first bar, end bar (exclusive), cluster], …] for each run of equal labels."""
    out: list[list[int]] = []
    for i, c in enumerate(labels):
        c = int(c)
        if out and out[-1][2] == c:
            out[-1][1] = i + 1
        else:
            out.append([i, i + 1, c])
    return out


def merge_segments(segments: list[list[int]], embedding: np.ndarray) -> list[tuple[int, int, int]]:
    """Merge every segment shorter than 4 bars into its more similar neighbour, then
    the shortest segments until at most 24 remain."""
    segs = [list(s) for s in segments]

    def centroid(s):
        return embedding[s[0]:s[1]].mean(axis=0)

    def absorb(i):
        options = [j for j in (i - 1, i + 1) if 0 <= j < len(segs)]
        here = centroid(segs[i])
        # The more similar neighbour; on a tie, the earlier one.
        j = min(options, key=lambda j: (float(np.linalg.norm(centroid(segs[j]) - here)), j))
        segs[i][2] = segs[j][2]
        coalesce()

    def coalesce():
        merged = [segs[0]]
        for s in segs[1:]:
            if s[2] == merged[-1][2]:
                merged[-1][1] = s[1]
            else:
                merged.append(s)
        segs[:] = merged

    while len(segs) > 1:
        lengths = [s[1] - s[0] for s in segs]
        shortest = int(np.argmin(lengths))
        if lengths[shortest] >= MIN_SEGMENT_BARS and len(segs) <= MAX_SEGMENTS:
            break
        absorb(shortest)
    return [tuple(s) for s in segs]


# ---- Names ---------------------------------------------------------------------------------------

def name_segments(segments, rms: np.ndarray, starts: np.ndarray, ends: np.ndarray) -> list[str]:
    """A name for each segment ([first, end, cluster]), by the heuristic in architecture §6.10:

    - the most-repeated cluster with the highest mean RMS → Chorus;
    - the cluster that most often directly precedes it → Verse (ties: the cluster that
      occurs more often, then the earlier one);
    - a unique first segment under 25 s → Intro; a unique last segment → Outro;
    - a unique segment between two Choruses → Bridge;
    - any other cluster → Part A, Part B, … in order of first appearance.
    """
    count = len(segments)
    clusters = [int(s[2]) for s in segments]
    occurrences = {c: clusters.count(c) for c in clusters}
    loudness = {c: float(np.mean(np.concatenate([rms[s[0]:s[1]] for s in segments if s[2] == c]))) for c in occurrences}
    order = list(dict.fromkeys(clusters))  # first appearance

    chorus = max(order, key=lambda c: (occurrences[c], loudness[c], -order.index(c))) if order else None
    before = {c: 0 for c in order if c != chorus}
    for a, b in zip(clusters, clusters[1:]):
        if b == chorus and a in before:
            before[a] += 1
    best = max(before.items(), key=lambda kv: (kv[1], occurrences[kv[0]], -order.index(kv[0])), default=(None, 0))
    verse = best[0] if best[1] > 0 else None

    names: list[str | None] = [None] * count
    for i, c in enumerate(clusters):
        if c == chorus:
            names[i] = 'Chorus'
        elif c == verse:
            names[i] = 'Verse'
        elif occurrences[c] == 1:
            seconds = float(ends[segments[i][1] - 1] - starts[segments[i][0]])
            if i == 0 and seconds < INTRO_MAX_SECONDS:
                names[i] = 'Intro'
            elif i == count - 1:
                names[i] = 'Outro'
            elif 0 < i < count - 1 and chorus is not None and clusters[i - 1] == chorus and clusters[i + 1] == chorus:
                names[i] = 'Bridge'
    letters: dict[int, str] = {}
    for i, c in enumerate(clusters):
        if names[i] is None:
            if c not in letters:
                letters[c] = _letter(len(letters))
            names[i] = f'Part {letters[c]}'
    return names


def _letter(index: int) -> str:
    """A, B, … Z, AA, AB, …"""
    out = ''
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        out = chr(ord('A') + rem) + out
    return out
