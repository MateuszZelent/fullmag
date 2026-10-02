#!/usr/bin/env python3
"""Independently verify the stored finite-element ``-grad(phi)`` artifact.

The validator consumes the artifacts written by
``eigen_physical_potential.rs`` directly:

* ``physical_potential.v1.json``;
* its ``potential_full.bin`` and ``demag_element_full.bin`` sidecars; and
* the run ``metadata.json`` containing the source FEM mesh.

It deliberately validates only the algebraic reconstruction of the stored
element field.  A consistent reconstruction is not a demagnetisation or T4
qualification result.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import sys
from pathlib import Path
from typing import Any, Iterable, NoReturn, Sequence


SCHEMA_VERSION = "fem_modal_physical_potential.v1"
RESULT_SCHEMA_VERSION = "de_physical_potential_validation.v1"
QUALIFICATION = "NOT VERIFIED"
DEFAULT_RTOL = 1.0e-10
DEFAULT_ZERO_SCALE = 1.0
DEGENERACY_RELATIVE_TOL = 1.0e-14
# The producer and this independent checker evaluate the same P1 gradient
# from separately serialized mesh coordinates.  Tangential gradients at a
# Dirichlet airbox face can be the result of cancelling three terms of order
# 1e8.  Keep the requested relative tolerance for physical discrepancies,
# while accounting explicitly for the finite-precision forward error of that
# cancellation.  The operation count is derived below from the scalar
# Tet4-gradient and complex four-node accumulation paths, then doubled for
# the two independent evaluations being compared.
FLOAT64_UNIT_ROUNDOFF = sys.float_info.epsilon / 2.0
TET4_GRADIENT_OPERATION_COUNT = 20  # 9 cross + 5 determinant + 3 divide + 3 nodal sum
COMPLEX_FIELD_OPERATION_COUNT = 32  # 4 complex products (24) + 4 complex sums (8)
GRADIENT_FORWARD_OPERATION_COUNT = 2 * (
    TET4_GRADIENT_OPERATION_COUNT + COMPLEX_FIELD_OPERATION_COUNT
)


def _gamma(operation_count: int) -> float:
    """Return Higham's ``gamma_n = n*u/(1-n*u)`` rounding bound."""

    numerator = operation_count * FLOAT64_UNIT_ROUNDOFF
    return numerator / (1.0 - numerator)


GRADIENT_FORWARD_GAMMA = _gamma(GRADIENT_FORWARD_OPERATION_COUNT)
SHA256_RE = re.compile(r"^sha256:([0-9a-fA-F]{64})$")


class ValidationError(ValueError):
    """A malformed, incomplete, or unsupported producer artifact."""


