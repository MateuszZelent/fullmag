"""Interpreted lead intent/round-trip checks; no native solve or LLG qualification."""
from __future__ import annotations

import argparse
import copy
from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from verify_antenna_external_lead_preparation import LeadPreparationChecks


class LeadAuthoringChecks(unittest.TestCase):
    storage_root: Path

    @staticmethod
    def intent():
        import fullmag as fm

        return fm.ExternalLeadPreparation(
            revision="authored-r1", extensions=LeadPreparationChecks.extensions(),
            drives=LeadPreparationChecks.drives(),
        )

    def transport(self, **changes):
        import fullmag as fm

        values = dict(
            name="authored-current", model="ohmic_poisson", domain=[fm.RegionRef("device")],
            materials=[fm.ChargeTransportMaterialAssignment(fm.RegionRef("device"), fm.ChargeTransportMaterial(4e7))],
            gauge=fm.ChargePotentialGauge("terminal_reference"),
            solver=fm.ChargeSolverPolicy(operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
            external_lead_preparation=self.intent(),
        )
        values.update(changes)
        return fm.CurrentTransport(**values)

    def test_declaration_is_public_immutable_and_geometry_light(self):
        import fullmag as fm
        from fullmag.meshing._antenna_external_lead_preparation import TerminalLeadExtension

        self.assertIs(TerminalLeadExtension, fm.TerminalLeadExtension)
        intent = self.intent()
        self.assertIs(copy.deepcopy(intent), intent)
        payload = intent.to_ir()
        self.assertEqual(payload["kind"], "isolated_branch_straight_stubs")
        self.assertEqual(set(payload), {"schema_version", "kind", "revision", "extensions", "drives"})
        self.assertNotIn("lead_mesh", payload)
        payload["extensions"][0]["length_m"] = 9.
        self.assertEqual(intent.extensions[0].length_m, 0.4e-6)
        with self.assertRaises(TypeError):
            intent.drives[0].outer_terminal_currents_a["left"] = 42.

    def test_decoder_and_script_expression_round_trip_with_default_layers(self):
        import fullmag as fm
        from fullmag.runtime.scene_document import _decode_external_lead_preparation, _decode_current_transport
        from fullmag.runtime.script_builder import _render_external_lead_preparation_payload

        raw = json.loads(json.dumps(self.intent().to_ir()))
        raw["extensions"][0].pop("layers")
        intent = _decode_external_lead_preparation(raw)
        expression = _render_external_lead_preparation_payload(raw)
        self.assertEqual(eval(expression, {"fm": fm}).to_ir(), intent.to_ir())
        transport = self.transport()
        self.assertEqual(_decode_current_transport(transport.to_ir()).to_ir(), transport.to_ir())

    def test_unknown_missing_and_foreign_fields_are_rejected(self):
        from fullmag.runtime.scene_document import _decode_external_lead_preparation

        for mutation in (
            lambda raw: raw.update(lead_mesh={}),
            lambda raw: raw.pop("revision"),
            lambda raw: raw.update(kind="closed_circuit"),
            lambda raw: raw["extensions"][0].update(solved_digest="fake"),
            lambda raw: raw["extensions"][0].pop("length_m"),
            lambda raw: raw["drives"][0].update(current_density=1.),
        ):
            raw = self.intent().to_ir()
            mutation(raw)
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                _decode_external_lead_preparation(raw)

    def test_oversized_scene_input_is_refused_before_typed_construction(self):
        from fullmag.runtime.scene_document import _decode_external_lead_preparation

        class OversizedList(list):
            def __len__(self):
                return 4 * (1 << 20) + 1

        class OversizedMap(dict):
            def __len__(self):
                return 4 * (1 << 20) + 1

        for field in ("extensions", "drives", "markers", "currents"):
            raw = self.intent().to_ir()
            if field == "extensions":
                raw[field] = [raw[field][0]] * 129
            elif field == "drives":
                raw[field] = OversizedList(raw[field])
            elif field == "markers":
                raw["extensions"][0]["boundary_markers"] = OversizedList([11])
            else:
                raw["drives"][0]["outer_terminal_currents_a"] = OversizedMap({"left": -1., "right": 1.})
            with self.subTest(field=field), patch(
                "fullmag.runtime.scene_document.TerminalLeadExtension", side_effect=AssertionError("late bound check")
            ), patch("fullmag.runtime.scene_document.CurrentSourceDrive", side_effect=AssertionError("late bound check")):
                with self.assertRaisesRegex(ValueError, "before construction"):
                    _decode_external_lead_preparation(raw)

    def test_declaration_refuses_ambiguous_identity_controls_and_selectors(self):
        import fullmag as fm

        intent = self.intent()
        for extensions, drives in (
            (intent.extensions[:1], intent.drives),
            ((intent.extensions[0], replace(intent.extensions[1], id="left")), intent.drives),
            ((intent.extensions[0], replace(intent.extensions[1], observation_id="observe-left")), intent.drives),
            ((intent.extensions[0], replace(intent.extensions[1], boundary_markers=(11,))), intent.drives),
            (intent.extensions, (intent.drives[0], intent.drives[0])),
            (intent.extensions, (fm.CurrentSourceDrive("drive", "port", {"left": 1.}),)),
        ):
            with self.subTest(extensions=extensions, drives=drives), self.assertRaises(ValueError):
                fm.ExternalLeadPreparation(revision="r1", extensions=extensions, drives=drives)
        for name, value in (("length_m", True), ("conductivity_spm", float("inf")),
                            ("layers", 2.0), ("outward_direction_xyz", (2., 0., 0.)),
                            ("boundary_markers", (True,)), ("object_id", "\x00")):
            with self.subTest(name=name), self.assertRaises(ValueError):
                replace(intent.extensions[0], **{name: value})

    def test_static_complete_transport_contract_and_exclusivity(self):
        import fullmag as fm

        for changes in (
            {"coupling": "bidirectional"}, {"time_envelope": fm.ConstantEnvelope(1.0)},
            {"gauge": fm.ChargePotentialGauge("zero_mean")},
            {"solver": fm.ChargeSolverPolicy()}, {"external_lead_preparation": {}},
            {"domain": [fm.RegionRef("foreign")]},
            {"conservative_current_source": self.intent().prepare(device_mesh=LeadPreparationChecks.box_mesh()).source},
        ):
            with self.subTest(changes=changes), self.assertRaises((ValueError, TypeError)):
                self.transport(**changes)
        self.assertEqual(self.transport().to_ir()["boundaries"], [])

    def test_actual_preparation_matches_existing_owner_without_mutating_intent(self):
        from fullmag.meshing._antenna_external_lead_preparation import prepare_antenna_external_lead_source

        mesh = LeadPreparationChecks.box_mesh(taper=0.6)
        intent = self.intent()
        before = intent.to_ir()
        prepared = intent.prepare(device_mesh=mesh)
        reference = prepare_antenna_external_lead_source(
            device_mesh=mesh, extensions=intent.extensions, drives=intent.drives, revision=intent.revision,
        )
        self.assertEqual(prepared.source.to_ir(), reference.source.to_ir())
        self.assertEqual(dict(prepared.receipt), dict(reference.receipt))
        self.assertEqual(intent.to_ir(), before)
        self.assertEqual(prepared.receipt["field_scope"], "external_electrode_truncation")
        self.assertFalse(any(prepared.receipt["capabilities"].values()))
        with self.assertRaisesRegex(ValueError, "requires retained"):
            intent.prepare(device_mesh=replace(mesh, vertex_identity=None))

    def test_actual_mesh_component_balance_is_not_replaced_by_global_balance(self):
        import fullmag as fm

        extensions = LeadPreparationChecks.extensions(second=True)
        currents = {"left": -1., "right": 0., "left-2": 1., "right-2": 0.}
        intent = fm.ExternalLeadPreparation(revision="r1", extensions=extensions,
            drives=[fm.CurrentSourceDrive("drive", "port", currents)])
        with self.assertRaisesRegex(ValueError, "imbalance in an electrical component"):
            intent.prepare(device_mesh=LeadPreparationChecks.box_mesh(second=True))

    def test_full_scene_script_ir_round_trip_never_meshes_during_capture(self):
        import fullmag as fm
        from fullmag.runtime.loader import load_problem_from_script
        from fullmag.runtime.scene_document import build_scene_document_from_builder
        from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir
        from fullmag.runtime.script_builder import export_builder_draft, render_scene_document_as_script, _render_current_transport_payload

        fragment = _render_current_transport_payload(self.transport().to_ir(), surface="flat")
        source = (
            "import fullmag as fm\n"
            "study = fm.study('lead-authoring')\n"
            "study.engine('fem')\nstudy.device('cpu', precision='double')\n"
            "study.disable_demag()\n"
            "film = study.geometry(fm.Box(100e-9,20e-9,10e-9), name='film', object_id='film-id')\n"
            "film.Ms=800e3\nfilm.Aex=13e-12\nfilm.alpha=0.01\n"
            "study.antenna_object(fm.Box(100e-9,20e-9,5e-9), name='Readable antenna', object_id='device')\n"
            + fragment + "\n"
        )
        with tempfile.TemporaryDirectory(dir=self.storage_root) as directory:
            path = Path(directory) / "authoring.py"
            path.write_text(source, encoding="utf-8")
            with patch("fullmag.meshing._gmsh_generators._generate_csg_mesh", side_effect=AssertionError("capture must not mesh")):
                loaded = load_problem_from_script(path, lightweight_assets=True)
                scene = build_scene_document_from_builder(export_builder_draft(loaded))
                rendered = render_scene_document_as_script(scene)
                path.write_text(rendered, encoding="utf-8")
                reloaded = load_problem_from_script(path, lightweight_assets=True)
                ir = scene_document_to_problem_ir(scene, requested_backend="fem", requested_device="cpu",
                    requested_precision="double", requested_mode="strict", source_root=self.storage_root)
            for module in (loaded.problem.current_modules[0], reloaded.problem.current_modules[0]):
                self.assertEqual(module.external_lead_preparation.to_ir(), self.intent().to_ir())
            self.assertEqual(ir["current_modules"][0]["external_lead_preparation"], self.intent().to_ir())
            self.assertFalse(ir.get("geometry_assets"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--storage-root", type=Path, required=True)
    args = parser.parse_args()
    if not args.storage_root.is_absolute() or not args.storage_root.is_dir():
        parser.error("--storage-root must be an existing absolute configured storage directory")
    sys.path.insert(0, str(args.repo_root / "packages/fullmag-py/src"))
    LeadAuthoringChecks.storage_root = args.storage_root.resolve(strict=True)
    # Rendering owns a temporary capture script: keep it in approved task storage.
    tempfile.tempdir = str(LeadAuthoringChecks.storage_root)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LeadAuthoringChecks))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
