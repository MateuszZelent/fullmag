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
ROUTES = ("generate-client", "production-source", "api-hygiene", "lint", "openapi-import-check", "react-doctor", "development-restart-check")


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def fingerprint(repo: Path, generating: bool):
    app = repo / "apps/control-room"
    files = [repo / "scripts/verify_control_room_sources.py", app / "package.json", app / "tsconfig.json", app / "tsconfig.typecheck.json", app / "typecheck-env.d.ts"]
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


def run(repo: Path, route: str):
    layout = storage.resolve_layout(repo, PROFILE)
    storage.initialize(layout)
    with storage.build_lock(layout):
        app = repo / "apps/control-room"
        dependencies = app / "node_modules"
        if not dependencies.is_dir():
            raise storage.StorageError("Frontend dependencies are missing; this source route does not install packages")
        real_dependencies = dependencies.resolve()
        registered_dependencies = storage.inside(real_dependencies, Path(layout["frontend_root"]).resolve())
        # Existing dependencies of this exact checkout may be read without
        # copying, installing or rebinding them. All new mutable outputs still
        # belong to the managed run; this never admits an unrelated checkout.
        existing_local_dependencies = real_dependencies == app.resolve() / "node_modules"
        if not registered_dependencies and not existing_local_dependencies:
            raise storage.StorageError("Frontend dependencies belong to neither the registered frontend root nor this exact checkout")
        dependency_mode = "registered_frontend" if registered_dependencies else "existing_worktree_read_only"
        node = shutil.which("node")
        if not node:
            raise storage.StorageError("Node.js is unavailable")
        run_root = storage.validate_path(Path(layout["build_root"]) / route / uuid.uuid4().hex, layout["build_storage_root"], "frontend source run")
        run_root.mkdir(parents=True)
        receipt_path = run_root / "receipt.json"
        log_path = run_root / "source.log"
        env = {**os.environ, **layout["env"]}
        env["FULLMAG_FRONTEND_SOURCE_RUN_ROOT"] = str(run_root)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        before = fingerprint(repo, route == "generate-client")
        receipt = {"dependency_mode": dependency_mode, "dependency_root": str(real_dependencies), "node": node, "schema": "fullmag_control_room_sources_v1", "route": route, "head": head, "started_at": timestamp(), "state": "running", "source_digest_before": before, "qualification": "not_assessed", "unit_tests": "not_compiled_not_run", "log": str(log_path)}
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
            elif route == "api-hygiene":
                commands = [[node, "scripts/check-api-hygiene.mjs"]]
            elif route == "lint":
                commands = [cli("eslint", "bin/eslint.js") + [".", "--max-warnings=0"]]
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
            after = fingerprint(repo, route == "generate-client")
            receipt.update(source_digest_after=after, source_changed_during_run=before != after, exit_code=return_code)
            receipt["state"] = "passed" if return_code == 0 and before == after else "failed"
            if route == "generate-client" and return_code == 0:
                output = app / "src/kernel/api/generated"
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
    args = parser.parse_args()
    try:
        return run(Path(args.repo_root).resolve(), args.route)
    except (storage.StorageError, OSError, ValueError) as error:
        print(f"[control-room source] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
