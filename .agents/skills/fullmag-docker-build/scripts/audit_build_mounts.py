"""Read-only partial audit of rendered Fullmag Compose build mounts."""
import argparse
import json
from pathlib import PurePosixPath
import re
import sys


BUILD_PATHS = {
    "backend": ("/build", "/opt/fullmag/package"),
    "frontend": ("/state/development",),
}
RUNTIME_BINDS = {"backend": {"/state", "/user-data", "/host-ledger"}, "frontend": set()}
WRITE_ENV = (
    "HOME", "XDG_CACHE_HOME", "CARGO_HOME", "CARGO_TARGET_DIR",
    "FULLMAG_CARGO_TARGET_DIR", "PNPM_HOME", "COREPACK_HOME", "PIP_CACHE_DIR",
    "UV_CACHE_DIR", "CUDA_CACHE_PATH", "SCCACHE_DIR", "CCACHE_DIR",
    "PLAYWRIGHT_BROWSERS_PATH",
    "NPM_CONFIG_CACHE", "npm_config_cache", "npm_config_store_dir",
    "FULLMAG_BUILD_ROOT", "FULLMAG_BACKEND_BUILD_STATE_ROOT",
    "FULLMAG_RUNNER_WORKSPACE",
)
TEMP_ENV = ("TMPDIR", "TEMP", "TMP")
LIVE_INPUTS = ("app", "src", "public", "scripts")


def normalized_target(value):
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("mount target must be an absolute container path")
    if ".." in PurePosixPath(value).parts:
        raise ValueError("mount target contains parent traversal")
    return str(PurePosixPath(value))


def covers(target, path):
    return target == path or target == "/" or path.startswith(target + "/")