def _fail(message: str) -> NoReturn:
    raise ValidationError(message)


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _is_real(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        _require(key not in result, f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _load_json(path: Path, description: str) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as stream:
            value = json.load(stream, object_pairs_hook=_unique_json_object)
    except FileNotFoundError as exc:
        _fail(f"{description} does not exist: {path}")
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"cannot read {description} {path}: {exc}")
    _require(isinstance(value, dict), f"{description} must be a JSON object: {path}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        _fail(f"cannot read binary artifact {path}: {exc}")
    return digest.hexdigest()


def _declared_digest(value: Any, field: str) -> str:
    _require(isinstance(value, str), f"manifest field {field} must be a sha256 string")
    match = SHA256_RE.fullmatch(value)
    _require(match is not None, f"manifest field {field} must have the form sha256:<64 hex digits>")
    return match.group(1).lower()


def _resolve_declared_path(run_root: Path, declared: Any, field: str) -> Path:
    _require(isinstance(declared, str) and declared, f"manifest field {field}.path must be non-empty")
    declared_path = Path(declared)
    _require(not declared_path.is_absolute(), f"manifest field {field}.path must be relative to the run root")
    _require(".." not in declared_path.parts, f"manifest field {field}.path may not traverse outside the run root")
    root = run_root.resolve()
    candidate = (root / declared_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        _fail(f"manifest field {field}.path resolves outside the run root")
    _require(candidate.is_file(), f"manifest field {field}.path does not exist below the run root: {candidate}")
    return candidate


def _positive_count(value: Any, field: str) -> int:
    _require(_is_integer(value) and value > 0, f"manifest field {field} must be a positive integer")
    return int(value)


def _validate_manifest(manifest_path: Path, run_root: Path) -> tuple[dict[str, Any], Path, int, Path, int]:
    manifest = _load_json(manifest_path, "physical-potential manifest")
    _require(manifest.get("schema_version") == SCHEMA_VERSION, "unsupported physical-potential manifest schema")
    _require(manifest.get("representation") == "full_physical_phasor", "manifest representation is not full_physical_phasor")
    _require(manifest.get("phasor_convention") == "exp(+i*omega*t)", "unsupported phasor convention")

    potential = manifest.get("potential")
    field = manifest.get("demag_field")
    _require(isinstance(potential, dict), "manifest must contain a potential object")
    _require(isinstance(field, dict), "manifest must contain a demag_field object")

    potential_contract = {
        "dtype": "float64",
        "byte_order": "little",
        "layout": "node_major_real_imag",
        "association": "source_mesh_nodes",
        "unit": "A",
    }
    field_contract = {
        "dtype": "float64",
        "byte_order": "little",
        "layout": "element_major_xyz_real_imag",
        "association": "source_mesh_tet4_elements",
        "unit": "A/m",
        "reconstruction": "-grad(phi_full)",
        "recovery": "none",
    }
    for key, expected in potential_contract.items():
        _require(potential.get(key) == expected, f"unsupported potential contract field {key!r}")
    for key, expected in field_contract.items():
        _require(field.get(key) == expected, f"unsupported demag_field contract field {key!r}")

    potential_count = _positive_count(potential.get("count"), "potential.count")
    field_count = _positive_count(field.get("count"), "demag_field.count")
    potential_digest = _declared_digest(potential.get("sha256"), "potential.sha256")
    field_digest = _declared_digest(field.get("sha256"), "demag_field.sha256")
    potential_path = _resolve_declared_path(run_root, potential.get("path"), "potential")
    field_path = _resolve_declared_path(run_root, field.get("path"), "demag_field")
    _require(_sha256(potential_path) == potential_digest, "potential_full.bin does not match manifest sha256")
    _require(_sha256(field_path) == field_digest, "demag_element_full.bin does not match manifest sha256")
    return manifest, potential_path, potential_count, field_path, field_count


def _validate_declared_mode_binding(
    manifest: dict[str, Any], manifest_path: Path, mode_metadata_path: Path,
    run_root: Path, potential_path: Path, field_path: Path,
) -> dict[str, Any]:
    """Bind declared provenance to one published mode, not a physics proof."""
    try:
        mode_metadata_path.relative_to(run_root)
    except ValueError:
        _fail("published mode metadata must be inside the metadata run root")
    mode = _load_json(mode_metadata_path, "published mode metadata")
    sample = manifest.get("sample_index")
    raw_mode = manifest.get("mode_index")
    for value, name in ((sample, "sample_index"), (raw_mode, "mode_index")):
        _require(_is_integer(value) and value >= 0, f"manifest {name} must be a non-negative integer")
    for name, expected in (("sample_index", sample), ("raw_mode_index", raw_mode)):
        value = mode.get(name)
        _require(_is_integer(value) and value == expected, f"mode metadata {name} disagrees with potential manifest")
    if "index" in mode:
        _require(_is_integer(mode["index"]) and mode["index"] == raw_mode,
                 "mode metadata index disagrees with raw_mode_index")
    field_dir = run_root / "eigen/mode_fields" / f"sample_{sample:04d}" / f"mode_{raw_mode:04d}"
    expected_mode = run_root / "eigen/modes" / f"sample_{sample:04d}" / f"mode_{raw_mode:04d}.json"
    _require(manifest_path == (field_dir / "physical_potential.v1.json"),
             "potential manifest path disagrees with declared sample/mode")
    _require(mode_metadata_path == expected_mode,
             "mode metadata path disagrees with declared sample/mode")
    _require(potential_path == (field_dir / "potential_full.bin"),
             "potential sidecar path disagrees with declared sample/mode")
    _require(field_path == (field_dir / "demag_element_full.bin"),
             "demag sidecar path disagrees with declared sample/mode")
    identities = {}
    for key in ("source_mesh_topology_sha256", "operator_input_signature_sha256", "phase_constraint_sha256"):
        expected = _declared_digest(manifest.get(key), key)
        actual = _declared_digest(mode.get(key), "mode." + key)
        _require(actual == expected, f"mode metadata {key} disagrees with potential manifest")
        identities[key] = "sha256:" + expected
    return {"status": "consistent", "scope": "declared_mode_provenance_only",
            "sample_index": sample, "raw_mode_index": raw_mode, **identities,
            "mode_metadata_sha256": "sha256:" + _sha256(mode_metadata_path),
            "manifest_sha256": "sha256:" + _sha256(manifest_path)}


def _validate_source_mesh_binding(manifest: dict[str, Any], metadata: dict[str, Any], metadata_path: Path) -> dict[str, Any]:
    """Recompute the canonical v3 topology without coercing producer arrays."""
    from types import SimpleNamespace
    source = Path(__file__).resolve().parents[1] / "packages/fullmag-py/src"
    if str(source) not in sys.path:
        sys.path.insert(0, str(source))
    try:
        from fullmag.meshing._gmsh_types import MeshData
        mesh = metadata["execution_plan"]["backend_plan"]["mesh"]
        cells, facets = mesh["cells"], mesh["facets"]
        values = {"nodes": mesh["nodes"], "element_markers": mesh["element_markers"],
                  "boundary_markers": mesh["boundary_markers"],
                  "periodic_boundary_pairs": mesh.get("periodic_boundary_pairs", []),
                  "periodic_node_pairs": mesh.get("periodic_node_pairs", [])}
        for prefix, connectivity in (("cell", cells), ("facet", facets)):
            for key in ("types", "offsets", "nodes"):
                values[prefix + "_" + key] = connectivity[key]
            values[prefix + "_global_ordinals"] = connectivity.get("global_ordinals", [])
        values["cell_mesh_parts"] = cells.get("mesh_parts", [])
        values["facet_roles"] = facets["roles"]
        actual = MeshData.topology_fingerprint_v3(SimpleNamespace(**values))
    except (ImportError, KeyError, TypeError, ValueError, OverflowError, struct.error) as exc:
        _fail(f"cannot recompute canonical source mesh topology: {exc}")
    expected = "sha256:" + _declared_digest(manifest.get("source_mesh_topology_sha256"), "source_mesh_topology_sha256")
    _require(actual == expected, "recomputed source mesh topology disagrees with potential manifest")
    return {"status": "consistent", "fingerprint_version": "v3",
            "source_mesh_topology_sha256": actual,
            "metadata_sha256": "sha256:" + _sha256(metadata_path)}


def _read_complex_values(path: Path, count: int, description: str) -> list[complex]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        _fail(f"cannot read {description} {path}: {exc}")
    expected_size = count * 16
    _require(len(raw) == expected_size, f"{description} has {len(raw)} bytes; expected {expected_size}")
    values: list[complex] = []
    for offset in range(0, len(raw), 16):
        real, imag = struct.unpack_from("<dd", raw, offset)
        _require(math.isfinite(real) and math.isfinite(imag), f"{description} contains a non-finite value at byte offset {offset}")
        values.append(complex(real, imag))
    return values


def _extract_mesh(metadata: dict[str, Any]) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int, int]]]:
    execution_plan = metadata.get("execution_plan")
    _require(isinstance(execution_plan, dict), "run metadata has no execution_plan object")
    backend_plan = execution_plan.get("backend_plan")
    _require(isinstance(backend_plan, dict), "run metadata execution_plan has no backend_plan object")
    _require(backend_plan.get("kind") == "fem_eigen", "run metadata backend_plan is not the tagged fem_eigen plan")
    mesh = backend_plan.get("mesh")
    _require(isinstance(mesh, dict), "run metadata backend_plan has no mesh object")

    raw_nodes = mesh.get("nodes")
    _require(isinstance(raw_nodes, list) and raw_nodes, "mesh.nodes must be a non-empty list")
    nodes: list[tuple[float, float, float]] = []
    for node_index, raw_node in enumerate(raw_nodes):
        _require(isinstance(raw_node, (list, tuple)) and len(raw_node) == 3, f"mesh node {node_index} is not a 3D coordinate")
        _require(all(_is_real(value) for value in raw_node), f"mesh node {node_index} contains a non-finite coordinate")
        nodes.append((float(raw_node[0]), float(raw_node[1]), float(raw_node[2])))

    raw_elements = mesh.get("elements")
    cells = mesh.get("cells")
    _require(not (raw_elements is not None and cells is not None), "mesh metadata must not contain both legacy elements and canonical cells")
    if raw_elements is not None:
        _require(isinstance(raw_elements, list) and raw_elements, "mesh.elements must be a non-empty list")
        elements: list[tuple[int, int, int, int]] = []
        for element_index, raw_element in enumerate(raw_elements):
            _require(isinstance(raw_element, (list, tuple)) and len(raw_element) == 4, f"mesh element {element_index} is not a Tet4 connectivity row")
            _require(all(_is_integer(value) for value in raw_element), f"mesh element {element_index} has a non-integer node index")
            indices = tuple(int(value) for value in raw_element)
            _require(all(0 <= value < len(nodes) for value in indices), f"mesh element {element_index} references a node outside mesh.nodes")
            elements.append(indices)  # type: ignore[arg-type]
        return nodes, elements

    # Canonical MeshIR connectivity is represented by parallel types/offsets/
    # nodes arrays in metadata snapshots that have not been compatibility-
    # serialized to the producer's ``elements`` rows.
    _require(isinstance(cells, dict), "mesh must contain producer elements or canonical cells connectivity")
    raw_types = cells.get("types")
    raw_offsets = cells.get("offsets")
    raw_cell_nodes = cells.get("nodes")
    _require(isinstance(raw_types, list) and raw_types, "mesh.cells.types must be a non-empty list")
    _require(isinstance(raw_offsets, list), "mesh.cells.offsets must be a list")
    _require(isinstance(raw_cell_nodes, list), "mesh.cells.nodes must be a list")
    _require(len(raw_offsets) == len(raw_types) + 1, "mesh.cells.offsets length must be types length plus one")
    _require(raw_offsets[0] == 0, "mesh.cells.offsets must start at zero")
    _require(all(_is_integer(value) for value in raw_offsets), "mesh.cells.offsets must contain integers")
    offsets = [int(value) for value in raw_offsets]
    _require(all(left <= right for left, right in zip(offsets, offsets[1:])), "mesh.cells.offsets must be monotone")
    _require(offsets[-1] == len(raw_cell_nodes), "mesh.cells.offsets does not cover mesh.cells.nodes")
    _require(all(_is_integer(value) for value in raw_cell_nodes), "mesh.cells.nodes must contain integer indices")
    flat_nodes = [int(value) for value in raw_cell_nodes]

    elements = []
    for cell_index, cell_type in enumerate(raw_types):
        _require(isinstance(cell_type, str) and cell_type.lower() == "tet4", f"unsupported mesh cell type at index {cell_index}: {cell_type!r}")
        begin, end = offsets[cell_index], offsets[cell_index + 1]
        row = flat_nodes[begin:end]
        _require(len(row) == 4, f"mesh cell {cell_index} is not a Tet4 connectivity row")
        _require(all(0 <= value < len(nodes) for value in row), f"mesh cell {cell_index} references a node outside mesh.nodes")
        elements.append(tuple(row))  # type: ignore[arg-type]
    _require(elements, "mesh.cells must contain at least one Tet4")
    return nodes, elements


