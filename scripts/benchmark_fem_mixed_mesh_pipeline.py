#!/usr/bin/env python3
"""Benchmark the strict SP4 mixed FEM mesh authoring and persistence pipeline."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import platform
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator, Mapping, Sequence, TypeVar

from fem_mixed_mesh_benchmark_evidence import (
    GMSH_VERSION,
    PHASE_TIMING_FIELDS,
    PRODUCTION_REPAIR_METHOD,
    REPAIR_METHODS,
    REPAIR_METHOD_OVERRIDES,
    SCHEMA,
    _SOURCE_IDENTITY_FIELDS,
    _normalize_sha256,
    _require_nonnegative_int,
    _require_positive_int,
    _run_failures,
    _summarize,
    linear_percentile,
    make_gate,
    validate_evidence_document,
)

_T = TypeVar("_T")
_QualificationRepairSelector = Callable[[str, object], object]

# The harness imports the canonical scenario as ``tests.*``.  When Python
# executes this file by path, ``sys.path[0]`` is ``scripts/`` rather than the
# repository root, so an unrelated installed package named ``tests`` can win
# the import.  Make the script self-contained for both direct and `just`
# invocations without requiring callers to remember a second PYTHONPATH entry.
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


@dataclass(frozen=True, slots=True)
class BenchmarkConfig:
    scenario: str
    cold_runs: int
    warm_runs: int
    native_audit_runs: int
    python_audit_runs: int
    warmup_runs: int
    artifact_dir: Path
    output: Path
    repair_method_override: str | None
    rayon_threads: Sequence[int]
    gmsh_threads: Sequence[int]


@dataclass(frozen=True, slots=True)
class PhaseTimings:
    authoring_resolve_s: float
    cache_lookup_s: float
    occ_build_s: float
    gmsh_generate_s: float
    gmsh_repair_s: float
    gmsh_extract_s: float
    orientation_s: float
    certificate_python_s: float
    certificate_native_s: float
    artifact_serialize_s: float
    artifact_hash_verify_s: float
    artifact_deserialize_s: float
    native_preflight_s: float
    total_s: float


@dataclass(frozen=True, slots=True)
class _BenchmarkDependencies:
    single_run: Callable[..., tuple[dict[str, object], object]]
    capture_source_identity: Callable[[Path], dict[str, object]]
    environment: Callable[[object], dict[str, object]]


@contextlib.contextmanager
def cold_workspace(artifact_dir: Path) -> Iterator[Path]:
    """Create and remove one cold workspace strictly below ``artifact_dir``."""
    requested = artifact_dir.expanduser().resolve()
    requested.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="cold-run-", dir=requested
    ) as workspace_name:
        workspace = Path(workspace_name).resolve()
        workspace.relative_to(requested)
        yield workspace


def _validate_config(config: BenchmarkConfig, mode: str) -> None:
    if config.scenario != "sp4_mixed":
        raise ValueError("scenario must be sp4_mixed")
    for field in (
        "cold_runs",
        "warm_runs",
        "native_audit_runs",
        "python_audit_runs",
        "warmup_runs",
    ):
        _require_nonnegative_int(getattr(config, field), field)
    if config.cold_runs + config.warm_runs < 1:
        raise ValueError("at least one cold or warm run is required")
    if not config.artifact_dir.is_absolute():
        raise ValueError("artifact_dir must be an absolute path")
    if not config.output.is_absolute():
        raise ValueError("output must resolve to an absolute path")
    if len(config.rayon_threads) != 1:
        raise ValueError("evidence.v2 requires exactly one Rayon thread value")
    (rayon_threads,) = tuple(config.rayon_threads)
    _require_positive_int(rayon_threads, "rayon_threads")
    if tuple(config.gmsh_threads) != (1,):
        raise ValueError(
            "evidence.v2 requires Gmsh threads to be exactly one: "
            "gmsh_threads=(1,)"
        )
    if config.repair_method_override not in {None, "", *REPAIR_METHOD_OVERRIDES}:
        raise ValueError("repair_method_override is unsupported")
    if mode == "baseline" and config.repair_method_override is not None:
        raise ValueError("repair_method_override is available only in qualification")
    if mode not in {"baseline", "qualification"}:
        raise ValueError(f"unsupported benchmark mode: {mode}")


def _rss_measurement() -> tuple[int | None, str]:
    if sys.platform == "win32":
        return None, "not_measured"
    import resource

    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024, "measured"


def _cpu_model() -> str:
    if sys.platform.startswith("linux"):
        try:
            for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
                if line.lower().startswith("model name"):
                    return line.partition(":")[2].strip() or "unknown"
        except OSError:
            pass
    return platform.processor() or "unknown"


def _benchmark_environment(mesh: object) -> dict[str, object]:
    certificate = mesh.mixed_layer_topology_certificate  # type: ignore[attr-defined]
    if certificate is None:
        raise ValueError("SP4 mixed mesh is missing its topology certificate")
    return {
        "python_version": platform.python_version(),
        "gmsh_version": certificate.gmsh_version,
        "certifier_algorithm": certificate.schema_version,
        "platform": platform.platform(),
        "cpu_model": _cpu_model(),
        "logical_cpus": os.cpu_count() or 1,
    }


def _seconds(nanoseconds: int) -> float:
    return float(nanoseconds) / 1_000_000_000.0


def _measure(
    timings_ns: dict[str, int], field: str, operation: Callable[[], _T]
) -> _T:
    started = time.perf_counter_ns()
    try:
        return operation()
    finally:
        timings_ns[field] = timings_ns.get(field, 0) + time.perf_counter_ns() - started


def _measure_sample(operation: Callable[[], _T]) -> tuple[_T, float]:
    """Run one audit without folding it into a producer-phase timing."""
    started = time.perf_counter_ns()
    try:
        result = operation()
    finally:
        elapsed_ns = time.perf_counter_ns() - started
    return result, _seconds(elapsed_ns)


@contextlib.contextmanager
def _environment(values: Mapping[str, str]) -> Iterator[None]:
    previous = {name: os.environ.get(name) for name in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@contextlib.contextmanager
def _isolated_run_environment(
    *,
    rayon_threads: int,
    gmsh_threads: int,
) -> Iterator[None]:
    """Disable shared-cache use for one measured run without touching its files."""
    with _environment(
        {
            "FULLMAG_FEM_MESH_CACHE_DIR": "",
            "RAYON_NUM_THREADS": str(rayon_threads),
            "FULLMAG_GMSH_THREADS": str(gmsh_threads),
        }
    ):
        yield


def _execute_repair(
    *,
    repair_method_override: str | None,
    gmsh_api: object,
    canonical_repair: Callable[[object], object],
    qualification_selector: _QualificationRepairSelector | None,
) -> object:
    if repair_method_override is None:
        return canonical_repair(gmsh_api)
    if qualification_selector is None:
        raise RuntimeError(
            "repair_method_override requires the canonical qualification selector "
            "introduced by Task 1; Task 0 does not duplicate production repair policy"
        )
    return qualification_selector(repair_method_override, gmsh_api)


@contextlib.contextmanager
def _mesh_phase_probe(
    timings_ns: dict[str, int],
    repair_method_override: str | None,
    qualification_selector: _QualificationRepairSelector | None = None,
) -> Iterator[None]:
    from fullmag.meshing import _gmsh_swept as swept

    gmsh = swept._import_gmsh()
    original_generate = gmsh.model.mesh.generate
    original_occ = swept._add_conforming_swept_box_airbox_geo
    original_repair = swept._repair_mixed_tetrahedra
    original_extract = swept._extract_mesh_data
    original_certificate = swept._attach_mixed_layer_topology_certificate
    original_oriented_copy = swept.MeshData.oriented_copy
    selected_repair = (
        qualification_selector
        or swept._repair_mixed_tetrahedra_for_qualification
    )

    def generated(*args: object, **kwargs: object) -> object:
        return _measure(
            timings_ns,
            "gmsh_generate_s",
            lambda: original_generate(*args, **kwargs),
        )

    def occ(*args: object, **kwargs: object) -> object:
        return _measure(
            timings_ns,
            "occ_build_s",
            lambda: original_occ(*args, **kwargs),
        )

    def repair(gmsh_api: object) -> object:
        # Preserve the production repair report so the apex optimizer can
        # reuse the completed tet gate instead of scanning the same mesh once
        # more.  The benchmark wrapper must not perturb the measured path.
        return _measure(
            timings_ns,
            "gmsh_repair_s",
            lambda: _execute_repair(
                repair_method_override=repair_method_override,
                gmsh_api=gmsh_api,
                canonical_repair=original_repair,
                qualification_selector=selected_repair,
            ),
        )

    def extract(*args: object, **kwargs: object) -> object:
        return _measure(
            timings_ns,
            "gmsh_extract_s",
            lambda: original_extract(*args, **kwargs),
        )

    def certificate(*args: object, **kwargs: object) -> object:
        return _measure(
            timings_ns,
            "certificate_python_s",
            lambda: original_certificate(*args, **kwargs),
        )

    def oriented_copy(instance: object, *args: object, **kwargs: object) -> object:
        return _measure(
            timings_ns,
            "orientation_s",
            lambda: original_oriented_copy(instance, *args, **kwargs),
        )

    gmsh.model.mesh.generate = generated
    swept._add_conforming_swept_box_airbox_geo = occ
    swept._repair_mixed_tetrahedra = repair
    swept._extract_mesh_data = extract
    swept._attach_mixed_layer_topology_certificate = certificate
    swept.MeshData.oriented_copy = oriented_copy
    try:
        yield
    finally:
        gmsh.model.mesh.generate = original_generate
        swept._add_conforming_swept_box_airbox_geo = original_occ
        swept._repair_mixed_tetrahedra = original_repair
        swept._extract_mesh_data = original_extract
        swept._attach_mixed_layer_topology_certificate = original_certificate
        swept.MeshData.oriented_copy = original_oriented_copy


@contextlib.contextmanager
def _persistence_phase_probe(
    timings_ns: dict[str, int], persistence: object
) -> Iterator[None]:
    from fullmag.meshing._gmsh_types import MeshData

    original_sha256 = persistence.sha256  # type: ignore[attr-defined]
    original_deserialize = persistence._deserialize_mesh  # type: ignore[attr-defined]
    original_deserialize_detached = getattr(
        persistence, "_deserialize_mesh_with_detached_certificate", None
    )
    original_topology_fingerprint = MeshData.topology_fingerprint_v3

    def timed_sha256(*args: object, **kwargs: object) -> object:
        return _measure(
            timings_ns,
            "artifact_hash_verify_s",
            lambda: original_sha256(*args, **kwargs),
        )

    def timed_deserialize(payload: bytes) -> object:
        return _measure(
            timings_ns,
            "artifact_deserialize_s",
            lambda: original_deserialize(payload),
        )

    def timed_deserialize_detached(payload: bytes) -> object:
        return _measure(
            timings_ns,
            "artifact_deserialize_s",
            lambda: original_deserialize_detached(payload),
        )

    def timed_topology_fingerprint(
        instance: object, *args: object, **kwargs: object
    ) -> object:
        return _measure(
            timings_ns,
            "artifact_hash_verify_s",
            lambda: original_topology_fingerprint(instance, *args, **kwargs),
        )

    persistence.sha256 = timed_sha256  # type: ignore[attr-defined]
    persistence._deserialize_mesh = timed_deserialize  # type: ignore[attr-defined]
    if original_deserialize_detached is not None:
        persistence._deserialize_mesh_with_detached_certificate = timed_deserialize_detached  # type: ignore[attr-defined]
    MeshData.topology_fingerprint_v3 = timed_topology_fingerprint  # type: ignore[method-assign]
    try:
        yield
    finally:
        persistence.sha256 = original_sha256  # type: ignore[attr-defined]
        persistence._deserialize_mesh = original_deserialize  # type: ignore[attr-defined]
        if original_deserialize_detached is not None:
            persistence._deserialize_mesh_with_detached_certificate = original_deserialize_detached  # type: ignore[attr-defined]
        MeshData.topology_fingerprint_v3 = original_topology_fingerprint  # type: ignore[method-assign]


def _author_sp4_without_meshing() -> object:
    import fullmag.world as world

    world.reset()
    original_build = world.build_domain_mesh
    world.build_domain_mesh = lambda: None
    try:
        from tests.standard_problems.mumag.sp4.fem.problem import (
            SP4RunRequest,
            build_study,
        )

        world.reset()
        request = SP4RunRequest(
            "relax",
            "case-a",
            "cpu",
            "medium",
            "baseline",
            None,
            None,
            "mixed_p1",
            1,
            "native",
        )
        study, _body = build_study(request)
        return study
    finally:
        world.build_domain_mesh = original_build


def _unavailable_phase_timings(*, native_audit_runs: int) -> list[str]:
    unavailable = ["cache_lookup_s"]
    if native_audit_runs == 0:
        unavailable.append("certificate_native_s")
    return unavailable


def _single_run(
    *,
    kind: str,
    index: int,
    workspace: Path,
    repair_method_override: str | None,
    rayon_threads: int,
    gmsh_threads: int,
    native_audit_runs: int,
    python_audit_runs: int,
) -> tuple[dict[str, object], object]:
    package_source = (
        Path(__file__).resolve().parents[1] / "packages" / "fullmag-py" / "src"
    )
    if str(package_source) not in sys.path:
        sys.path.insert(0, str(package_source))

    import fullmag.world as world
    from fullmag._core import validate_mesh_ir
    from fullmag.meshing import persistence

    timings_ns = {field: 0 for field in PHASE_TIMING_FIELDS}
    python_audit_samples_s: list[float] = []
    started_total = time.perf_counter_ns()
    with _isolated_run_environment(
        rayon_threads=rayon_threads,
        gmsh_threads=gmsh_threads,
    ):
        study = _measure(
            timings_ns,
            "authoring_resolve_s",
            _author_sp4_without_meshing,
        )
        with _mesh_phase_probe(timings_ns, repair_method_override):
            world.build_domain_mesh()
        artifact = study.mesh._current_artifact()
        mesh = artifact.mesh
        mesh_ir = mesh.to_ir(artifact.mesh_name)
        _measure(
            timings_ns,
            "native_preflight_s",
            lambda: validate_mesh_ir(mesh_ir),
        )
        for _ in range(python_audit_runs):
            _, elapsed_s = _measure_sample(
                lambda: mesh.validate_strict(require_positive_orientation=True)
            )
            python_audit_samples_s.append(elapsed_s)
        for _ in range(native_audit_runs):
            _measure(
                timings_ns,
                "certificate_native_s",
                lambda: validate_mesh_ir(mesh_ir),
            )

        artifact_path = workspace / f"{kind}-{index}.fullmag-mesh"
        _measure(
            timings_ns,
            "artifact_serialize_s",
            lambda: study.mesh.save(artifact_path),
        )
        with _persistence_phase_probe(timings_ns, persistence):
            loaded = persistence.load_mesh_artifact(artifact_path)

    timings_ns["total_s"] = time.perf_counter_ns() - started_total
    peak_rss_bytes, memory_status = _rss_measurement()
    build_report = loaded.build_report
    if not isinstance(build_report, Mapping):
        raise ValueError("SP4 mixed mesh artifact is missing its build report")
    degraded = build_report.get("degraded")
    if not isinstance(degraded, bool):
        raise ValueError(
            "SP4 mixed mesh build report is missing boolean degraded"
        )
    run = {
        "kind": kind,
        "index": index,
        "timings": asdict(
            PhaseTimings(
                **{
                    field: _seconds(timings_ns[field])
                    for field in PHASE_TIMING_FIELDS
                }
            )
        ),
        "python_audit_samples_s": python_audit_samples_s,
        "unavailable_phase_timings": _unavailable_phase_timings(
            native_audit_runs=native_audit_runs
        ),
        "peak_rss_bytes": peak_rss_bytes,
        "memory_status": memory_status,
        "topology_fingerprint_v3": _normalize_sha256(
            loaded.topology_fingerprint,
            "loaded topology_fingerprint_v3",
        ),
        "quality": _quality_document(loaded.mesh),
        "degraded": degraded,
    }
    return run, loaded.mesh


def _capture_source_identity(repo_root: Path) -> dict[str, object]:
    from capture_source_snapshot_identity import capture

    # The managed FEM runtime deliberately excludes documentation, UI and
    # other non-runtime trees from its source snapshot.  Reuse that exact
    # policy here: a full ``git status --untracked-files=all`` scan is
    # pathological on a Windows checkout exposed through Docker's 9P bind
    # mount, and can take longer than the mesh itself.  Runtime tracked and
    # untracked paths are still hashed and the capture remains race-checked.
    identity = capture(repo_root, ignore_non_runtime_dirty=True)
    return {field: identity[field] for field in _SOURCE_IDENTITY_FIELDS}


def _quality_document(mesh: object) -> dict[str, object]:
    certificate = mesh.mixed_layer_topology_certificate  # type: ignore[attr-defined]
    if certificate is None:
        raise ValueError("SP4 mixed mesh is missing its topology certificate")

    # An accepted certificate has zero total nonconforming faces, therefore
    # the same-side component is necessarily zero as well.  Avoid rebuilding
    # the Python face-adjacency dictionary for every large benchmark run; the
    # native certifier already checked this component during certification.
    same_side_two_owner_faces = 0
    if not hasattr(certificate, "nonconforming_face_count") or certificate.nonconforming_face_count:
        from fullmag.meshing._gmsh_types import _mixed_same_side_two_owner_face_count

        same_side_two_owner_faces = _mixed_same_side_two_owner_face_count(
            mesh, tolerance=certificate.plane_tolerance_m
        )

    return {
        "requested_layers": certificate.requested_layer_count,
        "realized_layers": certificate.realized_layer_count,
        "non_manifold_faces": certificate.nonmanifold_face_count,
        "same_side_two_owner_faces": same_side_two_owner_faces,
        "relative_volume_error": certificate.shared_domain_relative_volume_error,
        "scaled_jacobian_p05_by_family": dict(
            certificate.scaled_jacobian_p05_by_family
        ),
    }


def _render_document(document: Mapping[str, object]) -> str:
    return (
        json.dumps(
            document,
            sort_keys=True,
            allow_nan=False,
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )


def _write_document(path: Path, document: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_render_document(document), encoding="utf-8")


def _run_benchmark(
    config: BenchmarkConfig,
    *,
    mode: str,
    dependencies: _BenchmarkDependencies | None = None,
) -> dict[str, object]:
    _validate_config(config, mode)
    active = dependencies or _BenchmarkDependencies(
        single_run=_single_run,
        capture_source_identity=_capture_source_identity,
        environment=_benchmark_environment,
    )
    repo_root = Path(__file__).resolve().parents[1]
    artifact_dir = config.artifact_dir.expanduser().resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (configured_rayon_threads,) = tuple(config.rayon_threads)
    rayon_threads = int(configured_rayon_threads)
    gmsh_threads = 1

    warm_workspace = artifact_dir / "warm-workspace"
    warm_workspace.mkdir(parents=True, exist_ok=True)
    for index in range(config.warmup_runs):
        active.single_run(
            kind="warm",
            index=-(index + 1),
            workspace=warm_workspace,
            repair_method_override=config.repair_method_override,
            rayon_threads=rayon_threads,
            gmsh_threads=gmsh_threads,
            native_audit_runs=config.native_audit_runs,
            python_audit_runs=config.python_audit_runs,
        )

    runs: list[dict[str, object]] = []
    last_mesh: object | None = None
    for index in range(config.cold_runs):
        with cold_workspace(artifact_dir) as workspace:
            run, last_mesh = active.single_run(
                kind="cold",
                index=index,
                workspace=workspace,
                repair_method_override=config.repair_method_override,
                rayon_threads=rayon_threads,
                gmsh_threads=gmsh_threads,
                native_audit_runs=config.native_audit_runs,
                python_audit_runs=config.python_audit_runs,
            )
            runs.append(run)
    for index in range(config.warm_runs):
        run, last_mesh = active.single_run(
            kind="warm",
            index=index,
            workspace=warm_workspace,
            repair_method_override=config.repair_method_override,
            rayon_threads=rayon_threads,
            gmsh_threads=gmsh_threads,
            native_audit_runs=config.native_audit_runs,
            python_audit_runs=config.python_audit_runs,
        )
        runs.append(run)
    if last_mesh is None:
        raise ValueError("benchmark produced no measured mesh")

    failures = _run_failures(runs)
    last_run = runs[-1]
    document: dict[str, object] = {
        "schema": SCHEMA,
        "generated_at": datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        ),
        "source_identity": active.capture_source_identity(repo_root),
        "environment": active.environment(last_mesh),
        "scenario": {
            "id": config.scenario,
            "requested_layers": 1,
            "repair_method": (
                PRODUCTION_REPAIR_METHOD
                if mode == "baseline"
                else config.repair_method_override or "default"
            ),
            "gmsh_threads": gmsh_threads,
            "rayon_threads": rayon_threads,
            "python_audit_runs": config.python_audit_runs,
        },
        "mesh": {
            "nodes": last_mesh.n_nodes,  # type: ignore[attr-defined]
            "cells": last_mesh.n_elements,  # type: ignore[attr-defined]
            "facets": last_mesh.n_boundary_faces,  # type: ignore[attr-defined]
            "topology_fingerprint_v3": last_run["topology_fingerprint_v3"],
        },
        "quality": last_run["quality"],
        "runs": runs,
        "summary": _summarize(runs),
        "gate": make_gate(mode, failures),
    }
    validate_evidence_document(document)
    _write_document(config.output, document)
    return document


def run_benchmark(config: BenchmarkConfig) -> dict[str, object]:
    """Run the baseline harness against the canonical production repair hook."""
    return _run_benchmark(config, mode="baseline")


def _csv_positive_ints(value: str) -> tuple[int, ...]:
    try:
        parsed = tuple(int(item.strip()) for item in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected CSV integers") from error
    if not parsed or any(item <= 0 for item in parsed):
        raise argparse.ArgumentTypeError("thread counts must be positive integers")
    return parsed


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("sp4_mixed",), required=True)
    parser.add_argument(
        "--mode", choices=("baseline", "qualification"), required=True
    )
    parser.add_argument("--cold-runs", type=int, required=True)
    parser.add_argument("--warm-runs", type=int, required=True)
    parser.add_argument("--native-audit-runs", type=int, required=True)
    parser.add_argument("--python-audit-runs", type=int, required=True)
    parser.add_argument("--warmup-runs", type=int, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--repair-method",
        choices=("default", *REPAIR_METHOD_OVERRIDES),
        default="default",
    )
    parser.add_argument(
        "--rayon-threads", type=_csv_positive_ints, required=True
    )
    parser.add_argument(
        "--gmsh-threads", type=_csv_positive_ints, required=True
    )
    arguments = parser.parse_args(argv)
    if not arguments.artifact_dir.is_absolute():
        parser.error("--artifact-dir must be an absolute path")
    if len(arguments.rayon_threads) != 1:
        parser.error(
            "evidence.v2 records exactly one Rayon setting; "
            "pass one --rayon-threads value"
        )
    if tuple(arguments.gmsh_threads) != (1,):
        parser.error(
            "Task 0 through Task 9 requires --gmsh-threads 1 exactly; "
            "CSV matrices require separate evidence documents"
        )
    if (
        arguments.mode == "baseline"
        and arguments.repair_method != PRODUCTION_REPAIR_METHOD
    ):
        parser.error(
            "baseline requires --repair-method "
            f"{PRODUCTION_REPAIR_METHOD}"
        )
    return arguments


def _config_from_argv(
    argv: Sequence[str] | None = None,
) -> tuple[str, BenchmarkConfig]:
    arguments = _parse_args(argv)
    repair_override = None
    if arguments.mode == "qualification":
        repair_override = (
            "" if arguments.repair_method == "default" else arguments.repair_method
        )
    config = BenchmarkConfig(
        scenario=arguments.scenario,
        cold_runs=arguments.cold_runs,
        warm_runs=arguments.warm_runs,
        native_audit_runs=arguments.native_audit_runs,
        python_audit_runs=arguments.python_audit_runs,
        warmup_runs=arguments.warmup_runs,
        artifact_dir=arguments.artifact_dir,
        output=arguments.output.resolve(),
        repair_method_override=repair_override,
        rayon_threads=arguments.rayon_threads,
        gmsh_threads=arguments.gmsh_threads,
    )
    _validate_config(config, arguments.mode)
    return arguments.mode, config


def main(argv: Sequence[str] | None = None) -> int:
    mode, config = _config_from_argv(argv)
    if mode == "baseline":
        run_benchmark(config)
    else:
        _run_benchmark(config, mode="qualification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
