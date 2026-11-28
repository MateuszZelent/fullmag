"""Rig emulation probe: run one fullmag case once and record its per-job CPU, RAM and PCIe cost.

Run inside the Docker DEV backend container. One invocation runs one case once:

    gcc -O2 -I/usr/local/cuda/include scripts/benchmarks/nvml_gpu_sample.c -lnvidia-ml \
        -o /build/rig/nvml_gpu_sample
    python3 scripts/benchmarks/rig_probe.py --nvml-helper /build/rig/nvml_gpu_sample \
        --case-script scripts/benchmarks/fem_memory_transfer_case.py --backend fem \
        --label e2_auto_B_s110 --output /build/rig/results --prefix "taskset -c 30" \
        --env FEM_CASE_HMAX=3e-9 --env FEM_CASE_STEPS=110 --env FULLMAG_CPU_THREADS=1

See scripts/benchmarks/run_rig_fem_matrix.sh for the full matrix of the 2026-11-26 audit
(docs/audits/2026-11-26-rig-one-core-per-gpu-job.md).

Based on scripts/benchmarks/run_memory_transfer_probe.py. Differences:

- GPU state comes from the NVML helper ``nvml_gpu_sample``, read right before the run, every
  ``--gpu-interval`` seconds (5 s minimum, the agreed limit), and right after the run. It gives
  device memory in use, GPU utilisation and the cumulative PCIe byte counters of the whole GPU.
  The PCIe traffic of the run is the sum of the (wrapped) differences; the idle background of the
  GPU is measured separately (``--idle-only``) and subtracted in the analysis.
- The process tree is sampled every ``--sample-interval`` seconds: CPU time, RSS, thread count,
  page faults.
- Exact totals after the run come from getrusage(RUSAGE_CHILDREN): user and system CPU time,
  peak RSS of the largest process, page faults, voluntary and involuntary context switches.
- ``--neighbor-cpu K`` keeps a busy loop pinned to CPU K for the whole run.
- Small artifacts (CSV files and JSON receipts up to 20 MiB) and the logs are kept; field data
  is deleted.

Results are appended to ``<output>/results.jsonl``.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import resource
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
STEP_SUM_MARKERS = ("bytes", "sync", "count", "wall_time_ns", "evaluation", "solves", "rhs_evals",
                    "iterations")
COUNTER_KEY_MARKERS = ("d2h", "h2d", "host_sync", "graph_launch", "observed_step_count",
                       "realization", "workspace_bytes", "allocated_bytes", "strategy", "fallback",
                       "linear_solver", "cudss", "factor")
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")
KEEP_MAX_BYTES = 20 * 2**20
HERE = Path(__file__).resolve().parent


def nvml_sample(helper: Path) -> dict:
    try:
        completed = subprocess.run([str(helper)], capture_output=True, text=True, timeout=10,
                                   check=False)
        return json.loads(completed.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError) as error:
        return {"error": repr(error), "epoch_s": time.time()}


def pcie_sum(samples: list[dict], key: str) -> int | None:
    """Sum of successive differences of a cumulative counter, allowing for wrap-around."""
    values = [(s.get(key), s.get(key.replace("_bytes", "_bits"))) for s in samples
              if s.get("field_rc") == 0 and s.get(key.split("_")[0] + "_status") == 0]
    if len(values) < 2:
        return None
    total = 0
    for (previous, _), (current, bits) in zip(values, values[1:]):
        modulus = 2 ** (bits or 64)
        total += (current - previous) % modulus
    return total


def process_tree(root_pid: int) -> set[int]:
    parents: dict[int, int] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue
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


def sample_tree(root_pid: int, seen: dict[int, dict]) -> tuple[int, int, str]:
    """Summed RSS and thread count of the tree, and the CPU affinity of the root process.

    Updates per-process counters in ``seen``.
    """
    rss_total = 0
    threads_total = 0
    affinity = ""
    for pid in sorted(process_tree(root_pid), key=lambda pid: pid != root_pid):
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
            status = Path(f"/proc/{pid}/status").read_text()
        except OSError:
            continue
        fields = stat[stat.rfind(")") + 2:].split()
        record = {
            "comm": stat[stat.find("(") + 1:stat.rfind(")")],
            "cpu_s": (int(fields[11]) + int(fields[12])) / CLOCK_TICKS,
            "minflt": int(fields[7]),
            "majflt": int(fields[9]),
        }
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                rss_total += int(line.split()[1]) * 1024
            elif line.startswith("Threads:"):
                threads = int(line.split()[1])
                threads_total += threads
                record["threads"] = threads
            elif line.startswith("Cpus_allowed_list:") and not affinity:
                affinity = line.split(":", 1)[1].strip()
        seen[pid] = record
    return rss_total, threads_total, affinity


def collect_counters(value, prefix: str = "", out: dict | None = None, depth: int = 0) -> dict:
    if out is None:
        out = {}
    if depth > 8 or len(out) > 300:
        return out
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(child, (dict, list)):
                collect_counters(child, path, out, depth + 1)
            elif any(marker in key.lower() for marker in COUNTER_KEY_MARKERS):
                out[path] = child
    elif isinstance(value, list):
        for index, child in enumerate(value[:16]):
            collect_counters(child, f"{prefix}[{index}]", out, depth + 1)
    return out


def mesh_counts(metadata: dict) -> dict:
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


def keep_small_artifacts(artifacts: Path, destination: Path) -> list[str]:
    kept = []
    if not artifacts.is_dir():
        return kept
    for path in sorted(artifacts.rglob("*")):
        if path.is_file() and path.suffix in (".csv", ".json") and path.stat().st_size <= KEEP_MAX_BYTES:
            target = destination / path.relative_to(artifacts)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            kept.append(str(path.relative_to(artifacts)))
    return kept


def idle_only(args) -> int:
    first = nvml_sample(args.nvml_helper)
    samples = [first]
    deadline = time.time() + args.idle_only
    while time.time() < deadline:
        time.sleep(min(args.gpu_interval, max(0.0, deadline - time.time())))
        samples.append(nvml_sample(args.nvml_helper))
    span = samples[-1].get("epoch_s", 0) - first.get("epoch_s", 0)
    record = {"label": args.label, "kind": "idle_baseline", "span_s": round(span, 3),
              "pcie_tx_bytes": pcie_sum(samples, "tx_bytes"),
              "pcie_rx_bytes": pcie_sum(samples, "rx_bytes"), "gpu_samples": samples}
    args.output.mkdir(parents=True, exist_ok=True)
    with (args.output / "results.jsonl").open("a") as handle:
        handle.write(json.dumps(record) + "\n")
    tx, rx = record["pcie_tx_bytes"], record["pcie_rx_bytes"]
    print(f"{args.label}: idle {span:.1f}s tx={tx / span / 1e3 if tx and span else None} KB/s "
          f"rx={rx / span / 1e3 if rx and span else None} KB/s")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--case-script")
    parser.add_argument("--backend", choices=("fdm", "fem"))
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--env", action="append", default=[], help="KEY=VALUE for the case")
    parser.add_argument("--prefix", default="", help="command prepended to fullmag-bin")
    parser.add_argument("--neighbor-cpu", type=int, default=None,
                        help="keep busy loops pinned to this CPU during the run")
    parser.add_argument("--neighbor-count", type=int, default=1,
                        help="number of busy loops on --neighbor-cpu (default 1)")
    parser.add_argument("--fullmag-bin", default="fullmag-bin")
    parser.add_argument("--nvml-helper", type=Path, default=HERE / "nvml_gpu_sample")
    parser.add_argument("--sample-interval", type=float, default=0.2)
    parser.add_argument("--gpu-interval", type=float, default=5.0)
    parser.add_argument("--timeout", type=float, default=1800.0)
    parser.add_argument("--idle-only", type=float, default=0.0,
                        help="only measure the idle GPU background for this many seconds")
    args = parser.parse_args()
    args.gpu_interval = max(5.0, args.gpu_interval)
    if args.idle_only > 0:
        return idle_only(args)
    if not args.case_script or not args.backend:
        parser.error("--case-script and --backend are required")

    run_dir = args.output / "runs" / f"{args.label}-{int(time.time())}"
    run_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["FULLMAG_API_PORT"] = "0"
    env.update(PREVIEW_OFF_ENV)
    env.setdefault("FULLMAG_RUN_PERFORMANCE_STEP_CSV", "1")
    for item in args.env:
        key, _, value = item.partition("=")
        env[key] = value

    neighbors = []
    if args.neighbor_cpu is not None:
        for _ in range(max(1, args.neighbor_count)):
            neighbors.append(subprocess.Popen(["taskset", "-c", str(args.neighbor_cpu), "sh", "-c",
                                               "while :; do :; done"], start_new_session=True))
        time.sleep(1.0)

    command = shlex.split(args.prefix) + [
        args.fullmag_bin, args.case_script, "--backend", args.backend, "--headless",
        "--json", "--output-dir", str(run_dir / "out")]
    stdout_path, stderr_path = run_dir / "stdout.txt", run_dir / "stderr.txt"
    gpu_samples = [nvml_sample(args.nvml_helper)]
    samples = []
    seen: dict[int, dict] = {}
    peak_rss, peak_threads, affinity = 0, 0, ""
    affinities_seen: set[str] = set()
    timed_out = False
    usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started_epoch = time.time()
    started = time.perf_counter()
    next_gpu = started + args.gpu_interval
    with stdout_path.open("w") as out, stderr_path.open("w") as err:
        process = subprocess.Popen(command, env=env, stdout=out, stderr=err, start_new_session=True)
        while process.poll() is None:
            now = time.perf_counter()
            elapsed = now - started
            if elapsed > args.timeout:
                timed_out = True
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                break
            rss, threads, root_affinity = sample_tree(process.pid, seen)
            if root_affinity:
                affinity = root_affinity
                affinities_seen.add(root_affinity)
            cpu_s = sum(record["cpu_s"] for record in seen.values())
            minflt = sum(record["minflt"] for record in seen.values())
            samples.append((round(elapsed, 3), round(time.time(), 3), rss, threads, round(cpu_s, 3),
                            minflt))
            peak_rss = max(peak_rss, rss)
            peak_threads = max(peak_threads, threads)
            if now >= next_gpu:
                gpu_samples.append(nvml_sample(args.nvml_helper))
                next_gpu = now + args.gpu_interval
            time.sleep(args.sample_interval)
    returncode = process.wait()
    wall_s = time.perf_counter() - started
    ended_epoch = time.time()
    usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    gpu_samples.append(nvml_sample(args.nvml_helper))

    neighbor_cpu_s = None
    for neighbor in neighbors:
        try:
            stat = Path(f"/proc/{neighbor.pid}/stat").read_text()
            fields = stat[stat.rfind(")") + 2:].split()
            neighbor_cpu_s = (neighbor_cpu_s or 0.0) + (int(fields[11]) + int(fields[12])) / CLOCK_TICKS
        except OSError:
            pass
        os.killpg(neighbor.pid, signal.SIGKILL)
        neighbor.wait()

    with (run_dir / "samples.csv").open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["elapsed_s", "epoch_s", "process_tree_rss_bytes", "process_tree_threads",
                         "process_tree_cpu_s", "process_tree_minflt"])
        writer.writerows(samples)
    with (run_dir / "gpu_samples.jsonl").open("w") as handle:
        for sample in gpu_samples:
            handle.write(json.dumps(sample) + "\n")

    artifacts = run_dir / "out" / "artifacts"
    metadata = {}
    json_sizes = {}
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
    kept = keep_small_artifacts(artifacts, run_dir / "kept")
    log_text = stdout_path.read_text(errors="replace") + stderr_path.read_text(errors="replace")
    memory_used = [s.get("memory_used_mib") for s in gpu_samples if s.get("memory_rc") == 0]
    utils = [s.get("gpu_util_pct") for s in gpu_samples[1:-1] if s.get("util_rc") == 0]
    record = {
        "label": args.label,
        "kind": "run",
        "backend": args.backend,
        "case_script": args.case_script,
        "case_env": {item.partition("=")[0]: item.partition("=")[2] for item in args.env},
        "prefix": args.prefix,
        "neighbor_cpu": args.neighbor_cpu,
        "neighbor_count": len(neighbors),
        "neighbor_cpu_s": neighbor_cpu_s,
        "affinity_last": affinity,
        "affinities_seen": sorted(affinities_seen),
        "returncode": returncode,
        "timed_out": timed_out,
        "started_epoch": round(started_epoch, 3),
        "ended_epoch": round(ended_epoch, 3),
        "wall_s": round(wall_s, 3),
        "rusage": {
            "user_s": round(usage_after.ru_utime - usage_before.ru_utime, 3),
            "system_s": round(usage_after.ru_stime - usage_before.ru_stime, 3),
            "max_rss_largest_process_bytes": usage_after.ru_maxrss * 1024,
            "minflt": usage_after.ru_minflt - usage_before.ru_minflt,
            "majflt": usage_after.ru_majflt - usage_before.ru_majflt,
            "voluntary_switches": usage_after.ru_nvcsw - usage_before.ru_nvcsw,
            "involuntary_switches": usage_after.ru_nivcsw - usage_before.ru_nivcsw,
        },
        "process_tree_peak_rss_bytes": peak_rss,
        "process_tree_peak_threads": peak_threads,
        "process_tree_processes": sorted({r["comm"] for r in seen.values()}),
        "gpu_memory_before_mib": memory_used[0] if memory_used else None,
        "gpu_memory_peak_sampled_mib": max(memory_used) if memory_used else None,
        "gpu_util_samples_pct": utils,
        "pcie_tx_bytes": pcie_sum(gpu_samples, "tx_bytes"),
        "pcie_rx_bytes": pcie_sum(gpu_samples, "rx_bytes"),
        "pcie_window_s": round(gpu_samples[-1].get("epoch_s", 0) - gpu_samples[0].get("epoch_s", 0), 3),
        "json_artifact_bytes": json_sizes,
        "kept_artifacts": kept,
        "receipt_counters": collect_counters(provenance),
        "mesh": mesh_counts(metadata),
        "solver_steps": summarize_steps(artifacts / "solver_steps.csv"),
        "performance_steps": summarize_steps(artifacts / "performance" / "steps.csv"),
        "error_tail": "" if returncode == 0 else log_text[-2000:],
    }
    with (args.output / "results.jsonl").open("a") as handle:
        handle.write(json.dumps(record) + "\n")
    cpu = record["rusage"]["user_s"] + record["rusage"]["system_s"]
    print(f"{args.label}: rc={returncode} wall={wall_s:.1f}s cpu={cpu:.1f}s "
          f"rss_peak={peak_rss / 2**20:.0f}MiB threads_peak={peak_threads} affinity={affinity} "
          f"pcie_tx={record['pcie_tx_bytes']} pcie_rx={record['pcie_rx_bytes']} "
          f"invol_sw={record['rusage']['involuntary_switches']}")
    if (run_dir / "out").is_dir():
        shutil.rmtree(run_dir / "out", ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
