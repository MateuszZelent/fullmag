from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import fullmag as fm
from fullmag.live._scene import build_world_scene, _trim_pipeline_run_payloads
from fullmag.runtime.helper import main
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document, build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.script_builder import export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script

KEYS = ("interactive_session_requested", "wait_for_solve")
BASE = """import fullmag as fm
study = fm.study('execution-intent')
study.engine('fdm')
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(10e-9, 10e-9, 5e-9), name='film')
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1, 0, 0)
"""


def flags(problem):
    return {key: problem.runtime_metadata.get(key, False) for key in KEYS}


def sequence(first, last, final):
    lines = [BASE]
    for index, pair in enumerate((first, last)):
        lines.extend([f"study.interactive({pair[0]!r})", f"study.wait_for_solve({pair[1]!r})",
                      f"study.stages.add_run(stage_id='run{index}', until=1e-12)"])
    lines.extend([f"study.interactive({final[0]!r})", f"study.wait_for_solve({final[1]!r})"])
    return "\n".join(lines) + "\n"


class ExecutionIntentRoundtripTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.context = fm.ExecutionContext()
        self.context.__enter__()
        self.addCleanup(self.context.__exit__, None, None, None)
        self.process_guard = patch('subprocess.Popen', side_effect=AssertionError('no solver process permitted'))
        self.process_guard.start()
        self.addCleanup(self.process_guard.stop)
        if importlib.util.find_spec("gmsh") is not None:
            mesh_guard = patch('gmsh.model.mesh.generate', side_effect=AssertionError('no meshing permitted'))
            mesh_guard.start()
            self.addCleanup(mesh_guard.stop)

    def load(self, text, name='source.py'):
        path = self.root / name
        path.write_text(text, encoding='utf-8')
        return fm.load_problem_from_script(path, lightweight_assets=True)

    def assert_roundtrip(self, text):
        before = self.load(text)
        rendered = render_loaded_problem_as_script(before)
        after = self.load(rendered, 'rendered.py')
        self.assertEqual([flags(stage.problem) for stage in before.stages], [flags(stage.problem) for stage in after.stages])
        self.assertEqual(flags(before.workspace_problem), flags(after.workspace_problem))
        return before, after

    def export_config(self, path, *, thin=False):
        args = ['export-run-config', '--script', str(path), '--skip-geometry-assets']
        if thin:
            args.append('--runtime-flags-only')
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            result = main(args)
        self.assertEqual(result, 0, err.getvalue())
        return json.loads(out.getvalue())

    def test_script_roundtrip_preserves_stage_and_workspace_flags(self):
        for first, last, final in [((False, False), (False, False), (False, False)),
                                   ((True, False), (True, True), (False, False)),
                                   ((True, True), (False, False), (True, False)),
                                   ((False, True), (True, False), (False, True))]:
            with self.subTest(first=first, last=last, final=final):
                self.assert_roundtrip(sequence(first, last, final))

    def test_public_config_preserves_first_wait_and_last_interactive(self):
        for first, last in [((False, False), (False, False)), ((True, False), (True, True)),
                            ((True, True), (False, False)), ((False, True), (True, False))]:
            with self.subTest(first=first, last=last):
                before, after = self.assert_roundtrip(sequence(first, last, (False, False)))
                configs = [self.export_config(item.source_path) for item in (before, after)]
                self.assertEqual(configs[0]['ir']['problem_meta']['runtime_metadata'].get('wait_for_solve', False),
                                 configs[1]['ir']['problem_meta']['runtime_metadata'].get('wait_for_solve', False))
                self.assertEqual(flags(before.stages[-1].problem), flags(after.stages[-1].problem))
                public_gates = []
                for config in configs:
                    metadata = [stage['ir']['problem_meta']['runtime_metadata'] for stage in config['stages']]
                    self.assertEqual(len(metadata), 2)
                    public_gates.append((metadata[0].get('wait_for_solve', False),
                                         metadata[-1].get('interactive_session_requested', False)))
                self.assertEqual(public_gates, [(first[1], last[0])] * 2)

    def test_raw_multistage_flags_keep_types_in_full_and_thin_export(self):
        for value in ('false', 0, None):
            text = BASE + f"fm.runtime_metadata({KEYS[0]!r}, {value!r})\nfm.runtime_metadata({KEYS[1]!r}, 1)\nstudy.stages.add_run(until=1e-12)\nstudy.stages.add_run(until=2e-12)\n"
            loaded = self.load(text)
            for thin in (False, True):
                with self.subTest(value=value, thin=thin):
                    config = self.export_config(loaded.source_path, thin=thin)
                    metadata = config['ir']['problem_meta']['runtime_metadata']
                    self.assertEqual(metadata[KEYS[0]], value)
                    self.assertIs(type(metadata[KEYS[0]]), type(value))
                    self.assertIs(type(metadata[KEYS[1]]), int)
                    if not thin:
                        self.assertEqual(len(config['stages']), 2)
            with self.assertRaisesRegex(ValueError, KEYS[0]):
                build_scene_document_from_builder(export_builder_draft(loaded))

    def test_scene_flags_distinguish_missing_and_explicit_false(self):
        loaded = self.load(sequence((True, True), (True, True), (True, True)))
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        self.assertEqual({key: scene['study'][key] for key in KEYS}, dict.fromkeys(KEYS, True))
        for key in KEYS:
            scene['study'].pop(key)
        overrides = builder_overrides_from_scene_document(scene)
        self.assertTrue(all(key not in overrides for key in KEYS))
        retained = self.load(render_loaded_problem_as_script(loaded, overrides=overrides), 'missing.py')
        self.assertEqual(flags(retained.workspace_problem), dict.fromkeys(KEYS, True))
        scene['study'].update(dict.fromkeys(KEYS, False))
        rendered = self.load(render_scene_document_as_script(scene), 'scene.py')
        self.assertEqual(flags(rendered.workspace_problem), dict.fromkeys(KEYS, False))
        self.assertEqual({key: build_builder_from_scene_document(scene)[key] for key in KEYS}, dict.fromkeys(KEYS, False))
        for value in (None, 'false', 0, [], {}):
            for key in KEYS:
                invalid = copy.deepcopy(scene)
                invalid['study'][key] = value
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, key):
                    build_builder_from_scene_document(invalid)
        invalid = copy.deepcopy(scene)
        invalid['study']['study_pipeline'] = {'nodes': [{'node_kind': 'group', 'enabled': False,
            'children': [{'node_kind': 'primitive', 'enabled': False, 'payload': {KEYS[1]: 0}}]}]}
        with self.assertRaisesRegex(ValueError, KEYS[1]):
            build_builder_from_scene_document(invalid)

    def test_live_capture_and_trim_preserve_authored_flags(self):
        for enabled in (False, True):
            with fm.ExecutionContext():
                exec(BASE + f"study.interactive({enabled!r})\nstudy.wait_for_solve(False)\n", {})
                scene = build_world_scene(self.root / 'live.py')
                self.assertIs(scene['study'][KEYS[0]], enabled)
                self.assertIs(scene['study'][KEYS[1]], False)
        scene = {'study': {'study_pipeline': {'nodes': [{'stage_kind': 'run', 'payload': {
            'until_seconds': 1e-12, KEYS[0]: False, KEYS[1]: True, 'discard_me': 3}}]}}}
        _trim_pipeline_run_payloads(scene)
        payload = scene['study']['study_pipeline']['nodes'][0]['payload']
        self.assertIs(payload[KEYS[0]], False)
        self.assertIs(payload[KEYS[1]], True)
        self.assertNotIn('discard_me', payload)

    def test_scene_stages_inherit_missing_flags_and_preserve_explicit_overrides(self):
        loaded = self.load(sequence((True, True), (True, True), (True, True)))
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        scene['study'].pop('study_pipeline', None)
        for stage in scene['study']['stages']:
            for key in KEYS:
                stage.pop(key, None)
        # The first stage inherits study flags; the second changes only wait.
        scene['study']['stages'][1]['wait_for_solve'] = False
        rendered = self.load(render_scene_document_as_script(scene), 'inherit.py')
        self.assertEqual(flags(rendered.stages[0].problem), dict.fromkeys(KEYS, True))
        self.assertEqual(flags(rendered.stages[1].problem), {KEYS[0]: True, KEYS[1]: False})
        self.assertEqual(flags(rendered.workspace_problem), dict.fromkeys(KEYS, True))

    def test_scene_ir_keeps_stage_wait_distinct_from_explicit_workspace_false(self):
        from fullmag.runtime.scene_document_ir import _capture_scene_document
        loaded = self.load(sequence((True, True), (False, False), (True, False)))
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        with _capture_scene_document(scene, requested_backend='fdm', requested_device='cpu',
                requested_precision='double', requested_mode='strict', source_root=self.root,
                include_authored_stages=True, include_legacy_relax_stages=True) as capture:
            self.assertEqual(flags(capture.loaded.workspace_problem), flags(loaded.workspace_problem))
            self.assertEqual([flags(stage.problem) for stage in capture.loaded.stages],
                             [flags(stage.problem) for stage in loaded.stages])

    def test_scene_ir_explicit_stage_false_overrides_legacy_auto_wait(self):
        from fullmag.runtime.scene_document_ir import _capture_scene_document
        loaded = self.load(sequence((True, False), (True, True), (True, False)))
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        scene['study'].pop('wait_for_solve')
        with _capture_scene_document(scene, requested_backend='fdm', requested_device='cpu',
                requested_precision='double', requested_mode='strict', source_root=self.root,
                include_authored_stages=True, include_legacy_relax_stages=True) as capture:
            self.assertFalse(flags(capture.loaded.stages[0].problem)['wait_for_solve'])
            self.assertTrue(flags(capture.loaded.stages[1].problem)['wait_for_solve'])
            self.assertTrue(flags(capture.loaded.workspace_problem)['wait_for_solve'])

    def test_scene_ir_inherits_false_from_previous_active_stage(self):
        from fullmag.runtime.scene_document_ir import _capture_scene_document
        sources = [sequence((True, False), (True, True), (True, False)),
                   BASE + "study.interactive(True)\nstudy.wait_for_solve(False)\n"
                   "study.stages.add_save_state(artifact_name='snapshot')\n"
                   "study.stages.add_run(until=1e-12)\n"]
        for text, workspace_wait in [(sources[0], None), (sources[1], None), (sources[0], False)]:
            with self.subTest(action_first='add_save_state' in text, workspace_wait=workspace_wait):
                loaded = self.load(text)
                scene = build_scene_document_from_builder(export_builder_draft(loaded))
                scene['study'].pop('wait_for_solve')
                if workspace_wait is False:
                    scene['study']['wait_for_solve'] = False
                    scene['study']['stages'][0].pop('wait_for_solve', None)
                    scene['study']['study_pipeline']['nodes'][0]['payload'].pop('wait_for_solve', None)
                scene['study']['stages'][1].pop('wait_for_solve', None)
                scene['study']['study_pipeline']['nodes'][1]['payload'].pop('wait_for_solve', None)
                with _capture_scene_document(scene, requested_backend='fdm', requested_device='cpu',
                        requested_precision='double', requested_mode='strict', source_root=self.root,
                        include_authored_stages=True, include_legacy_relax_stages=True) as capture:
                    self.assertEqual([flags(stage.problem)['wait_for_solve'] for stage in capture.loaded.stages],
                                     [False, False])
                    self.assertIs(flags(capture.loaded.workspace_problem)['wait_for_solve'], workspace_wait is None)

    def test_action_stage_restores_flags_before_early_continue(self):
        self.assert_roundtrip(BASE + "study.interactive(True)\n"
            "study.wait_for_solve(False)\nstudy.stages.add_run(until=1e-12)\n"
            "study.interactive(False)\nstudy.wait_for_solve(False)\n"
            "study.stages.add_save_state(artifact_name='snapshot')\n"
            "study.interactive(True)\nstudy.wait_for_solve(False)\n")

    def test_real_material_mutation_remains_rejected(self):
        loaded = self.load(BASE + "study.stages.add_run(until=1e-12)\nfilm.Ms = 600e3\nstudy.stages.add_run(until=2e-12)\n")
        with self.assertRaises(ValueError):
            render_loaded_problem_as_script(loaded)


if __name__ == '__main__':
    unittest.main()
