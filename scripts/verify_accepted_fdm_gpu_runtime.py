#!/usr/bin/env python3
"""Verify one accepted FDM GPU run through the production process boundary."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_source_snapshot_identity as source_identity  # noqa: E402
import fullmag_storage as storage  # noqa: E402
from verify_project_api_runtime import (  # noqa: E402
    assert_build_identity,
    child_environment,
    json_request,
    terminate_process,
    wait_for_health,
    write_atomic_json,
)
from verify_resource_discovery_runtime import (  # noqa: E402
    contained_paths,
    durable_leases,
    load_fixture,
    run_json_process,
    sha256,
    start_api,
    worker_control_evidence,
)
from verify_session_persistence import toolchain_identity  # noqa: E402


PROFILE = "windows-api-fdm-gpu-runtime"
RECEIPT_SCHEMA = "fullmag_accepted_fdm_gpu_runtime_v1"
GPU_MEMORY_MINIMUM = 64 * 1024 * 1024
API_BINARY_NAMES = (
    "fullmag-api",
    "fullmag-api-resource-pool",
    "fullmag-api-accepted-scheduler",
    "fullmag-api-accepted-worker",
)


class AcceptedFdmGpuRuntimeError(RuntimeError):
    """The managed build or accepted GPU process proof failed."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def prepare_gpu_request(
    fixture: dict[str, object], fixture_identity: str
) -> tuple[str, str, dict[str, object]]:
    intent = fixture["run_intent"]
    specification = intent["specification"]
    request = specification["requested_execution"]
    minimum = request["minimum_resources"]
    run_id = f"accepted-fdm-gpu-{fixture_identity}"
    idempotency_key = f"accepted-fdm-gpu-{fixture_identity}"
    intent["idempotency_key"] = idempotency_key
    specification["run_id"] = run_id
    request["device"] = "gpu"
    minimum["gpu_memory_bytes"] = GPU_MEMORY_MINIMUM
    return run_id, idempotency_key, fixture


