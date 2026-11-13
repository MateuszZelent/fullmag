"""Read-only qualification of a completed FEM relaxation Zarr payload."""
from __future__ import annotations

import hashlib
import math
import os
from pathlib import Path
import re
import stat
import struct

from docker_activation_history_inventory import MAX_INVENTORY_ENTRIES, tree_inventory
from docker_activation_history_output import validate_preserved_run
from docker_activation_history_policy import HistoryError, canonical, document
from docker_activation_history_storage import _raw


SCHEMA = "fullmag.data-volume-zarr-qualification.v1"
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_GIT_COMMIT = re.compile(r"[0-9a-f]{40}\Z")
_TABLE_REQUIRED = frozenset({
    "step", "t", "mx", "my", "mz", "e_ex", "e_demag", "e_ext", "e_drive",
    "e_ani", "e_rotated_dmi", "e_dmi", "e_total", "max_torque_T",
})
_ENERGY_TERMS = (
    "e_ex", "e_demag", "e_ext", "e_drive", "e_ani", "e_rotated_dmi", "e_dmi",
)
_FIELD_REQUIRED = frozenset({"m", "H_eff", "H_ex", "H_demag", "H_ext"})
_NOFOLLOW = getattr(os, "O_NOFOLLOW", None)
_READ_CHUNK_BYTES = 64 * 1024


def _require(condition, message):
    if not condition:
        raise HistoryError(message)


def _stat_signature(value):
    return (
        value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
        value.st_size, value.st_mtime_ns, value.st_ctime_ns,
    )


def _strict_directory(path, label):
    path = Path(path)
    try:
        before = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise HistoryError(label + " is missing or unreadable") from error
    if not stat.S_ISDIR(before.st_mode) or resolved != path:
        raise HistoryError(label + " is linked or noncanonical")
    return before


def _stable_file_sha256(path, *, maximum):
    path = Path(path)
    _strict_directory(path.parent, "Adjacent source parent")
    if _NOFOLLOW is None:
        raise HistoryError("No-follow file reads are unavailable")
    try:
        before = path.lstat()
    except OSError as error:
        raise HistoryError("Adjacent Python source is missing") from error
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
        raise HistoryError("Adjacent Python source is linked, nonregular or oversized")
    try:
        descriptor = os.open(path, os.O_RDONLY | _NOFOLLOW)
    except OSError as error:
        raise HistoryError("Cannot open adjacent Python source without following links") from error
    hasher = hashlib.sha256()
    total = 0
    try:
        opened = os.fstat(descriptor)
        if _stat_signature(before) != _stat_signature(opened):
            raise HistoryError("Adjacent Python source changed before reading")
        while True:
            block = os.read(descriptor, _READ_CHUNK_BYTES)
            if not block:
                break
            total += len(block)
            if total > maximum:
                raise HistoryError("Adjacent Python source exceeds its byte bound")
            hasher.update(block)
        after = os.fstat(descriptor)
        named = path.lstat()
        if (_stat_signature(before) != _stat_signature(after)
                or _stat_signature(before) != _stat_signature(named)
                or total != before.st_size):
            raise HistoryError("Adjacent Python source changed while reading")
    finally:
        os.close(descriptor)
    return hasher.hexdigest()


