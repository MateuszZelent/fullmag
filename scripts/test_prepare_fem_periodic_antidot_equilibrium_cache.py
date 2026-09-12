from __future__ import annotations

import importlib.util
import json
import shutil
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts/prepare_fem_periodic_antidot_equilibrium_cache.py"


def load_module():
    spec = importlib.util.spec_from_file_location("prepare_equilibrium_cache", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def make_report(root: Path) -> Path:
    report = root / "report"
    stage = report / "workspace-history/session-1/stages/stage_00_flat_relax"
    values = [[1.0, 0.0, 0.0], [0.9, 0.1, 0.0], [0.0, 0.0, 0.0]]
    mesh = {
        "mesh_name": "study_domain",
        "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        "cells": {"types": ["tetra"], "offsets": [0, 4], "nodes": [0, 1, 2, 2]},
    }
    write_json(
        stage / "metadata.json",
        {
            "status": "completed",
            "stage_id": "flat_relax",
            "run_id": "run-1",
            "source_hash": "a" * 64,
            "problem_meta": {
                "runtime_metadata": {
                    "periodic_antidot_eigensolve": {
                        "scenario": "relax_then_eigenmodes_k0",
                        "equilibrium_torque_tolerance_t": 1e-6,
                        "equilibrium_torque_tolerance_a_per_m": 1.0,
                    }
                }
            },
            "execution_plan": {
                "backend_plan": {
                    "mesh": mesh,
                    "object_segments": [
                        {"object_id": "film", "node_start": 0, "node_count": 2},
                        {"object_id": "__air__", "node_start": 2, "node_count": 1},
                    ],
                }
            },
            "mesh": {
                "mesh_generation_id": "generation-1",
                "topology_fingerprint": "sha256:" + "1" * 64,
            },
            "fem_cpu_relaxation_qualification": {
                "converged": True,
                "stop_reason": "torque",
                "stop_metric_kind": "max_torque_apm",
                "stop_metric_unit": "A/m",
                "stop_metric_value": 0.5,
                "final_torque_apm": 0.5,
                "stop_threshold": 1.0,
            },
        },
    )
    write_json(
        stage / "m_final.json",
        {
            "observable": "m",
            "unit": "dimensionless",
            "step": 17,
            "time": 0.0,
            "values": values,
        },
    )
    return report


def test_prepare_cache_writes_full_and_magnetic_state(tmp_path: Path) -> None:
    module = load_module()
    report = make_report(tmp_path)
    output = tmp_path / "cache"
    manifest = module.prepare_cache(report, output)

    assert manifest["schema_version"] == module.SCHEMA_VERSION
    assert manifest["completion"] == {
        "status": "completed",
        "converged": True,
        "stop_reason": "torque",
        "metric_kind": "max_torque_apm",
        "metric_unit": "A/m",
        "metric_value": 0.5,
        "threshold": 1.0,
    }
    assert manifest["identity"]["schema_version"] == (
        "fem_periodic_antidot_equilibrium_identity.v1"
    )
    assert manifest["cache_identity_sha256"].startswith("sha256:")
    assert json.loads((output / "equilibrium_m.json").read_text())["values"][-1] == [0.0, 0.0, 0.0]
    magnetic = json.loads((output / "magnetic_m.json").read_text())
    assert magnetic["vector_count"] == 2
    assert len(magnetic["values"]) == 2

    # The public loader is the same validation path used by the examples.
    import sys

    sys.path.insert(0, str(REPO_ROOT / "packages/fullmag-py/src"))
    from fullmag.runtime.periodic_antidot_equilibrium_cache import (  # noqa: PLC0415
        load_periodic_antidot_equilibrium_cache,
    )

    loaded = load_periodic_antidot_equilibrium_cache(output)
    assert loaded.domain_mesh_path.name == "domain_mesh.json"
    assert loaded.magnetic_state_path.name == "magnetic_m.json"


def test_prepare_cache_refuses_stale_nonempty_output(tmp_path: Path) -> None:
    module = load_module()
    report = make_report(tmp_path)
    output = tmp_path / "cache"
    output.mkdir()
    (output / "unrelated.txt").write_text("keep", encoding="utf-8")
    with pytest.raises(ValueError, match="not empty"):
        module.prepare_cache(report, output)


def _qualification_path(report: Path) -> Path:
    return next(report.glob("workspace-history/session-*/stages/stage_00_flat_relax/metadata.json"))


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("converged", False, "not a converged torque equilibrium"),
        ("stop_reason", "max_steps", "stop_reason"),
        ("stop_metric_kind", "total_energy_plateau_range_j", "stop_metric_kind"),
        ("stop_metric_unit", "T", "stop_metric_unit"),
    ],
)
def test_prepare_cache_rejects_incoherent_completion_metadata(
    tmp_path: Path, field: str, value: object, message: str
) -> None:
    module = load_module()
    report = make_report(tmp_path)
    metadata_path = _qualification_path(report)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["fem_cpu_relaxation_qualification"][field] = value
    write_json(metadata_path, metadata)

    with pytest.raises(ValueError, match=message):
        module.prepare_cache(report, tmp_path / "cache")