def _sub(left: Sequence[float], right: Sequence[float]) -> tuple[float, float, float]:
    return (left[0] - right[0], left[1] - right[1], left[2] - right[2])


def _cross(left: Sequence[float], right: Sequence[float]) -> tuple[float, float, float]:
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )


def _dot(left: Sequence[float], right: Sequence[float]) -> float:
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]


def _norm(value: Sequence[float]) -> float:
    return math.sqrt(_dot(value, value))


def _tet4_gradients(nodes: Sequence[tuple[float, float, float]], element: Sequence[int], element_index: int) -> tuple[tuple[float, float, float], ...]:
    p0, p1, p2, p3 = (nodes[index] for index in element)
    a, b, c = _sub(p1, p0), _sub(p2, p0), _sub(p3, p0)
    determinant = _dot(a, _cross(b, c))
    edge_scale = max(_norm(a), _norm(b), _norm(c), _norm(_sub(p2, p1)), _norm(_sub(p3, p1)), _norm(_sub(p3, p2)))
    _require(math.isfinite(determinant) and math.isfinite(edge_scale) and edge_scale > 0.0, f"Tet4 element {element_index} has invalid geometry")
    determinant_floor = DEGENERACY_RELATIVE_TOL * max(edge_scale**3, 1.0e-300)
    _require(abs(determinant) > determinant_floor, f"Tet4 element {element_index} is degenerate or numerically singular")
    _require(determinant > determinant_floor, f"Tet4 element {element_index} has negative orientation")

    grad_1 = tuple(value / determinant for value in _cross(b, c))
    grad_2 = tuple(value / determinant for value in _cross(c, a))
    grad_3 = tuple(value / determinant for value in _cross(a, b))
    grad_0 = tuple(-(grad_1[axis] + grad_2[axis] + grad_3[axis]) for axis in range(3))
    gradients = (grad_0, grad_1, grad_2, grad_3)
    _require(all(math.isfinite(value) for gradient in gradients for value in gradient), f"Tet4 element {element_index} produced non-finite shape gradients")
    return gradients


