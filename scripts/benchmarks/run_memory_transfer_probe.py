"""Run one fullmag case and record memory, CPU<->GPU and RAM<->CPU evidence.

Run inside the Docker DEV backend container. One invocation runs one case once:

    python3 scripts/benchmarks/run_memory_transfer_probe.py \
        --case-script scripts/benchmarks/fdm_hot_loop_case.py --backend fdm \
        --label fdm_gpu_256x256x16 --output /build/perf \
        --env FDM_BENCH_DEVICE=gpu --env FDM_BENCH_GRID=256,256,16 --env FDM_BENCH_STEPS=20

While the case runs, the driver samples every ``--sample-interval`` seconds:

- the device memory in use and the GPU utilisation (nvidia-smi);
- the summed RSS of the fullmag process tree;
- per process: CPU time, minor and major page faults, and bytes written
  (``/proc/<pid>/stat`` and ``/proc/<pid>/io``).

After the run it records:

- wall time and exit code;
- the FDM CUDA preflight figures, if the preflight refused the workspace;
- the sizes of the JSON artifacts;
- the transfer and host-sync counters of the run receipt, of solver_steps.csv
  and of performance/steps.csv. The probe enables the performance step CSV by
  default, honoring an inherited setting or an explicit --env override.

Results are appended to ``<output>/results.jsonl``. Unless ``--keep`` is given,
the case's artifacts are deleted after they are measured.

The live preview stays off unless ``--preview`` is given. The run is always
detached from the group API (FULLMAG_API_PORT=0). ``--prefix`` prepends a
command, for example ``taskset -c 0,2,4,6`` or a valgrind tool.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import time
from pathlib import Path

PREVIEW_OFF_ENV = {
    "FULLMAG_DISABLE_PREVIEW_3D": "1",
    "FULLMAG_DISABLE_PREVIEW_2D": "1",
    "FULLMAG_DISABLE_LIVE_MAGNETIZATION": "1",
}
PREFLIGHT_RE = re.compile(r"(required_aggregate(?:_multilayer)?_workspace_bytes|usable_device_bytes|"
                          r"free_device_bytes|total_device_bytes|safety_reserve_bytes)=(\d+)")
STEP_SUM_MARKERS = ("bytes", "sync", "count", "wall_time_ns", "evaluation", "solves", "rhs_evals",
                    "iterations")
COUNTER_KEY_MARKERS = ("d2h", "h2d", "host_sync", "graph_launch", "observed_step_count",
                       "realization", "workspace_bytes", "allocated_bytes")
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")


def gpu_sample() -> tuple[float | None, float | None]:
    """Device memory in use (MiB) and GPU utilisation (%), or None."""
    try:
        completed = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return None, None
    if completed.returncode != 0:
        return None, None
    try:
        memory, util = completed.stdout.strip().splitlines()[0].split(",")
        return float(memory), float(util)
    except (ValueError, IndexError):
        return None, None


def process_tree(root_pid: int) -> set[int]:
    parents: dict[int, int] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        # The command name may contain spaces; the fields after ")" are fixed.
        fields = stat[stat.rfind(")") + 2:].split()
        parents[int(entry.name)] = int(fields[1])
    tree = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, parent in parents.items():
            if parent in tree and pid not in tree:
                tree.add(pid)
                changed = True
    return tree


def sample_tree(root_pid: int, seen: dict[int, dict]) -> int:
    """Return the summed RSS of the tree and update the per-process counters in ``seen``."""
    rss_total = 0
    for pid in process_tree(root_pid):
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
            status = Path(f"/proc/{pid}/status").read_text()
        except OSError:
            continue
        fields = stat[stat.rfind(")") + 2:].split()
        record = {
            "cpu_s": (int(fields[11]) + int(fields[12])) / CLOCK_TICKS,
            "minflt": int(fields[7]),
            "majflt": int(fields[9]),
        }
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                rss_total += int(line.split()[1]) * 1024
                break
        try:
            for line in Path(f"/proc/{pid}/io").read_text().splitlines():
                key, _, value = line.partition(":")
                if key in ("wchar", "write_bytes", "rchar", "read_bytes"):
                    record[key] = int(value)
        except OSError:
            pass
        seen[pid] = record
    return rss_total


def collect_counters(value, prefix: str = "", out: dict | None = None, depth: int = 0) -> dict:
    """Flatten receipt entries whose key names transfers, syncs or workspace bytes."""
    if out is None:
        out = {}
    if depth > 8 or len(out) > 200:
        return out
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(child, (dict, list)):
                collect_counters(child, path, out, depth + 1)
            elif any(marker in key for marker in COUNTER_KEY_MARKERS):
                out[path] = child
    elif isinstance(value, list):
        for index, child in enumerate(value[:16]):
            collect_counters(child, f"{prefix}[{index}]", out, depth + 1)
    return out


def mesh_counts(metadata: dict) -> dict:
    """FEM mesh sizes from metadata.json; empty for FDM."""
    mesh = metadata.get("mesh") if isinstance(metadata, dict) else None
    if not isinstance(mesh, dict):
        return {}
    counts = {"node_count": mesh.get("node_count"), "element_count": mesh.get("element_count")}
    try:
        signatures = mesh["mesh_build_report"]["magnetic_submesh_signatures"]
        counts["magnetic_node_count"] = sum(item.get("node_count", 0) for item in signatures)
    except (KeyError, TypeError):
        pass
    return counts


def summarize_steps(path: Path) -> dict:
    if not path.is_file():
        return {}
    sums: dict[str, float] = {}
    rows = 0
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            rows += 1
            for key, raw in row.items():
                if not key or not raw or not any(marker in key for marker in STEP_SUM_MARKERS):
                    continue
                try:
                    sums[key] = sums.get(key, 0.0) + float(raw)
                except ValueError:
                    continue
    return {"rows": rows, "sums": {key: value for key, value in sums.items() if value}}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--case-script", required=True)
    parser.add_argument("--backend", required=True, choices=("fdm", "fem"))
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--env", action="append", default=[], help="KEY=VALUE for the case")
    parser.add_argument("--preview", action="store_true", help="keep the live preview on")
    parser.add_argument("--prefix", default="", help="command prepended to fullmag-bin, e.g. 'taskset -c 0-3'")
    parser.add_argument("--fullmag-bin", default="fullmag-bin")
    parser.add_argument("--sample-interval", type=float, default=0.2)
    parser.add_argument("--timeout", type=float, default=900.0)
    parser.add_argument("--keep", action="store_true", help="keep the case artifacts")
    args = parser.parse_args()

    run_dir = args.output / "runs" / f"{args.label}-{int(time.time())}"
    run_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["FULLMAG_API_PORT"] = "0"
    env.setdefault("FULLMAG_RUN_PERFORMANCE_STEP_CSV", "1")
    if not args.preview:
        env.update(PREVIEW_OFF_ENV)
    for item in args.env:
        key, _, value = item.partition("=")
        env[key] = value

    baseline_mib, _ = gpu_sample()
    command = shlex.split(args.prefix) + [
        args.fullmag_bin, args.case_script, "--backend", args.backend, "--headless",
        "--json", "--output-dir", str(run_dir / "out")]
    stdout_path, stderr_path = run_dir / "stdout.txt", run_dir / "stderr.txt"
    samples = []
    seen: dict[int, dict] = {}
    peak_gpu_mib, peak_rss = baseline_mib, 0
    util_samples: list[float] = []
    timed_out = False
    started = time.perf_counter()
    with stdout_path.open("w") as out, stderr_path.open("w") as err:
        process = subprocess.Popen(command, env=env, stdout=out, stderr=err, start_new_session=True)
        while process.poll() is None:
            elapsed = time.perf_counter() - started
            if elapsed > args.timeout:
                timed_out = True
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                break
            gpu, util = gpu_sample()
            rss = sample_tree(process.pid, seen)
            cpu_s = sum(record["cpu_s"] for record in seen.values())
            samples.append((round(elapsed, 3), gpu, util, rss, round(cpu_s, 2)))
            if gpu is not None and (peak_gpu_mib is None or gpu > peak_gpu_mib):
                peak_gpu_mib = gpu
            if util is not None:
                util_samples.append(util)
            peak_rss = max(peak_rss, rss)
            time.sleep(args.sample_interval)
    wall_s = time.perf_counter() - started
    returncode = process.wait()

    with (run_dir / "samples.csv").open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["elapsed_s", "gpu_memory_used_mib", "gpu_util_pct", "process_tree_rss_bytes",
                         "process_tree_cpu_s"])
        writer.writerows(samples)

    log_text = stdout_path.read_text(errors="replace") + stderr_path.read_text(errors="replace")
    preflight = {key: int(value) for key, value in PREFLIGHT_RE.findall(log_text)}
    artifacts = run_dir / "out" / "artifacts"
    json_sizes = {}
    metadata = {}
    if artifacts.is_dir():
        for path in sorted(artifacts.glob("*.json")):
            json_sizes[path.name] = path.stat().st_size
        metadata_path = artifacts / "metadata.json"
        if metadata_path.is_file():
            try:
                metadata = json.loads(metadata_path.read_text())
            except (OSError, ValueError):
                metadata = {}
    provenance = metadata.get("execution_provenance", {}) if isinstance(metadata, dict) else {}
    totals = {key: sum(record.get(key, 0) for record in seen.values())
              for key in ("cpu_s", "minflt", "majflt", "wchar", "write_bytes", "rchar", "read_bytes")}
    record = {
        "label": args.label,
        "backend": args.backend,
        "case_env": {item.partition("=")[0]: item.partition("=")[2] for item in args.env},
        "preview": args.preview,
        "prefix": args.prefix,
        "returncode": returncode,
        "timed_out": timed_out,
        "wall_s": round(wall_s, 3),
        "gpu_baseline_mib": baseline_mib,
        "gpu_peak_mib": peak_gpu_mib,
        "gpu_peak_delta_mib": (None if baseline_mib is None or peak_gpu_mib is None
                               else peak_gpu_mib - baseline_mib),
        "gpu_util_mean_pct": (round(sum(util_samples) / len(util_samples), 1) if util_samples else None),
        "process_tree_peak_rss_bytes": peak_rss,
        "process_tree_totals": totals,
        "preflight": preflight,
        "json_artifact_bytes": json_sizes,
        "receipt_counters": collect_counters(provenance),
        "mesh": mesh_counts(metadata),
        "solver_steps": summarize_steps(artifacts / "solver_steps.csv"),
        "performance_steps": summarize_steps(artifacts / "performance" / "steps.csv"),
        "error_tail": "" if returncode == 0 else log_text[-1500:],
    }
    with (args.output / "results.jsonl").open("a") as handle:
        handle.write(json.dumps(record) + "\n")
    print(f"{args.label}: rc={returncode} wall={wall_s:.1f}s gpu_peak_delta={record['gpu_peak_delta_mib']} MiB "
          f"gpu_util={record['gpu_util_mean_pct']}% rss_peak={peak_rss / 2**20:.0f} MiB "
          f"cpu={totals['cpu_s']:.1f}s minflt={totals['minflt']} preflight={preflight or '-'}")
    if not args.keep and (run_dir / "out").is_dir():
        shutil.rmtree(run_dir / "out", ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
