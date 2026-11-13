import copy
import unittest

from summarize_gpu_occupancy import process


class SummaryTest(unittest.TestCase):
    def setUp(self):
        self.raw = dict(metadata={'renderer': 'actual browser value'}, results=[dict(
            scenario='plain', checkedAllocations=10, totalBirths=3, windows=[dict(
                start=10, slot=0, reference=100, gpu=106, differentSeed=105,
                ascendingOnly=100, pcgOnly=94, matched=106)])])
        self.history = dict(windows=[dict(scenario='plain', start=10, slot=0,
                                         cpu=100, gpu=106, control=105)])

    def test_bounds_and_measured_metadata(self):
        result = process(self.raw, self.history)
        summary = result['summary']
        self.assertTrue(summary['originalWindowsExactlyReproduced'])
        self.assertEqual(summary['failuresVsReference'], dict(
            gpu=1, differentSeed=0, ascendingOnly=0, pcgOnly=1, matched=1))
        self.assertEqual(summary['gpuFailuresVsMatched'], 0)
        self.assertEqual(result['metadata'], self.raw['metadata'])
        self.assertEqual(summary['checkedAllocations'], 10)
        self.assertEqual(summary['totalBirths'], 3)

    def test_changed_original_mean_is_not_exact_reproduction(self):
        for name in ['reference', 'gpu', 'differentSeed']:
            changed = copy.deepcopy(self.raw)
            changed['results'][0]['windows'][0][name] += .01
            self.assertFalse(process(changed, self.history)['summary']['originalWindowsExactlyReproduced'])

    def test_missing_extra_and_duplicate_windows_are_rejected(self):
        for windows in [[], self.raw['results'][0]['windows'] * 2,
                        [dict(self.raw['results'][0]['windows'][0], start=11)]]:
            changed = copy.deepcopy(self.raw)
            changed['results'][0]['windows'] = windows
            with self.assertRaises(ValueError):
                process(changed, self.history)

    def test_nonfinite_means_are_rejected(self):
        self.raw['results'][0]['windows'][0]['gpu'] = float('nan')
        with self.assertRaises(ValueError):
            process(self.raw, self.history)
