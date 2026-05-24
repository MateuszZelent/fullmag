#!/usr/bin/env python3
"""Run and report the Permalloy FEM demag benchmark matrix."""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXAMPLE = REPO_ROOT / "examples" / "permalloy_film_relax_1000x500x10nm.py"
DEFAULT_FULLMAG_BIN = REPO_ROOT / ".fullmag" / "local" / "bin" / "fullmag"
DEFAULT_GPU_BIN = REPO_ROOT / ".fullmag" / "runtimes" / "fem-gpu-host" / "bin" / "fullmag-fem-gpu"
DEFAULT_LOGS_DIR = REPO_ROOT / ".fullmag" / "logs"
DEFAULT_REPORT = REPO_ROOT / "docs" / "reports" / "2026-05-17" / "permalloy_fem_demag_benchmark.md"
FULLMAG_PY_SRC = REPO_ROOT / "packages" / "fullmag-py" / "src"
BUNDLED_PY_LIB = REPO_ROOT / ".fullmag" / "local" / "python" / "lib"
BUNDLED_PY_BIN = REPO_ROOT / ".fullmag" / "local" / "python" / "bin"

ENGINE_RE = re.compile(
    r"\[fullmag-runner\] live FEM engine: resolved_engine_id=(?P<engine>\S+) fallback=(?P<fallback>.+)"
)
CPU_RUNTIME_RE = re.compile(
    r"\[fullmag-fem\] cpu runtime: .*?poisson_solver=(?P<solver>\S+) "
    r"preconditioner=(?P<preconditioner>\S+).*?"
    r"requested_omp_threads=(?P<requested>\d+) "
    r"effective_omp_threads=(?P<effective>\d+) "
    r"mesh_nodes=(?P<nodes>\d+) elements=(?P<elements>\d+)"
)
NATIVE_ACTIVE_RE = re.compile(
    r"native FEM backend active: engine=(?P<engine>\S+) "
    r"device='(?P<device>[^']+)'.*?"
    r"demag_solver=(?P<solver>\S+) preconditioner=(?P<preconditioner>\S+)"
)
DEMAG_CALL_RE = re.compile(
    r"\[fullmag-fem\] demag call: step=(?P<step>\d+) call=(?P<call>\d+) "
    r"dt=(?P<dt>[-+0-9.eE]+) "
    r"assemble=(?P<assemble>[-+0-9.eE]+)ms "
    r"solve=(?P<solve>[-+0-9.eE]+)ms "
    r"recover=(?P<recover>[-+0-9.eE]+)ms "
    r"energy=(?P<energy>[-+0-9.eE]+)ms "
    r"total=(?P<total>[-+0-9.eE]+)ms "
    r"lin_iters=(?P<lin_iters>\d+) residual=(?P<residual>[-+0-9.eE]+)"
)
STAGE_RE = re.compile(
    r"stage\s+\d+/\d+\s+\((?P<stage>[^)]+)\)\s+step\s+(?P<step>\d+).*?"
    r"\[(?P<total_ms>[-+0-9.eE]+)ms\]\s+"
    r"phases\[ex=(?P<exchange>[-+0-9.eE]+)ms "
    r"demag=(?P<demag>[-+0-9.eE]+)ms "
    r"rhs=(?P<rhs>[-+0-9.eE]+)ms "
    r"extra=(?P<extra>[-+0-9.eE]+)ms "
    r"snap=(?P<snap>[-+0-9.eE]+)ms\]\s+"
    r"rk\[rhs_evals=(?P<rhs_evals>\d+) rejected=(?P<rejected>\d+) fsal=(?P<fsal>\d+)\]\s+"
    r"demag\[solves=(?P<solves>\d+) lin_iters=(?P<lin_iters>\d+) residual=(?P<residual>[-+0-9.eE]+)\]"
)
ARTIFACT_DIR_RE = re.compile(r"^- artifact_dir:\s+(?P<path>.+?)\s*$", re.MULTILINE)
ERROR_RE = re.compile(r"(?i)\b(error|runerror|panic|failed|unavailable)\b")


