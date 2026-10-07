#!/usr/bin/env python3
"""Materialize the A1 FEM ProblemIR and mesh in a managed Python image.

This is a bounded authoring/mesh diagnostic.  It intentionally loads the
public benchmark script and serializes its canonical ProblemIR, but it never
constructs a ``Simulation`` or executes a relaxation/eigensolve.  The caller
must provide a new output directory, normally a canonical Fullmag storage
directory mounted at ``/artifacts`` by the managed container route.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import sys
import traceback
from typing import Any, Mapping


SCHEMA_VERSION = "fullmag.comsol_nonzero_k.mesh_materialization.v1"
DEFAULT_CASE = "a1"
EXPECTED_GMSH_VERSION = "4.15.2"
EXPECTED_IMAGE_DIGEST = (
    "sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7"
)


def _ensure_repository_imports() -> Path:
    """Make both the package and ``tests`` namespace visible in a file run."""

    repository_root = Path(__file__).resolve().parents[4]
    package_source = repository_root / "packages" / "fullmag-py" / "src"
    for path in (repository_root, package_source):
        rendered = str(path)
        if rendered not in sys.path:
            sys.path.insert(0, rendered)
    return repository_root


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    """Publish one JSON document atomically after a complete write."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def _counts(values: object) -> dict[str, int]:
    if not isinstance(values, list):
        return {}
    return dict(sorted(Counter(str(value) for value in values).items()))


def _runtime_metadata(ir: Mapping[str, Any]) -> Mapping[str, Any]:
    problem_meta = ir.get("problem_meta")
    if not isinstance(problem_meta, Mapping):
        raise ValueError("ProblemIR is missing problem_meta")
    metadata = problem_meta.get("runtime_metadata")
    if not isinstance(metadata, Mapping):
        raise ValueError("ProblemIR is missing problem_meta.runtime_metadata")
    return metadata


def _domain_asset(ir: Mapping[str, Any]) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    assets = ir.get("geometry_assets")
    if not isinstance(assets, Mapping):
        raise ValueError("ProblemIR is missing geometry_assets")
    domain = assets.get("fem_domain_mesh_asset")
    if not isinstance(domain, Mapping):
        raise ValueError("ProblemIR is missing geometry_assets.fem_domain_mesh_asset")
    mesh = domain.get("mesh")
    if not isinstance(mesh, Mapping):
        raise ValueError("ProblemIR is missing fem_domain_mesh_asset.mesh")
    return domain, mesh


def _mesh_summary(mesh: Mapping[str, Any]) -> dict[str, Any]:
    nodes = mesh.get("nodes")
    cells = mesh.get("cells")
    facets = mesh.get("facets")
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("materialized mesh has no nodes")
    if not isinstance(cells, Mapping):
        raise ValueError("materialized mesh is missing cells")
    if not isinstance(facets, Mapping):
        raise ValueError("materialized mesh is missing facets")

    cell_types = cells.get("types")
    cell_offsets = cells.get("offsets")
    cell_nodes = cells.get("nodes")
    facet_types = facets.get("types")
    facet_roles = facets.get("roles")
    facet_offsets = facets.get("offsets")
    facet_nodes = facets.get("nodes")
    if not isinstance(cell_types, list) or not cell_types:
        raise ValueError("materialized mesh has no volume cells")
    if not isinstance(cell_offsets, list) or len(cell_offsets) != len(cell_types) + 1:
        raise ValueError("materialized mesh cell offsets are inconsistent")
    if not isinstance(cell_nodes, list) or not cell_nodes:
        raise ValueError("materialized mesh has no cell connectivity")
    if not isinstance(facet_types, list) or not facet_types:
        raise ValueError("materialized mesh has no boundary facets")
    if not isinstance(facet_roles, list) or len(facet_roles) != len(facet_types):
        raise ValueError("materialized mesh facet roles are inconsistent")
    if not isinstance(facet_offsets, list) or len(facet_offsets) != len(facet_types) + 1:
        raise ValueError("materialized mesh facet offsets are inconsistent")
    if not isinstance(facet_nodes, list) or not facet_nodes:
        raise ValueError("materialized mesh has no facet connectivity")

    tet_count = sum(str(kind) == "tet4" for kind in cell_types)
    periodic_boundary_pairs = mesh.get("periodic_boundary_pairs", [])
    periodic_node_pairs = mesh.get("periodic_node_pairs", [])
    if not isinstance(periodic_boundary_pairs, list):
        raise ValueError("periodic_boundary_pairs must be an array")
    if not isinstance(periodic_node_pairs, list):
        raise ValueError("periodic_node_pairs must be an array")

    return {
        "node_count": len(nodes),
        "cell_count": len(cell_types),
        "tet4_count": tet_count,
        "cell_type_counts": _counts(cell_types),
        "cell_connectivity_length": len(cell_nodes),
        "facet_count": len(facet_types),
        "facet_type_counts": _counts(facet_types),
        "facet_role_counts": _counts(facet_roles),
        "facet_connectivity_length": len(facet_nodes),
        "element_marker_counts": _counts(mesh.get("element_markers")),
        "boundary_marker_counts": _counts(mesh.get("boundary_markers")),
        "region_marker_count": len(mesh.get("region_markers", []))
        if isinstance(mesh.get("region_markers"), list)
        else None,
        "periodic_boundary_pair_count": len(periodic_boundary_pairs),
        "periodic_boundary_pair_ids": sorted(
            str(pair.get("pair_id"))
            for pair in periodic_boundary_pairs
            if isinstance(pair, Mapping)
        ),
        "periodic_node_pair_count": len(periodic_node_pairs),
        "periodic_mesh_certificate": mesh.get("periodic_mesh_certificate"),
        "mesh_realization_report": mesh.get("mesh_realization_report"),
        "mixed_layer_topology_certificate": mesh.get("mixed_layer_topology_certificate"),
        "mesh_statistics": mesh.get("mesh_statistics"),
    }


