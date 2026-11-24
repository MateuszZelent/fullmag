"""Source-only RT0 budget admission regressions; no native execution proof."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SurfaceRt0BudgetAdmissionSourceTests(unittest.TestCase):
    def setUp(self):
        self.core = (ROOT / 'backends/fem/cpu/mfem/interactions/oersted/surface_rt0.cpp').read_text()
        self.header = (ROOT / 'backends/fem/cpu/mfem/interactions/oersted/surface_rt0.hpp').read_text()
        self.io = (ROOT / 'backends/fem/cpu/mfem/workflows/antenna_field_solve/surface_rt0_io.cpp').read_text()

    def test_kernel_and_abi_share_the_mandatory_sqrt_preflight(self):
        self.assertIn('void validate_surface_rt0_work_minimums(', self.header)
        self.assertIn('validate_surface_rt0_work_minimums(l,cells,targets);', self.io)
        preflight = self.core.split('void preflight(', 1)[1].split('template<class R>', 1)[0]
        self.assertIn('validate_surface_rt0_work_minimums(limits,source_count,target_count);', preflight)
        self.assertLess(preflight.index('validate_surface_rt0_work_minimums('), preflight.index('work.reserve_output('))
        self.assertIn('{Kind::sqrt_calls,100}', self.core)

    def test_shared_admission_checks_total_and_per_target_without_overflow(self):
        body = self.core.split('void validate_surface_rt0_work_minimums(', 1)[1].split('SurfaceRt0Result evaluate_surface_rt0(', 1)[0]
        self.assertIn('source_count > 0 && target_count > 0', body)
        self.assertIn('source_count > limits.per_target[i]/per_pair', body)
        self.assertIn('source_count > limits.total[i]/per_pair/target_count', body)
        self.assertNotIn('source_count*target_count', body)
        self.assertIn('throw std::invalid_argument(message.str());', body)
        for label in ['kind=', 'minimum_per_pair=', 'source_cells=', 'targets=', 'per_target_limit=', 'total_limit=']:
            self.assertIn(label, body)

    def test_runtime_limit_error_is_detailed_inside_the_existing_failure_guard(self):
        body = self.core.split('    void charge(Kind kind,', 1)[1].split('    void guard()', 1)[0]
        self.assertIn('report_.total[i] > limits_.total[i]', body)
        self.assertIn('active_ && report_.current_target[i] > limits_.per_target[i]', body)
        for label in ['kind=', 'scope=', 'value=', 'limit=', 'target_index=']:
            self.assertIn(label, body)
        self.assertIn('throw std::runtime_error(message.str());', body)
        self.assertNotRegex(body, r'\b(return|continue)\b')

    def test_counter_names_cover_the_existing_enum_in_exact_order(self):
        enum = self.header.split('enum class SurfaceRt0WorkKind', 1)[1].split('};', 1)[0]
        kinds = re.findall(r'^\s*(\w+)\s*,?\s*$', enum, re.M)
        kinds = [name for name in kinds if name != 'count']
        names = self.core.split('const char *work_kind_name(', 1)[1].split('class Work', 1)[0]
        self.assertEqual(re.findall(r'"([a-z_0-9]+)"', names), kinds)


if __name__ == '__main__':
    unittest.main()
