"""Validate a sampled Fullmag solver-to-render trace artifact."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


FORMAT = "fullmag.solver_trace.v1"
MAX_TRACE_ID_BYTES = 192
SEGMENT_DOMAINS = {
    "native_to_runner_callback_ns": ("native_to_runner_callback", "server_monotonic"),
    "runner_callback_to_publisher_enqueue_ns": (
        "runner_callback_to_publisher_enqueue",
        "server_monotonic",
    ),
    "publisher_queue_ns": ("publisher_queue", "server_monotonic"),
    "publisher_apply_ns": ("publisher_apply", "server_monotonic"),
    "api_revision_visibility_ns": ("api_revision_visibility", "server_monotonic"),
    "browser_fetch_ns": ("browser_fetch", "browser_performance"),
    "browser_decode_to_commit_ns": (
        "browser_decode_to_commit",
        "browser_performance",
    ),
    "commit_to_animation_frame_ns": (
        "commit_to_animation_frame",
        "browser_performance",
    ),
}
COMPLETENESS = {"server_only", "partial", "complete"}


def _nonnegative_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _segment_entries(value: Any) -> tuple[list[tuple[str, dict[str, Any]]], list[str]]:
    failures: list[str] = []
    if isinstance(value, dict):
        return [
            (segment_id, segment)
            for segment_id, segment in value.items()
            if isinstance(segment, dict)
        ], failures
    if not isinstance(value, list):
        return [], ["segments must be an object or list"]

    entries: list[tuple[str, dict[str, Any]]] = []
    seen: set[str] = set()
    for segment in value:
        if not isinstance(segment, dict) or not isinstance(segment.get("id"), str):
            failures.append("segment list entries require a string id")
            continue
        segment_id = segment["id"]
        if segment_id in seen:
            failures.append(f"duplicate segment id: {segment_id}")
            continue
        seen.add(segment_id)
        entries.append((segment_id, segment))
    return entries, failures


def validate_trace(trace: dict[str, Any]) -> list[str]:
    """Return deterministic failures; an empty list means the trace is valid."""
    failures: list[str] = []
    if not isinstance(trace, dict):
        return ["trace must be an object"]
    if trace.get("format") != FORMAT:
        failures.append(f"unsupported trace format: {trace.get('format')!r}")

    trace_id = trace.get("trace_id")
    if not isinstance(trace_id, dict):
        failures.append("trace_id must be an object")
    else:
        value = trace_id.get("value")
        run_generation = trace_id.get("run_generation")
        numeric = ["stage_sequence", "accepted_step", "sample_sequence"]
        if not isinstance(run_generation, str) or not run_generation:
            failures.append("trace_id.run_generation must be non-empty")
        elif ":" in run_generation or any(ord(char) < 32 for char in run_generation):
            failures.append("trace_id.run_generation contains a forbidden character")
        for name in numeric:
            if not _nonnegative_integer(trace_id.get(name)):
                failures.append(f"trace_id.{name} must be a nonnegative integer")
        if not isinstance(value, str):
            failures.append("trace_id.value must be a string")
        elif len(value.encode("utf-8")) > MAX_TRACE_ID_BYTES:
            failures.append("trace_id.value exceeds 192 bytes")
        elif isinstance(run_generation, str) and all(
            _nonnegative_integer(trace_id.get(name)) for name in numeric
        ):
            expected = f"{run_generation}:{trace_id['stage_sequence']}:{trace_id['accepted_step']}:{trace_id['sample_sequence']}"
            if value != expected:
                failures.append("trace_id.value does not match its components")

    entries, segment_failures = _segment_entries(trace.get("segments"))
    failures.extend(segment_failures)
    for segment_id, segment in entries:
        expected = SEGMENT_DOMAINS.get(segment_id)
        if expected is None:
            failures.append(f"unknown segment id: {segment_id}")
            continue
        if not _nonnegative_integer(segment.get("duration_ns")):
            if isinstance(segment.get("duration_ns"), int) and not isinstance(
                segment.get("duration_ns"), bool
            ):
                failures.append(f"segment {segment_id} has negative duration_ns")
            else:
                failures.append(f"segment {segment_id} duration_ns must be a nonnegative integer")
        if segment.get("kind") != expected[0]:
            failures.append(
                f"segment {segment_id} has kind {segment.get('kind')}; expected {expected[0]}"
            )
        if segment.get("clock_domain") != expected[1]:
            failures.append(
                f"segment {segment_id} has clock_domain {segment.get('clock_domain')}; expected {expected[1]}"
            )

    api_revision = trace.get("api_revision")
    if api_revision is not None and not _nonnegative_integer(api_revision):
        failures.append("api_revision must be null or a nonnegative integer")
    if api_revision is not None and not any(
        segment_id == "api_revision_visibility_ns" for segment_id, _ in entries
    ):
        failures.append("api_revision requires api_revision_visibility_ns segment")

    completeness = trace.get("completeness")
    if completeness not in COMPLETENESS:
        failures.append(f"invalid completeness: {completeness!r}")
    segment_ids = {segment_id for segment_id, _ in entries}
    if completeness == "server_only" and segment_ids:
        failures.append("server_only trace cannot contain segments")
    if completeness == "complete" and segment_ids != set(SEGMENT_DOMAINS):
        failures.append("complete trace must contain every defined segment")
    for name in ("unaccounted_server_ns", "unaccounted_browser_ns"):
        if not _nonnegative_integer(trace.get(name)):
            failures.append(f"{name} must be a nonnegative integer")

    fetched_revision = trace.get("browser_fetch_api_revision")
    rendered_revision = trace.get("browser_render_api_revision")
    if fetched_revision is not None and rendered_revision is not None:
        if not _nonnegative_integer(fetched_revision) or not _nonnegative_integer(
            rendered_revision
        ):
            failures.append("browser revisions must be nonnegative integers")
        elif rendered_revision < fetched_revision:
            failures.append("browser render revision is older than fetched revision")

    return failures


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {Path(argv[0]).name} TRACE_JSON", file=sys.stderr)
        return 2
    path = Path(argv[1])
    try:
        trace = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"trace invalid: {error}", file=sys.stderr)
        return 1
    failures = validate_trace(trace)
    if failures:
        print("trace invalid:", file=sys.stderr)
        print("\n".join(f"- {failure}" for failure in failures), file=sys.stderr)
        return 1
    print("trace valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