def _thin_film_operation(
    build_report: object,
) -> Mapping[str, Any] | None:
    if not isinstance(build_report, Mapping):
        return None
    statuses = build_report.get("operation_statuses")
    if not isinstance(statuses, list):
        return None
    for status in statuses:
        if isinstance(status, Mapping) and status.get("kind") == "thin_film":
            return status
    return None


def _count_coordinate_planes(values: list[float]) -> int:
    if not values or not all(math.isfinite(value) for value in values):
        return 0
    ordered = sorted(values)
    thickness = ordered[-1] - ordered[0]
    tolerance = max(1.0e-15, 1.0e-8 * thickness)
    planes: list[float] = []
    for value in ordered:
        if not planes or abs(value - planes[-1]) > tolerance:
            planes.append(value)
    return len(planes)


def _thin_film_mesh_evidence(
    domain: Mapping[str, Any],
    mesh: Mapping[str, Any],
    benchmark: Mapping[str, Any],
) -> dict[str, Any]:
    """Derive layer evidence from serialized topology, independently of the report."""
    mesh_contract = benchmark.get("mesh")
    expected_layers = (
        mesh_contract.get("thin_film_layers")
        if isinstance(mesh_contract, Mapping)
        else None
    )
    if isinstance(expected_layers, bool) or not isinstance(expected_layers, int):
        expected_layers = None

    region_markers = domain.get("region_markers")
    magnetic_marker = None
    if isinstance(region_markers, list):
        for entry in region_markers:
            if not isinstance(entry, Mapping):
                continue
            marker = entry.get("marker")
            if isinstance(marker, int) and not isinstance(marker, bool):
                magnetic_marker = marker
                break

    nodes = mesh.get("nodes")
    cells = mesh.get("cells")
    markers = mesh.get("element_markers")
    cell_types = cells.get("types") if isinstance(cells, Mapping) else None
    cell_offsets = cells.get("offsets") if isinstance(cells, Mapping) else None
    cell_nodes = cells.get("nodes") if isinstance(cells, Mapping) else None
    evidence: dict[str, Any] = {
        "expected_layers": expected_layers,
        "magnetic_marker": magnetic_marker,
        "magnetic_cell_count": 0,
        "magnetic_node_count": 0,
        "resolved_layer_planes": 0,
        "all_volume_cells_tet4": isinstance(cell_types, list)
        and bool(cell_types)
        and all(str(kind) == "tet4" for kind in cell_types),
        "all_boundary_facets_tri3": False,
        "periodic_pair_ids": [],
    }
    facet_types = mesh.get("facets", {}).get("types") if isinstance(mesh.get("facets"), Mapping) else None
    evidence["all_boundary_facets_tri3"] = (
        isinstance(facet_types, list)
        and bool(facet_types)
        and all(str(kind) == "tri3" for kind in facet_types)
    )
    pairs = mesh.get("periodic_boundary_pairs")
    if isinstance(pairs, list):
        evidence["periodic_pair_ids"] = sorted(
            {
                str(pair.get("pair_id"))
                for pair in pairs
                if isinstance(pair, Mapping) and pair.get("pair_id") is not None
            }
        )

    if (
        magnetic_marker is None
        or not isinstance(nodes, list)
        or not isinstance(cell_types, list)
        or not isinstance(cell_offsets, list)
        or not isinstance(cell_nodes, list)
        or not isinstance(markers, list)
        or len(cell_offsets) != len(cell_types) + 1
        or len(markers) != len(cell_types)
    ):
        return evidence

    magnetic_nodes: set[int] = set()
    for index, kind in enumerate(cell_types):
        if markers[index] != magnetic_marker:
            continue
        start = cell_offsets[index]
        stop = cell_offsets[index + 1]
        if (
            isinstance(start, bool)
            or isinstance(stop, bool)
            or not isinstance(start, int)
            or not isinstance(stop, int)
            or start < 0
            or stop < start
            or stop > len(cell_nodes)
        ):
            return evidence
        evidence["magnetic_cell_count"] += 1
        for node in cell_nodes[start:stop]:
            if isinstance(node, int) and not isinstance(node, bool) and 0 <= node < len(nodes):
                magnetic_nodes.add(node)
    evidence["magnetic_node_count"] = len(magnetic_nodes)
    z_values: list[float] = []
    for node_index in sorted(magnetic_nodes):
        coordinate = nodes[node_index]
        if not isinstance(coordinate, list) or len(coordinate) != 3:
            return evidence
        try:
            z_values.append(float(coordinate[2]))
        except (TypeError, ValueError):
            return evidence
    evidence["resolved_layer_planes"] = _count_coordinate_planes(z_values)
    return evidence


