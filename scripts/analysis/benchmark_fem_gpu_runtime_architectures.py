#!/usr/bin/env python3
"""Cold/steady A/B for two immutable managed FEM GPU runtime variants."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import statistics
import subprocess
import sys
from pathlib import Path
from typing import Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[2]
VARIANTS_ROOT = REPO_ROOT / ".fullmag" / "runtimes" / "fem-gpu-variants"
ACTIVE_RUNTIME = REPO_ROOT / ".fullmag" / "runtimes" / "fem-gpu-host"
TASK0_FIXTURE_MANIFEST = (
    REPO_ROOT / "examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json"
)
TASK0_FIXTURE_ENVIRONMENT = (
    REPO_ROOT / "benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json"
)
TASK0_SOLVER_MESH = (
    REPO_ROOT / "examples/assets/fem_performance/box500_airbox_exchange_demag_v1.mesh.json"
)
TASK0_SOLVER_MESH_SHA256 = (
    "9c410c3b02cc86d3a832b923f13b5f9b0ec18c4be2babda148697c6dbc9c105a"
)


def prepare_empty_cache(path: Path) -> None:
    if path.exists():
        if not path.is_dir():
            raise ValueError(f"CUDA cache path is not a directory: {path}")
        if any(path.iterdir()):
            raise ValueError(f"CUDA cache directory is not empty: {path}")
        return
    path.mkdir(parents=True)


def runtime_environment(
    repo_root: Path,
    python_extension_root: Path,
    runner: Path,
    runtime_root: Path,
    cuda_cache: Path,
) -> dict[str, str]:
    env = os.environ.copy()

    def prepend(key: str, path: Path) -> None:
        current = env.get(key)
        env[key] = str(path) if not current else f"{path}{os.pathsep}{current}"

    env.update(
        {
            "FULLMAG_BENCH_GPU_BIN": str(runner),
            "FULLMAG_FEM_RUNTIME_ROOT": str(runtime_root),
            "FULLMAG_REPO_ROOT": str(repo_root),
            "FULLMAG_PYTHON": str(repo_root / ".fullmag/local/python/bin/python"),
            "FULLMAG_CPU_THREADS": "auto",
            "FULLMAG_BENCH_DOMAIN_HMAX": "5e-08",
            "FULLMAG_BENCH_AIRBOX_HMAX": "1e-07",
            "CUDA_CACHE_PATH": str(cuda_cache),
            "OPAL_PREFIX": str(runtime_root / "openmpi"),
            "OMPI_MCA_mca_base_component_path": str(runtime_root / "openmpi/lib/openmpi3"),
            "OMPI_MCA_orte_launch_agent": str(runtime_root / "openmpi/bin/orted"),
            "OMPI_MCA_ess": "singleton",
            "OMPI_MCA_plm": "isolated",
            "OMPI_MCA_pmix": "isolated",
            "OMPI_MCA_btl": "self",
            "PMIX_PREFIX": str(runtime_root / "lib/pmix2"),
            "PMIX_EXEC_PREFIX": str(runtime_root / "lib/pmix2"),
            "PMIX_DATADIR": str(runtime_root / "lib/pmix2/share"),
            "PMIX_PKGDATADIR": str(runtime_root / "lib/pmix2/share/pmix"),
            "PMIX_LIBDIR": str(runtime_root / "lib/pmix2/lib"),
            "PMIX_MCA_mca_base_component_path": str(runtime_root / "lib/pmix2/lib/pmix"),
        }
    )
    prepend("LD_LIBRARY_PATH", runtime_root / "lib")
    prepend("PYTHONPATH", python_extension_root)
    prepend("PYTHONPATH", repo_root / "packages/fullmag-py/src")
    prepend("PATH", runtime_root / "openmpi/bin")
    return env


def benchmark_command(
    repo_root: Path,
    *,
    repeat: int,
    warmup: bool,
    output: Path,
    fixture_manifest: Path = TASK0_FIXTURE_MANIFEST,
    fixture_environment: Path | None = TASK0_FIXTURE_ENVIRONMENT,
    require_fixture_identity: bool = True,
) -> list[str]:
    command = [
        sys.executable,
        str(repo_root / "scripts/analysis/fem_gpu_benchmark.py"),
        "--meshes",
        "coarse",
        "--scenarios",
        "box500_airbox_exchange_demag",
        "--integrators",
        "heun",
        "--relax-algorithms",
        "nonlinear_cg",
        "--demag-preconditioners",
        "AMG",
        "--demag-amg-relax-types",
        "6",
        "--steps",
        "64",
        "--repeat",
        str(repeat),
        "--backends",
        "gpu",
        "--fixture-manifest",
        str(fixture_manifest),
        "--reuse-generated-domain-mesh",
        "--require-stable-solver-mesh",
        "--require-demag-converged",
        "--require-gpu-strict-residency",
        "--skip-preflight",
        "--case-timeout-s",
        "900",
        "--output",
        str(output),
    ]
    if fixture_environment is not None:
        command.extend(["--fixture-environment", str(fixture_environment)])
    if require_fixture_identity:
        command.append("--require-fixture-identity")
    if warmup:
        command.append("--gpu-warmup")
    return command


def _as_int(value: object) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def write_localized_fixture_identity(
    repo_root: Path,
    output_dir: Path,
    preflight_row: Mapping[str, object],
) -> tuple[Path, Path, dict[str, str]]:
    source_manifest_path = (
        repo_root / "examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json"
    ).resolve()
    source_environment_path = (
        repo_root / "benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json"
    ).resolve()
    solver_mesh_path = (
        repo_root / "examples/assets/fem_performance/box500_airbox_exchange_demag_v1.mesh.json"
    ).resolve()
    source = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    mesh_sha256 = hashlib.sha256(solver_mesh_path.read_bytes()).hexdigest()
    exact_source_contract = {
        "solver_mesh_sha256": TASK0_SOLVER_MESH_SHA256,
        "node_count": 1200,
        "element_count": 5138,
        "domain_hmax_m": 50e-9,
        "airbox_hmax_m": 100e-9,
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
    }
    for key, expected in exact_source_contract.items():
        if source.get(key) != expected:
            raise ValueError(f"Task 0 fixture {key} differs from exact contract")
    if mesh_sha256 != TASK0_SOLVER_MESH_SHA256:
        raise ValueError("Task 0 physical solver mesh SHA-256 differs from exact contract")
    if source.get("stop_condition", {}).get("max_steps") != 64:
        raise ValueError("Task 0 fixture step count differs from exact contract")
    demag_policy = source.get("demag_policy", {})
    if (
        demag_policy.get("solver") != "CG"
        or demag_policy.get("preconditioner") != "AMG"
        or demag_policy.get("amg_relax_type") != 6
        or demag_policy.get("rtol") != 1e-12
    ):
        raise ValueError("Task 0 fixture demag policy differs from CG/AMG6 exact contract")

    row_contract = {
        "status": "ok",
        "reported_scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": "nonlinear_cg",
        "requested_demag_solver": "CG",
        "requested_demag_preconditioner": "AMG",
        "requested_demag_amg_relax_type": "6",
        "requested_demag_relative_tolerance": "1e-12",
    }
    for key, expected in row_contract.items():
        if str(preflight_row.get(key) or "") != expected:
            raise ValueError(f"localized fixture preflight {key} differs from exact contract")
    for key, expected in (("steps", 64), ("executed_steps", 64), ("node_count", 1200), ("element_count", 5138)):
        if _as_int(preflight_row.get(key)) != expected:
            raise ValueError(f"localized fixture preflight {key} differs from exact contract")
    solver_mesh_signature = str(preflight_row.get("solver_mesh_signature") or "")
    problem_ir_sha256 = str(preflight_row.get("executed_problem_ir_sha256") or "")
    if len(solver_mesh_signature) != 64 or len(problem_ir_sha256) != 64:
        raise ValueError("localized fixture preflight omitted SHA-256 mesh or ProblemIR identity")

    proof_dir = output_dir / "proof" / "localized-fixture"
    proof_dir.mkdir(parents=True, exist_ok=True)
    localized_manifest_path = proof_dir / "fixture.json"
    localized = dict(source)
    localized.update(
        {
            "solver_mesh_path": str(solver_mesh_path),
            "solver_mesh_signature": solver_mesh_signature,
            "problem_ir_sha256": problem_ir_sha256,
            "localized_identity": {
                "source_manifest": str(source_manifest_path),
                "source_manifest_sha256": hashlib.sha256(
                    source_manifest_path.read_bytes()
                ).hexdigest(),
                "reason": "Task 0 v1 ProblemIR identity contains a container-local mesh path",
            },
        }
    )
    localized_manifest_path.write_text(
        json.dumps(localized, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    manifest_sha256 = hashlib.sha256(localized_manifest_path.read_bytes()).hexdigest()
    localized_environment_path = proof_dir / "environment.json"
    localized_environment_path.write_text(
        json.dumps(
            {
                "schema": "fullmag.fem_gpu.localized_performance_environment.v1",
                "source_environment": str(source_environment_path),
                "fixture": {
                    "manifest_path": str(localized_manifest_path.resolve()),
                    "manifest_sha256": manifest_sha256,
                    "solver_mesh_sha256": mesh_sha256,
                    "solver_mesh_signature": solver_mesh_signature,
                    "problem_ir_sha256": problem_ir_sha256,
                },
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return (
        localized_manifest_path,
        localized_environment_path,
        {
            "manifest_sha256": manifest_sha256,
            "solver_mesh_sha256": mesh_sha256,
            "solver_mesh_signature": solver_mesh_signature,
            "problem_ir_sha256": problem_ir_sha256,
        },
    )


def verify_cross_variant_fixture_identity(
    baseline_rows: Sequence[Mapping[str, str]],
    candidate_rows: Sequence[Mapping[str, str]],
    identity: Mapping[str, str],
) -> None:
    expected_ir = identity["problem_ir_sha256"]
    expected_mesh = identity["solver_mesh_signature"]
    for row in [*baseline_rows, *candidate_rows]:
        if (
            row.get("executed_problem_ir_sha256") != expected_ir
            or row.get("solver_mesh_signature") != expected_mesh
        ):
            raise ValueError("A/B row differs from localized fixture identity")


def run_logged(
    command: Sequence[str],
    *,
    cwd: Path,
    log_path: Path,
    env: Mapping[str, str] | None = None,
) -> str:
    run_env = None if env is None else dict(env)
    if run_env is not None:
        run_env["FULLMAG_BENCH_RAW_CASE_OUTPUT"] = str(
            log_path.with_suffix(".case-output.log")
        )
    completed = subprocess.run(
        list(command),
        cwd=cwd,
        env=run_env,
        text=True,
        capture_output=True,
        check=False,
    )
    output = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(output, encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(
            f"command failed with exit {completed.returncode}; see {log_path}: "
            + " ".join(command)
        )
    return output


def manifest_identity(runtime_root: Path) -> dict[str, object]:
    manifest_path = runtime_root / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    payload = json.loads(manifest_bytes)
    if payload.get("schema") != 2:
        raise ValueError(f"runtime variant is not manifest schema v2: {runtime_root}")
    return {
        "root": str(runtime_root.resolve()),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "variant": payload.get("variant"),
        "build": payload.get("build"),
        "runtime_diagnostics": payload.get("runtime_diagnostics"),
        "native_libraries": payload.get("native_libraries"),
    }


def public_fem_abi_symbols(runtime_root: Path) -> tuple[str, ...]:
    manifest = json.loads((runtime_root / "manifest.json").read_text(encoding="utf-8"))
    library = runtime_root / manifest["native_libraries"]["fullmag_fem"]["path"]
    completed = subprocess.run(
        ["nm", "-D", "--defined-only", str(library)],
        text=True,
        capture_output=True,
        check=True,
    )
    return tuple(
        sorted(
            fields[-1]
            for line in completed.stdout.splitlines()
            if (fields := line.split()) and fields[-1].startswith("fullmag_fem_")
        )
    )


def loader_trace(runner: Path, runtime_root: Path) -> str:
    env = os.environ.copy()
    current = env.get("LD_LIBRARY_PATH")
    env["LD_LIBRARY_PATH"] = str(runtime_root / "lib") + (
        f"{os.pathsep}{current}" if current else ""
    )
    completed = subprocess.run(
        ["ldd", str(runner)],
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    if "not found" in completed.stdout:
        raise ValueError(f"loader trace has unresolved libraries for {runtime_root}")
    resolved_root = runtime_root.resolve()
    for soname in (
        "libfullmag_fem.so.0",
        "libmfem.so.4.9.0",
        "libHYPRE-3.1.0.so",
        "libceed.so",
    ):
        line = next(
            (line for line in completed.stdout.splitlines() if line.strip().startswith(soname)),
            None,
        )
        if line is None or "=>" not in line:
            raise ValueError(f"loader trace is missing {soname} for {runtime_root}")
        loaded = Path(line.split("=>", 1)[1].strip().split(" ", 1)[0]).resolve()
        if resolved_root not in loaded.parents:
            raise ValueError(f"{soname} escaped selected runtime root: {loaded}")
    return completed.stdout


def validate_runner_harness(
    runner: Path,
    baseline_root: Path,
    candidate_root: Path,
) -> str:
    runner = runner.resolve()
    for runtime_root in (baseline_root.resolve(), candidate_root.resolve()):
        if runner == runtime_root or runtime_root in runner.parents:
            raise ValueError(
                "common A/B runner must be independent of both runtime variants"
            )
    if not runner.is_file() or not os.access(runner, os.X_OK):
        raise ValueError(f"common A/B runner is missing or not executable: {runner}")
    worker_sha256 = hashlib.sha256(runner.read_bytes()).hexdigest()
    manifest_path = runner.parent / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "fullmag.fem_gpu.runner_harness.v1":
        raise ValueError("unsupported FEM GPU runner harness manifest schema")
    if manifest.get("worker") != runner.name:
        raise ValueError("runner harness manifest points to a different worker")
    if manifest.get("worker_sha256") != worker_sha256:
        raise ValueError("runner harness manifest worker SHA-256 mismatch")
    candidate_manifest_sha256 = hashlib.sha256(
        (candidate_root / "manifest.json").read_bytes()
    ).hexdigest()
    harness_id = hashlib.sha256(
        f"{worker_sha256}:{candidate_manifest_sha256}".encode("ascii")
    ).hexdigest()
    if runner.parent.name != harness_id or manifest.get("harness_id") != harness_id:
        raise ValueError(
            "common A/B runner directory must be addressed by runner and candidate hashes"
        )
    if (
        manifest.get("source_candidate_manifest_sha256")
        != candidate_manifest_sha256
    ):
        raise ValueError("runner harness candidate manifest SHA-256 mismatch")
    return worker_sha256


def select_and_validate(
    repo_root: Path,
    variant: str,
    runner: Path,
    proof_dir: Path,
) -> Path:
    runtime_root = (VARIANTS_ROOT / variant).resolve()
    run_logged(
        ["just", "select-fem-gpu-runtime-variant", variant],
        cwd=repo_root,
        log_path=proof_dir / "select-and-validate.log",
    )
    if ACTIVE_RUNTIME.resolve() != runtime_root:
        raise ValueError(
            f"active runtime did not resolve to selected variant: {ACTIVE_RUNTIME.resolve()}"
        )
    trace = loader_trace(runner, runtime_root)
    (proof_dir / "loader-trace.txt").write_text(trace, encoding="utf-8")
    return runtime_root


def read_rows(paths: Sequence[Path]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for path in paths:
        with path.open(newline="", encoding="utf-8") as handle:
            rows.extend(csv.DictReader(handle))
    return rows


def distribution(rows: Sequence[Mapping[str, str]], field: str) -> dict[str, float | int]:
    values = [float(row[field]) for row in rows if row.get(field)]
    if len(values) < 5:
        raise ValueError(f"{field} needs at least five samples, got {len(values)}")
    ordered = sorted(values)
    return {
        "count": len(values),
        "p50": statistics.median(ordered),
        "p95": ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)],
        "stddev": statistics.pstdev(ordered),
    }


def verify_rows(rows: Sequence[Mapping[str, str]], expected_manifest_sha256: str) -> None:
    if len(rows) < 5:
        raise ValueError(f"A/B phase needs at least five rows, got {len(rows)}")
    for row in rows:
        if row.get("status") != "ok":
            raise ValueError(f"benchmark row did not complete: {row.get('error')}")
        if row.get("runtime_manifest_sha256") != expected_manifest_sha256:
            raise ValueError("benchmark row runtime manifest differs from selected variant")
        for field in (
            "backend_create_wall_time_ms",
            "first_accepted_step_demag_solver_apply_wall_time_ms",
        ):
            if not row.get(field) or float(row[field]) <= 0.0:
                raise ValueError(f"benchmark row is missing positive {field}")


def summarize_variant(
    identity: Mapping[str, object],
    cold_rows: Sequence[Mapping[str, str]],
    steady_rows: Sequence[Mapping[str, str]],
) -> dict[str, object]:
    expected_hash = str(identity["manifest_sha256"])
    verify_rows(cold_rows, expected_hash)
    verify_rows(steady_rows, expected_hash)
    metrics = {}
    for field in (
        "backend_create_wall_time_ms",
        "first_accepted_step_demag_solver_apply_wall_time_ms",
        "wall_time_ms",
    ):
        metrics[field] = {
            "cold": distribution(cold_rows, field),
            "steady": distribution(steady_rows, field),
        }
    return {"identity": dict(identity), "metrics": metrics}


def write_reports(output_dir: Path, payload: Mapping[str, object]) -> None:
    (output_dir / "summary.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    baseline = payload["variants"]["baseline"]
    candidate = payload["variants"]["candidate"]
    lines = [
        "# FEM GPU runtime architecture A/B",
        "",
        f"- GPU: `{payload['gpu']['device_name']}` (CC `{payload['gpu']['compute_capability']}`)",
        f"- Baseline manifest: `{baseline['identity']['manifest_sha256']}`",
        f"- Candidate manifest: `{candidate['identity']['manifest_sha256']}`",
        f"- Common runner SHA-256: `{payload['common_runner_sha256']}`",
        "- Workload: Task 0 box500 airbox exchange+demag fixture; NCG; AMG relax 6; 64 steps.",
        f"- Task 0 physical mesh SHA-256: `{payload['localized_fixture']['solver_mesh_sha256']}`.",
        f"- Localized ProblemIR SHA-256: `{payload['localized_fixture']['problem_ir_sha256']}`.",
        "- The historical v1 ProblemIR hash was container-path-dependent; an unmeasured preflight localized that identity while preserving the exact physical fixture.",
        "- Cold: five processes with separate initially empty CUDA cache directories.",
        "- Steady: one warmup followed by five measured repeats per variant.",
        "- `first_accepted_step_demag_solver_apply_wall_time_ms` is the first non-zero accepted-step aggregate from the legacy-compatible step ABI; it is not a literal single-solve timing and may include multiple demag solves.",
        "",
        "| Metric | Baseline cold p50/p95 | Candidate cold p50/p95 | Baseline steady p50/p95 | Candidate steady p50/p95 |",
        "|---|---:|---:|---:|---:|",
    ]
    for field in (
        "backend_create_wall_time_ms",
        "first_accepted_step_demag_solver_apply_wall_time_ms",
        "wall_time_ms",
    ):
        bm = baseline["metrics"][field]
        cm = candidate["metrics"][field]
        lines.append(
            f"| `{field}` | {bm['cold']['p50']:.3f}/{bm['cold']['p95']:.3f} | "
            f"{cm['cold']['p50']:.3f}/{cm['cold']['p95']:.3f} | "
            f"{bm['steady']['p50']:.3f}/{bm['steady']['p95']:.3f} | "
            f"{cm['steady']['p50']:.3f}/{cm['steady']['p95']:.3f} |"
        )
    lines.extend(
        [
            "",
            "Packaging correctness is the Task 6 acceptance condition; no minimum speedup is imposed.",
            "The candidate variant was restored and revalidated after the measurement.",
            "",
        ]
    )
    (output_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-variant", required=True)
    parser.add_argument("--candidate-variant", required=True)
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--cold-repeats", type=int, default=5)
    parser.add_argument("--steady-repeats", type=int, default=5)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    if args.cold_repeats < 5 or args.steady_repeats < 5:
        raise SystemExit("cold and steady A/B each require at least five samples")
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    baseline_root = (VARIANTS_ROOT / args.baseline_variant).resolve()
    candidate_root = (VARIANTS_ROOT / args.candidate_variant).resolve()
    runner = args.runner.resolve()
    try:
        runner_sha256 = validate_runner_harness(runner, baseline_root, candidate_root)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from error

    baseline_symbols = public_fem_abi_symbols(baseline_root)
    candidate_symbols = public_fem_abi_symbols(candidate_root)
    if not baseline_symbols or baseline_symbols != candidate_symbols:
        raise SystemExit("baseline and candidate public fullmag_fem C ABI symbols differ")
    (output_dir / "public-c-abi-symbols.txt").write_text(
        "\n".join(baseline_symbols) + "\n", encoding="utf-8"
    )

    identities = {
        "baseline": manifest_identity(baseline_root),
        "candidate": manifest_identity(candidate_root),
    }
    measurements: dict[str, tuple[list[dict[str, str]], list[dict[str, str]]]] = {}
    localized_identity: dict[str, str] | None = None
    try:
        preflight_runtime_root = select_and_validate(
            REPO_ROOT,
            args.candidate_variant,
            runner,
            output_dir / "proof" / "localized-fixture-runtime",
        )
        preflight_cache = output_dir / "cuda-cache" / "localized-fixture-preflight"
        prepare_empty_cache(preflight_cache)
        preflight_csv = output_dir / "proof" / "localized-fixture" / "preflight.csv"
        preflight_csv.parent.mkdir(parents=True, exist_ok=True)
        run_logged(
            benchmark_command(
                REPO_ROOT,
                repeat=1,
                warmup=False,
                output=preflight_csv,
                fixture_manifest=TASK0_FIXTURE_MANIFEST,
                fixture_environment=None,
                require_fixture_identity=False,
            ),
            cwd=REPO_ROOT,
            env=runtime_environment(
                REPO_ROOT,
                candidate_root,
                runner,
                preflight_runtime_root,
                preflight_cache,
            ),
            log_path=output_dir / "proof" / "localized-fixture" / "preflight.log",
        )
        preflight_rows = read_rows([preflight_csv])
        if len(preflight_rows) != 1:
            raise ValueError(
                f"localized fixture preflight needs exactly one row, got {len(preflight_rows)}"
            )
        localized_manifest, localized_environment, localized_identity = (
            write_localized_fixture_identity(REPO_ROOT, output_dir, preflight_rows[0])
        )

        for label, variant in (
            ("baseline", args.baseline_variant),
            ("candidate", args.candidate_variant),
        ):
            runtime_root = select_and_validate(
                REPO_ROOT, variant, runner, output_dir / "proof" / label
            )
            cold_csvs = []
            for trial in range(1, args.cold_repeats + 1):
                cache = output_dir / "cuda-cache" / "cold" / label / f"trial-{trial}"
                prepare_empty_cache(cache)
                csv_path = output_dir / "cold" / label / f"trial-{trial}.csv"
                env = runtime_environment(
                    REPO_ROOT, candidate_root, runner, runtime_root, cache
                )
                run_logged(
                    benchmark_command(
                        REPO_ROOT,
                        repeat=1,
                        warmup=False,
                        output=csv_path,
                        fixture_manifest=localized_manifest,
                        fixture_environment=localized_environment,
                    ),
                    cwd=REPO_ROOT,
                    env=env,
                    log_path=output_dir / "cold" / label / f"trial-{trial}.log",
                )
                cold_csvs.append(csv_path)

            steady_cache = output_dir / "cuda-cache" / "steady" / label
            prepare_empty_cache(steady_cache)
            steady_csv = output_dir / "steady" / label / "benchmark.csv"
            run_logged(
                benchmark_command(
                    REPO_ROOT,
                    repeat=args.steady_repeats,
                    warmup=True,
                    output=steady_csv,
                    fixture_manifest=localized_manifest,
                    fixture_environment=localized_environment,
                ),
                cwd=REPO_ROOT,
                env=runtime_environment(
                    REPO_ROOT, candidate_root, runner, runtime_root, steady_cache
                ),
                log_path=output_dir / "steady" / label / "benchmark.log",
            )
            measurements[label] = (read_rows(cold_csvs), read_rows([steady_csv]))
    finally:
        select_and_validate(
            REPO_ROOT,
            args.candidate_variant,
            runner,
            output_dir / "proof" / "final-candidate-restore",
        )

    baseline_summary = summarize_variant(identities["baseline"], *measurements["baseline"])
    candidate_summary = summarize_variant(identities["candidate"], *measurements["candidate"])
    if localized_identity is None:
        raise ValueError("localized fixture identity was not generated")
    verify_cross_variant_fixture_identity(
        [*measurements["baseline"][0], *measurements["baseline"][1]],
        [*measurements["candidate"][0], *measurements["candidate"][1]],
        localized_identity,
    )
    gpu = identities["candidate"]["runtime_diagnostics"]
    payload = {
        "schema": "fullmag.fem_gpu.runtime_architecture_ab.v1",
        "gpu": gpu,
        "common_runner": str(runner),
        "common_runner_sha256": runner_sha256,
        "public_c_abi_symbol_count": len(baseline_symbols),
        "cold_repeats": args.cold_repeats,
        "steady_repeats": args.steady_repeats,
        "localized_fixture": localized_identity,
        "variants": {
            "baseline": baseline_summary,
            "candidate": candidate_summary,
        },
        "final_active_runtime": str(ACTIVE_RUNTIME.resolve()),
    }
    write_reports(output_dir, payload)
    print(json.dumps({"status": "ok", "report": str(output_dir / "report.md")}))


if __name__ == "__main__":
    main()
