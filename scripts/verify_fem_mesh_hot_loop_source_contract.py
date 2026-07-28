#!/usr/bin/env python3
"""Semantic source guard for generation-only FEM step updates."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import tempfile


STEP = re.compile(r"(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*::)*StepUpdate\s*\{")
PRODUCER = re.compile(
    r"(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*::)*(?P<operation>"
    r"FemMeshPayload::from(?:_[A-Za-z0-9_]+)?|"
    r"StageFemMeshAsset::build_from_[A-Za-z0-9_]+|"
    r"StageFemMeshIdentity::from_(?:fem|fem_eigen|fem_frequency_response|backend)_plan|"
    r"FemStageExecutionContext::from_[A-Za-z0-9_]+|"
    r"fem_(?:plan|eigen|frequency_response)_mesh_generation_id"
    r")\s*\("
)

# SHA-256 over sorted exact records: file, receiver, operation, normalized
# containing statement. This pins all semantic occurrences, not aggregate counts.
EXPECTED_MESH_ACCESS_INVENTORY_SHA256 = "252889e065b7eaabaa417d5009fc42d81fcd1df3295cc502e284b0919f86ffde"
EXPECTED_PRODUCER_INVENTORY_SHA256 = "fa98cf955bb089dff02b9d923ab45d2b74325c67311f17111afab695ed6fe09f"

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


def enclosing_context(code: str, position: int) -> str:
    constructs: list[dict[str, object]] = []
    for loop in re.finditer(r"\b(?:loop\s*|while\b[^\{]*|for\b[^\{]*)\{", code[:position]):
        brace = code.find("{", loop.start())
        try:
            body = balanced_body(code, brace)
        except ValueError:
            continue
        header = re.sub(r"\s+", " ", code[loop.start():brace].strip())
        constructs.append({"brace": brace, "end": brace + len(body) + 2,
                           "kind": "loop", "header": header})
    for callback in re.finditer(r"\|[^|]*\|\s*\{", code[:position]):
        brace = code.find("{", callback.start())
        try:
            body = balanced_body(code, brace)
        except ValueError:
            continue
        header = re.sub(r"\s+", " ", code[callback.start():brace].strip())
        constructs.append({"brace": brace, "end": brace + len(body) + 2,
                           "kind": "callback", "header": header})
    constructs.sort(key=lambda item: int(item["brace"]))
    for construct in constructs:
        brace = int(construct["brace"])
        parents = [candidate for candidate in constructs
                   if int(candidate["brace"]) < brace < int(candidate["end"])]
        construct["parent"] = int(max(parents, key=lambda item: int(item["brace"]))["brace"]) if parents else -1
        siblings = [candidate for candidate in constructs
                    if int(candidate["brace"]) <= brace
                    and candidate["kind"] == construct["kind"]
                    and candidate["header"] == construct["header"]
                    and candidate.get("parent", -1) == construct["parent"]]
        construct["ordinal"] = len(siblings)
    ancestry = [construct for construct in constructs
                if int(construct["brace"]) < position < int(construct["end"])]
    if inside_expression_callback(code, position):
        statement_start = max(code.rfind(";", 0, position), code.rfind("{", 0, position)) + 1
        header = re.sub(r"\s+", " ", code[statement_start:position].strip())
        ancestry.append({"brace": position, "end": position, "kind": "callback-expression",
                         "header": header, "ordinal": 1})
    return ">".join(
        f"{item['kind']}#{item['ordinal']}:{item['header']}" for item in ancestry
    ) if ancestry else "stage"


def mesh_access_record(rel: str, code: str, access: re.Match[str]) -> tuple[str, str, str, str, str]:
    prefix = code[max(0, access.start() - 100):access.start()]
    receivers = re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\s*$", prefix)
    receiver = receivers[-1] if receivers else "<expression>"
    tail = code[access.end():access.end() + 80]
    operation_match = re.match(r"\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|([=]))", tail)
    operation = (operation_match.group(1) or "assign") if operation_match else "read"
    return (rel, receiver, operation, enclosing_context(code, access.start()),
            containing_statement(code, access.start()))


def inventory_sha256(records: list[tuple[str, ...]]) -> str:
    payload = json.dumps(sorted(records), separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def producer_record(code: str, producer: re.Match[str]) -> tuple[str, str, str, str]:
    return (function_at(code, producer.start()), producer.group("operation"),
            enclosing_context(code, producer.start()),
            containing_statement(code, producer.start()))


def check_text(name: str, source: str,
               allowed_producer_records: set[tuple[str, str, str, str]] | None = None,
               validate_producers: bool = True) -> list[str]:
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
    for producer in PRODUCER.finditer(code) if validate_producers else ():
        function, operation, context, statement = producer_record(code, producer)
        allowed = (function, operation, context, statement) in (allowed_producer_records or set())
        if operation.startswith("FemMeshPayload::from") and not allowed:
            errors.append(f"{name}: {operation} outside a stage owner ({function})")
        if (inside_loop(code, producer.start()) or inside_callback(code, producer.start()) or inside_expression_callback(code, producer.start())) and not allowed:
            errors.append(f"{name}: mesh producer {operation} inside loop/callback ({function})")
    producers_by_function: dict[tuple[str, str], int] = {}
    for producer in PRODUCER.finditer(code) if validate_producers else ():
        function = function_at(code, producer.start())
        operation = producer.group("operation")
        if function:
            producers_by_function[(function, operation)] = producers_by_function.get((function, operation), 0) + 1
    for (function, operation), count in producers_by_function.items():
        matching_allowed = [record for record in (allowed_producer_records or set())
                            if record[0] == function and record[1] == operation]
        if count > 1 and not allowed_producer_records and len(matching_allowed) != count:
            errors.append(f"{name}: duplicate mesh producer {operation} in stage owner {function}")
    return errors


def check_repo(root: pathlib.Path,
               expected_mesh_digest: str = EXPECTED_MESH_ACCESS_INVENTORY_SHA256,
               expected_producer_digest: str = EXPECTED_PRODUCER_INVENTORY_SHA256,
               require_live_guard: bool = True) -> list[str]:
    errors: list[str] = []
    roots = [root / "crates/fullmag-runner/src", root / "crates/fullmag-cli/src", root / "crates/fullmag-api/src"]
    mesh_inventory: list[tuple[str, str, str, str, str]] = []
    producer_inventory: list[tuple[str, str, str, str, str]] = []
    source_by_path: list[tuple[str, str]] = []
    for base in roots:
        for path in base.rglob("*.rs"):
            rel = path.relative_to(root).as_posix()
            source = path.read_text()
            source_by_path.append((rel, source))
            code = mask_non_code(source)
            for access in re.finditer(r"\.[ \t\r\n]*fem_mesh\b", code):
                record = mesh_access_record(rel, code, access)
                mesh_inventory.append(record)
            for producer in PRODUCER.finditer(code):
                producer_inventory.append((
                    rel,
                    function_at(code, producer.start()),
                    producer.group("operation"),
                    enclosing_context(code, producer.start()),
                    containing_statement(code, producer.start()),
                ))
    mesh_digest = inventory_sha256(mesh_inventory)
    producer_digest = inventory_sha256(producer_inventory)
    if mesh_digest != expected_mesh_digest:
        errors.append(f"mesh access operation inventory drifted: expected={expected_mesh_digest} actual={mesh_digest}")
    if producer_digest != expected_producer_digest:
        errors.append(f"mesh producer inventory drifted: expected={expected_producer_digest} actual={producer_digest}")
    allowed_by_file: dict[str, set[tuple[str, str, str, str]]] = {}
    for rel, function, operation, context, statement in producer_inventory:
        allowed_by_file.setdefault(rel, set()).add((function, operation, context, statement))
    for rel, source in source_by_path:
        errors.extend(check_text(rel, source, allowed_by_file.get(rel, set()), validate_producers=True))
    print(f"[verify_fem_mesh_hot_loop_source_contract] classified {len(mesh_inventory)} .fem_mesh accesses")
    print(f"[verify_fem_mesh_hot_loop_source_contract] classified {len(producer_inventory)} mesh producers")
    if require_live_guard:
        live = (root / "crates/fullmag-cli/src/live_workspace.rs").read_text()
        code = mask_non_code(live)
        if "build_publish_payload(include_mesh" not in code or not re.search(r"include_mesh\s*\.then\s*\(\|\|\s*\{.*?self\.fem_mesh\.clone", code, re.S):
            errors.append("live_workspace.rs: mesh clone is not guarded by include_mesh")
    return errors


def self_test() -> None:
    mutations = [
        ("fn f(){ let _ = crate::types::FemMeshPayload::from(plan); }", None),
        ("fn f(){ let _ = crate::types::StepUpdate { stats }; }", None),
        ("fn fem_mesh_payload_from_backend_plan(){ loop { let _ = crate::types::FemMeshPayload::from(plan); } }", {"fem_mesh_payload_from_backend_plan"}),
        ("fn f(){ loop { let _ = crate::types::fem_plan_mesh_generation_id(plan); } }", None),
        ("fn f(){ let callback = || { crate::types::fem_plan_mesh_generation_id(plan) }; }", None),
        ("fn stage(){ let a=fem_plan_mesh_generation_id(plan); let b=fem_plan_mesh_generation_id(plan); }", None),
        ("fn fem(){ let _=StepUpdate { grid: [0,0,0], fem_mesh_generation_id: None }; }", None),
        ("fn f(){ let callback = || { StageFemMeshAsset::build_from_fem_plan(plan) }; }", None),
        ("fn stage(){ StageFemMeshAsset::build_from_fem_plan(plan); StageFemMeshAsset::build_from_fem_plan(plan); }", None),
        ("fn f(){ let callback = || { StageFemMeshIdentity::from_fem_plan(plan) }; }", None),
        ("fn f(){ let callback = || { FemStageExecutionContext::from_fem_plan(plan) }; }", None),
        ("fn stage(){ FemStageExecutionContext::from_fem_plan(plan); FemStageExecutionContext::from_fem_plan(plan); }", None),
        ("fn f(){ let callback = || { StageFemMeshIdentity::from_fem_eigen_plan(plan) }; }", None),
        ("fn f(){ let callback = || { StageFemMeshIdentity::from_fem_frequency_response_plan(plan) }; }", None),
        ("fn f(){ let callback = || fem_plan_mesh_generation_id(plan); }", None),
        ("fn fem(fem_grid: [u32; 3]){ let _=StepUpdate { grid: fem_grid, fem_mesh_generation_id: None }; }", None),
    ]
    for i, (mutation, owners) in enumerate(mutations):
        if not check_text(f"mutation-{i}", mutation, owners):
            raise SystemExit(f"mutation fixture {i} escaped the checker")
    valid = 'fn f(){ let _ = crate::types::StepUpdate { fem_mesh_generation_id: None }; /* } */ let s="{"; }'
    if check_text("valid", valid):
        raise SystemExit("valid qualified StepUpdate fixture was rejected")
    access = [("file.rs", "state", "take", "stage", "state.fem_mesh.take()")]
    substituted_access = [("file.rs", "state", "clone", "stage", "state.fem_mesh.clone()")]
    if inventory_sha256(access) == inventory_sha256(substituted_access):
        raise SystemExit("per-occurrence mesh operation substitution escaped inventory")
    producer = [("file.rs", "stage", "StageFemMeshAsset::build_from_fem_plan", "stage", "let asset = StageFemMeshAsset::build_from_fem_plan(plan)")]
    duplicate_producer = producer + producer
    if inventory_sha256(producer) == inventory_sha256(duplicate_producer):
        raise SystemExit("cross-boundary duplicate producer escaped inventory")
    with tempfile.TemporaryDirectory(prefix="fullmag-mesh-gate-") as temp:
        root = pathlib.Path(temp)
        runner = root / "crates/fullmag-runner/src"
        (root / "crates/fullmag-cli/src").mkdir(parents=True)
        (root / "crates/fullmag-api/src").mkdir(parents=True)
        runner.mkdir(parents=True)
        path = runner / "fixture.rs"
        plain = "fn stage(){ let asset = StageFemMeshAsset::build_from_fem_plan(plan); let mesh = state.fem_mesh.clone(); }"
        path.write_text(plain)
        code = mask_non_code(plain)
        mesh_records = [mesh_access_record(path.relative_to(root).as_posix(), code, match)
                        for match in re.finditer(r"\.[ \t\r\n]*fem_mesh\b", code)]
        producer_records = [(path.relative_to(root).as_posix(), *producer_record(code, match))
                            for match in PRODUCER.finditer(code)]
        mesh_digest = inventory_sha256(mesh_records)
        producer_digest = inventory_sha256(producer_records)
        for mutation in (
            "fn stage(){ loop { let asset = StageFemMeshAsset::build_from_fem_plan(plan); let mesh = state.fem_mesh.clone(); } }",
            "fn stage(){ let callback = || { let asset = StageFemMeshAsset::build_from_fem_plan(plan); let mesh = state.fem_mesh.clone(); }; }",
        ):
            path.write_text(mutation)
            if not check_repo(root, mesh_digest, producer_digest, require_live_guard=False):
                raise SystemExit("repository-mode context mutation escaped inventory")
        producer_statements = (
            "let asset = StageFemMeshAsset::build_from_fem_plan(plan);",
            "let identity = StageFemMeshIdentity::from_fem_plan(plan);",
            "let context = FemStageExecutionContext::from_fem_plan(plan);",
        )
        for producer_statement in producer_statements:
            for baseline, mutation in (
                (
                    f"fn stage(){{ for stage in stages {{ {producer_statement} let mesh = state.fem_mesh.clone(); }} }}",
                    f"fn stage(){{ for stage in stages {{ for step in steps {{ {producer_statement} let mesh = state.fem_mesh.clone(); }} }} }}",
                ),
                (
                    f"fn stage(){{ let outer = || {{ {producer_statement} let mesh = state.fem_mesh.clone(); }}; }}",
                    f"fn stage(){{ let outer = || {{ let inner = || {{ {producer_statement} let mesh = state.fem_mesh.clone(); }}; }}; }}",
                ),
            ):
                path.write_text(baseline)
                code = mask_non_code(baseline)
                mesh_records = [mesh_access_record(path.relative_to(root).as_posix(), code, match)
                                for match in re.finditer(r"\.[ \t\r\n]*fem_mesh\b", code)]
                producer_records = [(path.relative_to(root).as_posix(), *producer_record(code, match))
                                    for match in PRODUCER.finditer(code)]
                path.write_text(mutation)
                if not check_repo(root, inventory_sha256(mesh_records),
                                  inventory_sha256(producer_records), require_live_guard=False):
                    raise SystemExit("repository-mode nested-context mutation escaped inventory")
            sibling_baseline = (
                f"fn stage(){{ for stage in stages {{ {producer_statement} let mesh = state.fem_mesh.clone(); }} "
                "for stage in stages { consume(); } }"
            )
            sibling_mutation = (
                "fn stage(){ for stage in stages { consume(); } "
                f"for stage in stages {{ {producer_statement} let mesh = state.fem_mesh.clone(); }} }}"
            )
            callback_baseline = (
                f"fn stage(){{ let first = || {{ {producer_statement} let mesh = state.fem_mesh.clone(); }}; "
                "let second = || { consume(); }; }"
            )
            callback_mutation = (
                "fn stage(){ let first = || { consume(); }; "
                f"let second = || {{ {producer_statement} let mesh = state.fem_mesh.clone(); }}; }}"
            )
            for baseline, mutation in ((sibling_baseline, sibling_mutation),
                                       (callback_baseline, callback_mutation)):
                path.write_text(baseline)
                code = mask_non_code(baseline)
                mesh_records = [mesh_access_record(path.relative_to(root).as_posix(), code, match)
                                for match in re.finditer(r"\.[ \t\r\n]*fem_mesh\b", code)]
                producer_records = [(path.relative_to(root).as_posix(), *producer_record(code, match))
                                    for match in PRODUCER.finditer(code)]
                path.write_text(mutation)
                if not check_repo(root, inventory_sha256(mesh_records),
                                  inventory_sha256(producer_records), require_live_guard=False):
                    raise SystemExit("repository-mode sibling-owner mutation escaped inventory")


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