def _assess_benchmark_mesh(
    domain: Mapping[str, Any],
    mesh: Mapping[str, Any],
    benchmark: Mapping[str, Any],
) -> dict[str, Any]:
    """Return an explicit acceptance decision for the requested L1 mesh."""
    operation = _thin_film_operation(domain.get("build_report"))
    evidence = _thin_film_mesh_evidence(domain, mesh, benchmark)
    expected_layers = evidence.get("expected_layers")
    mesh_contract = benchmark.get("mesh")
    requested_pair_ids = (
        mesh_contract.get("periodic_pair_ids", [])
        if isinstance(mesh_contract, Mapping)
        else []
    )
    if not isinstance(requested_pair_ids, list):
        requested_pair_ids = []
    reasons: list[str] = []
    if operation is None:
        reasons.append("build report has no thin_film operation status")
    else:
        if operation.get("status") != "applied":
            reasons.append(
                "thin_film operation was not applied"
                + (
                    f" (status={operation.get('status')!r}, reason={operation.get('reason')!r})"
                    if operation.get("status") is not None
                    else ""
                )
            )
        details = operation.get("details")
        actual_method = operation.get("actual_method")
        if actual_method in {None, "free_tetrahedral"}:
            reasons.append(
                f"thin_film operation resolved to non-swept method {actual_method!r}"
            )
        build_mode = (
            domain.get("build_report", {}).get("build_mode")
            if isinstance(domain.get("build_report"), Mapping)
            else None
        )
        if build_mode not in {"single_geometry_geo_ring", "single_geometry_geo_mixed"}:
            reasons.append(f"build mode {build_mode!r} does not prove a swept shared-GEO mesh")
        if isinstance(details, Mapping):
            requested_layers = details.get("through_thickness_elements")
            if requested_layers is None:
                reasons.append("thin_film operation has no requested layer count")
            elif expected_layers is not None and requested_layers != expected_layers:
                reasons.append(
                    "thin_film operation requested "
                    f"{requested_layers!r} layers; benchmark requires {expected_layers}"
                )
    expected_layers = evidence.get("expected_layers")
    if expected_layers is None:
        reasons.append("benchmark mesh contract has no integer thin_film_layers")
    elif evidence.get("resolved_layer_planes") != expected_layers + 1:
        reasons.append(
            "serialized magnetic topology has "
            f"{evidence.get('resolved_layer_planes')} z planes; expected {expected_layers + 1}"
        )
    if not evidence.get("all_volume_cells_tet4"):
        reasons.append("serialized volume topology is not all linear tet4")
    if not evidence.get("all_boundary_facets_tri3"):
        reasons.append("serialized boundary topology is not all linear tri3")
    actual_pair_ids = set(evidence.get("periodic_pair_ids", []))
    missing_pair_ids = sorted(set(str(pair_id) for pair_id in requested_pair_ids) - actual_pair_ids)
    if missing_pair_ids:
        reasons.append(f"serialized mesh is missing periodic pairs {missing_pair_ids!r}")
    if not isinstance(mesh.get("periodic_node_pairs"), list) or not mesh.get("periodic_node_pairs"):
        reasons.append("serialized mesh has no periodic node correspondence")
    accepted = not reasons
    return {
        "status": "accepted" if accepted else "not_accepted",
        "accepted": accepted,
        "rejection_reasons": reasons,
        "thin_film_operation": dict(operation) if operation is not None else None,
        "evidence": evidence,
    }