def audit(document, expected_project):
    problems = []
    if not isinstance(document, dict):
        raise ValueError("Compose document must be an object")
    if document.get("name") != expected_project:
        problems.append("Compose project does not match the selected checkout")
    services = document.get("services")
    if not isinstance(services, dict):
        raise ValueError("Compose services must be an object")
    definitions = document.get("volumes") or {}
    if not isinstance(definitions, dict):
        raise ValueError("Compose volume definitions must be an object")
    sources = []
    for role, paths in BUILD_PATHS.items():
        service = services.get(role)
        if not isinstance(service, dict):
            problems.append(f"missing application service: {role}")
            continue
        if service.get("read_only") is not True:
            problems.append(f"{role}: mutable container root is outside the persistent build-volume contract")
        environment = service.get("environment") or {}
        if not isinstance(environment, dict):
            raise ValueError("use rendered Compose JSON with an environment object")
        if role == "backend":
            provenance = environment.get("FULLMAG_PACKAGE_PROVENANCE") or "/opt/fullmag/provenance.json"
            paths = (*paths, normalized_target(provenance))
        mounts = []
        declared_mounts = list(service.get("volumes", []))
        # Compose has a separate service-level tmpfs field, absent from volumes.
        tmpfs = service.get("tmpfs", [])
        if isinstance(tmpfs, str):
            tmpfs = [tmpfs]
        if not isinstance(tmpfs, list) or any(not isinstance(value, str) for value in tmpfs):
            raise ValueError("use normalized Compose tmpfs entries")
        for value in tmpfs:
            target, _, options = value.partition(":")
            bounded = re.search(r"(?:^|,)size=[1-9][0-9]*[kKmMgG]?(?:,|$)", options)
            if not bounded:
                problems.append(f"{role}: tmpfs needs an explicit positive size bound: {target}")
            declared_mounts.append({"type": "tmpfs", "target": target, "bounded_tmpfs": bool(bounded)})
        seen_targets = set()
        for item in declared_mounts:
            if not isinstance(item, dict):
                raise ValueError("use rendered Compose JSON with normalized mount objects")
            target = normalized_target(item.get("target"))
            if item.get("type") == "tmpfs" and "bounded_tmpfs" not in item:
                size = (item.get("tmpfs") or {}).get("size")
                if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
                    problems.append(f"{role}: tmpfs needs an explicit positive byte size: {target}")
            if target in seen_targets:
                problems.append(f"{role}: ambiguous duplicate mount target: {target}")
            seen_targets.add(target)
            mounts.append((target, item))
            if item.get("type") == "volume" and item.get("source"):
                definition = definitions.get(item["source"])
                if definition is None:
                    problems.append(f"{role}: volume identity is not declared: {item['source']}")
                elif not isinstance(definition, dict):
                    raise ValueError("use normalized Compose volume definitions")
                elif definition.get("driver_opts") or definition.get("driver", "local") != "local":
                    problems.append(f"{role}: volume may map external storage via driver/options: {item['source']}")
            if item.get("type") == "bind" and item.get("read_only") is not True:
                if target not in RUNTIME_BINDS[role]:
                    problems.append(f"{role}: writable host bind at {target}")
            if any(covers(path, target) for path in paths):
                live_name = target.removeprefix("/state/development/workspace/apps/control-room/")
                source_root = next((m.get("source") for m in declared_mounts
                                    if isinstance(m, dict) and m.get("target") == "/opt/fullmag/source"), None)
                expected_input = str(source_root).replace("\\", "/").rstrip("/") + "/apps/control-room/" + live_name
                source_input = (role == "frontend" and live_name in LIVE_INPUTS
                                and item.get("type") == "bind" and item.get("read_only") is True
                                and str(item.get("source")).replace("\\", "/") == expected_input)
                if item.get("type") != "volume" and not source_input:
                    problems.append(f"{role}: non-volume mount overlays a build directory: {target}")
                if item.get("type") == "volume" and any(target != path and covers(path, target) for path in BUILD_PATHS[role]):
                    problems.append(f"{role}: nested build volume requires a separate ownership/retention review: {target}")
        # Explicit write overrides must not route technical cache into a runtime
        # bind. Defaults, image ENV, entrypoint overrides and symlinks still need
        # live inspection; absence here does not certify them.
        for name in (*WRITE_ENV, *TEMP_ENV):
            if name in environment and environment[name] not in (None, ""):
                path = normalized_target(environment[name])
                matching = [(target, item) for target, item in mounts if covers(target, path)]
                mount = max(matching, key=lambda pair: len(pair[0]))[1] if matching else {}
                temporary = name in TEMP_ENV and mount.get("type") == "tmpfs"
                if not temporary and (mount.get("type") != "volume" or mount.get("read_only") is True or not mount.get("source")):
                    problems.append(f"{role}: configured write path {name} is outside a writable named volume: {path}")
        if environment.get("RUSTUP_HOME"):
            path = normalized_target(environment["RUSTUP_HOME"])
            matching = [(target, item) for target, item in mounts if covers(target, path)]
            mount = max(matching, key=lambda pair: len(pair[0]))[1] if matching else {}
            # A pinned Rust toolchain may legitimately reside in the readonly
            # image; writable host Rustup is never build-data confinement.
            if mount.get("type") == "bind" and mount.get("read_only") is not True:
                problems.append(f"{role}: RUSTUP_HOME uses writable host storage: {path}")
        for path in paths:
            matching = [(target, item) for target, item in mounts if covers(target, path)]
            if not matching:
                problems.append(f"{role}: build path has no persistent Docker volume: {path}")
                continue
            target, mount = max(matching, key=lambda pair: len(pair[0]))
            if mount.get("type") != "volume" or mount.get("read_only") is True:
                problems.append(f"{role}: build path is not in a writable Docker volume: {path} (mount {target})")
            elif not mount.get("source"):
                problems.append(f"{role}: anonymous volume does not provide an explicit cache identity: {path}")
        source = [item for target, item in mounts if target == "/opt/fullmag/source"]
        if len(source) != 1 or source[0].get("type") != "bind" or source[0].get("read_only") is not True:
            problems.append(f"{role}: selected source must be one readonly bind")
        else:
            sources.append(source[0].get("source"))
    if len(sources) == 2 and (not sources[0] or sources[0] != sources[1]):
        problems.append("frontend and backend source checkout differs")
    return {
        "status": "FAIL" if problems else "PASS",
        "build_data_qualification": "NOT VERIFIED",
        "scope": "rendered application mount topology only; not a build or retention qualification",
        "problems": problems,
        "still_required": [
            "review host launcher writes and BuildKit staging",
            "verify exact volume ownership and driver using Docker inspect, including external volumes",
            "review command, entrypoint, image ENV, symlinks and all effective writer paths",
            "inspect actual mounts, effective compiler and log paths",
            "measure allocation and verify retention after real builds",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("compose_json", help="rendered Compose JSON file, or - for stdin")
    parser.add_argument("--expected-project", required=True)
    args = parser.parse_args()
    try:
        if args.compose_json == "-":
            document = json.load(sys.stdin)
        else:
            with open(args.compose_json, encoding="utf-8-sig") as source:
                document = json.load(source)
        result = audit(document, args.expected_project)
    except (OSError, ValueError, TypeError) as error:
        print(json.dumps({"status": "INVALID", "error": str(error)}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return int(result["status"] != "PASS")


if __name__ == "__main__":
    raise SystemExit(main())