class BenchmarkCase(NamedTuple):
    label: str
    execution: str
    threads: int | None = None
    binary: Path | None = None


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    return float(statistics.median(values))


def bundled_python_site_packages() -> Path | None:
    candidates = sorted(BUNDLED_PY_LIB.glob("python*/site-packages"), reverse=True)
    return candidates[0] if candidates else None


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return float(statistics.fmean(values))


def _fmt(value: object, digits: int = 1) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        if value != value:
            return "-"
        if abs(value) >= 1e4 or (0 < abs(value) < 1e-3):
            return f"{value:.3e}"
        return f"{value:.{digits}f}"
    return str(value)


def _ns_to_ms(value: object) -> float | None:
    if not isinstance(value, (float, int)):
        return None
    return float(value) / 1e6


def _float(match: re.Match[str], key: str) -> float:
    return float(match.group(key))


def _int(match: re.Match[str], key: str) -> int:
    return int(match.group(key))


def extract_artifact_dir(output: str) -> Path | None:
    match = ARTIFACT_DIR_RE.search(output)
    if not match:
        return None
    path = Path(match.group("path"))
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path


def enrich_summary_with_metadata(summary: dict[str, object], metadata: dict[str, object]) -> None:
    demag_runtime = metadata.get("demag_runtime")
    if not isinstance(demag_runtime, dict):
        return
    timings = demag_runtime.get("timings_ns")
    if not isinstance(timings, dict):
        return
    summary["metadata_profile"] = True
    summary["metadata_demag_total_ms"] = _ns_to_ms(timings.get("total"))
    summary["metadata_demag_assemble_ms"] = _ns_to_ms(timings.get("assemble"))
    summary["metadata_demag_solve_ms"] = _ns_to_ms(timings.get("solve"))
    summary["metadata_demag_solver_setup_ms"] = _ns_to_ms(timings.get("solver_setup"))
    summary["metadata_demag_solver_apply_ms"] = _ns_to_ms(timings.get("solver_apply"))
    summary["metadata_demag_recover_ms"] = _ns_to_ms(timings.get("recover"))
    summary["metadata_demag_energy_ms"] = _ns_to_ms(timings.get("energy"))
    summary["metadata_demag_actual_iterations"] = demag_runtime.get("actual_iterations")
    summary["metadata_demag_final_residual"] = demag_runtime.get("final_residual_norm")
    summary["metadata_mfem_device"] = demag_runtime.get("mfem_device")
    summary["metadata_fem_assembly_mode"] = demag_runtime.get("fem_assembly_mode")
    if summary.get("requested_omp_threads") is None:
        summary["requested_omp_threads"] = demag_runtime.get("requested_fem_omp_threads")
    if summary.get("effective_omp_threads") is None:
        summary["effective_omp_threads"] = demag_runtime.get("effective_fem_omp_threads")


def enrich_summary_from_artifacts(summary: dict[str, object], output: str) -> None:
    artifact_dir = extract_artifact_dir(output)
    if artifact_dir is None:
        return
    summary["artifact_dir"] = str(artifact_dir)
    metadata_path = artifact_dir / "metadata.json"
    if not metadata_path.exists():
        summary["metadata_profile"] = False
        summary["metadata_error"] = f"missing metadata: {metadata_path}"
        return
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        summary["metadata_profile"] = False
        summary["metadata_error"] = str(exc)
        return
    if isinstance(metadata, dict):
        enrich_summary_with_metadata(summary, metadata)


def build_case_environment(
    case: BenchmarkCase,
    base_env: dict[str, str] | None = None,
    *,
    max_steps: int,
) -> dict[str, str]:
    env = dict(os.environ if base_env is None else base_env)
    python_paths = [str(FULLMAG_PY_SRC)]
    bundled_py_site = bundled_python_site_packages()
    if bundled_py_site is not None:
        python_paths.append(str(bundled_py_site))
    if env.get("PYTHONPATH"):
        python_paths.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(python_paths)
    if BUNDLED_PY_BIN.exists():
        env["PATH"] = str(BUNDLED_PY_BIN) + os.pathsep + env.get("PATH", "")
    env["FULLMAG_FEM_STEP_PROFILE"] = "1"
    env["FULLMAG_FEM_EXECUTION"] = case.execution
    env["PERMALLOY_DEVICE"] = case.execution
    env["PERMALLOY_MAX_STEPS"] = str(max_steps)
    if case.threads is not None:
        value = str(case.threads)
        env["FULLMAG_CPU_THREADS"] = value
        env["OMP_NUM_THREADS"] = value
        env["RAYON_NUM_THREADS"] = value
    return env


