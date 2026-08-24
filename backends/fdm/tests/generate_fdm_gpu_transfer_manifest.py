#!/usr/bin/env python3
"""Generate or check the fail-closed FDM GPU raw-transfer callsite manifest."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


SOURCE_SCOPES = (
    "backends/fdm/gpu/cuda",
    "backends/fdm/api",
    "crates/fullmag-fdm-sys",
    "crates/fullmag-runner/src/fdm/gpu",
)
SOURCE_SUFFIXES = {".c", ".cc", ".cpp", ".cu", ".cuh", ".h", ".hpp", ".rs"}
RAW_APIS = ("cudaMemcpyAsync", "cudaMemcpy")
ALLOWED_MACRO_SHADOWS = {"cudaMemcpy", "cudaMemcpyAsync"}
ALLOWED_WRAPPERS = {
    "fullmag_fdm_receipt_cuda_memcpy",
    "fullmag_fdm_receipt_cuda_memcpy_async",
}
ACCOUNTING_BY_PATH = (
    ("backends/fdm/gpu/cuda/demag/newell_gpu_", "fullmag_fdm_receipt_cuda_memcpy", "setup_tensor"),
    ("backends/fdm/gpu/cuda/runtime/context.cu", "fullmag_fdm_record_cuda_transfer_success", "context_boundary"),
    ("backends/fdm/gpu/cuda/runtime/llg_checkpoint.cpp", "fullmag_fdm_receipt_cuda_memcpy", "checkpoint_observation"),
    ("backends/fdm/gpu/cuda/runtime/reductions_fp64.cu", "fullmag_fdm_record_control_scalar_d2h", "control_scalar"),
    ("backends/fdm/gpu/cuda/transport/charge/device_solver.cu", "transfer_count", "transport_control"),
    ("backends/fdm/gpu/cuda/transport/context.cu", "append_charge_telemetry", "transport_telemetry"),
    ("backends/fdm/gpu/cuda/transport/spin/device_solver.cu", "control_h2d_count", "transport_control"),
    ("backends/fdm/gpu/cuda/transport/spin/sparse_solver.cu", "control_transfer_count", "preconditioner_control"),
)
CROSS_FUNCTION_ACCOUNTING = {
    (
        "backends/fdm/gpu/cuda/transport/context.cu",
        "copy_spin_checkpoint_to_host",
    ): {
        "caller": "checkpoint_export_impl",
        "call": "copy_spin_checkpoint_to_host",
        "call_arguments": (
            "parent",
            "snapshot",
            "&spin_data",
            "&copied_export_bytes",
            "&copied_export_count",
        ),
        "result_arguments": {
            "bytes": "copied_export_bytes",
            "count": "copied_export_count",
        },
        "record": {
            "owner": "append_charge_telemetry",
            "category": "transport_telemetry",
            "slot": "parent",
            "direction": "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H",
            "reason": "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H",
            "status": "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS",
            "flags": "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags",
            "bytes": "copied_export_bytes",
            "count": "copied_export_count",
        },
        "callee_evidence": ("*copied_bytes", "*copied_count"),
    },
    (
        "backends/fdm/gpu/cuda/transport/context.cu",
        "materialize_spin_checkpoint_from_host",
    ): {
        "caller": "checkpoint_import_impl",
        "call": "materialize_spin_checkpoint_from_host",
        "call_arguments": ("parent", "spin_data", "&restored_spin"),
        "result_variable": "status",
        "success_value": "FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK",
        "record": {
            "owner": "append_charge_telemetry",
            "category": "transport_telemetry",
            "slot": "parent",
            "direction": "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D",
            "reason": "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D",
            "status": "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS",
            "flags": "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER",
            "bytes": "import_bytes",
            "count": "4",
        },
        "callee_evidence": (
            "FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR",
            "FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK",
        ),
    },
}
LOCAL_CALLSITE_ACCOUNTING = {
    (
        "backends/fdm/gpu/cuda/transport/spin/device_solver.cu",
        "test_direct_she_signs_device",
    ): {
        "category": "test_observation",
        "hook": "local-test-observation:test_direct_she_signs_device",
        "evidence": (
            "18 * sizeof(double)",
            "cudaFree(device)",
        ),
    },
    (
        "backends/fdm/gpu/cuda/transport/spin/sparse_solver.cu",
        "audit_preconditioner",
    ): {
        "category": "test_observation",
        "hook": "local-test-observation:audit_preconditioner",
        "evidence": (
            "DevicePreconditionerAudit host_result",
            "sizeof(host_result)",
            "metrics->additive_relative_error",
        ),
    },
}


class InventoryError(RuntimeError):
    pass


def fnv1a_64(text: str) -> str:
    value = 14695981039346656037
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"


def mask_noncode(source: str) -> str:
    chars = list(source)
    index = 0
    state = "code"
    while index < len(chars):
        if state == "code":
            if source.startswith("//", index):
                chars[index] = chars[index + 1] = " "
                index += 2
                state = "line_comment"
                continue
            if source.startswith("/*", index):
                chars[index] = chars[index + 1] = " "
                index += 2
                state = "block_comment"
                continue
            if source.startswith('R"', index):
                delimiter_end = source.find("(", index + 2)
                if delimiter_end != -1:
                    delimiter = source[index + 2 : delimiter_end]
                    terminator = ")" + delimiter + '"'
                    end = source.find(terminator, delimiter_end + 1)
                    if end == -1:
                        end = len(source) - len(terminator)
                    for cursor in range(index, min(len(chars), end + len(terminator))):
                        if chars[cursor] != "\n":
                            chars[cursor] = " "
                    index = min(len(chars), end + len(terminator))
                    continue
            if chars[index] in {'"', "'"}:
                quote = chars[index]
                chars[index] = " "
                index += 1
                state = "string" if quote == '"' else "char"
                continue
            index += 1
            continue
        if state == "line_comment":
            if chars[index] == "\n":
                state = "code"
            else:
                chars[index] = " "
            index += 1
            continue
        if state == "block_comment":
            if source.startswith("*/", index):
                chars[index] = chars[index + 1] = " "
                index += 2
                state = "code"
            else:
                if chars[index] != "\n":
                    chars[index] = " "
                index += 1
            continue
        if chars[index] == "\\":
            chars[index] = " "
            if index + 1 < len(chars) and chars[index + 1] != "\n":
                chars[index + 1] = " "
            index += 2
            continue
        if (state == "string" and chars[index] == '"') or (
            state == "char" and chars[index] == "'"
        ):
            chars[index] = " "
            index += 1
            state = "code"
            continue
        if chars[index] != "\n":
            chars[index] = " "
        index += 1
    return "".join(chars)


def mask_preprocessor(masked: str) -> str:
    chars = list(masked)
    offset = 0
    continuation = False
    for line in masked.splitlines(keepends=True):
        stripped = line.lstrip()
        directive = continuation or stripped.startswith("#")
        continuation = directive and line.rstrip("\r\n").rstrip().endswith("\\")
        if directive:
            for index in range(offset, offset + len(line)):
                if chars[index] != "\n":
                    chars[index] = " "
        offset += len(line)
    return "".join(chars)


def normalized(text: str) -> str:
    return re.sub(r"\s+", "", text)


def balanced_end(source: str, opening: int) -> int:
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "(":
            depth += 1
        elif source[index] == ")":
            depth -= 1
            if depth == 0:
                return index + 1
    raise InventoryError("unbalanced transfer call expression")


def function_ranges(masked: str) -> list[tuple[int, int, str, str]]:
    signature = re.compile(
        r"\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?"
        r"(?:noexcept(?:\s*\([^)]*\))?\s*)?(?:->\s*[^;{}]+)?$",
        re.DOTALL,
    )
    controls = {"if", "for", "while", "switch", "catch"}
    stack: list[int] = []
    closes: dict[int, int] = {}
    for cursor, char in enumerate(masked):
        if char == "{":
            stack.append(cursor)
        elif char == "}":
            if stack:
                closes[stack.pop()] = cursor + 1

    ranges: list[tuple[int, int, str, str]] = []
    for opening, end in closes.items():
        prefix = masked[max(0, opening - 4096) : opening].rstrip()
        match = signature.search(prefix)
        if not match:
            continue
        name = match.group(1)
        if name in controls:
            continue
        signature_text = normalized(prefix[match.start() :])
        ranges.append((opening, end, name, f"{name}@{fnv1a_64(signature_text)}"))
    return ranges


def split_arguments(expression: str) -> list[str]:
    opening = expression.find("(")
    inner = expression[opening + 1 : -1]
    arguments: list[str] = []
    start = 0
    paren = bracket = brace = angle = 0
    for index, char in enumerate(inner):
        if char == "(": paren += 1
        elif char == ")": paren -= 1
        elif char == "[": bracket += 1
        elif char == "]": bracket -= 1
        elif char == "{": brace += 1
        elif char == "}": brace -= 1
        elif char == "<": angle += 1
        elif char == ">" and angle: angle -= 1
        elif char == "," and not (paren or bracket or brace or angle):
            arguments.append(inner[start:index].strip())
            start = index + 1
    arguments.append(inner[start:].strip())
    return arguments


def named_calls(source: str, name: str) -> list[tuple[int, int, list[str]]]:
    code = mask_preprocessor(mask_noncode(source))
    calls: list[tuple[int, int, list[str]]] = []
    pattern = re.compile(rf"\b{re.escape(name)}\s*\(")
    for match in pattern.finditer(code):
        opening = code.find("(", match.start(), match.end())
        end = balanced_end(code, opening)
        calls.append((match.start(), end, split_arguments(source[match.start() : end])))
    return calls


def validate_cross_function_accounting(
    path: str,
    function: str,
    function_source: str,
    caller_source: str,
    category: str,
    schema: dict[str, object],
) -> str:
    evidence = tuple(schema["callee_evidence"])
    if any(token not in function_source for token in evidence):
        raise InventoryError(
            f"{path}:{function}: accounting call-chain lost callee evidence"
        )

    call_name = str(schema["call"])
    expected_call_arguments = [
        normalized(str(value)) for value in schema["call_arguments"]
    ]
    matching_calls = [
        call
        for call in named_calls(caller_source, call_name)
        if [normalized(argument) for argument in call[2]] == expected_call_arguments
    ]
    if len(matching_calls) != 1:
        raise InventoryError(
            f"{path}:{function}: accounting call-chain caller lost unique "
            f"{call_name} invocation ({len(matching_calls)} matches)"
        )
    call_start, call_end, _ = matching_calls[0]

    result_variable = schema.get("result_variable")
    if result_variable is not None:
        assignment_prefix = mask_preprocessor(
            mask_noncode(caller_source[max(0, call_start - 256) : call_start])
        )
        assignment = re.compile(rf"\b{re.escape(str(result_variable))}\s*=\s*$")
        if assignment.search(assignment_prefix) is None:
            raise InventoryError(
                f"{path}:{function}: accounting call-chain lost {result_variable} result assignment"
            )

    record = dict(schema["record"])
    if str(record["category"]) != category:
        raise InventoryError(
            f"{path}:{function}: accounting call-chain category does not match record schema"
        )
    record_arguments = [
        str(record[key])
        for key in ("slot", "direction", "reason", "status", "flags", "bytes", "count")
    ]
    expected_record_arguments = [normalized(value) for value in record_arguments]
    matching_records = [
        call
        for call in named_calls(caller_source, str(record["owner"]))
        if call[0] > call_end
        and len(call[2]) >= len(expected_record_arguments)
        and [normalized(argument) for argument in call[2][:7]] == expected_record_arguments
    ]
    if len(matching_records) != 1:
        raise InventoryError(
            f"{path}:{function}: accounting call-chain lost unique post-call "
            f"{record['reason']} record ({len(matching_records)} matches)"
        )
    record_start = matching_records[0][0]

    result_arguments = schema.get("result_arguments")
    if result_arguments is not None:
        for field in ("bytes", "count"):
            if normalized(str(result_arguments[field])) != normalized(str(record[field])):
                raise InventoryError(
                    f"{path}:{function}: accounting record lost callee {field} result"
                )
    if result_variable is not None:
        success_value = re.escape(str(schema["success_value"]))
        result_name = re.escape(str(result_variable))
        guarded_region = mask_preprocessor(
            mask_noncode(caller_source[call_end:record_start])
        )
        guard = re.compile(rf"\bif\s*\(\s*{result_name}\s*!=\s*{success_value}\s*\)")
        if guard.search(guarded_region) is None:
            raise InventoryError(
                f"{path}:{function}: accounting record lost successful {result_variable} guard"
            )

    caller = str(schema["caller"])
    return f"call-chain:{caller}->{record['owner']}"


def direction_for(expression: str) -> str:
    arguments = split_arguments(expression)
    if len(arguments) < 4:
        raise InventoryError(f"transfer call has fewer than four arguments: {expression}")
    classifier = normalized(arguments[3])
    known = {
        "cudaMemcpyHostToDevice": "H2D",
        "cudaMemcpyDeviceToHost": "D2H",
        "cudaMemcpyDeviceToDevice": "D2D",
    }
    if classifier == "cudaMemcpyDefault":
        raise InventoryError("cudaMemcpyDefault is forbidden because direction is implicit")
    return known.get(classifier, f"runtime:{classifier}")


def accounting_for(
    path: str,
    direction: str,
    api: str,
    function: str,
    function_source: str,
    source: str,
    function_sources: dict[str, list[str]],
) -> tuple[str, str]:
    if direction == "D2D":
        return "device_internal", "none_device_internal"
    local_callsite = LOCAL_CALLSITE_ACCOUNTING.get((path, function))
    if local_callsite is not None:
        evidence = tuple(local_callsite["evidence"])
        if any(token not in function_source for token in evidence):
            raise InventoryError(
                f"{path}:{function}: local callsite accounting lost evidence"
            )
        return str(local_callsite["category"]), str(local_callsite["hook"])
    for prefix, owner, category in ACCOUNTING_BY_PATH:
        if path.startswith(prefix):
            if path == "backends/fdm/gpu/cuda/transport/charge/device_solver.cu":
                for candidate in ("output->transfer_count", "copy_boundary"):
                    if candidate in function_source:
                        return category, candidate
            if owner in function_source:
                return category, owner
            if path == "backends/fdm/gpu/cuda/runtime/context.cu" and function not in ALLOWED_WRAPPERS:
                macro = f"#define {api}"
                if macro not in source:
                    raise InventoryError(
                        f"{path}:{function}: transfer lost accounting macro {macro}"
                    )
                return category, f"macro:{api}"
            cross_function = CROSS_FUNCTION_ACCOUNTING.get((path, function))
            if cross_function is not None:
                caller = str(cross_function["caller"])
                caller_sources = function_sources.get(caller, [])
                if len(caller_sources) != 1:
                    raise InventoryError(
                        f"{path}:{function}: accounting call-chain caller {caller} "
                        f"resolved {len(caller_sources)} times"
                    )
                caller_source = caller_sources[0]
                hook = validate_cross_function_accounting(
                    path,
                    function,
                    function_source,
                    caller_source,
                    category,
                    cross_function,
                )
                return category, hook
            raise InventoryError(
                f"{path}:{function}: host-capable transfer lost accounting hook {owner}"
            )
    raise InventoryError(f"{path}: host-capable transfer has no accounting policy ({direction})")


def check_forbidden_surface(source: str, masked: str, path: str) -> None:
    for match in re.finditer(r"(?m)^\s*#\s*define\s+([A-Za-z_]\w*)[^\n]*\b(cudaMemcpy\w*)\b", masked):
        alias, target = match.groups()
        if alias not in ALLOWED_MACRO_SHADOWS or target not in RAW_APIS:
            raise InventoryError(f"{path}: unapproved transfer wrapper alias {alias} -> {target}")
    code = mask_preprocessor(masked)
    for match in re.finditer(r"\b(cudaMemcpyAsync|cudaMemcpy)\b", code):
        if code[match.end():].lstrip().startswith("("):
            continue
        raise InventoryError(
            f"{path}: raw transfer API referenced as alias/function pointer "
            f"{match.group(1)}"
        )
    for match in re.finditer(
        r"\b(?:cudaMemcpy\w+|cuMemcpy\w*|hipMemcpy\w*)\b(?=\s*\()", code
    ):
        token = match.group(0)
        if token not in RAW_APIS:
            raise InventoryError(f"{path}: unclassified transfer API {token}")
    if re.search(r"\bthrust\s*::\s*(?:copy|copy_n|copy_if)\s*\(", code):
        raise InventoryError(f"{path}: unclassified thrust transfer API")


def scan_text(path: str, source: str) -> list[dict[str, object]]:
    masked = mask_noncode(source)
    check_forbidden_surface(source, masked, path)
    code = mask_preprocessor(masked)
    ranges = function_ranges(code)
    function_sources: dict[str, list[str]] = {}
    for start, end, function, _anchor in ranges:
        function_sources.setdefault(function, []).append(source[start:end])
    calls: list[tuple[int, str, str]] = []
    api_pattern = re.compile(r"(?<![A-Za-z0-9_])(cudaMemcpyAsync|cudaMemcpy)\s*\(")
    for match in api_pattern.finditer(code):
        end = balanced_end(code, code.find("(", match.start()))
        calls.append((match.start(), match.group(1), source[match.start() : end]))

    ordinals: dict[tuple[str, str], int] = {}
    entries: list[dict[str, object]] = []
    for position, api, expression in calls:
        enclosing = [item for item in ranges if item[0] < position < item[1]]
        if not enclosing:
            raise InventoryError(f"{path}: {api} call is outside a recognized function")
        start, end, function, anchor = max(enclosing, key=lambda item: item[0])
        ordinal_key = (anchor, api)
        ordinal = ordinals.get(ordinal_key, 0) + 1
        ordinals[ordinal_key] = ordinal
        direction = direction_for(expression)
        category, hook = accounting_for(
            path, direction, api, function, source[start:end], source,
            function_sources,
        )
        call_normalized = normalized(expression)
        entries.append({
            "file": path,
            "function_anchor": anchor,
            "api": api,
            "api_ordinal": ordinal,
            "call_hash": fnv1a_64(call_normalized),
            "direction_classifier": direction,
            "reason": f"{function}:{api}#{ordinal}",
            "category": category,
            "accounting_hook": hook,
        })
    return entries


def scan_repository(root: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for scope in SOURCE_SCOPES:
        for path in sorted((root / scope).rglob("*")):
            if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
                continue
            relative = path.relative_to(root).as_posix()
            entries.extend(scan_text(relative, path.read_text(encoding="utf-8")))
    return sorted(entries, key=lambda item: (
        str(item["file"]), str(item["function_anchor"]), str(item["api"]), int(item["api_ordinal"])
    ))


def assert_manifest_matches(expected: list[dict[str, object]], observed: list[dict[str, object]]) -> None:
    if expected == observed:
        return
    expected_by_key = {(e["file"], e["function_anchor"], e["api"], e["api_ordinal"]): e for e in expected}
    observed_by_key = {(e["file"], e["function_anchor"], e["api"], e["api_ordinal"]): e for e in observed}
    missing = sorted(expected_by_key.keys() - observed_by_key.keys())
    added = sorted(observed_by_key.keys() - expected_by_key.keys())
    changed = sorted(key for key in expected_by_key.keys() & observed_by_key.keys()
                     if expected_by_key[key] != observed_by_key[key])
    raise InventoryError(f"manifest mismatch: added={added[:3]} missing={missing[:3]} changed={changed[:3]}")


def run_mutation_tests() -> None:
    path = "backends/fdm/gpu/cuda/runtime/context.cu"
    baseline = """
