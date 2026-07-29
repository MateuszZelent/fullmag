from __future__ import annotations

import copy
import csv
import hashlib
import json
import math
from pathlib import Path
import tempfile
import unittest

from scripts.verify_fem_mixed_prism_airbox_runtime import (
    ContractError,
    prepare_bounded_scenario,
    validate_runtime_artifacts,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


class MixedPrismAirboxRuntimeVerifierTest(unittest.TestCase):
    def test_prepare_replaces_exactly_one_step_limit_without_mutating_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "scenario.py"
            output = root / "bounded.py"
            original = "study.stages.add_relax(\n    max_steps=50_000,\n)\n"
            source.write_text(original, encoding="utf-8")

            evidence = prepare_bounded_scenario(source, output)

            self.assertEqual(source.read_text(encoding="utf-8"), original)
            self.assertEqual(
                output.read_text(encoding="utf-8"),
                original.replace("max_steps=50_000", "max_steps=1"),
            )
            self.assertEqual(evidence["replacement_count"], 1)
            self.assertEqual(evidence["bounded_max_steps"], 1)

    def test_prepare_fails_closed_for_zero_or_multiple_canonical_limits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, source_text in (
                ("zero", "max_steps=32\n"),
                ("multiple", "max_steps=50_000\nmax_steps=50_000\n"),
            ):
                source = root / f"{name}.py"
                output = root / f"{name}.bounded.py"
                source.write_text(source_text, encoding="utf-8")
                with self.subTest(name=name), self.assertRaisesRegex(
                    ContractError, "exactly one"
                ):
                    prepare_bounded_scenario(source, output)
                self.assertFalse(output.exists())

    def test_prepare_exact_sp4_source_changes_only_the_authored_step_limit(self) -> None:
        source = (
            REPO_ROOT
            / "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py"
        )
        with tempfile.TemporaryDirectory() as directory:
            bounded = Path(directory) / "bounded.py"

            evidence = prepare_bounded_scenario(source, bounded)

            expected = source.read_text(encoding="utf-8").replace(
                "max_steps=50_000", "max_steps=1", 1
            )
            self.assertEqual(bounded.read_text(encoding="utf-8"), expected)
            self.assertEqual(evidence["replacement_count"], 1)
            self.assertEqual(
                evidence["canonical_source_sha256"],
                hashlib.sha256(source.read_bytes()).hexdigest(),
            )

    def _write_valid_bundle(
        self, root: Path
    ) -> tuple[Path, Path, Path, dict[str, object]]:
        source = root / "scenario.py"
        bounded = root / "bounded.py"
        artifacts = root / "artifacts"
        artifacts.mkdir()
        source.write_text("max_steps=50_000\n", encoding="utf-8")
        bounded_text = "max_steps=1\n"
        bounded.write_text(bounded_text, encoding="utf-8")
        fingerprint = "sha256:" + "a" * 64
        certificate = {
            "schema_version": "mixed_layer_topology_certificate.v1",
            "certificate_status": "accepted",
            "topology_fingerprint": fingerprint,
            "fallbacks_triggered": [],
        }
        report = {
            "build_mode": "shared_domain",
            "fallbacks_triggered": [],
            "degraded": False,
            "mixed_layer_topology_certificate": certificate,
            "mixed_topology_provenance": {
                "requested_topology": "mixed_p1",
                "resolved_topology": "mixed_p1",
                "accepted_certificate_fingerprint": fingerprint,
                "requested_device": "cpu",
                "precision": "double",
                "capability_status": "implemented",
            },
        }
        metadata: dict[str, object] = {
            "problem_name": "mumag_sp4_fem_relax_projected_gradient_bb",
            "source_hash": hashlib.sha256(bounded_text.encode()).hexdigest(),
            "problem_meta": {
                "runtime_metadata": {
                    "runtime_selection": {"device": "auto"},
                    "model_builder": {
                        "problem": {"runtime": {"device": "auto"}}
                    },
                    "runtime_device_override": {
                        "device": "cpu",
                        "source": "managed_launcher",
                    },
                }
            },
            "requested_execution": {
                "backend": "fem",
                "device": "cpu",
                "precision": "double",
                "mode": "strict",
                "fallback_policy": "forbidden",
            },
            "execution_provenance": {
                "execution_engine": "fem_cpu_native",
                "precision": "double",
                "lossy_fallback_used": False,
                "ignored_terms": [],
            },
            "mesh": {
                "topology_fingerprint": fingerprint,
                "mesh_build_report": report,
            },
            "fem_cpu_relaxation_qualification": {
                "schema_version": "fem_cpu_relaxation_qualification.v1",
                "relaxation_algorithm": "projected_gradient_bb",
                "executed_steps": 1,
                "final_energy_terms_j": {
                    "E_ex": 1.0,
                    "E_demag": 2.0,
                    "E_ext": 0.0,
                    "e_drive": 0.0,
                    "E_ani": 0.0,
                    "E_dmi": 0.0,
                    "E_total": 3.0,
                },
                "final_torque_apm": 4.0,
                "final_torque_t": 5.0e-6,
            },
        }
        (artifacts / "metadata.json").write_text(
            json.dumps(metadata), encoding="utf-8"
        )
        with (artifacts / "scalars.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(
                stream,
                fieldnames=["step", "E_ex", "E_demag", "E_total", "max_torque_T"],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "step": 1,
                    "E_ex": 1.0,
                    "E_demag": 2.0,
                    "E_total": 3.0,
                    "max_torque_T": 5.0e-6,
                }
            )
        (artifacts / "m_final.json").write_text(
            json.dumps({"values": [[1.0, 0.0, 0.0]]}), encoding="utf-8"
        )
        return source, bounded, artifacts, metadata

    def test_validate_accepts_exact_cpu_mixed_runtime_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source, bounded, artifacts, _metadata = self._write_valid_bundle(
                Path(directory)
            )

            summary = validate_runtime_artifacts(source, bounded, artifacts)

            self.assertEqual(summary["schema_version"], "fem_mixed_prism_airbox_runtime.v1")
            self.assertEqual(summary["execution_engine"], "fem_cpu_native")
            self.assertEqual(summary["executed_steps"], 1)
            self.assertEqual(summary["fallbacks_triggered"], [])
            self.assertEqual(summary["qualification_status"], "implemented")

    def test_validate_rejects_each_identity_fallback_and_numeric_violation(self) -> None:
        def mutate(metadata: dict[str, object], case: str) -> None:
            runtime = metadata["problem_meta"]["runtime_metadata"]  # type: ignore[index]
            provenance = metadata["execution_provenance"]  # type: ignore[assignment]
            mesh = metadata["mesh"]  # type: ignore[assignment]
            report = mesh["mesh_build_report"]  # type: ignore[index]
            certificate = report["mixed_layer_topology_certificate"]  # type: ignore[index]
            qualification = metadata["fem_cpu_relaxation_qualification"]  # type: ignore[assignment]
            if case == "authored_device":
                runtime["runtime_selection"]["device"] = "cpu"
            elif case == "override_source":
                runtime["runtime_device_override"]["source"] = "script"
            elif case == "effective_device":
                metadata["requested_execution"]["device"] = "gpu"  # type: ignore[index]
            elif case == "engine":
                provenance["execution_engine"] = "fem_native_gpu"
            elif case == "resolved_fallback":
                provenance["resolved_fallback"] = {"occurred": True}
            elif case == "report_fallback":
                report["fallbacks_triggered"] = ["tet_conversion"]
            elif case == "degraded":
                report["degraded"] = True
            elif case == "certificate_fingerprint":
                certificate["topology_fingerprint"] = "sha256:" + "b" * 64
            elif case == "steps":
                qualification["executed_steps"] = 2
            elif case == "energy":
                qualification["final_energy_terms_j"]["E_total"] = math.nan
            elif case == "torque":
                qualification["final_torque_t"] = math.inf
            else:
                raise AssertionError(case)

        for case in (
            "authored_device",
            "override_source",
            "effective_device",
            "engine",
            "resolved_fallback",
            "report_fallback",
            "degraded",
            "certificate_fingerprint",
            "steps",
            "energy",
            "torque",
        ):
            with tempfile.TemporaryDirectory() as directory:
                source, bounded, artifacts, metadata = self._write_valid_bundle(
                    Path(directory)
                )
                mutated = copy.deepcopy(metadata)
                mutate(mutated, case)
                (artifacts / "metadata.json").write_text(
                    json.dumps(mutated), encoding="utf-8"
                )
                with self.subTest(case=case), self.assertRaises(ContractError):
                    validate_runtime_artifacts(source, bounded, artifacts)

    def test_just_recipe_uses_exact_scenario_and_existing_managed_cpu_path(self) -> None:
        justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
        recipe = justfile.split(
            "verify-fem-mixed-prism-airbox-runtime:", 1
        )[1].split("\nverify-fem-mixed-p1-native-contract:", 1)[0]
        self.assertIn(
            "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py",
            recipe,
        )
        self.assertIn("just fem-managed-headless cpu", recipe)
        self.assertIn("verify_fem_mixed_prism_airbox_runtime.py prepare", recipe)
        self.assertIn("verify_fem_mixed_prism_airbox_runtime.py validate", recipe)
        self.assertNotIn("--skip-geometry-assets", recipe)
        self.assertNotIn("FULLMAG_RUN_SLOW_REAL_ASSET_TESTS", recipe)


if __name__ == "__main__":
    unittest.main()
