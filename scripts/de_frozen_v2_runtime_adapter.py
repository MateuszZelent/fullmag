"""Prepare a private runtime script from a validated frozen v2 DE probe bundle.

This adapter only derives immutable launch inputs. It does not execute Fullmag,
build a mesh, relax a state, synthesize equilibrium data, or claim parity.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
from types import MappingProxyType
from typing import Any, Mapping

import freeze_signed_de_probe_inputs as freezer
from comsol_mesh_identity import mesh_topology_fingerprint_v3


DEFAULT_CONTAINER_INPUT_ROOT = "/workspace/benchmark-input"
EXPECTED_INDICES = (3, 11, 3)
EXPECTED_VECTORS = ((0.0, -1.0e7, 0.0), (0.0, 1.0e7, 0.0), (0.0, -1.0e7, 0.0))
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_NATIVE_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
_MAX_READ_BYTES = 1024**3


@dataclass(frozen=True)
class PreparedFrozenV2Probe:
    """Validated, mode-independent source for a later serial/adaptive launch."""

    bundle_path: Path
    container_input_root: str
    manifest_sha256: str
    closure_file_table_sha256: str
    run_request_sha256: str
    run_result_sha256: str
    metadata_raw_sha256: str
    model_source_commit: str
    model_source_path: str
    source_model_sha256: str
    runtime_script_bytes: bytes
    runtime_script_sha256: str
    runtime_environment: Mapping[str, str]
    mesh_ir_bundle_path: str
    mesh_ir_raw: bytes
    mesh_ir_raw_sha256: str
    mesh_region_markers: Any
    mesh_object_region_markers: Any
    source_mesh_topology_sha256: str
    modal_mesh_topology_fingerprint_v3: str
    source_mesh_node_count: int
    modal_mesh_node_count: int
    selected_equilibrium_bundle_path: str
    selected_equilibrium_schema: str
    selected_equilibrium_raw_sha256: str
    selected_equilibrium_native_content_sha256: str
    source_sample_indices: tuple[int, int, int]
    k_vectors_rad_per_m: tuple[tuple[float, float, float], ...]
    source_state_closure_status: str
    physical_source_state_replay: str
    runtime_capsule_status: str
    qualification_status: str

    def environment_for_mode(self, mode: str) -> dict[str, str]:
        """Return the identical runtime environment with only policy mode varied."""
        if mode not in {"serial", "adaptive"}:
            raise ValueError("parallel mode must be 'serial' or 'adaptive'")
        environment = dict(self.runtime_environment)
        environment["FULLMAG_DE_SMOKE_PARALLEL_MODE"] = mode
        return environment


def _stat_signature(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_mode)


def _safe_relative(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError(f"{label} must be a non-empty storage-relative POSIX path")
    path = PurePosixPath(value)
    if (path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts) or
            path.as_posix() != value):
        raise ValueError(f"{label} escapes its containing root")
    return path.as_posix()


def _safe_container_root(value: str) -> PurePosixPath:
    if not isinstance(value, str) or "\\" in value:
        raise ValueError("container input root must be an absolute POSIX path")
    path = PurePosixPath(value)
    if (not path.is_absolute() or any(part in {".", ".."} for part in path.parts) or
            path.as_posix() != value):
        raise ValueError("container input root must be normalized and absolute")
    return path


def _bundle_file_path(bundle: Path, relative: str) -> Path:
    normalized = _safe_relative(relative, "bundle file path")
    root_info = bundle.lstat()
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise ValueError("frozen input bundle root is linked or not a directory")
    path = bundle
    for part in PurePosixPath(normalized).parts:
        path = path / part
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError(f"bundle file traverses a link: {normalized}")
        if path != bundle / Path(*PurePosixPath(normalized).parts):
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError(f"bundle path component is not a directory: {normalized}")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"bundle entry is not a regular file: {normalized}")
    try:
        if not path.resolve(strict=True).is_relative_to(bundle.resolve(strict=True)):
            raise ValueError(f"bundle file escapes through a path alias: {normalized}")
    except OSError as error:
        raise ValueError(f"bundle file cannot be resolved: {normalized}") from error
    return path


def _scan_file(path: Path, *, capture: bool = False) -> tuple[int, str, bytes | None]:
    before = path.lstat()
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ValueError(f"bundle file is linked or non-regular: {path}")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ValueError(f"bundle file could not be opened safely: {path}") from error
    digest = hashlib.sha256()
    chunks: list[bytes] | None = [] if capture else None
    size = 0
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if _stat_signature(opened) != _stat_signature(before):
            raise ValueError(f"bundle file changed while opening: {path}")
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(block)
            if size > _MAX_READ_BYTES:
                raise ValueError(f"bundle file exceeds adapter read limit: {path}")
            digest.update(block)
            if chunks is not None:
                chunks.append(block)
        closed = os.fstat(stream.fileno())
    after = path.lstat()
    if (_stat_signature(before) != _stat_signature(closed) or
            _stat_signature(before) != _stat_signature(after) or size != after.st_size):
        raise ValueError(f"bundle file changed while reading: {path}")
    raw = b"".join(chunks) if chunks is not None else None
    return size, digest.hexdigest(), raw


def _strict_json(raw: bytes, label: str) -> dict[str, Any]:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for key, value in items:
            if key in output:
                raise ValueError(f"{label} contains a duplicate key: {key}")
            output[key] = value
        return output

    def reject_constant(value: str) -> None:
        raise ValueError(f"{label} contains a non-finite number: {value}")

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"{label} is not strict UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _read_record(bundle: Path, record: Mapping[str, Any], *, capture: bool) -> bytes | None:
    relative = _safe_relative(record.get("bundle_path"), "manifest bundle path")
    expected_size = record.get("size")
    expected_sha = record.get("raw_sha256")
    if isinstance(expected_size, bool) or not isinstance(expected_size, int) or expected_size < 0:
        raise ValueError(f"bundle size binding is invalid: {relative}")
    if not isinstance(expected_sha, str) or _HEX64.fullmatch(expected_sha) is None:
        raise ValueError(f"bundle raw hash binding is invalid: {relative}")
    path = _bundle_file_path(bundle, relative)
    size, digest, raw = _scan_file(path, capture=capture)
    if (size, digest) != (expected_size, expected_sha):
        raise ValueError(f"bundle file hash mismatch after campaign validation: {relative}")
    return raw


def _verified_snapshot(bundle: Path, validated_manifest: Mapping[str, Any]) -> tuple[bytes, str, dict[str, dict[str, Any]]]:
    manifest_path = _bundle_file_path(bundle, freezer.MANIFEST_FILENAME)
    _, manifest_sha, manifest_raw = _scan_file(manifest_path, capture=True)
    assert manifest_raw is not None
    reread_manifest = _strict_json(manifest_raw, "frozen input manifest")
    if reread_manifest != dict(validated_manifest):
        raise ValueError("frozen input manifest changed after freezer validation")
    records = reread_manifest.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("frozen input manifest has no file records")
    by_path: dict[str, dict[str, Any]] = {}
    actual_paths = set(freezer._bundle_file_table(bundle))
    expected_paths = {freezer.MANIFEST_FILENAME}
    for record in records:
        if not isinstance(record, Mapping):
            raise ValueError("frozen input manifest has an invalid file record")
        relative = _safe_relative(record.get("bundle_path"), "manifest bundle path")
        if relative in by_path:
            raise ValueError(f"duplicate manifest bundle path: {relative}")
        by_path[relative] = dict(record)
        expected_paths.add(relative)
        _read_record(bundle, record, capture=False)
    if actual_paths != expected_paths:
        raise ValueError("frozen bundle file set changed after campaign validation")
    return manifest_raw, manifest_sha, by_path


def _record_for_role(records: Mapping[str, Mapping[str, Any]], role: str) -> Mapping[str, Any]:
    matches = [record for record in records.values() if record.get("role") == role]
    if len(matches) != 1:
        raise ValueError(f"bundle must contain exactly one {role} input")
    return matches[0]


def _finite_number(value: object, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"accepted {label} is not finite numeric metadata")
    number = float(value)
    if positive and number <= 0:
        raise ValueError(f"accepted {label} must be positive")
    return number


def _ghz_text(value_hz: object, label: str) -> str:
    frequency_hz = _finite_number(value_hz, label, positive=True)
    value_ghz = frequency_hz / 1.0e9
    text = repr(value_ghz)
    if float(text) * 1.0e9 != frequency_hz:
        raise ValueError(f"accepted {label} cannot be represented exactly by the model's GHz environment input")
    return text


def _runtime_environment(manifest: Mapping[str, Any]) -> dict[str, str]:
    numerical = manifest.get("numerical_settings")
    if not isinstance(numerical, Mapping):
        raise ValueError("frozen bundle has no numerical settings")
    model = numerical.get("model_metadata")
    if not isinstance(model, Mapping):
        raise ValueError("frozen bundle has no accepted model metadata")
    if model.get("sampling") != "signed-fifteen" or model.get("modal_target") != "frequency_window":
        raise ValueError("frozen model metadata is not the supported signed-fifteen frequency-window source")
    if model.get("requested_mode_count") != 1:
        raise ValueError("frozen signed-fifteen model does not request the supported single mode")

    frequency = numerical.get("frequency_window_hz")
    if (not isinstance(frequency, list) or len(frequency) != 2 or
            _finite_number(frequency[0], "frequency window lower bound", positive=True) >=
            _finite_number(frequency[1], "frequency window upper bound", positive=True)):
        raise ValueError("accepted frequency window is invalid")
    if model.get("frequency_window_hz") != frequency:
        raise ValueError("accepted model and numerical-settings frequency windows differ")

    element_size = _finite_number(model.get("magnetic_element_size_m"), "magnetic element size", positive=True)
    levels = {"L0": 10.0e-9, "L1": 7.5e-9, "L2": 5.0e-9, "L3": 3.75e-9}
    level_matches = [level for level, size in levels.items() if element_size == size]
    if len(level_matches) != 1:
        raise ValueError("accepted magnetic element size has no exact pinned mesh-level environment value")

    layers = model.get("through_thickness_elements")
    if isinstance(layers, bool) or not isinstance(layers, int) or layers not in {3, 6, 9}:
        raise ValueError("accepted through-thickness element count is unsupported by the pinned runtime model")
    rtol = _finite_number(model.get("eigen_solver_rtol"), "eigen solver tolerance", positive=True)
    rtol_values = {1.0e-8: "1e-8", 1.0e-7: "1e-7", 1.0e-6: "1e-6"}
    if rtol not in rtol_values:
        raise ValueError("accepted eigen solver tolerance is unsupported by the pinned runtime model")

    return {
        "FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ": _ghz_text(frequency[0], "frequency lower bound"),
        "FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ": _ghz_text(frequency[1], "frequency upper bound"),
        "FULLMAG_DE_SMOKE_MESH_LEVEL": level_matches[0],
        "FULLMAG_DE_SMOKE_THICKNESS_LAYERS": str(layers),
        "FULLMAG_DE_SMOKE_SOLVER_RTOL": rtol_values[rtol],
    }


def _call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _call_name(node.value)
        return f"{parent}.{node.attr}" if parent else None
    return None


def _named_calls(tree: ast.AST, name: str) -> list[ast.Call]:
    return [node for node in ast.walk(tree) if isinstance(node, ast.Call) and _call_name(node.func) == name]


def _has_string_dict_key(node: ast.AST, key: str) -> bool:
    for candidate in ast.walk(node):
        if not isinstance(candidate, ast.Dict):
            continue
        for item in candidate.keys:
            if isinstance(item, ast.Constant) and item.value == key:
                return True
    return False


def _top_level_assignment(tree: ast.Module, name: str) -> ast.stmt:
    matches: list[ast.stmt] = []
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == name for target in statement.targets
        ):
            matches.append(statement)
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name) and statement.target.id == name:
            matches.append(statement)
    if len(matches) != 1:
        raise ValueError(f"pinned model structure requires exactly one top-level {name} assignment")
    return matches[0]


def _literal(value: Any) -> ast.expr:
    try:
        source = repr(value)
        return ast.parse(source, mode="eval").body
    except (SyntaxError, ValueError, TypeError) as error:
        raise ValueError("frozen metadata contains a value that cannot be embedded as a Python literal") from error


class _FrozenModelTransform(ast.NodeTransformer):
    def __init__(self, *, mesh_path: str, equilibrium_path: str, markers: Mapping[str, Any]) -> None:
        self.mesh_path = mesh_path
        self.equilibrium_path = equilibrium_path
        self.markers = markers

    def visit_Expr(self, node: ast.Expr):
        call = node.value if isinstance(node.value, ast.Call) else None
        if call is None:
            return self.generic_visit(node)
        name = _call_name(call.func)
        if name == "study.build_domain_mesh":
            return ast.copy_location(ast.Expr(value=ast.Call(
                func=ast.Attribute(value=ast.Name(id="fm", ctx=ast.Load()), attr="domain_mesh", ctx=ast.Load()),
                args=[ast.Constant(value=self.mesh_path)],
                keywords=[
                    ast.keyword(arg="region_markers", value=_literal(self.markers["region_markers"])),
                    ast.keyword(arg="object_region_markers", value=_literal(self.markers["object_region_markers"])),
                ],
            )), node)
        if name == "study.stages.add_relax":
            return None
        return self.generic_visit(node)

    def visit_Call(self, node: ast.Call):
        node = self.generic_visit(node)
        if _call_name(node.func) == "study.stages.add_eigenmodes":
            for keyword in node.keywords:
                if keyword.arg == "equilibrium_source":
                    keyword.value = ast.Constant(value="artifact")
                elif keyword.arg == "equilibrium_artifact":
                    keyword.value = ast.Constant(value=self.equilibrium_path)
            if not any(keyword.arg == "equilibrium_source" for keyword in node.keywords):
                raise ValueError("pinned eigenmodes stage omits equilibrium_source")
            if not any(keyword.arg == "equilibrium_artifact" for keyword in node.keywords):
                node.keywords.append(ast.keyword(arg="equilibrium_artifact", value=ast.Constant(value=self.equilibrium_path)))
        return node


def _derive_runtime_script(
    model_raw: bytes,
    manifest: Mapping[str, Any],
    container_input_root: str = DEFAULT_CONTAINER_INPUT_ROOT,
) -> bytes:
    """Derive a deterministic three-point model without mesh generation/relaxation."""
    if not isinstance(model_raw, bytes) or not model_raw or len(model_raw) > 1024 * 1024:
        raise ValueError("pinned model source bytes are missing or oversized")
    try:
        tree = ast.parse(model_raw.decode("utf-8"), filename="model-input.py")
    except (UnicodeError, SyntaxError) as error:
        raise ValueError("pinned model source is not valid UTF-8 Python") from error

    imports_fullmag_alias = any(
        isinstance(statement, ast.Import) and any(alias.name == "fullmag" and alias.asname == "fm" for alias in statement.names)
        for statement in tree.body
    )
    if not imports_fullmag_alias or len(_named_calls(tree, "fm.study")) != 1:
        raise ValueError("pinned model structure does not match the expected Fullmag study source")
    study_call = _named_calls(tree, "fm.study")[0]
    if len(study_call.args) != 1 or not isinstance(study_call.args[0], ast.Constant) or study_call.args[0].value != "de-smoke-10nm-numeric":
        raise ValueError("pinned model study identity is unsupported")
    for name in ("SAMPLING", "KY", "K_VECTORS", "MODAL_TARGET"):
        _top_level_assignment(tree, name)

    build_calls = _named_calls(tree, "study.build_domain_mesh")
    relax_calls = _named_calls(tree, "study.stages.add_relax")
    eigen_calls = _named_calls(tree, "study.stages.add_eigenmodes")
    if len(build_calls) != 1 or len(relax_calls) != 1 or len(eigen_calls) != 1:
        raise ValueError("pinned model structure must contain one mesh build, relax stage, and eigenmodes stage")
    eigen_call = eigen_calls[0]
    source_keywords = [keyword for keyword in eigen_call.keywords if keyword.arg == "equilibrium_source"]
    if (len(source_keywords) != 1 or not isinstance(source_keywords[0].value, ast.Constant) or
            source_keywords[0].value.value != "relax" or
            any(keyword.arg == "equilibrium_artifact" for keyword in eigen_call.keywords) or
            not (any(keyword.arg == "k_sampling" for keyword in eigen_call.keywords) or
                 any(keyword.arg is None and _has_string_dict_key(keyword.value, "k_sampling")
                     for keyword in eigen_call.keywords))):
        raise ValueError("pinned model eigenmodes stage does not match the expected relax-backed k-path")

    probe = manifest.get("probe")
    if not isinstance(probe, Mapping) or probe.get("source_sample_indices") != list(EXPECTED_INDICES):
        raise ValueError("frozen manifest does not authorize the exact three-point probe")
    raw_vectors = probe.get("k_vectors_rad_per_m")
    if (not isinstance(raw_vectors, list) or len(raw_vectors) != len(EXPECTED_VECTORS) or
            any(not isinstance(vector, list) or len(vector) != 3 for vector in raw_vectors)):
        raise ValueError("frozen manifest has invalid probe vectors")
    frozen_vectors = tuple(tuple(_finite_number(value, "probe k component") for value in vector)
                           for vector in raw_vectors)
    if frozen_vectors != EXPECTED_VECTORS:
        raise ValueError("frozen manifest does not authorize the exact [-10,+10,-10] probe vectors")
    mesh = manifest.get("mesh")
    selected = manifest.get("selected_equilibrium")
    if not isinstance(mesh, Mapping) or not isinstance(selected, Mapping):
        raise ValueError("frozen manifest omits its receipt-bound mesh or equilibrium")
    markers = {
        "region_markers": mesh.get("region_markers"),
        "object_region_markers": mesh.get("object_region_markers"),
    }
    if not isinstance(markers["region_markers"], (list, dict)):
        raise ValueError("frozen MeshIR region markers have an unsupported shape")
    mesh_relative = _safe_relative(mesh.get("bundle_path"), "frozen MeshIR bundle path")
    equilibrium_relative = _safe_relative(selected.get("bundle_path"), "selected equilibrium bundle path")
    if mesh_relative != "input/mesh-ir.json" or not equilibrium_relative.startswith("input/state/"):
        raise ValueError("frozen runtime input paths do not match v2 bundle layout")
    root = _safe_container_root(container_input_root)
    mesh_path = (root / PurePosixPath(mesh_relative)).as_posix()
    equilibrium_path = (root / PurePosixPath(equilibrium_relative)).as_posix()

    sampling = _top_level_assignment(tree, "SAMPLING")
    sampling.value = ast.Constant(value="signed-fifteen")
    ky = _top_level_assignment(tree, "KY")
    ky_values = tuple(vector[1] for vector in frozen_vectors)
    ky.value = ast.Tuple(elts=[ast.Constant(value=value) for value in ky_values], ctx=ast.Load())
    k_vectors = _top_level_assignment(tree, "K_VECTORS")
    k_vectors.value = ast.List(elts=[
        ast.Tuple(elts=[ast.Constant(value=value) for value in vector], ctx=ast.Load())
        for vector in frozen_vectors
    ], ctx=ast.Load())
    modal_target = _top_level_assignment(tree, "MODAL_TARGET")
    modal_target.value = ast.Constant(value="frequency_window")

    tree = _FrozenModelTransform(
        mesh_path=mesh_path,
        equilibrium_path=equilibrium_path,
        markers=markers,
    ).visit(tree)
    ast.fix_missing_locations(tree)
    if (_named_calls(tree, "study.build_domain_mesh") or _named_calls(tree, "study.stages.add_relax") or
            len(_named_calls(tree, "fm.domain_mesh")) != 1 or len(_named_calls(tree, "study.stages.add_eigenmodes")) != 1):
        raise ValueError("derived model retained a mesh-generation/relax call or lost a required runtime input")
    derived = (ast.unparse(tree) + "\n").encode("utf-8")
    try:
        compile(derived, "derived-frozen-probe.py", "exec")
    except (SyntaxError, ValueError) as error:
        raise ValueError("derived frozen probe source is not valid Python") from error
    return derived


def _validated_model_identity(manifest: Mapping[str, Any], request_raw: bytes, model_raw: bytes) -> str:
    request = _strict_json(request_raw, "bundled run-request")
    source = request.get("model_source")
    if (not isinstance(source, Mapping) or source.get("commit") != freezer.PINNED_MODEL_COMMIT or
            source.get("path") != "examples/fem_de_smoke_numeric.py"):
        raise ValueError("frozen model source identity is not the pinned standalone model")
    model_sha = hashlib.sha256(model_raw).hexdigest()
    if model_sha != request.get("model_sha256") or model_sha != source.get("sha256"):
        raise ValueError("frozen original model bytes do not match the receipt-bound source identity")
    source_manifest = manifest.get("source")
    if not isinstance(source_manifest, Mapping) or source_manifest.get("model_source") != dict(source):
        raise ValueError("frozen model source provenance differs from copied run-request")
    return model_sha


def _prepare_from_validated_bundle(
    bundle: Path,
    manifest: Mapping[str, Any],
    container_input_root: str,
) -> PreparedFrozenV2Probe:
    manifest_raw, manifest_sha, records = _verified_snapshot(bundle, manifest)
    required_roles = {
        "run_request": "run_request",
        "run_result": "run_result",
        "accepted_metadata": "accepted_metadata",
        "model_source": "model_source",
        "mesh_ir": "receipt_bound_complete_mesh_ir",
        "selected_equilibrium": "solver_consumed_equilibrium",
    }
    by_role = {key: _record_for_role(records, role) for key, role in required_roles.items()}
    if by_role["mesh_ir"].get("bundle_path") != "input/mesh-ir.json":
        raise ValueError("complete MeshIR is not at the v2 runtime path")
    request_raw = _read_record(bundle, by_role["run_request"], capture=True)
    result_raw = _read_record(bundle, by_role["run_result"], capture=True)
    metadata_raw = _read_record(bundle, by_role["accepted_metadata"], capture=True)
    model_raw = _read_record(bundle, by_role["model_source"], capture=True)
    mesh_raw = _read_record(bundle, by_role["mesh_ir"], capture=True)
    eq_record = by_role["selected_equilibrium"]
    eq_raw = _read_record(bundle, eq_record, capture=True)
    assert all(raw is not None for raw in (request_raw, result_raw, metadata_raw, model_raw, mesh_raw, eq_raw))
    request_raw, result_raw, metadata_raw, model_raw, mesh_raw, eq_raw = (
        raw for raw in (request_raw, result_raw, metadata_raw, model_raw, mesh_raw, eq_raw) if raw is not None
    )
    model_sha = _validated_model_identity(manifest, request_raw, model_raw)
    metadata = _strict_json(metadata_raw, "accepted source metadata")
    request = _strict_json(request_raw, "bundled run-request")
    result = _strict_json(result_raw, "bundled run-result")
    if result.get("status") != "completed_unqualified" or result.get("return_code") != 0:
        raise ValueError("frozen source result is not a completed accepted campaign")
    if request.get("model_sha256") != result.get("model_sha256"):
        raise ValueError("copied run-request and run-result do not bind the same original model")

    mesh_ir = _strict_json(mesh_raw, "frozen complete MeshIR")
    backend = metadata.get("execution_plan", {}).get("backend_plan", {})
    source_mesh = backend.get("mesh") if isinstance(backend, Mapping) else None
    if not isinstance(source_mesh, Mapping) or mesh_ir != dict(source_mesh):
        raise ValueError("frozen MeshIR differs from the receipt-bound planner MeshIR")
    mesh = manifest.get("mesh")
    if not isinstance(mesh, Mapping):
        raise ValueError("frozen manifest omits mesh identities")
    if hashlib.sha256(mesh_raw).hexdigest() != mesh.get("raw_sha256") or len(mesh_raw) != mesh.get("size"):
        raise ValueError("frozen MeshIR bytes differ from the dedicated mesh binding")
    modal_fingerprint = mesh_topology_fingerprint_v3(mesh_ir)
    if modal_fingerprint != mesh.get("modal_mesh_topology_fingerprint_v3"):
        raise ValueError("frozen MeshIR topology fingerprint differs from modal identity")
    source_geometry = manifest.get("source_mesh_geometry_replay")
    if (not isinstance(source_geometry, Mapping) or
            source_geometry.get("status") != "receipt_bound_source_and_modal_topology_replayed" or
            source_geometry.get("source_samples") != [3, 11] or
            source_geometry.get("modal_mesh_topology_fingerprint_v3") != modal_fingerprint or
            source_geometry.get("physical_source_state_replay") != "not_performed"):
        raise ValueError("source geometry replay status is missing or overclaims physical replay")
    source_fingerprint = source_geometry.get("source_mesh_topology_sha256")
    if (not isinstance(source_fingerprint, str) or _NATIVE_SHA.fullmatch(source_fingerprint) is None or
            mesh.get("source_mesh_topology_sha256") != source_fingerprint):
        raise ValueError("receipt-bound source mesh identity is missing or differs from the manifest")

    selected = manifest.get("selected_equilibrium")
    if not isinstance(selected, Mapping):
        raise ValueError("frozen manifest omits selected equilibrium")
    if selected.get("source_samples") != [3, 11]:
        raise ValueError("selected equilibrium is not derived from both probe source samples")
    eq_relative = _safe_relative(selected.get("bundle_path"), "selected equilibrium bundle path")
    if eq_record.get("bundle_path") != eq_relative or eq_record.get("role") != "solver_consumed_equilibrium":
        raise ValueError("selected equilibrium is not the unique receipt-bound solver input")
    equilibrium = _strict_json(eq_raw, "selected equilibrium artifact")
    eq_schema = selected.get("schema_version")
    raw_sha = hashlib.sha256(eq_raw).hexdigest()
    native_sha = selected.get("native_content_sha256")
    if (eq_schema not in {"equilibrium_artifact.v7", "equilibrium_artifact.v8"} or
            equilibrium.get("schema_version") != eq_schema or
            not isinstance(native_sha, str) or _NATIVE_SHA.fullmatch(native_sha) is None or
            equilibrium.get("content_sha256") != native_sha or
            raw_sha != selected.get("raw_sha256") or
            eq_record.get("schema_version") != eq_schema or eq_record.get("native_content_sha256") != native_sha):
        raise ValueError("selected equilibrium raw/native identities do not match their separate receipt bindings")
    identities = manifest.get("identities")
    if not isinstance(identities, Mapping):
        raise ValueError("frozen sample identity table is missing")
    first, second = identities.get("3"), identities.get("11")
    if not isinstance(first, Mapping) or not isinstance(second, Mapping):
        raise ValueError("frozen source identities for samples 3 and 11 are missing")
    identity_fields = (
        "equilibrium_content_sha256", "source_mesh_topology_sha256", "modal_mesh_topology_fingerprint_v3",
    )
    if (any(first.get(field) != second.get(field) for field in identity_fields) or
            first.get("node_count") != second.get("node_count")):
        raise ValueError("probe source samples do not bind the same EQ, source mesh, and modal mesh identities")
    if (first.get("equilibrium_content_sha256") != native_sha or
            first.get("source_mesh_topology_sha256") != source_fingerprint or
            first.get("modal_mesh_topology_fingerprint_v3") != modal_fingerprint):
        raise ValueError("probe sample identities differ from the separately bound runtime inputs")
    mesh_identity = selected.get("mesh_identity")
    if (not isinstance(mesh_identity, Mapping) or
            mesh_identity.get("source_mesh_topology_sha256") != source_fingerprint or
            mesh_identity.get("modal_mesh_topology_fingerprint_v3") != modal_fingerprint):
        raise ValueError("selected EQ mesh identity does not preserve source/modal fingerprints separately")
    if mesh_identity.get("node_count") != first.get("node_count"):
        raise ValueError("selected EQ source node count differs from both sample identities")

    closure = manifest.get("source_state_closure")
    if (not isinstance(closure, Mapping) or closure.get("status") != "hash_bound_only" or
            not isinstance(closure.get("file_table_sha256"), str) or
            _HEX64.fullmatch(closure["file_table_sha256"]) is None):
        raise ValueError("frozen state closure is not explicitly hash-bound")
    if manifest.get("probe", {}).get("source_sample_indices") != list(EXPECTED_INDICES):
        raise ValueError("frozen probe source indices changed")
    if manifest.get("probe", {}).get("k_vectors_rad_per_m") != [list(vector) for vector in EXPECTED_VECTORS]:
        raise ValueError("frozen probe k vectors changed")
    model_metadata = manifest.get("numerical_settings", {}).get("model_metadata")
    if not isinstance(model_metadata, Mapping):
        raise ValueError("frozen numerical model metadata is missing")
    metadata_de_smoke = metadata.get("problem_meta", {}).get("runtime_metadata", {}).get("de_smoke")
    if model_metadata != metadata_de_smoke:
        raise ValueError("frozen numerical model settings differ from exact source metadata")

    container_root = _safe_container_root(container_input_root).as_posix()
    environment = MappingProxyType(_runtime_environment(manifest))
    runtime_script = _derive_runtime_script(model_raw, manifest, container_root)
    source_node_count = mesh_identity.get("node_count")
    modal_node_count = mesh.get("node_count")
    if (isinstance(source_node_count, bool) or not isinstance(source_node_count, int) or source_node_count <= 0 or
            isinstance(modal_node_count, bool) or not isinstance(modal_node_count, int) or modal_node_count != len(mesh_ir.get("nodes", []))):
        raise ValueError("source or modal MeshIR node count is invalid")
    markers = {
        "region_markers": mesh.get("region_markers"),
        "object_region_markers": mesh.get("object_region_markers"),
    }
    metadata_digest = hashlib.sha256(metadata_raw).hexdigest()
    if metadata_digest != mesh.get("source_metadata_raw_sha256"):
        raise ValueError("frozen MeshIR metadata provenance hash differs from exact metadata bytes")

    return PreparedFrozenV2Probe(
        bundle_path=bundle,
        container_input_root=container_root,
        manifest_sha256=manifest_sha,
        closure_file_table_sha256=closure["file_table_sha256"],
        run_request_sha256=hashlib.sha256(request_raw).hexdigest(),
        run_result_sha256=hashlib.sha256(result_raw).hexdigest(),
        metadata_raw_sha256=metadata_digest,
        model_source_commit=request["model_source"]["commit"],
        model_source_path=request["model_source"]["path"],
        source_model_sha256=model_sha,
        runtime_script_bytes=runtime_script,
        runtime_script_sha256=hashlib.sha256(runtime_script).hexdigest(),
        runtime_environment=environment,
        mesh_ir_bundle_path="input/mesh-ir.json",
        mesh_ir_raw=mesh_raw,
        mesh_ir_raw_sha256=hashlib.sha256(mesh_raw).hexdigest(),
        mesh_region_markers=markers["region_markers"],
        mesh_object_region_markers=markers["object_region_markers"],
        source_mesh_topology_sha256=source_fingerprint,
        modal_mesh_topology_fingerprint_v3=modal_fingerprint,
        source_mesh_node_count=source_node_count,
        modal_mesh_node_count=modal_node_count,
        selected_equilibrium_bundle_path=eq_relative,
        selected_equilibrium_schema=eq_schema,
        selected_equilibrium_raw_sha256=raw_sha,
        selected_equilibrium_native_content_sha256=native_sha,
        source_sample_indices=EXPECTED_INDICES,
        k_vectors_rad_per_m=EXPECTED_VECTORS,
        source_state_closure_status="hash_bound_only",
        physical_source_state_replay="not_performed",
        runtime_capsule_status="NOT VERIFIED: managed launch capsule is bound by the later driver",
        qualification_status="NOT VERIFIED",
    )


def prepare_frozen_v2_probe(
    bundle: str | Path,
    storage_root: str | Path,
    *,
    container_input_root: str = DEFAULT_CONTAINER_INPUT_ROOT,
) -> PreparedFrozenV2Probe:
    """Validate and prepare a frozen bundle before any runtime side effect."""
    manifest = freezer.validate_bundle(bundle, storage_root)
    bundle_path = Path(os.path.abspath(os.fspath(bundle)))
    storage_path = Path(os.path.abspath(os.fspath(storage_root)))
    if not bundle_path.resolve(strict=True).is_relative_to(storage_path.resolve(strict=True)):
        raise ValueError("frozen input bundle is outside configured storage")
    return _prepare_from_validated_bundle(bundle_path, manifest, container_input_root)


def verify_bundle_for_launch(prepared: PreparedFrozenV2Probe, storage_root: str | Path) -> dict[str, str]:
    """Revalidate the same immutable bundle immediately before a future launch."""
    if not isinstance(prepared, PreparedFrozenV2Probe):
        raise TypeError("launch verification requires a PreparedFrozenV2Probe")
    manifest = freezer.validate_bundle(prepared.bundle_path, storage_root)
    _, manifest_sha, records = _verified_snapshot(prepared.bundle_path, manifest)
    if (manifest_sha != prepared.manifest_sha256 or
            manifest.get("source_state_closure", {}).get("file_table_sha256") != prepared.closure_file_table_sha256):
        raise ValueError("frozen bundle identity changed after runtime preparation")
    if records.get(prepared.selected_equilibrium_bundle_path, {}).get("raw_sha256") != prepared.selected_equilibrium_raw_sha256:
        raise ValueError("selected equilibrium binding changed after runtime preparation")
    if records.get(prepared.mesh_ir_bundle_path, {}).get("raw_sha256") != prepared.mesh_ir_raw_sha256:
        raise ValueError("MeshIR binding changed after runtime preparation")
    return {
        "manifest_sha256": manifest_sha,
        "source_model_sha256": prepared.source_model_sha256,
        "runtime_script_sha256": prepared.runtime_script_sha256,
        "selected_equilibrium_raw_sha256": prepared.selected_equilibrium_raw_sha256,
        "selected_equilibrium_native_content_sha256": prepared.selected_equilibrium_native_content_sha256,
        "modal_mesh_topology_fingerprint_v3": prepared.modal_mesh_topology_fingerprint_v3,
        "source_mesh_topology_sha256": prepared.source_mesh_topology_sha256,
        "status": "hash_bindings_revalidated; runtime_not_executed; science_not_qualified",
    }