def test_prepare_cache_rejects_metric_value_that_differs_from_final_torque(
    tmp_path: Path,
) -> None:
    module = load_module()
    report = make_report(tmp_path)
    metadata_path = _qualification_path(report)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["fem_cpu_relaxation_qualification"]["stop_metric_value"] = 0.4
    write_json(metadata_path, metadata)

    with pytest.raises(ValueError, match="stop_metric_value"):
        module.prepare_cache(report, tmp_path / "cache")


def test_loader_rejects_manifest_identity_mutation(tmp_path: Path) -> None:
    module = load_module()
    report = make_report(tmp_path)
    output = tmp_path / "cache"
    module.prepare_cache(report, output)
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["completion"]["threshold"] = 2.0
    write_json(manifest_path, manifest)

    import sys

    sys.path.insert(0, str(REPO_ROOT / "packages/fullmag-py/src"))
    from fullmag.runtime.periodic_antidot_equilibrium_cache import (  # noqa: PLC0415
        load_periodic_antidot_equilibrium_cache,
    )

    with pytest.raises(ValueError, match="cache identity"):
        load_periodic_antidot_equilibrium_cache(output)


def test_loader_rejects_rehashed_domain_mesh_content_mutation(tmp_path: Path) -> None:
    module = load_module()
    report = make_report(tmp_path)
    output = tmp_path / "cache"
    module.prepare_cache(report, output)
    domain_mesh_path = output / "domain_mesh.json"
    domain_mesh = json.loads(domain_mesh_path.read_text(encoding="utf-8"))
    domain_mesh["nodes"][0][0] = 0.25
    write_json(domain_mesh_path, domain_mesh)
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["artifacts"]["domain_mesh"]["sha256"] = module._sha256(domain_mesh_path)
    manifest["cache_identity_sha256"] = module._canonical_json_sha256(
        module.CACHE_IDENTITY_NAMESPACE,
        {key: value for key, value in manifest.items() if key != "cache_identity_sha256"},
    )
    write_json(manifest_path, manifest)

    import sys

    sys.path.insert(0, str(REPO_ROOT / "packages/fullmag-py/src"))
    from fullmag.runtime.periodic_antidot_equilibrium_cache import (  # noqa: PLC0415
        load_periodic_antidot_equilibrium_cache,
    )

    with pytest.raises(ValueError, match="domain mesh content identity"):
        load_periodic_antidot_equilibrium_cache(output)


def test_loader_rejects_artifact_copied_from_another_cache(tmp_path: Path) -> None:
    module = load_module()
    first_report = make_report(tmp_path / "first")
    second_report = make_report(tmp_path / "second")
    second_state_path = next(
        second_report.glob("workspace-history/session-*/stages/stage_00_flat_relax/m_final.json")
    )
    second_state = json.loads(second_state_path.read_text(encoding="utf-8"))
    second_state["values"][0] = [0.0, 1.0, 0.0]
    write_json(second_state_path, second_state)
    first_output = tmp_path / "first-cache"
    second_output = tmp_path / "second-cache"
    module.prepare_cache(first_report, first_output)
    module.prepare_cache(second_report, second_output)
    shutil.copyfile(second_output / "equilibrium_m.json", first_output / "equilibrium_m.json")

    import sys

    sys.path.insert(0, str(REPO_ROOT / "packages/fullmag-py/src"))
    from fullmag.runtime.periodic_antidot_equilibrium_cache import (  # noqa: PLC0415
        load_periodic_antidot_equilibrium_cache,
    )

    with pytest.raises(ValueError, match="failed its sha256 check"):
        load_periodic_antidot_equilibrium_cache(first_output)