def _content_tree(root):
    """Hash all content and stat identity below root without following links."""
    root = Path(root)
    root_before = _strict_directory(root, "Zarr root")
    content_rows = []
    stability_rows = []
    directories = [(root, _stat_signature(root_before))]

    def fail_walk(error):
        raise HistoryError("Cannot inventory Zarr content: " + str(error))

    for parent, child_directories, files in os.walk(root, topdown=True, followlinks=False, onerror=fail_walk):
        child_directories.sort()
        files.sort()
        parent_path = Path(parent)
        for name in child_directories:
            path = parent_path / name
            try:
                info = path.lstat()
            except OSError as error:
                raise HistoryError("Cannot inspect Zarr directory entry") from error
            if not stat.S_ISDIR(info.st_mode):
                raise HistoryError("Zarr content contains a linked or special directory")
            _strict_directory(path, "Zarr directory")
            directories.append((path, _stat_signature(info)))
            row = {"path": path.relative_to(root).as_posix(), "kind": "directory"}
            content_rows.append(row)
            stability_rows.append({**row, "stat": list(_stat_signature(info))})
            if len(content_rows) > MAX_INVENTORY_ENTRIES:
                raise HistoryError("Zarr content inventory exceeds its entry bound")
        for name in files:
            path = parent_path / name
            try:
                info = path.lstat()
            except OSError as error:
                raise HistoryError("Cannot inspect Zarr file entry") from error
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise HistoryError("Zarr content contains a linked or special file")
            file_sha = _stable_file_sha256_for_tree(path, info)
            row = {"path": path.relative_to(root).as_posix(), "kind": "file", "sha256": file_sha}
            content_rows.append(row)
            stability_rows.append({**row, "stat": list(_stat_signature(info))})
            if len(content_rows) > MAX_INVENTORY_ENTRIES:
                raise HistoryError("Zarr content inventory exceeds its entry bound")

    for path, signature in directories:
        try:
            current = path.lstat()
        except OSError as error:
            raise HistoryError("Zarr directory changed during inventory") from error
        if _stat_signature(current) != signature:
            raise HistoryError("Zarr directory changed during inventory")
    if _stat_signature(root.lstat()) != _stat_signature(root_before):
        raise HistoryError("Zarr root changed during inventory")
    content_rows.sort(key=lambda row: row["path"])
    stability_rows.sort(key=lambda row: row["path"])
    return {
        "entries": len(content_rows),
        "sha256": hashlib.sha256(canonical(content_rows)).hexdigest(),
        "stat_sha256": hashlib.sha256(canonical(stability_rows)).hexdigest(),
    }


def _stable_file_sha256_for_tree(path, before):
    if _NOFOLLOW is None:
        raise HistoryError("No-follow file reads are unavailable")
    try:
        descriptor = os.open(path, os.O_RDONLY | _NOFOLLOW)
    except OSError as error:
        raise HistoryError("Cannot open Zarr file without following links") from error
    hasher = hashlib.sha256()
    total = 0
    try:
        opened = os.fstat(descriptor)
        if _stat_signature(before) != _stat_signature(opened):
            raise HistoryError("Zarr file changed before content inventory")
        while True:
            block = os.read(descriptor, _READ_CHUNK_BYTES)
            if not block:
                break
            total += len(block)
            hasher.update(block)
        after = os.fstat(descriptor)
        named = path.lstat()
        if (_stat_signature(before) != _stat_signature(after)
                or _stat_signature(before) != _stat_signature(named)
                or total != before.st_size):
            raise HistoryError("Zarr file changed during content inventory")
    finally:
        os.close(descriptor)
    return hasher.hexdigest()


def _read_document(path, label):
    return document(_raw(path), label)


def _validate_identity(native_build_identity):
    if type(native_build_identity) is not dict or set(native_build_identity) != {
            "git_commit", "source_snapshot_sha256"}:
        raise HistoryError("Expected native build identity has an open or incomplete shape")
    commit = native_build_identity.get("git_commit")
    snapshot = native_build_identity.get("source_snapshot_sha256")
    if (not isinstance(commit, str) or _GIT_COMMIT.fullmatch(commit) is None
            or not isinstance(snapshot, str) or _SHA256.fullmatch(snapshot) is None):
        raise HistoryError("Expected native build identity is malformed")
    return {"git_commit": commit, "source_snapshot_sha256": snapshot}


