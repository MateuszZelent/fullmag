"""Fixed lightweight frontend source routes with managed paths and receipts.

These routes cannot build Next, Rust, native solvers or unit-test bundles.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
import fullmag_storage as storage

PROFILE = "windows-control-room-source-check"
GENERATED_OUTPUTS = ("openapi-v2-types.ts", "openapi-v2-client.ts", "openapi-v2-paths.ts")
ROUTES = ("generate-client", "production-source", "api-hygiene", "lint", "openapi-import-check", "react-doctor", "development-restart-check", "resource-client-cache-check", "development-kernel-host-check", "development-transport-pause-check", "development-run-outcome-handoff-check", "development-run-outcome-handoff-lint", "development-restart-action-check", "development-restart-action-lint")


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def fingerprint(repo: Path, generating: bool):
    app = repo / "apps/control-room"
    files = [repo / "scripts/verify_control_room_sources.py", repo / "scripts/frontend_source_workspace.py", app / "package.json", app / "tsconfig.json", app / "tsconfig.typecheck.json", app / "typecheck-env.d.ts"]
    # Include root configuration, declaration modules and reused Next typegen.
    # Prune dependency/output directories rather than walking node_modules.
    for directory, children, names in os.walk(app):
        children[:] = [name for name in children if name not in ("node_modules", "out", "build", "storybook-static", "target-host", ".fullmag") and not (name.startswith(".next") and name != ".next")]
        if Path(directory) == app / ".next":
            children[:] = [name for name in children if name == "types"]
        for name in names:
            path = Path(directory) / name
            if path.suffix in (".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".json", ".css") and (not storage.inside(path, app / ".next") or storage.inside(path, app / ".next/types")):
                files.append(path)
    outputs = {"openapi-v2-types.ts", "openapi-v2-client.ts", "openapi-v2-paths.ts"}
    digest = hashlib.sha256()
    for path in sorted(set(files)):
        if generating and path.parent == app / "src/kernel/api/generated" and path.name in outputs:
            continue
        if path.exists():
            digest.update(path.relative_to(repo).as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def generated_output_state(repo):
    output = Path(repo) / "apps/control-room/src/kernel/api/generated"
    result = {}
    for name in GENERATED_OUTPUTS:
        path = storage.validate_path(output / name, repo, "generated output")
        if path.exists() and not path.is_file():
            raise storage.StorageError(f"Generated output must be a regular file: {name}")
        result[name] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    return result


def publish_generated_outputs(repo, staged_app, expected):
    # The caller holds the worktree lock, serializing cooperating publishers.
    # Check editor changes optimistically after preparation and before replace.
    data = {}
    for name in GENERATED_OUTPUTS:
        source = storage.validate_path(Path(staged_app) / "src/kernel/api/generated" / name,
                                       staged_app, "staged generated output")
        if not source.is_file():
            raise storage.StorageError(f"Generator did not produce {name}")
        data[name] = source.read_bytes()
    prepared = []
    try:
        for name, value in data.items():
            target = storage.validate_path(Path(repo) / "apps/control-room/src/kernel/api/generated" / name,
                                           repo, "generated output")
            temporary = target.with_name(f".{name}.{uuid.uuid4().hex}.tmp")
            with temporary.open("xb") as output:
                prepared.append((name, temporary, target))
                output.write(value)
        expected_now = dict(expected)
        for name, temporary, target in prepared:
            if generated_output_state(repo) != expected_now:
                raise storage.StorageError("Generated API outputs changed during publication")
            os.replace(temporary, target)
            expected_now[name] = hashlib.sha256(data[name]).hexdigest()
    finally:
        for _, temporary, _ in prepared:
            if temporary.exists():
                temporary.unlink()  # Only this invocation's unpublished output.


def run(repo: Path, route: str, dependency_workspace: Path | None = None):
    layout = storage.resolve_layout(repo, PROFILE)
    storage.initialize(layout)
    with storage.build_lock(layout):
        app = repo / "apps/control-room"
        before = fingerprint(repo, route == "generate-client")
        output_before = generated_output_state(repo) if route == "generate-client" else None
        run_root = storage.validate_path(Path(layout["build_root"]) / route / uuid.uuid4().hex,
                                         layout["build_storage_root"], "frontend source run")
        run_root.mkdir(parents=True)
        workspace_evidence = {}
        if dependency_workspace is not None:
            if route not in {"generate-client", "production-source", "api-hygiene"}:
                raise storage.StorageError("Native dependency workspace is supported only for API generation and production source checks")
            from frontend_source_workspace import prepare_source_workspace, validate_dependency_workspace
            dependency_before = validate_dependency_workspace(repo, layout, dependency_workspace)
            prepared = prepare_source_workspace(repo, layout, run_root, dependency_workspace)
            app = prepared["app"]
            dependencies = prepared["dependencies"]
            dependency_mode = prepared["dependency_mode"]
            workspace_evidence = {key: str(value) if isinstance(value, Path) else value for key, value in prepared.items()
                                  if key not in {"app", "dependencies", "dependency_mode"}}
        else:
            dependencies = app / "node_modules"
            if not dependencies.is_dir():
                raise storage.StorageError("Frontend dependencies are missing; this source route does not install packages")
            real = dependencies.resolve()
            registered = storage.inside(real, Path(layout["frontend_root"]).resolve())
            local = real == app.resolve() / "node_modules"
            if not registered and not local:
                raise storage.StorageError("Frontend dependencies belong to neither the registered frontend root nor this exact checkout")
            dependency_mode = "registered_frontend" if registered else "existing_worktree_read_only"
        real_dependencies = dependencies.resolve()
        node = shutil.which("node")
        if not node:
            raise storage.StorageError("Node.js is unavailable")
        receipt_path = run_root / "receipt.json"
        log_path = run_root / "source.log"
        env = {**os.environ, **layout["env"]}
        env["FULLMAG_FRONTEND_SOURCE_RUN_ROOT"] = str(run_root)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        receipt = {"dependency_mode": dependency_mode, "dependency_root": str(real_dependencies), "node": node, "schema": "fullmag_control_room_sources_v1", "route": route, "head": head, "started_at": timestamp(), "state": "running", "source_digest_before": before, "qualification": "not_assessed", "unit_tests": "not_compiled_not_run", "log": str(log_path)}
        receipt["source_workspace"] = workspace_evidence
        storage.atomic_json(receipt_path, receipt)
        try:
            def cli(package, relative):
                path = dependencies / package / relative
                if not path.is_file():
                    raise storage.StorageError(f"Required frontend tool is missing: {package}")
                return [node, str(path)]
            if route == "generate-client":
                commands = [cli("openapi-typescript", "bin/cli.js") + ["src/kernel/api/generated/openapi-v2.json", "--output", "src/kernel/api/generated/openapi-v2-types.ts"], [node, "scripts/generate-v2-client.mjs"]]
            elif route == "openapi-import-check":
                commands = [[node, "--test", "scripts/normalize-openapi-build-identity.node-test.mjs", "scripts/managed-openapi-import.node-test.mjs"]]
                receipt["interpreted_node_checks"] = True
                receipt["unit_tests"] = "interpreted_node_only_no_compilation"
            elif route == "development-restart-check":
                commands = [[node, "--experimental-vm-modules", "scripts/check-development-restart-controller.mjs"]]
                receipt["interpreted_node_checks"] = True
                receipt["unit_tests"] = "none_native_type_erasure_of_production_source_only"
            elif route == "resource-client-cache-check":
                commands = [[node, "--experimental-vm-modules", "scripts/check-resource-client-cache-scope.mjs"]]
                receipt["interpreted_node_checks"] = True
                receipt["unit_tests"] = "none_native_type_erasure_of_production_source_only"
            elif route in {"development-kernel-host-check", "development-transport-pause-check", "development-run-outcome-handoff-check", "development-restart-action-check"}:
                check = {"development-kernel-host-check": "check-development-kernel-host.mjs", "development-transport-pause-check": "check-development-transport-pause.mjs", "development-run-outcome-handoff-check": "check-development-run-outcome-handoff.mjs", "development-restart-action-check": "check-development-restart-action.mjs"}[route]
                commands = [[node, "--experimental-vm-modules", "scripts/" + check]]
                receipt["interpreted_node_checks"] = True
                receipt["unit_tests"] = "none_native_type_erasure_of_production_source_only"
                if route == "development-run-outcome-handoff-check":
                    receipt["unit_tests"] = "none_interpreted_js_driver_no_unit_build"
                    receipt["production_source_transform"] = "in_memory_parameter_property_support"
            elif route == "api-hygiene":
                commands = [[node, "scripts/check-api-hygiene.mjs"]]
            elif route == "lint":
                commands = [cli("eslint", "bin/eslint.js") + [".", "--max-warnings=0"]]
            elif route == "development-run-outcome-handoff-lint":
                checked_files = [
                    "src/kernel/KernelProvider.tsx",
                    "src/kernel/persistence/ProjectDocumentController.ts",
                    "src/kernel/persistence/RunOutcomeConnector.tsx",
                    "scripts/check-development-run-outcome-handoff.mjs",
                    "scripts/fixtures/development-run-outcome-handoff-page.tsx",
                    "scripts/smoke-development-run-outcome-handoff.mjs",
                ]
                commands = [cli("eslint", "bin/eslint.js") + checked_files + ["--max-warnings=0"]]
                receipt["lint_scope"] = "development_run_outcome_handoff_only"
                receipt["checked_files"] = checked_files
            elif route == "development-restart-action-lint":
                checked_files = [
                    "src/kernel/development/DevelopmentRestartActionService.ts",
                    "src/kernel/development/DevelopmentKernelHost.ts",
                    "src/kernel/development/DevelopmentKernelOwners.ts",
                    "src/kernel/development/DevelopmentRestartController.ts",
                    "src/kernel/layout/DevelopmentBackendBanner.tsx",
                    "scripts/check-development-restart-action.mjs",
                    "scripts/check-development-kernel-host.mjs",
                    "scripts/check-development-restart-controller.mjs",
                    "scripts/fixtures/development-restart-action-page.tsx",
                    "scripts/smoke-development-restart-action.mjs",
                ]
                commands = [cli("eslint", "bin/eslint.js") + checked_files + ["--max-warnings=0"]]
                receipt["lint_scope"] = "development_restart_action_only"
                receipt["checked_files"] = checked_files
            elif route == "react-doctor":
                # Reuse the repository-pinned tool without installing or
                # contacting the score/supply-chain services. Dumps and caches
                # inherit the managed storage environment of this source run.
                doctor = repo / "node_modules/react-doctor/bin/react-doctor.js"
                if not doctor.is_file():
                    raise storage.StorageError("Repository-pinned React Doctor is unavailable")
                env["NODE_DISABLE_COMPILE_CACHE"] = "1"
                commands = [[node, str(doctor), ".", "--verbose", "--scope", "changed",
                             "--base", "HEAD", "--no-score", "--no-supply-chain",
                             "--no-dead-code", "--no-parallel", "--yes",
                             "--output-dir", str(run_root / "diagnostics")]]
                receipt["scope"] = "changed_against_HEAD"
                receipt["online_services"] = "disabled_score_and_supply_chain"
            else:
                # This is source checking, not compilation of test targets. UI
                # route generation is unchanged and existing typegen is reused.
                config = run_root / "tsconfig.production.json"
                exclude = ["node_modules", "out", ".next/dev", "**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/__tests__/**"]
                config.write_text(json.dumps({"extends": str(app / "tsconfig.typecheck.json"), "compilerOptions": {"noEmit": True, "incremental": False}, "exclude": [(app / pattern).as_posix() for pattern in exclude]}, indent=2), encoding="utf-8")
                commands = [cli("typescript", "bin/tsc") + ["--noEmit", "--project", str(config)]]
                receipt["test_exclusions"] = exclude
            receipt["steps"] = []
            return_code = 0
            with log_path.open("w", encoding="utf-8") as log:
                for command in commands:
                    result = subprocess.run(command, cwd=app, env=env, stdout=log, stderr=subprocess.STDOUT, text=True, encoding="utf-8", check=False)
                    receipt["steps"].append({"tool": Path(command[1]).name, "exit_code": result.returncode})
                    if result.returncode:
                        return_code = result.returncode
                        break
            if dependency_workspace is not None:
                dependency_after = validate_dependency_workspace(repo, layout, dependency_workspace)
                if dependency_before != dependency_after:
                    raise storage.StorageError("Native workspace dependency identity changed during the source run")
            after = fingerprint(repo, route == "generate-client")
            receipt.update(source_digest_after=after, source_changed_during_run=before != after, exit_code=return_code)
            receipt["state"] = "passed" if return_code == 0 and before == after else "failed"
            if route == "generate-client" and return_code == 0 and before == after:
                if dependency_workspace is not None:
                    publish_generated_outputs(repo, app, output_before)
                output = repo / "apps/control-room" / "src/kernel/api/generated"
                receipt["generated_artifacts"] = [{"path": str(output / name), "sha256": hashlib.sha256((output / name).read_bytes()).hexdigest()} for name in ("openapi-v2-types.ts", "openapi-v2-client.ts", "openapi-v2-paths.ts")]
            return 0 if receipt["state"] == "passed" else (return_code or 1)
        except BaseException as error:
            receipt.update(state="failed", error=str(error))
            raise
        finally:
            receipt["finished_at"] = timestamp()
            storage.atomic_json(receipt_path, receipt)
            print(json.dumps({"receipt": str(receipt_path), "log": str(log_path), "state": receipt["state"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--route", choices=ROUTES, required=True)
    parser.add_argument("--dependency-workspace", type=Path, help="Existing same-checkout native launcher workspace; read-only dependencies")
    args = parser.parse_args()
    try:
        return run(Path(args.repo_root).resolve(), args.route, args.dependency_workspace)
    except (storage.StorageError, OSError, ValueError) as error:
        print(f"[control-room source] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
