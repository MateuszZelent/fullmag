#!/usr/bin/env python3
"""Capture and summarize the fixed managed FEM GPU Nsight fixture."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
from typing import Callable, Iterable, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUN_ID = "task13-box500-airbox-ncg-sm89-v1"
DEFAULT_RUNTIME_ROOT = REPO_ROOT / ".fullmag" / "runtimes" / "fem-gpu-host"
DEFAULT_OUTPUT_ROOT = REPO_ROOT / ".fullmag" / "reports" / "task-13-nsight"
FIXTURE_MANIFEST = (
    REPO_ROOT
    / "examples"
    / "assets"
    / "fem_performance"
    / "box500_airbox_exchange_demag_v2.fixture.json"
)
FIXTURE_ENVIRONMENT = (
    REPO_ROOT
    / "benchmarks"
    / "fem-gpu"
    / "accepted"
    / "rtx4080-sm89"
    / "nsight-v2-environment.json"
)
NSYS_STATS_REPORTS = ("cuda_api_sum", "cuda_gpu_kern_sum", "nvtx_sum")
REQUIRED_NVTX_RANGES = (
    "fem.relax.ncg.step",
    "fem.relax.armijo",
    "fem.demag.rhs",
    "fem.demag.hypre.apply",
    "fullmag.demag.wait_in_enqueue",
    "fullmag.demag.hypre_mult_host",
    "fullmag.demag.hypre_device",
    "fullmag.demag.wait_out_enqueue",
    "fem.demag.recovery",
    "fem.preview.snapshot",
    "fem.host.callback",
    "fem.host.publish",
)
COMPUTE_NVTX_RANGES = (
    "fem.relax.ncg.step",
    "fem.relax.armijo",
    "fem.demag.rhs",
    "fem.demag.hypre.apply",
    "fullmag.demag.wait_in_enqueue",
    "fullmag.demag.hypre_mult_host",
    "fullmag.demag.hypre_device",
    "fullmag.demag.wait_out_enqueue",
    "fem.demag.recovery",
)
HOST_NVTX_RANGES = (
    "fem.preview.snapshot",
    "fem.host.callback",
    "fem.host.publish",
)
TRACE_PHASE_RANGES = {
    "setup": ("fem.gpu.setup",),
    "attempt": ("fem.relax.ncg.step",),
    "accepted_finalization": ("fem.gpu.accepted_finalization",),
    "snapshot": ("fem.preview.snapshot",),
    "export": ("fem.host.publish",),
}
NCU_SECTIONS = ("LaunchStats", "Occupancy", "SpeedOfLight", "WarpStateStats")
NCU_TIMEOUT_SECONDS = 120
DIRECT_MINIMIZER_CAPTURE_ALGORITHMS = (
    "nonlinear_cg",
    "projected_gradient_bb",
)
DIRECT_MINIMIZER_CAPTURE_STRATEGIES = (
    "none",
    "diagonal",
    "exchange_mass_cg4",
    "exchange_mass_cg8",
)
DIRECT_MINIMIZER_CAPTURE_IDENTITY_FIELDS = (
    "source_commit",
    "source_snapshot_sha256",
    "workload_sha256",
    "mesh_sha256",
    "gpu_uuid",
    "runtime_manifest_sha256",
    "final_artifact_sha256",
)


Runner = Callable[..., subprocess.CompletedProcess[str]]


def trace_phase_failures(observed_ranges: Iterable[str]) -> list[str]:
    observed = set(observed_ranges)
    return [
        f"{phase} trace phase is missing"
        for phase, candidates in TRACE_PHASE_RANGES.items()
        if not observed.intersection(candidates)
    ]


def ordered_trace_phase_failures(
    events: Sequence[Mapping[str, object]],
) -> list[str]:
    """Require setup through export in order within one Nsight capture."""
    nvtx_events = sorted(
        (
            event
            for event in events
            if event.get("kind") == "nvtx"
            and isinstance(event.get("start_ns"), int)
        ),
        key=lambda event: int(event["start_ns"]),
    )
    previous_start: int | None = None
    failures: list[str] = []
    for phase, candidates in TRACE_PHASE_RANGES.items():
        match = next(
            (
                event
                for event in nvtx_events
                if event.get("name") in candidates
                and (
                    previous_start is None
                    or int(event["start_ns"]) >= previous_start
                )
            ),
            None,
        )
        if match is None:
            failures.append(f"{phase} trace phase is missing or out of order")
            continue
        previous_start = int(match["start_ns"])
    return failures


def not_verified_payload(
    *, run_id: str, blockers: Sequence[object]
) -> dict[str, object]:
    return {
        "schema": "fullmag.fem_gpu.nsight_capture.v1",
        "status": "unavailable",
        "qualification_status": "NOT VERIFIED",
        "run_id": run_id,
        "trace_scope": {
            "from": "setup",
            "through": "export",
            "phases": list(TRACE_PHASE_RANGES),
        },
        "blockers": [str(value) for value in blockers],
    }


def _run_text(
    runner: Runner,
    command: list[str],
    **kwargs: object,
) -> subprocess.CompletedProcess[str]:
    return runner(command, capture_output=True, text=True, check=False, **kwargs)


def preflight_tools(runner: Runner = subprocess.run) -> dict[str, object]:
    tools: dict[str, dict[str, object]] = {}
    blockers: list[str] = []
    reasons: list[str] = []
    for tool in ("nsys", "ncu"):
        try:
            completed = _run_text(runner, [tool, "--version"])
        except OSError as exc:
            completed = subprocess.CompletedProcess([tool, "--version"], 127, "", str(exc))
        output = "\n".join(part.strip() for part in (completed.stdout, completed.stderr) if part.strip())
        available = completed.returncode == 0
        tools[tool] = {
            "available": available,
            "version": output if available else None,
            "error": None if available else (output or f"{tool} --version failed"),
            "reason": None if available else "missing_binary",
        }
        if not available:
            blockers.append(f"{tool} unavailable in managed fixture image")

    # A tool version is not evidence that a CUDA device is visible.  Probe the
    # device before any runtime rebuild or Nsight capture.  This command does
    # not launch a workload and therefore cannot manufacture a trace.
    device_command = [
        "nvidia-smi",
        "--query-gpu=name,driver_version",
        "--format=csv,noheader,nounits",
    ]
    if shutil.which(device_command[0]) is None:
        device = {
            "available": False,
            "driver": None,
            "error": "nvidia-smi binary is missing",
            "reason": "no_cuda_device",
        }
        reasons.append("no_cuda_device")
        blockers.append("no CUDA device: nvidia-smi binary is missing")
    else:
        try:
            completed = _run_text(runner, device_command)
        except OSError as exc:
            completed = subprocess.CompletedProcess(device_command, 127, "", str(exc))
        output = "\n".join(
            part.strip() for part in (completed.stdout, completed.stderr) if part.strip()
        )
        error_code = _ncu_error_code(output)
        lowered = output.lower()
        if completed.returncode != 0:
            if error_code == "ERR_NVGPUCTRPERM" or "permission" in lowered:
                reason = "permission"
                reasons.append(reason)
                blockers.append(
                    f"permission: CUDA device probe failed ({error_code or output})"
                )
            elif "driver" in lowered and (
                "mismatch" in lowered or "version" in lowered or "failed" in lowered
            ):
                reason = "driver_tool_mismatch"
                reasons.append(reason)
                blockers.append(
                    f"driver/tool mismatch: CUDA device probe failed ({output})"
                )
            else:
                reason = "no_cuda_device"
                reasons.append(reason)
                blockers.append(
                    f"no CUDA device: nvidia-smi exited {completed.returncode}"
                )
            device = {
                "available": False,
                "driver": None,
                "error": output or f"nvidia-smi exited {completed.returncode}",
                "reason": reason,
            }
        else:
            rows = [line.strip() for line in output.splitlines() if line.strip()]
            if not rows:
                reasons.append("no_cuda_device")
                blockers.append("no CUDA device: nvidia-smi returned no GPUs")
                device = {
                    "available": False,
                    "driver": None,
                    "error": "nvidia-smi returned no GPUs",
                    "reason": "no_cuda_device",
                }
            else:
                device = {
                    "available": True,
                    "driver": rows[0].split(",", 1)[1].strip()
                    if "," in rows[0]
                    else None,
                    "error": None,
                    "reason": None,
                    "gpu_count": len(rows),
                }
    return {
        "status": "available" if not blockers else "unavailable",
        "tools": tools,
        "cuda_device": device,
        "reasons": reasons,
        "blockers": blockers,
    }


def parse_nsys_csv(text: str) -> list[dict[str, str]]:
    lines = [line for line in text.splitlines() if line.strip() and not line.startswith("Generating ")]
    if not lines:
        return []
    return [
        {str(key).strip(): str(value).strip() for key, value in row.items() if key is not None}
        for row in csv.DictReader(io.StringIO("\n".join(lines)))
    ]


def parse_ncu_csv(text: str) -> list[dict[str, str]]:
    lines = text.splitlines()
    header_index = next(
        (
            index
            for index, line in enumerate(lines)
            if "Kernel Name" in line and "Metric Name" in line
        ),
        None,
    )
    if header_index is None:
        return []
    return [
        {str(key).strip(): str(value).strip() for key, value in row.items() if key is not None}
        for row in csv.DictReader(io.StringIO("\n".join(lines[header_index:])))
    ]


def _field(row: Mapping[str, object], *candidates: str) -> object | None:
    normalized = {re.sub(r"[^a-z0-9]", "", key.lower()): value for key, value in row.items()}
    for candidate in candidates:
        key = re.sub(r"[^a-z0-9]", "", candidate.lower())
        if key in normalized:
            return normalized[key]
    return None


def _int_field(row: Mapping[str, object], *candidates: str) -> int:
    value = _field(row, *candidates)
    if value is None:
        return 0
    text = str(value).replace(",", "").strip()
    try:
        return int(float(text))
    except ValueError:
        return 0


def _name_field(row: Mapping[str, object]) -> str:
    return str(_field(row, "Name", "Range", "Kernel Name") or "")


def _fixture_mesh_counts(fixture: Mapping[str, object]) -> dict[str, int]:
    aliases = {
        "solver_mesh_node_count": ("solver_mesh_node_count", "node_count"),
        "solver_mesh_cell_count": (
            "solver_mesh_cell_count",
            "cell_count",
            "element_count",
        ),
        "solver_mesh_facet_count": ("solver_mesh_facet_count", "facet_count"),
        "solver_mesh_exterior_facet_count": (
            "solver_mesh_exterior_facet_count",
            "exterior_facet_count",
        ),
        "solver_mesh_interface_facet_count": (
            "solver_mesh_interface_facet_count",
            "interface_facet_count",
        ),
    }
    counts: dict[str, int] = {}
    for output, candidates in aliases.items():
        values = [fixture[name] for name in candidates if name in fixture]
        if not values:
            continue
        parsed = [int(value) for value in values]
        if any(value != parsed[0] for value in parsed[1:]):
            raise ValueError(f"fixture has conflicting {output} aliases")
        counts[output] = parsed[0]
    return counts


def _percentile(values: Sequence[int], percentile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def _union_duration(intervals: Iterable[tuple[int, int]]) -> int:
    ordered = sorted((start, end) for start, end in intervals if end > start)
    if not ordered:
        return 0
    total = 0
    current_start, current_end = ordered[0]
    for start, end in ordered[1:]:
        if start <= current_end:
            current_end = max(current_end, end)
            continue
        total += current_end - current_start
        current_start, current_end = start, end
    return total + current_end - current_start


def summarize_stats(
    api_rows: Sequence[Mapping[str, object]],
    kernel_rows: Sequence[Mapping[str, object]],
    nvtx_rows: Sequence[Mapping[str, object]],
    timeline_events: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    stream_wait_rows = [row for row in api_rows if "streamwaitevent" in _name_field(row).lower()]
    stream_waits = {
        "count": sum(_int_field(row, "Num Calls", "Instances") for row in stream_wait_rows),
        "total_time_ns": sum(_int_field(row, "Total Time (ns)") for row in stream_wait_rows),
    }
    hypre_rows = [row for row in nvtx_rows if _name_field(row) == "fem.demag.hypre.apply"]
    hypre_apply = {
        "count": sum(_int_field(row, "Instances", "Num Calls") for row in hypre_rows),
        "total_time_ns": sum(_int_field(row, "Total Time (ns)") for row in hypre_rows),
    }

    def nvtx_range_summary(name: str) -> dict[str, int]:
        rows = [row for row in nvtx_rows if _name_field(row) == name]
        return {
            "count": sum(_int_field(row, "Instances", "Num Calls") for row in rows),
            "total_time_ns": sum(_int_field(row, "Total Time (ns)") for row in rows),
        }

    hypre_timing_ranges = {
        name: nvtx_range_summary(name)
        for name in (
            "fullmag.demag.wait_in_enqueue",
            "fullmag.demag.hypre_mult_host",
            "fullmag.demag.hypre_device",
            "fullmag.demag.wait_out_enqueue",
        )
    }
    kernel_count = sum(_int_field(row, "Instances", "Num Calls") for row in kernel_rows)
    reduction_count = sum(
        _int_field(row, "Instances", "Num Calls")
        for row in kernel_rows
        if re.search(r"reduce|reduction|cub::", _name_field(row), re.IGNORECASE)
    )

    kernel_events = sorted(
        (event for event in timeline_events if event.get("kind") == "kernel"),
        key=lambda event: int(event["start_ns"]),
    )
    memcpy_events = sorted(
        (event for event in timeline_events if event.get("kind") == "memcpy"),
        key=lambda event: int(event["start_ns"]),
    )
    launches_by_thread: dict[object, list[Mapping[str, object]]] = {}
    for event in timeline_events:
        if event.get("kind") != "runtime" or not re.match(
            r"^(?:cuda|cu)Launch", str(event.get("name", ""))
        ):
            continue
        launches_by_thread.setdefault(event.get("thread_id"), []).append(event)
    launch_gaps: list[int] = []
    for launch_events in launches_by_thread.values():
        ordered_launches = sorted(
            launch_events,
            key=lambda event: int(event["start_ns"]),
        )
        launch_gaps.extend(
            max(0, int(current["start_ns"]) - int(previous["end_ns"]))
            for previous, current in zip(ordered_launches, ordered_launches[1:])
        )
    launch_gaps = [gap for gap in launch_gaps if gap > 0]
    gap_summary = {
        "count": len(launch_gaps),
        "max": max(launch_gaps, default=0),
        "p50": _percentile(launch_gaps, 0.50),
        "p95": _percentile(launch_gaps, 0.95),
    }

    def named_events(name: str) -> list[Mapping[str, object]]:
        return [
            event
            for event in timeline_events
            if event.get("kind") == "nvtx" and event.get("name") == name
        ]

    def preview_overlap(gpu_events: Sequence[Mapping[str, object]]) -> int:
        return _union_duration(
            (
                max(int(preview["start_ns"]), int(gpu["start_ns"])),
                min(int(preview["end_ns"]), int(gpu["end_ns"])),
            )
            for preview in named_events("fem.preview.snapshot")
            for gpu in gpu_events
        )

    preview_kernel_overlap = preview_overlap(kernel_events)
    preview_memcpy_overlap = preview_overlap(memcpy_events)
    preview_gpu_overlap = preview_overlap([*kernel_events, *memcpy_events])
    callback_publish_overlap = _union_duration(
        (
            max(int(callback["start_ns"]), int(publisher["start_ns"])),
            min(int(callback["end_ns"]), int(publisher["end_ns"])),
        )
        for callback in named_events("fem.host.callback")
        for publisher in named_events("fem.host.publish")
    )
    observed_ranges = sorted({_name_field(row) for row in nvtx_rows if _name_field(row)})
    return {
        "cpu_launch_gaps_ns": gap_summary,
        "stream_waits": stream_waits,
        "hypre_apply": hypre_apply,
        "hypre_timing_ranges": hypre_timing_ranges,
        "kernels": {
            "count": kernel_count,
            "reduction_count": reduction_count,
            "top_five": top_kernel_names(kernel_rows),
        },
        "overlap_ns": {
            "preview_with_gpu": preview_gpu_overlap,
            "preview_with_kernels": preview_kernel_overlap,
            "preview_with_memcpy": preview_memcpy_overlap,
            "callback_with_publish": callback_publish_overlap,
        },
        "nvtx_ranges_observed": observed_ranges,
        "nvtx_ranges_missing": sorted(set(REQUIRED_NVTX_RANGES) - set(observed_ranges)),
    }


def top_kernel_names(rows: Sequence[Mapping[str, object]], limit: int = 5) -> list[str]:
    ordered = sorted(
        rows,
        key=lambda row: _int_field(row, "Total Time (ns)"),
        reverse=True,
    )
    names: list[str] = []
    for row in ordered:
        name = _name_field(row)
        if name and name not in names:
            names.append(name)
        if len(names) == limit:
            break
    return names


def build_nsys_stats_command(report: Path, output_prefix: Path) -> list[str]:
    return [
        "nsys",
        "stats",
        "--force-overwrite=true",
        "--force-export=true",
        "--report",
        ",".join(NSYS_STATS_REPORTS),
        "--format",
        "csv",
        "--output",
        str(output_prefix),
        str(report),
    ]


def build_nsys_profile_command(
    fixture_command: Sequence[str], trace_prefix: Path
) -> list[str]:
    return [
        "nsys",
        "profile",
        "--force-overwrite=true",
        "--trace=cuda,nvtx,osrt",
        "--sample=none",
        "--cpuctxsw=none",
        "--cuda-flush-interval",
        "1000",
        "--output",
        str(trace_prefix),
        *fixture_command,
    ]


def build_ncu_command(
    kernel_name: str,
    fixture_command: Sequence[str],
    output_prefix: Path,
) -> list[str]:
    command = [
        "ncu",
        "--force-overwrite",
        "--target-processes",
        "all",
        "--kernel-name-base",
        "demangled",
        "--rename-kernels",
        "off",
        "--kernel-name",
        kernel_name,
        "--launch-count",
        "1",
        "--kill",
        "yes",
        "--csv",
        "--page",
        "raw",
        "--log-file",
        str(output_prefix.with_suffix(".csv")),
        "--export",
        str(output_prefix),
    ]
    for section in NCU_SECTIONS:
        command.extend(["--section", section])
    command.extend(fixture_command)
    return command


def build_ncu_access_probe_command(
    fixture_command: Sequence[str], output_prefix: Path
) -> list[str]:
    return [
        "ncu",
        "--force-overwrite",
        "--target-processes",
        "all",
        "--launch-count",
        "1",
        "--kill",
        "yes",
        "--section",
        "LaunchStats",
        "--csv",
        "--export",
        str(output_prefix),
        *fixture_command,
    ]


def run_ncu_access_probe(
    fixture_command: Sequence[str],
    output_dir: Path,
    environment: Mapping[str, str],
    *,
    runner: Runner = subprocess.run,
) -> dict[str, object]:
    command = build_ncu_access_probe_command(
        fixture_command, output_dir / "ncu-access-probe"
    )
    try:
        completed = runner(
            command,
            cwd=REPO_ROOT,
            env=dict(environment),
            capture_output=True,
            text=True,
            check=False,
            timeout=NCU_TIMEOUT_SECONDS,
        )
        returncode: int | None = completed.returncode
        output = _subprocess_output_text(completed.stdout, completed.stderr)
    except subprocess.TimeoutExpired as exc:
        returncode = None
        output = _subprocess_output_text(exc.stdout, exc.stderr)
        output += (
            f"\nncu access probe timed out after {NCU_TIMEOUT_SECONDS} seconds\n"
        )
    (output_dir / "ncu-access-probe.log").write_text(output, encoding="utf-8")
    error_match = re.search(r"\b(ERR_[A-Z0-9_]+)\b", output)
    error_code = error_match.group(1) if error_match else None
    if returncode == 0:
        status = "available"
        blocker = None
    elif error_code is not None:
        status = "unavailable"
        blocker = f"ncu access probe failed: {error_code}"
    elif returncode is None:
        status = "unavailable"
        blocker = "ncu access probe timed out after 120 seconds"
    else:
        status = "unavailable"
        blocker = f"ncu access probe exited {returncode}"
    return {
        "status": status,
        "returncode": returncode,
        "error_code": error_code,
        "blocker": blocker,
        "command": command,
        "log": os.path.relpath(output_dir / "ncu-access-probe.log", REPO_ROOT),
    }


def _subprocess_output_text(*parts: object) -> str:
    return "".join(
        part.decode(errors="replace") if isinstance(part, bytes) else str(part or "")
        for part in parts
    )


def _ncu_error_code(output: str) -> str | None:
    match = re.search(r"\b(ERR_[A-Z0-9_]+)\b", output)
    return match.group(1) if match else None


def run_ncu_top_kernel_pass(
    command: Sequence[str],
    output_dir: Path,
    index: int,
    environment: Mapping[str, str],
    *,
    runner: Runner = subprocess.run,
) -> dict[str, object]:
    try:
        completed = runner(
            command,
            cwd=REPO_ROOT,
            env=dict(environment),
            capture_output=True,
            text=True,
            check=False,
            timeout=NCU_TIMEOUT_SECONDS,
        )
        returncode: int | None = completed.returncode
        output = _subprocess_output_text(completed.stdout, completed.stderr)
    except subprocess.TimeoutExpired as exc:
        returncode = None
        output = _subprocess_output_text(exc.stdout, exc.stderr)
        output += (
            f"\nncu top-kernel pass {index} timed out after "
            f"{NCU_TIMEOUT_SECONDS} seconds\n"
        )
    log_path = output_dir / f"ncu-{index:02d}.log"
    log_path.write_text(output, encoding="utf-8")
    error_code = _ncu_error_code(output)
    if returncode == 0:
        status = "available"
        blocker = None
    elif error_code is not None:
        status = "unavailable"
        blocker = f"ncu top-kernel pass {index} failed: {error_code}"
    elif returncode is None:
        status = "unavailable"
        blocker = (
            f"ncu top-kernel pass {index} timed out after "
            f"{NCU_TIMEOUT_SECONDS} seconds"
        )
    else:
        status = "unavailable"
        blocker = f"ncu top-kernel pass {index} exited {returncode}"
    return {
        "status": status,
        "returncode": returncode,
        "error_code": error_code,
        "blocker": blocker,
        "command": list(command),
        "log": os.path.relpath(log_path, REPO_ROOT),
    }


def build_ncu_commands(
    kernel_names: Sequence[str],
    fixture_command: Sequence[str],
    output_dir: Path,
) -> list[list[str]]:
    return [
        build_ncu_command(
            kernel_name,
            fixture_command,
            output_dir / f"top-kernel-{index:02d}",
        )
        for index, kernel_name in enumerate(kernel_names[:5], start=1)
    ]


def parse_ncu_metrics(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, dict[str, list[dict[str, str]]]]:
    parsed: dict[str, dict[str, list[dict[str, str]]]] = {}
    for row in rows:
        kernel = str(_field(row, "Kernel Name", "Kernel") or "").strip()
        name = str(_field(row, "Metric Name", "Metric") or "").strip()
        value = str(_field(row, "Metric Value", "Value") or "").strip()
        unit = str(_field(row, "Metric Unit", "Unit") or "").strip()
        if not kernel or not name:
            continue
        try:
            numeric_value = float(value.replace(",", "").rstrip("%"))
        except ValueError:
            continue
        if not math.isfinite(numeric_value):
            continue
        normalized_name = " ".join(name.lower().split())
        if "achieved occupancy" in normalized_name:
            group = "occupancy"
        elif any(
            marker in normalized_name
            for marker in (
                "dram throughput",
                "dram bandwidth",
                "memory throughput",
                "memory bandwidth",
            )
        ):
            group = "achieved_bandwidth"
        elif "grid size" in normalized_name or re.search(
            r"\bgrid(?: dimension)? [xyz]\b", normalized_name
        ):
            group = "launch_grid"
        elif "stall" in normalized_name:
            group = "warp_stalls"
        else:
            continue
        kernel_metrics = parsed.setdefault(
            kernel,
            {
                "occupancy": [],
                "achieved_bandwidth": [],
                "launch_grid": [],
                "warp_stalls": [],
            },
        )
        kernel_metrics[group].append({"name": name, "unit": unit, "value": value})
    return parsed


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect_bundle_identity(runtime_root: Path) -> dict[str, object]:
    runtime_root = runtime_root.resolve()
    manifest_path = runtime_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    build = manifest.get("build") if isinstance(manifest.get("build"), Mapping) else {}
    binaries = manifest.get("binaries")
    integrity = manifest.get("integrity")
    libraries = manifest.get("native_libraries")
    if not isinstance(binaries, Mapping) or not isinstance(integrity, Mapping):
        raise ValueError("runtime manifest binary integrity is missing")
    if not isinstance(libraries, Mapping):
        raise ValueError("runtime manifest native library integrity is missing")

    def verified_sha256(path_value: object, expected_value: object, label: str) -> str:
        if not isinstance(path_value, str) or not path_value:
            raise ValueError(f"runtime manifest has no {label} path")
        path = (runtime_root / path_value).resolve()
        try:
            path.relative_to(runtime_root)
        except ValueError as exc:
            raise ValueError(f"runtime manifest {label} path escapes bundle") from exc
        if not path.is_file():
            raise ValueError(f"runtime manifest {label} is missing: {path}")
        if not isinstance(expected_value, str) or not re.fullmatch(
            r"[0-9a-f]{64}", expected_value
        ):
            raise ValueError(f"runtime manifest has invalid {label} sha256")
        actual = _sha256(path)
        if actual != expected_value:
            raise ValueError(
                f"{label} sha256 mismatch: expected {expected_value}, got {actual}"
            )
        return actual

    binary_digests = {
        str(name): verified_sha256(
            path,
            integrity.get(f"{name}_sha256"),
            str(name),
        )
        for name, path in binaries.items()
    }
    fullmag_fem = libraries.get("fullmag_fem")
    if not isinstance(fullmag_fem, Mapping):
        raise ValueError("runtime manifest native_libraries.fullmag_fem is missing")
    library_digests = {}
    for name, entry in libraries.items():
        if not isinstance(entry, Mapping):
            raise ValueError(f"runtime manifest {name} entry is invalid")
        library_digests[str(name)] = verified_sha256(
            entry.get("path"),
            entry.get("sha256"),
            str(name),
        )
    instrumentation = (
        manifest.get("instrumentation")
        if isinstance(manifest.get("instrumentation"), Mapping)
        else {}
    )
    provenance = (
        manifest.get("source_provenance")
        if isinstance(manifest.get("source_provenance"), Mapping)
        else {}
    )
    return {
        "runtime_root": str(runtime_root),
        "manifest_sha256": _sha256(manifest_path),
        "runtime_git_commit": provenance.get("git_commit"),
        "runtime_git_tree": provenance.get("git_tree"),
        "runtime_source_inputs_sha256": provenance.get("source_inputs_sha256"),
        "runtime_dirty": provenance.get("dirty"),
        "runtime_dirty_patch_sha256": provenance.get("dirty_patch_sha256"),
        "docker_image": manifest.get("docker_image"),
        "docker_image_id": manifest.get("docker_image_id"),
        "requested_cuda_architectures": build.get("requested_cuda_architectures"),
        "effective_cuda_architectures": build.get("effective_cuda_architectures", []),
        "nvtx_enabled": instrumentation.get("nvtx_enabled") is True,
        "binaries": binary_digests,
        "libraries": library_digests,
    }


def direct_minimizer_capture_summary(
    capture_case: Mapping[str, object],
    benchmark_case: Mapping[str, object],
) -> dict[str, object]:
    """Bind one Nsight repeat-1 capture to, but never replace, five repeats."""
    blockers: list[str] = []
    if capture_case.get("repeat_count") != 1:
        blockers.append("Nsight direct-minimizer capture requires repeat_count=1")
    if capture_case.get("relaxation_algorithm") not in DIRECT_MINIMIZER_CAPTURE_ALGORITHMS:
        blockers.append("Nsight direct-minimizer capture has an unsupported algorithm")
    if (
        capture_case.get("relaxation_preconditioner_strategy")
        not in DIRECT_MINIMIZER_CAPTURE_STRATEGIES
    ):
        blockers.append("Nsight direct-minimizer capture has an unsupported strategy")
    if benchmark_case.get("measured_repetitions") != 5:
        blockers.append(
            "Nsight repeat-1 capture cannot replace the required five benchmark repetitions"
        )
    capture_identity = capture_case.get("identity")
    benchmark_identity = benchmark_case.get("identity")
    if not isinstance(capture_identity, Mapping) or not isinstance(
        benchmark_identity, Mapping
    ):
        blockers.append("Nsight capture and benchmark require complete identity objects")
    else:
        for field in DIRECT_MINIMIZER_CAPTURE_IDENTITY_FIELDS:
            capture_value = capture_identity.get(field)
            benchmark_value = benchmark_identity.get(field)
            if not capture_value or not benchmark_value:
                blockers.append(f"Nsight identity {field} is missing")
            elif capture_value != benchmark_value:
                blockers.append(
                    f"Nsight identity {field} differs from the five-repeat benchmark"
                )
    return {
        "schema": "fullmag.fem_gpu.direct_minimizer_nsight_capture.v1",
        "qualification_status": "NOT VERIFIED",
        "repeat_count": capture_case.get("repeat_count"),
        "benchmark_measured_repetitions": benchmark_case.get("measured_repetitions"),
        "relaxation_algorithm": capture_case.get("relaxation_algorithm"),
        "relaxation_preconditioner_strategy": capture_case.get(
            "relaxation_preconditioner_strategy"
        ),
        "blockers": blockers,
        "promotion_blocker": (
            "Nsight is a separate residency capture and does not qualify a "
            "direct-minimizer strategy without five timing repeats, parity and physics"
        ),
    }


def write_direct_minimizer_capture_summary(
    output_path: Path,
    capture_case: Mapping[str, object],
    benchmark_case: Mapping[str, object],
) -> dict[str, object]:
    summary = direct_minimizer_capture_summary(capture_case, benchmark_case)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        "FEM_DIRECT_MINIMIZER_CAPTURE_SUMMARY="
        + json.dumps(summary, sort_keys=True)
    )
    return summary


def write_summary_artifacts(output_dir: Path, payload: Mapping[str, object]) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "summary.json"
    markdown_path = output_dir / "report.md"
    json_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    lines = [
        "# FEM GPU Nsight capture",
        "",
        f"- status: `{payload.get('status', 'unknown')}`",
        f"- run ID: `{payload.get('run_id', '')}`",
    ]
    bundle = payload.get("bundle")
    if isinstance(bundle, Mapping):
        lines.extend(
            [
                f"- runtime manifest SHA-256: `{bundle.get('manifest_sha256', '')}`",
                f"- runtime Git commit: `{bundle.get('runtime_git_commit', '')}`",
                f"- runtime source-input SHA-256: `{bundle.get('runtime_source_inputs_sha256', '')}`",
                f"- runtime dirty: `{bundle.get('runtime_dirty', '')}`",
                f"- requested CUDA architectures: `{bundle.get('requested_cuda_architectures', '')}`",
                f"- effective CUDA architectures: `{bundle.get('effective_cuda_architectures', [])}`",
            ]
        )
    blockers = payload.get("blockers")
    if isinstance(blockers, list) and blockers:
        lines.extend(["", "## Blockers", ""] + [f"- {blocker}" for blocker in blockers])
    metrics = payload.get("metrics")
    if isinstance(metrics, Mapping):
        lines.extend(["", "## Parsed metrics", "", "```json", json.dumps(metrics, indent=2, sort_keys=True), "```"])
    markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, markdown_path


def _string_table(connection: sqlite3.Connection) -> dict[int, str]:
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "StringIds" not in tables:
        return {}
    columns = [row[1] for row in connection.execute("PRAGMA table_info(StringIds)")]
    id_column = next((column for column in columns if column.lower() in {"id", "stringid"}), None)
    value_column = next((column for column in columns if column.lower() in {"value", "string", "text"}), None)
    if id_column is None or value_column is None:
        return {}
    return {
        int(row[0]): str(row[1])
        for row in connection.execute(f'SELECT "{id_column}", "{value_column}" FROM StringIds')
    }


def load_timeline_events(sqlite_path: Path) -> list[dict[str, object]]:
    connection = sqlite3.connect(sqlite_path)
    try:
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        strings = _string_table(connection)
        events: list[dict[str, object]] = []
        for table in tables:
            upper = table.upper()
            if not any(
                marker in upper for marker in ("KERNEL", "MEMCPY", "NVTX", "RUNTIME")
            ):
                continue
            columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
            lower = {column.lower(): column for column in columns}
            start_column = lower.get("start") or lower.get("startns")
            end_column = lower.get("end") or lower.get("endns")
            if start_column is None or end_column is None:
                continue
            if "KERNEL" in upper:
                name_candidates = ("demangledname", "shortname", "name")
            elif "MEMCPY" in upper:
                name_candidates = ("name",)
            elif "NVTX" in upper:
                name_candidates = ("text", "textid", "name")
            else:
                name_candidates = ("name", "nameid")
            name_columns = [lower[key] for key in name_candidates if key in lower]
            if "MEMCPY" in upper and not name_columns:
                name_expression = "'memcpy'"
            elif not name_columns:
                continue
            else:
                name_parts = [f'NULLIF("{column}", \'\')' for column in name_columns]
                name_expression = (
                    name_parts[0]
                    if len(name_parts) == 1
                    else "COALESCE(" + ", ".join(name_parts) + ")"
                )
            thread_column = next(
                (lower[key] for key in ("globaltid", "threadid", "tid") if key in lower),
                None,
            )
            thread_expression = f'"{thread_column}"' if thread_column else "NULL"
            for start, end, raw_name, thread_id in connection.execute(
                f'SELECT "{start_column}", "{end_column}", {name_expression}, '
                f'{thread_expression} FROM "{table}" '
                f'WHERE "{end_column}" IS NOT NULL'
            ):
                name = strings.get(raw_name, str(raw_name)) if isinstance(raw_name, int) else str(raw_name)
                events.append(
                    {
                        "kind": (
                            "nvtx"
                            if "NVTX" in upper
                            else "runtime"
                            if "RUNTIME" in upper
                            else "memcpy"
                            if "MEMCPY" in upper
                            else "kernel"
                        ),
                        "name": name,
                        "start_ns": int(start),
                        "end_ns": int(end),
                        "thread_id": thread_id,
                    }
                )
        return events
    finally:
        connection.close()


def _stats_csv(output_prefix: Path, report_name: str) -> Path:
    matches = sorted(output_prefix.parent.glob(f"{output_prefix.name}*{report_name}*.csv"))
    if len(matches) != 1:
        raise ValueError(f"expected one {report_name} CSV from nsys stats, got {matches}")
    return matches[0]


def _stats_rows(
    output_prefix: Path, report_name: str, *, optional: bool = False
) -> list[dict[str, str]]:
    try:
        path = _stats_csv(output_prefix, report_name)
    except ValueError:
        if optional:
            return []
        raise
    return parse_nsys_csv(path.read_text(encoding="utf-8"))


def _benchmark_command(output_dir: Path, *, interactive: bool) -> list[str]:
    command = [
        "python3",
        "scripts/analysis/fem_gpu_benchmark.py",
        "--meshes",
        "coarse",
        "--scenarios",
        "box500_airbox_exchange_demag",
        "--integrators",
        "heun",
        "--relax-algorithms",
        "nonlinear_cg",
        "--backends",
        "gpu",
        "--demag-preconditioners",
        "AMG",
        "--demag-amg-relax-types",
        "6",
        "--steps",
        "64",
        "--repeat",
        "1",
        "--reuse-generated-domain-mesh",
        "--require-stable-solver-mesh",
        "--require-demag-converged",
        "--require-gpu-strict-residency",
        "--require-gpu-control-readback-budget",
    ]
    if interactive:
        command.extend(["--ui-surface", "interactive"])
    else:
        command.extend(
            [
                "--fixture-manifest",
                str(FIXTURE_MANIFEST),
                "--fixture-environment",
                str(FIXTURE_ENVIRONMENT),
                "--require-fixture-identity",
            ]
        )
    command.extend(
        [
            "--output",
            str(output_dir / "fixture.csv"),
            "--quiet-json-summary",
        ]
    )
    return command


def _fixture_command(output_dir: Path) -> list[str]:
    return _benchmark_command(output_dir, interactive=False)


def _interactive_fixture_command(output_dir: Path) -> list[str]:
    return _benchmark_command(output_dir, interactive=True)


def capture_environment(
    base: Mapping[str, str] | None = None, *, interactive: bool = False
) -> dict[str, str]:
    environment = dict(os.environ if base is None else base)
    environment.update(
        {
            "PYTHONPATH": "/workspace/packages/fullmag-py/src",
            "FULLMAG_PYTHON": "/usr/bin/python3",
            "FULLMAG_BENCH_DOMAIN_HMAX": "50e-9",
            "FULLMAG_BENCH_AIRBOX_HMAX": "100e-9",
            "FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE": "1e-6",
            "FULLMAG_FEM_EXECUTION": "gpu",
            "FULLMAG_RELAX_DEVICE": "gpu",
            "FULLMAG_FEM_MFEM_DEVICE": "cuda",
            "FULLMAG_FEM_GPU_DEMAG_MODE": "device_hypre_poisson",
            "FULLMAG_FEM_STEP_PROFILE": "1",
        }
    )
    if interactive:
        environment["FULLMAG_BENCH_DOMAIN_MESH"] = str(
            FIXTURE_MANIFEST.parent / "box500_airbox_exchange_demag_v2.mesh.json"
        )
    return environment


def read_execution_identity(csv_path: Path, label: str) -> dict[str, str]:
    with csv_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != 1:
        raise ValueError(f"{label} pass did not produce exactly one row")
    row = rows[0]
    return {
        "status": str(row.get("status") or ""),
        "problem_ir_sha256": str(row.get("executed_problem_ir_sha256") or ""),
        "solver_mesh_sha256": str(row.get("solver_mesh_sha256") or ""),
        "solver_mesh_signature": str(row.get("solver_mesh_signature") or ""),
        "reported_scenario": str(row.get("reported_scenario") or ""),
        "reported_integrator": str(row.get("reported_integrator") or ""),
        "reported_relaxation_algorithm": str(
            row.get("reported_relaxation_algorithm") or ""
        ),
        "reported_timestep_policy": str(
            row.get("reported_timestep_policy") or ""
        ),
        "requested_steps": str(row.get("steps") or ""),
        "executed_steps": str(row.get("executed_steps") or ""),
    }


def execution_identity_failures(
    actual: Mapping[str, object],
    expected: Mapping[str, object],
    *,
    label: str,
    require_problem_ir_match: bool,
) -> list[str]:
    failures: list[str] = []
    status = str(actual.get("status") or "")
    if status != "ok":
        failures.append(f"{label} status differs from completed execution: expected ok, got {status}")
    problem_ir_sha256 = str(actual.get("problem_ir_sha256") or "")
    if re.fullmatch(r"[0-9a-f]{64}", problem_ir_sha256) is None:
        failures.append(
            f"{label} executed_problem_ir_sha256 must be a canonical lowercase SHA-256"
        )
    elif require_problem_ir_match:
        expected_problem_ir_sha256 = str(expected.get("problem_ir_sha256") or "")
        if problem_ir_sha256 != expected_problem_ir_sha256:
            failures.append(
                f"{label} executed_problem_ir_sha256 differs from canonical fixture: "
                f"expected {expected_problem_ir_sha256}, got {problem_ir_sha256}"
            )

    exact_fields = {
        "solver_mesh_sha256": "solver_mesh_sha256",
        "solver_mesh_signature": "solver_mesh_signature",
    }
    for expected_key, row_key in exact_fields.items():
        expected_value = str(expected.get(expected_key) or "")
        actual_value = str(actual.get(expected_key) or "")
        if actual_value != expected_value:
            failures.append(
                f"{label} {row_key} differs from canonical fixture: "
                f"expected {expected_value}, got {actual_value}"
            )
    stop_condition = expected.get("stop_condition")
    expected_steps = (
        str(stop_condition.get("max_steps") or "")
        if isinstance(stop_condition, Mapping)
        else ""
    )
    execution_fields = {
        "reported_scenario": str(expected.get("scenario") or ""),
        "reported_integrator": "heun",
        "reported_relaxation_algorithm": str(
            expected.get("relaxation_algorithm") or ""
        ),
        "reported_timestep_policy": "fixed",
        "requested_steps": expected_steps,
        "executed_steps": expected_steps,
    }
    for field, expected_value in execution_fields.items():
        actual_value = str(actual.get(field) or "")
        if actual_value != expected_value:
            failures.append(
                f"{label} {field} differs from fixture execution identity: "
                f"expected {expected_value}, got {actual_value}"
            )
    return failures


def read_interactive_identity(csv_path: Path) -> dict[str, str]:
    return read_execution_identity(csv_path, "interactive")


def interactive_identity_failures(
    actual: Mapping[str, object], expected: Mapping[str, object]
) -> list[str]:
    return execution_identity_failures(
        actual,
        expected,
        label="interactive",
        require_problem_ir_match=False,
    )


def validate_interactive_identity(
    csv_path: Path, expected: Mapping[str, object]
) -> dict[str, str]:
    identity = read_interactive_identity(csv_path)
    failures = interactive_identity_failures(identity, expected)
    if failures:
        raise ValueError("; ".join(failures))
    return identity


def _run_nsys_pass(
    label: str,
    fixture_command: Sequence[str],
    environment: Mapping[str, str],
    output_dir: Path,
) -> dict[str, object]:
    trace_prefix = output_dir / f"{label}-timeline"
    profile_command = build_nsys_profile_command(fixture_command, trace_prefix)
    profile = subprocess.run(
        profile_command,
        cwd=REPO_ROOT,
        env=dict(environment),
        capture_output=True,
        text=True,
        check=False,
    )
    (output_dir / f"{label}-nsys-profile.log").write_text(
        profile.stdout + profile.stderr, encoding="utf-8"
    )
    if profile.returncode != 0:
        raise RuntimeError(f"{label} nsys profile exited {profile.returncode}")

    report = trace_prefix.with_suffix(".nsys-rep")
    stats_prefix = output_dir / f"{label}-stats"
    for stale_csv in output_dir.glob(f"{stats_prefix.name}*.csv"):
        stale_csv.unlink()
    stats_command = build_nsys_stats_command(report, stats_prefix)
    stats = subprocess.run(
        stats_command, cwd=REPO_ROOT, capture_output=True, text=True, check=False
    )
    (output_dir / f"{label}-nsys-stats.log").write_text(
        stats.stdout + stats.stderr, encoding="utf-8"
    )
    if stats.returncode != 0:
        raise RuntimeError(f"{label} nsys stats exited {stats.returncode}")

    sqlite_path = output_dir / f"{label}-timeline.sqlite"
    export_command = [
        "nsys",
        "export",
        "--type",
        "sqlite",
        "--force-overwrite=true",
        "--output",
        str(sqlite_path),
        str(report),
    ]
    exported = subprocess.run(
        export_command, cwd=REPO_ROOT, capture_output=True, text=True, check=False
    )
    (output_dir / f"{label}-nsys-export.log").write_text(
        exported.stdout + exported.stderr, encoding="utf-8"
    )
    if exported.returncode != 0:
        raise RuntimeError(f"{label} nsys export exited {exported.returncode}")

    return {
        "api_rows": _stats_rows(stats_prefix, "cuda_api_sum"),
        "kernel_rows": _stats_rows(
            stats_prefix, "cuda_gpu_kern_sum", optional=True
        ),
        "nvtx_rows": _stats_rows(stats_prefix, "nvtx_sum"),
        "events": load_timeline_events(sqlite_path),
        "profile_command": profile_command,
        "stats_command": stats_command,
        "export_command": export_command,
    }


def _run_capture(args: argparse.Namespace, preflight: Mapping[str, object]) -> int:
    output_dir = args.output_dir / args.run_id
    try:
        bundle = collect_bundle_identity(args.runtime_root)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        payload = not_verified_payload(
            run_id=args.run_id,
            blockers=[f"managed runtime identity is invalid: {exc}"],
        )
        payload["status"] = "unavailable"
        payload["preflight"] = dict(preflight)
        write_summary_artifacts(output_dir, payload)
        return 2
    fixture_identity = json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))
    fixture_block: dict[str, object] = {
        "manifest": str(FIXTURE_MANIFEST.relative_to(REPO_ROOT)),
        "manifest_sha256": _sha256(FIXTURE_MANIFEST),
        "environment": str(FIXTURE_ENVIRONMENT.relative_to(REPO_ROOT)),
        "environment_sha256": _sha256(FIXTURE_ENVIRONMENT),
        "problem_ir_sha256": fixture_identity["problem_ir_sha256"],
        "solver_mesh_sha256": fixture_identity["solver_mesh_sha256"],
        "solver_mesh_signature": fixture_identity["solver_mesh_signature"],
    }
    fixture_block.update(_fixture_mesh_counts(fixture_identity))
    base: dict[str, object] = {
        **not_verified_payload(run_id=args.run_id, blockers=[]),
        "preflight": preflight,
        "bundle": bundle,
        "fixture": fixture_block,
    }
    if preflight.get("status") != "available":
        base.update(status="unavailable", blockers=preflight.get("blockers", []))
        write_summary_artifacts(output_dir, base)
        print("status=unavailable: " + "; ".join(str(value) for value in base["blockers"]), file=sys.stderr)
        return 2
    if not bundle.get("nvtx_enabled"):
        base.update(status="unavailable", blockers=["managed FEM bundle was not built with FULLMAG_ENABLE_NVTX=1"])
        write_summary_artifacts(output_dir, base)
        print("status=unavailable: managed FEM bundle has NVTX disabled", file=sys.stderr)
        return 2
    if args.preflight_only:
        base.update(status="available", blockers=[])
        write_summary_artifacts(output_dir, base)
        return 0

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "compute").mkdir(exist_ok=True)
    (output_dir / "host").mkdir(exist_ok=True)
    compute_command = _fixture_command(output_dir / "compute")
    host_command = _interactive_fixture_command(output_dir / "host")
    env = capture_environment()
    host_env = capture_environment(interactive=True)
    try:
        compute_pass = _run_nsys_pass(
            "compute", compute_command, env, output_dir
        )
        host_pass = _run_nsys_pass("host", host_command, host_env, output_dir)
    except (OSError, RuntimeError, ValueError) as exc:
        base.update(status="failed", blockers=[str(exc)])
        write_summary_artifacts(output_dir, base)
        return 1

    compute_metrics = summarize_stats(
        compute_pass["api_rows"],
        compute_pass["kernel_rows"],
        compute_pass["nvtx_rows"],
        compute_pass["events"],
    )
    host_metrics = summarize_stats(
        host_pass["api_rows"],
        host_pass["kernel_rows"],
        host_pass["nvtx_rows"],
        host_pass["events"],
    )
    compute_observed = set(compute_metrics["nvtx_ranges_observed"])
    host_observed = set(host_metrics["nvtx_ranges_observed"])
    missing_compute = sorted(set(COMPUTE_NVTX_RANGES) - compute_observed)
    missing_host = sorted(set(HOST_NVTX_RANGES) - host_observed)
    metrics = dict(compute_metrics)
    metrics["overlap_ns"] = host_metrics["overlap_ns"]
    metrics["nvtx_coverage"] = {
        "compute": {
            "required": list(COMPUTE_NVTX_RANGES),
            "observed": sorted(compute_observed),
            "missing": missing_compute,
        },
        "host": {
            "required": list(HOST_NVTX_RANGES),
            "observed": sorted(host_observed),
            "missing": missing_host,
        },
    }
    metrics["nvtx_ranges_observed"] = sorted(compute_observed | host_observed)
    metrics["nvtx_ranges_missing"] = sorted(missing_compute + missing_host)
    ordered_phase_failures = {
        "compute": ordered_trace_phase_failures(compute_pass["events"]),
        "host": ordered_trace_phase_failures(host_pass["events"]),
    }
    qualifying_phase_pass = next(
        (
            label
            for label, failures in ordered_phase_failures.items()
            if not failures
        ),
        None,
    )
    metrics["ordered_trace_phase_contract"] = {
        "required_order": list(TRACE_PHASE_RANGES),
        "qualifying_pass": qualifying_phase_pass,
        "failures_by_pass": ordered_phase_failures,
    }
    top_five = top_kernel_names(compute_pass["kernel_rows"])
    blockers: list[str] = []
    try:
        compute_identity = read_execution_identity(
            output_dir / "compute" / "fixture.csv", "compute"
        )
    except (OSError, ValueError) as exc:
        compute_identity = {}
        blockers.append(str(exc))
    else:
        blockers.extend(
            execution_identity_failures(
                compute_identity,
                fixture_identity,
                label="compute",
                require_problem_ir_match=True,
            )
        )
    try:
        interactive_identity = read_interactive_identity(
            output_dir / "host" / "fixture.csv"
        )
    except (OSError, ValueError) as exc:
        interactive_identity = {}
        blockers.append(str(exc))
    else:
        blockers.extend(
            interactive_identity_failures(interactive_identity, fixture_identity)
        )
    base["execution_identities"] = {
        "pass_a_compute_run_json": compute_identity,
        "pass_b_script_interactive": interactive_identity,
        "relationship": (
            "The exact hashes differ in this capture because pass B retains inspected "
            "script authoring provenance; fixture equivalence is enforced by exact "
            "solver-mesh identity and the complete execution tuple."
            if interactive_identity.get("problem_ir_sha256")
            != compute_identity.get("problem_ir_sha256")
            else "Each pass independently recorded the same canonical ProblemIR hash; "
            "fixture equivalence is also enforced by exact solver-mesh identity and "
            "the complete execution tuple."
        ),
    }
    if missing_compute:
        blockers.append("compute NVTX ranges missing: " + ", ".join(missing_compute))
    if missing_host:
        blockers.append("host NVTX ranges missing: " + ", ".join(missing_host))
    if qualifying_phase_pass is None:
        blockers.append(
            "no single Nsight capture contains ordered setup -> attempt -> "
            "accepted_finalization -> snapshot -> export phases: "
            + json.dumps(ordered_phase_failures, sort_keys=True)
        )
    if len(top_five) != 5:
        blockers.append(f"compute nsys reported only {len(top_five)} unique kernels")
    ncu_access_probe = run_ncu_access_probe(
        _fixture_command(output_dir / "ncu-access-probe-fixture"),
        output_dir,
        env,
    )
    if ncu_access_probe.get("blocker"):
        blockers.append(str(ncu_access_probe["blocker"]))
    if blockers:
        base.update(
            status="failed",
            blockers=blockers,
            metrics=metrics,
            interactive_identity=interactive_identity,
            ncu_access_probe=ncu_access_probe,
        )
        write_summary_artifacts(output_dir, base)
        return 1

    ncu_commands = build_ncu_commands(
        top_five,
        _fixture_command(output_dir / "ncu-fixture"),
        output_dir,
    )
    ncu_csv_paths: list[Path] = []
    ncu_metrics: dict[str, dict[str, list[dict[str, str]]]] = {}
    ncu_top_kernel_passes: list[dict[str, object]] = []
    for index, ncu_command in enumerate(ncu_commands, start=1):
        ncu_pass = run_ncu_top_kernel_pass(
            ncu_command,
            output_dir,
            index,
            env,
        )
        ncu_top_kernel_passes.append(ncu_pass)
        if ncu_pass.get("blocker"):
            base.update(
                status="failed",
                blockers=[str(ncu_pass["blocker"])],
                metrics=metrics,
                ncu_access_probe=ncu_access_probe,
                ncu_top_kernel_passes=ncu_top_kernel_passes,
            )
            write_summary_artifacts(output_dir, base)
            return 1
        ncu_csv = output_dir / f"top-kernel-{index:02d}.csv"
        if not ncu_csv.is_file():
            base.update(
                status="failed",
                blockers=[f"ncu did not write {ncu_csv.name}"],
                metrics=metrics,
                ncu_access_probe=ncu_access_probe,
                ncu_top_kernel_passes=ncu_top_kernel_passes,
            )
            write_summary_artifacts(output_dir, base)
            return 1
        ncu_csv_paths.append(ncu_csv)
        for kernel, groups in parse_ncu_metrics(
            parse_ncu_csv(ncu_csv.read_text(encoding="utf-8"))
        ).items():
            target = ncu_metrics.setdefault(
                kernel,
                {
                    "occupancy": [],
                    "achieved_bandwidth": [],
                    "launch_grid": [],
                    "warp_stalls": [],
                },
            )
            for group, values in groups.items():
                target[group].extend(values)
    incomplete_metrics = {
        kernel: [
            group
            for group in ("occupancy", "achieved_bandwidth", "launch_grid", "warp_stalls")
            if not ncu_metrics.get(kernel, {}).get(group)
        ]
        for kernel in top_five
    }
    incomplete_metrics = {
        kernel: groups for kernel, groups in incomplete_metrics.items() if groups
    }
    if incomplete_metrics:
        base.update(
            status="failed",
            blockers=[f"ncu required metrics missing: {incomplete_metrics}"],
            metrics=metrics,
            ncu_access_probe=ncu_access_probe,
            ncu_top_kernel_passes=ncu_top_kernel_passes,
        )
        write_summary_artifacts(output_dir, base)
        return 1
    base.update(
        status="captured",
        qualification_status="VERIFIED",
        blockers=[],
        metrics=metrics,
        interactive_identity=interactive_identity,
        ncu={
            "top_five_kernels": top_five,
            "sections": list(NCU_SECTIONS),
            "launch_count_per_selected_kernel": 1,
            "timeout_seconds_per_selected_kernel": NCU_TIMEOUT_SECONDS,
            "csv": [str(path.relative_to(REPO_ROOT)) for path in ncu_csv_paths],
            "metrics": ncu_metrics,
        },
        ncu_access_probe=ncu_access_probe,
        ncu_top_kernel_passes=ncu_top_kernel_passes,
        commands={
            "compute_nsys_profile": compute_pass["profile_command"],
            "compute_nsys_stats": compute_pass["stats_command"],
            "host_nsys_profile": host_pass["profile_command"],
            "host_nsys_stats": host_pass["stats_command"],
            "ncu": ncu_commands,
        },
    )
    write_summary_artifacts(output_dir, base)
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--run-id", default=DEFAULT_RUN_ID)
    parser.add_argument("--runtime-root", type=Path, default=DEFAULT_RUNTIME_ROOT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument(
        "--record-not-verified",
        default=None,
        help="Write an explicit NOT VERIFIED capture summary without profiling",
    )
    parser.add_argument(
        "--direct-minimizer-capture-input",
        type=Path,
        default=None,
        help="JSON file containing the Nsight direct-minimizer capture case payload",
    )
    parser.add_argument(
        "--direct-minimizer-benchmark-input",
        type=Path,
        default=None,
        help="JSON file containing the five-repeat direct-minimizer benchmark matrix case payload",
    )
    parser.add_argument(
        "--direct-minimizer-summary-output",
        type=Path,
        default=None,
        help="Output path for the direct-minimizer capture summary JSON",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.direct_minimizer_capture_input is not None:
        if (
            args.direct_minimizer_benchmark_input is None
            or args.direct_minimizer_summary_output is None
        ):
            raise SystemExit(
                "--direct-minimizer-capture-input requires "
                "--direct-minimizer-benchmark-input and --direct-minimizer-summary-output"
            )
        capture_case = json.loads(
            args.direct_minimizer_capture_input.read_text(encoding="utf-8")
        )
        benchmark_case = json.loads(
            args.direct_minimizer_benchmark_input.read_text(encoding="utf-8")
        )
        summary = write_direct_minimizer_capture_summary(
            args.direct_minimizer_summary_output,
            capture_case,
            benchmark_case,
        )
        if summary.get("blockers"):
            print(
                "FEM_DIRECT_MINIMIZER_CAPTURE_BLOCKERS="
                + "; ".join(summary["blockers"]),
                file=sys.stderr,
            )
            return 2
        return 0
    if args.record_not_verified is not None:
        write_summary_artifacts(
            args.output_dir / args.run_id,
            not_verified_payload(
                run_id=args.run_id,
                blockers=[args.record_not_verified],
            ),
        )
        print("qualification_status=NOT VERIFIED", file=sys.stderr)
        return 2
    preflight = preflight_tools()
    if args.preflight_only:
        output_dir = args.output_dir / args.run_id
        payload = {
            **not_verified_payload(
                run_id=args.run_id,
                blockers=preflight["blockers"],
            ),
            "status": preflight["status"],
            "preflight": preflight,
        }
        if (args.runtime_root / "manifest.json").is_file():
            try:
                payload["bundle"] = collect_bundle_identity(args.runtime_root)
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                payload["status"] = "unavailable"
                payload["qualification_status"] = "NOT VERIFIED"
                payload["blockers"] = [
                    *payload["blockers"],
                    f"managed runtime identity is invalid: {exc}",
                ]
                write_summary_artifacts(output_dir, payload)
                return 2
        write_summary_artifacts(output_dir, payload)
        if preflight["status"] != "available":
            print("status=unavailable: " + "; ".join(preflight["blockers"]), file=sys.stderr)
            return 2
        print("status=available: nsys and ncu present in managed fixture image")
        return 0
    return _run_capture(args, preflight)


if __name__ == "__main__":
    raise SystemExit(main())
