#!/usr/bin/env python3
"""Qualify BORIS tensor adapter with raw OVF inputs; no solver qualification."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import replace
from pathlib import Path

from compare_boris_fullmag_she_nf import (
    _normalize_boris_fields, compare_transport_artifacts, normalize_boris_artifact,
)
from verify_boris_nf_interface import (
    MeshFields, compute_interface_balance, compute_interface_slice, read_text_ovf,
)

PINNED_COMMIT = "048503d2ca6475e91b073eb1762ecf9d3634c3e1"
PINNED_FILES = {
    "Boris/Transport_Spin_Display.cpp": "fefbc95a5c8f0b95611302dd2a992b3aae8e903c10a9631b53b332b2c905d791",
    "BorisLib/Funcs_Math_base.h": "54dac9acaaa68fac247f1f9a1142b17a4942054801b6e40a359fac309f6af96b",
    "BorisLib/Types_VAL.h": "1602c65945d070272f47b0aacfddb754523b12deb64bf6c71fb9097859cd5bfe",
}
# Exact historical source literal from pinned Funcs_Math_base.h, independently
# verified by file hash; replacing it with current CODATA changes this adapter.
SPIN_SCALE = 1.0 / 5.788381608e-05


def write_ovf(path: Path, rows: list[list[float]], *, origin_z: float) -> None:
    header = [
        "# OOMMF OVF 2.0", "# Segment count: 1", "# Begin: Segment",
        "# Begin: Header", "# meshtype: rectangular", "# meshunit: m",
        "# xnodes: 2", "# ynodes: 1", "# znodes: 2",
        "# xstepsize: 1e-9", "# ystepsize: 1e-9", "# zstepsize: 1e-9",
        "# xmin: 0", "# ymin: 0", f"# zmin: {origin_z}",
        "# xmax: 2e-9", "# ymax: 1e-9", f"# zmax: {origin_z + 2e-9}",
        "# xbase: 5e-10", "# ybase: 5e-10", f"# zbase: {origin_z + 5e-10}",
        f"# valuedim: {len(rows[0])}", "# End: Header", "# Begin: Data Text",
    ]
    path.write_text("\n".join(header + [" ".join(map(str, row)) for row in rows]
                             + ["# End: Data Text", "# End: Segment", ""]), encoding="utf-8")


def fixture(root: Path) -> tuple[dict[str, dict[str, Path]], list[list[float]]]:
    root.mkdir(parents=True, exist_ok=True)
    fields: dict[str, dict[str, Path]] = {}
    expected: list[list[float]] = []
    for domain, offset, origin in (("normal", 0, 0.0), ("ferromagnet", 1000, 2e-9)):
        # x-fast point ordering, four distinct points per material; signed entries.
        tensors = [[((-1) ** component) * (offset * (component + 1) + 100 * point + component + 1)
                    for component in range(9)] for point in range(4)]
        expected.extend(tensors)
        raw = {
            "V": [[offset + point] for point in range(4)],
            "S": [[offset + 10 * point + a + 1 for a in range(3)] for point in range(4)],
            "Jc": [[offset + 10 * point + 30 + a for a in range(3)] for point in range(4)],
            "Jsx": [row[0:3] for row in tensors],
            "Jsy": [row[3:6] for row in tensors],
            "Jsz": [row[6:9] for row in tensors],
        }
        if domain == "ferromagnet":
            raw.update({"Ts": [[3.0, 5.0, 7.0]] * 4, "Tsi": [[11.0, 13.0, 17.0]] * 4})
        fields[domain] = {}
        for quantity, rows in raw.items():
            path = root / f"{domain}_{quantity}.ovf"
            write_ovf(path, rows, origin_z=origin)
            fields[domain][quantity] = path
    # Independent row selection: last normal plane vs first ferromagnet plane.
    normal_flux = [(expected[2][6 + a] + expected[3][6 + a]) / 2 for a in range(3)]
    ferro_flux = [(expected[4][6 + a] + expected[5][6 + a]) / 2 for a in range(3)]
    balances = {
        "normal_axis": "z", "normal_sign": 1, "charge_closure": 0.0,
        "spin_torque_closure": 0.0, "normal_spin_flux": normal_flux,
        "ferromagnet_spin_flux": ferro_flux,
        "spin_flux_jump": [n - f for n, f in zip(normal_flux, ferro_flux)],
        "absorbed_spin_flux": [n - f for n, f in zip(normal_flux, ferro_flux)],
        "torque": [11e-9, 13e-9, 17e-9],
    }
    summary = {
        "schema_version": "fullmag.boris_she_nf.v2",
        "runtime": {"schema_version": "fullmag.boris.runtime.v1", "identity_complete": False,
                    "precision": None, "kind": "synthetic_raw_ovf_fixture",
                    "solver_executed": False},
        "scenario": {"workload": "N/F", "parameters": {
            "SHA": 0.1, "iSHA": 0.1, "Gi_Spm2": 1.0, "Gmix_Spm2": [2.0, 3.0],
            "De_m2_per_s": 0.02, "elC_Spm": 4e6}},
        "fields": {domain: {name: path.name for name, path in entries.items()}
                   for domain, entries in fields.items()},
        "residuals": {"charge_scaled_l2": 0.0, "spin_scaled_l2": 0.0},
        "interface_balances": balances, "qualification": {"status": "diagnostic"},
    }
    (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return fields, expected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--boris-source", type=Path, required=True)
    args = parser.parse_args()
    errors: list[str] = []
    source_hashes = {}
    for relative, expected_hash in PINNED_FILES.items():
        actual = hashlib.sha256((args.boris_source / relative).read_bytes()).hexdigest()
        source_hashes[relative] = actual
        if actual != expected_hash:
            errors.append(f"source hash mismatch: {relative}")
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        raise RuntimeError("adapter fixture output must be fresh")
    fields, expected = fixture(args.output_dir / "raw-ovf")
    raw_root = args.output_dir / "raw-ovf"
    try:
        normalize_boris_artifact(raw_root)
    except ValueError as error:
        if "incomplete" not in str(error):
            raise
    else:
        errors.append("synthetic input was admitted by the public benchmark gate")
    artifact = _normalize_boris_fields(raw_root,
        json.loads((raw_root / "summary.json").read_text(encoding="utf-8")),
        source="synthetic_raw_ovf_algorithm_fixture")

    def check(label: str, actual: float, desired: float) -> None:
        if not math.isclose(actual, desired, rel_tol=2e-15, abs_tol=1e-15):
            errors.append(f"{label}: got {actual:.17g}, expected {desired:.17g}")

    for point, row in enumerate(expected):
        for component, value in enumerate(row):
            check(f"Q[{point},{component}]", artifact.spin_current_qia_apm2[point][component],
                  value * SPIN_SCALE)
        check(f"V[{point}]", artifact.potential_v[point],
              (point if point < 4 else 1000 + point - 4))
        offset, local = (0, point) if point < 4 else (1000, point - 4)
        for a in range(3):
            check(f"mu_s[{point},{a}]", artifact.mu_s_v[point][a],
                  2 * 0.02 * (offset + 10 * local + a + 1) * SPIN_SCALE / 4e6)
    meshes = {}
    for domain, entries in fields.items():
        parsed = {name: read_text_ovf(path) for name, path in entries.items()}
        meshes[domain] = MeshFields(parsed["Jc"], parsed["Jsx"], parsed["Jsy"],
                                   parsed["Jsz"], parsed["S"])
    tsi = read_text_ovf(fields["ferromagnet"]["Tsi"])
    for sign in (1, -1):
        interface = compute_interface_slice(meshes["normal"], meshes["ferromagnet"],
                                            tsi, normal_sign=sign)
        balance = compute_interface_balance(interface)
        for a in range(3):
            n = (expected[2][6 + a] + expected[3][6 + a]) / 2
            f = (expected[4][6 + a] + expected[5][6 + a]) / 2
            check(f"normal_flux[{sign},{a}]", interface.normal_flux[a], n)
            check(f"ferromagnet_flux[{sign},{a}]", interface.ferromagnet_flux[a], f)
            check(f"jump[{sign},{a}]", balance["spin_flux_jump"][a], sign * (n - f))
            check(f"normalized_balance[{a}]", artifact.interface_balances["normal_spin_flux"][a],
                  n * SPIN_SCALE)
    # Re-normalize raw input with reversed normal and poisoned historical
    # balances: the current adapter must derive fluxes from OVFs, not metadata.
    summary_path = args.output_dir / "raw-ovf" / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["interface_balances"]["normal_sign"] = -1
    summary["interface_balances"]["normal_spin_flux"] = [999.0] * 3
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    reversed_artifact = _normalize_boris_fields(raw_root, summary,
        source="synthetic_raw_ovf_algorithm_fixture")
    for a in range(3):
        n = (expected[2][6 + a] + expected[3][6 + a]) / 2
        f = (expected[4][6 + a] + expected[5][6 + a]) / 2
        check(f"raw_reload_flux[{a}]", reversed_artifact.interface_balances["normal_spin_flux"][a],
              n * SPIN_SCALE)
        check(f"raw_reload_signed_jump[{a}]", reversed_artifact.interface_balances["spin_flux_jump"][a],
              -(n - f) * SPIN_SCALE)
    if reversed_artifact.normal_sign != -1:
        errors.append("reversed normal identity was lost")
    fullmag_conventions = {**artifact.conventions, "torque_unit": "gilbert_source_per_s"}
    comparison = compare_transport_artifacts(artifact, replace(artifact, conventions=fullmag_conventions))
    if comparison["status"] != "incomparable" or "torque_per_s" in comparison["observables"]:
        errors.append("incompatible BORIS/Fullmag torque was compared")
    if artifact.conventions.get("adapter_version") != "fullmag.boris_flow_major_units.v2":
        errors.append("versioned unit adapter metadata is missing")
    if artifact.conventions.get("torque_unit") != "boris_tsi_A_per_m_s":
        errors.append("BORIS torque unit refusal was lost")
    report = {
        "schema": "fullmag.boris_tensor_adapter.raw_ovf_check.v1",
        "status": "pass" if not errors else "fail",
        "qualification": "adapter_fixture_only",
        "public_runtime_admission": "refused_incomplete_synthetic_identity",
        "solver_executed": False,
        "upstream_commit": PINNED_COMMIT, "source_sha256": source_hashes,
        "adapter_version": artifact.conventions.get("adapter_version"),
        "point_count": len(expected), "tensor_component_checks": len(expected) * 9,
        "normal_signs": [1, -1], "errors": errors,
        "raw_input_sha256": {
            f"{domain}/{name}": hashlib.sha256(path.read_bytes()).hexdigest()
            for domain, entries in fields.items() for name, path in entries.items()},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("status", "point_count", "tensor_component_checks", "adapter_version", "errors")}))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
