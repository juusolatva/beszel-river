"""Apply the approved multi-seed occupancy gate to the output of runGpuOccupancyGate().

The gate is specified in docs/superpowers/plans/2026-11-13-gpu-prototype.md ("Revised occupancy gate").
"""

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any

#: Two-sided Student t quantile at alpha = 0.05 / 330 with 19 degrees of freedom (scipy.stats.t.ppf).
T_CRIT = 4.71
#: One-sided normal quantile for 90 % detection.
DETECT_Z = 1.28
FLOOR_PARTICLES = 1.0
FLOOR_SHARE = 0.005
#: Slots with a CPU mean above this count as busy for the sensitivity requirement.
BUSY_PARTICLES = 20.0
MAX_DETECTABLE_SHARE = 0.05
SCENARIOS = ('occupancy', 'filaments')
SEEDS = dict(cpu=range(1, 21), calibration=range(21, 41), pcg=range(1001, 1021), gpu=range(1001, 1021))
SERIES = 33
WINDOWS = 5


def group_runs(raw):
    """Index the runs by scenario and group, rejecting anything but the gate's exact runs."""
    grouped, starts = {}, {}
    for run in raw['runs']:
        key = run['scenario'], run['group']
        if run['scenario'] not in SCENARIOS or run['group'] not in SEEDS:
            raise ValueError(f'Unknown run: {key}')
        means = run['means']
        if len(means) != WINDOWS * SERIES or not all(math.isfinite(m) for m in means):
            raise ValueError(f'Malformed means: {key} seed {run["seed"]}')
        if len(run['starts']) != WINDOWS or starts.setdefault(run['scenario'], run['starts']) != run['starts']:
            raise ValueError(f'Window starts differ: {key} seed {run["seed"]}')
        grouped.setdefault(key, {})
        if run['seed'] in grouped[key]:
            raise ValueError(f'Duplicate run: {key} seed {run["seed"]}')
        grouped[key][run['seed']] = means
    for scenario in SCENARIOS:
        for group, seeds in SEEDS.items():
            if sorted(grouped.get((scenario, group), {})) != list(seeds):
                raise ValueError(f'Seeds differ from the gate: {scenario}/{group}')
    return grouped


def compare(scenario, reference, other):
    """One row per window and series: both means, the bound and the 90 % detectable difference."""
    rows = []
    for index in range(WINDOWS * SERIES):
        a_values = [means[index] for means in reference.values()]
        b_values = [means[index] for means in other.values()]
        a, b = statistics.fmean(a_values), statistics.fmean(b_values)
        error = math.sqrt(statistics.variance(a_values) / len(a_values) + statistics.variance(b_values) / len(b_values))
        floor = max(FLOOR_PARTICLES, FLOOR_SHARE * a)
        bound = T_CRIT * error + floor
        rows.append(dict(scenario=scenario, window=index // SERIES, slot=index % SERIES - 1, a=a, b=b,
                         difference=b - a, bound=bound, passed=abs(b - a) <= bound,
                         detectable=(T_CRIT + DETECT_Z) * error + floor))
    return rows


def process(raw: dict[str, Any]) -> dict[str, Any]:
    grouped = group_runs(raw)
    comparisons = {name: [row for scenario in SCENARIOS
                          for row in compare(scenario, grouped[scenario, 'cpu'], grouped[scenario, name])]
                   for name in ('calibration', 'pcg', 'gpu')}
    busy = [row['detectable'] / row['a'] for row in comparisons['calibration']
            if row['slot'] >= 0 and row['a'] > BUSY_PARTICLES]
    # No busy slot at all means the fixture did not run as specified; sensitivity is then unknown.
    median_share = statistics.median(busy) if busy else None
    failures = {name: sum(not row['passed'] for row in rows) for name, rows in comparisons.items()}
    calibration_passed = (failures['calibration'] == 0 and failures['pcg'] == 0
                          and median_share is not None and median_share <= MAX_DETECTABLE_SHARE)
    summary = dict(comparisons=len(comparisons['gpu']), failures=failures,
                   medianDetectableShare=median_share, calibrationPassed=calibration_passed,
                   gpuPassed=failures['gpu'] == 0, gatePassed=calibration_passed and failures['gpu'] == 0,
                   closest={name: sorted(rows, key=lambda row: abs(row['difference']) / row['bound'], reverse=True)[:5]
                            for name, rows in comparisons.items()})
    # Browser metadata and runs are preserved verbatim; derived values live in their own blocks.
    return dict(metadata=raw['metadata'], runs=raw['runs'], comparisons=comparisons, summary=summary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='JSON exported by runGpuOccupancyGate')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = process(json.loads(args.input.read_text()))
    encoded = json.dumps(result, indent=1, allow_nan=False) + '\n'
    if args.output:
        args.output.write_text(encoded)
    else:
        print(json.dumps(result['summary'], indent=1))
    raise SystemExit(0 if result['summary']['gatePassed'] else 1)
