#!/usr/bin/env python3
"""Run a closed, interpreted owner/air-interface meshing experiment.

The driver exercises only the authored ``owner_target_ring`` case used by the
production precedence regression.  It runs the checked-out mesher in two
reference configurations and two source-backed in-memory variants:

* ``reference_current_wip_30`` runs the unchanged current mesher with the
  30 nm authored air target;
* ``baseline_current_wip`` runs the unchanged current mesher with the 50 nm
  authored air target;
* ``fixed_levels`` keeps the 50 nm downstream fields but derives z levels from
  the 30 nm schedule;
* ``fixed_fields`` keeps the 50 nm z-level schedule but uses 30 nm for the
  air field, owner ``VOut`` and global air ceiling.
* ``air_field_only_30`` changes only the scoped air grading-field outer size
  to 30 nm; the z-level schedule and downstream owner/global fields stay at
  the authored 50 nm value.
* ``owner_ceiling_only_30`` changes only the scoped owner ``VOut`` ceiling
  and global air ceiling to 30 nm; the z-level schedule and air grading field
  stay at the authored 50 nm value.
* ``staged_magnetic_first_30`` and ``staged_magnetic_first_50`` run an
  in-memory two-phase candidate: magnetic volumes are meshed and converted
  before the air field is installed, then the remaining air volumes are
  meshed with ``MeshOnlyEmpty``.
* ``body_first_cad_30`` and ``body_first_cad_50`` run source-pinned in-memory
  candidates that construct magnetic CAD intervals first, then upper air,
  then lower air, while retaining the authored 30 nm or 50 nm air target.
* ``repeat_reference_current_wip_30`` and ``repeat_baseline_current_wip``
  repeat the unchanged 30 nm and 50 nm baselines to measure reproducibility.
* ``clone_reference_current_wip_30`` and ``clone_baseline_current_wip`` execute
  the already-pinned, unchanged in-memory baseline clones.

This is an interpreted Gmsh observation only.  It does not modify production
sources, does not install dependencies, and does not qualify the mesher or
the physics contract.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import traceback
import uuid

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import fullmag_storage as storage
import verify_exact_layer_mesh_diagnostics as exact_diagnostics


DIAGNOSTIC_PROFILE = "windows-exact-layer-mesh-diagnostics"
NATIVE_PROFILE = "windows-native-fdm-cpu-dev"
RECEIPT_SCHEMA = "fullmag.owner_air_interface_isolation.v1"
CHILD_SCHEMA = "fullmag.owner_air_interface_isolation.child.v1"
SUITE_NAME = "owner-target-ring"
VARIANT_NAMES = (
    "reference_current_wip_30",
    "baseline_current_wip",
    "fixed_levels",
    "fixed_fields",
    "clone_reference_current_wip_30",
    "clone_baseline_current_wip",
    "repeat_reference_current_wip_30",
    "repeat_baseline_current_wip",
    "air_field_only_30",
    "owner_ceiling_only_30",
    "staged_magnetic_first_30",
    "staged_magnetic_first_50",
    "body_first_cad_30",
    "body_first_cad_50",
)
PREPARED_VARIANT_NAMES = (
    "reference_current_wip_30",
    "baseline_current_wip",
    "fixed_levels",
    "fixed_fields",
    "air_field_only_30",
    "owner_ceiling_only_30",
    "staged_magnetic_first_30",
    "staged_magnetic_first_50",
    "body_first_cad_30",
    "body_first_cad_50",
)
STAGED_VARIANT_NAMES = {
    "staged_magnetic_first_30",
    "staged_magnetic_first_50",
}
BODY_FIRST_CAD_VARIANT_NAMES = {
    "body_first_cad_30",
    "body_first_cad_50",
}
CHILD_TIMEOUT_SECONDS = 15 * 60
MESHER_FUNCTION = "_generate_coincident_ring_airbox_mesh"
MESHER_MODULE = "fullmag.meshing._gmsh_swept"
EXPERIMENT_SOURCE_BASE = "f53dc54f8d82d2e982f25461df0a4eea18aaf81d"
EXPERIMENT_SCOPE = {
    "geometry": "owner_target_ring",
    "layers": 3,
    "hint_hmax_m": 10e-9,
    "owner_hmax_m": 20e-9,
    "airbox_hmax_m": 50e-9,
    "reference_airbox_hmax_m": 30e-9,
    "candidate_airbox_hmax_m": 50e-9,
    "domain_m": [40e-9, 40e-9, 410e-9],
    "ring_hole_grouped_in_magnetic_intervals": True,
    "exterior_air_intervals_geometry_only": True,
}

_LEVEL_ANCHOR = "h_outer=h_outer,"
_LEVEL_REPLACEMENT = "h_outer=30.0e-9,"
_FIELD_OUTER_ANCHORS = (
    "h_outer=h_outer_scaled,",
    "max(body_hmax_scaled, h_outer_scaled),",
    "airbox_maximum_element_size=h_outer_scaled,",
)
_FIELD_OUTER_REPLACEMENTS = (
    "h_outer=fixed_field_h_outer_scaled,",
    "max(body_hmax_scaled, fixed_field_h_outer_scaled),",
    "airbox_maximum_element_size=fixed_field_h_outer_scaled,",
)
_FIELD_OUTER_INSERTION = (
    "    h_outer_scaled = h_outer * SCALE\n"
    "    fixed_field_h_outer_scaled = 30.0e-9 * SCALE\n"
)
_AIR_FIELD_ONLY_INSERTION = (
    "    h_outer_scaled = h_outer * SCALE\n"
    "    air_field_only_outer_scaled = 30.0e-9 * SCALE\n"
)
_AIR_FIELD_ONLY_REPLACEMENT = "h_outer=air_field_only_outer_scaled,"
_OWNER_CEILING_ONLY_INSERTION = (
    "    h_outer_scaled = h_outer * SCALE\n"
    "    owner_ceiling_only_outer_scaled = 30.0e-9 * SCALE\n"
)
_OWNER_CEILING_ONLY_REPLACEMENT = "owner_ceiling_only_outer_scaled"
_STAGED_SOURCE_ANCHORS = (
    "_add_airbox_grading_field(",
    "_apply_mesh_options(",
    "gmsh.model.mesh.generate(3)",
    "subdivide_layered_prisms(gmsh)",
)
_BODY_FIRST_CAD_Z_SOURCE_ANCHOR = "        z_source = levels[0]\n"
_BODY_FIRST_CAD_LOOP_START = "        annulus_volumes: list[int] = []\n"
_BODY_FIRST_CAD_LOOP_END = (
    "            current_hole = next_hole[0] if next_hole else None\n"
)
_BODY_FIRST_CAD_SOURCE_AST_ANCHORS = {
    "source_z_from_lower_cap": {"base": 1, "candidate": 0},
    "source_z_from_magnetic_bottom": {"base": 0, "candidate": 1},
    "original_interval_loop_start": {"base": 1, "candidate": 0},
    "body_first_interval_order": {"base": 0, "candidate": 1},
    "negative_lower_air_step": {"base": 0, "candidate": 1},
    "directional_target_z": {"base": 0, "candidate": 1},
    "magnetic_prism_guard": {"base": 1, "candidate": 1},
}
_BODY_FIRST_CAD_TRACKED_CALLS = {
    "_add_airbox_grading_field",
    "_apply_mesh_options",
    "_apply_mixed_source_face_mesh_options",
    "_box_airbox_layer_levels",
    "_resolve_box_airbox_layer_sizes",
    "subdivide_layered_prisms",
}


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    return exact_diagnostics._sha256_file(path)


def _source_fingerprints(repo: Path) -> dict[str, str]:
    package_root = repo / "packages/fullmag-py/src/fullmag"
    return {
        "python_package": exact_diagnostics._tree_digest(package_root, repo=repo),
        "test_meshing": _sha256_file(repo / "packages/fullmag-py/tests/test_meshing.py"),
        "meshing_production_fixtures": _sha256_file(
            repo / "packages/fullmag-py/tests/meshing_production_fixtures.py"
        ),
        "gmsh_swept": _sha256_file(
            repo / "packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py"
        ),
        "gmsh_layered_tetrahedra": _sha256_file(
            repo / "packages/fullmag-py/src/fullmag/meshing/_gmsh_layered_tetrahedra.py"
        ),
        "diagnostic_driver": _sha256_file(Path(__file__).resolve()),
    }


def _source_origins(repo: Path) -> dict[str, str]:
    return {
        "python_package": str((repo / "packages/fullmag-py/src/fullmag").resolve()),
        "test_meshing": str((repo / "packages/fullmag-py/tests/test_meshing.py").resolve()),
        "meshing_production_fixtures": str(
            (repo / "packages/fullmag-py/tests/meshing_production_fixtures.py").resolve()
        ),
        "gmsh_swept": str(
            (repo / "packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py").resolve()
        ),
        "gmsh_layered_tetrahedra": str(
            (repo / "packages/fullmag-py/src/fullmag/meshing/_gmsh_layered_tetrahedra.py").resolve()
        ),
        "diagnostic_driver": str(Path(__file__).resolve()),
    }


def _mesher_function_source(repo: Path) -> str:
    path = repo / "packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py"
    module_source = path.read_text(encoding="utf-8")
    tree = ast.parse(module_source, filename=str(path))
    definitions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == MESHER_FUNCTION
    ]
    if len(definitions) != 1:
        raise storage.StorageError("Checked-out mesher source does not define one target function")
    function_source = ast.get_source_segment(module_source, definitions[0])
    if not isinstance(function_source, str):
        raise storage.StorageError("Checked-out mesher source could not be extracted")
    return textwrap.dedent(function_source).rstrip()


def _write_variant_source(run_root: Path, variant: str, source: str) -> tuple[Path, str]:
    variants_root = storage.validate_path(
        run_root / "variants", run_root, "owner/air variant source root"
    )
    if variants_root.exists() and storage.is_link(variants_root):
        raise storage.StorageError("Variant source root is a link")
    variants_root.mkdir(parents=True, exist_ok=True)
    candidate = storage.validate_path(
        variants_root / f"{variant}.py", variants_root, "owner/air variant source"
    )
    if candidate.exists() or storage.is_link(candidate):
        raise storage.StorageError(f"Variant source already exists: {candidate}")
    payload = source.encode("utf-8")
    candidate.write_bytes(payload)
    return candidate, _sha256_bytes(payload)


def _validate_function_tree(source: str, candidate: Path) -> object:
    tree = ast.parse(source, filename=str(candidate))
    definitions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if len(definitions) != 1 or definitions[0].name != MESHER_FUNCTION:
        raise storage.StorageError("Variant must contain exactly one target function")
    compile(tree, str(candidate), "exec")
    return tree


def _staged_source_anchor_counts(source: str) -> dict[str, int]:
    counts = {anchor: source.count(anchor) for anchor in _STAGED_SOURCE_ANCHORS}
    if any(count != 1 for count in counts.values()):
        raise storage.StorageError(
            "Staged candidate source anchors are not exactly one each: "
            f"{counts!r}"
        )
    return counts


def _body_first_cad_call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _body_first_cad_call_name(node.value)
        return f"{parent}.{node.attr}" if parent else None
    return None


def _body_first_cad_ast_budget(source: str, candidate: str) -> dict[str, object]:
    def tracked_counts(function_source: str) -> dict[str, int]:
        tree = ast.parse(function_source)
        counts: dict[str, int] = {}
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _body_first_cad_call_name(node.func)
            if name is None:
                continue
            if name.startswith("gmsh.model.") or name in _BODY_FIRST_CAD_TRACKED_CALLS:
                counts[name] = counts.get(name, 0) + 1
        return dict(sorted(counts.items()))

    source_counts = tracked_counts(source)
    candidate_counts = tracked_counts(candidate)
    if source_counts != candidate_counts:
        raise storage.StorageError(
            "Body-first CAD candidate changed the Gmsh/meshing AST call budget: "
            f"source={source_counts!r}, candidate={candidate_counts!r}"
        )
    return {
        "source_call_counts": source_counts,
        "candidate_call_counts": candidate_counts,
        "preserved": True,
    }


def _body_first_cad_source(source: str) -> tuple[str, dict[str, object]]:
    if source.count(_BODY_FIRST_CAD_Z_SOURCE_ANCHOR) != 1:
        raise storage.StorageError("Body-first CAD source-z anchor is not unique")
    if source.count(_BODY_FIRST_CAD_LOOP_START) != 1 or source.count(
        _BODY_FIRST_CAD_LOOP_END
    ) != 1:
        raise storage.StorageError("Body-first CAD interval-loop anchors are not unique")
    loop_start = source.index(_BODY_FIRST_CAD_LOOP_START)
    loop_end = source.index(_BODY_FIRST_CAD_LOOP_END, loop_start) + len(
        _BODY_FIRST_CAD_LOOP_END
    )
    original_loop = source[loop_start:loop_end]
    replacement_loop = textwrap.indent(
        textwrap.dedent(
            """\
            annulus_volumes_by_interval: dict[int, int] = {}
            hole_volumes_by_interval: dict[int, int] = {}
            current_annulus = int(annulus_surface)
            current_hole = int(hole_surface) if hole_surface is not None else None
            interval_midpoints = [
                0.5 * (levels[level_index] + levels[level_index + 1])
                for level_index in range(len(levels) - 1)
            ]
            magnetic_indices = [
                level_index
                for level_index, midpoint in enumerate(interval_midpoints)
                if body_bottom < midpoint < body_top
            ]
            above_indices = [
                level_index
                for level_index, midpoint in enumerate(interval_midpoints)
                if midpoint >= body_top
            ]
            below_indices = [
                level_index
                for level_index, midpoint in enumerate(interval_midpoints)
                if midpoint <= body_bottom
            ]
            if len(magnetic_indices) + len(above_indices) + len(below_indices) != len(
                interval_midpoints
            ):
                raise RuntimeError("coincident ring intervals do not partition the airbox")
            ordered_indices = [*magnetic_indices, *above_indices, *reversed(below_indices)]
            below_started = False
            for level_index in ordered_indices:
                is_below = level_index in below_indices
                if is_below and not below_started:
                    current_annulus = int(annulus_surface)
                    current_hole = int(hole_surface) if hole_surface is not None else None
                    below_started = True
                interval_step = float(levels[level_index + 1] - levels[level_index])
                step = -interval_step if is_below else interval_step
                target_z = float(
                    levels[level_index] if is_below else levels[level_index + 1]
                )
                source_entities = [(2, current_annulus)] + (
                    [(2, current_hole)] if current_hole is not None else []
                )
                # Keep every requested z interval as a separate CAD volume. The
                # unscoped compatibility route still extrudes its premeshed
                # source triangulation. Scoped air slabs remain geometry-only so
                # the final conforming 3D mesh resolves magnetic-owner and air
                # sizing independently. Magnetic intervals use one recombined
                # prism layer; the existing coordinate-based converter then gives
                # periodic copies the same deterministic tetrahedral split.
                if scoped_layer_partitioning:
                    if body_bottom < 0.5 * (levels[level_index] + levels[level_index + 1]) < body_top:
                        extruded = gmsh.model.geo.extrude(
                            source_entities,
                            0.0,
                            0.0,
                            step,
                            numElements=[1],
                            heights=[1.0],
                            recombine=True,
                        )
                    else:
                        extruded = gmsh.model.geo.extrude(
                            source_entities,
                            0.0,
                            0.0,
                            step,
                        )
                else:
                    extruded = gmsh.model.geo.extrude(
                        source_entities,
                        0.0,
                        0.0,
                        step,
                        numElements=[1],
                        heights=[1.0],
                        recombine=True,
                    )
                gmsh.model.geo.synchronize()
                volumes = [int(tag) for dim, tag in extruded if int(dim) == 3]
                if len(volumes) != (2 if tool is not None else 1):
                    raise RuntimeError("coincident ring extrusion must produce annulus and hole volumes")
                annulus_step: list[int] = []
                hole_step: list[int] = []
                for volume in volumes:
                    box = gmsh.model.getBoundingBox(3, volume)
                    x_span = float(box[3] - box[0])
                    if math.isclose(x_span, sx * SCALE, rel_tol=1.0e-7, abs_tol=1.0e-9):
                        annulus_step.append(volume)
                    else:
                        hole_step.append(volume)
                if len(annulus_step) != 1 or len(hole_step) != (1 if tool is not None else 0):
                    raise RuntimeError("coincident ring extrusion volume identity is ambiguous")
                annulus_volumes_by_interval[level_index] = annulus_step[0]
                if hole_step:
                    hole_volumes_by_interval[level_index] = hole_step[0]
                top_surfaces = []
                for dim, tag in extruded:
                    if int(dim) != 2:
                        continue
                    box = gmsh.model.getBoundingBox(2, int(tag))
                    if abs(float(box[2]) - target_z) <= 1.0e-8 and abs(float(box[5]) - target_z) <= 1.0e-8:
                        top_surfaces.append((int(tag), float(box[3] - box[0])))
                next_annulus = [tag for tag, x_span in top_surfaces if math.isclose(x_span, sx * SCALE, rel_tol=1.0e-7, abs_tol=1.0e-9)]
                next_hole = [tag for tag, x_span in top_surfaces if not math.isclose(x_span, sx * SCALE, rel_tol=1.0e-7, abs_tol=1.0e-9)]
                if len(next_annulus) != 1 or len(next_hole) != (1 if tool is not None else 0):
                    raise RuntimeError("coincident ring extrusion top-face identity is ambiguous")
                current_annulus = next_annulus[0]
                current_hole = next_hole[0] if next_hole else None

            expected_interval_indices = set(range(len(levels) - 1))
            if set(annulus_volumes_by_interval) != expected_interval_indices:
                raise RuntimeError("coincident ring realization lost an annulus interval volume")
            if tool is not None and set(hole_volumes_by_interval) != expected_interval_indices:
                raise RuntimeError("coincident ring realization lost a hole interval volume")
            annulus_volumes = [
                annulus_volumes_by_interval[index]
                for index in range(len(levels) - 1)
            ]
            hole_volumes = [
                hole_volumes_by_interval[index]
                for index in sorted(hole_volumes_by_interval)
            ]
            """
        ),
        "        ",
    )
    patched_source = source.replace(
        _BODY_FIRST_CAD_Z_SOURCE_ANCHOR,
        "        z_source = body_bottom\n",
        1,
    ).replace(original_loop, replacement_loop, 1)
    canonical_base = source.replace(
        _BODY_FIRST_CAD_Z_SOURCE_ANCHOR,
        "<source-z-anchor>\n",
        1,
    ).replace(original_loop, "<interval-loop-anchor>\n", 1)
    canonical_candidate = patched_source.replace(
        "        z_source = body_bottom\n",
        "<source-z-anchor>\n",
        1,
    ).replace(replacement_loop, "<interval-loop-anchor>\n", 1)
    if canonical_base != canonical_candidate:
        raise storage.StorageError("Body-first CAD candidate changed source outside its anchors")

    expected_anchor_text = {
        "source_z_from_lower_cap": (
            _BODY_FIRST_CAD_Z_SOURCE_ANCHOR.strip(), "<removed-lower-cap-source>"
        ),
        "source_z_from_magnetic_bottom": (
            "<absent-magnetic-bottom-source>", "z_source = body_bottom"
        ),
        "original_interval_loop_start": (
            _BODY_FIRST_CAD_LOOP_START.strip(), "<removed-original-interval-loop>"
        ),
        "body_first_interval_order": (
            "<absent-body-first-interval-order>",
            "ordered_indices = [*magnetic_indices, *above_indices, *reversed(below_indices)]",
        ),
        "negative_lower_air_step": (
            "<absent-negative-lower-air-step>",
            "step = -interval_step if is_below else interval_step",
        ),
        "directional_target_z": (
            "<absent-directional-target-z>",
            "levels[level_index] if is_below else levels[level_index + 1]",
        ),
        "magnetic_prism_guard": (
            "if body_bottom < 0.5 * (levels[level_index] + levels[level_index + 1]) < body_top:",
            "if body_bottom < 0.5 * (levels[level_index] + levels[level_index + 1]) < body_top:",
        ),
    }
    anchor_report = {
        name: {
            "base": source.count(base_anchor) if not base_anchor.startswith("<absent-") else 0,
            "candidate": patched_source.count(candidate_anchor)
            if not candidate_anchor.startswith("<removed-")
            else 0,
        }
        for name, (base_anchor, candidate_anchor) in expected_anchor_text.items()
    }
    if anchor_report != _BODY_FIRST_CAD_SOURCE_AST_ANCHORS:
        raise storage.StorageError(
            f"Body-first CAD source anchor budget drifted: {anchor_report!r}"
        )
    return patched_source, {
        "source_ast_anchors": anchor_report,
        "body_first_cad_ast_budget": _body_first_cad_ast_budget(
            source, patched_source
        ),
    }


def _prepare_variant(
    original: object,
    mesher_module: object,
    *,
    variant: str,
    run_root: Path,
) -> tuple[object, dict[str, object]]:
    base_source = inspect.getsource(original)
    source = textwrap.dedent(base_source).rstrip()
    body_first_cad_metadata: dict[str, object] | None = None
    if variant in {
        "reference_current_wip_30",
        "baseline_current_wip",
        *STAGED_VARIANT_NAMES,
    }:
        patched_source = source
        contract = (
            "staged_magnetic_first_two_phase_wrapper_source_unchanged"
            if variant in STAGED_VARIANT_NAMES
            else "checked_out_current_wip_unchanged"
        )
        if any(source.count(anchor) != 1 for anchor in _FIELD_OUTER_ANCHORS):
            raise storage.StorageError("Baseline downstream field anchors are not unique")
        if source.count(_LEVEL_ANCHOR) != 1:
            raise storage.StorageError("Baseline level anchor is not unique")
    elif variant == "fixed_levels":
        if source.count(_LEVEL_ANCHOR) != 1:
            raise storage.StorageError("Fixed-level schedule anchor is not unique")
        patched_source = source.replace(_LEVEL_ANCHOR, _LEVEL_REPLACEMENT, 1)
        contract = "levels_from_30nm_schedule_downstream_fields_50nm"
    elif variant == "fixed_fields":
        if source.count("    h_outer_scaled = h_outer * SCALE\n") != 1:
            raise storage.StorageError("Fixed-field insertion anchor is not unique")
        patched_source = source.replace(
            "    h_outer_scaled = h_outer * SCALE\n",
            _FIELD_OUTER_INSERTION,
            1,
        )
        for anchor, replacement in zip(_FIELD_OUTER_ANCHORS, _FIELD_OUTER_REPLACEMENTS):
            if patched_source.count(anchor) != 1:
                raise storage.StorageError(f"Fixed-field anchor is not unique: {anchor}")
            patched_source = patched_source.replace(anchor, replacement, 1)
        contract = "levels_from_50nm_schedule_downstream_fields_30nm"
    elif variant == "air_field_only_30":
        if source.count("    h_outer_scaled = h_outer * SCALE\n") != 1:
            raise storage.StorageError("Air-field-only insertion anchor is not unique")
        if source.count(_FIELD_OUTER_ANCHORS[0]) != 1:
            raise storage.StorageError("Air-field-only grading anchor is not unique")
        patched_source = source.replace(
            "    h_outer_scaled = h_outer * SCALE\n",
            _AIR_FIELD_ONLY_INSERTION,
            1,
        ).replace(_FIELD_OUTER_ANCHORS[0], _AIR_FIELD_ONLY_REPLACEMENT, 1)
        contract = "levels_50nm_air_field_30nm_owner_and_global_50nm"
    elif variant == "owner_ceiling_only_30":
        if source.count("    h_outer_scaled = h_outer * SCALE\n") != 1:
            raise storage.StorageError("Owner-ceiling-only insertion anchor is not unique")
        if any(source.count(anchor) != 1 for anchor in _FIELD_OUTER_ANCHORS[1:]):
            raise storage.StorageError("Owner-ceiling-only downstream anchors are not unique")
        patched_source = source.replace(
            "    h_outer_scaled = h_outer * SCALE\n",
            _OWNER_CEILING_ONLY_INSERTION,
            1,
        )
        for anchor in _FIELD_OUTER_ANCHORS[1:]:
            patched_source = patched_source.replace(
                anchor,
                anchor.replace("h_outer_scaled", _OWNER_CEILING_ONLY_REPLACEMENT),
                1,
            )
        contract = "levels_50nm_air_field_50nm_owner_and_global_30nm"
    elif variant in BODY_FIRST_CAD_VARIANT_NAMES:
        patched_source, body_first_cad_metadata = _body_first_cad_source(source)
        authored_airbox = "30nm" if variant == "body_first_cad_30" else "50nm"
        contract = f"body_first_cad_interval_order_authored_{authored_airbox}"
    else:
        raise storage.StorageError(f"Unsupported owner/air variant: {variant}")

    candidate, candidate_sha = _write_variant_source(run_root, variant, patched_source)
    tree = _validate_function_tree(patched_source, candidate)
    definitions = [node for node in tree.body if getattr(node, "name", None) == MESHER_FUNCTION]
    if len(definitions) != 1:
        raise storage.StorageError("Variant target definition count changed")
    namespace: dict[str, object] = {}
    exec(compile(tree, str(candidate), "exec"), mesher_module.__dict__, namespace)
    patched = namespace.get(MESHER_FUNCTION)
    if not callable(patched):
        raise storage.StorageError("Variant did not define a callable target")
    if inspect.signature(original) != inspect.signature(patched):
        raise storage.StorageError("Variant changed the target signature")

    if variant == "fixed_levels":
        if patched_source.count(_LEVEL_REPLACEMENT) != 1:
            raise storage.StorageError("Fixed-level replacement count is not one")
        if patched_source.count("h_outer_scaled") != source.count("h_outer_scaled"):
            raise storage.StorageError("Fixed-level variant changed downstream field source")
        if (
            source.replace(_LEVEL_ANCHOR, "<level-anchor>", 1)
            != patched_source.replace(_LEVEL_REPLACEMENT, "<level-anchor>", 1)
        ):
            raise storage.StorageError("Fixed-level variant changed source outside its anchor")
        level_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_box_airbox_layer_levels"
        ]
        if len(level_calls) != 1:
            raise storage.StorageError("Fixed-level variant changed the level-call budget")
        level_keywords = [item for item in level_calls[0].keywords if item.arg == "h_outer"]
        if len(level_keywords) != 1 or not isinstance(level_keywords[0].value, ast.Constant):
            raise storage.StorageError("Fixed-level variant does not use a literal schedule target")
        if float(level_keywords[0].value.value) != 30.0e-9:
            raise storage.StorageError("Fixed-level variant schedule target drifted")
    elif variant == "fixed_fields":
        if patched_source.count("fixed_field_h_outer_scaled") != 4:
            raise storage.StorageError("Fixed-field target count is not three uses plus definition")
        if patched_source.count(_LEVEL_ANCHOR) != 1:
            raise storage.StorageError("Fixed-field variant changed the level schedule")
        base_canonical = source.replace(
            "    h_outer_scaled = h_outer * SCALE\n", "<field-insertion>\n", 1
        )
        variant_canonical = patched_source.replace(
            _FIELD_OUTER_INSERTION, "<field-insertion>\n", 1
        )
        for anchor, replacement in zip(_FIELD_OUTER_ANCHORS, _FIELD_OUTER_REPLACEMENTS):
            base_canonical = base_canonical.replace(anchor, "<field-anchor>", 1)
            variant_canonical = variant_canonical.replace(replacement, "<field-anchor>", 1)
        if base_canonical != variant_canonical:
            raise storage.StorageError("Fixed-field variant changed source outside its anchors")
        level_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_box_airbox_layer_levels"
        ]
        if len(level_calls) != 1:
            raise storage.StorageError("Fixed-field variant changed the level-call budget")
        level_keywords = [item for item in level_calls[0].keywords if item.arg == "h_outer"]
        if len(level_keywords) != 1 or not isinstance(level_keywords[0].value, ast.Name):
            raise storage.StorageError("Fixed-field variant changed the level input")
        if level_keywords[0].value.id != "h_outer":
            raise storage.StorageError("Fixed-field variant level input is not the 50 nm source")
    elif variant == "air_field_only_30":
        if patched_source.count("air_field_only_outer_scaled") != 2:
            raise storage.StorageError("Air-field-only target count is not one definition plus one use")
        if patched_source.count(_LEVEL_ANCHOR) != 1:
            raise storage.StorageError("Air-field-only variant changed the level schedule")
        if any(patched_source.count(anchor) != 1 for anchor in _FIELD_OUTER_ANCHORS[1:]):
            raise storage.StorageError("Air-field-only variant changed owner/global field anchors")
        base_canonical = source.replace(
            "    h_outer_scaled = h_outer * SCALE\n", "<field-insertion>\n", 1
        ).replace(_FIELD_OUTER_ANCHORS[0], "<air-field-anchor>", 1)
        variant_canonical = patched_source.replace(
            _AIR_FIELD_ONLY_INSERTION, "<field-insertion>\n", 1
        ).replace(_AIR_FIELD_ONLY_REPLACEMENT, "<air-field-anchor>", 1)
        if base_canonical != variant_canonical:
            raise storage.StorageError("Air-field-only variant changed source outside its anchor")
        level_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_box_airbox_layer_levels"
        ]
        if len(level_calls) != 1:
            raise storage.StorageError("Air-field-only variant changed the level-call budget")
        level_keywords = [item for item in level_calls[0].keywords if item.arg == "h_outer"]
        if (
            len(level_keywords) != 1
            or not isinstance(level_keywords[0].value, ast.Name)
            or level_keywords[0].value.id != "h_outer"
        ):
            raise storage.StorageError("Air-field-only variant changed the 50 nm level input")
        grading_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_add_airbox_grading_field"
        ]
        if len(grading_calls) != 1:
            raise storage.StorageError("Air-field-only variant changed the grading-call budget")
        grading_keywords = [item for item in grading_calls[0].keywords if item.arg == "h_outer"]
        if (
            len(grading_keywords) != 1
            or not isinstance(grading_keywords[0].value, ast.Name)
            or grading_keywords[0].value.id != "air_field_only_outer_scaled"
        ):
            raise storage.StorageError("Air-field-only variant did not isolate the grading field")
    elif variant == "owner_ceiling_only_30":
        if patched_source.count("owner_ceiling_only_outer_scaled") != 3:
            raise storage.StorageError("Owner-ceiling-only target count is not one definition plus two uses")
        if patched_source.count(_LEVEL_ANCHOR) != 1:
            raise storage.StorageError("Owner-ceiling-only variant changed the level schedule")
        if patched_source.count(_FIELD_OUTER_ANCHORS[0]) != 1:
            raise storage.StorageError("Owner-ceiling-only variant changed the air grading field")
        base_canonical = source.replace(
            "    h_outer_scaled = h_outer * SCALE\n", "<field-insertion>\n", 1
        )
        variant_canonical = patched_source.replace(
            _OWNER_CEILING_ONLY_INSERTION, "<field-insertion>\n", 1
        )
        for anchor in _FIELD_OUTER_ANCHORS[1:]:
            replacement = anchor.replace("h_outer_scaled", _OWNER_CEILING_ONLY_REPLACEMENT)
            base_canonical = base_canonical.replace(anchor, "<owner-ceiling-anchor>", 1)
            variant_canonical = variant_canonical.replace(replacement, "<owner-ceiling-anchor>", 1)
        if base_canonical != variant_canonical:
            raise storage.StorageError(
                "Owner-ceiling-only variant changed source outside its anchors"
            )
        level_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_box_airbox_layer_levels"
        ]
        if len(level_calls) != 1:
            raise storage.StorageError("Owner-ceiling-only variant changed the level-call budget")
        level_keywords = [item for item in level_calls[0].keywords if item.arg == "h_outer"]
        if (
            len(level_keywords) != 1
            or not isinstance(level_keywords[0].value, ast.Name)
            or level_keywords[0].value.id != "h_outer"
        ):
            raise storage.StorageError("Owner-ceiling-only variant changed the 50 nm level input")
        grading_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_add_airbox_grading_field"
        ]
        if len(grading_calls) != 1:
            raise storage.StorageError("Owner-ceiling-only variant changed the grading-call budget")
        grading_keywords = [item for item in grading_calls[0].keywords if item.arg == "h_outer"]
        if (
            len(grading_keywords) != 1
            or not isinstance(grading_keywords[0].value, ast.Name)
            or grading_keywords[0].value.id != "h_outer_scaled"
        ):
            raise storage.StorageError("Owner-ceiling-only variant changed the grading field")

    metadata = {
        "variant": variant,
        "metadata_kind": "prepared_in_memory_candidate",
        "base_function_sha256": _sha256_bytes(source.encode("utf-8")),
        "variant_function_sha256": _sha256_bytes(patched_source.encode("utf-8")),
        "base_function_signature": str(inspect.signature(original)),
        "variant_function_signature": str(inspect.signature(patched)),
        "variant_contract": contract,
        "owner_and_air_field_source_scope": "in_memory_candidate_only",
        "variant_source_path": str(candidate),
        "variant_source_sha256": candidate_sha,
        "compiled_filename": str(patched.__code__.co_filename),
        "prepared_compiled_filename": str(patched.__code__.co_filename),
        "compiled_filename_semantics": "prepared_candidate_only",
    }
    metadata["source_ast_anchors"] = (
        _staged_source_anchor_counts(source)
        if variant in STAGED_VARIANT_NAMES
        else (
            body_first_cad_metadata["source_ast_anchors"]
            if body_first_cad_metadata is not None
            else None
        )
    )
    if body_first_cad_metadata is not None:
        source_origin = inspect.getsourcefile(original)
        if not isinstance(source_origin, str) or not source_origin:
            raise storage.StorageError("Body-first CAD clone has no source origin")
        source_origin_path = Path(source_origin).resolve()
        if not source_origin_path.is_file() or storage.is_link(source_origin_path):
            raise storage.StorageError("Body-first CAD clone source origin is not a regular file")
        metadata.update(body_first_cad_metadata)
        metadata["clone_source_origin"] = str(source_origin_path)
        metadata["clone_source_file_sha256"] = _sha256_file(source_origin_path)
        metadata["clone_source_function_sha256"] = metadata["base_function_sha256"]
    return patched, metadata


def _module_details(name: str, module: object) -> dict[str, object]:
    origin = exact_diagnostics._module_origin(module)
    if not origin or not Path(origin).is_file() or storage.is_link(Path(origin)):
        raise storage.StorageError(f"Module {name} has no regular source origin")
    version = getattr(module, "__version__", None)
    if version is None and name == "gmsh":
        getter = getattr(module, "version", None)
        version = getter() if callable(getter) else None
    return {"origin": origin, "version": None if version is None else str(version)}


def _canonical_json_digest(value: object) -> str:
    return _sha256_bytes(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )


def _physical_group_entities(gmsh: object, dimension: int, tag: int) -> list[int]:
    try:
        return sorted(
            int(value)
            for value in gmsh.model.getEntitiesForPhysicalGroup(dimension, tag)
        )
    except Exception:
        return []


def _all_node_coordinates(gmsh: object) -> dict[int, tuple[float, float, float]]:
    tags, coordinates, _ = gmsh.model.mesh.getNodes()
    flat = [float(value) for value in coordinates]
    return {
        int(tag): (flat[index * 3], flat[index * 3 + 1], flat[index * 3 + 2])
        for index, tag in enumerate(tags)
    }


def _element_records(
    gmsh: object,
    *,
    dimension: int,
    entities: list[int],
) -> tuple[dict[str, int], list[tuple[int, int, int, tuple[int, ...]]]]:
    counts: dict[str, int] = {}
    records: list[tuple[int, int, int, tuple[int, ...]]] = []
    for entity in entities:
        element_types, element_tags, node_tags = gmsh.model.mesh.getElements(dimension, entity)
        for element_type, tags, nodes in zip(element_types, element_tags, node_tags):
            tags_list = [int(value) for value in tags]
            counts[str(int(element_type))] = counts.get(str(int(element_type)), 0) + len(tags_list)
            if dimension == 2:
                width = len(nodes) // max(1, len(tags_list))
                for offset, element_tag in enumerate(tags_list):
                    records.append(
                        (
                            int(entity),
                            int(element_tag),
                            int(element_type),
                            tuple(int(value) for value in nodes[offset * width : (offset + 1) * width]),
                        )
                    )
    return counts, records


def _pre_subdivide_observation(gmsh: object, levels_m: list[float] | None) -> dict[str, object]:
    coordinate_map = _all_node_coordinates(gmsh)
    body_entities = _physical_group_entities(gmsh, 3, 1)
    air_entities = _physical_group_entities(gmsh, 3, 2)
    interface_entities = _physical_group_entities(gmsh, 2, 10)
    if not body_entities or not air_entities:
        raise storage.StorageError("Pre-subdivide observation lacks body or air physical volumes")
    if not interface_entities:
        raise storage.StorageError("Pre-subdivide observation lacks the interface physical group")
    interface_counts, interface_records = _element_records(
        gmsh, dimension=2, entities=interface_entities
    )
    interface_triangles: list[tuple[tuple[float, float, float], ...]] = []
    interface_quads: list[tuple[tuple[float, float, float], ...]] = []
    interface_facets: list[dict[str, object]] = []
    for _entity, _tag, element_type, node_ids in interface_records:
        try:
            points = tuple(
                tuple(round(float(coordinate_map[node][axis]) / 1.0e6, 20) for axis in range(3))
                for node in node_ids
            )
        except KeyError as error:
            raise storage.StorageError(f"Interface facet refers to unknown node {error}") from error
        if element_type == 2:
            if len(points) != 3:
                raise storage.StorageError("Gmsh type 2 interface facet is not tri3")
            interface_triangles.append(tuple(sorted(points)))
        elif element_type == 3:
            if len(points) != 4:
                raise storage.StorageError("Gmsh type 3 interface facet is not quad4")
            interface_quads.append(tuple(sorted(points)))
        interface_facets.append(
            {"element_type": element_type, "points": tuple(sorted(points))}
        )
    if not interface_facets:
        raise storage.StorageError("Pre-subdivide observation lacks interface facets")

    body_node_ids: set[int] = set()
    for entity in body_entities:
        element_types, _element_tags, node_tags = gmsh.model.mesh.getElements(3, entity)
        for _element_type, nodes in zip(element_types, node_tags):
            body_node_ids.update(int(value) for value in nodes)
    body_xy = sorted(
        {
            (
                round(coordinate_map[node][0] / 1.0e6, 17),
                round(coordinate_map[node][1] / 1.0e6, 17),
            )
            for node in body_node_ids
            if node in coordinate_map
        }
    )
    if not body_xy:
        raise storage.StorageError("Pre-subdivide observation lacks magnetic body XY nodes")
    return {
        "levels_m": None
        if levels_m is None
        else [float(value) for value in levels_m],
        "body_volume_tags": body_entities,
        "air_volume_tags": air_entities,
        "interface_surface_tags": interface_entities,
        "interface_facet_count": len(interface_facets),
        "interface_facet_type_counts": interface_counts,
        "interface_triangle_count": len(interface_triangles),
        "interface_triangle_digest": _canonical_json_digest(interface_triangles),
        "interface_quad4_count": len(interface_quads),
        "interface_quad4_digest": _canonical_json_digest(interface_quads),
        "interface_facet_digest": _canonical_json_digest(interface_facets),
        "body_xy_count": len(body_xy),
        "body_xy_m": body_xy,
        "body_xy_digest": _canonical_json_digest(body_xy),
    }


def _build_owner_ring_case(airbox_hmax: float) -> tuple[object, object, object, object]:
    import fullmag as fm
    from fullmag.meshing.asset_pipeline import (
        realize_fem_domain_mesh_asset_from_components_with_report,
    )

    geometry = fm.Difference(
        base=fm.Box(40e-9, 40e-9, 10e-9, name="owner_target_ring_box"),
        tool=fm.Cylinder(radius=8e-9, height=10e-9, name="owner_target_ring_hole"),
        name="owner_target_ring",
    )
    mesh_workflow = {
        "mesh_options": {
            "mesh_strategy": "thin_film_tetrahedral",
            "through_thickness_elements": 3,
            "periodic_pair_ids": ["x_faces", "y_faces"],
            "compute_quality": False,
            "per_element_quality": False,
            "size_fields": [],
        },
        "per_geometry": [{"geometry": geometry.geometry_name, "hmax": 20e-9}],
    }
    study_universe = {
        "mode": "manual",
        "size": [40e-9, 40e-9, 410e-9],
        "center": [0.0, 0.0, 0.0],
        "airbox_hmax": airbox_hmax,
    }
    return geometry, mesh_workflow, study_universe, realize_fem_domain_mesh_asset_from_components_with_report


def _requested_controls(
    *,
    variant: str,
    mesh_workflow: object,
    study_universe: object,
) -> dict[str, object]:
    """Return authored controls separately from any in-memory variant override."""
    if not isinstance(mesh_workflow, dict) or not isinstance(study_universe, dict):
        raise storage.StorageError("Owner/air diagnostic controls are not plain mappings")
    authored_airbox_hmax = study_universe.get("airbox_hmax")
    if not isinstance(authored_airbox_hmax, (int, float)) or isinstance(
        authored_airbox_hmax, bool
    ):
        raise storage.StorageError("Owner/air diagnostic lacks authored airbox_hmax")
    realization_override = {
        "levels_air_target_m": None,
        "air_field_outer_m": None,
        "owner_vout_outer_m": None,
        "global_air_ceiling_m": None,
    }
    if variant == "fixed_levels":
        realization_override["levels_air_target_m"] = 30e-9
    elif variant == "fixed_fields":
        realization_override.update(
            air_field_outer_m=30e-9,
            owner_vout_outer_m=30e-9,
            global_air_ceiling_m=30e-9,
        )
    elif variant == "air_field_only_30":
        realization_override["air_field_outer_m"] = 30e-9
    elif variant == "owner_ceiling_only_30":
        realization_override.update(
            owner_vout_outer_m=30e-9,
            global_air_ceiling_m=30e-9,
        )
    elif variant not in {
        "reference_current_wip_30",
        "baseline_current_wip",
        "clone_reference_current_wip_30",
        "clone_baseline_current_wip",
        "repeat_reference_current_wip_30",
        "repeat_baseline_current_wip",
        *STAGED_VARIANT_NAMES,
        *BODY_FIRST_CAD_VARIANT_NAMES,
    }:
        raise storage.StorageError(f"Unsupported owner/air variant controls: {variant}")
    controls = {
        "authored": {
            "hints": {"order": 1, "hmax_m": 10e-9},
            "mesh_workflow": mesh_workflow,
            "study_universe": study_universe,
            "airbox_hmax_m": float(authored_airbox_hmax),
            "owner_target_ring_hmax_m": 20e-9,
        },
        "variant_realization_overrides": realization_override,
    }
    try:
        # Force a detached JSON-compatible copy so the receipt cannot retain
        # references that a mesher or a report mutates during realization.
        return json.loads(json.dumps(controls, allow_nan=False))
    except (TypeError, ValueError) as error:
        raise storage.StorageError("Owner/air diagnostic controls are not JSON-safe") from error


def _report_payload(report: object, *, geometry_name: str) -> dict[str, object]:
    to_dict = getattr(report, "to_dict", None)
    if not callable(to_dict):
        raise storage.StorageError("public_realize returned a report without to_dict")
    payload = to_dict()
    if not isinstance(payload, dict):
        raise storage.StorageError("public_realize report is not a mapping")
    try:
        payload = json.loads(json.dumps(payload, allow_nan=False))
    except (TypeError, ValueError) as error:
        raise storage.StorageError("public_realize report is not JSON-safe") from error
    effective_airbox = payload.get("effective_airbox_target")
    per_object = payload.get("effective_per_object_targets")
    if not isinstance(effective_airbox, dict) or not isinstance(per_object, dict):
        raise storage.StorageError("public_realize report lacks effective target mappings")
    owner_target = per_object.get(geometry_name)
    if not isinstance(owner_target, dict):
        raise storage.StorageError(
            f"public_realize report lacks effective target for {geometry_name}"
        )
    owner_hmax = owner_target.get("hmax")
    if not isinstance(owner_hmax, (int, float)) or isinstance(owner_hmax, bool):
        raise storage.StorageError("Effective owner target hmax is missing")
    if not math.isclose(float(owner_hmax), 20e-9, rel_tol=1e-12, abs_tol=1e-30):
        raise storage.StorageError(
            f"Effective owner target hmax drifted: expected 20e-9, got {owner_hmax!r}"
        )
    return payload


def _actual_function_metadata(
    target: object,
    *,
    execution_kind: str,
    prepared_metadata: dict[str, object] | None,
) -> dict[str, object]:
    code = getattr(target, "__code__", None)
    filename = getattr(code, "co_filename", None)
    if not isinstance(filename, str) or not filename:
        raise storage.StorageError("Executed mesher function has no source filename")
    if prepared_metadata is None:
        source = textwrap.dedent(inspect.getsource(target)).rstrip()
        source_sha = _sha256_bytes(source.encode("utf-8"))
    else:
        source_sha = prepared_metadata.get("variant_function_sha256")
        if not isinstance(source_sha, str):
            raise storage.StorageError("Prepared variant lacks its source digest")
    if execution_kind not in {
        "checked_out_original",
        "in_memory_variant",
        "in_memory_unchanged_clone",
    }:
        raise storage.StorageError(f"Unknown executed mesher function kind: {execution_kind}")
    return {
        "execution_kind": execution_kind,
        "executed_function_filename": str(Path(filename).resolve()),
        "executed_function_sha256": source_sha,
    }


def _volume_element_count(gmsh: object, volume_tags: list[int]) -> int:
    model = getattr(gmsh, "model", None)
    mesh = getattr(model, "mesh", None)
    get_elements = getattr(mesh, "getElements", None)
    if not callable(get_elements):
        raise storage.StorageError("Staged candidate cannot inspect Gmsh volume elements")
    count = 0
    for volume in volume_tags:
        _types, element_tags, _nodes = get_elements(3, int(volume))
        count += sum(len(tags) for tags in element_tags)
    return int(count)


def _volume_element_type_counts(gmsh: object, volume_tags: list[int]) -> dict[str, int]:
    model = getattr(gmsh, "model", None)
    mesh = getattr(model, "mesh", None)
    get_elements = getattr(mesh, "getElements", None)
    if not callable(get_elements):
        raise storage.StorageError("Staged candidate cannot inspect Gmsh volume types")
    counts: dict[str, int] = {}
    for volume in volume_tags:
        element_types, element_tags, _nodes = get_elements(3, int(volume))
        for element_type, tags in zip(element_types, element_tags):
            key = str(int(element_type))
            counts[key] = counts.get(key, 0) + len(tags)
    return counts


def _capture_staged_mesh_state(gmsh: object) -> dict[str, object]:
    model = getattr(gmsh, "model", None)
    option = getattr(gmsh, "option", None)
    if model is None or option is None:
        raise storage.StorageError("Staged candidate cannot capture Gmsh state")
    entities: list[tuple[int, int, float]] = []
    for dimension in range(4):
        for dim, tag in model.getEntities(dimension):
            dim_int = int(dim)
            tag_int = int(tag)
            visibility = float(model.getVisibility(dim_int, tag_int))
            if not math.isfinite(visibility):
                raise storage.StorageError("Gmsh visibility is not finite")
            entities.append((dim_int, tag_int, visibility))
    entities.sort()
    return {
        "entities": entities,
        "mesh_only_visible": float(option.getNumber("Mesh.MeshOnlyVisible")),
        "mesh_only_empty": float(option.getNumber("Mesh.MeshOnlyEmpty")),
    }


def _set_staged_visibility(
    gmsh: object,
    entities: list[tuple[int, int, float]],
    value: float,
    *,
    recursive: bool,
) -> None:
    model = getattr(gmsh, "model", None)
    if model is None:
        raise storage.StorageError("Staged candidate cannot set Gmsh visibility")
    dim_tags = [(int(dim), int(tag)) for dim, tag, _old in entities]
    if dim_tags:
        if not math.isfinite(value) or value != int(value):
            raise storage.StorageError("Gmsh visibility must be an integer")
        model.setVisibility(dim_tags, int(value), bool(recursive))


def _restore_staged_mesh_state(gmsh: object, state: dict[str, object]) -> None:
    model = getattr(gmsh, "model", None)
    option = getattr(gmsh, "option", None)
    if model is None or option is None:
        raise storage.StorageError("Staged candidate cannot restore Gmsh state")
    raw_entities = state.get("entities")
    if not isinstance(raw_entities, list):
        raise storage.StorageError("Staged Gmsh visibility state is malformed")
    expected = {(int(dim), int(tag)) for dim, tag, _old in raw_entities}
    current = {
        (int(dim), int(tag))
        for dimension in range(4)
        for dim, tag in model.getEntities(dimension)
    }
    if current != expected:
        raise storage.StorageError("Staged candidate changed the CAD entity set")
    for dim, tag, visibility in raw_entities:
        model.setVisibility([(int(dim), int(tag))], int(visibility), False)
    option.setNumber("Mesh.MeshOnlyVisible", float(state["mesh_only_visible"]))
    option.setNumber("Mesh.MeshOnlyEmpty", float(state["mesh_only_empty"]))
    for dim, tag, expected_visibility in raw_entities:
        observed = float(model.getVisibility(int(dim), int(tag)))
        if not math.isclose(observed, float(expected_visibility), rel_tol=0.0, abs_tol=1.0e-12):
            raise storage.StorageError(
                f"Staged candidate failed to restore visibility for {(dim, tag)}"
            )
    for name in ("Mesh.MeshOnlyVisible", "Mesh.MeshOnlyEmpty"):
        expected_option = float(state["mesh_only_visible" if name.endswith("Visible") else "mesh_only_empty"])
        observed_option = float(option.getNumber(name))
        if not math.isclose(observed_option, expected_option, rel_tol=0.0, abs_tol=1.0e-12):
            raise storage.StorageError(f"Staged candidate failed to restore {name}")


def _run_variant(
    *,
    variant: str,
    mesher_module: object,
    layered_module: object,
    target: object,
    public_realize: object,
    geometry: object,
    mesh_workflow: object,
    study_universe: object,
    execution_kind: str,
    prepared_metadata: dict[str, object] | None,
) -> dict[str, object]:
    requested_controls = _requested_controls(
        variant=variant,
        mesh_workflow=mesh_workflow,
        study_universe=study_universe,
    )
    active: dict[str, object] = {
        "variant": variant,
        "levels_m": None,
        "requested_controls": requested_controls,
    }
    is_staged = variant in STAGED_VARIANT_NAMES
    execution_metadata = _actual_function_metadata(
        target,
        execution_kind=execution_kind,
        prepared_metadata=prepared_metadata,
    )
    original_target = getattr(mesher_module, MESHER_FUNCTION)
    original_levels = getattr(mesher_module, "_box_airbox_layer_levels")
    original_subdivide = getattr(layered_module, "subdivide_layered_prisms")
    original_apply = getattr(mesher_module, "_apply_mesh_options", None)
    original_add_airbox_field = getattr(mesher_module, "_add_airbox_grading_field", None)
    if is_staged and (not callable(original_apply) or not callable(original_add_airbox_field)):
        raise storage.StorageError(
            "Staged candidate requires the mesher's imported field helpers"
        )

    def observed_levels(*args: object, **kwargs: object) -> object:
        levels = original_levels(*args, **kwargs)
        active["levels_m"] = [float(value) for value in levels]
        return levels

    def restore_staged_state() -> None:
        if not is_staged or active.get("staged_mesh_state") is None:
            return
        if active.get("staged_state_restored") is True:
            return
        _restore_staged_mesh_state(
            active["staged_gmsh"],  # type: ignore[arg-type]
            active["staged_mesh_state"],  # type: ignore[arg-type]
        )
        active["staged_state_restored"] = True
        evidence = active.get("staged_phase_evidence")
        if isinstance(evidence, dict):
            evidence["visibility_restored"] = True
            evidence["options_restored"] = True

    def observed_subdivide(gmsh: object) -> object:
        if not is_staged:
            active["pre_subdivide"] = _pre_subdivide_observation(
                gmsh, active.get("levels_m")
            )
            return original_subdivide(gmsh)

        observation = _pre_subdivide_observation(gmsh, active.get("levels_m"))
        evidence = active.get("staged_phase_evidence")
        if not isinstance(evidence, dict):
            raise storage.StorageError("Staged candidate lacks phase evidence")
        body_tags = [int(value) for value in observation["body_volume_tags"]]
        air_tags = [int(value) for value in observation["air_volume_tags"]]
        body_count = _volume_element_count(gmsh, body_tags)
        air_count = _volume_element_count(gmsh, air_tags)
        body_types = _volume_element_type_counts(gmsh, body_tags)
        air_types = _volume_element_type_counts(gmsh, air_tags)
        expected_body_count = evidence.get("body_volume_element_count_after_conversion")
        evidence["raw_magnetic_body_after_air_phase"] = observation
        evidence["raw_body_element_count_after_air_phase"] = body_count
        evidence["raw_body_element_types_after_air_phase"] = body_types
        if not isinstance(expected_body_count, int) or expected_body_count <= 0:
            raise storage.StorageError("Staged candidate lacks converted body count")
        if body_count != expected_body_count:
            raise storage.StorageError(
                "Staged air phase changed magnetic body element count: "
                f"{expected_body_count} -> {body_count}"
            )
        if air_count <= 0:
            raise storage.StorageError("Staged air phase produced no air volume elements")
        if set(body_types) != {"4"}:
            raise storage.StorageError("Staged air phase regenerated magnetic prisms")
        # Preserve the completed body; apply the production converter only to
        # any new air prisms and quads before checking the final mesh contract.
        original_subdivide(gmsh)
        observation = _pre_subdivide_observation(gmsh, active.get("levels_m"))
        body_types = _volume_element_type_counts(gmsh, body_tags)
        air_types = _volume_element_type_counts(gmsh, air_tags)
        if set(body_types) != {"4"} or set(air_types) != {"4"}:
            raise storage.StorageError(
                "Staged final volume mesh is not tet4-only: "
                f"body={body_types!r}, air={air_types!r}"
            )
        interface_types = observation.get("interface_facet_type_counts")
        if not isinstance(interface_types, dict) or set(interface_types) != {"2"}:
            raise storage.StorageError(
                "Staged final body/air interface is not tri3-only: "
                f"{interface_types!r}"
            )
        converted = evidence.get("magnetic_body_after_conversion")
        if not isinstance(converted, dict):
            raise storage.StorageError("Staged candidate lacks converted body observation")
        if observation.get("body_xy_digest") != converted.get("body_xy_digest"):
            raise storage.StorageError("Staged air phase changed magnetic body XY nodes")
        evidence.update(
            {
                "magnetic_body_after_air_phase": observation,
                "body_volume_element_count_after_air_phase": body_count,
                "air_volume_element_count_after_air_phase": air_count,
                "body_volume_element_type_counts_after_air_phase": body_types,
                "air_volume_element_type_counts_after_air_phase": air_types,
                "interface_facet_type_counts_after_air_phase": interface_types,
            }
        )
        active["pre_subdivide"] = observation
        # The production target finalizes Gmsh after this callback.  Restore
        # while the model is still live; the outer finally only retries when
        # an exception interrupted the callback before this point.
        restore_staged_state()
        return None

    def observed_airbox_field(*args: object, **kwargs: object) -> object:
        if active.get("staged_airbox_field_call") is not None:
            raise storage.StorageError("Staged candidate invoked the air field twice")
        active["staged_airbox_field_call"] = (args, kwargs)
        return None

    def observed_apply(*args: object, **kwargs: object) -> object:
        call_count = int(active.get("staged_apply_call_count", 0))
        if call_count != 0:
            raise storage.StorageError("Staged candidate invoked mesh options twice")
        active["staged_apply_call_count"] = 1
        bound = inspect.signature(original_apply).bind(*args, **kwargs)  # type: ignore[arg-type]
        bound.apply_defaults()
        gmsh = bound.arguments.get("gmsh")
        if gmsh is None:
            raise storage.StorageError("Staged mesh options call lacks Gmsh context")
        state = _capture_staged_mesh_state(gmsh)
        active["staged_gmsh"] = gmsh
        active["staged_mesh_state"] = state
        original_finalize = gmsh.finalize
        active["staged_original_finalize"] = original_finalize

        def finalize_staged_model(*args: object, **kwargs: object) -> object:
            # Capture early validation failures before the target tears down.
            try:
                restore_staged_state()
            finally:
                result = original_finalize(*args, **kwargs)
            return result

        gmsh.finalize = finalize_staged_model
        body_tags = _physical_group_entities(gmsh, 3, 1)
        air_tags = _physical_group_entities(gmsh, 3, 2)
        if not body_tags or not air_tags:
            raise storage.StorageError("Staged candidate lacks magnetic or air volumes")
        source_anchors = (
            prepared_metadata.get("source_ast_anchors")
            if isinstance(prepared_metadata, dict)
            else None
        )
        if source_anchors != {anchor: 1 for anchor in _STAGED_SOURCE_ANCHORS}:
            raise storage.StorageError("Staged candidate source anchors are not pinned")
        component_volume_tags = bound.arguments.get("component_volume_tags")
        component_surface_tags = bound.arguments.get("component_surface_tags")
        if not isinstance(component_volume_tags, dict) or not isinstance(
            component_surface_tags, dict
        ):
            raise storage.StorageError(
                "Staged candidate lacks component-scoped 3D field tags"
            )
        opts = bound.arguments.get("opts")
        size_fields = getattr(opts, "size_fields", None)
        lower_bound_fields = getattr(opts, "lower_bound_fields", None)
        if not isinstance(size_fields, (list, tuple)) or not isinstance(
            lower_bound_fields, (list, tuple)
        ):
            raise storage.StorageError(
                "Staged candidate cannot account for size/lower-bound fields"
            )
        evidence = {
            "contract": "magnetic_first_two_phase_mesh_only_visible_then_empty",
            "mesh_only_visible_first_phase": True,
            "mesh_only_empty_first_phase": False,
            "mesh_only_visible_second_phase": 1.0,
            "mesh_only_empty_second_phase": True,
            "visibility_restored": False,
            "options_restored": False,
            "body_volume_tags": body_tags,
            "air_volume_tags": air_tags,
            "component_volume_tags": {
                str(key): [int(value) for value in values]
                for key, values in component_volume_tags.items()
            },
            "component_surface_tag_counts": {
                str(key): len(values) for key, values in component_surface_tags.items()
            },
            "size_field_count_preserved": len(size_fields),
            "lower_bound_field_count_preserved": len(lower_bound_fields),
            "source_ast_anchors": dict(source_anchors),
        }
        active["staged_phase_evidence"] = evidence
        all_entities = state["entities"]
        if not isinstance(all_entities, list):
            raise storage.StorageError("Staged Gmsh entity state is malformed")
        _set_staged_visibility(gmsh, all_entities, 0.0, recursive=False)
        gmsh.model.setVisibility([(3, tag) for tag in body_tags], 1, True)
        gmsh.option.setNumber("Mesh.MeshOnlyVisible", 1)
        gmsh.option.setNumber("Mesh.MeshOnlyEmpty", 0)
        first_arguments = dict(bound.arguments)
        first_arguments["airbox_maximum_element_size"] = None
        if first_arguments.get("preexisting_field_ids") is not None:
            first_arguments["preexisting_field_ids"] = list(
                first_arguments["preexisting_field_ids"]
            )
        first_report = original_apply(**first_arguments)  # type: ignore[arg-type]
        gmsh.model.mesh.generate(3)
        body_before = _volume_element_count(gmsh, body_tags)
        air_before = _volume_element_count(gmsh, air_tags)
        if body_before <= 0 or air_before != 0:
            raise storage.StorageError(
                "Staged magnetic phase meshed an unexpected volume set: "
                f"body={body_before}, air={air_before}"
            )
        body_types_before = _volume_element_type_counts(gmsh, body_tags)
        magnetic_before = _pre_subdivide_observation(gmsh, active.get("levels_m"))
        original_subdivide(gmsh)
        body_after = _volume_element_count(gmsh, body_tags)
        air_after = _volume_element_count(gmsh, air_tags)
        body_types_after = _volume_element_type_counts(gmsh, body_tags)
        if body_after <= 0 or air_after != 0:
            raise storage.StorageError(
                "Staged converter changed the wrong volumes: "
                f"body={body_after}, air={air_after}"
            )
        magnetic_after = _pre_subdivide_observation(gmsh, active.get("levels_m"))
        if magnetic_before.get("body_xy_digest") != magnetic_after.get("body_xy_digest"):
            raise storage.StorageError("Staged converter changed magnetic body XY nodes")
        if set(body_types_after) != {"4"}:
            raise storage.StorageError(
                f"Staged converter did not produce tet4 body cells: {body_types_after!r}"
            )
        evidence.update(
            {
                "body_volume_element_count_before_conversion": body_before,
                "air_volume_element_count_after_body_phase": air_before,
                "body_volume_element_count_after_conversion": body_after,
                "body_volume_element_type_counts_before_conversion": body_types_before,
                "body_volume_element_type_counts_after_conversion": body_types_after,
                "magnetic_body_before_conversion": magnetic_before,
                "magnetic_body_after_conversion": magnetic_after,
                "air_field_call_captured": active.get("staged_airbox_field_call") is not None,
            }
        )
        field_call = active.get("staged_airbox_field_call")
        if not isinstance(field_call, tuple) or len(field_call) != 2:
            raise storage.StorageError("Staged candidate did not capture its air field")
        field_args, field_kwargs = field_call
        airbox_field = original_add_airbox_field(*field_args, **field_kwargs)  # type: ignore[arg-type]
        if not isinstance(airbox_field, int) or airbox_field <= 0:
            raise storage.StorageError("Staged candidate air field did not return a valid id")
        second_arguments = dict(bound.arguments)
        preexisting = list(second_arguments.get("preexisting_field_ids") or [])
        second_arguments["preexisting_field_ids"] = [*preexisting, int(airbox_field)]
        second_arguments["airbox_maximum_element_size"] = bound.arguments.get(
            "airbox_maximum_element_size"
        )
        completed_volumes = [(3, tag) for tag in body_tags]
        gmsh.model.mesh.removeConstraints(completed_volumes)
        evidence["consumed_volume_constraints_removed"] = completed_volumes
        _set_staged_visibility(gmsh, all_entities, 1.0, recursive=False)
        gmsh.model.setVisibility([(3, tag) for tag in body_tags], 0, False)
        gmsh.option.setNumber("Mesh.MeshOnlyVisible", 1)
        gmsh.option.setNumber("Mesh.MeshOnlyEmpty", 1)
        active["staged_phase_evidence"].update(
            {
                "airbox_field_id": int(airbox_field),
                "phase_two_prepared": True,
            }
        )
        return original_apply(**second_arguments)  # type: ignore[arg-type]

    try:
        setattr(mesher_module, MESHER_FUNCTION, target)
        setattr(mesher_module, "_box_airbox_layer_levels", observed_levels)
        setattr(layered_module, "subdivide_layered_prisms", observed_subdivide)
        if is_staged:
            setattr(mesher_module, "_apply_mesh_options", observed_apply)
            setattr(mesher_module, "_add_airbox_grading_field", observed_airbox_field)
        mesh_output, region_markers, report = public_realize(
            geometries=[geometry],
            hints=__import__("fullmag").FEM(order=1, hmax=10e-9),
            study_universe=study_universe,
            mesh_workflow=mesh_workflow,
        )
        observation = active.get("pre_subdivide")
        if not isinstance(observation, dict):
            raise storage.StorageError("Mesher completed without pre-subdivide observation")
        report_payload = _report_payload(report, geometry_name=geometry.geometry_name)
        observation["requested_controls"] = requested_controls
        observation["effective_airbox_target"] = report_payload["effective_airbox_target"]
        observation["effective_per_object_targets"] = {
            geometry.geometry_name: report_payload["effective_per_object_targets"][
                geometry.geometry_name
            ]
        }
        try:
            region_markers_payload = json.loads(
                json.dumps(region_markers, allow_nan=False)
            )
        except (TypeError, ValueError) as error:
            raise storage.StorageError("public_realize region markers are not JSON-safe") from error
        observation["public_realize_output"] = {
            "mesh_type": type(mesh_output).__name__,
            "region_markers": region_markers_payload,
            "shared_domain_build_report": report_payload,
        }
        if is_staged:
            staged_evidence = active.get("staged_phase_evidence")
            if not isinstance(staged_evidence, dict):
                raise storage.StorageError("Staged candidate lacks final phase evidence")
            observation["staged_phase_evidence"] = staged_evidence
        return {
            "variant": variant,
            "attempted": True,
            "status": "observed",
            "skipped": False,
            **execution_metadata,
            "requested_controls": requested_controls,
            "effective_airbox_target": report_payload["effective_airbox_target"],
            "effective_per_object_targets": {
                geometry.geometry_name: report_payload["effective_per_object_targets"][
                    geometry.geometry_name
                ]
            },
            "staged_phase_evidence": active.get("staged_phase_evidence")
            if is_staged
            else None,
            "observation": observation,
        }
    except BaseException as error:
        return {
            "variant": variant,
            "attempted": True,
            "status": "error",
            "skipped": False,
            "error": f"{type(error).__name__}: {error}",
            **execution_metadata,
            "requested_controls": requested_controls,
            "levels_m": active.get("levels_m"),
            "pre_subdivide": active.get("pre_subdivide"),
            "staged_phase_evidence": active.get("staged_phase_evidence")
            if is_staged
            else None,
        }
    finally:
        restore_error: BaseException | None = None
        if is_staged and active.get("staged_mesh_state") is not None:
            try:
                restore_staged_state()
            except BaseException as error:
                restore_error = error
        setattr(mesher_module, MESHER_FUNCTION, original_target)
        setattr(mesher_module, "_box_airbox_layer_levels", original_levels)
        setattr(layered_module, "subdivide_layered_prisms", original_subdivide)
        if is_staged:
            setattr(mesher_module, "_apply_mesh_options", original_apply)
            setattr(mesher_module, "_add_airbox_grading_field", original_add_airbox_field)
            if active.get("staged_original_finalize") is not None:
                active["staged_gmsh"].finalize = active["staged_original_finalize"]
        if getattr(mesher_module, MESHER_FUNCTION) is not original_target:
            raise storage.StorageError("Mesher target was not restored")
        if getattr(mesher_module, "_box_airbox_layer_levels") is not original_levels:
            raise storage.StorageError("Layer schedule helper was not restored")
        if getattr(layered_module, "subdivide_layered_prisms") is not original_subdivide:
            raise storage.StorageError("Layer converter was not restored")
        if is_staged:
            if getattr(mesher_module, "_apply_mesh_options") is not original_apply:
                raise storage.StorageError("Mesh options helper was not restored")
            if getattr(mesher_module, "_add_airbox_grading_field") is not original_add_airbox_field:
                raise storage.StorageError("Air field helper was not restored")
        if restore_error is not None:
            raise storage.StorageError(
                f"Staged Gmsh state restoration failed: {restore_error}"
            ) from restore_error


def _child_main(repo: Path, run_root: Path) -> int:
    layout = storage.resolve_layout(repo, DIAGNOSTIC_PROFILE)
    run_root = storage.validate_path(run_root, layout["runs_root"], "owner/air child root")
    summary_path = run_root / "child-summary.json"
    summary: dict[str, object] = {
        "schema": CHILD_SCHEMA,
        "state": "running",
        "suite": SUITE_NAME,
        "source_base_reference": EXPERIMENT_SOURCE_BASE,
        "mesher_module": MESHER_MODULE,
        "mesher_function": MESHER_FUNCTION,
        "expected_variants": list(VARIANT_NAMES),
        "prepared_variants": list(PREPARED_VARIANT_NAMES),
        "source_roots": {
            "package": str((repo / "packages/fullmag-py/src").resolve()),
            "tests": str((repo / "packages/fullmag-py/tests").resolve()),
        },
        "source_fingerprints_before": None,
        "source_fingerprints_after": None,
        "source_origins": _source_origins(repo),
        "module_origins": {},
        "module_details": {},
        "python_executable": str(Path(sys.executable).resolve()),
        "mesher_variants": [],
        "variant_runs": [],
        "qualification": "not_assessed",
        "scope": EXPERIMENT_SCOPE,
    }
    try:
        summary["source_fingerprints_before"] = _source_fingerprints(repo)
        sys.path[:0] = [str(repo / "packages/fullmag-py/src"), str(repo / "packages/fullmag-py/tests")]
        import fullmag
        import gmsh
        import numpy
        import fullmag.meshing._gmsh_swept as gmsh_swept
        import fullmag.meshing._gmsh_layered_tetrahedra as layered_tetrahedra

        module_objects = {
            "fullmag": fullmag,
            "fullmag.meshing._gmsh_swept": gmsh_swept,
            "fullmag.meshing._gmsh_layered_tetrahedra": layered_tetrahedra,
            "gmsh": gmsh,
            "numpy": numpy,
        }
        summary["module_details"] = {
            name: _module_details(name, module) for name, module in module_objects.items()
        }
        summary["module_details"]["python"] = {"origin": None, "version": sys.version}
        summary["module_origins"] = {
            name: details["origin"]
            for name, details in summary["module_details"].items()
            if isinstance(details, dict) and details.get("origin")
        }
        original = getattr(gmsh_swept, MESHER_FUNCTION)
        if not callable(original):
            raise storage.StorageError("Target mesher function is not callable")
        prepared_variants: list[tuple[object, dict[str, object]]] = []
        for variant in PREPARED_VARIANT_NAMES:
            prepared_variants.append(
                _prepare_variant(original, gmsh_swept, variant=variant, run_root=run_root)
            )
        summary["mesher_variants"] = [metadata for _target, metadata in prepared_variants]
        prepared_by_name = {
            metadata["variant"]: (target, metadata)
            for target, metadata in prepared_variants
        }
        for variant in VARIANT_NAMES:
            prepared_target, prepared_metadata = prepared_by_name.get(
                variant, (None, None)
            )
            if variant in {
                "fixed_levels",
                "fixed_fields",
                "air_field_only_30",
                "owner_ceiling_only_30",
                *STAGED_VARIANT_NAMES,
                *BODY_FIRST_CAD_VARIANT_NAMES,
            }:
                target = prepared_target
                execution_kind = "in_memory_variant"
                actual_prepared_metadata = prepared_metadata
            elif variant == "clone_reference_current_wip_30":
                target, actual_prepared_metadata = prepared_by_name["reference_current_wip_30"]
                execution_kind = "in_memory_unchanged_clone"
            elif variant == "clone_baseline_current_wip":
                target, actual_prepared_metadata = prepared_by_name["baseline_current_wip"]
                execution_kind = "in_memory_unchanged_clone"
            else:
                target = original
                execution_kind = "checked_out_original"
                actual_prepared_metadata = None
            if not callable(target):
                raise storage.StorageError(f"No executable target prepared for {variant}")
            airbox_hmax = (
                30e-9
                if variant in {
                    "reference_current_wip_30",
                    "clone_reference_current_wip_30",
                    "repeat_reference_current_wip_30",
                    "staged_magnetic_first_30",
                    "body_first_cad_30",
                }
                else 50e-9
            )
            geometry, mesh_workflow, study_universe, public_realize = _build_owner_ring_case(
                airbox_hmax
            )
            result = _run_variant(
                variant=variant,
                mesher_module=gmsh_swept,
                layered_module=layered_tetrahedra,
                target=target,
                public_realize=public_realize,
                geometry=geometry,
                mesh_workflow=mesh_workflow,
                study_universe=study_universe,
                execution_kind=execution_kind,
                prepared_metadata=actual_prepared_metadata,
            )
            summary["variant_runs"].append(result)
        summary["source_fingerprints_after"] = _source_fingerprints(repo)
        if summary["source_fingerprints_before"] != summary["source_fingerprints_after"]:
            raise storage.StorageError("Source fingerprints changed during experiment")
        if [item.get("variant") for item in summary["variant_runs"]] != list(VARIANT_NAMES):
            raise storage.StorageError("Experiment did not attempt exactly fourteen variants")
        if any(item.get("attempted") is not True for item in summary["variant_runs"]):
            raise storage.StorageError("An expected variant was not attempted")
        summary["state"] = "completed"
        summary["driver_exit_code"] = 0
        return 0
    except BaseException as error:
        summary["state"] = "failed"
        summary["driver_exit_code"] = 2
        summary["error"] = f"{type(error).__name__}: {error}"
        traceback.print_exc(file=sys.stderr)
        return 2
    finally:
        if summary["source_fingerprints_after"] is None:
            try:
                summary["source_fingerprints_after"] = _source_fingerprints(repo)
            except BaseException as error:
                summary["source_fingerprints_after_error"] = f"{type(error).__name__}: {error}"
        storage.atomic_json(summary_path, summary)


def _validate_child_summary(summary: object, *, repo: Path, run_root: Path) -> None:
    if not isinstance(summary, dict):
        raise storage.StorageError("Child summary is not an object")
    if summary.get("schema") != CHILD_SCHEMA or summary.get("state") != "completed":
        raise storage.StorageError("Child summary is not terminal completed")
    if summary.get("suite") != SUITE_NAME:
        raise storage.StorageError("Child summary suite drifted")
    if summary.get("source_base_reference") != EXPERIMENT_SOURCE_BASE:
        raise storage.StorageError("Child source base reference drifted")
    if summary.get("mesher_module") != MESHER_MODULE or summary.get("mesher_function") != MESHER_FUNCTION:
        raise storage.StorageError("Child mesher target drifted")
    if summary.get("scope") != EXPERIMENT_SCOPE:
        raise storage.StorageError("Child experiment scope drifted")
    if summary.get("expected_variants") != list(VARIANT_NAMES):
        raise storage.StorageError("Child variant contract drifted")
    if summary.get("prepared_variants") != list(PREPARED_VARIANT_NAMES):
        raise storage.StorageError("Child prepared-variant contract drifted")
    if summary.get("qualification") != "not_assessed":
        raise storage.StorageError("Child changed qualification boundary")
    before = summary.get("source_fingerprints_before")
    after = summary.get("source_fingerprints_after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise storage.StorageError("Child source fingerprints are missing")
    expected_fingerprints = _source_fingerprints(repo)
    if set(before) != set(expected_fingerprints) or before != after:
        raise storage.StorageError("Child source fingerprints are incomplete or changed")
    if any(
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
        for value in before.values()
    ):
        raise storage.StorageError("Child source fingerprints contain invalid digests")
    if summary.get("source_origins") != _source_origins(repo):
        raise storage.StorageError("Child source origins drifted")
    for name, origin in summary["source_origins"].items():
        origin_path = Path(origin)
        if not storage.inside(origin_path, repo) or storage.is_link(origin_path):
            raise storage.StorageError(f"Child source origin escapes the repository: {name}")
        if name == "python_package":
            valid_origin = origin_path.is_dir()
        else:
            valid_origin = origin_path.is_file()
        if not valid_origin:
            raise storage.StorageError(f"Child source origin is not a regular path: {name}")
    variants = summary.get("mesher_variants")
    if not isinstance(variants, list) or [item.get("variant") for item in variants] != list(
        PREPARED_VARIANT_NAMES
    ):
        raise storage.StorageError("Child source variant metadata is incomplete")
    variant_root = storage.validate_path(run_root / "variants", run_root, "owner/air variant root")
    prepared_by_variant: dict[str, dict[str, object]] = {}
    for item in variants:
        if not isinstance(item, dict):
            raise storage.StorageError("Child variant metadata is not an object")
        source_path = item.get("variant_source_path")
        source_sha = item.get("variant_source_sha256")
        compiled = item.get("compiled_filename")
        if not isinstance(source_path, str) or not isinstance(source_sha, str) or not isinstance(compiled, str):
            raise storage.StorageError("Child variant source pin is incomplete")
        if item.get("metadata_kind") != "prepared_in_memory_candidate":
            raise storage.StorageError("Child variant metadata kind drifted")
        if item.get("compiled_filename_semantics") != "prepared_candidate_only":
            raise storage.StorageError("Child prepared compiled filename semantics drifted")
        path = storage.validate_path(Path(source_path), variant_root, "owner/air variant source")
        if path.parent != variant_root or not path.is_file() or _sha256_file(path) != source_sha:
            raise storage.StorageError("Child variant source is not pinned to its run-root file")
        if compiled != source_path:
            raise storage.StorageError("Child variant compiled filename drifted")
        if item.get("prepared_compiled_filename") != compiled:
            raise storage.StorageError("Child prepared compiled filename metadata drifted")
        if item.get("base_function_signature") != item.get("variant_function_signature"):
            raise storage.StorageError("Child variant changed target signature")
        if item.get("variant") in STAGED_VARIANT_NAMES:
            if item.get("source_ast_anchors") != {
                anchor: 1 for anchor in _STAGED_SOURCE_ANCHORS
            }:
                raise storage.StorageError("Child staged source anchors are incomplete")
        elif item.get("variant") in BODY_FIRST_CAD_VARIANT_NAMES:
            if item.get("source_ast_anchors") != _BODY_FIRST_CAD_SOURCE_AST_ANCHORS:
                raise storage.StorageError("Child body-first CAD source anchors are incomplete")
            body_first_budget = item.get("body_first_cad_ast_budget")
            if not isinstance(body_first_budget, dict) or body_first_budget.get(
                "preserved"
            ) is not True:
                raise storage.StorageError("Child body-first CAD AST budget is missing")
            source_calls = body_first_budget.get("source_call_counts")
            candidate_calls = body_first_budget.get("candidate_call_counts")
            if not isinstance(source_calls, dict) or source_calls != candidate_calls:
                raise storage.StorageError("Child body-first CAD AST call budget drifted")
            if any(
                not isinstance(count, int) or isinstance(count, bool) or count < 0
                for count in source_calls.values()
            ):
                raise storage.StorageError("Child body-first CAD AST call budget is malformed")
            expected_clone_origin = _source_origins(repo)["gmsh_swept"]
            if item.get("clone_source_origin") != expected_clone_origin:
                raise storage.StorageError("Body-first CAD clone origin drifted")
            if item.get("clone_source_file_sha256") != expected_fingerprints["gmsh_swept"]:
                raise storage.StorageError("Body-first CAD clone source file digest drifted")
            base_source = _mesher_function_source(repo)
            if item.get("base_function_sha256") != _sha256_bytes(base_source.encode("utf-8")):
                raise storage.StorageError("Body-first CAD clone function digest drifted")
            if item.get("clone_source_function_sha256") != item.get("base_function_sha256"):
                raise storage.StorageError("Body-first CAD clone function origin digest drifted")
            expected_candidate, expected_body_metadata = _body_first_cad_source(base_source)
            if path.read_text(encoding="utf-8") != expected_candidate:
                raise storage.StorageError("Body-first CAD source replacement drifted")
            if body_first_budget != expected_body_metadata["body_first_cad_ast_budget"]:
                raise storage.StorageError("Body-first CAD AST budget does not match the source clone")
            expected_contract = (
                "body_first_cad_interval_order_authored_30nm"
                if item.get("variant") == "body_first_cad_30"
                else "body_first_cad_interval_order_authored_50nm"
            )
            if item.get("variant_contract") != expected_contract:
                raise storage.StorageError("Body-first CAD variant contract drifted")
        elif item.get("source_ast_anchors") is not None:
            raise storage.StorageError("Non-staged variant carries staged source anchors")
        prepared_by_variant[str(item["variant"])] = item
    runs = summary.get("variant_runs")
    if not isinstance(runs, list) or [item.get("variant") for item in runs] != list(VARIANT_NAMES):
        raise storage.StorageError("Child variant observations are incomplete")
    for item in runs:
        if not isinstance(item, dict) or item.get("attempted") is not True or item.get("skipped") is not False:
            raise storage.StorageError("Child variant run was not a real non-skipped attempt")
        execution_kind = item.get("execution_kind")
        executed_filename = item.get("executed_function_filename")
        executed_sha = item.get("executed_function_sha256")
        if execution_kind not in {
            "checked_out_original",
            "in_memory_variant",
            "in_memory_unchanged_clone",
        }:
            raise storage.StorageError("Child executed function kind is invalid")
        if not isinstance(executed_filename, str) or not isinstance(executed_sha, str):
            raise storage.StorageError("Child executed function metadata is incomplete")
        if len(executed_sha) != 64 or any(
            character not in "0123456789abcdef" for character in executed_sha
        ):
            raise storage.StorageError("Child executed function digest is invalid")
        if item.get("variant") in {
            "fixed_levels",
            "fixed_fields",
            "air_field_only_30",
            "owner_ceiling_only_30",
            *BODY_FIRST_CAD_VARIANT_NAMES,
            *STAGED_VARIANT_NAMES,
        }:
            if execution_kind != "in_memory_variant":
                raise storage.StorageError("Fixed variant did not execute its in-memory candidate")
            executed_path = storage.validate_path(
                Path(executed_filename), variant_root, "owner/air executed variant source"
            )
            if not executed_path.is_file():
                raise storage.StorageError("Executed variant source is not a regular file")
            prepared = prepared_by_variant[item["variant"]]
            if Path(executed_filename).resolve() != Path(
                str(prepared.get("compiled_filename"))
            ).resolve() or executed_sha != prepared.get("variant_function_sha256"):
                raise storage.StorageError("Executed variant metadata does not match its prepared source")
        elif item.get("variant") in {
            "clone_reference_current_wip_30",
            "clone_baseline_current_wip",
        }:
            if execution_kind != "in_memory_unchanged_clone":
                raise storage.StorageError("Prepared baseline clone did not execute as an unchanged clone")
            executed_path = storage.validate_path(
                Path(executed_filename), variant_root, "owner/air executed clone source"
            )
            if not executed_path.is_file():
                raise storage.StorageError("Executed clone source is not a regular file")
            source_variant = {
                "clone_reference_current_wip_30": "reference_current_wip_30",
                "clone_baseline_current_wip": "baseline_current_wip",
            }[item["variant"]]
            prepared = prepared_by_variant[source_variant]
            if prepared.get("variant_function_sha256") != prepared.get("base_function_sha256"):
                raise storage.StorageError("Prepared baseline clone is not source-identical")
            if Path(executed_filename).resolve() != Path(
                str(prepared.get("compiled_filename"))
            ).resolve() or executed_sha != prepared.get("variant_function_sha256"):
                raise storage.StorageError("Executed clone metadata does not match its prepared source")
        else:
            if execution_kind != "checked_out_original":
                raise storage.StorageError("Baseline variant did not execute checked-out source")
            expected_source = (repo / "packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py").resolve()
            if Path(executed_filename).resolve() != expected_source:
                raise storage.StorageError("Baseline executed function escaped checked-out source")
            baseline_prepared = prepared_by_variant["baseline_current_wip"]
            if executed_sha != baseline_prepared.get("base_function_sha256"):
                raise storage.StorageError("Baseline executed function digest drifted")
        controls = item.get("requested_controls")
        if not isinstance(controls, dict):
            raise storage.StorageError("Child variant requested controls are missing")
        authored = controls.get("authored")
        if not isinstance(authored, dict):
            raise storage.StorageError("Child variant authored controls are missing")
        variant_name = item.get("variant")
        if variant_name not in VARIANT_NAMES:
            raise storage.StorageError("Child variant name is invalid")
        expected_authored_airbox = (
            30e-9
            if variant_name
            in {
                "reference_current_wip_30",
                "clone_reference_current_wip_30",
                "repeat_reference_current_wip_30",
                "staged_magnetic_first_30",
                "body_first_cad_30",
            }
            else 50e-9
        )
        authored_airbox = authored.get("airbox_hmax_m")
        if not isinstance(authored_airbox, (int, float)) or isinstance(
            authored_airbox, bool
        ) or not math.isclose(
            float(authored_airbox), expected_authored_airbox, rel_tol=1e-12, abs_tol=1e-30
        ):
            raise storage.StorageError("Child variant authored airbox hmax drifted")
        overrides = controls.get("variant_realization_overrides")
        expected_overrides = {
            "levels_air_target_m": 30e-9 if variant_name == "fixed_levels" else None,
            "air_field_outer_m": (
                30e-9
                if variant_name in {"fixed_fields", "air_field_only_30"}
                else None
            ),
            "owner_vout_outer_m": (
                30e-9
                if variant_name in {"fixed_fields", "owner_ceiling_only_30"}
                else None
            ),
            "global_air_ceiling_m": (
                30e-9
                if variant_name in {"fixed_fields", "owner_ceiling_only_30"}
                else None
            ),
        }
        if overrides != expected_overrides:
            raise storage.StorageError("Child variant realization overrides drifted")
        owner_hmax = authored.get("owner_target_ring_hmax_m")
        if not isinstance(owner_hmax, (int, float)) or isinstance(owner_hmax, bool) or not math.isclose(
            float(owner_hmax), 20e-9, rel_tol=1e-12, abs_tol=1e-30
        ):
            raise storage.StorageError("Child variant authored owner hmax drifted")
        if item.get("status") not in {"observed", "error"}:
            raise storage.StorageError("Child variant status is invalid")
        if item.get("status") == "error" and not isinstance(item.get("error"), str):
            raise storage.StorageError("Child error observation lacks bounded error text")
        if item.get("status") != "observed":
            continue
        effective_airbox = item.get("effective_airbox_target")
        effective_per_object = item.get("effective_per_object_targets")
        if not isinstance(effective_airbox, dict) or not isinstance(effective_per_object, dict):
            raise storage.StorageError("Child observed variant lacks effective target evidence")
        effective_airbox_hmax = effective_airbox.get("hmax")
        if not isinstance(effective_airbox_hmax, (int, float)) or isinstance(
            effective_airbox_hmax, bool
        ) or not math.isclose(
            float(effective_airbox_hmax), expected_authored_airbox, rel_tol=1e-12, abs_tol=1e-30
        ):
            raise storage.StorageError("Child observed effective airbox hmax drifted")
        effective_owner = effective_per_object.get(EXPERIMENT_SCOPE["geometry"])
        if not isinstance(effective_owner, dict):
            raise storage.StorageError("Child observed variant lacks owner effective target")
        effective_owner_hmax = effective_owner.get("hmax")
        if not isinstance(effective_owner_hmax, (int, float)) or isinstance(
            effective_owner_hmax, bool
        ) or not math.isclose(float(effective_owner_hmax), 20e-9, rel_tol=1e-12, abs_tol=1e-30):
            raise storage.StorageError("Child observed owner effective hmax drifted")
        observation = item.get("observation")
        if not isinstance(observation, dict):
            raise storage.StorageError("Child observed variant lacks pre-subdivide observation")
        if observation.get("requested_controls") != controls:
            raise storage.StorageError("Child observation controls do not match variant controls")
        output = observation.get("public_realize_output")
        if not isinstance(output, dict) or not isinstance(
            output.get("shared_domain_build_report"), dict
        ):
            raise storage.StorageError("Child observation lacks public_realize output")
        if variant_name in STAGED_VARIANT_NAMES:
            staged = item.get("staged_phase_evidence")
            if not isinstance(staged, dict):
                raise storage.StorageError("Staged observation lacks phase evidence")
            if staged.get("contract") != "magnetic_first_two_phase_mesh_only_visible_then_empty":
                raise storage.StorageError("Staged phase contract drifted")
            for key in (
                "magnetic_body_before_conversion",
                "magnetic_body_after_conversion",
                "magnetic_body_after_air_phase",
            ):
                value = staged.get(key)
                if not isinstance(value, dict):
                    raise storage.StorageError(f"Staged phase lacks {key}")
                digest = value.get("body_xy_digest")
                if not isinstance(digest, str) or len(digest) != 64 or any(
                    character not in "0123456789abcdef" for character in digest
                ):
                    raise storage.StorageError(f"Staged phase {key} lacks a valid body XY digest")
            digests = [
                staged[key]["body_xy_digest"]
                for key in (
                    "magnetic_body_before_conversion",
                    "magnetic_body_after_conversion",
                    "magnetic_body_after_air_phase",
                )
            ]
            if len(set(digests)) != 1:
                raise storage.StorageError("Staged phase changed magnetic body XY nodes")
            for key in (
                "body_volume_element_count_before_conversion",
                "body_volume_element_count_after_conversion",
                "body_volume_element_count_after_air_phase",
            ):
                if not isinstance(staged.get(key), int) or staged[key] <= 0:
                    raise storage.StorageError(f"Staged phase has invalid {key}")
            if staged.get("air_volume_element_count_after_body_phase") != 0:
                raise storage.StorageError("Staged magnetic phase meshed air volumes")
            if not isinstance(staged.get("air_volume_element_count_after_air_phase"), int) or staged[
                "air_volume_element_count_after_air_phase"
            ] <= 0:
                raise storage.StorageError("Staged air phase lacks air volume elements")
            if staged.get("body_volume_element_count_after_conversion") != staged.get(
                "body_volume_element_count_after_air_phase"
            ):
                raise storage.StorageError("Staged air phase changed body element count")
            if staged.get("mesh_only_visible_first_phase") is not True or staged.get(
                "mesh_only_empty_second_phase"
            ) is not True:
                raise storage.StorageError("Staged MeshOnly phase contract drifted")
            if staged.get("visibility_restored") is not True or staged.get(
                "options_restored"
            ) is not True:
                raise storage.StorageError("Staged Gmsh state was not restored")
            anchors = staged.get("source_ast_anchors")
            if anchors != {anchor: 1 for anchor in _STAGED_SOURCE_ANCHORS}:
                raise storage.StorageError("Staged source anchor evidence drifted")
            component_volume_tags = staged.get("component_volume_tags")
            if not isinstance(component_volume_tags, dict):
                raise storage.StorageError("Staged component volume tags are missing")
            body_tags = staged.get("body_volume_tags")
            scoped_tags = component_volume_tags.get(EXPERIMENT_SCOPE["geometry"])
            if not isinstance(body_tags, list) or not isinstance(scoped_tags, list):
                raise storage.StorageError("Staged component volume tags are malformed")
            if {int(value) for value in body_tags} != {int(value) for value in scoped_tags}:
                raise storage.StorageError("Staged component volume tags drifted")
            for key in ("size_field_count_preserved", "lower_bound_field_count_preserved"):
                if not isinstance(staged.get(key), int) or staged[key] < 0:
                    raise storage.StorageError(f"Staged field preservation evidence lacks {key}")


def _parent_run(repo: Path) -> int:
    if os.name != "nt":
        raise storage.StorageError("Owner/air diagnostic requires the approved native Windows route")
    layout = storage.resolve_layout(repo, DIAGNOSTIC_PROFILE)
    native_layout = storage.resolve_layout(repo, NATIVE_PROFILE)
    storage.initialize(layout)
    interpreter = exact_diagnostics._managed_interpreter(native_layout)
    script_path = Path(__file__).resolve()
    storage.validate_path(script_path, repo, "owner/air diagnostic driver")
    with storage.build_lock(layout):
        run_root = storage.validate_path(
            Path(layout["runs_root"]) / DIAGNOSTIC_PROFILE / uuid.uuid4().hex,
            layout["runs_root"],
            "owner/air diagnostic run root",
        )
        run_root.mkdir(parents=True, exist_ok=False)
        temp_root = run_root / "tmp"
        temp_root.mkdir()
        receipt_path = run_root / "receipt.json"
        log_path = run_root / "diagnostic.log"
        source_before = _source_fingerprints(repo)
        interpreter_before = _sha256_file(interpreter)
        head = storage.git(repo, "rev-parse", "HEAD")
        receipt: dict[str, object] = {
            "schema": RECEIPT_SCHEMA,
            "state": "running",
            "profile": DIAGNOSTIC_PROFILE,
            "interpreter_profile": NATIVE_PROFILE,
            "repo_root": str(repo),
            "worktree_id": layout["worktree_id"],
            "head": head,
            "suite": SUITE_NAME,
            "source_base_reference": EXPERIMENT_SOURCE_BASE,
            "mesher_module": MESHER_MODULE,
            "mesher_function": MESHER_FUNCTION,
            "expected_variants": list(VARIANT_NAMES),
            "prepared_variants": list(PREPARED_VARIANT_NAMES),
            "variant_contract": (
                "reference_30_baseline_50_fixed_levels_fixed_fields_clone_30_clone_50_repeat_30_repeat_50_air_field_only_30_owner_ceiling_only_30_staged_magnetic_first_30_staged_magnetic_first_50_body_first_cad_30_body_first_cad_50"
            ),
            "scope": EXPERIMENT_SCOPE,
            "source_fingerprints_before": source_before,
            "interpreter": str(interpreter),
            "interpreter_sha256_before": interpreter_before,
            "qualification": "not_assessed",
            "unit_tests": "none_interpreted_mesh_observation_only",
            "started_at": _timestamp(),
            "run_root": str(run_root),
            "log": str(log_path),
            "receipt": str(receipt_path),
            "process": {
                "pid": None,
                "spawned": False,
                "waited": False,
                "timed_out": False,
                "terminate_requested": False,
                "kill_requested": False,
                "exit_code": None,
                "timeout_seconds": CHILD_TIMEOUT_SECONDS,
            },
        }
        storage.atomic_json(receipt_path, receipt)
        process: subprocess.Popen[bytes] | None = None
        driver_code = 2
        try:
            child_env = {**os.environ, **layout["env"]}
            pythonpath = [
                str(repo / "packages/fullmag-py/src"),
                str(repo / "packages/fullmag-py/tests"),
            ]
            existing_pythonpath = os.environ.get("PYTHONPATH")
            if existing_pythonpath:
                pythonpath.append(existing_pythonpath)
            child_env.update(
                FULLMAG_REPO_ROOT=str(repo),
                FULLMAG_STORAGE_PROFILE=DIAGNOSTIC_PROFILE,
                FULLMAG_OWNER_AIR_INTERFACE_ISOLATION_RUN_ROOT=str(run_root),
                PYTHONDONTWRITEBYTECODE="1",
                TMPDIR=str(temp_root), TEMP=str(temp_root), TMP=str(temp_root),
                PYTHONPATH=os.pathsep.join(pythonpath),
            )
            command = [
                str(interpreter), "-u", str(script_path), "--repo-root", str(repo),
                "--child", "--run-root", str(run_root),
            ]
            with log_path.open("x", encoding="utf-8") as log:
                process = subprocess.Popen(
                    command,
                    cwd=repo,
                    env=child_env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                process_record = receipt["process"]
                if not isinstance(process_record, dict):
                    raise storage.StorageError("Parent process record was corrupted")
                process_record.update(spawned=True, pid=process.pid)
                storage.atomic_json(receipt_path, receipt)
                try:
                    driver_code = int(process.wait(timeout=CHILD_TIMEOUT_SECONDS))
                    process_record.update(waited=True, exit_code=driver_code)
                except subprocess.TimeoutExpired:
                    process_record.update(timed_out=True, terminate_requested=True)
                    try:
                        process.terminate()
                    except OSError:
                        pass
                    try:
                        driver_code = int(process.wait(timeout=15))
                        process_record.update(waited=True, exit_code=driver_code)
                    except subprocess.TimeoutExpired:
                        process_record.update(kill_requested=True)
                        try:
                            process.kill()
                        except OSError:
                            pass
                        driver_code = int(process.wait())
                        process_record.update(waited=True, exit_code=driver_code)
                if process.returncode is None:
                    driver_code = int(process.wait())
                    process_record.update(waited=True, exit_code=driver_code)
                log.flush()
            summary_path = run_root / "child-summary.json"
            if summary_path.is_file():
                receipt["child_summary"] = json.loads(summary_path.read_text(encoding="utf-8"))
            else:
                receipt["child_summary_error"] = "Managed child did not publish child-summary.json"
            source_after = _source_fingerprints(repo)
            interpreter_after = _sha256_file(interpreter)
            head_after = storage.git(repo, "rev-parse", "HEAD")
            receipt.update(
                source_fingerprints_after=source_after,
                interpreter_sha256_after=interpreter_after,
                head_after=head_after,
                child_exit_code=driver_code,
            )
            try:
                _validate_child_summary(receipt.get("child_summary"), repo=repo, run_root=run_root)
                receipt["child_summary_contract_valid"] = True
            except BaseException as error:
                receipt["child_summary_contract_valid"] = False
                receipt["child_summary_validation_error"] = f"{type(error).__name__}: {error}"
            source_stable = source_before == source_after
            interpreter_stable = interpreter_before == interpreter_after
            head_stable = head == head_after
            receipt["source_changed_during_run"] = not source_stable
            receipt["interpreter_changed_during_run"] = not interpreter_stable
            receipt["head_changed_during_run"] = not head_stable
            receipt["state"] = (
                "completed"
                if driver_code == 0
                and source_stable
                and interpreter_stable
                and head_stable
                and receipt.get("child_summary_contract_valid") is True
                and isinstance(receipt["process"], dict)
                and receipt["process"].get("waited") is True
                and receipt["process"].get("timed_out") is False
                else "failed"
            )
            if receipt["state"] != "completed":
                receipt["error"] = "Managed child did not complete the closed owner/air experiment"
        except BaseException as error:
            if process is not None and process.poll() is None:
                process_record = receipt["process"]
                if isinstance(process_record, dict):
                    process_record["terminate_requested"] = True
                try:
                    process.terminate()
                except OSError:
                    pass
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    if isinstance(process_record, dict):
                        process_record["kill_requested"] = True
                    try:
                        process.kill()
                    except OSError:
                        pass
                    process.wait()
                if isinstance(process_record, dict):
                    process_record.update(waited=True, exit_code=process.returncode)
            receipt["state"] = "failed"
            receipt["error"] = f"{type(error).__name__}: {error}"
            with log_path.open("a", encoding="utf-8") as log:
                traceback.print_exc(file=log)
        finally:
            receipt["finished_at"] = _timestamp()
            receipt["log_sha256"] = _sha256_file(log_path) if log_path.is_file() else None
            storage.atomic_json(receipt_path, receipt)
            print(json.dumps({
                "receipt": str(receipt_path),
                "log": str(log_path),
                "state": receipt["state"],
                "driver_exit_code": driver_code,
            }, ensure_ascii=False))
        return 0 if receipt["state"] == "completed" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--run-root", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    repo = Path(args.repo_root).resolve()
    try:
        if args.child:
            if args.run_root is None:
                raise storage.StorageError("Child diagnostic requires --run-root")
            return _child_main(repo, args.run_root.resolve())
        return _parent_run(repo)
    except (storage.StorageError, OSError, ValueError) as error:
        print(f"[owner/air interface diagnostic] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
