#!/usr/bin/env python3
"""Copy raw managed contract outputs into a racetrack evidence root.

This utility is deliberately not a proof generator.  It copies immutable
runtime files and logs for later review and records their hashes.  It never
creates ``proofs/*.json`` and cannot promote a qualification gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = "fdm_gpu_racetrack_contract_artifacts.v1"
SUMMARY_NAME = "fdm_gpu_racetrack_contract_artifacts.v1.json"


class CollectionError(RuntimeError):
    """A raw artifact cannot be copied safely."""


_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def _validate_label(label: str) -> None:
    if not _LABEL_PATTERN.fullmatch(label):
        raise CollectionError("label_invalid")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _copy(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise CollectionError("source_not_regular_file")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output, source.open("rb") as input_stream:
            shutil.copyfileobj(input_stream, output)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def _parse_items(items: Sequence[str], label: str) -> list[tuple[str, Path]]:
    parsed: list[tuple[str, Path]] = []
    for item in items:
        name, separator, raw_path = item.partition("=")
        if not separator or not name or not raw_path:
            raise CollectionError(f"{label}_argument_invalid")
        parsed.append((name, Path(raw_path)))
    return parsed


def collect(
    evidence_root: str | Path,
    *,
    artifacts: Sequence[tuple[str, str | Path]] = (),
    logs: Sequence[tuple[str, str | Path]] = (),
) -> dict[str, Any]:
    root = Path(evidence_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    blocked: list[str] = []
    for kind, items in (("artifact", artifacts), ("log", logs)):
        for label, raw_source in items:
            source = Path(raw_source)
            record: dict[str, Any] = {"kind": kind, "label": label, "source": str(source)}
            try:
                _validate_label(label)
                if not source.is_file() or source.is_symlink():
                    raise CollectionError("source_not_regular_file")
                destination = (root / "contracts" / kind / label / source.name).resolve()
                destination.relative_to(root)
                _copy(source, destination)
                record.update(
                    {
                        "status": "collected",
                        "path": destination.relative_to(root).as_posix(),
                        "sha256": _sha256(destination),
                        "size_bytes": destination.stat().st_size,
                    }
                )
            except (CollectionError, OSError, ValueError) as error:
                record.update({"status": "blocked", "reason_code": str(error)})
                blocked.append(f"{kind}_{label}_{error}")
            records.append(record)
    summary = {
        "schema_version": SCHEMA_VERSION,
        "status": "collected" if records and not blocked else "blocked",
        "promotion": "forbidden_raw_artifacts_only",
        "records": records,
        "reason_codes": sorted(set(blocked)),
    }
    temporary = root / f".{SUMMARY_NAME}.tmp"
    temporary.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(root / SUMMARY_NAME)
    return summary


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--artifact", action="append", default=[], help="label=/absolute/path")
    parser.add_argument("--log", action="append", default=[], help="label=/absolute/path")
    args = parser.parse_args(argv)
    try:
        result = collect(
            args.evidence_root,
            artifacts=_parse_items(args.artifact, "artifact"),
            logs=_parse_items(args.log, "log"),
        )
    except CollectionError as error:
        print(f"raw contract collection rejected: {error}")
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "collected" else 1


if __name__ == "__main__":
    raise SystemExit(main())