void upload(Context &ctx, void *dst, const void *src, size_t bytes, cudaMemcpyKind kind) {
    cudaMemcpy(dst, src, bytes, kind);
    fullmag_fdm_record_cuda_transfer_success(ctx, true, bytes);
}
"""
    expected = scan_text(path, baseline)
    assert len(expected) == 1 and expected[0]["direction_classifier"] == "runtime:kind"
    raw_add = baseline + """
void download(Context &ctx, void *dst, const void *src, size_t bytes) {
    cudaMemcpy(dst, src, bytes, cudaMemcpyDeviceToHost);
    fullmag_fdm_record_cuda_transfer_success(ctx, false, bytes);
}
"""
    try:
        assert_manifest_matches(expected, scan_text(path, raw_add))
    except InventoryError:
        pass
    else:
        raise InventoryError("mutation gate accepted a raw-call addition")
    try:
        assert_manifest_matches([], scan_text(path, baseline))
    except InventoryError:
        pass
    else:
        raise InventoryError("mutation gate accepted a new-file variable-direction raw call")
    try:
        scan_text(path, baseline.replace("fullmag_fdm_record_cuda_transfer_success", "unaccounted"))
    except InventoryError:
        pass
    else:
        raise InventoryError("mutation gate accepted accounted-to-unaccounted call")
    for field in ("direction_classifier", "reason", "category"):
        mutation = [dict(expected[0])]
        mutation[0][field] = "mutated"
        try:
            assert_manifest_matches(mutation, expected)
        except InventoryError:
            pass
        else:
            raise InventoryError(f"mutation gate accepted changed {field}")
    ignored = scan_text(path, '// cudaMemcpy(a,b,c,kind)\nconst char *s = "hipMemcpy";\n')
    if ignored:
        raise InventoryError("scanner treated a comment/string as a raw call")
    for forbidden in (
        "void f(){ cudaMemcpy2D(a,b,c,d,e,f,g); }",
        "void f(){ hipMemcpy(a,b,c,d); }",
        "#define hidden_copy cudaMemcpy\nvoid f(){ hidden_copy(a,b,c,d); }",
        "void f(){ auto hidden_copy = cudaMemcpy; hidden_copy(a,b,c,d); }",
        "void f(){ auto hidden_copy = cudaMemcpyAsync; hidden_copy(a,b,c,d,e); }",
        "void f(){ thrust::copy(a,b,c); }",
    ):
        try:
            scan_text("backends/fdm/gpu/cuda/test.cu", forbidden)
        except InventoryError:
            pass
        else:
            raise InventoryError(f"scanner accepted forbidden transfer surface: {forbidden}")
    export_record = """
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER | checkpoint_flags,
        copied_export_bytes, copied_export_count, 0, 0, 0, nullptr);
