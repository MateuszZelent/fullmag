#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


TASK_IDS = tuple(f"T{number}" for number in range(24))
STATUSES = {"pending", "in_progress", "completed", "blocked", "no_go"}
COMMIT_RE = re.compile(r"[0-9a-f]{40}$")
LEDGER_COLUMNS = (
    "Task",
    "status",
    "source_commit",
    "runtime_manifest_sha256",
    "evidence",
    "decision",
    "commit",
    "notes",
)


def _task_rows(markdown: str) -> tuple[dict[str, dict[str, str]], list[str]]:
    rows: dict[str, dict[str, str]] = {}
    errors: list[str] = []
    header: list[str] | None = None
    for line in markdown.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells == list(LEDGER_COLUMNS):
            header = list(LEDGER_COLUMNS)
            continue
        if header is None or not cells or not re.fullmatch(r"T\d+", cells[0]):
            continue
        if len(cells) != len(header):
            continue
        if cells[0] in rows:
            errors.append(f"duplicate task row: {cells[0]}")
            continue
        rows[cells[0]] = dict(zip(header, cells))
    return rows, errors


def _evidence_paths(value: str) -> list[str]:
    return [path.strip() for path in value.split(";") if path.strip()]


def validate_ledger(path: Path, repo_root: Path) -> list[str]:
    """Return deterministic validation failures; an empty list means valid."""
    try:
        rows, errors = _task_rows(path.read_text(encoding="utf-8"))
    except OSError as error:
        return [str(error)]

    for task_id in TASK_IDS:
        row = rows.get(task_id)
        if row is None:
            errors.append(f"missing task row: {task_id}")
            continue

        status = row.get("status", "")
        if status not in STATUSES:
            errors.append(f"task {task_id} has invalid status: {status}")
        if status != "pending" and not COMMIT_RE.fullmatch(row.get("source_commit", "")):
            errors.append(f"non-pending task {task_id} requires a 40-character source_commit")

        evidence_paths = _evidence_paths(row.get("evidence", ""))
        if status == "completed" and not evidence_paths:
            errors.append(f"completed task {task_id} requires at least one evidence path")
        for evidence_path in evidence_paths:
            if not (repo_root / evidence_path).is_file():
                errors.append(f"task {task_id} evidence path does not exist: {evidence_path}")
        if status == "completed" and row.get("decision", "") == "blocked_by_measurement":
            errors.append(f"completed task {task_id} cannot use decision=blocked_by_measurement")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("ledger", type=Path)
    parser.add_argument(
        "--repo-root", type=Path, default=Path(__file__).resolve().parent.parent
    )
    args = parser.parse_args()
    errors = validate_ledger(args.ledger, args.repo_root)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"ledger valid: {len(TASK_IDS)} task rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