def parse_benchmark_log(
    output: str,
    *,
    label: str,
    requested_execution: str,
    requested_threads: int | None,
    returncode: int,
    elapsed_s: float,
    log_path: Path,
) -> dict[str, object]:
    demag_calls: list[dict[str, float | int]] = []
    stages_by_step: dict[int, dict[str, float | int | str]] = {}
    summary: dict[str, object] = {
        "label": label,
        "requested_execution": requested_execution,
        "requested_threads": requested_threads,
        "returncode": returncode,
        "elapsed_s": elapsed_s,
        "log_path": str(log_path),
        "status": "failed" if returncode else "ok",
        "resolved_engine_id": None,
        "fallback": None,
        "gpu_fallback": False,
        "backend_device": None,
        "poisson_solver": None,
        "preconditioner": None,
        "requested_omp_threads": None,
        "effective_omp_threads": None,
        "mesh_nodes": None,
        "mesh_elements": None,
        "error_summary": None,
    }

    for line in output.splitlines():
        if summary["error_summary"] is None and ERROR_RE.search(line):
            summary["error_summary"] = line.strip()

        engine_match = ENGINE_RE.search(line)
        if engine_match:
            summary["resolved_engine_id"] = engine_match.group("engine")
            fallback = engine_match.group("fallback").strip()
            summary["fallback"] = fallback
            continue

        runtime_match = CPU_RUNTIME_RE.search(line)
        if runtime_match:
            summary["poisson_solver"] = runtime_match.group("solver")
            summary["preconditioner"] = runtime_match.group("preconditioner")
            summary["requested_omp_threads"] = _int(runtime_match, "requested")
            summary["effective_omp_threads"] = _int(runtime_match, "effective")
            summary["mesh_nodes"] = _int(runtime_match, "nodes")
            summary["mesh_elements"] = _int(runtime_match, "elements")
            continue

        active_match = NATIVE_ACTIVE_RE.search(line)
        if active_match:
            summary["resolved_engine_id"] = summary["resolved_engine_id"] or active_match.group("engine")
            summary["backend_device"] = active_match.group("device")
            summary["poisson_solver"] = active_match.group("solver")
            summary["preconditioner"] = active_match.group("preconditioner")
            continue

        demag_match = DEMAG_CALL_RE.search(line)
        if demag_match:
            demag_calls.append(
                {
                    "step": _int(demag_match, "step"),
                    "call": _int(demag_match, "call"),
                    "dt": _float(demag_match, "dt"),
                    "assemble_ms": _float(demag_match, "assemble"),
                    "solve_ms": _float(demag_match, "solve"),
                    "recover_ms": _float(demag_match, "recover"),
                    "energy_ms": _float(demag_match, "energy"),
                    "total_ms": _float(demag_match, "total"),
                    "lin_iters": _int(demag_match, "lin_iters"),
                    "residual": _float(demag_match, "residual"),
                }
            )
            continue

        stage_match = STAGE_RE.search(line)
        if stage_match:
            step = _int(stage_match, "step")
            stages_by_step[step] = {
                "stage": stage_match.group("stage"),
                "step": step,
                "total_ms": _float(stage_match, "total_ms"),
                "exchange_ms": _float(stage_match, "exchange"),
                "demag_ms": _float(stage_match, "demag"),
                "rhs_ms": _float(stage_match, "rhs"),
                "extra_ms": _float(stage_match, "extra"),
                "snap_ms": _float(stage_match, "snap"),
                "rhs_evals": _int(stage_match, "rhs_evals"),
                "rejected": _int(stage_match, "rejected"),
                "demag_solves": _int(stage_match, "solves"),
                "demag_lin_iters": _int(stage_match, "lin_iters"),
                "demag_residual": _float(stage_match, "residual"),
            }

    stages = [stages_by_step[key] for key in sorted(stages_by_step)]
    total_values = [float(call["total_ms"]) for call in demag_calls]
    assemble_values = [float(call["assemble_ms"]) for call in demag_calls]
    solve_values = [float(call["solve_ms"]) for call in demag_calls]
    recover_values = [float(call["recover_ms"]) for call in demag_calls]
    energy_values = [float(call["energy_ms"]) for call in demag_calls]
    lin_iters = [float(call["lin_iters"]) for call in demag_calls]
    step_times = [float(stage["total_ms"]) for stage in stages]
    stage_demag = [float(stage["demag_ms"]) for stage in stages]

    fallback = str(summary.get("fallback") or "")
    resolved_engine = str(summary.get("resolved_engine_id") or "")
    summary["gpu_fallback"] = (
        requested_execution == "gpu"
        and returncode == 0
        and (fallback not in {"", "None", "null"} or "gpu" not in resolved_engine.lower())
    )
    if returncode == 0 and not demag_calls:
        summary["status"] = "no_demag_samples"

    summary.update(
        {
            "demag_call_count": len(demag_calls),
            "stage_sample_count": len(stages),
            "rejected_steps": int(sum(int(stage["rejected"]) for stage in stages)),
            "demag_total_median_ms": _median(total_values),
            "demag_total_mean_ms": _mean(total_values),
            "demag_assemble_median_ms": _median(assemble_values),
            "demag_solve_median_ms": _median(solve_values),
            "demag_recover_median_ms": _median(recover_values),
            "demag_energy_median_ms": _median(energy_values),
            "demag_lin_iters_median": _median(lin_iters),
            "demag_residual_last": float(demag_calls[-1]["residual"]) if demag_calls else None,
            "step_time_median_ms": _median(step_times),
            "stage_demag_median_ms": _median(stage_demag),
        }
    )
    return summary


