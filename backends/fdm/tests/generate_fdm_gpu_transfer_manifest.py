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
        "call": "copy_spin_checkpoint_to_host(",
        "owner": "append_charge_telemetry(",
        "callee_evidence": ("*copied_bytes", "*copied_count"),
    },
    (
        "backends/fdm/gpu/cuda/transport/context.cu",
        "materialize_spin_checkpoint_from_host",
    ): {
        "caller": "checkpoint_import_impl",
        "call": "materialize_spin_checkpoint_from_host(",
        "owner": "append_charge_telemetry(",
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
                call = str(cross_function["call"])
                cross_owner = str(cross_function["owner"])
                evidence = tuple(cross_function["callee_evidence"])
                if caller_source.count(call) != 1 or cross_owner not in caller_source:
                    raise InventoryError(
                        f"{path}:{function}: accounting call-chain {caller} lost "
                        f"call or owner {cross_owner}"
                    )
                if any(token not in function_source for token in evidence):
                    raise InventoryError(
                        f"{path}:{function}: accounting call-chain lost callee evidence"
                    )
                return category, f"call-chain:{caller}->{cross_owner[:-1]}"
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
    cross_function_owner = """
void accounted(Context &ctx) {
    fullmag_fdm_record_cuda_transfer_success(ctx, true, 1);
}
void unaccounted(void *dst, const void *src, size_t bytes) {
    cudaMemcpy(dst, src, bytes, cudaMemcpyDeviceToHost);
}
"""
    try:
        scan_text(path, cross_function_owner)
    except InventoryError:
        pass
    else:
        raise InventoryError("scanner accepted an owner from an unrelated function")
    print(
        "FDM GPU raw-transfer mutations: PASS "
        "(raw-add, new-file-variable, accounted-to-unaccounted, "
        "direction, reason, category, alternate-api, wrapper-alias, "
        "function-pointer-alias, cross-function-owner)"
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
