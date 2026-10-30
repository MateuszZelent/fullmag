"""Regression gates for evidence-backed DE dispersion plots (no solver run)."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import plot_eigensolve_completed_native_dispersion as plot


class PlotEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.evidence = json.loads((plot.ROOT / 'docs/audits/2026-10-27-eigensolve-gamma-after-docker.evidence.json').read_text())
        self.mode = self.evidence['spectrum']['payload']['samples'][0]['modes'][0]
        self.script = plot.ROOT / 'examples/fem_eigen_mode_ui_de_signed15.py'

    def test_reference_matches_authored_physics(self):
        params = plot.benchmark_parameters(self.script, self.mode)
        reference = plot.load_reference(plot.ROOT / 'docs/raports/2026-10-04-de-signed15-runtime.csv', params)
        self.assertEqual(len(reference), 15)
        self.assertIn(0, reference)

    def test_reference_rejects_changed_thickness(self):
        params = plot.benchmark_parameters(self.script, self.mode)
        params['film_thickness_m'] *= 2
        with self.assertRaisesRegex(ValueError, 'reference does not match'):
            plot.load_reference(plot.ROOT / 'docs/raports/2026-10-04-de-signed15-runtime.csv', params)

    def test_executed_gamma_must_match_script(self):
        mode = copy.deepcopy(self.mode)
        mode['gamma0_rad_s_per_A_m'] *= 2
        with self.assertRaisesRegex(ValueError, 'Executed gamma differs'):
            plot.benchmark_parameters(self.script, mode)

    def test_nonfinite_residual_rejected(self):
        self.mode['block_residuals']['eps_full'] = float('nan')
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'input.json'
            path.write_text(json.dumps(self.evidence))
            with self.assertRaisesRegex(ValueError, 'Uncertified full descriptor'):
                plot.load_samples(path)

    def test_conflicting_generation_rejected(self):
        resource = dict(status='ready', run_id='run', stage_id='eigen',
                        generation_status='member_verified_owner_bound', generation_id='generation-A')
        evidence = dict(run=dict(status='completed', run_id='run'),
                        manifest=dict(result_manifest=resource), spectrum={**resource, 'generation_id': 'generation-B'})
        with self.assertRaisesRegex(ValueError, 'generations/stages differ'):
            plot.published_owner(evidence)

    def test_activation_must_belong_to_result_run(self):
        evidence = dict(run=dict(status='completed', run_id='run'), spectrum={}, activation=dict(run_id='stale-run'))
        with self.assertRaisesRegex(ValueError, 'Activation and result run owners differ'):
            plot.published_owner(evidence)

    def test_unbound_owner_rejected(self):
        resource = dict(status='ready', run_id='another-run', stage_id='eigen',
                        generation_status='member_verified_owner_bound', generation_id='generation-A')
        evidence = dict(run=dict(status='completed', run_id='run'),
                        manifest=dict(result_manifest=resource), spectrum=resource)
        with self.assertRaisesRegex(ValueError, 'conflicting published artifact owner'):
            plot.published_owner(evidence)


if __name__ == '__main__':
    unittest.main()
