"""Bounded structural validation for a preserved accepted project output."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat

from docker_activation_history_policy import HistoryError, document
from docker_activation_history_storage import _directory, _raw
from docker_activation_history_inventory import MAX_INVENTORY_ENTRIES, tree_inventory


# Two existing single-attempt output contracts. Do not discover arbitrary
# directories or rename a preserved result to make it fit a fixture layout.
OUTPUT_LAYOUTS = {"reversal-attempt-1": "main", "relax-attempt-1": "relax"}
MAX_METADATA_BYTES = 32 * 1024 * 1024
MAX_STAGES = 4096
MAX_OUTPUTS = 200
MAX_INDEX_ENTRIES = 1_000_000
MAX_ARRAY_SAMPLES = MAX_INVENTORY_ENTRIES
_RUN_ID = re.compile(r"run-[A-Za-z0-9][A-Za-z0-9._-]{0,200}\Z")
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def _require(condition, message):
    if not condition:
        raise HistoryError(message)


def _read_document(path, label):
    return document(_raw(path), label)


def _zarr_group(path, *, schema_version=None, target=None, require_attrs=True):
    path = _directory(path)
    group = _read_document(path / ".zgroup", "Zarr group metadata")
    attrs_path = path / ".zattrs"
    attrs = _read_document(attrs_path, "Zarr attributes") if attrs_path.exists() or attrs_path.is_symlink() else {}
    if require_attrs and not attrs_path.exists():
        raise HistoryError("Preserved Zarr group has no attributes metadata")
    _require(group.get("zarr_format") == 2, "Preserved output is not a Zarr v2 group")
    if schema_version is not None:
        _require(attrs.get("schema_version") == schema_version,
                 "Preserved Zarr group schema differs")
    if target is not None:
        _require(attrs.get("target") == target, "Preserved Zarr target differs")
    return attrs


def _bounded_inventory(root):
    """Bound path count and readable metadata before hashing a Zarr tree."""
    root = _directory(root)
    entries = 0
    metadata_bytes = 0

    def fail_walk(error):
        raise HistoryError("Cannot inventory preserved run: " + str(error))

    for parent, directories, files in os.walk(root, followlinks=False, onerror=fail_walk):
        for name in sorted(directories + files):
            path = Path(parent) / name
            info = path.lstat()
            entries += 1
            if entries > MAX_INVENTORY_ENTRIES:
                raise HistoryError("Preserved run inventory exceeds its path budget")
            if stat.S_ISDIR(info.st_mode):
                _directory(path)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                if (name.endswith((".json", ".py")) or name in {".zgroup", ".zattrs", ".zarray"}):
                    if info.st_size > 8 * 1024 * 1024:
                        raise HistoryError("Preserved run metadata exceeds its per-file budget")
                    metadata_bytes += info.st_size
                    if metadata_bytes > MAX_METADATA_BYTES:
                        raise HistoryError("Preserved run metadata exceeds its total budget")
            else:
                raise HistoryError("Preserved run contains a link or special file")
    return entries, metadata_bytes


def _regular_file(path):
    path = Path(path)
    _directory(path.parent)
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or path.resolve(strict=True) != path):
        raise HistoryError("Preserved output path is linked or not a regular file: " + path.name)
    return info


def _run_output_path(output_root, raw):
    if (not isinstance(raw, str) or not raw or "\\" in raw or "\x00" in raw or ":" in raw):
        raise HistoryError("Preserved run output path is malformed")
    relative = PurePosixPath(raw)
    if (relative.is_absolute() or str(relative) != raw
            or any(part in {"", ".", ".."} for part in relative.parts)):
        raise HistoryError("Preserved run output path is not canonical and relative")
    path = output_root.joinpath(*relative.parts)
    if path.is_symlink():
        raise HistoryError("Preserved run output path is linked")
    return path


def _output_directory(path):
    return _directory(path)


def _output_file(path):
    return _regular_file(path)


def _check_output_declarations(output_root, outputs, target):
    _require(isinstance(outputs, list) and 0 < len(outputs) <= MAX_OUTPUTS,
             "Terminal run has no bounded declared outputs")
    declarations = {}
    file_kinds = {"metadata", "table", "field", "sequence_manifest", "storage_receipt",
                  "autosave_manifest", "hdf5"}
    for entry in outputs:
        _require(isinstance(entry, dict) and set(entry) >= {"path", "kind"},
                 "Terminal run output declaration is malformed")
        raw_path, kind = entry.get("path"), entry.get("kind")
        _require(isinstance(kind, str) and kind in file_kinds | {"zarr_store"},
                 "Terminal run declares an unknown output kind")
        path = _run_output_path(output_root, raw_path)
        _require(raw_path not in declarations, "Terminal run declares a duplicate output path")
        if kind == "zarr_store":
            _output_directory(path)
            _zarr_group(path, require_attrs=False)
        else:
            _output_file(path)
        declarations[raw_path] = kind
    required = {f"{target}.autosave.json": "autosave_manifest", f"{target}.zarr": "zarr_store",
                "output-storage.json": "storage_receipt"}
    _require(all(declarations.get(path) == kind for path, kind in required.items()),
             "Terminal run does not declare its autosave, Zarr and storage receipt")
    return declarations


def _array(path, *, samples, width=None, quantities=None, dimension_order=None):
    path = _directory(path)
    metadata = _read_document(path / ".zarray", "Zarr array metadata")
    shape = metadata.get("shape")
    chunks = metadata.get("chunks")
    if (not isinstance(shape, list) or len(shape) != 2
            or type(shape[0]) is not int or type(shape[1]) is not int
            or shape[0] != samples or shape[0] < 0 or shape[0] > MAX_ARRAY_SAMPLES or shape[1] <= 0
            or samples > MAX_ARRAY_SAMPLES
            or (width is not None and shape[1] != width)
            or not isinstance(chunks, list) or len(chunks) != 2
            or chunks != [1, max(shape[1], 1)]
            or metadata.get("zarr_format") != 2 or metadata.get("dtype") != "<f8"
            or metadata.get("compressor") is not None or metadata.get("fill_value") is not None
            or metadata.get("order") != "C" or metadata.get("filters") is not None
            or metadata.get("dimension_separator") != "."):
        raise HistoryError("Preserved Zarr array metadata differs from the autosave contract")
    attrs = _read_document(path / ".zattrs", "Zarr array attributes")
    if quantities is not None:
        _require(attrs.get("quantities") == quantities and attrs.get("dimension_order") == dimension_order,
                 "Preserved table array attributes differ from its stage manifest")
    elif dimension_order is not None:
        _require(attrs.get("dimension_order") == dimension_order,
                 "Preserved field array dimension order differs")
    expected_chunks = {str(index) + ".0" for index in range(samples)}
    names = {entry.name for entry in path.iterdir()}
    _require(names == expected_chunks | {".zarray", ".zattrs"},
             "Preserved Zarr array has missing or unexpected chunks")
    for name in expected_chunks:
        chunk = path / name
        info = _regular_file(chunk)
        if info.st_size != shape[1] * 8:
            raise HistoryError("Preserved Zarr chunk size differs from its array shape")
    return {"samples": shape[0], "width": shape[1]}


def _safe_stage(stage):
    if not isinstance(stage, dict):
        raise HistoryError("Autosave stage declaration is malformed")
    stage_id = stage.get("stage_id")
    stage_index = stage.get("stage_index")
    if (not isinstance(stage_id, str) or _TOKEN.fullmatch(stage_id) is None
            or type(stage_index) is not int or stage_index < 0):
        raise HistoryError("Autosave stage identity is malformed")
    return f"stage_{stage_index:04d}_{stage_id}"


def _stage_metadata(main_zarr, autosave, target):
    if (autosave.get("schema_version") != "fullmag.stage_autosave.artifact.v1"
            or autosave.get("target") != target or autosave.get("format") != "zarr"
            or autosave.get("layout") not in {"continuous", "separate"}):
        raise HistoryError("Autosave artifact metadata is not a supported Zarr target")
    stages = autosave.get("stages")
    if not isinstance(stages, list) or not stages or len(stages) > MAX_STAGES:
        raise HistoryError("Autosave artifact has no bounded completed stages")
    layout = autosave["layout"]
    _zarr_group(main_zarr, schema_version="fullmag.stage_autosave.v1", target=target)
    stages_root = main_zarr / "stages"
    _zarr_group(stages_root, require_attrs=False)
    expected_dirs = set()
    by_index = {}
    total_samples = 0
    total_table = 0
    total_fields = 0
    field_counts = {}
    for stage in stages:
        stage_name = _safe_stage(stage)
        if stage.get("schema_version") != "stage_autosave.v1" or stage.get("target") != target:
            raise HistoryError("Autosave stage schema or target differs")
        if stage.get("format") != "zarr" or stage.get("layout") != layout or stage.get("complete") is not True:
            raise HistoryError("Autosave stage is incomplete or its layout differs")
        if stage["stage_index"] in by_index:
            raise HistoryError("Autosave artifact repeats a stage index")
        table_quantities, field_quantities = stage.get("table_quantities"), stage.get("field_quantities")
        if (not isinstance(table_quantities, list) or not isinstance(field_quantities, list)
                or any(not isinstance(value, str) or _TOKEN.fullmatch(value) is None
                       for value in table_quantities + field_quantities)
                or len(set(table_quantities)) != len(table_quantities)
                or len(set(field_quantities)) != len(field_quantities)):
            raise HistoryError("Autosave stage quantities are malformed")
        table_count, field_count = stage.get("table_sample_count"), stage.get("field_sample_count")
        if (type(table_count) is not int or table_count < 0
                or type(field_count) is not int or field_count < 0
                or not table_quantities and table_count != 0
                or not field_quantities and field_count != 0):
            raise HistoryError("Autosave stage sample counts do not match declared quantities")
        stage_dir = stages_root / stage_name
        _zarr_group(stage_dir, require_attrs=False)
        stage_record = _read_document(stage_dir / "manifest.json", "Autosave stage manifest")
        stage_core = {key: value for key, value in stage.items() if key != "provenance"}
        record_core = {key: value for key, value in stage_record.items() if key != "provenance"}
        _require(record_core == stage_core,
                 "Autosave stage identity or array declaration differs from the Zarr stage manifest")
        expected_dirs.add(stage_name)
        by_index[stage["stage_index"]] = stage
        total_samples += table_count + field_count
        total_table += table_count
        total_fields += field_count
        field_counts[stage_name] = {quantity: 0 for quantity in field_quantities}
        if table_quantities:
            _array(stage_dir / "table", samples=table_count, width=len(table_quantities),
                   quantities=table_quantities, dimension_order=["sample", "quantity"])
        elif (stage_dir / "table").exists() or (stage_dir / "table").is_symlink():
            raise HistoryError("Undeclared table array is present")
        fields_root = stage_dir / "fields"
        if field_quantities:
            _zarr_group(fields_root, require_attrs=False)
            for quantity in field_quantities:
                quantity_path = fields_root / quantity
                if quantity_path.exists() or quantity_path.is_symlink():
                    _require(not quantity_path.is_symlink(), "Preserved field array is linked")
                    array_meta_path = quantity_path / ".zarray"
                    array_meta = _read_document(array_meta_path, "Zarr field array metadata")
                    shape = array_meta.get("shape")
                    if not isinstance(shape, list) or len(shape) != 2 or type(shape[0]) is not int:
                        raise HistoryError("Preserved field array shape is malformed")
                    _array(quantity_path, samples=shape[0], width=shape[1],
                           dimension_order=["sample", "value"])
                    attrs = _read_document(quantity_path / ".zattrs", "Zarr field attributes")
                    _require(attrs.get("quantity") == quantity,
                             "Preserved field quantity differs from its stage manifest")
                    field_counts[stage_name][quantity] = shape[0]
            if sum(field_counts[stage_name].values()) != field_count:
                raise HistoryError("Preserved field arrays do not account for the stage samples")
            actual_field_dirs = {entry.name for entry in fields_root.iterdir() if entry.is_dir()}
            _require(actual_field_dirs == {name for name, count in field_counts[stage_name].items() if count > 0},
                     "Preserved field directories differ from sampled quantities")
        elif fields_root.exists() or fields_root.is_symlink():
            raise HistoryError("Undeclared field arrays are present")
    actual_stage_dirs = {entry.name for entry in stages_root.iterdir() if entry.is_dir()}
    _require(actual_stage_dirs == expected_dirs, "Zarr stages differ from the autosave artifact manifest")
    return {"layout": layout, "stages": by_index, "stage_dirs": expected_dirs,
            "table_sample_count": total_table, "field_sample_count": total_fields,
            "sample_count": total_samples, "field_counts": field_counts}


def _continuous_index(main_zarr, stage_info):
    if stage_info["layout"] != "continuous":
        _require(not (main_zarr / "continuous").exists(),
                 "Separate autosave layout has an unexpected continuous index")
        return {"entries": 0, "sha256": None}
    continuous = main_zarr / "continuous"
    attrs = _zarr_group(continuous)
    if attrs.get("payload_policy") != "references_only" or attrs.get("index") != "index.jsonl":
        raise HistoryError("Continuous Zarr metadata differs from the reference-only contract")
    raw = _raw(continuous / "index.jsonl")
    lines = raw.splitlines()
    if len(lines) > MAX_INDEX_ENTRIES:
        raise HistoryError("Continuous Zarr index exceeds its entry budget")
    target_index = 0
    table_counts = {index: 0 for index in stage_info["stages"]}
    field_stage_counts = {index: 0 for index in stage_info["stages"]}
    field_quantity_counts = {name: {quantity: 0 for quantity in counts}
                             for name, counts in stage_info["field_counts"].items()}
    for line in lines:
        if not line:
            continue
        entry = document(line, "Continuous Zarr index entry")
        stage_index = entry.get("stage_index")
        stage = stage_info["stages"].get(stage_index)
        if (stage is None or entry.get("stage_id") != stage.get("stage_id")
                or type(entry.get("target_sample_index")) is not int
                or entry["target_sample_index"] != target_index):
            raise HistoryError("Continuous Zarr sample index differs from its stage")
        target_index += 1
        sample_kind = entry.get("sample_kind")
        stage_name = _safe_stage(stage)
        stage_sample = entry.get("stage_sample_index")
        if type(stage_sample) is not int or stage_sample < 0:
            raise HistoryError("Continuous Zarr stage sample index is malformed")
        coordinate = entry.get("coordinate")
        if not isinstance(coordinate, dict):
            raise HistoryError("Continuous Zarr coordinate is malformed")
        if coordinate.get("kind") == "physical_time":
            value = coordinate.get("time_s")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise HistoryError("Continuous Zarr time coordinate is malformed")
        elif coordinate.get("kind") == "accepted_step":
            if type(coordinate.get("accepted_step")) is not int or coordinate["accepted_step"] < 0:
                raise HistoryError("Continuous Zarr step coordinate is malformed")
        else:
            raise HistoryError("Continuous Zarr coordinate kind is unknown")
        payload_ref = entry.get("payload_ref")
        ref = PurePosixPath(payload_ref) if isinstance(payload_ref, str) else PurePosixPath("/")
        if ref.is_absolute() or str(ref) != payload_ref or ".." in ref.parts:
            raise HistoryError("Continuous Zarr payload reference is not canonical")
        parts = ref.parts
        if sample_kind == "table":
            expected_sample = table_counts[stage_index]
            if stage_sample != expected_sample or expected_sample >= stage["table_sample_count"]:
                raise HistoryError("Continuous table sample count differs from its stage")
            expected_ref = ("stages", stage_name, "table", str(expected_sample))
            table_counts[stage_index] += 1
        elif sample_kind == "field":
            expected_field_stage_sample = field_stage_counts[stage_index]
            if stage_sample != expected_field_stage_sample or expected_field_stage_sample >= stage["field_sample_count"]:
                raise HistoryError("Continuous field sample count differs from its stage")
            if len(parts) != 5 or parts[:3] != ("stages", stage_name, "fields"):
                raise HistoryError("Continuous field payload reference is malformed")
            quantity = parts[3]
            if quantity not in stage_info["field_counts"][stage_name]:
                raise HistoryError("Continuous field references an undeclared quantity")
            local_sample = field_quantity_counts[stage_name][quantity]
            expected_ref = ("stages", stage_name, "fields", quantity, str(local_sample))
            field_quantity_counts[stage_name][quantity] += 1
            field_stage_counts[stage_index] += 1
        else:
            raise HistoryError("Continuous Zarr sample kind is unknown")
        if parts != expected_ref:
            raise HistoryError("Continuous Zarr payload reference differs from its sample identity")
        array_path = main_zarr.joinpath(*parts[:-1])
        array_metadata = _read_document(array_path / ".zarray", "Referenced Zarr array metadata")
        width = array_metadata.get("shape", [None, None])[1]
        if type(width) is not int or width <= 0:
            raise HistoryError("Referenced Zarr array width is malformed")
        chunk = main_zarr.joinpath(*parts).with_name(parts[-1] + ".0")
        if _regular_file(chunk).st_size != width * 8:
            raise HistoryError("Continuous Zarr payload chunk size differs from its array")
    if target_index != stage_info["sample_count"]:
        raise HistoryError("Continuous Zarr index does not cover all declared samples")
    for index, stage in stage_info["stages"].items():
        name = _safe_stage(stage)
        if (table_counts[index] != stage["table_sample_count"]
                or field_stage_counts[index] != stage["field_sample_count"]
                or field_quantity_counts[name] != stage_info["field_counts"][name]):
            raise HistoryError("Continuous Zarr index and stage sample counts differ")
    return {"entries": target_index, "sha256": hashlib.sha256(raw).hexdigest()}


def _validate_preserved_run(zarr: Path, run_id: str) -> dict:
    """Prove a terminal, nonempty project output and its declared Zarr payloads.

    The proof is structural. It authenticates document/path/sample bindings and
    checks chunk presence and byte lengths without reading or judging scientific
    field values.
    """
    zarr = _directory(Path(zarr))
    if not isinstance(run_id, str) or _RUN_ID.fullmatch(run_id) is None:
        raise HistoryError("Preserved run identity is malformed")
    _zarr_group(zarr)
    run_root = _directory(zarr / run_id)
    _zarr_group(run_root)
    direct_entries = {entry.name for entry in run_root.iterdir()}
    attempts = direct_entries - {".zgroup", ".zattrs"}
    _require({".zgroup", ".zattrs"}.issubset(direct_entries) and len(attempts) == 1,
             "Preserved run has an unsupported output-attempt layout")
    output_attempt = next(iter(attempts))
    _require(output_attempt in OUTPUT_LAYOUTS,
             "Preserved run has an unsupported output-attempt layout")
    target = OUTPUT_LAYOUTS[output_attempt]
    output_root = _directory(run_root / output_attempt)
    output_attrs = _zarr_group(output_root, schema_version="fullmag.project_results.v1")

    before_entries, before_metadata_bytes = _bounded_inventory(run_root)
    before_inventory = tree_inventory(run_root)
    run_record = _read_document(output_root / "run.json", "Accepted project output receipt")
    resolved = run_record.get("resolved_output_storage")
    receipt_directory = run_record.get("attempt_receipt_directory")
    if run_record.get("schema") != "fullmag.accepted_project_output.v1" or not isinstance(resolved, dict):
        raise HistoryError("Accepted project output receipt schema differs")
    receipt_path = PurePosixPath(receipt_directory) if isinstance(receipt_directory, str) else PurePosixPath(".")
    if (not receipt_path.is_absolute() or str(receipt_path) != receipt_directory
            or ".." in receipt_path.parts or "\\" in receipt_directory or "\x00" in receipt_directory):
        raise HistoryError("Accepted project attempt receipt path is not canonical")
    run_locations = [index for index, part in enumerate(receipt_path.parts)
                     if part == "runs" and index + 2 < len(receipt_path.parts)
                     and receipt_path.parts[index + 1] == run_id
                     and receipt_path.parts[index + 2] == "worker-attempts"]
    if len(run_locations) != 1:
        raise HistoryError("Accepted project attempt receipt does not bind the preserved run")

    output_dir = resolved.get("output_dir")
    output_posix = PurePosixPath(output_dir) if isinstance(output_dir, str) else PurePosixPath(".")
    if (not output_posix.is_absolute() or str(output_posix) != output_dir
            or not str(output_posix).startswith("/user-data/") or ".." in output_posix.parts
            or "\\" in output_dir or "\x00" in output_dir
            or output_posix.parts[-3:] != (zarr.name, run_id, output_attempt)):
        raise HistoryError("Accepted project output path does not bind this preserved Zarr run")
    terminal_run_id = resolved.get("run_id")
    if not isinstance(terminal_run_id, str) or not terminal_run_id or "/" in terminal_run_id or "\\" in terminal_run_id:
        raise HistoryError("Accepted project terminal run identity is malformed")

    storage = _read_document(output_root / "output-storage.json", "Output storage receipt")
    if (storage.get("schema") != "fullmag.output_storage.resolved.v1"
            or storage.get("state") != "succeeded" or storage.get("resolved") != resolved
            or resolved.get("run_id") != terminal_run_id or resolved.get("data_format") != "zarr"):
        raise HistoryError("Output storage receipt does not bind the accepted run")
    temp_dir = resolved.get("temp_dir")
    temp_posix = PurePosixPath(temp_dir) if isinstance(temp_dir, str) else PurePosixPath(".")
    if (resolved.get("cleanup") not in {"on_success", "always", "never"}
            or not temp_posix.is_absolute() or str(temp_posix) != temp_dir
            or not str(temp_posix).startswith("/user-data/") or ".." in temp_posix.parts
            or "\\" in temp_dir or "\x00" in temp_dir):
        raise HistoryError("Output storage temporary path or cleanup policy is malformed")
    fullmag_run = _read_document(output_root / "fullmag-run.json", "Terminal Fullmag run manifest")
    exit_code = fullmag_run.get("exit_code")
    source = fullmag_run.get("source")
    if (fullmag_run.get("schema") != "fullmag.run_manifest.v1"
            or fullmag_run.get("status") != "completed"
            or (exit_code is not None and (type(exit_code) is not int or exit_code != 0))
            or fullmag_run.get("error") not in (None, "")
            or fullmag_run.get("run_id") != terminal_run_id
            or not isinstance(source, dict) or source.get("kind") != "project"
            or not isinstance(source.get("project_id"), str) or not source.get("project_id")
            or type(source.get("revision")) is not int or source["revision"] < 0
            or not isinstance(source.get("sha256"), str)
            or re.fullmatch(r"[0-9a-f]{64}", source["sha256"]) is None
            or not isinstance(fullmag_run.get("started_at"), str) or not fullmag_run["started_at"]
            or not isinstance(fullmag_run.get("finished_at"), str) or not fullmag_run["finished_at"]):
        raise HistoryError("Preserved Fullmag run manifest is not terminal or bound")
    session_id = fullmag_run.get("session_id")
    if session_id is not None and (not isinstance(session_id, str) or not session_id):
        raise HistoryError("Accepted project session identity is malformed")

    declarations = _check_output_declarations(output_root, fullmag_run.get("outputs"), target)
    autosave = _read_document(output_root / f"{target}.autosave.json", "Autosave artifact manifest")
    main_zarr = output_root / f"{target}.zarr"
    stage_info = _stage_metadata(main_zarr, autosave, target)
    if stage_info["sample_count"] == 0:
        raise HistoryError("Preserved run has no terminal autosave samples")
    index_proof = _continuous_index(main_zarr, stage_info)
    run_stages = fullmag_run.get("stages")
    if not isinstance(run_stages, list) or not run_stages or len(run_stages) > MAX_STAGES:
        raise HistoryError("Terminal Fullmag stage summaries are missing or unbounded")
    for row in run_stages:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise HistoryError("Terminal Fullmag stage summary is malformed")
    _require(any(row["id"] == output_attempt for row in run_stages),
             "Terminal Fullmag manifest does not bind the preserved output attempt")

    after_entries, after_metadata_bytes = _bounded_inventory(run_root)
    after_inventory = tree_inventory(run_root)
    if (before_entries != after_entries or before_metadata_bytes != after_metadata_bytes
            or before_inventory != after_inventory):
        raise HistoryError("Preserved run changed while its output proof was collected")
    return {
        "run_id": run_id,
        "terminal_run_id": terminal_run_id,
        "output_dir": output_dir,
        "declared_outputs": len(declarations),
        "autosave": {key: stage_info[key] for key in
                     ("layout", "table_sample_count", "field_sample_count", "sample_count")},
        "continuous_index": index_proof,
        "root_zarr_metadata": {"zgroup_sha256": hashlib.sha256(
            _raw(zarr / ".zgroup")).hexdigest(), "zattrs_sha256": hashlib.sha256(
            _raw(zarr / ".zattrs")).hexdigest()},
        "run_inventory": after_inventory,
        "run_inventory_entries": after_entries,
        "metadata_bytes": after_metadata_bytes,
        "attempt_attributes": output_attrs,
    }


def validate_preserved_run(zarr: Path, run_id: str) -> dict:
    try:
        return _validate_preserved_run(zarr, run_id)
    except HistoryError:
        raise
    except (OSError, ValueError, TypeError, IndexError, KeyError, OverflowError) as error:
        raise HistoryError("Cannot validate preserved terminal output: " + str(error)) from error


__all__ = ["validate_preserved_run"]