def _validate_stage_provenance(provenance, *, expected_device, native_build_identity):
    if not isinstance(provenance, dict):
        raise HistoryError("FEM relaxation provenance is missing")
    resolution = provenance.get("execution_resolution")
    if not isinstance(resolution, dict) or resolution.get("fallback_occurred") is not False:
        raise HistoryError("FEM relaxation used a fallback or lacks execution resolution")
    authored = resolution.get("authored_request")
    resolved = resolution.get("resolved_execution")
    effective = resolution.get("effective_request")
    for label, request in (("authored", authored), ("effective", effective), ("resolved", resolved)):
        if (not isinstance(request, dict) or request.get("backend") != "fem"
                or request.get("device") != expected_device):
            raise HistoryError("FEM " + label + " execution does not match the requested lane")
    expected_engine = "fem_cpu_native" if expected_device == "cpu" else "fem_native_gpu"
    if provenance.get("execution_engine") != expected_engine:
        raise HistoryError("FEM execution engine does not match the requested lane")
    if expected_device == "gpu":
        receipt = provenance.get("fem_gpu_minimizer_execution_receipt")
        accounting = receipt.get("accounting") if isinstance(receipt, dict) else None
        required_zeroes = ("fallback_count", "executed_host_operator_mask",
                           "executed_unknown_operator_mask")
        if (not isinstance(accounting, dict)
                or any(type(accounting.get(name)) is not int or accounting[name] != 0
                       for name in required_zeroes)):
            raise HistoryError("FEM GPU execution receipt reports fallback or lacks operator accounting")
    build_identity = provenance.get("build_identity")
    if not isinstance(build_identity, dict) or any(
            build_identity.get(key) != value for key, value in native_build_identity.items()):
        raise HistoryError("Saved FEM build identity differs from the StartedGroup identity")
    poisson = provenance.get("fem_poisson_demag")
    if not isinstance(poisson, dict):
        raise HistoryError("Saved FEM Poisson demagnetization certificate is missing")
    residual = poisson.get("final_residual")
    rtol = poisson.get("rtol")
    actual_iterations = poisson.get("actual_iterations")
    max_iterations = poisson.get("max_iterations")
    if (isinstance(residual, bool) or not isinstance(residual, (int, float))
            or not math.isfinite(residual) or residual < 0.0 or residual > 1e-12
            or isinstance(rtol, bool) or not isinstance(rtol, (int, float)) or rtol != 1e-12
            or type(actual_iterations) is not int or actual_iterations < 0
            or type(max_iterations) is not int or max_iterations < 0
            or actual_iterations > max_iterations):
        raise HistoryError("Saved FEM Poisson demagnetization certificate is outside its limits")
    return {"final_residual": float(residual), "rtol": float(rtol),
            "actual_iterations": actual_iterations, "max_iterations": max_iterations}


def _array_metadata(path, *, quantity, table=False):
    metadata = _read_document(path / ".zarray", "Zarr array metadata")
    shape = metadata.get("shape")
    chunks = metadata.get("chunks")
    if (not isinstance(shape, list) or len(shape) != 2
            or type(shape[0]) is not int or type(shape[1]) is not int
            or shape[0] < 0 or shape[0] > MAX_INVENTORY_ENTRIES or shape[1] <= 0
            or not isinstance(chunks, list) or chunks != [1, shape[1]]
            or metadata.get("zarr_format") != 2 or metadata.get("dtype") != "<f8"
            or metadata.get("compressor") is not None or metadata.get("filters") is not None
            or metadata.get("fill_value") is not None or metadata.get("order") != "C"
            or metadata.get("dimension_separator") != "."):
        raise HistoryError("Zarr array format is not the uncompressed little-endian f64 contract")
    attrs = _read_document(path / ".zattrs", "Zarr array attributes")
    expected_order = ["sample", "quantity"] if table else ["sample", "value"]
    if attrs.get("dimension_order") != expected_order:
        raise HistoryError("Zarr array sample dimensions differ")
    if table:
        quantities = attrs.get("quantities")
        if not isinstance(quantities, list) or len(quantities) != shape[1] or len(set(quantities)) != len(quantities):
            raise HistoryError("Zarr table quantities are malformed")
    elif attrs.get("quantity") != quantity:
        raise HistoryError("Zarr field quantity differs from its path")
    expected_names = {str(index) + ".0" for index in range(shape[0])}
    try:
        names = {entry.name for entry in path.iterdir()}
    except OSError as error:
        raise HistoryError("Cannot enumerate Zarr array chunks") from error
    if names != expected_names | {".zarray", ".zattrs"}:
        raise HistoryError("Zarr array has missing or undeclared chunk files")
    return shape, attrs


def _read_finite_chunk(path, *, width, collect=False):
    if _NOFOLLOW is None:
        raise HistoryError("No-follow chunk reads are unavailable")
    try:
        before = path.lstat()
    except OSError as error:
        raise HistoryError("Zarr chunk is missing") from error
    expected_size = width * 8
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != expected_size:
        raise HistoryError("Zarr chunk is linked, nonregular or the wrong size")
    try:
        descriptor = os.open(path, os.O_RDONLY | _NOFOLLOW)
    except OSError as error:
        raise HistoryError("Cannot open Zarr chunk without following links") from error
    values = [] if collect else None
    count = 0
    total = 0
    remainder = b""
    try:
        opened = os.fstat(descriptor)
        if _stat_signature(before) != _stat_signature(opened):
            raise HistoryError("Zarr chunk changed before reading")
        while True:
            block = os.read(descriptor, _READ_CHUNK_BYTES)
            if not block:
                break
            total += len(block)
            data = remainder + block
            aligned = len(data) - (len(data) % 8)
            for (value,) in struct.iter_unpack("<d", data[:aligned]):
                if not math.isfinite(value):
                    raise HistoryError("Zarr array contains a non-finite scalar")
                if collect:
                    values.append(value)
                count += 1
            remainder = data[aligned:]
        after = os.fstat(descriptor)
        named = path.lstat()
        if (_stat_signature(before) != _stat_signature(after)
                or _stat_signature(before) != _stat_signature(named)
                or total != expected_size or remainder or count != width):
            raise HistoryError("Zarr chunk changed or differs from its declared shape")
    finally:
        os.close(descriptor)
    return values


