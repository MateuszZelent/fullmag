#!/usr/bin/env python3
"""Semantic source guard for generation-only FEM step updates."""

from __future__ import annotations

import argparse
import pathlib
import re


STEP = re.compile(r"(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*::)*StepUpdate\s*\{")
PAYLOAD = re.compile(r"(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*::)*FemMeshPayload::from\s*\(")
GENERATION_HASH = re.compile(r"(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*::)*fem_(?:plan|eigen|frequency_response)_mesh_generation_id\s*\(")


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


def check_text(name: str, source: str, allow_payload_functions: set[str] | None = None,
               allow_generation_loop_functions: set[str] | None = None) -> list[str]:
    code = mask_non_code(source)
    errors: list[str] = []
    for match in STEP.finditer(code):
        prefix = code[max(0, match.start() - 80):match.start()]
        if re.search(r"\b(?:impl|struct)\s*$", prefix) or re.search(r"->\s*$", prefix):
            continue
        body = balanced_body(code, code.find("{", match.start()))
        if not re.search(r"\bfem_mesh_generation_id\s*[:,]", body) and not re.search(r"\.\.\s*[A-Za-z_]", body):
            errors.append(f"{name}: StepUpdate literal lacks fem_mesh_generation_id")
        if re.search(r"(?<!generation_id)\bfem_mesh\s*:", body):
            errors.append(f"{name}: StepUpdate literal owns fem_mesh")
    for payload in PAYLOAD.finditer(code):
        functions = list(re.finditer(r"\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", code[:payload.start()]))
        function = functions[-1].group(1) if functions else ""
        if inside_loop(code, payload.start()) or function not in (allow_payload_functions or set()):
            errors.append(f"{name}: FemMeshPayload::from outside a stage owner ({function})")
    for mesh_access in re.finditer(r"\.[ \t\r\n]*fem_mesh\b", code):
        errors.append(f"{name}: unclassified .fem_mesh access")
    for generation_hash in GENERATION_HASH.finditer(code):
        if re.search(r"\bfn\s*$", code[max(0, generation_hash.start() - 12):generation_hash.start()]):
            continue
        functions = list(re.finditer(r"\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", code[:generation_hash.start()]))
        function = functions[-1].group(1) if functions else ""
        if inside_loop(code, generation_hash.start()) and function not in (allow_generation_loop_functions or set()):
            errors.append(f"{name}: topology generation hash inside loop")
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
        },
        "crates/fullmag-runner/src/interactive_runtime.rs": {"from_fem_plan"},
        "crates/fullmag-runner/src/interactive_runtime/fem/mod.rs": {"from_fem_plan"},
        "crates/fullmag-cli/src/orchestrator.rs": {"fem_mesh_payload_from_backend_plan"},
        "crates/fullmag-api/src/quantities.rs": {"extract_fem_mesh_from_metadata"},
    }
    generation_stage_owners = {
        "crates/fullmag-runner/src/types.rs": {"from"},
        "crates/fullmag-cli/src/orchestrator.rs": {"run_script_mode"},
    }
    for base in roots:
        for path in base.rglob("*.rs"):
            rel = path.relative_to(root).as_posix()
            file_errors = check_text(rel, path.read_text(), owners.get(rel), generation_stage_owners.get(rel))
            file_errors = [e for e in file_errors if "unclassified .fem_mesh access" not in e]
            errors.extend(file_errors)
    mesh_inventory = []
    for base in roots:
        for path in base.rglob("*.rs"):
            rel = path.relative_to(root).as_posix()
            code = mask_non_code(path.read_text())
            test_module = re.search(r"(?m)^\s*mod\s+tests\s*\{", code)
            for access in re.finditer(r"\.[ \t\r\n]*fem_mesh\b", code):
                receiver = code[max(0, access.start() - 40):access.start()]
                if ("/tests.rs" in rel or "#[cfg(test)]" in code[:access.start()][-200:]
                        or (test_module is not None and access.start() > test_module.start())):
                    category = "test_fixture"
                elif re.search(r"(?:latest_step|update)\s*$", receiver):
                    category = "legacy_nested_input"
                    tail = code[access.start():access.start() + 80]
                    if rel != "crates/fullmag-api/src/session.rs" or ".take()" not in tail:
                        errors.append(f"{rel}: nested mesh access must be input-only take")
                elif rel.startswith("crates/fullmag-cli/"):
                    category = "cli_stage_resource"
                else:
                    category = "api_top_level_resource"
                mesh_inventory.append((rel, category))
    if not mesh_inventory:
        errors.append("mesh access inventory is unexpectedly empty")
    print(f"[verify_fem_mesh_hot_loop_source_contract] classified {len(mesh_inventory)} .fem_mesh accesses")
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
    ]
    for i, (mutation, owners) in enumerate(mutations):
        if not check_text(f"mutation-{i}", mutation, owners):
            raise SystemExit(f"mutation fixture {i} escaped the checker")
    valid = 'fn f(){ let _ = crate::types::StepUpdate { fem_mesh_generation_id: None }; /* } */ let s="{"; }'
    if check_text("valid", valid):
        raise SystemExit("valid qualified StepUpdate fixture was rejected")


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
