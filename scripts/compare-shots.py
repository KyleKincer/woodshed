#!/usr/bin/env python3
"""Compare fixture captures with baselines (architecture §10.6, §11.4).

    python3 -I scripts/compare-shots.py [--out tests/fixture/out]
        [--baselines tests/fixture/baselines/2.0] [--legacy]
        [--threshold 0.0015] [--thresholds FILE] [--pixel-tolerance 16]
        [--filter REGEX] [--curated] [--allow-new] [--report FILE]

Every PNG in --baselines named <state>--<device>-<theme>.png is compared with
the capture of the same name in --out. A pixel differs when any channel
differs by more than --pixel-tolerance (0-255). A state passes when the share
of differing pixels is at most its threshold: --threshold (default 0.15 %),
or the first matching entry of the thresholds file ({"<regex>": fraction},
default <baselines>/thresholds.json when it exists). For every compared state
it writes out/diff/<name>.png: the capture dimmed, with differing pixels in
red; captures of another size compare as fully different.

--legacy compares against tests/fixture/baselines/legacy/ for the owner's
side-by-side review (gate G4): each diff image is baseline | capture | diff,
and differences and missing captures are reported but never fail.
--curated keeps only the committed variants (laptop-dark and ipad-light).
A capture with no baseline is reported as "new" and fails unless --allow-new.

Writes a JSON report (default out/compare-report.json) and exits 0 when every
state passes, 1 when any differs, is missing or is new, 2 on a setup error.
Needs Pillow and numpy; run with python3 -I.
"""
import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NAME = re.compile(r'^(?P<state>[a-z0-9][a-z0-9-]*?)--(?P<device>[a-z]+)-(?P<theme>light|dark)\.png$')
CURATED = {('laptop', 'dark'), ('ipad', 'light')}
DIFF_RED = (230, 30, 60)


def fail_setup(message):
    print(f'compare-shots: {message}', file=sys.stderr)
    sys.exit(2)


try:
    import numpy as np
    from PIL import Image
except ImportError as error:  # pragma: no cover - environment problem
    fail_setup(f'needs Pillow and numpy ({error})')


def parse_args(argv):
    p = argparse.ArgumentParser(description='Compare fixture captures with baselines.')
    p.add_argument('--out', type=Path, default=REPO / 'tests/fixture/out')
    p.add_argument('--baselines', type=Path)
    p.add_argument('--legacy', action='store_true')
    p.add_argument('--threshold', type=float, default=0.0015)
    p.add_argument('--thresholds', type=Path)
    p.add_argument('--pixel-tolerance', type=int, default=16)
    p.add_argument('--filter', type=re.compile)
    p.add_argument('--curated', action='store_true')
    p.add_argument('--allow-new', action='store_true')
    p.add_argument('--report', type=Path)
    args = p.parse_args(argv)
    if args.baselines is None:
        args.baselines = REPO / ('tests/fixture/baselines/legacy' if args.legacy else 'tests/fixture/baselines/2.0')
    if not 0 <= args.threshold <= 1:
        fail_setup('--threshold is a fraction between 0 and 1')
    if not 0 <= args.pixel_tolerance <= 255:
        fail_setup('--pixel-tolerance is 0-255')
    return args


def load_thresholds(args):
    path = args.thresholds or (args.baselines / 'thresholds.json')
    if not path.exists():
        if args.thresholds:
            fail_setup(f'no thresholds file {path}')
        return []
    try:
        data = json.loads(path.read_text())
        return [(re.compile(pattern), float(value)) for pattern, value in data.items()]
    except (ValueError, re.error) as error:
        fail_setup(f'bad thresholds file {path}: {error}')


def threshold_for(name, rules, default):
    for pattern, value in rules:
        if pattern.search(name):
            return value
    return default


def rgb(path):
    with Image.open(path) as im:
        return np.asarray(im.convert('RGB'), dtype=np.int16)


