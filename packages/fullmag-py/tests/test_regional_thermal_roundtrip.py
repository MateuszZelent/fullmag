"""Brown noise must reach planning instead of disappearing in scene export."""
from pathlib import Path
import tempfile
import unittest
import fullmag as fm
from fullmag.runtime.scene_document import build_scene_document_from_builder, builder_overrides_from_scene_document
from fullmag.runtime.thermal_noise_authoring import canonical_thermal_noise
from fullmag.runtime.scene_document_ir import scene_document_to_execution_config
from fullmag.runtime.script_builder import export_builder_draft, render_scene_document_as_script, rewrite_loaded_problem_script

class RegionalThermalRoundtripTests(unittest.TestCase):
    def test_seeded_and_entropy_thermal_intent_survives_both_exports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for seed in (17, 2**64 - 1, None):
                source = root / 'input.py'
                source.write_text(f'''import fullmag as fm
study = fm.study("thermal-regions")
study.engine("fdm").device("gpu").mode("strict")
study.cell(2e-9, 2e-9, 2e-9)
body = study.geometry(fm.Box(8e-9, 4e-9, 2e-9), name="film")
body.Ms = 8e5
body.Aex = 13e-12
body.alpha = .02
region = body.add_region("right", fm.Box(4e-9, 4e-9, 2e-9).translate((2e-9, 0, 0)))
region.material_transition(kind="sharp")
region.material.Ms = 1.2e6
study.thermal_noise(300.12345678901234, seed={seed!r})
study.solver(fix_dt=1e-14, integrator="heun")
study.run(1e-13)
''')
                loaded = fm.load_problem_from_script(source, lightweight_assets=True)
                original = loaded.problem.to_ir(include_geometry_assets=False)
                scene = build_scene_document_from_builder(export_builder_draft(loaded))
                expected_config = {'temperature': original['temperature']}
                if seed is not None:
                    expected_config['seed'] = str(seed)
                self.assertEqual(scene['study']['thermal_noise'], expected_config)
                with self.subTest(seed=seed, path='execution_config'):
                    config = scene_document_to_execution_config(
                        scene, requested_backend='fdm', requested_device='gpu',
                        requested_precision='double', requested_mode='strict', source_root=root)
                    self.assertEqual(config['ir']['temperature'], original['temperature'])
                    self.assertEqual([t for t in config['ir']['energy_terms'] if t['kind']=='thermal_noise'],
                                     [t for t in original['energy_terms'] if t['kind']=='thermal_noise'])
                for path, rendered in {
                    'problem': rewrite_loaded_problem_script(loaded)['rendered_source'],
                    'scene': render_scene_document_as_script(scene),
                }.items():
                    with self.subTest(seed=seed, path=path):
                        target = root / 'exported.py'; target.write_text(rendered)
                        actual = fm.load_problem_from_script(target, lightweight_assets=True).problem.to_ir(include_geometry_assets=False)
                        self.assertEqual(actual['temperature'], original['temperature'])
                        self.assertEqual([t for t in actual['energy_terms'] if t['kind']=='thermal_noise'],
                                         [t for t in original['energy_terms'] if t['kind']=='thermal_noise'])

    def test_thermal_override_presence_and_clear(self):
        scene = {'version': 'scene.v2', 'objects': [], 'materials': [], 'study': {}}
        self.assertNotIn('thermal_noise', builder_overrides_from_scene_document(scene))
        scene['study']['thermal_noise'] = None
        self.assertIsNone(builder_overrides_from_scene_document(scene)['thermal_noise'])

    def test_rewriting_existing_script_preserves_missing_and_applies_clear(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'input.py'
            source.write_text('''import fullmag as fm
study = fm.study("thermal-rewrite")
body = study.geometry(fm.Box(8e-9, 4e-9, 2e-9), name="film")
body.Ms = 8e5
body.Aex = 13e-12
study.thermal_noise(300.12345678901234, seed=18446744073709551615)
study.run(1e-13)
''')
            loaded = fm.load_problem_from_script(source, lightweight_assets=True)
            for overrides, expected in (({}, True), ({'thermal_noise': None}, False)):
                with self.subTest(overrides=overrides):
                    rendered = rewrite_loaded_problem_script(loaded, overrides=overrides)['rendered_source']
                    target = root / 'output.py'; target.write_text(rendered)
                    rebuilt = fm.load_problem_from_script(target, lightweight_assets=True)
                    terms = [term for term in rebuilt.problem.to_ir(include_geometry_assets=False)['energy_terms']
                             if term['kind'] == 'thermal_noise']
                    self.assertEqual(bool(terms), expected)
                    if expected:
                        self.assertEqual(terms[0]['seed'], 2**64 - 1)
                        self.assertEqual(terms[0]['temperature'], 300.12345678901234)

    def test_thermal_configuration_rejects_lossy_or_invalid_values(self):
        for value in ({'temperature': 0}, {'temperature': float('nan')},
                      {'temperature': True}, {'temperature': 300, 'seed': 17},
                      {'temperature': 300, 'seed': '0'},
                      {'temperature': 300, 'seed': '017'},
                      {'temperature': 300, 'seed': str(2**64)},
                      {'temperature': 300, 'seed': '-1'},
                      {'temperature': 300, 'extra': 1}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                canonical_thermal_noise(value)

if __name__ == '__main__':
    unittest.main()
