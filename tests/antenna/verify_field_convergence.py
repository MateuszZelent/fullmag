"""Qualify published antenna H/A against a finite straight-wire reference."""

import argparse
import hashlib
import json
import math
import struct
from pathlib import Path


def finite_wire_field(start, end, point):
    direction = [end[i] - start[i] for i in range(3)]
    length = math.sqrt(sum(value * value for value in direction))
    if not math.isfinite(length) or length == 0.0:
        raise ValueError("wire endpoints must be distinct and finite")
    unit = [value / length for value in direction]
    displacement = [point[i] - start[i] for i in range(3)]
    axial = sum(displacement[i] * unit[i] for i in range(3))
    radial = [displacement[i] - axial * unit[i] for i in range(3)]
    radius_squared = sum(value * value for value in radial)
    if not math.isfinite(radius_squared) or radius_squared == 0.0:
        raise ValueError("sample lies on the wire axis")
    factor = (
        axial / math.sqrt(radius_squared + axial * axial)
        - (axial - length) / math.sqrt(radius_squared + (axial - length) ** 2)
    ) / (4.0 * math.pi * radius_squared)
    cross = (
        unit[1] * radial[2] - unit[2] * radial[1],
        unit[2] * radial[0] - unit[0] * radial[2],
        unit[0] * radial[1] - unit[1] * radial[0],
    )
    return tuple(factor * value for value in cross), math.sqrt(radius_squared)


def is_link(path):
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def read_vectors(directory, prefix, reference, expected_unit):
    if (reference.get("scalar_type"), reference.get("layout"), reference.get("unit")) != (
        "float64_le", "sample_xyz_interleaved", expected_unit
    ):
        raise ValueError("unexpected payload type, layout, or unit")
    logical = reference["path"]
    if not isinstance(logical, str) or "\\" in logical or ":" in logical:
        raise ValueError("invalid payload path")
    parts = logical.split("/")
    if (len(parts) <= len(prefix) or tuple(parts[:len(prefix)]) != prefix
            or any(part in ("", ".", "..") for part in parts)):
        raise ValueError("payload path does not belong to the selected solution")
    path = directory
    for part in parts[len(prefix):]:
        path /= part
        if is_link(path):
            raise ValueError("payload path contains a link")
    if not path.resolve().is_relative_to(directory.resolve()):
        raise ValueError("payload path escapes the selected revision")
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != reference["sha256"]:
        raise ValueError(f"payload hash mismatch: {path}")
    count = reference["value_count"]
    if count == 0 or count % 3 or len(payload) != count * 8:
        raise ValueError("invalid payload length")
    values = struct.unpack(f"<{count}d", payload)
    if any(not math.isfinite(value) for value in values):
        raise ValueError("non-finite payload value")
    return list(zip(values[::3], values[1::3], values[2::3]))


def read_solution(manifest_path, port_mode_id):
    manifest_path = Path(manifest_path).absolute()
    directory = manifest_path.parent
    if (directory.parent.name == "field_solutions"
            and directory.parent.parent.name == "antenna"):
        solution_directory = directory
    elif (directory.parent.parent.name == "field_solutions"
          and directory.parent.parent.parent.name == "antenna"):
        solution_directory = directory.parent
    else:
        raise ValueError("unsupported antenna manifest layout")
    if manifest_path.name != "manifest.v1.json":
        raise ValueError("unsupported antenna manifest filename")
    for path in (manifest_path, directory, solution_directory,
                 solution_directory.parent, solution_directory.parent.parent):
        if is_link(path):
            raise ValueError("antenna manifest path contains a link")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != "antenna_field_solution.v1" or manifest.get("status") != "ready":
        raise ValueError(f"not a ready antenna field solution: {manifest_path}")
    for key in ("solution_id", "asset_id"):
        value = manifest.get(key)
        if (not isinstance(value, str) or not value.strip() or value in (".", "..")
                or any(character in value for character in ("/", "\\", ":"))):
            raise ValueError(f"invalid manifest identity: {key}")
    if (manifest["solution_id"] != solution_directory.name
            or (directory != solution_directory and manifest["asset_id"] != directory.name)):
        raise ValueError("manifest identity does not match the selected directory")
    prefix = ("antenna", "field_solutions", manifest["solution_id"])
    positions = read_vectors(directory, prefix, manifest["sample_positions"], "m")
    bases = [basis for basis in manifest["bases"] if basis["port_mode_id"] == port_mode_id]
    if len(bases) != 1 or bases[0].get("normalization_current_a") != 1.0:
        raise ValueError("expected exactly one basis normalized to 1 A")
    basis = bases[0]
    diagnostics = basis.get("quadrature_diagnostics")
    if (not isinstance(diagnostics, dict)
            or diagnostics.get("schema_version") != "fem_oersted_direct_tetra_quadrature.v1"
            or diagnostics.get("unconverged_pair_count") != 0
            or not isinstance(diagnostics.get("maximum_pair_error_apm"), (int, float))
            or not math.isfinite(diagnostics["maximum_pair_error_apm"])):
        raise ValueError("field lacks a converged quadrature certificate")
    field = read_vectors(directory, prefix, basis["magnetic_field_per_ampere"], "A/m/A")
    if len(positions) != len(field):
        raise ValueError("field and sample positions have different lengths")
    return positions, field


