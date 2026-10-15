#!/usr/bin/env python3
"""Report the pinned FEM/GPU Docker dependency contract.

The Dockerfile is the only version authority.  The report reuses the existing
``fullmag.docker.fem-gpu-dependencies.v1`` declared/actual manifest shape and
never treats a declared pin or an upstream latest release as qualification.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

REPORT_SCHEMA = "fullmag.docker_dependency_report.v1"
MANIFEST_SCHEMA = "fullmag.docker.fem-gpu-dependencies.v1"
PARSER_VERSION = "docker-arg-env-run-v2"
DEFAULT_DOCKERFILE = Path(__file__).resolve().parents[1] / "docker" / "fem-gpu" / "Dockerfile"

# This is schema vocabulary only.  No version or commit is duplicated here;
# all values are read from Dockerfile ARG/ENV/RUN instructions.
_SOURCE_SPECS = (
    ("mfem", "MFEM_REF", "MFEM_SOURCE_COMMIT", False),
    ("libceed", "LIBCEED_REF", "LIBCEED_SOURCE_COMMIT", False),
    ("hypre", "HYPRE_REF", "HYPRE_SOURCE_COMMIT", False),
    ("petsc", "PETSC_REF", "PETSC_SOURCE_COMMIT", False),
    ("slepc", "SLEPC_REF", "SLEPC_SOURCE_COMMIT", False),
    ("umpire", "UMPIRE_REF", "UMPIRE_SOURCE_COMMIT", True),
)
_SOURCE_NAMES = tuple(spec[0] for spec in _SOURCE_SPECS)
_TOOL_NAMES = ("cmake", "node", "python", "pnpm", "rust")

# Official upstream endpoints used only by --check-updates.  Failure is
# represented in the report and never changes the Dockerfile or manifest.
_UPDATE_SOURCES: dict[str, dict[str, str]] = {
    "mfem": {
        "kind": "github_release",
        "url": "https://api.github.com/repos/mfem/mfem/releases/latest",
    },
    "libceed": {
        "kind": "github_release",
        "url": "https://api.github.com/repos/CEED/libCEED/releases/latest",
    },
    "hypre": {
        "kind": "github_release",
        "url": "https://api.github.com/repos/hypre-space/hypre/releases/latest",
    },
    "petsc": {
        "kind": "gitlab_releases",
        "url": "https://gitlab.com/api/v4/projects/petsc%2Fpetsc/releases?per_page=20",
        "fallback_kind": "gitlab_tags",
        "fallback_url": "https://gitlab.com/api/v4/projects/petsc%2Fpetsc/repository/tags?per_page=100",
    },
    "slepc": {
        "kind": "gitlab_releases",
        "url": "https://gitlab.com/api/v4/projects/slepc%2Fslepc/releases?per_page=20",
        "fallback_kind": "gitlab_tags",
        "fallback_url": "https://gitlab.com/api/v4/projects/slepc%2Fslepc/repository/tags?per_page=100",
    },
    "cmake": {
        "kind": "github_release",
        "url": "https://api.github.com/repos/Kitware/CMake/releases/latest",
    },
    "node": {
        "kind": "node_dist",
        "url": "https://nodejs.org/dist/index.json",
    },
    "python": {
        "kind": "github_tags",
        "url": "https://api.github.com/repos/python/cpython/tags?per_page=100",
    },
    "pnpm": {
        "kind": "github_release",
        "url": "https://api.github.com/repos/pnpm/pnpm/releases/latest",
    },
    "umpire": {
        "kind": "github_release",
        "url": "https://api.github.com/repos/LLNL/Umpire/releases/latest",
    },
}
_RUST_STABLE_URL = "https://static.rust-lang.org/dist/channel-rust-stable.toml"
MAX_RESPONSE_BYTES = 2_000_000
MAX_TIMEOUT_SECONDS = 30.0


class ReportError(ValueError):
    """Input or Dockerfile contract error."""


def _logical_lines(text: str) -> Iterable[str]:
    pending = ""
    for physical in text.splitlines():
        line = physical.rstrip()
        if not pending and not line.strip():
            continue
        if not pending and line.lstrip().startswith("#"):
            continue
        if line.endswith("\\"):
            pending += line[:-1] + " "
            continue
        logical = pending + line
        pending = ""
        if logical.strip() and not logical.lstrip().startswith("#"):
            yield logical.strip()
    if pending.strip():
        raise ReportError("Dockerfile ends with an unfinished continuation")


def _strip_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _assignment(token: str) -> tuple[str, str | None]:
    if "=" in token:
        name, value = token.split("=", 1)
        return name.strip(), _strip_value(value)
    return token.strip(), None


def _parse_env(rest: str) -> dict[str, str]:
    try:
        tokens = shlex.split(rest, posix=True)
    except ValueError as exc:
        raise ReportError(f"invalid ENV instruction: {rest!r}") from exc
    if not tokens:
        return {}
    if "=" not in tokens[0] and len(tokens) == 2:
        return {tokens[0]: tokens[1]}
    values: dict[str, str] = {}
    for token in tokens:
        name, value = _assignment(token)
        if value is None:
            raise ReportError(f"ENV assignment lacks a value: {token!r}")
        values[name] = value
    return values


def parse_dockerfile(text: str) -> dict[str, Any]:
    args: dict[str, list[str | None]] = {}
    env: dict[str, list[str]] = {}
    runs: list[str] = []
    for instruction in _logical_lines(text):
        parts = instruction.split(None, 1)
        if len(parts) != 2:
            continue
        keyword, rest = parts[0].upper(), parts[1].strip()
        if keyword == "ARG":
            name, value = _assignment(rest)
            if not name:
                raise ReportError(f"ARG lacks a name: {instruction!r}")
            args.setdefault(name, []).append(value)
        elif keyword == "ENV":
            for name, value in _parse_env(rest).items():
                env.setdefault(name, []).append(value)
        elif keyword == "RUN":
            runs.append(rest)
    return {"args": args, "env": env, "runs": runs}


def _unique(values: Sequence[str | None], name: str) -> str | None:
    present = [value for value in values if value is not None]
    if not present:
        return None
    if len(set(present)) != 1:
        raise ReportError(f"conflicting Dockerfile declarations for {name}: {present!r}")
    return present[0]


def _arg(parsed: Mapping[str, Any], name: str) -> str | None:
    return _unique(parsed["args"].get(name, []), name)


def _env(parsed: Mapping[str, Any], name: str) -> str | None:
    return _unique(parsed["env"].get(name, []), name)


def _expand(value: str | None, parsed: Mapping[str, Any]) -> str | None:
    if value is None:
        return None

    def replace(match: re.Match[str]) -> str:
        name = match.group(1) or match.group(2)
        return _arg(parsed, name) or _env(parsed, name) or match.group(0)

    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)", replace, value)


def _resolved_env(parsed: Mapping[str, Any], name: str) -> str | None:
    value = _expand(_env(parsed, name), parsed)
    if value is not None and re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*", value):
        return None
    return value


def _run_commit_assertions(parsed: Mapping[str, Any]) -> dict[str, str]:
    commits: dict[str, str] = {}
    pattern = re.compile(
        r'git\s+-C\s+(?P<path>[^\s)]+)\s+rev-parse\s+HEAD\)"\s*=\s*["\'](?P<commit>[0-9a-f]{40})',
        re.IGNORECASE,
    )
    for run in parsed["runs"]:
        for match in pattern.finditer(run):
            path = match.group("path").lower()
            commit = match.group("commit").lower()
            if "libceed" in path:
                commits["libceed"] = commit
            elif "petsc" in path:
                commits["petsc"] = commit
            elif "slepc" in path:
                commits["slepc"] = commit
            elif "hypre" in path:
                commits["hypre"] = commit
            elif "umpire" in path:
                commits["umpire"] = commit
            elif path.endswith("mfem"):
                commits["mfem"] = commit
    return commits


def _cuda_version(reference: str | None) -> str | None:
    if not reference:
        return None
    # CUDA image tags contain a toolkit version before the distro/variant
    # suffix, for example 12.4.1-devel-ubuntu20.04.
    match = re.search(r":(?P<version>\d+\.\d+(?:\.\d+)?)", reference)
    return match.group("version") if match else None


def _source_declared(parsed: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    commits = _run_commit_assertions(parsed)
    result: dict[str, dict[str, Any]] = {}
    for name, ref_name, commit_name, optional in _SOURCE_SPECS:
        ref = _resolved_env(parsed, ref_name)
        commit = _resolved_env(parsed, commit_name)
        if commit is None:
            commit = commits.get(name)
        result[name] = {"ref": ref, "commit": commit, "optional": optional}
    return result


def _declared_manifest(parsed: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    base_reference = _expand(_arg(parsed, "FULLMAG_CUDA_BASE_IMAGE"), parsed) or _resolved_env(parsed, "FULLMAG_CUDA_BASE_IMAGE")
    base_digest = _expand(_arg(parsed, "FULLMAG_CUDA_BASE_IMAGE_DIGEST"), parsed) or _resolved_env(parsed, "FULLMAG_CUDA_BASE_IMAGE_DIGEST")
    if base_digest:
        base_digest = base_digest.removeprefix("sha256:")
    base_image = {"reference": base_reference, "digest": base_digest or None}

    cuda_arch = _expand(_arg(parsed, "FULLMAG_CUDA_ARCHITECTURES"), parsed) or _resolved_env(parsed, "FULLMAG_CUDA_ARCHITECTURES")
    hypre_arch = _expand(_arg(parsed, "FULLMAG_HYPRE_GPU_ARCHITECTURES"), parsed) or _resolved_env(parsed, "FULLMAG_HYPRE_GPU_ARCHITECTURES")
    declared = {
        "base_image": base_image,
        "cuda": {
            "version": _resolved_env(parsed, "CUDA_VERSION") or _cuda_version(base_reference),
            "architectures": cuda_arch,
        },
        "hypre": {
            "gpu_architectures": hypre_arch,
            "memory_variant": _expand(_arg(parsed, "FULLMAG_HYPRE_MEMORY_VARIANT"), parsed) or _resolved_env(parsed, "FULLMAG_HYPRE_MEMORY_VARIANT"),
        },
        "dependencies": _source_declared(parsed),
        "tools": {
            "cmake": _resolved_env(parsed, "CMAKE_VERSION"),
            "node": _resolved_env(parsed, "NODE_VERSION"),
            "python": _resolved_env(parsed, "PYTHON_VERSION"),
            "pnpm": _resolved_env(parsed, "PNPM_VERSION"),
            "rust": _resolved_env(parsed, "RUST_TOOLCHAIN"),
        },
    }
    artifact_hashes = {
        "node": {
            "amd64": _arg(parsed, "NODE_SHA256_AMD64"),
            "arm64": _arg(parsed, "NODE_SHA256_ARM64"),
        },
        "python": _arg(parsed, "PYTHON_SHA256"),
    }
    pinning: dict[str, Any] = {
        "base_image": "tag+digest" if base_digest else "tag",
        "dependencies": {},
        "tools": {},
    }
    for name, entry in declared["dependencies"].items():
        if entry["ref"] and entry["commit"]:
            pinning["dependencies"][name] = "ref+source-commit"
        elif entry["ref"]:
            pinning["dependencies"][name] = "ref-only"
        elif entry["commit"]:
            pinning["dependencies"][name] = "source-commit-only"
        else:
            pinning["dependencies"][name] = "unresolved"
    pinning["tools"] = {
        "cmake": "exact-version" if declared["tools"]["cmake"] else "unresolved",
        "node": "version+sha256" if declared["tools"]["node"] and all(artifact_hashes["node"].values()) else "partial",
        "python": "version+sha256" if declared["tools"]["python"] and artifact_hashes["python"] else "partial",
        "pnpm": "exact-version" if declared["tools"]["pnpm"] else "unresolved",
        "rust": "channel-only" if declared["tools"]["rust"] else "unresolved",
    }
    return declared, artifact_hashes, pinning


def _relative_source(path: Path) -> str:
    try:
        return path.resolve().relative_to(Path(__file__).resolve().parents[1]).as_posix()
    except ValueError:
        return str(path.resolve())


def _is_sha1(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{40}", value) is not None


def load_installed_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReportError(f"cannot read installed manifest {path}: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema") != MANIFEST_SCHEMA:
        raise ReportError(f"installed manifest schema must be {MANIFEST_SCHEMA}")
    actual = value.get("actual")
    commits = actual.get("source_commits") if isinstance(actual, dict) else None
    if not isinstance(commits, dict):
        raise ReportError("installed manifest actual.source_commits must be an object")
    for name, commit in commits.items():
        if name not in _SOURCE_NAMES:
            raise ReportError(f"unknown installed source dependency {name!r}")
        if commit is not None and not _is_sha1(commit):
            raise ReportError(f"installed source commit for {name!r} must be a 40-hex SHA or null")
    required = ("mfem", "libceed", "hypre", "petsc", "slepc")
    missing = [name for name in required if not _is_sha1(commits.get(name))]
    if missing:
        raise ReportError("installed manifest is missing required actual.source_commits: " + ", ".join(missing))
    return value


def _installed_comparison(report: Mapping[str, Any], installed: Mapping[str, Any]) -> dict[str, Any]:
    actual = installed["actual"]["source_commits"]
    comparisons: dict[str, Any] = {}
    for name, declared in report["declared"]["dependencies"].items():
        expected = declared.get("commit")
        observed = actual.get(name)
        if observed is None and declared.get("optional"):
            status = "optional-or-not-built"
        elif observed is None:
            status = "missing"
        elif expected is None:
            status = "actual-without-declared-pin"
        elif observed.lower() == expected.lower():
            status = "match"
        else:
            status = "mismatch"
        comparisons[name] = {"declared": expected, "actual": observed, "status": status}
    return comparisons


def build_report(dockerfile: Path, installed_manifest: Path | None = None) -> dict[str, Any]:
    try:
        raw = dockerfile.read_bytes()
    except OSError as exc:
        raise ReportError(f"cannot read Dockerfile {dockerfile}: {exc}") from exc
    try:
        parsed = parse_dockerfile(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ReportError(f"Dockerfile is not UTF-8: {dockerfile}") from exc
    declared, artifact_hashes, pinning = _declared_manifest(parsed)
    report: dict[str, Any] = {
        "schema": REPORT_SCHEMA,
        "manifest_schema": MANIFEST_SCHEMA,
        "source": {
            "dockerfile": _relative_source(dockerfile),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "parser": PARSER_VERSION,
        },
        "declared": declared,
        "artifact_hashes": artifact_hashes,
        "pinning": pinning,
        "latest": {
            "status": "not-queried",
            "policy": "Pinned refs, commits, image digests, and tool hashes remain authoritative; latest never updates or qualifies an image.",
        },
    }
    if installed_manifest is not None:
        installed = load_installed_manifest(installed_manifest)
        report["installed_manifest"] = installed
        report["installed_comparison"] = _installed_comparison(report, installed)
    return report


def _request(url: str, timeout: float, accept: str) -> bytes:
    if not 0 < timeout <= MAX_TIMEOUT_SECONDS:
        raise ReportError(f"timeout must be between 0 and {MAX_TIMEOUT_SECONDS:g} seconds")
    request = urllib.request.Request(
        url,
        headers={"Accept": accept, "User-Agent": "fullmag-docker-dependency-report/1"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read(MAX_RESPONSE_BYTES + 1)
    if len(payload) > MAX_RESPONSE_BYTES:
        raise ReportError(f"upstream response exceeds {MAX_RESPONSE_BYTES} bytes: {url}")
    return payload


def _fetch_json(url: str, timeout: float) -> Any:
    return json.loads(_request(url, timeout, "application/json").decode("utf-8"))


def _fetch_text(url: str, timeout: float) -> str:
    return _request(url, timeout, "text/plain").decode("utf-8")


def _version(value: str | None) -> tuple[int, ...] | None:
    if not value:
        return None
    match = re.search(r"(?<!\d)v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?!\d)", value)
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def _stable_version(value: str | None) -> bool:
    if not value:
        return False
    # A complete numeric tag is the only form accepted as stable.  This
    # excludes rc/beta/nightly/dev suffixes instead of guessing at markers.
    return re.fullmatch(r"v?\d+(?:\.\d+){0,2}", value.strip()) is not None


def _github_latest(payload: Any) -> tuple[str | None, str]:
    if not isinstance(payload, dict):
        return None, "invalid-response"
    if payload.get("prerelease"):
        return None, "prerelease-only"
    tag = payload.get("tag_name") or payload.get("name")
    if not isinstance(tag, str) or not _stable_version(tag):
        return None, "no-stable-release"
    return tag, "ok"


def _github_tags_latest(payload: Any) -> tuple[str | None, str]:
    if not isinstance(payload, list):
        return None, "invalid-response"
    candidates = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        tag = item.get("name") or item.get("tag_name")
        if isinstance(tag, str) and _stable_version(tag):
            version = _version(tag)
            if version is not None:
                candidates.append((version, tag))
    if not candidates:
        return None, "no-stable-tag"
    return max(candidates)[1], "ok"


def _gitlab_latest(payload: Any) -> tuple[str | None, str]:
    if not isinstance(payload, list):
        return None, "invalid-response"
    candidates = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        tag = item.get("tag_name")
        if isinstance(tag, str) and _stable_version(tag):
            version = _version(tag)
            if version is not None:
                candidates.append((version, tag))
    if not candidates:
        return None, "no-stable-release"
    return max(candidates)[1], "ok"


def _gitlab_tags_latest(payload: Any) -> tuple[str | None, str]:
    if not isinstance(payload, list):
        return None, "invalid-response"
    candidates = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        tag = item.get("name") or item.get("tag_name")
        if isinstance(tag, str) and _stable_version(tag):
            version = _version(tag)
            if version is not None:
                candidates.append((version, tag))
    if not candidates:
        return None, "no-stable-tag"
    return max(candidates)[1], "ok"


def _node_latest(payload: Any) -> tuple[str | None, str]:
    if not isinstance(payload, list):
        return None, "invalid-response"
    candidates = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        version = item.get("version")
        if isinstance(version, str) and _stable_version(version):
            parsed = _version(version)
            if parsed is not None:
                candidates.append((parsed, version))
    if not candidates:
        return None, "no-stable-release"
    return max(candidates)[1], "ok"


def _rust_latest(channel: str) -> tuple[str | None, str]:
    section_match = re.search(
        r"(?ms)^\[pkg\.rust\]\s*(.*?)(?=^\[[^]]+\]\s*$|\Z)",
        channel,
    )
    if not section_match:
        return None, "rust-package-section-missing"
    match = re.search(r'(?m)^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)(?:[^"]*)?"', section_match.group(1))
    if not match:
        return None, "rust-package-version-missing"
    return match.group(1), "ok"


def _compare(declared: str | None, latest: str | None) -> str:
    if not declared or not latest:
        return "unavailable"
    declared_version = _version(declared)
    latest_version = _version(latest)
    if declared_version is None or latest_version is None:
        return "uncomparable"
    if latest_version > declared_version:
        return "newer-stable-available"
    if latest_version == declared_version:
        return "same-version"
    return "declared-newer-than-latest"


def _update_declarations(report: Mapping[str, Any]) -> dict[str, str | None]:
    declared = report["declared"]
    result: dict[str, str | None] = {"cuda": declared["base_image"].get("reference")}
    result.update({name: entry.get("ref") for name, entry in declared["dependencies"].items()})
    result.update({name: declared["tools"].get(name) for name in _TOOL_NAMES})
    return result


def _latest_from_payload(kind: str, payload: Any) -> tuple[str | None, str]:
    if kind == "github_release":
        return _github_latest(payload)
    if kind == "github_tags":
        return _github_tags_latest(payload)
    if kind == "gitlab_releases":
        return _gitlab_latest(payload)
    if kind == "gitlab_tags":
        return _gitlab_tags_latest(payload)
    if kind == "node_dist":
        return _node_latest(payload)
    return None, "unsupported-source"


def check_updates(report: dict[str, Any], timeout: float = 5.0) -> dict[str, Any]:
    if not 0 < timeout <= MAX_TIMEOUT_SECONDS:
        raise ReportError(f"timeout must be between 0 and {MAX_TIMEOUT_SECONDS:g} seconds")
    results: dict[str, Any] = {}
    for name, declared in _update_declarations(report).items():
        if name == "rust":
            source = {"kind": "official-rust-channel", "url": _RUST_STABLE_URL}
            result: dict[str, Any] = {"source": source, "declared": declared}
            try:
                latest, status = _rust_latest(_fetch_text(source["url"], timeout))
                result.update({"latest_stable": latest, "status": status, "comparison": "channel-not-comparable"})
            except (OSError, urllib.error.URLError, TimeoutError, ValueError) as exc:
                result.update({"latest_stable": None, "status": "unavailable", "error": str(exc), "comparison": "channel-not-comparable"})
            results[name] = result
            continue
        source = _UPDATE_SOURCES.get(name)
        if source is None:
            results[name] = {
                "declared": declared,
                "status": "not-queried",
                "reason": "no-safe-official-version-endpoint",
                "comparison": "unavailable",
            }
            continue
        result: dict[str, Any] = {"source": source, "declared": declared}
        try:
            payload = _fetch_json(source["url"], timeout)
            latest, status = _latest_from_payload(source["kind"], payload)
            if status in {"no-stable-release", "no-stable-tag", "invalid-response"} and source.get("fallback_url"):
                fallback_source = {"kind": source["fallback_kind"], "url": source["fallback_url"]}
                fallback_payload = _fetch_json(fallback_source["url"], timeout)
                fallback_latest, fallback_status = _latest_from_payload(fallback_source["kind"], fallback_payload)
                result["fallback_source"] = fallback_source
                if fallback_status == "ok":
                    latest, status = fallback_latest, fallback_status
            result.update({"latest_stable": latest, "status": status, "comparison": _compare(declared, latest) if status == "ok" else "unavailable"})
        except (OSError, urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            result.update({"status": "unavailable", "error": str(exc), "comparison": "unavailable"})
        results[name] = result
    return {
        "status": "checked",
        "policy": "Stable upstream observations only; no automatic update or qualification.",
        "results": results,
    }


def _timeout_argument(value: str) -> float:
    try:
        timeout = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("timeout must be a number") from exc
    if not 0 < timeout <= MAX_TIMEOUT_SECONDS:
        raise argparse.ArgumentTypeError(f"timeout must be between 0 and {MAX_TIMEOUT_SECONDS:g} seconds")
    return timeout


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dockerfile", type=Path, default=DEFAULT_DOCKERFILE)
    parser.add_argument("--installed-manifest", type=Path)
    parser.add_argument("--check-updates", action="store_true")
    parser.add_argument("--timeout", type=_timeout_argument, default=5.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--compact", action="store_true", help="emit one-line JSON")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report = build_report(args.dockerfile, args.installed_manifest)
        if args.check_updates:
            report["latest"] = check_updates(report, timeout=args.timeout)
        rendered = json.dumps(report, ensure_ascii=False, indent=None if args.compact else 2, sort_keys=True) + "\n"
        if args.output:
            try:
                args.output.write_text(rendered, encoding="utf-8")
            except OSError as exc:
                raise ReportError(f"cannot write report {args.output}: {exc}") from exc
        else:
            sys.stdout.write(rendered)
        return 0
    except ReportError as exc:
        print(f"docker dependency report: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
