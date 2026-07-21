#!/usr/bin/env python3
"""Semantic source guard for generation-only FEM step updates."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re


STEP = re.compile(r"(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*::)*StepUpdate\s*\{")
PRODUCER = re.compile(
    r"(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*::)*(?P<operation>"
    r"FemMeshPayload::from(?:_[A-Za-z0-9_]+)?|"
    r"StageFemMeshAsset::build_from_[A-Za-z0-9_]+|"
    r"StageFemMeshIdentity::from_(?:fem|eigen|frequency_response|backend)_plan|"
    r"FemStageExecutionContext::from_backend_plan|"
    r"fem_(?:plan|eigen|frequency_response)_mesh_generation_id"
    r")\s*\("
)

# SHA-256 over sorted exact records: file, receiver, operation, normalized
# containing statement. This pins all semantic occurrences, not aggregate counts.
EXPECTED_MESH_ACCESS_INVENTORY_SHA256 = "eec0964c7cef2e28b6431679219bb64755e757657a63e0a3ce28be737e69bea3"
EXPECTED_PRODUCER_INVENTORY_SHA256 = "c0ae1c9c1d957181ca2603e9215a940884c49766b81ca83f8d835312dd1f3dfb"

def mask_non_code(source: str) -> str:
    out = list(source)
    i = 0
    while i < len(source):
        if source.startswith("//", i):
            end = source.find("\n", i)
            end = len(source) if end < 0 else end
            out[i:end] = " " * (end - i)
            i = end
        elif source.startswith("/*", i):
            depth, j = 1, i + 2
            while j < len(source) and depth:
                if source.startswith("/*", j): depth, j = depth + 1, j + 2
                elif source.startswith("*/", j): depth, j = depth - 1, j + 2
                else: j += 1
            out[i:j] = " " * (j - i)
            i = j
        elif source[i] == '"':
            quote, j = source[i], i + 1
            while j < len(source):
                if source[j] == "\\": j += 2
                elif source[j] == quote:
                    j += 1
                    break
                else: j += 1
            out[i:j] = " " * (j - i)
            i = j
        else:
            i += 1
    return "".join(out)


def balanced_body(code: str, brace: int) -> str:
    depth = 0
    for i in range(brace, len(code)):
        if code[i] == "{": depth += 1
        elif code[i] == "}":
            depth -= 1
            if depth == 0: return code[brace + 1:i]
    raise ValueError("unbalanced StepUpdate literal")


def inside_loop(code: str, position: int) -> bool:
    for loop in re.finditer(r"\b(?:loop\s*|while\b[^\{]*|for\b[^\{]*)\{", code[:position]):
        brace = code.find("{", loop.start())
        try:
            body = balanced_body(code, brace)
        except ValueError:
            continue
        if brace < position < brace + len(body) + 2:
            return True
    return False


def inside_callback(code: str, position: int) -> bool:
    for callback in re.finditer(r"\|[^|]*\|\s*\{", code[:position]):
        brace = code.find("{", callback.start())
        try:
            body = balanced_body(code, brace)
        except ValueError:
            continue
        if brace < position < brace + len(body) + 2:
            return True
    return False


def inside_expression_callback(code: str, position: int) -> bool:
    statement_start = max(code.rfind(";", 0, position), code.rfind("{", 0, position)) + 1
    return re.search(r"\|[^|]*\|\s*$", code[statement_start:position]) is not None


def containing_statement(code: str, position: int) -> str:
    start = max(code.rfind(";", 0, position), code.rfind("{", 0, position), code.rfind("}", 0, position)) + 1
    ends = [end for end in (code.find(";", position), code.find("{", position), code.find("}", position)) if end >= 0]
    end = min(ends) if ends else len(code)
    return re.sub(r"\s+", " ", code[start:end].strip())


def function_at(code: str, position: int) -> str:
    functions = list(re.finditer(r"\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", code[:position]))
    return functions[-1].group(1) if functions else ""


def mesh_access_record(rel: str, code: str, access: re.Match[str]) -> tuple[str, str, str, str]:
    prefix = code[max(0, access.start() - 100):access.start()]
    receivers = re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\s*$", prefix)
    receiver = receivers[-1] if receivers else "<expression>"
    tail = code[access.end():access.end() + 80]
    operation_match = re.match(r"\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|([=]))", tail)
    operation = (operation_match.group(1) or "assign") if operation_match else "read"
    return rel, receiver, operation, containing_statement(code, access.start())


def inventory_sha256(records: list[tuple[str, ...]]) -> str:
    payload = json.dumps(sorted(records), separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def check_text(name: str, source: str, allow_payload_functions: set[str] | None = None,
               allow_generation_loop_functions: set[str] | None = None) -> list[str]:
    code = mask_non_code(source)
    errors: list[str] = []
    for match in STEP.finditer(code):
        prefix = code[max(0, match.start() - 80):match.start()]
        if re.search(r"\b(?:impl|struct)\s*$", prefix) or re.search(r"->\s*$", prefix):
            continue
        body = balanced_body(code, code.find("{", match.start()))
        function = function_at(code, match.start())
        if not re.search(r"\bfem_mesh_generation_id\s*[:,]", body) and not re.search(r"\.\.\s*[A-Za-z_]", body):
            errors.append(f"{name}: StepUpdate literal lacks fem_mesh_generation_id")
        if (re.search(r"\bfem_mesh_generation_id\s*:\s*None\b", body)
                and (re.search(r"\bgrid\s*:\s*\[\s*0\s*,\s*0\s*,\s*0\s*\]", body)
                     or re.search(r"\bfem\b", function, re.I)
                     or re.search(r"\bgrid\s*:\s*fem[A-Za-z0-9_]*\b", body))):
            errors.append(f"{name}: FEM-shaped StepUpdate uses generation None")
        if re.search(r"(?<!generation_id)\bfem_mesh\s*:", body):
            errors.append(f"{name}: StepUpdate literal owns fem_mesh")
    for producer in PRODUCER.finditer(code):
        function = function_at(code, producer.start())
        operation = producer.group("operation")
        if operation.startswith("FemMeshPayload::from") and function not in (allow_payload_functions or set()):
            errors.append(f"{name}: {operation} outside a stage owner ({function})")
        if (inside_loop(code, producer.start()) or inside_callback(code, producer.start()) or inside_expression_callback(code, producer.start())) and function not in (allow_generation_loop_functions or set()):
            errors.append(f"{name}: mesh producer {operation} inside loop/callback ({function})")
    for mesh_access in re.finditer(r"\.[ \t\r\n]*fem_mesh\b", code):
        errors.append(f"{name}: unclassified .fem_mesh access")
    producers_by_function: dict[tuple[str, str], int] = {}
    for producer in PRODUCER.finditer(code):
        function = function_at(code, producer.start())
        operation = producer.group("operation")
        if function:
            producers_by_function[(function, operation)] = producers_by_function.get((function, operation), 0) + 1
    for (function, operation), count in producers_by_function.items():
        if count > 1 and function not in ((allow_payload_functions or set()) | (allow_generation_loop_functions or set())):
            errors.append(f"{name}: duplicate mesh producer {operation} in stage owner {function}")
    return errors


def check_repo(root: pathlib.Path) -> list[str]:
    errors: list[str] = []
    roots = [root / "crates/fullmag-runner/src", root / "crates/fullmag-cli/src", root / "crates/fullmag-api/src"]
    owners = {
        "crates/fullmag-runner/src/types.rs": {
            "from", "fem_mesh_payload_generation_id_is_stable_for_same_plan",
            "fem_mesh_topology_fingerprint_changes_for_node_reorder",
            "fem_mesh_topology_fingerprint_changes_for_element_connectivity",
            "fem_mesh_topology_fingerprint_changes_for_mesh_part_node_indices",
            "fem_mesh_payload_is_built_once_while_step_updates_reuse_generation",
            "build_from_fem_plan", "build_from_fem_eigen_plan",
            "build_from_fem_frequency_response_plan",
        },
        "crates/fullmag-runner/src/interactive_runtime.rs": {"from_fem_plan"},
        "crates/fullmag-runner/src/interactive_runtime/fem/mod.rs": {"from_fem_plan"},
        "crates/fullmag-cli/src/orchestrator.rs": {"fem_mesh_payload_from_backend_plan"},
        "crates/fullmag-api/src/quantities.rs": {"extract_fem_mesh_from_metadata"},
    }
    generation_stage_owners = {
        "crates/fullmag-runner/src/types.rs": {
            "from", "fem_mesh_payload_generation_id_is_stable_for_same_plan",
            "build_from_fem_plan", "build_from_fem_eigen_plan",
            "build_from_fem_frequency_response_plan",
        },
        "crates/fullmag-cli/src/orchestrator.rs": {
            "maybe_execute_adaptive_relaxation_followup_passes", "run_script_mode",
        },
        "crates/fullmag-api/src/quantities.rs": {"extract_fem_mesh_from_metadata"},
    }
    for base in roots:
        for path in base.rglob("*.rs"):
            rel = path.relative_to(root).as_posix()
            file_errors = check_text(rel, path.read_text(), owners.get(rel), generation_stage_owners.get(rel))
            file_errors = [e for e in file_errors if "unclassified .fem_mesh access" not in e]
            errors.extend(file_errors)
    mesh_inventory: list[tuple[str, str, str, str]] = []
    producer_inventory: list[tuple[str, str, str, str]] = []
    for base in roots:
        for path in base.rglob("*.rs"):
            rel = path.relative_to(root).as_posix()
            code = mask_non_code(path.read_text())
            for access in re.finditer(r"\.[ \t\r\n]*fem_mesh\b", code):
                record = mesh_access_record(rel, code, access)
                mesh_inventory.append(record)
            for producer in PRODUCER.finditer(code):
                producer_inventory.append((
                    rel,
                    function_at(code, producer.start()),
                    producer.group("operation"),
                    containing_statement(code, producer.start()),
                ))
    mesh_digest = inventory_sha256(mesh_inventory)
    producer_digest = inventory_sha256(producer_inventory)
    if mesh_digest != EXPECTED_MESH_ACCESS_INVENTORY_SHA256:
        errors.append(f"mesh access operation inventory drifted: expected={EXPECTED_MESH_ACCESS_INVENTORY_SHA256} actual={mesh_digest}")
    if producer_digest != EXPECTED_PRODUCER_INVENTORY_SHA256:
        errors.append(f"mesh producer inventory drifted: expected={EXPECTED_PRODUCER_INVENTORY_SHA256} actual={producer_digest}")
    print(f"[verify_fem_mesh_hot_loop_source_contract] classified {len(mesh_inventory)} .fem_mesh accesses")
    print(f"[verify_fem_mesh_hot_loop_source_contract] classified {len(producer_inventory)} mesh producers")
    live = (root / "crates/fullmag-cli/src/live_workspace.rs").read_text()
    code = mask_non_code(live)
    if "build_publish_payload(include_mesh" not in code or not re.search(r"include_mesh\s*\.then\s*\(\|\|\s*\{.*?self\.fem_mesh\.clone", code, re.S):
        errors.append("live_workspace.rs: mesh clone is not guarded by include_mesh")
    return errors


def self_test() -> None:
    mutations = [
        ("fn f(){ let _ = crate::types::FemMeshPayload::from(plan); }", None),
        ("fn f(){ let _ = LiveStepView { fem_mesh: mesh }; update.fem_mesh.take(); }", None),
        ("fn f(){ let _ = crate::types::StepUpdate { stats }; }", None),
        ("fn fem_mesh_payload_from_backend_plan(){ loop { let _ = crate::types::FemMeshPayload::from(plan); } }", {"fem_mesh_payload_from_backend_plan"}),
        ("fn f(frame: Frame){ let _ = frame.fem_mesh; }", None),
        ("fn f(){ loop { let _ = crate::types::fem_plan_mesh_generation_id(plan); } }", None),
        ("fn f(){ let callback = || { crate::types::fem_plan_mesh_generation_id(plan) }; }", None),
        ("fn stage(){ let a=fem_plan_mesh_generation_id(plan); let b=fem_plan_mesh_generation_id(plan); }", None),
        ("fn fem(){ let _=StepUpdate { grid: [0,0,0], fem_mesh_generation_id: None }; }", None),
        ("fn f(){ let callback = || { StageFemMeshAsset::build_from_fem_plan(plan) }; }", None),
        ("fn stage(){ StageFemMeshAsset::build_from_fem_plan(plan); StageFemMeshAsset::build_from_fem_plan(plan); }", None),
        ("fn f(){ let callback = || { StageFemMeshIdentity::from_fem_plan(plan) }; }", None),
        ("fn f(){ let callback = || fem_plan_mesh_generation_id(plan); }", None),
        ("fn fem(fem_grid: [u32; 3]){ let _=StepUpdate { grid: fem_grid, fem_mesh_generation_id: None }; }", None),
    ]
    for i, (mutation, owners) in enumerate(mutations):
        if not check_text(f"mutation-{i}", mutation, owners):
            raise SystemExit(f"mutation fixture {i} escaped the checker")
    valid = 'fn f(){ let _ = crate::types::StepUpdate { fem_mesh_generation_id: None }; /* } */ let s="{"; }'
    if check_text("valid", valid):
        raise SystemExit("valid qualified StepUpdate fixture was rejected")
    access = [("file.rs", "state", "take", "state.fem_mesh.take()")]
    substituted_access = [("file.rs", "state", "clone", "state.fem_mesh.clone()")]
    if inventory_sha256(access) == inventory_sha256(substituted_access):
        raise SystemExit("per-occurrence mesh operation substitution escaped inventory")
    producer = [("file.rs", "stage", "StageFemMeshAsset::build_from_fem_plan", "let asset = StageFemMeshAsset::build_from_fem_plan(plan)")]
    duplicate_producer = producer + producer
    if inventory_sha256(producer) == inventory_sha256(duplicate_producer):
        raise SystemExit("cross-boundary duplicate producer escaped inventory")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=pathlib.Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test: self_test()
    if args.root:
        errors = check_repo(args.root)
        if errors:
            raise SystemExit("\n".join(errors))
        print("[verify_fem_mesh_hot_loop_source_contract] semantic mesh ownership contract passed")


if __name__ == "__main__": main()