def build_cuda_binaries(
    repo_root: Path,
    layout: dict[str, object],
    paths: dict[str, Path],
    env: dict[str, str],
    expected_identity: dict[str, object],
) -> tuple[dict[str, Path], dict[str, object]]:
    powershell = shutil.which("pwsh.exe") or shutil.which("powershell.exe")
    if powershell is None:
        raise AcceptedFdmGpuRuntimeError("PowerShell executable is unavailable")
    command = [
        powershell,
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(repo_root / "scripts" / "windows" / "run_fullmag.ps1"),
        "-BuildMode",
        "true",
        "-Frontend",
        "dev",
        "-Backend",
        "fdm",
        "-Device",
        "gpu",
        "-RunMode",
        "headless",
        "-BuildOnly",
        "-SkipCompatibilityLinks",
    ]
    build_env = dict(env)
    build_env["FULLMAG_STORAGE_PROFILE"] = PROFILE
    build_env["FULLMAG_STORAGE_MANAGED_ENTRY"] = "1"
    with paths["cargo_log"].open("w", encoding="utf-8", newline="\n") as log:
        completed = subprocess.run(
            command,
            cwd=repo_root,
            env=build_env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
    if completed.returncode != 0:
        raise AcceptedFdmGpuRuntimeError(
            f"managed CUDA production build failed with code {completed.returncode}"
        )

    manifest_path = Path(str(layout["build_root"])) / "windows-runtime" / "build-manifest.json"
    if not manifest_path.is_file():
        raise AcceptedFdmGpuRuntimeError("managed CUDA build manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("cuda") is not True
        or manifest.get("git_commit") != expected_identity["head_commit_full"]
        or manifest.get("source_snapshot_sha256")
        != expected_identity["source_snapshot_sha256"]
        or manifest.get("source_identity_check") != "passed"
    ):
        raise AcceptedFdmGpuRuntimeError(
            "managed CUDA build manifest does not match the requested source snapshot"
        )

    api_binary = Path(str(manifest.get("api_binary", "")))
    cli_binary = Path(str(manifest.get("binary", "")))
    native_dll = Path(str(manifest.get("native_fdm_dll", "")))
    source_directory = api_binary.parent
    extension = ".exe" if os.name == "nt" else ""
    sources = {
        "fullmag": cli_binary,
        "fullmag_fdm.dll": native_dll,
        **{
            name: source_directory / f"{name}{extension}" for name in API_BINARY_NAMES
        },
    }
    binaries: dict[str, Path] = {}
    evidence: dict[str, object] = {
        "command": command,
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256(manifest_path),
        "manifest": manifest,
    }
    for name, source in sources.items():
        if not source.is_file() or source.stat().st_size == 0:
            raise AcceptedFdmGpuRuntimeError(
                f"managed CUDA binary is missing or empty: {source}"
            )
        destination = paths["run_root"] / source.name
        shutil.copy2(source, destination)
        binaries[name] = destination
        evidence[name] = {
            "path": str(destination),
            "size_bytes": destination.stat().st_size,
            "sha256": sha256(destination),
        }
    return binaries, evidence


def validate_gpu_offer(
    published: dict[str, object], minimum: dict[str, int]
) -> dict[str, object]:
    if published.get("status") != "accepted" or published.get("generation") != 1:
        raise AcceptedFdmGpuRuntimeError("GPU resource pool publication was not accepted")
    discovery = published.get("discovery")
    resources = published.get("resources")
    if (
        not isinstance(discovery, dict)
        or discovery.get("gpu_status") != "available"
        or int(discovery.get("gpu_count", 0)) < 1
        or not isinstance(resources, list)
    ):
        raise AcceptedFdmGpuRuntimeError("local discovery did not prove an available GPU")
    offers = [
        item
        for item in resources
        if isinstance(item, dict) and item.get("kind") == "gpu"
    ]
    if not offers:
        raise AcceptedFdmGpuRuntimeError("local discovery published no GPU offer")
    for offer in offers:
        resource_id = str(offer.get("resource_id", ""))
        budget = offer.get("budget")
        if ".gpu.GPU-" not in resource_id or not isinstance(budget, dict):
            raise AcceptedFdmGpuRuntimeError(
                "GPU offer has no durable local NVIDIA UUID binding"
            )
        for key in ("cpu_millis", "memory_bytes", "gpu_memory_bytes", "storage_bytes"):
            if int(budget.get(key, -1)) < int(minimum[key]):
                raise AcceptedFdmGpuRuntimeError(
                    f"discovered GPU offer does not satisfy {key}"
                )
    return offers[0]


def execution_resolution(store_root: Path, run_id: str) -> dict[str, object]:
    metadata_paths = sorted(
        (store_root / "runs" / run_id / "worker-attempts").glob("**/metadata.json")
    )
    if len(metadata_paths) != 1:
        raise AcceptedFdmGpuRuntimeError(
            "accepted GPU proof requires exactly one private runner metadata artifact"
        )
    metadata_path = metadata_paths[0]
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    provenance = metadata.get("execution_provenance", {})
    resolution = provenance.get("execution_resolution", {})
    if (
        provenance.get("execution_engine") != "cuda_fdm"
        or resolution.get("effective_request", {}).get("backend") != "fdm"
        or resolution.get("effective_request", {}).get("device") != "gpu"
        or resolution.get("resolved_execution", {}).get("backend") != "fdm"
        or resolution.get("resolved_execution", {}).get("device") != "gpu"
        or resolution.get("resolved_execution", {}).get("precision") != "double"
        or resolution.get("resolution_mode") != "exact"
        or resolution.get("fallback_occurred") is not False
        or resolution.get("fallback_reason") is not None
    ):
        raise AcceptedFdmGpuRuntimeError(
            "runner metadata did not prove exact FDM GPU double execution without fallback"
        )
    return {
        "metadata_path": str(metadata_path),
        "metadata_sha256": sha256(metadata_path),
        "execution_engine": provenance["execution_engine"],
        "execution_resolution": resolution,
    }


def run(repo_root: Path) -> tuple[int, dict[str, object]]:
    if os.name != "nt":
        raise AcceptedFdmGpuRuntimeError("managed accepted FDM GPU runtime is Windows-only")
    layout = storage.resolve_layout(repo_root, PROFILE)
    storage.initialize(layout)
    with storage.build_lock(layout):
        invocation_id = uuid.uuid4().hex
        paths = contained_paths(layout, invocation_id)
        for key in (
            "run_root",
            "temp_root",
            "state_root",
            "target_dir",
            "cargo_home",
            "rustup_home",
        ):
            paths[key].mkdir(parents=True, exist_ok=True)
        receipt: dict[str, object] = {
            "schema": RECEIPT_SCHEMA,
            "route": "api-accepted-fdm-gpu-runtime",
            "profile": PROFILE,
            "invocation_id": invocation_id,
            "worktree_id": layout["worktree_id"],
            "repo_root": layout["repo_root"],
            "started_at": utc_now(),
            "state": "preflight",
            "paths": {key: str(value) for key, value in paths.items()},
            "runtime_scope": [
                "public HTTP v2 immutable RunSpec FDM GPU double strict submission",
                "local NVIDIA UUID resource discovery and durable GPU lease",
                "production scheduler, supervisor, and accepted worker processes",
                "exact CUDA worker binding through CUDA_VISIBLE_DEVICES",
                "final runner execution resolution with no CPU fallback",
                "worker-originated HeartbeatAck and exact lease release",
            ],
        }
        write_atomic_json(paths["receipt"], receipt)
        api_process: subprocess.Popen[bytes] | None = None
        api_log = None
        result_code = 2
        try:
            fixture, fixture_evidence = load_fixture(repo_root)
            run_id, idempotency_key, request = prepare_gpu_request(
                fixture, str(fixture_evidence["identity"])
            )
            expected_step_id = request["study_plan"]["steps"][0]["step_id"]
            request_path = paths["run_root"] / "accepted-fdm-gpu-request.json"
            write_atomic_json(request_path, request)
            minimum = request["run_intent"]["specification"]["requested_execution"][
                "minimum_resources"
            ]
            project_id = request["run_intent"]["specification"]["snapshot"]["project_id"]
            receipt["fixture"] = {
                **fixture_evidence,
                "request_path": str(request_path),
                "request_sha256": sha256(request_path),
                "run_id": run_id,
                "idempotency_key": idempotency_key,
                "requested_execution": request["run_intent"]["specification"][
                    "requested_execution"
                ],
            }

            identity = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_before"], identity)
            receipt["source_identity"] = identity
            toolchain, tools = toolchain_identity()
            receipt["toolchain"] = toolchain
            env = child_environment(layout, paths, tools, PROFILE)
            runtime_worktree_id = f"{layout['worktree_id']}-fdm-gpu-{invocation_id[:12]}"
            runtime_runs_root = storage.validate_path(
                Path(env["FULLMAG_PROJECT_STORAGE_ROOT"]) / "runs" / runtime_worktree_id,
                Path(env["FULLMAG_PROJECT_STORAGE_ROOT"]),
                "isolated accepted FDM GPU runs root",
            )
            runtime_runs_root.mkdir(parents=True, exist_ok=True)
            env.update(
                {
                    "FULLMAG_WORKTREE_ID": runtime_worktree_id,
                    "FULLMAG_RUNS_ROOT": str(runtime_runs_root),
                    "FULLMAG_SOURCE_GIT_COMMIT": str(identity["head_commit_full"]),
                    "FULLMAG_SOURCE_WORKTREE_STATE": (
                        "dirty" if identity["source_snapshot_dirty"] else "clean"
                    ),
                    "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(
                        identity["source_snapshot_sha256"]
                    ),
                    "FULLMAG_DISABLE_STATIC_CONTROL_ROOM": "1",
                    "FULLMAG_ACCEPTED_RUN_BACKLOG_LIMIT": "2",
                }
            )
            env.pop("FULLMAG_FDM_EXECUTION", None)
            store_root = runtime_runs_root / "session-store"

            receipt["state"] = "building"
            write_atomic_json(paths["receipt"], receipt)
            binaries, build_evidence = build_cuda_binaries(
                repo_root, layout, paths, env, identity
            )
            receipt["build"] = build_evidence
            env["PATH"] = str(paths["run_root"]) + os.pathsep + env.get("PATH", "")

            receipt["state"] = "submitting"
            write_atomic_json(paths["receipt"], receipt)
            api_process, api_log, base_url = start_api(
                binaries["fullmag-api"], repo_root, env, paths["api_submit_log"]
            )
            health = wait_for_health(base_url, api_process)
            _, openapi = json_request(f"{base_url}/v2/platform/openapi.json")
            build_identity = assert_build_identity(
                openapi,
                {
                    "git_commit": identity["head_commit_full"],
                    "source_snapshot_sha256": identity["source_snapshot_sha256"],
                    "worktree_state": "dirty" if identity["source_snapshot_dirty"] else "clean",
                },
            )
            cli_submit = run_json_process(
                [
                    str(binaries["fullmag"]),
                    "run-json",
                    str(request_path),
                    "--api-url",
                    base_url,
                ],
                cwd=repo_root,
                env=env,
                log_path=paths["run_root"] / "cli-submit-gpu.log",
                timeout=60,
            )
            submitted = cli_submit.get("submit", {})
            materialized = cli_submit.get("materialization", {})
            before = cli_submit.get("run", {}).get("body", {})
            tasks = before.get("tasks", [])
            if (
                cli_submit.get("operation") != "submit_accepted_run"
                or cli_submit.get("transport") != "public_http_v2"
                or cli_submit.get("run_id") != run_id
                or submitted.get("status") != 201
                or submitted.get("body", {}).get("disposition") != "accepted"
                or materialized.get("status") != 200
                or len(tasks) != 1
                or tasks[0].get("lifecycle") != "accepted"
            ):
                raise AcceptedFdmGpuRuntimeError(
                    "public accepted-run transport did not materialize one GPU task"
                )
            receipt["submit"] = {
                "health": health,
                "build_identity": build_identity,
                "cli": cli_submit,
            }
            receipt["api_submit_exit_code"] = terminate_process(api_process)
            api_process = None
            api_log.close()
            api_log = None

            pool_id = f"accepted-fdm-gpu-{invocation_id}"
            publisher = run_json_process(
                [
                    str(binaries["fullmag-api-resource-pool"]),
                    "--store-root",
                    str(store_root),
                    "--pool-id",
                    pool_id,
                    "--expected-generation",
                    "0",
                    "--discover-local",
                    "true",
                    "--host-resource-id",
                    f"fdm-gpu-{invocation_id[:20]}",
                    "--include-cpu",
                    "false",
                    "--require-gpu",
                    "true",
                    "--cpu-reserve-millis",
                    "1000",
                    "--memory-reserve-bytes",
                    "536870912",
                    "--storage-reserve-bytes",
                    "536870912",
                ],
                cwd=repo_root,
                env=env,
                log_path=paths["publisher_log"],
                timeout=30,
            )
            gpu_offer = validate_gpu_offer(publisher, minimum)
            receipt["resource_pool"] = publisher

            receipt["state"] = "executing"
            write_atomic_json(paths["receipt"], receipt)
            scheduler = run_json_process(
                [
                    str(binaries["fullmag-api-accepted-scheduler"]),
                    "--store-root",
                    str(store_root),
                    "--run-id",
                    run_id,
                    "--pool-id",
                    pool_id,
                    "--resident",
                    "true",
                    "--discover-resources",
                    "true",
                    "--worker-executable",
                    str(binaries["fullmag-api-accepted-worker"]),
                    "--max-concurrency",
                    "1",
                    "--max-queued-runs",
                    "1",
                    "--max-tasks",
                    "1",
                    "--max-idle-polls",
                    "0",
                    "--idle-poll-milliseconds",
                    "20",
                    "--worker-timeout-seconds",
                    "120",
                    "--heartbeat-interval-milliseconds",
                    "250",
                    "--max-automatic-retries",
                    "0",
                ],
                cwd=repo_root,
                env=env,
                log_path=paths["scheduler_log"],
                timeout=180,
            )
            executed = scheduler.get("executed", [])
            if (
                scheduler.get("status") != "completed"
                or scheduler.get("scheduled_count") != 1
                or len(executed) != 1
                or executed[0].get("run_id") != run_id
                or executed[0].get("resource_id") != gpu_offer["resource_id"]
                or executed[0].get("worker", {}).get("status") != "completed"
            ):
                raise AcceptedFdmGpuRuntimeError(
                    "scheduler did not complete one accepted task on the discovered GPU"
                )
            receipt["scheduler"] = scheduler

            leases = durable_leases(store_root, run_id)
            if (
                len(leases) != 1
                or leases[0].get("kind") != "gpu"
                or leases[0].get("resource_id") != gpu_offer["resource_id"]
                or leases[0].get("state") != "released"
                or leases[0].get("released_at") is None
            ):
                raise AcceptedFdmGpuRuntimeError(
                    "accepted GPU task did not release its exact durable GPU lease"
                )
            receipt["resource_leases"] = leases
            receipt["worker_control"] = worker_control_evidence(
                store_root, run_id, leases[0]
            )
            receipt["execution"] = execution_resolution(store_root, run_id)

            api_process, api_log, result_url = start_api(
                binaries["fullmag-api"], repo_root, env, paths["api_result_log"]
            )
            wait_for_health(result_url, api_process)
            _, after = json_request(
                f"{result_url}/v2/persistence/projects/{project_id}/runs/{run_id}"
            )
            after_tasks = after.get("tasks", [])
            accepted_state_ref = (
                after_tasks[0].get("accepted_state_ref") if len(after_tasks) == 1 else None
            )
            if (
                after.get("requested_execution", {}).get("device") != "gpu"
                or after.get("requested_execution", {}).get("minimum_resources") != minimum
                or len(after_tasks) != 1
                or after_tasks[0].get("lifecycle") != "succeeded"
                or not isinstance(accepted_state_ref, dict)
                or accepted_state_ref.get("id", {}).get("run_id") != run_id
                or accepted_state_ref.get("id", {}).get("stage_id")
                != expected_step_id
                or accepted_state_ref.get("generation", {}).get("runtime_epoch")
                != leases[0].get("ownership_epoch")
            ):
                raise AcceptedFdmGpuRuntimeError(
                    "public run projection did not expose the successful immutable GPU accepted state"
                )
            receipt["run"] = after
            receipt["api_result_exit_code"] = terminate_process(api_process)
            api_process = None
            api_log.close()
            api_log = None

            identity_after = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_after"], identity_after)
            receipt["source_identity_after"] = identity_after
            receipt["source_changed_during_run"] = (
                identity_after["source_snapshot_sha256"]
                != identity["source_snapshot_sha256"]
            )
            if receipt["source_changed_during_run"]:
                raise AcceptedFdmGpuRuntimeError(
                    "source identity changed during accepted GPU runtime verification"
                )
            receipt["state"] = "passed"
            result_code = 0
        except BaseException as error:
            receipt["state"] = "failed"
            receipt["error"] = f"{type(error).__name__}: {error}"
            result_code = 1
        finally:
            if api_process is not None:
                receipt["api_cleanup_exit_code"] = terminate_process(api_process)
            if api_log is not None:
                api_log.close()
            receipt["finished_at"] = utc_now()
            receipt["exit_code"] = result_code
            write_atomic_json(paths["receipt"], receipt)
        print(
            json.dumps(
                {
                    "receipt": str(paths["receipt"]),
                    "state": receipt["state"],
                    "error": receipt.get("error"),
                },
                ensure_ascii=False,
            )
        )
        return result_code, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        return run(args.repo_root.resolve())[0]
    except Exception as error:
        print(
            f"accepted FDM GPU runtime failed before receipt: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
