#!/usr/bin/env python3
"""Run a managed, read-only Gmsh exact-layer diagnostic.

The driver executes one selected existing unittest under four in-memory
mesher variants: the checked-out baseline, a variant that adds one Gmsh layer
to every scoped extrusion, a magnetic-partitions-only variant that adds that
layer only when the scoped interval midpoint is inside the magnetic body, and
a magnetic-prism variant that uses the same scoped intervals with
``recombine=True``.  The magnetic variants keep outer air slabs
geometry-only and record that the ring hole remains part of
``source_entities`` for magnetic intervals.  No variant writes repository
sources.

This is an implementation diagnostic, not a production or scientific
qualification gate.  Test failures are recorded as observations; import,
provenance, storage, timeout, or source-integrity failures fail the driver
closed.  A skipped test is never reported as a successful variant.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import traceback
import unittest
import uuid

import fullmag_storage as storage


DIAGNOSTIC_PROFILE = "windows-exact-layer-mesh-diagnostics"
NATIVE_PROFILE = "windows-native-fdm-cpu-dev"
CHILD_SCHEMA = "fullmag.exact_layer_mesh_diagnostics.child.v1"
RECEIPT_SCHEMA = "fullmag.exact_layer_mesh_diagnostics.v1"
SUITE_TESTS = {
    "scoped-ring": (
        "RegionMeshPolicyTests."
        "test_scoped_exact_ring_lower_bound_uses_layer_route_and_report"
    ),
    "implicit-cap": (
        "RegionMeshPolicyTests."
        "test_exact_layer_implicit_airbox_cap_coarsens_far_air"
    ),
}
VARIANT_NAMES = (
    "baseline",
    "one_per_partition",
    "magnetic_partitions_only",
    "magnetic_prism_partitions",
)
CHILD_TIMEOUT_SECONDS = 15 * 60
MESHER_MODULE = "fullmag.meshing._gmsh_swept"
MESHER_FUNCTION = "_generate_coincident_ring_airbox_mesh"

_SCOPED_EXTRUSION = "\n".join(
    (
        "            if scoped_layer_partitioning:",
        "                extruded = gmsh.model.geo.extrude(",
        "                    source_entities,",
        "                    0.0,",
        "                    0.0,",
        "                    step,",
        "                )",
    )
)
_ONE_PER_PARTITION_EXTRUSION = "\n".join(
    (
        "            if scoped_layer_partitioning:",
        "                extruded = gmsh.model.geo.extrude(",
        "                    source_entities,",
        "                    0.0,",
        "                    0.0,",
        "                    step,",
        "                    numElements=[1],",
        "                    heights=[1.0],",
        "                )",
    )
)
_CURRENT_EXTRUSION_BRANCH = "\n".join(
    (
        "            if scoped_layer_partitioning:",
        "                extruded = gmsh.model.geo.extrude(",
        "                    source_entities,",
        "                    0.0,",
        "                    0.0,",
        "                    step,",
        "                )",
        "            else:",
        "                extruded = gmsh.model.geo.extrude(",
        "                    source_entities,",
        "                    0.0,",
        "                    0.0,",
        "                    step,",
        "                    numElements=[1],",
        "                    heights=[1.0],",
        "                    recombine=True,",
        "                )",
    )
)
_MAGNETIC_PARTITIONS_ONLY_EXTRUSION = "\n".join(
    (
        "            if scoped_layer_partitioning:",
        "                if body_bottom < 0.5 * (levels[level_index] + levels[level_index + 1]) < body_top:",
        "                    extruded = gmsh.model.geo.extrude(",
        "                        source_entities,",
        "                        0.0,",
        "                        0.0,",
        "                        step,",
        "                        numElements=[1],",
        "                        heights=[1.0],",
        "                    )",
        "                else:",
        "                    extruded = gmsh.model.geo.extrude(",
        "                        source_entities,",
        "                        0.0,",
        "                        0.0,",
        "                        step,",
        "                    )",
        "            else:",
        "                extruded = gmsh.model.geo.extrude(",
        "                    source_entities,",
        "                    0.0,",
        "                    0.0,",
        "                    step,",
        "                    numElements=[1],",
        "                    heights=[1.0],",
        "                    recombine=True,",
        "                )",
    )
)
_MAGNETIC_PRISM_PARTITIONS_EXTRUSION = "\n".join(
    (
        "            if scoped_layer_partitioning:",
        "                if body_bottom < 0.5 * (levels[level_index] + levels[level_index + 1]) < body_top:",
        "                    extruded = gmsh.model.geo.extrude(",
        "                        source_entities,",
        "                        0.0,",
        "                        0.0,",
        "                        step,",
        "                        numElements=[1],",
        "                        heights=[1.0],",
        "                        recombine=True,",
        "                    )",
        "                else:",
        "                    extruded = gmsh.model.geo.extrude(",
        "                        source_entities,",
        "                        0.0,",
        "                        0.0,",
        "                        step,",
        "                    )",
        "            else:",
        "                extruded = gmsh.model.geo.extrude(",
        "                    source_entities,",
        "                    0.0,",
        "                    0.0,",
        "                    step,",
        "                    numElements=[1],",
        "                    heights=[1.0],",
        "                    recombine=True,",
        "                )",
    )
)


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    if not path.is_file() or storage.is_link(path):
        raise storage.StorageError(f"Expected a regular non-link file: {path}")
    return _sha256_bytes(path.read_bytes())


def _tree_digest(root: Path, *, repo: Path) -> str:
    root = root.resolve()
    if not root.is_dir() or storage.is_link(root):
        raise storage.StorageError(f"Expected a regular source directory: {root}")
    digest = hashlib.sha256()
    ignored = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
    files: list[Path] = []
    for directory, child_dirs, names in os.walk(root):
        checked_dirs: list[str] = []
        for name in child_dirs:
            path = Path(directory) / name
            if path.is_symlink() or storage.is_link(path):
                raise storage.StorageError(f"Source fingerprint encountered a link: {path}")
            if name not in ignored:
                checked_dirs.append(name)
        child_dirs[:] = checked_dirs
        for name in names:
            path = Path(directory) / name
            if path.is_symlink() or storage.is_link(path):
                raise storage.StorageError(f"Source fingerprint encountered a link: {path}")
            if path.is_file():
                files.append(path)
    for path in sorted(files):
        digest.update(path.relative_to(repo).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(_sha256_file(path).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def _source_fingerprints(repo: Path) -> dict[str, str]:
    package_root = repo / "packages/fullmag-py/src/fullmag"
    test_fixture = repo / "packages/fullmag-py/tests/test_meshing.py"
    production_fixture = repo / "packages/fullmag-py/tests/meshing_production_fixtures.py"
    verifier = Path(__file__).resolve()
    return {
        "python_package": _tree_digest(package_root, repo=repo),
        "test_fixture": _sha256_file(test_fixture),
        "meshing_production_fixtures": _sha256_file(production_fixture),
        "diagnostic_driver": _sha256_file(verifier),
    }


def _module_origin(module: object) -> str | None:
    value = getattr(module, "__file__", None)
    return str(Path(value).resolve()) if value else None


def _assert_origin(name: str, module: object, expected_root: Path, expected_file: Path | None = None) -> str:
    origin = _module_origin(module)
    if origin is None:
        raise storage.StorageError(f"Module {name} has no file origin")
    path = Path(origin)
    if expected_file is not None:
        if path != expected_file.resolve():
            raise storage.StorageError(
                f"Module {name} resolved outside the selected source: {path}"
            )
    elif not storage.inside(path, expected_root.resolve()):
        raise storage.StorageError(
            f"Module {name} resolved outside the selected source root: {path}"
        )
    return origin


def _load_test_module(test_path: Path) -> object:
    spec = importlib.util.spec_from_file_location(
        "fullmag_exact_layer_diagnostic_test_meshing", test_path
    )
    if spec is None or spec.loader is None:
        raise storage.StorageError(f"Cannot load selected unittest module: {test_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write_variant_source(run_root: Path, variant: str, source: str) -> tuple[Path, str]:
    variants_root = storage.validate_path(
        run_root / "variants", run_root, "exact-layer variant source root"
    )
    if variants_root.exists() and storage.is_link(variants_root):
        raise storage.StorageError(f"Variant source root is a link: {variants_root}")
    variants_root.mkdir(parents=True, exist_ok=True)
    candidate_path = storage.validate_path(
        variants_root / f"{variant}.py", variants_root, "exact-layer variant source"
    )
    if candidate_path.exists() or storage.is_link(candidate_path):
        raise storage.StorageError(f"Variant source path already exists: {candidate_path}")
    payload = source.encode("utf-8")
    candidate_path.write_bytes(payload)
    return candidate_path, _sha256_bytes(payload)


def _prepare_variant(
    function: object,
    mesher_module: object,
    *,
    variant: str,
    run_root: Path,
) -> tuple[object, dict[str, object]]:
    source = textwrap.dedent(inspect.getsource(function)).rstrip()
    if variant == "one_per_partition":
        anchor = _SCOPED_EXTRUSION
        replacement = _ONE_PER_PARTITION_EXTRUSION
        contract = "scoped_geo_extrude_numElements_1_heights_1_without_recombine"
        if source.count(anchor) != 1:
            raise storage.StorageError(
                "Scoped extrusion replacement anchor must occur exactly once"
            )
    elif variant in {"magnetic_partitions_only", "magnetic_prism_partitions"}:
        anchor = _CURRENT_EXTRUSION_BRANCH
        if variant == "magnetic_partitions_only":
            replacement = _MAGNETIC_PARTITIONS_ONLY_EXTRUSION
            contract = (
                "numElements_1_heights_1_only_scoped_body_partitions;"
                "scoped_air_geometry_only;ring_hole_follows_body_interval"
            )
        else:
            replacement = _MAGNETIC_PRISM_PARTITIONS_EXTRUSION
            contract = (
                "numElements_1_heights_1_recombine_only_scoped_body_partitions;"
                "scoped_air_geometry_only;ring_hole_follows_body_interval"
            )
        if source.count(anchor) != 1:
            raise storage.StorageError(
                "Complete extrusion branch replacement anchor must occur exactly once"
            )
    else:
        raise storage.StorageError(f"Unsupported in-memory variant: {variant}")
    if source.count(anchor) != 1:
        raise storage.StorageError(
            "Scoped extrusion replacement anchor must occur exactly once"
        )
    patched_source = source.replace(anchor, replacement)
    if patched_source.count(replacement) != 1:
        raise storage.StorageError(
            "In-memory extrusion replacement must occur exactly once"
        )
    if (
        source.replace(anchor, "<scoped-extrusion>")
        != patched_source.replace(replacement, "<scoped-extrusion>")
    ):
        raise storage.StorageError(
            "In-memory variant changed source outside the scoped extrusion anchor"
        )
    candidate_path, candidate_sha256 = _write_variant_source(
        run_root, variant, patched_source
    )
    tree = ast.parse(patched_source, filename=str(candidate_path))
    definitions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    if len(definitions) != 1 or definitions[0].name != MESHER_FUNCTION:
        raise storage.StorageError("In-memory mesher variant must contain exactly one target function")
    if variant == "one_per_partition":
        scoped_block = patched_source.split("if scoped_layer_partitioning:", 1)[1].split(
            "            else:", 1
        )[0]
        if "recombine" in scoped_block or "numElements=[1]" not in scoped_block:
            raise storage.StorageError(
                "Variant does not have the exact one-per-partition scoped contract"
            )
    elif variant == "magnetic_partitions_only":
        if (
            "body_bottom < 0.5 * (levels[level_index] + levels[level_index + 1]) < body_top"
            not in replacement
            or "numElements=[1]" not in replacement
            or replacement.count("recombine=True") != 1
        ):
            raise storage.StorageError(
                "Variant does not preserve magnetic-only and unscoped extrusion branches"
            )
    else:
        scoped_body_block = replacement.split(
            "if body_bottom < 0.5 * (levels[level_index] + levels[level_index + 1]) < body_top:",
            1,
        )[1].split("                else:", 1)[0]
        if (
            "body_bottom < 0.5 * (levels[level_index] + levels[level_index + 1]) < body_top"
            not in replacement
            or "numElements=[1]" not in scoped_body_block
            or "recombine=True" not in scoped_body_block
            or replacement.count("recombine=True") != 2
        ):
            raise storage.StorageError(
                "Variant does not preserve magnetic prism and unscoped recombined branches"
            )

    namespace: dict[str, object] = {}
    filename = str(candidate_path)
    exec(compile(tree, filename, "exec"), mesher_module.__dict__, namespace)
    patched = namespace.get(MESHER_FUNCTION)
    if patched is None or not callable(patched):
        raise storage.StorageError("In-memory mesher variant did not define the target function")
    if inspect.signature(function) != inspect.signature(patched):
        raise storage.StorageError("In-memory mesher variant changed the target signature")
    return patched, {
        "replacement_count": 1,
        "variant": variant,
        "base_function_sha256": _sha256_bytes(source.encode("utf-8")),
        "variant_function_sha256": _sha256_bytes(patched_source.encode("utf-8")),
        "base_function_signature": str(inspect.signature(function)),
        "variant_function_signature": str(inspect.signature(patched)),
        "variant_contract": contract,
        "owner_and_air_field_source_unchanged": True,
        "variant_source_path": str(candidate_path),
        "variant_source_sha256": candidate_sha256,
        "compiled_filename": str(patched.__code__.co_filename),
    }


def _prepare_baseline_metadata(function: object, run_root: Path) -> dict[str, object]:
    source = textwrap.dedent(inspect.getsource(function)).rstrip()
    candidate_path, candidate_sha256 = _write_variant_source(
        run_root, "baseline", source
    )
    tree = ast.parse(source, filename=str(candidate_path))
    definitions = [
        node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if len(definitions) != 1 or definitions[0].name != MESHER_FUNCTION:
        raise storage.StorageError("Baseline candidate source must contain exactly one target function")
    compile(tree, str(candidate_path), "exec")
    function_sha256 = _sha256_bytes(source.encode("utf-8"))
    return {
        "replacement_count": 0,
        "variant": "baseline",
        "base_function_sha256": function_sha256,
        "variant_function_sha256": function_sha256,
        "base_function_signature": str(inspect.signature(function)),
        "variant_function_signature": str(inspect.signature(function)),
        "variant_contract": "checked_out_mesher_unchanged",
        "owner_and_air_field_source_unchanged": True,
        "variant_source_path": str(candidate_path),
        "variant_source_sha256": candidate_sha256,
        "compiled_filename": str(candidate_path),
    }


def _run_selected_test(
    test_module: object,
    *,
    variant: str,
    selected_test: str,
) -> dict[str, object]:
    suite = unittest.TestSuite()
    class_name, method_name = selected_test.split(".", 1)
    test_class = getattr(test_module, class_name, None)
    if test_class is None:
        raise storage.StorageError(f"Selected unittest class is unavailable: {class_name}")
    suite.addTest(test_class(method_name))
    runner = unittest.TextTestRunner(stream=sys.stderr, verbosity=2, failfast=False)
    result = runner.run(suite)

    def names(entries: list[tuple[object, str]]) -> list[str]:
        return [str(entry[0].id()) for entry in entries]

    skipped = [str(entry[0].id()) for entry in result.skipped]
    unexpected_successes = [str(entry.id()) for entry in result.unexpectedSuccesses]
    tests_run = int(result.testsRun)
    skipped_count = len(skipped)
    success = bool(
        result.wasSuccessful()
        and tests_run == 1
        and skipped_count == 0
        and not unexpected_successes
    )
    return {
        "variant": variant,
        "selected_test": selected_test,
        "tests_run": tests_run,
        "failures": names(result.failures),
        "errors": names(result.errors),
        "skips": skipped,
        "skipped_count": skipped_count,
        "unexpected_successes": unexpected_successes,
        "success": success,
        "unittest_exit_code": 0 if success else 1,
    }


def _periodic_certificate_observation(
    boundary_faces: object,
    boundary_markers: object,
    periodic_boundary_pairs: object,
    periodic_node_pairs: object,
    *,
    variant: str | None,
) -> dict[str, object]:
    def rows(value: object) -> list[object]:
        tolist = getattr(value, "tolist", None)
        converted = tolist() if callable(tolist) else value
        return list(converted) if isinstance(converted, (list, tuple)) else []

    faces = [
        tuple(int(node) for node in row)
        for row in rows(boundary_faces)
        if isinstance(row, (list, tuple))
    ]
    markers = [int(marker) for marker in rows(boundary_markers)]
    raw_boundary_pairs = [
        item for item in rows(periodic_boundary_pairs) if isinstance(item, dict)
    ]
    raw_node_pairs = [item for item in rows(periodic_node_pairs) if isinstance(item, dict)]
    maps: dict[str, dict[int, int]] = {}
    for item in raw_node_pairs:
        pair_id = str(item.get("pair_id", "")).strip()
        if not pair_id:
            continue
        maps.setdefault(pair_id, {})[int(item.get("node_a", -1))] = int(
            item.get("node_b", -1)
        )

    pair_observations: list[dict[str, object]] = []
    for item in raw_boundary_pairs:
        pair_id = str(item.get("pair_id", "")).strip()
        marker_a = int(item.get("marker_a", -1))
        marker_b = int(item.get("marker_b", -1))
        source_indices = [
            index for index, marker in enumerate(markers) if marker == marker_a
        ]
        destination_indices = [
            index for index, marker in enumerate(markers) if marker == marker_b
        ]
        destination_by_vertices: dict[frozenset[int], int] = {}
        for index in destination_indices:
            if index < len(faces):
                destination_by_vertices[frozenset(faces[index])] = index
        mapping = maps.get(pair_id, {})
        mapped_faces = 0
        missing_node_faces = 0
        matched_destination_faces = 0
        for index in source_indices:
            if index >= len(faces):
                continue
            mapped = [mapping.get(node, -1) for node in faces[index]]
            if -1 in mapped:
                missing_node_faces += 1
                continue
            mapped_faces += 1
            if frozenset(mapped) in destination_by_vertices:
                matched_destination_faces += 1
        pair_observations.append(
            {
                "pair_id": pair_id,
                "marker_a": marker_a,
                "marker_b": marker_b,
                "source_face_count": len(source_indices),
                "destination_face_count": len(destination_indices),
                "destination_unique_face_count": len(destination_by_vertices),
                "node_pair_count": len(mapping),
                "mapped_source_face_count": mapped_faces,
                "missing_node_face_count": missing_node_faces,
                "matched_destination_face_count": matched_destination_faces,
            }
        )
    return {
        "variant": variant,
        "boundary_face_count": len(faces),
        "boundary_marker_count": len(markers),
        "periodic_boundary_pair_count": len(raw_boundary_pairs),
        "periodic_node_pair_count": len(raw_node_pairs),
        "pairs": pair_observations,
    }


def _gmsh_details(gmsh_module: object) -> dict[str, str]:
    origin = _module_origin(gmsh_module)
    if not origin:
        raise storage.StorageError("Gmsh module has no file origin")
    origin_path = Path(origin)
    if not origin_path.is_file() or storage.is_link(origin_path):
        raise storage.StorageError(f"Gmsh module origin is not a regular file: {origin_path}")
    version = getattr(gmsh_module, "__version__", None)
    if version is None:
        version_getter = getattr(gmsh_module, "version", None)
        if callable(version_getter):
            version = version_getter()
    if version is None or not str(version).strip():
        raise storage.StorageError("Gmsh module did not expose a version")
    return {"origin": origin, "version": str(version)}


def _child_main(repo: Path, run_root: Path, suite_name: str) -> int:
    if suite_name not in SUITE_TESTS:
        raise storage.StorageError(f"Unsupported diagnostic suite: {suite_name}")
    selected_test = SUITE_TESTS[suite_name]
    source_root = repo / "packages/fullmag-py/src"
    tests_root = repo / "packages/fullmag-py/tests"
    test_path = tests_root / "test_meshing.py"
    diagnostic_layout = storage.resolve_layout(repo, DIAGNOSTIC_PROFILE)
    run_root = storage.validate_path(
        run_root, diagnostic_layout["runs_root"], "exact-layer diagnostic child root"
    )
    sys.path[:0] = [str(source_root), str(tests_root)]
    summary_path = run_root / "child-summary.json"
    summary: dict[str, object] = {
        "schema": CHILD_SCHEMA,
        "state": "running",
        "suite": suite_name,
        "selected_test": selected_test,
        "expected_variants": list(VARIANT_NAMES),
        "source_roots": {"package": str(source_root), "tests": str(tests_root)},
        "source_fingerprints_before": None,
        "source_fingerprints_after": None,
        "module_origins": {},
        "gmsh": None,
        "mesher_variants": [],
        "variants": [],
        "periodic_observations": [],
        "qualification": "not_assessed",
    }
    try:
        summary["source_fingerprints_before"] = _source_fingerprints(repo)
        import fullmag
        import fullmag.meshing._gmsh_swept as gmsh_swept
        import gmsh

        summary["gmsh"] = _gmsh_details(gmsh)
        test_module = _load_test_module(test_path)
        summary["module_origins"] = {
            "fullmag": _assert_origin("fullmag", fullmag, source_root / "fullmag"),
            "fullmag.meshing._gmsh_swept": _assert_origin(
                MESHER_MODULE, gmsh_swept, source_root / "fullmag"
            ),
            "test_meshing": _assert_origin(
                "test_meshing", test_module, tests_root, expected_file=test_path
            ),
            "gmsh": str(summary["gmsh"]["origin"]),
        }
        production_fixtures = sys.modules.get("meshing_production_fixtures")
        if production_fixtures is None:
            raise storage.StorageError("Selected unittest did not load meshing_production_fixtures")
        summary["module_origins"]["meshing_production_fixtures"] = _assert_origin(
            "meshing_production_fixtures",
            production_fixtures,
            tests_root,
            expected_file=tests_root / "meshing_production_fixtures.py",
        )

        original = getattr(gmsh_swept, MESHER_FUNCTION)
        if not callable(original):
            raise storage.StorageError(f"Mesher target is not callable: {MESHER_FUNCTION}")
        baseline_metadata = _prepare_baseline_metadata(original, run_root)
        one_per_partition, one_per_metadata = _prepare_variant(
            original, gmsh_swept, variant="one_per_partition", run_root=run_root
        )
        magnetic_partitions_only, magnetic_metadata = _prepare_variant(
            original, gmsh_swept, variant="magnetic_partitions_only", run_root=run_root
        )
        magnetic_prism_partitions, magnetic_prism_metadata = _prepare_variant(
            original, gmsh_swept, variant="magnetic_prism_partitions", run_root=run_root
        )
        magnetic_metadata.update(
            ring_hole_source_entities_in_magnetic_partitions=True,
            air_slabs_geometry_only=True,
            qualification_note=(
                "Diagnostic only: ring hole is included in source_entities for a "
                "magnetic midpoint interval; no production qualification is implied."
            ),
        )
        magnetic_prism_metadata.update(
            ring_hole_source_entities_in_magnetic_partitions=True,
            air_slabs_geometry_only=True,
            qualification_note=(
                "Diagnostic only: ring hole is included in source_entities for a "
                "magnetic midpoint interval; no production qualification is implied."
            ),
        )
        summary["mesher_variants"] = [
            baseline_metadata,
            one_per_metadata,
            magnetic_metadata,
            magnetic_prism_metadata,
        ]
        summary["module_origins"][MESHER_MODULE] = _module_origin(gmsh_swept)

        original_certifier = getattr(gmsh_swept, "certify_extracted_periodic_mesh")
        active_variant: dict[str, str | None] = {"name": None}

        def observed_certifier(
            nodes: object,
            boundary_faces: object,
            boundary_markers: object,
            periodic_boundary_pairs: object,
            periodic_node_pairs: object,
        ) -> object:
            observation = _periodic_certificate_observation(
                boundary_faces,
                boundary_markers,
                periodic_boundary_pairs,
                periodic_node_pairs,
                variant=active_variant["name"],
            )
            try:
                certificate = original_certifier(
                    nodes,
                    boundary_faces,
                    boundary_markers,
                    periodic_boundary_pairs,
                    periodic_node_pairs,
                )
            except BaseException as error:
                observation["status"] = "rejected"
                observation["error"] = f"{type(error).__name__}: {error}"
                summary["periodic_observations"].append(observation)
                raise
            observation["status"] = "accepted"
            summary["periodic_observations"].append(observation)
            return certificate

        try:
            setattr(gmsh_swept, "certify_extracted_periodic_mesh", observed_certifier)
            setattr(gmsh_swept, MESHER_FUNCTION, original)
            active_variant["name"] = "baseline"
            observation_start = len(summary["periodic_observations"])
            baseline_result = _run_selected_test(
                test_module, variant="baseline", selected_test=selected_test
            )
            baseline_result["periodic_observation_count"] = (
                len(summary["periodic_observations"]) - observation_start
            )
            summary["variants"].append(
                baseline_result
            )
            setattr(gmsh_swept, MESHER_FUNCTION, one_per_partition)
            active_variant["name"] = "one_per_partition"
            observation_start = len(summary["periodic_observations"])
            one_per_result = _run_selected_test(
                test_module,
                variant="one_per_partition",
                selected_test=selected_test,
            )
            one_per_result["periodic_observation_count"] = (
                len(summary["periodic_observations"]) - observation_start
            )
            summary["variants"].append(
                one_per_result
            )
            setattr(gmsh_swept, MESHER_FUNCTION, magnetic_partitions_only)
            active_variant["name"] = "magnetic_partitions_only"
            observation_start = len(summary["periodic_observations"])
            magnetic_result = _run_selected_test(
                test_module,
                variant="magnetic_partitions_only",
                selected_test=selected_test,
            )
            magnetic_result["periodic_observation_count"] = (
                len(summary["periodic_observations"]) - observation_start
            )
            summary["variants"].append(magnetic_result)
            setattr(gmsh_swept, MESHER_FUNCTION, magnetic_prism_partitions)
            active_variant["name"] = "magnetic_prism_partitions"
            observation_start = len(summary["periodic_observations"])
            magnetic_prism_result = _run_selected_test(
                test_module,
                variant="magnetic_prism_partitions",
                selected_test=selected_test,
            )
            magnetic_prism_result["periodic_observation_count"] = (
                len(summary["periodic_observations"]) - observation_start
            )
            summary["variants"].append(magnetic_prism_result)
        finally:
            setattr(gmsh_swept, MESHER_FUNCTION, original)
            setattr(gmsh_swept, "certify_extracted_periodic_mesh", original_certifier)
            if getattr(gmsh_swept, MESHER_FUNCTION) is not original:
                raise storage.StorageError(
                    "Mesher function was not restored after the in-memory variants"
                )
            if getattr(gmsh_swept, "certify_extracted_periodic_mesh") is not original_certifier:
                raise storage.StorageError(
                    "Periodic certificate observer was not restored after the variants"
                )

        core_module = sys.modules.get("fullmag._core")
        if core_module is not None:
            summary["module_origins"]["fullmag._core"] = _assert_origin(
                "fullmag._core", core_module, source_root / "fullmag"
            )

        summary["source_fingerprints_after"] = _source_fingerprints(repo)
        if summary["source_fingerprints_before"] != summary["source_fingerprints_after"]:
            raise storage.StorageError("Source fingerprints changed during the diagnostic")
        if [item.get("variant") for item in summary["variants"]] != list(VARIANT_NAMES):
            raise storage.StorageError("Diagnostic did not record exactly the expected variants")
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
        try:
            if summary["source_fingerprints_after"] is None:
                summary["source_fingerprints_after"] = _source_fingerprints(repo)
            storage.atomic_json(summary_path, summary)
        except BaseException:
            traceback.print_exc(file=sys.stderr)


def _managed_interpreter(native_layout: dict[str, object]) -> Path:
    build_root = Path(str(native_layout["build_root"]))
    interpreter = storage.validate_path(
        build_root / "python" / "fullmag" / "Scripts" / "python.exe",
        build_root,
        "managed exact-layer diagnostic interpreter",
    )
    if storage.is_link(interpreter) or not interpreter.is_file():
        raise storage.StorageError(
            f"Managed native interpreter is unavailable: {interpreter}"
        )
    return interpreter


def _validate_child_summary(
    summary: object,
    *,
    repo: Path,
    run_root: Path,
    suite_name: str,
    selected_test: str,
) -> dict[str, object]:
    if not isinstance(summary, dict):
        raise storage.StorageError("Child summary is not a JSON object")
    if summary.get("schema") != CHILD_SCHEMA:
        raise storage.StorageError("Child summary schema is not the diagnostic schema")
    if summary.get("state") != "completed":
        raise storage.StorageError("Child summary is not terminal completed")
    if summary.get("suite") != suite_name:
        raise storage.StorageError("Child summary suite does not match the parent request")
    if summary.get("selected_test") != selected_test:
        raise storage.StorageError("Child summary selected test does not match the parent request")
    if summary.get("expected_variants") != list(VARIANT_NAMES):
        raise storage.StorageError("Child summary expected variant contract is incomplete")
    if summary.get("qualification") != "not_assessed":
        raise storage.StorageError("Child summary changed the qualification boundary")

    source_roots = summary.get("source_roots")
    expected_source_roots = {
        "package": str((repo / "packages/fullmag-py/src").resolve()),
        "tests": str((repo / "packages/fullmag-py/tests").resolve()),
    }
    if source_roots != expected_source_roots:
        raise storage.StorageError("Child summary source roots do not match the selected repository")

    expected_fingerprint_keys = {
        "python_package",
        "test_fixture",
        "meshing_production_fixtures",
        "diagnostic_driver",
    }
    for field in ("source_fingerprints_before", "source_fingerprints_after"):
        fingerprints = summary.get(field)
        if not isinstance(fingerprints, dict) or set(fingerprints) != expected_fingerprint_keys:
            raise storage.StorageError(f"Child summary {field} is incomplete")
        if any(
            not isinstance(value, str) or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
            for value in fingerprints.values()
        ):
            raise storage.StorageError(f"Child summary {field} contains an invalid digest")
    if summary["source_fingerprints_before"] != summary["source_fingerprints_after"]:
        raise storage.StorageError("Child summary reports source mutation during the diagnostic")

    module_origins = summary.get("module_origins")
    if not isinstance(module_origins, dict):
        raise storage.StorageError("Child summary module origins are missing")
    required_origins = {
        "fullmag",
        "fullmag.meshing._gmsh_swept",
        "test_meshing",
        "meshing_production_fixtures",
        "gmsh",
    }
    if not required_origins.issubset(module_origins):
        raise storage.StorageError("Child summary lacks a required module origin")
    if any(not isinstance(module_origins[name], str) or not module_origins[name] for name in required_origins):
        raise storage.StorageError("Child summary contains an empty required module origin")
    gmsh_details = summary.get("gmsh")
    if (
        not isinstance(gmsh_details, dict)
        or not isinstance(gmsh_details.get("origin"), str)
        or not gmsh_details.get("origin")
        or not isinstance(gmsh_details.get("version"), str)
        or not gmsh_details.get("version")
    ):
        raise storage.StorageError("Child summary lacks the actual Gmsh version and origin")

    mesher_variants = summary.get("mesher_variants")
    if not isinstance(mesher_variants, list) or [
        item.get("variant") if isinstance(item, dict) else None for item in mesher_variants
    ] != list(VARIANT_NAMES):
        raise storage.StorageError("Child summary mesher variant metadata is incomplete")
    if any(
        not isinstance(item, dict)
        or item.get("owner_and_air_field_source_unchanged") is not True
        for item in mesher_variants
    ):
        raise storage.StorageError("Child summary does not prove source ownership preservation")
    variant_source_root = storage.validate_path(
        run_root / "variants", run_root, "exact-layer variant source root"
    )
    for item in mesher_variants:
        source_path_value = item.get("variant_source_path")
        source_sha256 = item.get("variant_source_sha256")
        compiled_filename = item.get("compiled_filename")
        if (
            not isinstance(source_path_value, str)
            or not isinstance(source_sha256, str)
            or len(source_sha256) != 64
            or any(character not in "0123456789abcdef" for character in source_sha256)
            or not isinstance(compiled_filename, str)
        ):
            raise storage.StorageError("Child summary variant source pin is incomplete")
        source_path = storage.validate_path(
            Path(source_path_value), variant_source_root, "exact-layer variant source"
        )
        if source_path.parent != variant_source_root or not source_path.is_file():
            raise storage.StorageError("Child summary variant source is not a regular file in run root")
        if _sha256_file(source_path) != source_sha256:
            raise storage.StorageError("Child summary variant source SHA does not match the file")
        if compiled_filename != source_path_value:
            raise storage.StorageError("Child summary compiled filename is not pinned to candidate source")
    for magnetic_metadata in mesher_variants[2:]:
        if (
            magnetic_metadata.get("ring_hole_source_entities_in_magnetic_partitions") is not True
            or magnetic_metadata.get("air_slabs_geometry_only") is not True
            or not isinstance(magnetic_metadata.get("qualification_note"), str)
            or "no production qualification" not in magnetic_metadata["qualification_note"]
        ):
            raise storage.StorageError("Child summary magnetic partition contract is incomplete")

    variants = summary.get("variants")
    if not isinstance(variants, list) or [
        item.get("variant") if isinstance(item, dict) else None for item in variants
    ] != list(VARIANT_NAMES):
        raise storage.StorageError("Child summary did not record exactly the four variants")
    for item in variants:
        if not isinstance(item, dict):
            raise storage.StorageError("Child variant result is not an object")
        if item.get("selected_test") != selected_test:
            raise storage.StorageError("Child variant selected test drifted")
        if item.get("tests_run") != 1:
            raise storage.StorageError("Child variant did not execute exactly one test")
        if item.get("skipped_count") != 0 or item.get("skips") != []:
            raise storage.StorageError("A skipped test cannot qualify as a diagnostic PASS")
        if not isinstance(item.get("success"), bool):
            raise storage.StorageError("Child variant success field is not boolean")
        if not isinstance(item.get("periodic_observation_count"), int) or item[
            "periodic_observation_count"
        ] < 0:
            raise storage.StorageError("Child variant periodic observer count is invalid")

    periodic_observations = summary.get("periodic_observations")
    if not isinstance(periodic_observations, list):
        raise storage.StorageError("Child periodic observer output is missing")
    for observation in periodic_observations:
        if not isinstance(observation, dict):
            raise storage.StorageError("Child periodic observer entry is not an object")
        if observation.get("variant") not in VARIANT_NAMES:
            raise storage.StorageError("Child periodic observer variant is invalid")
        if observation.get("status") not in {"accepted", "rejected"}:
            raise storage.StorageError("Child periodic observer status is invalid")
        if observation.get("status") == "rejected" and not isinstance(
            observation.get("error"), str
        ):
            raise storage.StorageError("Rejected periodic observer entry lacks its error")
        if not isinstance(observation.get("pairs"), list):
            raise storage.StorageError("Child periodic observer pair details are missing")
        for pair in observation["pairs"]:
            if not isinstance(pair, dict):
                raise storage.StorageError("Child periodic observer pair is not an object")
            for field in (
                "source_face_count",
                "destination_face_count",
                "destination_unique_face_count",
                "node_pair_count",
                "mapped_source_face_count",
                "missing_node_face_count",
                "matched_destination_face_count",
            ):
                if not isinstance(pair.get(field), int) or pair[field] < 0:
                    raise storage.StorageError(
                        f"Child periodic observer count is invalid: {field}"
                    )
    if sum(item["periodic_observation_count"] for item in variants) != len(
        periodic_observations
    ):
        raise storage.StorageError("Child periodic observer counts do not reconcile")

    return summary


def _parent_run(repo: Path, suite_name: str) -> int:
    if os.name != "nt":
        raise storage.StorageError("Exact-layer diagnostic requires the approved native Windows interpreter")
    if suite_name not in SUITE_TESTS:
        raise storage.StorageError(f"Unsupported diagnostic suite: {suite_name}")
    selected_test = SUITE_TESTS[suite_name]
    layout = storage.resolve_layout(repo, DIAGNOSTIC_PROFILE)
    native_layout = storage.resolve_layout(repo, NATIVE_PROFILE)
    storage.initialize(layout)
    interpreter = _managed_interpreter(native_layout)
    script_path = Path(__file__).resolve()
    storage.validate_path(script_path, repo, "diagnostic driver")

    with storage.build_lock(layout):
        run_root = storage.validate_path(
            Path(layout["runs_root"]) / DIAGNOSTIC_PROFILE / uuid.uuid4().hex,
            layout["runs_root"],
            "exact-layer diagnostic run root",
        )
        run_root.mkdir(parents=True, exist_ok=False)
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
            "suite": suite_name,
            "selected_test": selected_test,
            "expected_variants": list(VARIANT_NAMES),
            "variant_contract": (
                "baseline_and_in_memory_one_per_partition_magnetic_partitions_only_"
                "and_magnetic_prism_partitions"
            ),
            "source_fingerprints_before": source_before,
            "interpreter": str(interpreter),
            "interpreter_sha256_before": interpreter_before,
            "qualification": "not_assessed",
            "unit_tests": "interpreted_unittest_only_no_pytest_no_compilation",
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
        driver_code = 2
        process: subprocess.Popen[bytes] | None = None
        try:
            child_env = {**os.environ, **layout["env"]}
            existing_pythonpath = os.environ.get("PYTHONPATH")
            pythonpath = [
                str(repo / "packages/fullmag-py/src"),
                str(repo / "packages/fullmag-py/tests"),
            ]
            if existing_pythonpath:
                pythonpath.append(existing_pythonpath)
            child_env.update(
                FULLMAG_REPO_ROOT=str(repo),
                FULLMAG_STORAGE_PROFILE=DIAGNOSTIC_PROFILE,
                FULLMAG_EXACT_LAYER_DIAGNOSTIC_RUN_ROOT=str(run_root),
                PYTHONDONTWRITEBYTECODE="1",
                PYTHONPATH=os.pathsep.join(pythonpath),
            )
            command = [
                str(interpreter),
                "-u",
                str(script_path),
                "--repo-root",
                str(repo),
                "--child",
                "--run-root",
                str(run_root),
                "--suite",
                suite_name,
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
            receipt["source_fingerprints_after"] = source_after
            receipt["interpreter_sha256_after"] = interpreter_after
            receipt["head_after"] = head_after
            receipt["child_exit_code"] = driver_code
            source_stable = source_before == source_after
            interpreter_stable = interpreter_before == interpreter_after
            head_stable = head == head_after
            child_completed = False
            try:
                _validate_child_summary(
                    receipt.get("child_summary"),
                    repo=repo,
                    run_root=run_root,
                    suite_name=suite_name,
                    selected_test=selected_test,
                )
                child_completed = True
                receipt["child_summary_contract_valid"] = True
            except BaseException as error:
                receipt["child_summary_contract_valid"] = False
                receipt["child_summary_validation_error"] = f"{type(error).__name__}: {error}"
            receipt["source_changed_during_run"] = not source_stable
            receipt["interpreter_changed_during_run"] = not interpreter_stable
            receipt["head_changed_during_run"] = not head_stable
            receipt["state"] = (
                "completed"
                if (
                    driver_code == 0
                    and source_stable
                    and interpreter_stable
                    and head_stable
                    and child_completed
                    and isinstance(receipt["process"], dict)
                    and receipt["process"].get("waited") is True
                    and receipt["process"].get("timed_out") is False
                )
                else "failed"
            )
            if receipt["state"] != "completed" and not receipt.get("error"):
                receipt["error"] = "Managed child did not complete the closed diagnostic"
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
            print(
                json.dumps(
                    {
                        "receipt": str(receipt_path),
                        "log": str(log_path),
                        "state": receipt["state"],
                        "driver_exit_code": driver_code,
                    },
                    ensure_ascii=False,
                )
            )
        return 0 if receipt["state"] == "completed" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument(
        "--suite",
        choices=tuple(SUITE_TESTS),
        default="scoped-ring",
        help="Existing meshing unittest selected for the four in-memory variants.",
    )
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--run-root", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    repo = Path(args.repo_root).resolve()
    try:
        if args.child:
            if args.run_root is None:
                raise storage.StorageError("Child diagnostic requires --run-root")
            return _child_main(repo, args.run_root.resolve(), args.suite)
        return _parent_run(repo, args.suite)
    except (storage.StorageError, OSError, ValueError) as error:
        print(f"[exact-layer diagnostic] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