def _coordinate_matches_table(coordinate, row, column_index):
    if not isinstance(coordinate, dict):
        return False
    kind = coordinate.get("kind")
    if kind == "accepted_step":
        step = coordinate.get("accepted_step")
        return type(step) is int and float(step) == row[column_index["step"]]
    if kind == "physical_time":
        time_s = coordinate.get("time_s")
        return (not isinstance(time_s, bool) and isinstance(time_s, (int, float))
                and math.isfinite(time_s)
                and math.isclose(float(time_s), row[column_index["t"]], rel_tol=1e-12, abs_tol=1e-30))
    return False


def _index_coordinates(root, run_id, output_attempt, stage_manifest, table_rows, field_samples, columns):
    index_path = root / run_id / output_attempt / "relax.zarr/continuous/index.jsonl"
    raw = _raw(index_path)
    table_coords = {}
    field_coords = {name: {} for name in stage_manifest["field_quantities"]}
    stage_id = stage_manifest["stage_id"]
    stage_index = stage_manifest["stage_index"]
    for line in raw.splitlines():
        if not line:
            continue
        entry = document(line, "Zarr continuous index entry")
        if entry.get("stage_id") != stage_id or entry.get("stage_index") != stage_index:
            continue
        ref = entry.get("payload_ref")
        if not isinstance(ref, str):
            continue
        parts = ref.split("/")
        coordinate = entry.get("coordinate")
        if len(parts) == 4 and parts[:3] == ["stages", "stage_0000_relax", "table"]:
            try:
                sample = int(parts[3])
            except ValueError:
                continue
            table_coords[sample] = coordinate
        elif len(parts) == 5 and parts[:2] == ["stages", "stage_0000_relax"] and parts[2] == "fields":
            quantity = parts[3]
            if quantity not in field_coords:
                continue
            try:
                sample = int(parts[4])
            except ValueError:
                continue
            field_coords[quantity][sample] = coordinate
    if len(table_coords) != len(table_rows) or set(table_coords) != set(range(len(table_rows))):
        raise HistoryError("Zarr continuous index does not bind every table sample")
    for sample, row in enumerate(table_rows):
        if not _coordinate_matches_table(table_coords[sample], row, columns):
            raise HistoryError("Zarr table row differs from its continuous coordinate")
    final_row = table_rows[-1]
    for quantity, sample_count in field_samples.items():
        coordinates = field_coords.get(quantity, {})
        if len(coordinates) != sample_count or set(coordinates) != set(range(sample_count)):
            raise HistoryError("Zarr continuous index does not bind every field sample")
        if (not _coordinate_matches_table(coordinates[0], table_rows[0], columns)
                or not _coordinate_matches_table(coordinates[sample_count - 1], final_row, columns)):
            raise HistoryError("Initial or final field sample differs from its table coordinate")