def _extract_summary(
    ir: Mapping[str, Any],
    *,
    source_script: Path,
    case: str,
    image_digest: str,
    stage_ids: list[str | None],
    started_at: str,
    finished_at: str,
) -> dict[str, Any]:
    domain, mesh = _domain_asset(ir)
    metadata = _runtime_metadata(ir)
    benchmark = metadata.get("comsol_nonzero_k_dispersion")
    if not isinstance(benchmark, Mapping):
        raise ValueError("ProblemIR is missing comsol_nonzero_k_dispersion metadata")
    geometry = benchmark.get("geometry")
    if not isinstance(geometry, Mapping):
        raise ValueError("benchmark metadata is missing geometry")
    summary = _mesh_summary(mesh)
    benchmark_mesh = _assess_benchmark_mesh(domain, mesh, benchmark)
    summary.update(
        {
            "schema_version": SCHEMA_VERSION,
            "status": "passed",
            "materialization_status": "passed",
            "benchmark_mesh_status": benchmark_mesh["status"],
            "benchmark_mesh_accepted": benchmark_mesh["accepted"],
            "benchmark_mesh_rejection_reasons": benchmark_mesh["rejection_reasons"],
            "benchmark_mesh_evidence": benchmark_mesh["evidence"],
            "case": case,
            "source_script": source_script.as_posix(),
            "source_script_sha256": _sha256(source_script),
            "problem_ir_source_hash": ir.get("problem_meta", {}).get("source_hash"),
            "toolchain_image_digest": image_digest,
            "python": platform.python_version(),
            "numpy": _module_version("numpy"),
            "gmsh": _module_version("gmsh"),
            "stage_count": len(stage_ids),
            "stage_ids": stage_ids,
            "mesh_name": mesh.get("mesh_name"),
            "mesh_source": domain.get("mesh_source"),
            "periodic_mesh_certificate_status": (
                "accepted"
                if isinstance(mesh.get("periodic_mesh_certificate"), Mapping)
                else "not_present"
            ),
            "mixed_layer_topology_certificate_status": (
                "accepted"
                if isinstance(mesh.get("mixed_layer_topology_certificate"), Mapping)
                else "not_present"
            ),
            "region_markers": domain.get("region_markers", []),
            "object_region_markers": domain.get("object_region_markers", []),
            "build_report": domain.get("build_report"),
            "geometry_names": [
                entry.get("name", entry.get("geometry_name"))
                for entry in ir.get("geometry", {}).get("entries", [])
                if isinstance(entry, Mapping)
            ],
            "geometry_contract": dict(geometry),
            "magnetic_volume_m3": geometry.get("magnetic_volume_m3"),
            "energy_terms": ir.get("energy_terms", []),
            "study": ir.get("study"),
            "solver_executed": False,
            "started_at": started_at,
            "finished_at": finished_at,
        }
    )
    return summary


def _module_version(name: str) -> str | None:
    module = sys.modules.get(name)
    if module is None:
        return None
    return str(getattr(module, "__version__", "unknown"))