def diff_mask(a, b, tolerance):
    """Boolean mask of differing pixels, or None when the sizes differ."""
    if a.shape != b.shape:
        return None
    return (np.abs(a - b) > tolerance).any(axis=2)


def diff_image(current, mask):
    dim = (current * 0.35 + 255 * 0.65).astype(np.uint8)
    dim[mask] = DIFF_RED
    return dim


def side_by_side(*images):
    h = max(i.shape[0] for i in images)
    w = sum(i.shape[1] for i in images) + 8 * (len(images) - 1)
    canvas = np.full((h, w, 3), 128, dtype=np.uint8)
    x = 0
    for i in images:
        canvas[:i.shape[0], x:x + i.shape[1]] = i.astype(np.uint8)
        x += i.shape[1] + 8
    return canvas


def compare(args):
    if not args.baselines.is_dir():
        fail_setup(f'no baselines directory {args.baselines}')
    rules = load_thresholds(args)
    diff_dir = args.out / 'diff'
    keep = lambda name: (NAME.match(name)
                         and (not args.filter or args.filter.search(name))
                         and (not args.curated or (NAME.match(name)['device'], NAME.match(name)['theme']) in CURATED))
    baselines = sorted(p.name for p in args.baselines.glob('*.png') if keep(p.name))
    captures = sorted(p.name for p in args.out.glob('*.png') if keep(p.name)) if args.out.is_dir() else []
    results = []
    for name in baselines:
        current_path = args.out / name
        threshold = threshold_for(name, rules, args.threshold)
        if not current_path.exists():
            results.append({'name': name, 'status': 'missing', 'threshold': threshold})
            continue
        base, current = rgb(args.baselines / name), rgb(current_path)
        mask = diff_mask(base, current, args.pixel_tolerance)
        diff_dir.mkdir(parents=True, exist_ok=True)
        if mask is None:
            ratio, differing, total = 1.0, None, int(current.shape[0] * current.shape[1])
            image = side_by_side(base, current)
            status = 'size'
        else:
            differing, total = int(mask.sum()), int(mask.size)
            ratio = differing / total if total else 0.0
            image = diff_image(current, mask)
            if args.legacy:
                image = side_by_side(base, current, image)
            status = 'pass' if ratio <= threshold else 'fail'
        if args.legacy:
            status = 'review'
        Image.fromarray(image.astype(np.uint8)).save(diff_dir / name)
        results.append({'name': name, 'status': status, 'ratio': round(ratio, 6), 'differing': differing, 'total': total,
                        'threshold': threshold, 'size': {'baseline': list(base.shape[1::-1]), 'capture': list(current.shape[1::-1])},
                        'diff': str((diff_dir / name).relative_to(REPO) if (diff_dir / name).is_relative_to(REPO) else diff_dir / name)})
    if not args.legacy:
        for name in captures:
            if name not in baselines:
                results.append({'name': name, 'status': 'new' if not args.allow_new else 'new-allowed'})
    # The legacy comparison is a review aid (gate G4): it reports and never fails.
    bad = [] if args.legacy else [r for r in results if r['status'] in ('fail', 'size', 'missing', 'new')]
    report = {'mode': 'legacy' if args.legacy else '2.0', 'baselines': str(args.baselines), 'out': str(args.out),
              'threshold': args.threshold, 'pixelTolerance': args.pixel_tolerance,
              'compared': len([r for r in results if 'ratio' in r]), 'failed': len(bad), 'results': results}
    report_path = args.report or (args.out / 'compare-report.json')
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=1) + '\n')
    for r in results:
        detail = f" {r['ratio'] * 100:.3f}% (≤ {r['threshold'] * 100:.3f}%)" if 'ratio' in r else ''
        print(f"{r['status']:<11} {r['name']}{detail}")
    print(f"{len(results) - len(bad)}/{len(results)} ok · report {report_path}")
    return 1 if bad else 0


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    return compare(args)


if __name__ == '__main__':
    sys.exit(main())