def _reconstruct_field(phi: Sequence[complex], nodes: Sequence[tuple[float, float, float]], elements: Sequence[Sequence[int]]) -> list[complex]:
    reconstructed, _ = _reconstruct_field_with_bounds(phi, nodes, elements)
    return reconstructed


def _reconstruct_field_with_bounds(
    phi: Sequence[complex],
    nodes: Sequence[tuple[float, float, float]],
    elements: Sequence[Sequence[int]],
) -> tuple[list[complex], list[float]]:
    """Reconstruct ``-grad(phi)`` and its per-component roundoff envelope.

    ``sum(abs(phi_i)) * sum(abs(grad_i))`` is the forward-error scale for a
    P1 component when the shape-gradient terms are independently rounded and
    then accumulated.  This matters for nearly cancelling components, where
    the physical result is near zero although the terms are not.  The local
    multiplier is ``gamma_n`` for the explicitly counted float64 operations
    in the producer and checker.  It is an error bound for reconstruction
    arithmetic on the same non-degenerate Tet4 geometry, not a replacement
    for the configured relative comparison tolerance or a mesh-conditioning
    certificate.
    """
    reconstructed: list[complex] = []
    forward_error_bounds: list[float] = []
    for element_index, element in enumerate(elements):
        gradients = _tet4_gradients(nodes, element, element_index)
        potential_l1 = math.fsum(abs(phi[node_index]) for node_index in element)
        for axis in range(3):
            value = 0j
            for local_index, node_index in enumerate(element):
                value -= phi[node_index] * gradients[local_index][axis]
            _require(math.isfinite(value.real) and math.isfinite(value.imag), f"reconstructed field is non-finite at element {element_index}, component {axis}")
            reconstructed.append(value)
            gradient_l1 = math.fsum(abs(gradients[local_index][axis]) for local_index in range(4))
            forward_error_bound = (
                GRADIENT_FORWARD_GAMMA
                * potential_l1
                * gradient_l1
            )
            _require(
                math.isfinite(forward_error_bound),
                f"reconstruction forward-error bound is non-finite at element {element_index}, component {axis}",
            )
            forward_error_bounds.append(forward_error_bound)
    return reconstructed, forward_error_bounds


