from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import pytest

from scripts.build_skyrmion_hall_artifact import HallBuildError, build_hall_artifact
from scripts.validate_skyrmion_hall_angle import validate_hall_artifact


def _write_stage(root: Path, *, sample_count: int = 2) -> Path:
    nx, ny, nz = 64, 64, 1
    cell = (2.0e-9, 2.0e-9, 1.0e-9)
    grid_id = "a" * 64
    (root / "fields/m.zarr").mkdir(parents=True)
    (root / "mesh").mkdir()
    (root / "physics").mkdir()
    zarr = root / "fields/m.zarr"
    (zarr / ".zarray").write_text(
        json.dumps(
            {
                "chunks": [1, 3, nx * ny * nz],
                "compressor": None,
                "dimension_separator": ".",
                "dtype": "<f8",
                "fill_value": 0.0,
                "filters": None,
                "order": "C",
                "shape": [sample_count, 3, nx * ny * nz],
                "zarr_format": 2,
            }
        ),
        encoding="utf-8",
    )
    (zarr / ".zattrs").write_text(json.dumps({"axes": ["sample", "component", "cell"]}), encoding="utf-8")
    sample_rows = ["sample,step,time,solver_dt,chunk_key,dtype,scalar_bytes,cell_count"]
    for sample in range(sample_count):
        time_s = sample * 1.0e-10
        sample_rows.append(
            f"{sample},{sample},{time_s:.15e},1.0e-10,{sample}.0.0,<f8,8,{nx * ny * nz}"
        )
        values = [[0.0] * (nx * ny * nz) for _ in range(3)]
        cx = (nx * 0.5 + sample * 0.2) * cell[0]
        cy = ny * 0.5 * cell[1]
        radius = 14.0e-9
        for y in range(ny):
            for x in range(nx):
                px = (x + 0.5) * cell[0]
                py = (y + 0.5) * cell[1]
                dx, dy = px - cx, py - cy
                r = math.hypot(dx, dy)
                theta = math.pi * max(0.0, 1.0 - min(r / radius, 1.0))
                phi = math.atan2(dy, dx)
                index = x + nx * y
                values[0][index] = math.sin(theta) * math.cos(phi)
                values[1][index] = math.sin(theta) * math.sin(phi)
                values[2][index] = math.cos(theta)
        payload = [component for component in values for component in component]
        (zarr / f"{sample}.0.0").write_bytes(struct.pack("<" + "d" * len(payload), *payload))
    (zarr / "samples.csv").write_text("\n".join(sample_rows) + "\n", encoding="utf-8")

    certificate = {
        "schema_version": "fdm_grid_certificate.v1",
        "certificate": {
            "active_cells": nx * ny,
            "cell_m": list(cell),
            "counts": [nx, ny, nz],
            "estimated_bytes": nx * ny * nz * 32,
            "extent_m": [nx * cell[0], ny * cell[1], nz * cell[2]],
            "grid_fingerprint": grid_id,
            "object_ids": ["fm"],
            "origin_m": [0.0, 0.0, 0.0],
            "region_legend_fingerprint": "sha256:" + "b" * 64,
        },
    }
    (root / "mesh/fdm_grid_certificate.json").write_text(json.dumps(certificate), encoding="utf-8")
    descriptor = {
        "schema_version": "fdm_region_membership.v2",
        "binary_path": "mesh/fdm_region_membership.v2.bin",
        "grid_fingerprint": grid_id,
        "domain_generation_id": grid_id,
        "origin_m": [0.0, 0.0, 0.0],
        "counts": [nx, ny, nz],
        "cell_m": list(cell),
        "cell_count": nx * ny * nz,
        "magnetic_support": {"active_cell_count": nx * ny},
        "object_ids": ["fm"],
        "region_legend": [],
        "encoding": "FMRM:u32_membership_le",
    }
    (root / "mesh/fdm_region_membership.v2.json").write_text(json.dumps(descriptor), encoding="utf-8")
    header = bytearray(b"FMRM")
    header.extend(bytes([2, 2]))
    header.extend(b"\0\0")
    header.extend(struct.pack("<3I", nx, ny, nz))
    header.extend(struct.pack("<2I", nx * ny * nz, 0))
    header.extend(bytes.fromhex(grid_id))
    header.extend(b"\0\0\0\0")
    memberships = [0] * (nx * ny) + [0xFFFFFFFF] * (nx * ny * (nz - 1))
    (root / "mesh/fdm_region_membership.v2.bin").write_bytes(header + struct.pack("<" + "I" * len(memberships), *memberships))
    (root / "physics/physics_graph_provenance.v1.json").write_text(
        json.dumps({"scene_revision": 4, "mesh_revision": 7}), encoding="utf-8"
    )
    (root / "metadata.json").write_text(
        json.dumps(
            {
                "problem_meta": {
                    "runtime_metadata": {
                        "active_stage_id": "drive_solved_current_plus_1_5",
                        "model_builder": {
                            "problem": {
                                "current_modules": [
                                    {
                                        "boundaries": [
                                            {
                                                "id": "terminal_x_plus",
                                                "outward_current_density_Apm2": -1.5e12,
                                            },
                                            {
                                                "id": "terminal_x_minus",
                                                "outward_current_density_Apm2": 1.5e12,
                                            },
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    return root


def test_builds_fail_closed_artifact_from_real_zarr_samples(tmp_path: Path) -> None:
    artifact = build_hall_artifact(_write_stage(tmp_path))

    validate_hall_artifact(artifact)
    assert artifact["hall_angle"]["reason_code"] == "insufficient_samples"
    assert artifact["trajectory"]["source"]["magnetization_quantity_id"] == "m"
    assert artifact["trajectory"]["q"][0] < -0.5
    assert artifact["hall_angle"]["mean_signed_current_a_per_m2"] is None


def test_rejects_missing_magnetization_series(tmp_path: Path) -> None:
    stage = _write_stage(tmp_path)
    (stage / "fields/m.zarr/0.0.0").unlink()
    with pytest.raises(HallBuildError, match="chunk"):
        build_hall_artifact(stage)


def test_rejects_compressed_or_non_fdm_layout(tmp_path: Path) -> None:
    stage = _write_stage(tmp_path)
    zarray = json.loads((stage / "fields/m.zarr/.zarray").read_text(encoding="utf-8"))
    zarray["compressor"] = {"id": "zstd"}
    (stage / "fields/m.zarr/.zarray").write_text(json.dumps(zarray), encoding="utf-8")
    with pytest.raises(HallBuildError, match="compressor"):
        build_hall_artifact(stage)


def test_accepts_weighted_gls_window_only_after_real_motion_samples(tmp_path: Path) -> None:
    artifact = build_hall_artifact(_write_stage(tmp_path, sample_count=25))

    validate_hall_artifact(artifact)
    hall = artifact["hall_angle"]
    assert hall["reason_code"] is None
    assert hall["v_parallel_m_per_s"] > 1.0
    assert abs(hall["angle_deg"]) < 1.0
    assert artifact["producer"]["uncertainty_calibration_status"] == "provisional_cell_quantization"