"""
    import_record = """
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_H2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_TRANSFER,
        import_bytes, 4, 0, 0, 0, nullptr);
"""
    cross_function_source = """
bool copy_spin_checkpoint_to_host(
    void *destination, const void *source, uint64_t bytes,
    uint64_t *copied_bytes, uint64_t *copied_count) {
    if (cudaMemcpyAsync(destination, source, bytes, cudaMemcpyDeviceToHost,
                        stream) != cudaSuccess)
        return false;
    *copied_bytes += bytes;
    ++*copied_count;
    return true;
}

uint32_t checkpoint_export_impl() {
    uint64_t copied_export_bytes = 0;
    uint64_t copied_export_count = 0;
    if (include_spin && !copy_spin_checkpoint_to_host(
            parent, snapshot, &spin_data, &copied_export_bytes,
            &copied_export_count))
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
""" + export_record + """
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION,
        0, 1, 0, 0, 0, nullptr);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

uint32_t materialize_spin_checkpoint_from_host(
    void *destination, const void *source, uint64_t bytes) {
    if (cudaMemcpyAsync(destination, source, bytes, cudaMemcpyHostToDevice,
                        stream) != cudaSuccess)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_CUDA_RUNTIME_ERROR;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

uint32_t checkpoint_import_impl() {
    uint32_t status = materialize_spin_checkpoint_from_host(
        parent, spin_data, &restored_spin);
    if (status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        return status;
    uint64_t import_bytes = bytes;
""" + import_record + """
    append_charge_telemetry(
        parent, FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_DIRECTION_DEVICE_INTERNAL,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STREAM_SYNCHRONIZE,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS,
        FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_SYNCHRONIZATION,
        0, 1, 0, 0, 0, nullptr);
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}
"""
    context_path = "backends/fdm/gpu/cuda/transport/context.cu"
    cross_expected = scan_text(context_path, cross_function_source)
    if len(cross_expected) != 2:
        raise InventoryError("cross-function fixture did not inventory export and import")

    cross_mutations = {
        "missing export record": cross_function_source.replace(export_record, "", 1),
        "wrong export reason": cross_function_source.replace(
            "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_EXPORT_D2H",
            "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_SCALAR_REDUCTION_D2H",
            1,
        ),
        "wrong export variables": cross_function_source.replace(
            "copied_export_bytes, copied_export_count, 0, 0, 0, nullptr",
            "unrelated_bytes, unrelated_count, 0, 0, 0, nullptr",
            1,
        ),
        "wrong export result argument": cross_function_source.replace(
            "&copied_export_count))",
            "&unrelated_export_count))",
            1,
        ),
        "duplicate export record": cross_function_source.replace(
            export_record,
            export_record + export_record,
            1,
        ),
        "missing import record": cross_function_source.replace(import_record, "", 1),
        "wrong import reason": cross_function_source.replace(
            "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_CHECKPOINT_IMPORT_H2D",
            "FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_REASON_STATIC_UPLOAD_H2D",
            1,
        ),
        "wrong import variables": cross_function_source.replace(
            "import_bytes, 4, 0, 0, 0, nullptr",
            "unrelated_bytes, unrelated_count, 0, 0, 0, nullptr",
            1,
        ),
        "wrong import result variable": cross_function_source.replace(
            "uint32_t status = materialize_spin_checkpoint_from_host(",
            "uint32_t unrelated_status = materialize_spin_checkpoint_from_host(",
            1,
        ),
    }
    for label, mutation in cross_mutations.items():
        try:
            scan_text(context_path, mutation)
        except InventoryError:
            pass
        else:
            raise InventoryError(f"scanner accepted cross-function mutation: {label}")
    print(
        "FDM GPU raw-transfer mutations: PASS "
        "(raw-add, new-file-variable, accounted-to-unaccounted, "
        "direction, reason, category, alternate-api, wrapper-alias, "
        "function-pointer-alias, cross-function-record)"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--emit", action="store_true")
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    root = (args.root or Path(__file__).resolve().parents[2]).resolve()
    manifest = args.manifest or root / "backends/fdm/tests/fdm_gpu_host_transfer_callsites_v1.json"
    try:
        if args.self_test:
            run_mutation_tests()
        observed = scan_repository(root)
        if args.emit:
            json.dump(observed, sys.stdout, indent=2)
            sys.stdout.write("\n")
        elif args.write:
            manifest.write_text(json.dumps(observed, indent=2) + "\n", encoding="utf-8")
            print(f"Wrote {len(observed)} callsites to {manifest}")
        else:
            expected = json.loads(manifest.read_text(encoding="utf-8"))
            assert_manifest_matches(expected, observed)
            print(f"FDM GPU raw-transfer manifest: PASS ({len(observed)} callsites)")
    except (InventoryError, OSError, json.JSONDecodeError) as error:
        print(f"FDM GPU raw-transfer manifest: FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