def validate_physical_potential(
    manifest_path: Path | str,
    mesh_metadata_path: Path | str,
    *,
    rtol: float = DEFAULT_RTOL,
    zero_scale: float = DEFAULT_ZERO_SCALE,
    mode_metadata_path: Path | str | None = None,
    verify_source_mesh: bool = False,
) -> dict[str, Any]:
    """Compare stored Tet4 element fields with an independent P1 gradient.

    ``rtol`` is dimensionless and ``zero_scale`` is in the demag field's
    declared A/m unit. The comparison rule is explicitly
    ``abs(error) <= rtol * max(abs(expected), abs(reconstructed), zero_scale)
    + forward_error_bound``. The local roundoff envelope is computed from
    the potential and shape-gradient terms; it does not certify mesh conditioning.
    Contract and geometry errors raise :class:`ValidationError`; a numerical
    mismatch is returned as a report with ``status == "mismatch"``.
    """

    _require(_is_real(rtol) and rtol >= 0.0, "rtol must be a finite non-negative number")
    _require(_is_real(zero_scale) and zero_scale > 0.0, "zero_scale must be a finite positive number")
    _require(isinstance(verify_source_mesh, bool), "verify_source_mesh must be boolean")
    metadata_file = Path(mesh_metadata_path).resolve()
    manifest_file = Path(manifest_path).resolve()
    run_root = metadata_file.parent
    try:
        manifest_file.relative_to(run_root)
    except ValueError:
        _fail("physical-potential manifest must be inside the metadata run root")
    manifest, potential_path, potential_count, field_path, field_count = _validate_manifest(manifest_file, run_root)
    identity_binding: dict[str, Any] = {"status": "not_requested"}
    if mode_metadata_path is not None:
        identity_binding = _validate_declared_mode_binding(
            manifest, manifest_file, Path(mode_metadata_path).resolve(),
            run_root, potential_path, field_path)
    metadata = _load_json(metadata_file, "run metadata")
    nodes, elements = _extract_mesh(metadata)
    source_mesh_binding = (_validate_source_mesh_binding(manifest, metadata, metadata_file)
                           if verify_source_mesh else {"status": "not_requested"})
    _require(potential_count == len(nodes), f"manifest potential.count={potential_count} does not match mesh node count {len(nodes)}")
    _require(field_count == len(elements), f"manifest demag_field.count={field_count} does not match mesh element count {len(elements)}")

    phi = _read_complex_values(potential_path, potential_count, "potential_full.bin")
    stored_field = _read_complex_values(field_path, field_count * 3, "demag_element_full.bin")
    reconstructed, forward_error_bounds = _reconstruct_field_with_bounds(phi, nodes, elements)

    max_abs_error = 0.0
    max_normalized_error = 0.0
    worst_element = 0
    worst_component = 0
    mismatch_count = 0
    first_mismatch: dict[str, Any] | None = None
    for flat_index, (expected, actual) in enumerate(zip(stored_field, reconstructed)):
        element_index, component = divmod(flat_index, 3)
        error = abs(expected - actual)
        scale = max(abs(expected), abs(actual), float(zero_scale))
        tolerance = float(rtol) * scale + forward_error_bounds[flat_index]
        normalized_error = error / scale
        if normalized_error > max_normalized_error:
            max_normalized_error = normalized_error
            worst_element = element_index
            worst_component = component
        max_abs_error = max(max_abs_error, error)
        if error > tolerance:
            mismatch_count += 1
            if first_mismatch is None:
                first_mismatch = {
                    "element": element_index,
                    "component": component,
                    "stored_real": expected.real,
                    "stored_imag": expected.imag,
                    "reconstructed_real": actual.real,
                    "reconstructed_imag": actual.imag,
                    "absolute_error": error,
                    "scale": scale,
                    "forward_error_bound": forward_error_bounds[flat_index],
                    "tolerance": tolerance,
                }

    status = "consistent" if mismatch_count == 0 else "mismatch"
    comparison: dict[str, Any] = {
        "rtol": float(rtol),
        "zero_scale": float(zero_scale),
        "forward_error_operation_count": GRADIENT_FORWARD_OPERATION_COUNT,
        "forward_error_gamma": GRADIENT_FORWARD_GAMMA,
        "max_forward_error_bound": max(forward_error_bounds, default=0.0),
        "tolerance_rule": "abs(error) <= rtol * max(abs(stored), abs(reconstructed), zero_scale) + gamma_104 * sum(abs(phi_i)) * sum(abs(grad_i)); gamma_n = n * (eps / 2) / (1 - n * (eps / 2))",
        "node_count": len(nodes),
        "element_count": len(elements),
        "max_absolute_error": max_abs_error,
        "max_normalized_error": max_normalized_error,
        "worst_element": worst_element,
        "worst_component": worst_component,
        "mismatch_count": mismatch_count,
    }
    if first_mismatch is not None:
        comparison["first_mismatch"] = first_mismatch

    return {
        "schema_version": RESULT_SCHEMA_VERSION,
        "status": status,
        "qualification": QUALIFICATION,
        "reconstruction_agreement": mismatch_count == 0,
        "manifest_schema_version": manifest.get("schema_version"),
        "identity_binding": identity_binding,
        "source_mesh_binding": source_mesh_binding,
        "potential_path": str(potential_path),
        "demag_field_path": str(field_path),
        "comparison": comparison,
        "qualification_note": "This report covers only independent stored-field reconstruction; it does not qualify demagnetization or T4 physics.",
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path, help="physical_potential.v1.json")
    parser.add_argument("--mesh-metadata", required=True, type=Path, help="run metadata.json containing execution_plan.backend_plan.mesh")
    parser.add_argument("--mode-metadata", type=Path, help="optional published mode JSON for declared identity binding")
    parser.add_argument("--verify-source-mesh", action="store_true", help="recompute canonical v3 source topology")
    parser.add_argument("--rtol", type=float, default=DEFAULT_RTOL, help=f"relative tolerance (default: {DEFAULT_RTOL:g})")
    parser.add_argument("--zero-scale", type=float, default=DEFAULT_ZERO_SCALE, help=f"positive A/m scale floor (default: {DEFAULT_ZERO_SCALE:g})")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        report = validate_physical_potential(args.manifest, args.mesh_metadata, rtol=args.rtol, zero_scale=args.zero_scale, mode_metadata_path=args.mode_metadata, verify_source_mesh=args.verify_source_mesh)
    except ValidationError as exc:
        error_report = {
            "schema_version": RESULT_SCHEMA_VERSION,
            "status": "invalid",
            "qualification": QUALIFICATION,
            "reconstruction_agreement": False,
            "error": str(exc),
            "qualification_note": "Invalid input cannot qualify demagnetization or T4 physics.",
        }
        json.dump(error_report, sys.stderr, indent=2, sort_keys=True)
        sys.stderr.write("\n")
        return 2
    json.dump(report, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if report["status"] == "consistent" else 1


if __name__ == "__main__":
    raise SystemExit(main())