def build_cases(args: argparse.Namespace) -> list[BenchmarkCase]:
    cases: list[BenchmarkCase] = []
    for thread_text in args.threads.split(","):
        thread_text = thread_text.strip()
        if not thread_text:
            continue
        thread_count = int(thread_text)
        cases.append(
            BenchmarkCase(
                label=f"cpu-{thread_count}t",
                execution="cpu",
                threads=thread_count,
                binary=args.fullmag_bin,
            )
        )
    if args.include_gpu:
        gpu_binary = args.gpu_bin if args.gpu_bin.exists() else args.fullmag_bin
        cases.append(BenchmarkCase(label="gpu", execution="gpu", threads=None, binary=gpu_binary))
    return cases


def run_case(
    case: BenchmarkCase,
    *,
    example: Path,
    logs_dir: Path,
    stamp: str,
    timeout_seconds: int,
    max_steps: int,
) -> dict[str, object]:
    binary = case.binary or DEFAULT_FULLMAG_BIN
    log_path = logs_dir / f"permalloy-benchmark-{stamp}-{case.label}.log"
    if not binary.exists():
        text = f"benchmark binary is missing: {binary}\n"
        log_path.write_text(text, encoding="utf-8")
        return parse_benchmark_log(
            text,
            label=case.label,
            requested_execution=case.execution,
            requested_threads=case.threads,
            returncode=127,
            elapsed_s=0.0,
            log_path=log_path,
        )

    env = build_case_environment(case, max_steps=max_steps)
    command = [str(binary), "--headless", str(example)]
    started = datetime.now(timezone.utc)
    try:
        completed = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        elapsed_s = (datetime.now(timezone.utc) - started).total_seconds()
        output = completed.stdout
        returncode = completed.returncode
    except subprocess.TimeoutExpired as exc:
        elapsed_s = (datetime.now(timezone.utc) - started).total_seconds()
        output = (exc.stdout or "") + f"\n[benchmark] timeout after {timeout_seconds}s\n"
        returncode = 124

    log_path.write_text(output, encoding="utf-8")
    summary = parse_benchmark_log(
        output,
        label=case.label,
        requested_execution=case.execution,
        requested_threads=case.threads,
        returncode=returncode,
        elapsed_s=elapsed_s,
        log_path=log_path,
    )
    enrich_summary_from_artifacts(summary, output)
    return summary