def materialize(*, output: Path, case: str, image_digest: str) -> dict[str, Any]:
    if not output.is_absolute():
        raise ValueError("--output must be an absolute path")
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"output directory must be new and empty: {output}")
    output.mkdir(parents=True, exist_ok=True)

    repository_root = _ensure_repository_imports()
    script = Path(__file__).resolve().with_name("problem.py")
    if not script.is_file():
        raise FileNotFoundError(script)

    # Keep the route deterministic and bounded.  In particular, no field
    # export selector can turn this mesh-only probe into a solver run.
    os.environ["FULLMAG_COMSOL_DISPERSION_CASE"] = case
    os.environ.pop("FULLMAG_COMSOL_DISPERSION_ALL_FIELDS", None)
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

    import numpy  # noqa: PLC0415
    import gmsh  # noqa: PLC0415

    preflight = {
        "schema_version": SCHEMA_VERSION,
        "status": "passed",
        "case": case,
        "source_script": script.as_posix(),
        "repository_root": repository_root.as_posix(),
        "source_script_sha256": _sha256(script),
        "toolchain_image_digest": image_digest,
        "expected_toolchain_image_digest": EXPECTED_IMAGE_DIGEST,
        "python": platform.python_version(),
        "numpy": str(getattr(numpy, "__version__", "unknown")),
        "gmsh": str(getattr(gmsh, "__version__", "unknown")),
        "source_read_only_contract": True,
        "solver_route": "disabled",
        "checked_at": _utc_now(),
    }
    if image_digest != EXPECTED_IMAGE_DIGEST:
        raise ValueError(
            f"unexpected toolchain image digest {image_digest!r}; "
            f"expected {EXPECTED_IMAGE_DIGEST!r}"
        )
    if str(getattr(gmsh, "__version__", "")) != EXPECTED_GMSH_VERSION:
        raise ValueError(
            f"unexpected gmsh version {getattr(gmsh, '__version__', None)!r}; "
            f"expected {EXPECTED_GMSH_VERSION!r}"
        )
    _write_json(output / "preflight.json", preflight)

    started_at = _utc_now()
    # Import only the public DSL/loader.  There is deliberately no Simulation
    # import or native runner call in this route.
    import fullmag as fm  # noqa: PLC0415

    fm.reset()
    loaded = fm.load_problem_from_script(script, lightweight_assets=False)
    stage_ids = [stage.stage_id for stage in loaded.stages]
    if len(stage_ids) != 2 or stage_ids != ["relax", "eigenmodes-1"]:
        raise ValueError(f"A1 workflow stage contract changed: {stage_ids!r}")

    runtime = loaded.problem.runtime
    ir = loaded.to_ir(
        requested_backend=runtime.backend_target,
        execution_mode=runtime.execution_mode,
        execution_precision=runtime.execution_precision,
        _copy_cached_geometry_assets=False,
    )
    domain, mesh = _domain_asset(ir)
    if str(mesh.get("mesh_name", "")) == "":
        raise ValueError("materialized mesh has no mesh_name")
    if sum(str(kind) == "tet4" for kind in mesh.get("cells", {}).get("types", [])) <= 0:
        raise ValueError("A1 materialization did not produce any tet4 cells")
    if not mesh.get("periodic_boundary_pairs"):
        raise ValueError("A1 materialization did not produce periodic boundary pairs")
    if not mesh.get("periodic_node_pairs"):
        raise ValueError("A1 materialization did not produce periodic node pairs")
    finished_at = _utc_now()

    _write_json(output / "problem_ir.json", ir)
    summary = _extract_summary(
        ir,
        source_script=script,
        case=case,
        image_digest=image_digest,
        stage_ids=stage_ids,
        started_at=started_at,
        finished_at=finished_at,
    )
    _write_json(output / "materialization_summary.json", summary)
    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", choices=("c0", "c1", "a1"), default=DEFAULT_CASE)
    parser.add_argument("--image-digest", default=EXPECTED_IMAGE_DIGEST)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output = args.output.resolve()
    started = _utc_now()
    try:
        summary = materialize(
            output=output,
            case=args.case,
            image_digest=str(args.image_digest),
        )
    except Exception as exc:
        failure = {
            "schema_version": SCHEMA_VERSION,
            "status": "failed",
            "case": args.case,
            "output": output.as_posix(),
            "toolchain_image_digest": str(args.image_digest),
            "started_at": started,
            "finished_at": _utc_now(),
            "solver_executed": False,
            "error_type": type(exc).__name__,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        }
        try:
            output.mkdir(parents=True, exist_ok=True)
            _write_json(output / "run_receipt.json", failure)
        except Exception:
            pass
        raise
    receipt = {
        "schema_version": SCHEMA_VERSION,
        "status": "passed",
        "case": args.case,
        "output": output.as_posix(),
        "toolchain_image_digest": str(args.image_digest),
        "started_at": started,
        "finished_at": summary["finished_at"],
        "solver_executed": False,
        "artifacts": [
            "preflight.json",
            "problem_ir.json",
            "materialization_summary.json",
            "run_receipt.json",
        ],
        "node_count": summary["node_count"],
        "tet4_count": summary["tet4_count"],
        "periodic_boundary_pair_count": summary["periodic_boundary_pair_count"],
        "periodic_node_pair_count": summary["periodic_node_pair_count"],
        "materialization_status": summary["materialization_status"],
        "benchmark_mesh_status": summary["benchmark_mesh_status"],
        "benchmark_mesh_accepted": summary["benchmark_mesh_accepted"],
        "benchmark_mesh_rejection_reasons": summary["benchmark_mesh_rejection_reasons"],
    }
    _write_json(output / "run_receipt.json", receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