def qualify_completed_fem_zarr(root: Path, run_id: str, *, script_sha256: str,
                               expected_device: str, native_build_identity: dict) -> dict:
    """Read and qualify one completed FEM relaxation Zarr tree.

    This checks the stored native completion certificate and all saved scalar
    and field chunks. It does not independently reconstruct or postprocess the
    Poisson residual.
    """
    try:
        if not isinstance(root, Path):
            raise HistoryError("Zarr root must be a pathlib Path")
        if (not isinstance(run_id, str) or not run_id
                or not isinstance(script_sha256, str) or _SHA256.fullmatch(script_sha256) is None
                or expected_device not in {"cpu", "gpu"}):
            raise HistoryError("Zarr qualification identity or requested device is malformed")
        identity = _validate_identity(native_build_identity)
        _strict_directory(root, "Zarr root")
        script_path = root.with_suffix(".py")
        observed_script_sha = _stable_file_sha256(script_path, maximum=8 * 1024 * 1024)
        if observed_script_sha != script_sha256:
            raise HistoryError("Adjacent Python source SHA differs from the requested pin")

        # Existing inventory protects nofollow paths and stable metadata. The
        # additional content inventory hashes every Zarr file, including binary
        # chunks that the activation-history inventory intentionally leaves as
        # size/mtime-only entries.
        before_inventory = tree_inventory(root)
        before_content = _content_tree(root)
        structure = validate_preserved_run(root, run_id)
        output_attempt = "relax-attempt-1"
        output = root / run_id / output_attempt
        autosave = _read_document(output / "relax.autosave.json", "FEM relaxation autosave manifest")
        stages = autosave.get("stages")
        if not isinstance(stages, list) or len(stages) != 1:
            raise HistoryError("FEM Zarr must contain exactly one relaxation stage")
        stage = stages[0]
        if (stage.get("stage_id") != "relax" or stage.get("stage_index") != 0
                or stage.get("complete") is not True):
            raise HistoryError("FEM Zarr stage is not the completed stage_0000_relax")
        completion = stage.get("completion")
        if (not isinstance(completion, dict) or completion.get("status") != "completed"
                or completion.get("converged") is not True):
            raise HistoryError("FEM relaxation stage did not complete and converge")
        if autosave.get("target") != "relax" or autosave.get("format") != "zarr":
            raise HistoryError("FEM Zarr is not a relaxation output")

        run_record = _read_document(output / "fullmag-run.json", "FEM run manifest")
        for label in ("requested", "resolved"):
            execution = run_record.get(label)
            if (not isinstance(execution, dict) or execution.get("backend") != "fem"
                    or execution.get("device") != expected_device):
                raise HistoryError("Terminal run manifest does not match the requested FEM device")

        zarr = output / "relax.zarr"
        stage_dir = zarr / "stages/stage_0000_relax"
        stage_record = _read_document(stage_dir / "manifest.json", "FEM relaxation Zarr manifest")
        if stage_record.get("provenance") != stage.get("provenance"):
            raise HistoryError("Autosave and Zarr stage provenance differ")
        provenance = stage.get("provenance")
        poisson_certificate = _validate_stage_provenance(
            provenance, expected_device=expected_device, native_build_identity=identity)
        expected_completion_identity = {"stage_id": "relax", "stage_index": 0, "target": "relax"}

        table_quantities = stage.get("table_quantities")
        field_quantities = stage.get("field_quantities")
        if (not isinstance(table_quantities, list) or len(set(table_quantities)) != len(table_quantities)
                or not _TABLE_REQUIRED.issubset(table_quantities)
                or not isinstance(field_quantities, list) or len(set(field_quantities)) != len(field_quantities)
                or not _FIELD_REQUIRED.issubset(field_quantities)):
            raise HistoryError("FEM relaxation table or field arrays are missing required quantities")

        table_path = stage_dir / "table"
        table_shape, table_attrs = _array_metadata(table_path, quantity="table", table=True)
        table_samples, table_width = table_shape
        if table_samples < 2 or table_width != len(table_quantities) or table_attrs.get("quantities") != table_quantities:
            raise HistoryError("FEM relaxation table lacks initial and final scalar samples")
        if (table_attrs.get("provenance") != provenance
                or table_attrs.get("completion") != completion
                or table_attrs.get("completion_stage_identity") != expected_completion_identity):
            raise HistoryError("FEM table attributes differ from the completed stage provenance")

        column = {name: index for index, name in enumerate(table_quantities)}
        table_rows = []
        for sample in range(table_samples):
            values = _read_finite_chunk(table_path / (str(sample) + ".0"), width=table_width, collect=True)
            if values is None:
                raise HistoryError("FEM table chunk could not be decoded")
            step = values[column["step"]]
            if step < 0.0 or not step.is_integer() or (sample == 0 and step != 0.0):
                raise HistoryError("FEM relaxation table steps must start at zero and be integers")
            if sample and step <= table_rows[-1][column["step"]]:
                raise HistoryError("FEM relaxation table steps are not strictly increasing")
            energy_sum = math.fsum(values[column[name]] for name in _ENERGY_TERMS)
            total = values[column["e_total"]]
            if not math.isclose(energy_sum, total, rel_tol=1e-12, abs_tol=1e-30):
                raise HistoryError("FEM relaxation table energy terms do not close to e_total")
            table_rows.append(values)

        field_samples = {}
        required_field_width = None
        for quantity in field_quantities:
            field_path = stage_dir / "fields" / quantity
            shape, attrs = _array_metadata(field_path, quantity=quantity)
            samples, width = shape
            if quantity in _FIELD_REQUIRED:
                if width % 3 != 0:
                    raise HistoryError("Required FEM field width is not a sequence of xyz vectors")
                if required_field_width is None:
                    required_field_width = width
                elif width != required_field_width:
                    raise HistoryError("Required FEM field arrays do not share a vector width")
            if quantity in _FIELD_REQUIRED and samples < 2:
                raise HistoryError("Required FEM field lacks initial and final samples")
            if (attrs.get("provenance") != provenance or attrs.get("completion") != completion
                    or attrs.get("completion_stage_identity") != expected_completion_identity):
                raise HistoryError("FEM field attributes differ from the completed stage provenance")
            for sample in range(samples):
                _read_finite_chunk(field_path / (str(sample) + ".0"), width=width)
            field_samples[quantity] = samples

        declared_field_count = stage.get("field_sample_count")
        if type(declared_field_count) is not int or sum(field_samples.values()) != declared_field_count:
            raise HistoryError("FEM field sample counts differ from the stage manifest")
        declared_table_count = stage.get("table_sample_count")
        if type(declared_table_count) is not int or declared_table_count != table_samples:
            raise HistoryError("FEM table sample count differs from the stage manifest")
        _index_coordinates(root, run_id, output_attempt, stage, table_rows, field_samples, column)

        final = table_rows[-1]
        final_torque = final[column["max_torque_T"]]
        if final_torque < 0.0 or final_torque > 1e-8:
            raise HistoryError("Final FEM physical torque exceeds the qualification threshold")
        if (completion.get("metric") == "max_torque_apm"
                and "max_torque" in column):
            metric = completion.get("metric_value")
            if (isinstance(metric, bool) or not isinstance(metric, (int, float))
                    or not math.isfinite(metric)
                    or not math.isclose(float(metric), final[column["max_torque"]],
                                        rel_tol=1e-12, abs_tol=1e-30)):
                raise HistoryError("Stage completion metric differs from the final scalar row")

        after_content = _content_tree(root)
        after_inventory = tree_inventory(root)
        if before_content != after_content or before_inventory != after_inventory:
            raise HistoryError("FEM Zarr changed while its qualification was collected")
        if _stable_file_sha256(script_path, maximum=8 * 1024 * 1024) != observed_script_sha:
            raise HistoryError("Adjacent Python source changed while its Zarr was qualified")

        energies = {name: float(final[column[name]]) for name in (*_ENERGY_TERMS, "e_total")}
        return {
            "schema": SCHEMA,
            "state": "completed-fem-zarr-qualified",
            "zarr_root": str(root),
            "run_id": run_id,
            "structure": structure,
            "script_sha256": observed_script_sha,
            "native_build_identity": identity,
            "device": expected_device,
            "tree_sha256": before_content["sha256"],
            "tree_entries": before_content["entries"],
            "structural_inventory": before_inventory,
            "samples": {"table": table_samples, "fields": field_samples},
            "final": {
                "sample_index": table_samples - 1,
                "step": int(final[column["step"]]),
                "time_s": float(final[column["t"]]),
                "m_avg": [float(final[column[name]]) for name in ("mx", "my", "mz")],
                "energies_j": energies,
                "energy_unit": "J",
                "max_torque_T": float(final_torque),
            },
            "native_demag_certificate": {
                "operator": "fem_poisson_demag",
                "final_residual": poisson_certificate["final_residual"],
                "rtol": poisson_certificate["rtol"],
                "actual_iterations": poisson_certificate["actual_iterations"],
                "max_iterations": poisson_certificate["max_iterations"],
                "residual_source": "saved native completion provenance",
            },
            "limitation": (
                "This reads the saved native FEM Poisson certificate and saved Zarr scalars; "
                "it is not an independent Poisson postprocess."
            ),
        }
    except HistoryError:
        raise
    except (OSError, ValueError, TypeError, KeyError, IndexError, OverflowError, struct.error) as error:
        raise HistoryError("Cannot qualify completed FEM Zarr: " + str(error)) from error


__all__ = ["qualify_completed_fem_zarr"]