def _bottleneck(row: dict[str, object]) -> str:
    phases = [
        ("assemble", row.get("demag_assemble_median_ms")),
        ("solve", row.get("demag_solve_median_ms")),
        ("recover", row.get("demag_recover_median_ms")),
        ("energy", row.get("demag_energy_median_ms")),
    ]
    numeric = [(name, float(value)) for name, value in phases if isinstance(value, (float, int))]
    if not numeric:
        return "-"
    return max(numeric, key=lambda item: item[1])[0]


def render_markdown_report(
    rows: list[dict[str, object]],
    *,
    generated_at: str,
    command: str,
) -> str:
    lines = [
        "# Permalloy FEM demag benchmark",
        "",
        f"- Generated: `{generated_at}`",
        f"- Command: `{command}`",
        f"- Example: `{DEFAULT_EXAMPLE}`",
        "- Problem: Permalloy film `1000 x 500 x 10 nm`, `B_ext=(0.1, 0, 0) T`, `max_steps=100` unless overridden.",
        "- Profiler: `FULLMAG_FEM_STEP_PROFILE=1`.",
        "",
        "## Results",
        "",
        "Primary median columns come from native per-call demag profiler logs. `metadata exact` columns below come from final-step `metadata.json` nanosecond `StepStats` when available.",
        "",
        "| case | metadata exact demag ms | assemble ms | solve ms | solver apply ms | recover ms | residual | device | assembly |",
        "|---|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for row in rows:
        lines.append(
            "| "
            + " | ".join(
                [
                    str(row.get("label")),
                    _fmt(row.get("metadata_demag_total_ms"), 3),
                    _fmt(row.get("metadata_demag_assemble_ms"), 3),
                    _fmt(row.get("metadata_demag_solve_ms"), 3),
                    _fmt(row.get("metadata_demag_solver_apply_ms"), 3),
                    _fmt(row.get("metadata_demag_recover_ms"), 3),
                    _fmt(row.get("metadata_demag_final_residual"), 3),
                    str(row.get("metadata_mfem_device") or "-"),
                    str(row.get("metadata_fem_assembly_mode") or "-"),
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "## Log-Derived Summary",
            "",
            "| case | status | requested | resolved engine | GPU fallback | requested OMP | effective OMP | nodes | elements | demag calls | demag median ms | assemble ms | solve ms | recover ms | lin iters | residual last | step median ms | rejected | elapsed s | bottleneck | log |",
            "|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
        ]
    )
    for row in rows:
        lines.append(
            "| "
            + " | ".join(
                [
                    str(row.get("label")),
                    str(row.get("status")),
                    str(row.get("requested_execution")),
                    str(row.get("resolved_engine_id") or "-"),
                    "yes" if row.get("gpu_fallback") else "no",
                    _fmt(row.get("requested_omp_threads"), 0),
                    _fmt(row.get("effective_omp_threads"), 0),
                    _fmt(row.get("mesh_nodes"), 0),
                    _fmt(row.get("mesh_elements"), 0),
                    _fmt(row.get("demag_call_count"), 0),
                    _fmt(row.get("demag_total_median_ms"), 1),
                    _fmt(row.get("demag_assemble_median_ms"), 1),
                    _fmt(row.get("demag_solve_median_ms"), 1),
                    _fmt(row.get("demag_recover_median_ms"), 1),
                    _fmt(row.get("demag_lin_iters_median"), 1),
                    _fmt(row.get("demag_residual_last"), 3),
                    _fmt(row.get("step_time_median_ms"), 1),
                    _fmt(row.get("rejected_steps"), 0),
                    _fmt(row.get("elapsed_s"), 1),
                    _bottleneck(row),
                    f"`{row.get('log_path')}`",
                ]
            )
            + " |"
        )

    ranked = [
        row
        for row in rows
        if row.get("status") == "ok" and isinstance(row.get("demag_total_median_ms"), (float, int))
    ]
    ranked.sort(key=lambda row: float(row["demag_total_median_ms"]))
    lines.extend(["", "## Ranking", ""])
    if not ranked:
        lines.append("No successful demag samples were produced.")
    else:
        for index, row in enumerate(ranked, 1):
            fallback = "yes" if row.get("gpu_fallback") else "no"
            lines.append(
                f"{index}. `{row['label']}`: demag median "
                f"{_fmt(row.get('demag_total_median_ms'), 1)} ms/call, "
                f"step median {_fmt(row.get('step_time_median_ms'), 1)} ms, "
                f"bottleneck {_bottleneck(row)}, GPU fallback: {fallback}."
            )

    lines.extend(["", "## Notes", ""])
    gpu_rows = [row for row in rows if row.get("requested_execution") == "gpu"]
    if gpu_rows:
        gpu = gpu_rows[0]
        lines.append(
            "- GPU fallback: "
            + ("yes" if gpu.get("gpu_fallback") else "no")
            + f"; resolved engine `{gpu.get('resolved_engine_id') or '-'}`."
        )
    failed = [row for row in rows if row.get("status") != "ok"]
    if failed:
        lines.append(
            "- Failed or incomplete rows: "
            + ", ".join(f"`{row['label']}` ({row['status']})" for row in failed)
            + "."
        )
        for row in failed:
            if row.get("error_summary"):
                lines.append(f"- `{row['label']}` error: {row['error_summary']}")
    if ranked:
        bottlenecks = {}
        for row in ranked:
            bottlenecks[_bottleneck(row)] = bottlenecks.get(_bottleneck(row), 0) + 1
        dominant = max(bottlenecks.items(), key=lambda item: item[1])[0]
        lines.append(f"- Dominant demag bottleneck across successful rows: `{dominant}`.")
    lines.append("- Raw logs are preserved under `.fullmag/logs/permalloy-benchmark-*`.")
    lines.append("")
    return "\n".join(lines)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--example", type=Path, default=DEFAULT_EXAMPLE)
    parser.add_argument("--fullmag-bin", type=Path, default=DEFAULT_FULLMAG_BIN)
    parser.add_argument("--gpu-bin", type=Path, default=DEFAULT_GPU_BIN)
    parser.add_argument("--threads", default="10,20,30,40")
    parser.add_argument("--include-gpu", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--max-steps", type=int, default=100)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--logs-dir", type=Path, default=DEFAULT_LOGS_DIR)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    args.logs_dir.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    cases = build_cases(args)
    command = " ".join([Path(sys.argv[0]).name] + (sys.argv[1:] if argv is None else argv))
    rows: list[dict[str, object]] = []
    for case in cases:
        print(
            f"[benchmark] running {case.label}: execution={case.execution} "
            f"threads={case.threads or '-'}",
            file=sys.stderr,
        )
        row = run_case(
            case,
            example=args.example,
            logs_dir=args.logs_dir,
            stamp=stamp,
            timeout_seconds=args.timeout_seconds,
            max_steps=args.max_steps,
        )
        rows.append(row)
        print(
            f"[benchmark] {case.label}: status={row['status']} "
            f"demag_median_ms={_fmt(row.get('demag_total_median_ms'), 1)} "
            f"log={row['log_path']}",
            file=sys.stderr,
        )

    summary_path = args.logs_dir / f"permalloy-benchmark-{stamp}.json"
    summary_path.write_text(json.dumps(rows, indent=2, sort_keys=True), encoding="utf-8")
    report = render_markdown_report(
        rows,
        generated_at=datetime.now().astimezone().isoformat(timespec="seconds"),
        command=command,
    )
    args.report.write_text(report, encoding="utf-8")
    print(f"[benchmark] summary={summary_path}", file=sys.stderr)
    print(f"[benchmark] report={args.report}", file=sys.stderr)
    return 0 if all(row.get("status") == "ok" for row in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
