import copy
import random
import unittest
from typing import Any

from summarize_gpu_occupancy_gate import SEEDS, SERIES, WINDOWS, process

STARTS = [10.000000149011612, 25.00000037252903, 45.000000670552254, 50.00000074505806, 55.000000819563866]


def make_raw(gpu_shift=None, spread=8.5) -> dict[str, Any]:
    """Runs with the gate's seeds; `gpu_shift(index)` adds a bias to GPU means."""
    base = [10000.0 if i % SERIES == 0 else (416.0 if i % SERIES < 9 else 0.0) for i in range(WINDOWS * SERIES)]
    runs = []
    for scenario in ('occupancy', 'filaments'):
        for group, seeds in SEEDS.items():
            for seed in seeds:
                noise = random.Random(f'{scenario}/{group}/{seed}')
                means = []
                for i, value in enumerate(base):
                    # Totals of a saturated pool and unused slots barely vary; busy slots do.
                    jitter = noise.gauss(0, spread) if value == 416.0 else 0.0
                    shift = gpu_shift(i) if gpu_shift and group == 'gpu' else 0.0
                    means.append(value + jitter + shift)
                runs.append(dict(scenario=scenario, group=group, seed=seed, starts=list(STARTS), means=means))
    return dict(metadata={'renderer': 'actual browser value', 'runsPerGroup': 20}, runs=runs)


class GateTest(unittest.TestCase):
    def test_matching_distributions_pass_and_metadata_is_kept(self):
        raw = make_raw()
        result = process(raw)
        summary = result['summary']
        self.assertTrue(summary['calibrationPassed'])
        self.assertTrue(summary['gpuPassed'])
        self.assertTrue(summary['gatePassed'])
        self.assertEqual(summary['comparisons'], 330)
        self.assertEqual(result['metadata'], raw['metadata'])
        self.assertLess(summary['medianDetectableShare'], 0.05)

    def test_a_visible_bias_in_one_slot_fails_the_gpu(self):
        # 10 % of a 416-particle slot in one window of one scenario.
        summary = process(make_raw(gpu_shift=lambda i: 41.6 if i == 2 * SERIES + 3 else 0.0))['summary']
        self.assertTrue(summary['calibrationPassed'])
        self.assertFalse(summary['gpuPassed'])
        self.assertEqual(summary['failures']['gpu'], 2)  # the same index in both scenarios

    def test_the_floor_allows_small_constant_differences_in_saturated_totals(self):
        # Totals have no spread; 3 particles of 10,000 is below 0.5 % but far above the statistic.
        summary = process(make_raw(gpu_shift=lambda i: 3.0 if i % SERIES == 0 else 0.0))['summary']
        self.assertTrue(summary['gpuPassed'])
        summary = process(make_raw(gpu_shift=lambda i: 60.0 if i % SERIES == 0 else 0.0))['summary']
        self.assertFalse(summary['gpuPassed'])

    def test_unused_slots_must_read_zero_within_one_particle(self):
        summary = process(make_raw(gpu_shift=lambda i: 0.5 if i % SERIES == 20 else 0.0))['summary']
        self.assertTrue(summary['gpuPassed'])
        summary = process(make_raw(gpu_shift=lambda i: 1.5 if i % SERIES == 20 else 0.0))['summary']
        self.assertFalse(summary['gpuPassed'])

    def test_failed_calibration_fails_the_gate_even_if_the_gpu_passes(self):
        raw = make_raw()
        for run in raw['runs']:
            if run['group'] == 'calibration':
                run['means'][3] += 100
        summary = process(raw)['summary']
        self.assertFalse(summary['calibrationPassed'])
        self.assertTrue(summary['gpuPassed'])
        self.assertFalse(summary['gatePassed'])

    def test_too_wide_a_spread_fails_calibration_on_sensitivity(self):
        summary = process(make_raw(spread=20.0))['summary']
        self.assertGreater(summary['medianDetectableShare'], 0.05)
        self.assertFalse(summary['calibrationPassed'])

    def test_malformed_runs_are_rejected(self):
        raw = make_raw()
        cases = []
        missing = copy.deepcopy(raw); missing['runs'].pop(); cases.append(missing)
        extra = copy.deepcopy(raw); extra['runs'].append(copy.deepcopy(raw['runs'][0])); cases.append(extra)
        seed = copy.deepcopy(raw); seed['runs'][0]['seed'] = 999; cases.append(seed)
        short = copy.deepcopy(raw); short['runs'][0]['means'].pop(); cases.append(short)
        nan = copy.deepcopy(raw); nan['runs'][0]['means'][0] = float('nan'); cases.append(nan)
        starts = copy.deepcopy(raw); starts['runs'][5]['starts'][0] += 0.1; cases.append(starts)
        for case in cases:
            with self.assertRaises(ValueError):
                process(case)


if __name__ == '__main__':
    unittest.main()
