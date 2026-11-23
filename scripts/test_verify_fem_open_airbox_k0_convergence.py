from __future__ import annotations

import ast
import hashlib
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import verify_fem_open_airbox_k0_convergence as verifier
import prepare_fem_open_airbox_k0_convergence as preparer


class OpenAirboxConvergenceVerifierTests(unittest.TestCase):
    def _complete_window_evidence(self):
        frequencies = [0.5e9 + index * 0.4e9 for index in range(17)]
        schedule = lambda pass_name: {
            "pass": pass_name,
            "subwindow_index": 0,
            "status": "ok",
            "accepted_frequencies_hz": frequencies,
        }
        complete_schedule = {
            "state": "completed",
            "planned_subwindow_count": 1,
            "completed_subwindow_count": 1,
            "failed_subwindow_count": 0,
            "cancelled": False,
        }
        certificate = {
            "schema_version": "poisson_airbox_frequency_window_certificate.v2",
            "status": "certified",
            "spectrum_scope": "complete_window",
            "window_complete": True,
            "requested_min_hz": 1.0,
            "requested_max_hz": 8.0e9,
            "requested_mode_count": 17,
            "accepted_mode_count": 17,
            "discovered_mode_count": 17,
            "count_certificate": {
                "status": "certified",
                "method": "hermitian_ldl_inertia",
                "count": 17,
            },
            "search_stability": {
                "status": "stable",
                "requested_cluster_limit_covered": True,
            },
            "coverage_margins_hz": {"lower": 1.0, "upper": 1.0},
            "accepted_cluster_frequencies_hz": frequencies,
            "cluster_ranks": [1] * 17,
            "base_schedule": dict(complete_schedule),
            "refinement_schedule": dict(complete_schedule),
            "base_schedule_summary_ref": "executed_subwindows_json#pass=base",
            "refinement_schedule_summary_ref": "executed_subwindows_json#pass=refinement",
        }
        solver = {
            "target_kind": "frequency_window",
            "window_complete": True,
            "requested_window_hz": [1.0, 8.0e9],
            "requested_mode_count": 17,
            "accepted_mode_count": 17,
            "window_certificate": certificate,
            "subwindows": [schedule("base"), schedule("refinement")],
        }
        modes = [
            {"frequency_hz": frequency, "raw_mode_index": index}
            for index, frequency in enumerate(frequencies)
        ]
        return solver, modes

    def test_augmented_window_verifies_partition_and_saved_modes(self) -> None:
        solver, modes = self._complete_window_evidence()
        solver["solver_adapter"] = "k0_poisson_airbox_gpu_augmented_cudss"
        solver["window_certificate"] = {
            "schema_version": "poisson_airbox_augmented_inertia_window_certificate.v1",
            "status": "certified",
            "window_complete": True,
            "requested_min_hz": 1.0,
            "requested_max_hz": 8.0e9,
            "negative_at_origin": 33408,
            "negative_at_lower": 33408,
            "negative_at_upper": 33425,
            "certified_count": 17,
            "partition": [
                {
                    "lower_hz": 1.0, "upper_hz": 2.0e9,
                    "negative_at_lower": 33408, "negative_at_upper": 33412,
                    "accepted_count": 4,
                },
                {
                    "lower_hz": 2.0e9, "upper_hz": 8.0e9,
                    "negative_at_lower": 33412, "negative_at_upper": 33425,
                    "accepted_count": 13,
                },
            ],
        }
        def qualify():
            return verifier.window_completeness(
                solver, [1.0, 8.0e9], expected_mode_count=17, saved_modes=modes
            )
        self.assertEqual(qualify()["status"], "certified")
        solver["window_certificate"]["partition"][1]["lower_hz"] += 1
        self.assertIn("certified interval 1 breaks the inertia partition", qualify()["proof_errors"])
        solver["window_certificate"]["partition"][1]["lower_hz"] -= 1
        solver["window_certificate"]["partition"][0]["accepted_count"] = True
        self.assertEqual(qualify()["status"], "unproven")
        solver["window_certificate"]["partition"][0]["accepted_count"] = 4
        modes[0]["frequency_hz"] = 9.0e9
        self.assertEqual(qualify()["status"], "unproven")

    def test_generation_member_must_match_consumed_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "mode_0000.json"
            first = b'{"frequency_hz":1}'
            digest = hashlib.sha256(first).hexdigest()
            members = {path.name: {"byte_length": len(first), "sha256": f"sha256:{digest}"}}
            path.write_bytes(first)
            mode, verified_digest = verifier.load_generation_json(root, members, path.name, "mode")
            self.assertEqual(mode["frequency_hz"], 1)
            self.assertEqual(verified_digest, digest)
            path.write_bytes(b'{"frequency_hz":2}')
            with self.assertRaisesRegex(verifier.VerificationError, "differs from its generation member"):
                verifier.load_generation_json(root, members, path.name, "mode")

    def test_kittel_reference_derives_from_explicit_fullmag_gamma(self) -> None:
        identity = preparer._kittel_input_identity(4.0, 8.0)
        reference = identity["analytic_reference"]
        gamma0 = 221_100.0
        mu0 = 4.0e-7 * 3.141592653589793
        expected = gamma0 / (2.0 * 3.141592653589793 * mu0) * 0.1

        self.assertEqual(identity["gyromagnetic_ratio_m_per_a_s"], gamma0)
        self.assertEqual(reference["gyromagnetic_ratio_m_per_a_s"], gamma0)
        self.assertEqual(reference["mu0_T_m_per_A"], mu0)
        self.assertAlmostEqual(reference["expected_frequency_hz"], expected, places=6)
        self.assertAlmostEqual(expected, 2_800_264_212.9151104, places=5)

    def test_staging_and_verifier_use_the_same_tree_identity_encoding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "nested").mkdir()
            (root / "nested" / "input.bin").write_bytes(b"identity\x00bytes")
            self.assertEqual(
                verifier.tree_sha256(root)["tree_sha256"],
                preparer.tree_identity(root)["tree_sha256"],
            )

    def test_container_campaign_root_is_bound_to_declared_script_output_mount(self) -> None:
        manifest = {
            "source": {
                "container_output_root": "/opt/fullmag/script-output",
                "script_output_root_relative": "examples",
                "campaign_root_relative": "examples/.fullmag-tmp/campaign-a",
            }
        }
        self.assertEqual(
            str(verifier.expected_container_campaign_root(manifest)),
            "/opt/fullmag/script-output/.fullmag-tmp/campaign-a",
        )
        manifest["source"]["campaign_root_relative"] = "../outside"
        with self.assertRaises(verifier.VerificationError):
            verifier.expected_container_campaign_root(manifest)

    def test_staged_metric_path_must_stay_inside_the_campaign(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "inputs").mkdir()
            (root / "inputs" / "metric.json").write_text("{}", encoding="utf-8")
            self.assertEqual(
                verifier.resolve_campaign_entry(
                    root,
                    "inputs/metric.json",
                    "test metric",
                    expected_kind="file",
                ),
                root / "inputs" / "metric.json",
            )
            with self.assertRaises(verifier.VerificationError):
                verifier.resolve_campaign_entry(
                    root,
                    "../outside.json",
                    "test metric",
                    expected_kind="file",
                )

    def test_checkpoint_descriptor_identity_is_a_pinned_input_subset(self) -> None:
        identity = {
            "equilibrium_artifact_content_sha256": "sha256:content",
            "equilibrium_artifact_file_sha256": "file-sha256",
            "equilibrium_step": 8006,
            "equilibrium_tree_sha256": "tree-sha256",
            "input_mesh_sha256": "mesh-sha256",
            "magnetization_f64le_sha256": "m0-sha256",
            "native_mesh_topology_sha256": "sha256:topology",
            "node_count": 100,
            "reference_mesh_mass_metric": {"node_mass_weights_sha256": "weights"},
        }
        case = {"checkpoint_identity": dict(identity)}
        run = {"input_identity": {**identity, "physics": {"operator": "full_2x2"}}}
        self.assertTrue(verifier.checkpoint_descriptor_matches_run(case, run))
        run["input_identity"]["input_mesh_sha256"] = "different-mesh"
        self.assertFalse(verifier.checkpoint_descriptor_matches_run(case, run))

    def test_staged_templates_keep_scene_document_stdout_clean(self) -> None:
        examples = ROOT / "examples"
        for name in (
            "fem_eigen_k0_open_airbox_sphere_matrix_case.py",
            "fem_eigen_k0_open_airbox_checkpoint_repeat_case.py",
        ):
            with self.subTest(template=name):
                tree = ast.parse((examples / name).read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if not isinstance(node, ast.Call):
                        continue
                    if not isinstance(node.func, ast.Name) or node.func.id != "print":
                        continue
                    file_arg = next(
                        (keyword.value for keyword in node.keywords if keyword.arg == "file"),
                        None,
                    )
                    self.assertIsNotNone(file_arg, f"stdout print in {name}")
                    self.assertEqual(
                        ast.unparse(file_arg),
                        "sys.stderr",
                        f"non-stderr print in {name}",
                    )

    def test_staged_templates_use_relative_case_output_for_alias_binding(self) -> None:
        examples = ROOT / "examples"
        for name in (
            "fem_eigen_k0_open_airbox_sphere_matrix_case.py",
            "fem_eigen_k0_open_airbox_checkpoint_repeat_case.py",
        ):
            with self.subTest(template=name):
                source = (examples / name).read_text(encoding="utf-8")
                self.assertIn('output_dir=case["output_directory_name"]', source)
                self.assertNotIn('output_dir=case["container_output_path"]', source)

    def test_checkpoint_template_uses_pinned_gyromagnetic_ratio(self) -> None:
        source = (
            ROOT / "examples/fem_eigen_k0_open_airbox_checkpoint_repeat_case.py"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'study.solver(gamma=float(case["input_identity"]["gyromagnetic_ratio_m_per_a_s"]))',
            source,
        )

    def test_managed_commands_use_existing_cli_backend_and_pinned_mount_paths(self) -> None:
        text = preparer.managed_run_commands(
            source_root=Path("/repo/worktree"),
            campaign_root=Path("/repo/worktree/examples/.fullmag-tmp/campaign-a"),
            port=3395,
            runs=[
                {
                    "case_id": "kittel_smoke",
                    "execution_device": "gpu",
                    "script_container_path": (
                        "/opt/fullmag/script-output/.fullmag-tmp/campaign-a/"
                        "runs/kittel_smoke.py"
                    ),
                    "output_container_path": (
                        "/opt/fullmag/script-output/.fullmag-tmp/campaign-a/"
                        "runs/kittel_smoke.zarr"
                    ),
                }
            ],
        )

        self.assertIn('label=com.docker.compose.project=$project', text)
        self.assertIn('label=com.docker.compose.service=backend', text)
        self.assertIn('"$backend" /opt/fullmag/package/bin/fullmag-bin', text)
        self.assertIn("docker exec -w /opt/fullmag/source", text)
        self.assertIn("FULLMAG_API_PORT=0", text)
        self.assertIn("FULLMAG_FEM_EXECUTION=gpu", text)
        self.assertIn("--output-dir /opt/fullmag/script-output/", text)
        self.assertIn("--workspace-root /opt/fullmag/script-output/", text)
        self.assertNotIn("run-script", text)
        self.assertNotIn("docker-dev-toolchain", text)

    def test_checkpoint_observation_requires_zero_step_and_exact_magnetization(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = root / "artifacts/antenna/accepted_equilibria/source/relax_receipt.v3.json"
            receipt.parent.mkdir(parents=True)
            mesh = "sha256:" + "a" * 64
            initial = [[1.0, 0.0, 0.0]]
            payload = {
                "schema_version": "AcceptedFemRelaxStageHandoff.v3",
                "source_stage_kind": "flat_relax",
                "source_mesh_topology_sha256": mesh,
                "equilibrium_magnetization": initial,
                "completion": {
                    "status": "completed", "converged": True,
                    "reason": "torque", "metric": "max_torque_apm",
                    "metric_value": 0.7, "threshold": 0.7957747154594766,
                },
            }
            receipt.write_text(json.dumps(payload))
            certificate = receipt.with_name("recomputed_certificate.v1.json")
            certificate.write_text(json.dumps({
                "status": "matched", "mesh_topology_sha256": mesh,
                "recompute_provider": "native_fem_final_state_refresh.v1",
            }))
            samples = root / "stages/stage_00_flat_relax/fields/m.zarr/samples.csv"
            samples.parent.mkdir(parents=True)
            samples.write_text("sample,step\n0,0\n")
            expected = {
                "node_count": 1,
                "native_mesh_topology_sha256": mesh,
                "magnetization_f64le_sha256": hashlib.sha256(
                    struct.pack("<3d", *initial[0])
                ).hexdigest(),
            }
            proof = verifier.verify_zero_step_checkpoint_observation(root, expected)
            self.assertEqual(proof["accepted_steps"], 0)
            self.assertEqual(proof["magnetization_f64le_sha256"],
                             expected["magnetization_f64le_sha256"])

            samples.write_text("sample,step\n0,1\n")
            with self.assertRaisesRegex(verifier.VerificationError, "step zero"):
                verifier.verify_zero_step_checkpoint_observation(root, expected)
            samples.write_text("sample,step\n0,0\n")
            payload["equilibrium_magnetization"] = [[0.0, 1.0, 0.0]]
            receipt.write_text(json.dumps(payload))
            with self.assertRaisesRegex(verifier.VerificationError, "magnetization"):
                verifier.verify_zero_step_checkpoint_observation(root, expected)

    def test_gpu_checkpoint_uses_the_sealed_stage_certificate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage = root / "stages/stage_00_flat_relax"
            generation = root / "generation"
            members = {}

            def write(path, payload):
                path.parent.mkdir(parents=True, exist_ok=True)
                data = json.dumps(payload).encode()
                path.write_bytes(data)
                digest = "sha256:" + hashlib.sha256(data).hexdigest()
                if path.is_relative_to(generation):
                    members[path.relative_to(generation).as_posix()] = {
                        "byte_length": len(data), "sha256": digest,
                    }
                return digest

            mesh = "sha256:" + "a" * 64
            magnetization = [[1.0, 0.0, 0.0]]
            expected = {
                "node_count": 1, "native_mesh_topology_sha256": mesh,
                "magnetization_f64le_sha256": verifier.checkpoint_magnetization_sha256(magnetization, 1),
            }
            certificate = {
                "status": "matched", "mesh_topology_sha256": mesh,
                "recompute_provider": "native_fem_final_state_refresh.v1",
                "content_sha256": "sha256:" + "b" * 64,
            }
            member = "eigen/metadata/sample_0000/recomputed_fem_linearization_certificate.v1.json"
            certificate_digest = write(generation / member, certificate)
            certificate_path = stage / "equilibrium/recomputed_fem_linearization_certificate.v1.json"
            write(certificate_path, certificate)
            identity = {
                "schema_version": "linearization_identity.v2",
                "handoff_schema_version": "AcceptedFemRelaxStageHandoff.v3",
                "source_stage_kind": "flat_relax", "source_mesh_topology_sha256": mesh,
                "node_count": 1,
                "content_sha256": "sha256:" + "c" * 64,
                "handoff_content_sha256": "sha256:" + "d" * 64,
                "recomputed_certificate_path": member,
                "recomputed_certificate_bytes_sha256": certificate_digest,
                "recomputed_certificate_content_sha256": certificate["content_sha256"],
            }
            write(generation / "eigen/metadata/sample_0000/linearization_identity.v2.json", identity)
            write(stage / "metadata.json", {
                "accepted_solver_steps": 1,
                "execution_provenance": {
                    "execution_engine": "fem_native_gpu", "precision": "double",
                    "fem_gpu_minimizer_execution_receipt": {
                        "schema_version": "fullmag.fem.gpu.minimizer-execution-receipt.v1",
                        "accounting": {
                            "executed": "cuda_fem_initial_equilibrium", "accepted_step_count": 0,
                            "fallback_count": 0, "accounting_valid": True,
                        },
                    },
                },
                "completion": {
                    "status": "completed", "converged": True, "reason": "torque",
                    "metric": "max_torque_apm", "metric_value": 0.7, "threshold": 0.79,
                },
            })
            write(stage / "m_final.json", {"step": 0, "values": magnetization})
            samples = stage / "fields/m.zarr/samples.csv"
            samples.parent.mkdir(parents=True)
            samples.write_text("sample,step\n0,0\n")
            artifacts = {
                "generation_path": generation, "generation_members": members,
                "solver": {
                    "linearization_identity_sha256": identity["content_sha256"],
                    "relax_to_eigen_handoff_sha256": identity["handoff_content_sha256"],
                },
            }
            proof = verifier.verify_zero_step_checkpoint_observation(root, expected, gpu_artifacts=artifacts)
            self.assertEqual(proof["certificate_file_sha256"], certificate_digest.removeprefix("sha256:"))
            write(certificate_path, {**certificate, "status": "wrong"})
            with self.assertRaisesRegex(verifier.VerificationError, "differs from the sealed"):
                verifier.verify_zero_step_checkpoint_observation(root, expected, gpu_artifacts=artifacts)

    def test_cli_artifact_root_accepts_one_nested_generation_and_rejects_ambiguity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            nested = root / "artifacts"
            marker = nested / "artifacts/frequency_domain/generation.v2.json"
            marker.parent.mkdir(parents=True)
            marker.write_text("{}", encoding="utf-8")
            self.assertEqual(verifier.resolve_cli_artifact_root(root), nested)

            direct_marker = root / "artifacts/frequency_domain/generation.v2.json"
            direct_marker.parent.mkdir(parents=True)
            direct_marker.write_text("{}", encoding="utf-8")
            with self.assertRaises(verifier.VerificationError):
                verifier.resolve_cli_artifact_root(root)

    def test_staged_equilibrium_artifact_binds_file_content_completion_and_m0(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact_path = root / "inputs/checkpoint_step_8006/equilibrium_artifact.v7.json"
            artifact_path.parent.mkdir(parents=True)
            m0_bytes = struct.pack("<3d", 1.0, 0.0, 0.0)
            m0_sha256 = hashlib.sha256(m0_bytes).hexdigest()
            content_sha256 = "sha256:" + "a" * 64
            completion_sha256 = "sha256:" + "b" * 64
            artifact = {
                "schema_version": "equilibrium_artifact.v7",
                "accepted_for_linearization": True,
                "equilibrium_id": "equilibrium_artifact.v7:" + "a" * 64,
                "content_sha256": content_sha256,
                "completion_sha256": completion_sha256,
                "m0": [[1.0, 0.0, 0.0]],
                "acceptance_certificate": {
                    "completion_sha256": completion_sha256,
                    "status": "completed",
                    "converged": True,
                    "criterion": "torque",
                    "unit": "A/m",
                    "metric_value": 0.5,
                    "threshold": 1.0,
                },
            }
            artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
            expected = {
                "equilibrium_artifact_path": "inputs/checkpoint_step_8006/equilibrium_artifact.v7.json",
                "equilibrium_artifact_file_sha256": hashlib.sha256(
                    artifact_path.read_bytes()
                ).hexdigest(),
                "equilibrium_artifact_content_sha256": content_sha256,
                "node_count": 1,
                "magnetization_f64le_sha256": m0_sha256,
            }

            result = verifier.verify_staged_equilibrium_artifact(root, expected)

        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["m0_scalar_count"], 3)

    def test_kittel_mode_comparison_requires_equal_canonical_mesh_identity(self) -> None:
        weights = [2.0]
        identity = {
            "mesh_id": "sphere-mesh",
            "mesh_generation_id": "sha256:mesh-generation",
            "topology_fingerprint": "sha256:topology",
            "indexing": "full_domain_node_order",
            "node_count": 2,
        }

        def run(mesh_identity: dict[str, object]) -> dict[str, object]:
            mode = {
                "raw_mode_index": 0,
                "frequency_real_hz": 2.8e9,
                "source_mesh_topology_sha256": "sha256:topology",
                "source_mesh_identity": mesh_identity,
                "q_real": [1.0, 0.0],
                "q_imag": [0.0, 0.0],
            }
            return {
                "_artifacts": {
                    "modes": [mode],
                    "mesh_metric": {
                        "status": "available",
                        "mesh_topology_sha256": "sha256:topology",
                        "active_magnetic_node_count": 1,
                        "node_mass_weights_sha256": preparer.canonical_sha256(weights),
                        "_weights": weights,
                    },
                }
            }

        options = {
            "minimum_overlap": 0.9,
            "maximum_relative_frequency_delta": 1e-3,
            "expected_mode_count": 1,
            "require_canonical_mesh_identity": True,
        }
        equal = verifier.mode_pair_comparison(run(identity), run(identity), **options)
        self.assertTrue(equal["complete"])
        changed = {**identity, "mesh_generation_id": "sha256:other-generation"}
        unequal = verifier.mode_pair_comparison(run(identity), run(changed), **options)
        self.assertFalse(unequal["complete"])
        self.assertIn(
            "CPU/GPU Kittel profiles do not prove canonical cached mesh identity equality",
            unequal["errors"],
        )

    def test_pair_stays_incomplete_when_modes_compare_but_run_proof_is_incomplete(self) -> None:
        identity = {
            "mesh_id": "sphere-mesh",
            "mesh_generation_id": "sha256:mesh-generation",
            "topology_fingerprint": "sha256:topology",
            "indexing": "full_domain_node_order",
            "node_count": 2,
        }
        weights = [2.0]

        def row(case_id: str, device: str, complete: str) -> dict[str, object]:
            mode = {
                "raw_mode_index": 0,
                "frequency_real_hz": 2.8e9,
                "source_mesh_topology_sha256": "sha256:topology",
                "source_mesh_identity": identity,
                "q_real": [1.0, 0.0],
                "q_imag": [0.0, 0.0],
            }
            return {
                "case_id": case_id,
                "pair_id": "pair",
                "family": "kittel_sphere",
                "execution_device_expected": device,
                "input_identity_sha256": "a" * 64,
                "complete": complete,
                "selected": "proven",
                "modal_equilibrium": {"magnetization_f64le_sha256": "b" * 64},
                "_artifacts": {
                    "modes": [mode],
                    "mesh_metric": {
                        "status": "available",
                        "mesh_topology_sha256": "sha256:topology",
                        "active_magnetic_node_count": 1,
                        "node_mass_weights_sha256": preparer.canonical_sha256(weights),
                        "_weights": weights,
                    },
                },
            }

        manifest = {
            "runs": [
                {"case_id": "cpu", "pair_id": "pair", "family": "kittel_sphere", "execution_device": "cpu"},
                {"case_id": "gpu", "pair_id": "pair", "family": "kittel_sphere", "execution_device": "gpu"},
            ],
            "expectations": {"checkpoint_window": {"minimum_positive_mode_count": 17}},
        }
        result = verifier.compare_pairs(
            manifest,
            [row("cpu", "cpu", "complete"), row("gpu", "gpu", "incomplete")],
            {"availability": "unavailable"},
            minimum_overlap=0.9,
            maximum_relative_frequency_delta=1e-3,
        )[0]

        self.assertTrue(result["selected_mode_artifact_comparison_complete"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["status"], "incomplete")

        cpu = row("cpu", "cpu", "complete")
        gpu = row("gpu", "gpu", "complete")
        gpu["modal_equilibrium"]["magnetization_f64le_sha256"] = "c" * 64
        unequal = verifier.compare_pairs(
            manifest, [cpu, gpu], {"availability": "unavailable"},
            minimum_overlap=0.9, maximum_relative_frequency_delta=1e-8,
        )[0]
        self.assertFalse(unequal["complete"])
        self.assertIn("CPU and GPU Kittel equilibria differ", unequal["errors"])
        self.assertIn(
            "CPU/GPU run evidence is incomplete for the requested scientific scope",
            result["errors"],
        )

    def test_checkpoint_overlap_can_use_only_pinned_archive_mass_weights(self) -> None:
        identity = {
            "mesh_id": "checkpoint-mesh",
            "topology_fingerprint": "sha256:topology",
            "indexing": "full_domain_node_order",
            "node_count": 2,
        }
        mode = {
            "raw_mode_index": 0,
            "frequency_real_hz": 2.0e9,
            "source_mesh_topology_sha256": "sha256:topology",
            "source_mesh_identity": identity,
            "q_real": [1.0, 0.0],
            "q_imag": [0.0, 0.0],
        }
        unavailable_metric = {
            "status": "unavailable",
            "mesh_topology_sha256": None,
            "active_magnetic_node_count": None,
            "node_mass_weights_sha256": None,
            "_weights": None,
        }
        run = {
            "_artifacts": {
                "modes": [mode],
                "mesh_metric": unavailable_metric,
            }
        }
        weights = [3.0]
        result = verifier.mode_pair_comparison(
            run,
            run,
            minimum_overlap=0.9,
            maximum_relative_frequency_delta=1e-3,
            expected_mode_count=1,
            frequency_window_hz=[1.0, 8.0e9],
            reference_node_mass_weights=weights,
            reference_mesh_topology_sha256="sha256:topology",
            reference_node_mass_weights_sha256=preparer.canonical_sha256(weights),
        )

        self.assertTrue(result["complete"])
        self.assertEqual(
            result["overlap_weight_reference"],
            "pinned historical CPU archive metric",
        )

    def test_degenerate_profiles_compare_as_invariant_subspaces(self) -> None:
        def mode(reals):
            return {"q_real": reals, "q_imag": [0.0] * len(reals)}

        left = [mode([1.0, 0.0, 0.0, 0.0]), mode([0.0, 1.0, 0.0, 0.0])]
        right = [mode([1.0, 1.0, 0.0, 0.0]), mode([1.0, -1.0, 0.0, 0.0])]
        metric = verifier.modal_subspace_metrics(left, right, [1.0, 1.0])
        self.assertLess(metric["maximum_principal_angle_sine"], 1e-12)
        self.assertLess(metric["aligned_relative_q_delta"], 1e-12)
        self.assertLess(verifier.phase_invariant_overlap(left[0], right[0], [1.0, 1.0]), 0.9)

        identity = {"topology_fingerprint": "sha256:mesh", "node_count": 2}

        def run(modes):
            return {"_artifacts": {
                "modes": [
                    {
                        **item,
                        "raw_mode_index": index,
                        "frequency_hz": 2.8e9,
                        "source_mesh_identity": identity,
                        "source_mesh_topology_sha256": "sha256:mesh",
                    }
                    for index, item in enumerate(modes)
                ],
                "mesh_metric": {
                    "status": "available",
                    "mesh_topology_sha256": "sha256:mesh",
                    "active_magnetic_node_count": 2,
                    "_weights": [1.0, 1.0],
                },
            }}

        result = verifier.mode_pair_comparison(
            run(left), run(right), minimum_overlap=0.95,
            maximum_relative_frequency_delta=1e-8, expected_mode_count=2,
        )
        self.assertEqual(result["parity_assessment"], "within_budgets")
        self.assertEqual(len(result["cluster_matches"]), 1)
        self.assertTrue(all(not row["overlap_within_budget"] for row in result["mode_matches"]))

        right[1] = mode([0.0, 0.0, 1.0, 0.0])
        metric = verifier.modal_subspace_metrics(left, right, [1.0, 1.0])
        self.assertGreater(metric["maximum_principal_angle_sine"], 0.9)

    def test_complex_overlap_is_global_phase_invariant(self) -> None:
        left = {
            "raw_mode_index": 0,
            "q_real": [1.0, 2.0, -3.0, 4.0],
            "q_imag": [0.5, -0.25, 1.5, -2.0],
        }
        right = {
            "raw_mode_index": 4,
            # The second vector is the first multiplied by i.
            "q_real": [-0.5, 0.25, -1.5, 2.0],
            "q_imag": [1.0, 2.0, -3.0, 4.0],
        }

        self.assertAlmostEqual(
            verifier.phase_invariant_overlap(left, right, [2.0, 3.0]), 1.0
        )

    def test_maximum_overlap_assignment_avoids_greedy_mismatch(self) -> None:
        self.assertEqual(
            verifier.maximum_overlap_assignment([[0.9, 0.8], [0.85, 0.1]]),
            [(0, 1), (1, 0)],
        )

    def test_window_certificate_requires_requested_bounds_and_complete_status(self) -> None:
        solver, modes = self._complete_window_evidence()
        result = verifier.window_completeness(
            solver,
            [1.0, 8.0e9],
            expected_mode_count=17,
            saved_modes=modes,
        )

        self.assertEqual(result["status"], "certified")
        self.assertTrue(result["raw_certificate_bounds_match"])
        self.assertEqual(result["certified_count"], 17)
        self.assertEqual(len(result["raw_subwindows"]), 2)

    def test_window_verifier_decodes_native_json_string_subwindows_and_keeps_payload(self) -> None:
        solver, modes = self._complete_window_evidence()
        solver["executed_subwindows"] = json.dumps(solver.pop("subwindows"))
        result = verifier.window_completeness(
            solver,
            [1.0, 8.0e9],
            expected_mode_count=17,
            saved_modes=modes,
        )

        self.assertEqual(result["status"], "certified")
        self.assertEqual(len(result["raw_subwindows"]), 2)
        self.assertIsInstance(result["raw_subwindows_payload"], str)
        self.assertEqual(
            result["raw_subwindows_payload_sha256"],
            hashlib.sha256(
                result["raw_subwindows_payload"].encode("utf-8")
            ).hexdigest(),
        )

    def test_generic_window_status_cannot_replace_raw_count_certificate(self) -> None:
        solver, modes = self._complete_window_evidence()
        del solver["window_certificate"]["requested_max_hz"]
        result = verifier.window_completeness(
            solver,
            [1.0, 8.0e9],
            expected_mode_count=17,
            saved_modes=modes,
        )

        self.assertEqual(result["status"], "unproven")
        self.assertFalse(result["raw_certificate_bounds_match"])
        self.assertIn(
            "raw window certificate bounds do not match the requested interval",
            result["proof_errors"],
        )

    def test_selected_only_spectrum_cannot_claim_complete_window(self) -> None:
        result = verifier.window_completeness(
            {
                "target_kind": "nearest_frequency",
                "window_complete": False,
                "spectrum_completeness": "selected_only",
            },
            [1.0, 8.0e9],
            expected_mode_count=17,
            saved_modes=[],
        )

        self.assertEqual(result["status"], "unproven")
        self.assertFalse(result["bounds_match"])
        self.assertTrue(result["proof_errors"])

    def test_missing_run_reports_availability_selection_and_completeness_separately(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = verifier.verify_one_run(
                root,
                {
                    "case_id": "gpu_smoke",
                    "pair_id": "kittel_h4_box8",
                    "family": "kittel_sphere",
                    "analysis_group": "mesh_refinement",
                    "execution_device": "gpu",
                    "input_identity_sha256": "a" * 64,
                    "output_path": "runs/gpu_smoke.zarr",
                    "magnetic_hmax_nm": 4.0,
                    "box_factor": 8.0,
                },
            )

        self.assertEqual(result["availability"], "unavailable")
        self.assertEqual(result["selected"], "unproven")
        self.assertEqual(result["complete"], "incomplete")

    def test_convergence_sequence_preserves_coarse_to_fine_axis_order(self) -> None:
        rows = [
            {
                "complete": "complete",
                "box_factor": 6.0,
                "frequency_hz": 2.9e9,
            },
            {
                "complete": "complete",
                "box_factor": 8.0,
                "frequency_hz": 2.83e9,
            },
            {
                "complete": "complete",
                "box_factor": 10.0,
                "frequency_hz": 2.81e9,
            },
        ]
        result = verifier.convergence_sequence(
            rows,
            axis_name="box_factor",
            expected_values=[6.0, 8.0, 10.0],
            expected_frequency_hz=2.802e9,
        )

        self.assertEqual(
            [row["box_factor"] for row in result["entries"]],
            [6.0, 8.0, 10.0],
        )
        self.assertEqual(
            result["convergence_assessment"],
            "observed_decrease_to_kittel_reference",
        )

    def test_convergence_sequence_reports_partial_measurements_without_qualifying_them(self) -> None:
        rows = [
            {
                "availability": "available",
                "complete": "complete",
                "selected": "proven",
                "box_factor": 6.0,
                "frequency_hz": 2.9e9,
            },
            {
                "availability": "available",
                "complete": "incomplete",
                "selected": "proven",
                "box_factor": 8.0,
                "frequency_hz": 2.83e9,
            },
            {
                "availability": "available",
                "complete": "complete",
                "selected": "proven",
                "box_factor": 10.0,
                "frequency_hz": 2.81e9,
            },
        ]
        result = verifier.convergence_sequence(
            rows,
            axis_name="box_factor",
            expected_values=[6.0, 8.0, 10.0],
            expected_frequency_hz=2.802e9,
        )

        self.assertEqual(result["entries"][1]["frequency_hz"], 2.83e9)
        self.assertEqual(
            result["convergence_assessment"],
            "observed_decrease_with_incomplete_run_evidence",
        )


if __name__ == "__main__":
    unittest.main()