def relative_errors(positions, field, start, end, minimum_distance):
    error_squared = reference_squared = 0.0
    maximum_error = maximum_reference = 0.0
    for position, observed in zip(positions, field):
        reference, radial_distance = finite_wire_field(start, end, position)
        if radial_distance < minimum_distance:
            raise ValueError("sample is inside the excluded near-wire region")
        difference = math.sqrt(sum((observed[i] - reference[i]) ** 2 for i in range(3)))
        magnitude = math.sqrt(sum(value * value for value in reference))
        error_squared += difference * difference
        reference_squared += magnitude * magnitude
        maximum_error = max(maximum_error, difference)
        maximum_reference = max(maximum_reference, magnitude)
    if reference_squared == 0.0:
        raise ValueError("reference field is zero at every sample")
    return {"l2_relative": math.sqrt(error_squared / reference_squared),
            "linf_relative": maximum_error / maximum_reference,
            "sample_count": len(positions)}


def verify(manifests, port_mode_id, start, end, minimum_distance, max_l2, max_linf):
    if len(manifests) != 3:
        raise ValueError("exactly three mesh levels are required")
    levels = []
    reference_positions = None
    for name, manifest in zip(("coarse", "medium", "fine"), manifests):
        positions, field = read_solution(manifest, port_mode_id)
        if reference_positions is not None and positions != reference_positions:
            raise ValueError("mesh levels must use identical physical sample positions")
        reference_positions = positions
        levels.append({"level": name, "manifest": str(Path(manifest).resolve()),
                       **relative_errors(positions, field, start, end, minimum_distance)})
    if levels[2]["l2_relative"] >= levels[0]["l2_relative"]:
        raise ValueError("fine-mesh L2 error did not improve over coarse mesh")
    if levels[2]["l2_relative"] > max_l2 or levels[2]["linf_relative"] > max_linf:
        raise ValueError("fine-mesh field error exceeds the requested tolerance")
    return {"schema": "fullmag.antenna.field_convergence.v1", "status": "pass",
            "port_mode_id": port_mode_id,
            "reference": {"model": "finite_straight_filament", "current_a": 1.0,
                          "start_xyz_m": start, "end_xyz_m": end,
                          "minimum_radial_distance_m": minimum_distance},
            "tolerances": {"l2_relative": max_l2, "linf_relative": max_linf},
            "levels": levels}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifests", nargs=3, type=Path, required=True)
    parser.add_argument("--port-mode-id", required=True)
    parser.add_argument("--wire-start", nargs=3, type=float, required=True)
    parser.add_argument("--wire-end", nargs=3, type=float, required=True)
    parser.add_argument("--minimum-distance-m", type=float, required=True)
    parser.add_argument("--max-l2-relative", type=float, required=True)
    parser.add_argument("--max-linf-relative", type=float, required=True)
    args = parser.parse_args()
    if any(not math.isfinite(value) or value <= 0 for value in (
        args.minimum_distance_m, args.max_l2_relative, args.max_linf_relative
    )):
        parser.error("distance and tolerances must be positive and finite")
    print(json.dumps(verify(args.manifests, args.port_mode_id, args.wire_start,
                            args.wire_end, args.minimum_distance_m,
                            args.max_l2_relative, args.max_linf_relative), indent=2))


if __name__ == "__main__":
    main()
