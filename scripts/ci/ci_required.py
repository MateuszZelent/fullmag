from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Iterable, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[2]
RULES_PATH = ROOT / ".github" / "ci-required-paths.json"
ALWAYS_GATES = ("contract_guard",)
PATH_GATE_IDS = (
    "abl_live_browser",
    "dispersion_artifact_consumers",
    "documentation",
    "eigensolve_damping_oracle",
    "eigensolve_method_contracts",
    "eigensolve_ui_method_contracts",
    "pypi_build",
    "scoped_mesh_fields",
    "shifted_ksp_true_convergence",
)
ALL_GATE_IDS = ("bootstrap", *ALWAYS_GATES, *PATH_GATE_IDS)
CI_TRIGGER_PATHS = {
    ".github/ci-required-paths.json",
    "scripts/ci/ci_required.py",
    "scripts/test_ci_required.py",
    "scripts/test_ci_workflow_policy.py",
    "scripts/test_bootstrap_workflow_contract.py",
    "scripts/test_frontend3d_required_checks.py",
}


class GateSelectionError(RuntimeError):
    """Raised when a required CI gate cannot be selected or proven complete."""


def load_rules(path: Path = RULES_PATH) -> dict[str, list[str]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GateSelectionError(f"cannot load CI path rules from {path}: {exc}") from exc
    if not isinstance(value, dict) or set(value) != set(PATH_GATE_IDS):
        raise GateSelectionError(
            "CI path rules must define exactly: " + ", ".join(PATH_GATE_IDS)
        )

    rules: dict[str, list[str]] = {}
    for gate, patterns in value.items():
        if not isinstance(patterns, list) or not patterns:
            raise GateSelectionError(f"CI path rules for {gate} must be a nonempty list")
        if any(not isinstance(pattern, str) or not pattern for pattern in patterns):
            raise GateSelectionError(f"CI path rules for {gate} contain an empty pattern")
        for pattern in patterns:
            if pattern.startswith("!") or any(
                token in pattern for token in ("?", "[", "]", "{", "}", "(", ")")
            ):
                raise GateSelectionError(
                    f"unsupported GitHub path pattern for {gate}: {pattern}"
                )
            _pattern_regex(pattern)
        rules[gate] = patterns
    return rules


def _pattern_regex(pattern: str) -> re.Pattern[str]:
    """Compile the GitHub path glob subset used by the checked-in CI rules."""
    pieces = ["^"]
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if index + 1 < len(pattern) and pattern[index + 1] == "*":
                if index + 2 < len(pattern) and pattern[index + 2] == "/":
                    pieces.append("(?:.*/)?")
                    index += 3
                else:
                    pieces.append(".*")
                    index += 2
            else:
                pieces.append("[^/]*")
                index += 1
        else:
            pieces.append(re.escape(char))
            index += 1
    pieces.append("$")
    return re.compile("".join(pieces))


def path_matches(path: str, pattern: str) -> bool:
    if not path or path.startswith("/") or "\\" in path or "\n" in path or "\r" in path:
        raise GateSelectionError(f"invalid changed path: {path!r}")
    return _pattern_regex(pattern).fullmatch(path) is not None


def _is_docs_only_pull_request(paths: Sequence[str]) -> bool:
    if not paths:
        return False
    excluded_segments = {"config", "configs", "fixtures", "scripts", "tests"}
    for path in paths:
        if not path.startswith("public_docs/site/"):
            return False
        parts = {part.casefold() for part in path.split("/")}
        if parts & excluded_segments:
            return False
        if not (path.endswith(".md") or path.endswith(".source-map.json")):
            return False
    return True


def select_gates(
    changed_files: Iterable[str],
    rules: Mapping[str, Sequence[str]],
    event_name: str = "pull_request",
) -> dict[str, bool]:
    if any(not isinstance(gate, str) or not gate for gate in rules):
        raise GateSelectionError("CI path rule names must be nonempty strings")
    if any(
        not isinstance(patterns, Sequence) or isinstance(patterns, (str, bytes))
        for patterns in rules.values()
    ):
        raise GateSelectionError("CI path rule values must be sequences of glob patterns")

    paths = tuple(changed_files)
    for path in paths:
        if "\n" in path or "\r" in path or not path or path.startswith("/") or "\\" in path:
            raise GateSelectionError(f"invalid changed path: {path!r}")

    docs_only = (
        event_name == "pull_request"
        and _is_docs_only_pull_request(paths)
    )
    matches = {
        path: {
            gate
            for gate, patterns in rules.items()
            if any(path_matches(path, pattern) for pattern in patterns)
        }
        for path in paths
    }
    matched_gates = set().union(*matches.values()) if matches else set()
    unknown_paths = any(not gates for gates in matches.values())
    ci_change = any(
        path.startswith(".github/workflows/") or path in CI_TRIGGER_PATHS
        for path in paths
    )
    full_specialist_stack = (
        not paths
        or unknown_paths
        or len(matched_gates) > 1
        or ci_change
        or event_name != "pull_request"
    )

    selected = {
        "bootstrap": not docs_only,
        "contract_guard": True,
    }
    for gate in rules:
        selected[gate] = full_specialist_stack or gate in matched_gates
    if docs_only:
        for gate in rules:
            selected[gate] = gate == "documentation" and gate in matched_gates
    return selected


def _git(repo_root: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise GateSelectionError(
            f"git {' '.join(args)} failed with exit {result.returncode}: {detail}"
        )
    return result.stdout


def _validate_commit(repo_root: Path, commit: str, label: str) -> None:
    if re.fullmatch(r"[0-9a-fA-F]{40}", commit or "") is None:
        raise GateSelectionError(f"{label} must be a full 40-character commit SHA")
    _git(repo_root, "cat-file", "-e", f"{commit}^{{commit}}")


def changed_paths(repo_root: Path, base: str, head: str) -> set[str]:
    repo_root = Path(repo_root)
    _validate_commit(repo_root, base, "base SHA")
    _validate_commit(repo_root, head, "head SHA")
    raw = _git(
        repo_root,
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        "--no-ext-diff",
        f"{base}...{head}",
        "--",
    )
    paths: set[str] = set()
    for raw_path in raw.split(b"\0"):
        if not raw_path:
            continue
        try:
            path = raw_path.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise GateSelectionError(
                "changed path is not valid UTF-8; refusing to skip path gates"
            ) from exc
        if not path or path.startswith("/") or "\\" in path:
            raise GateSelectionError(f"git diff returned an invalid path: {path!r}")
        paths.add(path)
    return paths


def validate_results(
    expected: Mapping[str, bool],
    results: Mapping[str, str],
    plan_result: str,
) -> None:
    if plan_result != "success":
        raise GateSelectionError(f"gate selection job ended as {plan_result!r}")
    if set(expected) != set(results):
        missing = sorted(set(expected) - set(results))
        unexpected = sorted(set(results) - set(expected))
        raise GateSelectionError(
            f"gate result set does not match the plan; missing={missing}, unexpected={unexpected}"
        )
    if not set((*ALWAYS_GATES, "bootstrap")).issubset(expected):
        raise GateSelectionError("gate plan omitted bootstrap or the always-required contract guard")
    if expected.get("contract_guard") is not True:
        raise GateSelectionError("contract guard must always be selected")
    if expected["bootstrap"] is False:
        if expected.get("documentation") is not True or any(
            enabled
            for gate, enabled in expected.items()
            if gate not in {"bootstrap", "contract_guard", "documentation"}
        ):
            raise GateSelectionError(
                "bootstrap may be skipped only for an exclusively documentation-only plan"
            )
    if any(type(value) is not bool for value in expected.values()):
        raise GateSelectionError("gate plan values must be booleans")

    for gate in sorted(expected):
        state = results[gate]
        wanted = expected[gate]
        if wanted and state != "success":
            raise GateSelectionError(
                f"required gate {gate} was selected but ended as {state!r}"
            )
        if not wanted and state != "skipped":
            raise GateSelectionError(
                f"unselected gate {gate} must be skipped, got {state!r}"
            )


def _write_plan_outputs(plan: Mapping[str, bool]) -> None:
    output = os.environ.get("GITHUB_OUTPUT")
    if not output:
        raise GateSelectionError("GITHUB_OUTPUT is required to publish the gate plan")
    lines = [f"gates={json.dumps(plan, sort_keys=True, separators=(',', ':'))}"]
    lines.extend(f"{gate}={'true' if enabled else 'false'}" for gate, enabled in plan.items())
    with open(output, "a", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines) + "\n")


def _validate_from_environment() -> None:
    raw_expected = os.environ.get("EXPECTED_GATES_JSON", "")
    try:
        expected = json.loads(raw_expected)
    except json.JSONDecodeError as exc:
        raise GateSelectionError(f"EXPECTED_GATES_JSON is invalid: {exc}") from exc
    rules = load_rules()
    expected_ids = {"bootstrap", *ALWAYS_GATES, *rules}
    if not isinstance(expected, dict) or set(expected) != expected_ids:
        raise GateSelectionError("gate plan is missing one or more required gate outputs")
    results = {
        gate: os.environ.get(f"RESULT_{gate.upper()}", "")
        for gate in expected_ids
    }
    validate_results(expected, results, os.environ.get("PLAN_RESULT", ""))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Select and validate the required Fullmag PR CI gates.")
    commands = parser.add_subparsers(dest="command", required=True)
    plan_parser = commands.add_parser("plan")
    plan_parser.add_argument("--repo-root", type=Path, default=ROOT)
    plan_parser.add_argument("--base", required=True)
    plan_parser.add_argument("--head", required=True)
    plan_parser.add_argument("--event-name", default="pull_request")
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--expected-gates-json", dest="expected_gates_json")

    args = parser.parse_args(argv)
    try:
        if args.command == "plan":
            rules = load_rules()
            paths = changed_paths(args.repo_root, args.base, args.head)
            plan = select_gates(paths, rules, args.event_name)
            _write_plan_outputs(plan)
            print(f"Selected CI gates for {len(paths)} changed paths: {plan}")
        else:
            if args.expected_gates_json:
                os.environ["EXPECTED_GATES_JSON"] = args.expected_gates_json
            _validate_from_environment()
            print("All required CI gates completed with their expected results.")
    except GateSelectionError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
