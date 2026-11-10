"""Geometry-only shared-domain FEM mesh build (ADR 0074).

The Control Room builds the solver mesh from the scene geometry, universe and
mesh policies alone. Materials, initial state, interactions and study stages
are physics inputs and are not read here; Compute validates them later.

Input (stdin JSON)::

    {
      "geometries": [GeometryEntryIR, ...],      # geometry name == object_id
      "geometry_object_ids": {name: object_id},
      "declared_universe": {...},                # scene universe policy
      "hmax": float,                             # body maximum element size
      "order": int,
      "mesh_name": str,
      "mesh_options": {...}                      # shared-domain policy + per_geometry
    }

Output (stdout JSON): ``mesh`` in the canonical ``MeshIR`` layout plus the
region markers, quality summaries, statistics and build provenance that the
Rust API publishes into the live mesh workspace.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from typing import Any

from ..model.discretization import FEM
from .asset_pipeline import realize_fem_domain_mesh_asset_from_components_with_report
from .remesh_cli import _geometry_from_ir, _mesh_result_payload

GEOMETRY_MESH_BUILD_SCHEMA = "fullmag.geometry_mesh_build.v1"
GENERATION_MODE = "geometry_only_shared_domain"

# Flat topology keys of ``_mesh_result_payload`` regrouped into ``MeshIR``.
_CELL_KEYS = {
    "cell_types": "types",
    "cell_offsets": "offsets",
    "cell_nodes": "nodes",
    "cell_global_ordinals": "global_ordinals",
    "cell_mesh_parts": "mesh_parts",
}
_FACET_KEYS = {
    "facet_types": "types",
    "facet_roles": "roles",
    "facet_offsets": "offsets",
    "facet_nodes": "nodes",
    "facet_global_ordinals": "global_ordinals",
}


class GeometryMeshBuildError(ValueError):
    """An authored input that cannot be meshed; the message is user-facing."""


def _universe_has_air(universe: Mapping[str, object]) -> bool:
    size = universe.get("size")
    if isinstance(size, (list, tuple)) and len(size) == 3:
        return True
    padding = universe.get("padding")
    return isinstance(padding, (list, tuple)) and any(
        isinstance(value, (int, float)) and value > 0.0 for value in padding
    )


def _validated_payload(payload: Mapping[str, Any]) -> tuple[list[Any], Mapping[str, object], float, int]:
    raw_geometries = payload.get("geometries")
    if not isinstance(raw_geometries, list) or not raw_geometries:
        raise GeometryMeshBuildError("Add at least one object before building the mesh.")
    universe = payload.get("declared_universe")
    if not isinstance(universe, Mapping) or not _universe_has_air(universe):
        raise GeometryMeshBuildError(
            "The FEM mesh needs a surrounding air domain: set the Universe size "
            "(Manual) or a positive Auto padding before building."
        )
    hmax = payload.get("hmax")
    if isinstance(hmax, bool) or not isinstance(hmax, (int, float)) or not hmax > 0.0:
        raise GeometryMeshBuildError(
            "Set the maximum element size (h_max) of the shared-domain mesh policy "
            "before building."
        )
    order = int(payload.get("order") or 1)
    geometries = [_geometry_from_ir(entry) for entry in raw_geometries]
    return geometries, universe, float(hmax), order


def build_geometry_only_mesh(payload: Mapping[str, Any]) -> dict[str, Any]:
    geometries, universe, hmax, order = _validated_payload(payload)
    mesh_name = str(payload.get("mesh_name") or "study_domain")
    raw_options = payload.get("mesh_options")
    mesh_options = dict(raw_options) if isinstance(raw_options, Mapping) else {}
    per_geometry = mesh_options.get("per_geometry")
    raw_object_ids = payload.get("geometry_object_ids")
    mesh_data, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
        geometries,
        FEM(order=order, maximum_element_size=hmax),
        study_universe=universe,
        mesh_workflow={
            "mesh_options": mesh_options,
            "per_geometry": per_geometry if isinstance(per_geometry, list) else [],
        },
        geometry_object_ids=dict(raw_object_ids) if isinstance(raw_object_ids, Mapping) else None,
    )
    report_payload = report.to_dict()
    result = _mesh_result_payload(
        mesh_data,
        mesh_name=mesh_name,
        generation_mode=GENERATION_MODE,
        mesh_provenance={
            "geometry_kind": "shared_domain",
            "order": order,
            "hmax": hmax,
            "mesh_options": mesh_options,
            "shared_domain_build_mode": report.build_mode,
            "fallbacks_triggered": report_payload["fallbacks_triggered"],
            "effective_airbox_target": report_payload["effective_airbox_target"],
            "effective_per_object_targets": report_payload["effective_per_object_targets"],
            "used_size_field_kinds": report_payload["used_size_field_kinds"],
            "operation_statuses": report_payload["operation_statuses"],
            "shared_domain_build_report": report_payload,
        },
        region_markers=region_markers,
        object_region_markers=report.object_region_markers,
        # The API reads one stdout document; a separate topology file would
        # need its own ownership and cleanup contract.
        inline_topology_max_bytes=sys.maxsize,
    )
    mesh: dict[str, Any] = {
        "mesh_name": result.pop("mesh_name"),
        "nodes": result.pop("nodes"),
        "cells": {target: result.pop(source) for source, target in _CELL_KEYS.items()},
        "element_markers": result.pop("element_markers"),
        "facets": {target: result.pop(source) for source, target in _FACET_KEYS.items()},
        "boundary_markers": result.pop("boundary_markers"),
    }
    for key in ("periodic_boundary_pairs", "periodic_node_pairs"):
        pairs = result.pop(key)
        if pairs:
            mesh[key] = pairs
    return {"schema": GEOMETRY_MESH_BUILD_SCHEMA, "mesh": mesh, **result}


def _ordinary_shared_workflow(workflow: Mapping[str, Any]) -> bool:
    if workflow.get("domain_mesh_mode") not in (None, "generated_shared_domain_mesh"):
        return False
    if workflow.get("operations") or workflow.get("domain_mesh_source"):
        return False
    return all(
        isinstance(entry, Mapping)
        and entry.get("mode") == "inherit"
        and set(entry) <= {"geometry", "geometry_name", "object_id", "mode"}
        for entry in workflow.get("per_geometry", ())
    )


def _geometry_shapes(entries, owner_ids):
    """Compare geometry by stable owner and physical parameters."""
    def shape(entry):
        kind = entry["kind"]
        if kind not in {"box", "cylinder", "ellipsoid", "sphere", "sin_waveguide", "arch_waveguide", "translate"}:
            raise ValueError("geometry requires its native materialization")
        result = {key: value for key, value in entry.items() if key != "name"}
        if kind == "translate":
            result["base"] = shape(result["base"])
        return result

    return [(owner_ids[entry["name"]], shape(entry)) for entry in entries]


def matches_solver_geometry_reuse(payload: Mapping[str, Any], recipes: list[dict]) -> bool:
    """Qualify a geometry-only publication against the actual solver recipes.

    Nontrivial object recipes, conformal regions, imported sources, and mixed
    topology go through their canonical geometry preparation.
    """
    from ._gmsh_swept import _disconnected_mixed_p1_pair
    from .asset_pipeline import (
        _mesh_options_from_runtime_metadata,
        _resolve_requested_partition_hmaxs,
        _shared_domain_size_field_default_hmax,
        _study_universe_airbox_options,
        _validate_domain_mesh_workflow,
    )

    try:
        geometries, universe, hmax, order = _validated_payload(payload)
        build_shapes = _geometry_shapes(payload["geometries"], payload["geometry_object_ids"])
        if order != 1 or not recipes or _disconnected_mixed_p1_pair(geometries) is not None:
            return False
        build_options = payload["mesh_options"]
        build_workflow = {
            "mesh_options": build_options,
            "per_geometry": build_options.get("per_geometry", ()),
        }
        if build_options.get("adaptive_enabled") or not _ordinary_shared_workflow(build_workflow):
            return False
        hints = FEM(order=order, maximum_element_size=hmax)
        build_airbox = _study_universe_airbox_options(geometries, universe)
        if build_airbox is None:
            return False

        def options(workflow):
            return (
                _mesh_options_from_runtime_metadata(
                    workflow, geometries=geometries, default_hmax=hmax,
                    include_size_fields=False,
                ),
                _mesh_options_from_runtime_metadata(
                    workflow, geometries=geometries,
                    default_hmax=_shared_domain_size_field_default_hmax(hints, build_airbox),
                    component_aware=True,
                ),
                _resolve_requested_partition_hmaxs(
                    geometries, hints, airbox=build_airbox,
                    mesh_workflow=workflow, per_object_recipes=None,
                ),
            )

        build_resolved = options(build_workflow)
        if build_resolved[0].mesh_strategy not in (None, "auto", "free_tetrahedral"):
            return False
        for recipe in recipes:
            workflow = recipe["mesh_workflow"]
            if not isinstance(workflow, Mapping) or not _ordinary_shared_workflow(workflow):
                return False
            if _validate_domain_mesh_workflow(workflow) is not None:
                return False
            if recipe["order"] != order or recipe["hmax"] != hmax or recipe["mesh"] is not None:
                return False
            if _geometry_shapes(recipe["geometries"], recipe["geometry_object_ids"]) != build_shapes:
                return False
            if _study_universe_airbox_options(geometries, recipe["study_universe"]) != build_airbox:
                return False
            if options(workflow) != build_resolved:
                return False
        return True
    except (KeyError, TypeError, ValueError):
        return False


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
        # C mesh libraries print banners to fd 1; keep stdout for the JSON.
        real_stdout_fd = os.dup(1)
        devnull_fd = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull_fd, 1)
        os.close(devnull_fd)
        try:
            result = build_geometry_only_mesh(payload)
        finally:
            sys.stdout.flush()
            os.dup2(real_stdout_fd, 1)
            os.close(real_stdout_fd)
        json.dump(result, sys.stdout, separators=(",", ":"))
        sys.stdout.flush()
    except GeometryMeshBuildError as exc:
        print(json.dumps({"error": str(exc), "user_facing": True}), file=sys.stderr)
        sys.exit(2)
    except Exception as exc:  # noqa: BLE001 - reported to the API caller
        import traceback

        print(json.dumps({"error": str(exc), "traceback": traceback.format_exc()}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
