"""Summarize exported browser evidence and compare every historical window."""

import argparse
import json
import math
from pathlib import Path


def process(raw, historical):
    def index(rows):
        indexed = {}
        for row in rows:
            key = row['scenario'], row['start'], row['slot']
            if key in indexed:
                raise ValueError(f'Duplicate window: {key}')
            indexed[key] = row
        return indexed

    rows = [dict(w, scenario=r['scenario']) for r in raw['results'] for w in r['windows']]
    current, previous = index(rows), index(historical['windows'])
    if not current or current.keys() != previous.keys():
        raise ValueError('Missing or extra historical windows')
    names = ['gpu', 'differentSeed', 'ascendingOnly', 'pcgOnly', 'matched']
    summary = dict(originalWindowsExactlyReproduced=True,
                   checkedAllocations=sum(r['checkedAllocations'] for r in raw['results']),
                   totalBirths=sum(r['totalBirths'] for r in raw['results']),
                   comparisons=len(rows), failuresVsReference=dict.fromkeys(names, 0),
                   gpuFailuresVsMatched=0, maxGpuMatchedMeanDifference=0)
    for key, w in current.items():
        old = previous[key]
        if not all(math.isfinite(w[n]) for n in ['reference', *names]):
            raise ValueError(f'Nonfinite mean: {key}')
        summary['originalWindowsExactlyReproduced'] &= (
            (w['reference'], w['gpu'], w['differentSeed']) == (old['cpu'], old['gpu'], old['control']))
        for name in names:
            summary['failuresVsReference'][name] += abs(w[name] - w['reference']) > max(5, .05 * w['reference'])
        delta = abs(w['gpu'] - w['matched'])
        summary['gpuFailuresVsMatched'] += delta > max(5, .05 * w['matched'])
        summary['maxGpuMatchedMeanDifference'] = max(summary['maxGpuMatchedMeanDifference'], delta)
    # Browser metadata is preserved verbatim. Derived claims live in a separate block.
    return dict(metadata=raw['metadata'], results=raw['results'], summary=summary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='JSON exported by runGpuOccupancyInvestigation')
    parser.add_argument('--reference', type=Path, default=Path(__file__).resolve().parents[2] /
                        'docs/experiments/2026-11-13-gpu-lifecycle.json')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = process(json.loads(args.input.read_text()), json.loads(args.reference.read_text()))
    encoded = json.dumps(result, indent=2, allow_nan=False) + '\n'
    if args.output:
        args.output.write_text(encoded)
    else:
        print(encoded, end='')
    raise SystemExit(0 if result['summary']['originalWindowsExactlyReproduced'] else 1)
