"""Measure a real three-run CPU artifact for the SP4-derived bilayer gate.

The utility only reads runtime-produced snapshots.  It never creates fields,
energies, or fixture values; missing or malformed runtime inputs fail closed.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
from typing import Any

import numpy as np

from .common import AIRBOX_OBSERVATION, BILAYER, CANONICAL_SP4, QUALIFICATION_SCOPE

MU0 = 4.0 * math.pi * 1.0e-7
SCHEMA_VERSION = "sp4_fdm_multilayer_runtime.v1"
HEX_40 = re.compile(r"^[0-9a-f]{40}$")
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
RFC3339_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


class RuntimeMeasurementError(ValueError):
    """Raised when a real runtime input cannot be measured safely."""


def _require_file(path: Path) -> Path:
    if not path.is_file():
        raise RuntimeMeasurementError(f"runtime_input_missing: {path}")
    return path


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(_require_file(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeMeasurementError(f"runtime_input_unreadable: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeMeasurementError(f"runtime_input_malformed: {path}")
    return payload


def _field_path(
    run_dir: Path,
    layer_id: str,
    step: int,
    expected_identity: dict[str, str],
) -> Path:
    manifest = _read_json(run_dir / "fields" / "H_demag" / "manifest.json")
    manifest_identity = _build_identity(
        manifest.get("build_identity"), f"{run_dir}:field_manifest"
    )
    if manifest_identity != expected_identity:
        raise RuntimeMeasurementError(
            f"runtime_build_identity_mismatch: {run_dir}:field_manifest"
        )
    for layer in manifest.get("layers", []):
        if isinstance(layer, dict) and layer.get("id") == layer_id:
            directory = layer.get("directory")
            if isinstance(directory, str) and directory:
                return run_dir / "fields" / "H_demag" / directory / f"step_{step:06d}.json"
    raise RuntimeMeasurementError(f"runtime_layer_missing: {run_dir}: {layer_id}")


def _read_field(
    run_dir: Path,
    layer_id: str,
    step: int,
    expected_identity: dict[str, str],
) -> np.ndarray:
    payload = _read_json(_field_path(run_dir, layer_id, step, expected_identity))
    provenance = payload.get("provenance")
    if not isinstance(provenance, dict):
        raise RuntimeMeasurementError(
            f"runtime_field_provenance_missing: {run_dir}: {layer_id}"
        )
    field_identity = _build_identity(
        provenance.get("build_identity"), f"{run_dir}:{layer_id}:field"
    )
    if field_identity != expected_identity:
        raise RuntimeMeasurementError(
            f"runtime_build_identity_mismatch: {run_dir}:{layer_id}:field"
        )
    if payload.get("observable") != "H_demag" or payload.get("unit") != "A/m":
        raise RuntimeMeasurementError(f"runtime_field_contract_mismatch: {run_dir}: {layer_id}")
    values = np.asarray(payload.get("values"), dtype=np.float64)
    if values.ndim != 2 or values.shape[1] != 3 or not np.all(np.isfinite(values)):
        raise RuntimeMeasurementError(f"runtime_field_values_malformed: {run_dir}: {layer_id}")
    if payload.get("step") != step:
        raise RuntimeMeasurementError(f"runtime_field_step_mismatch: {run_dir}: {layer_id}")
    return values


def _read_initial_m(run_dir: Path, expected_identity: dict[str, str]) -> np.ndarray:
    payload = _read_json(run_dir / "m_initial.json")
    provenance = payload.get("provenance")
    if not isinstance(provenance, dict):
        raise RuntimeMeasurementError(f"runtime_m_initial_provenance_missing: {run_dir}")
    initial_identity = _build_identity(
        provenance.get("build_identity"), f"{run_dir}:m_initial"
    )
    if initial_identity != expected_identity:
        raise RuntimeMeasurementError(f"runtime_build_identity_mismatch: {run_dir}:m_initial")
    values = np.asarray(payload.get("values"), dtype=np.float64)
    if payload.get("observable") != "m" or values.ndim != 2 or values.shape[1] != 3:
        raise RuntimeMeasurementError(f"runtime_m_initial_malformed: {run_dir}")
    if not np.all(np.isfinite(values)):
        raise RuntimeMeasurementError(f"runtime_m_initial_nonfinite: {run_dir}")
    return values


def _jsonable(value: object) -> object:
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    return value


def _build_identity(value: Any, label: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise RuntimeMeasurementError(f"runtime_build_identity_missing: {label}")
    identity = {
        "built_at_utc": value.get("built_at_utc"),
        "git_commit": value.get("git_commit"),
        "worktree_state": value.get("worktree_state"),
        "source_snapshot_sha256": value.get("source_snapshot_sha256"),
    }
    if not isinstance(identity["built_at_utc"], str) or not RFC3339_UTC.fullmatch(
        identity["built_at_utc"]
    ):
        raise RuntimeMeasurementError(f"runtime_build_identity_invalid: {label}:built_at_utc")
    if not isinstance(identity["git_commit"], str) or not HEX_40.fullmatch(
        identity["git_commit"]
    ):
        raise RuntimeMeasurementError(f"runtime_build_identity_invalid: {label}:git_commit")
    if identity["worktree_state"] not in {"clean", "dirty"}:
        raise RuntimeMeasurementError(
            f"runtime_build_identity_invalid: {label}:worktree_state"
        )
    if not isinstance(identity["source_snapshot_sha256"], str) or not HEX_64.fullmatch(
        identity["source_snapshot_sha256"]
    ):
        raise RuntimeMeasurementError(
            f"runtime_build_identity_invalid: {label}:source_snapshot_sha256"
        )
    return identity  # type: ignore[return-value]


def measure_runtime(
    ab_dir: str | Path,
    a_only_dir: str | Path,
    b_only_dir: str | Path,
    output_path: str | Path,
    *,
    step: int = 0,
) -> dict[str, Any]:
    """Measure cross-layer fields and energies from three real CPU runs."""

    if isinstance(step, bool) or not isinstance(step, int) or step < 0:
        raise RuntimeMeasurementError("runtime_step_invalid")
    ab = Path(ab_dir)
    a_only = Path(a_only_dir)
    b_only = Path(b_only_dir)
    metadata_by_run = {
        "ab": _read_json(ab / "metadata.json"),
        "a_only": _read_json(a_only / "metadata.json"),
        "b_only": _read_json(b_only / "metadata.json"),
    }
    identities = {
        label: _build_identity(metadata.get("build_identity"), label)
        for label, metadata in metadata_by_run.items()
    }
    build_identity = identities["ab"]
    if any(identity != build_identity for identity in identities.values()):
        raise RuntimeMeasurementError("runtime_build_identity_mismatch")
    h_a_total = _read_field(ab, "layer_bottom", step, identities["ab"])
    h_b_total = _read_field(ab, "layer_top", step, identities["ab"])
    h_a_self = _read_field(a_only, "layer_bottom", step, identities["a_only"])
    h_b_self = _read_field(b_only, "layer_top", step, identities["b_only"])
    m = _read_initial_m(ab, identities["ab"])
    if m.shape[0] != h_a_total.shape[0] + h_b_total.shape[0]:
        raise RuntimeMeasurementError("runtime_layer_state_length_mismatch")
    if h_a_self.shape != h_a_total.shape or h_b_self.shape != h_b_total.shape:
        raise RuntimeMeasurementError("runtime_control_grid_shape_mismatch")

    h_a_from_b = h_a_total - h_a_self
    h_b_from_a = h_b_total - h_b_self
    m_a = m[: h_a_total.shape[0]]
    m_b = m[h_a_total.shape[0] :]
    cell_volume = math.prod(BILAYER.cell_m)
    ms = CANONICAL_SP4.ms_a_per_m
    energy_demag = -0.5 * MU0 * ms * cell_volume * float(
        np.sum(m_a * h_a_total) + np.sum(m_b * h_b_total)
    )
    coupling_a = -MU0 * ms * cell_volume * float(np.sum(m_a * h_a_from_b))
    coupling_b = -MU0 * ms * cell_volume * float(np.sum(m_b * h_b_from_a))
    relative_error = abs(coupling_a - coupling_b) / max(abs(coupling_a), abs(coupling_b), 1e-300)

    metadata = metadata_by_run["ab"]
    layout = metadata.get("artifact_layout")
    if not isinstance(layout, dict) or layout.get("backend") != "fdm_multilayer":
        raise RuntimeMeasurementError("runtime_layout_missing_or_wrong_backend")
    payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "qualification_scope": QUALIFICATION_SCOPE,
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "strategy": "multilayer_convolution",
        "mode": "two_d_stack",
        "build_identity": build_identity,
        "source_artifact_build_identities": identities,
        "airbox": _jsonable(
            {
                "cells": (160, 40, 18),
                "cells_xy": (160, 40),
                "spacing_m": (3.125e-9, 3.125e-9, 3e-9),
                "origin_m": (-250e-9, -62.5e-9, -28.5e-9),
                "size_m": (500e-9, 125e-9, 54e-9),
                "center_m": (0.0, 0.0, -1.5e-9),
                "padding_cells_above_below": (5, 9),
                "target_only": True,
                "scope_kind": "airbox",
                "published_quantities": ["H_demag"],
                "unavailable_quantities": {
                    "H_eff": "fdm_multilayer_airbox_h_eff_unavailable.v1"
                },
                "coordinate_system": AIRBOX_OBSERVATION.coordinate_system,
                "cell_center_rule": "origin + (i+0.5,j+0.5,k+0.5)*spacing",
            }
        ),
        "outputs": {
            "field_a_from_b_apm": [float(value) for value in h_a_from_b.mean(axis=0)],
            "field_b_from_a_apm": [float(value) for value in h_b_from_a.mean(axis=0)],
            "field_a_from_b_rms_apm": [
                float(value) for value in np.sqrt(np.mean(h_a_from_b * h_a_from_b, axis=0))
            ],
            "energy_demag_j": energy_demag,
            "coupling_a_from_b_j": coupling_a,
            "coupling_b_from_a_j": coupling_b,
            "coupling_reciprocity_relative_error": relative_error,
        },
        "measurement": {
            "sample_step": step,
            "sample_time_s": 0.0,
            "source_unit": "A/m",
            "source_runs": {
                "ab": str(ab),
                "a_only": str(a_only),
                "b_only": str(b_only),
            },
            "field_difference": "H_demag(A+B)-H_demag(A-only) for A<-B; reciprocal B-only control",
            "energy_formula": "-0.5*mu0*Ms*sum(m dot H_demag)*cell_volume",
            "cross_energy_formula": "-mu0*Ms*sum(m_A dot H_A<-B)*cell_volume",
            "layout_backend": layout["backend"],
            "layout": layout,
            "runtime_metadata_source": str(ab / "metadata.json"),
        },
    }
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ab_dir", type=Path, help="A+B runtime artifact directory")
    parser.add_argument("a_only_dir", type=Path, help="A-only control runtime directory")
    parser.add_argument("b_only_dir", type=Path, help="B-only control runtime directory")
    parser.add_argument("output", type=Path, help="runtime.json output path")
    parser.add_argument("--step", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        payload = measure_runtime(
            args.ab_dir,
            args.a_only_dir,
            args.b_only_dir,
            args.output,
            step=args.step,
        )
    except RuntimeMeasurementError as exc:
        print(str(exc))
        return 2
    print(json.dumps(payload["outputs"], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
