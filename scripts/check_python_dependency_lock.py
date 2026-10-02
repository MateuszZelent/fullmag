"""Reject a Fullmag wheel lock whose declared project contract has drifted."""

import argparse
from pathlib import Path
import re
import tomllib


def normalized_name(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def specifiers(value):
    # This guard deliberately supports the simple registry requirements used by
    # this project. New PEP 508 forms need an explicit extension, not omission.
    pieces = {part.strip() for part in value.split(",") if part.strip()}
    if any(not re.fullmatch(r"(?:>=|<=|==|!=|~=|>|<)[A-Za-z0-9.*+!-]+", piece) for piece in pieces):
        raise ValueError(f"Unsupported dependency specifier in lock guard: {value}")
    return tuple(sorted(pieces))


def requirement(value, marker=""):
    match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)\s*([<>=!~].*)?", value.strip())
    if not match:
        raise ValueError(f"Unsupported dependency requirement in lock guard: {value}")
    return normalized_name(match[1]), specifiers(match[2] or ""), marker


def check_lock(project_path, lock_path):
    project = tomllib.loads(project_path.read_text(encoding="utf-8"))
    lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    declared = project["project"]
    name = normalized_name(declared["name"])
    packages = [p for p in lock["package"] if normalized_name(p["name"]) == name]
    if len(packages) != 1:
        raise ValueError("Python dependency lock must contain exactly one project entry")
    package = packages[0]
    if package["version"] != declared["version"]:
        raise ValueError("Python dependency lock has a stale project version")
    if specifiers(lock["requires-python"]) != specifiers(declared["requires-python"]):
        raise ValueError("Python dependency lock has a stale requires-python contract")
    metadata = package["metadata"]
    extras = declared.get("optional-dependencies", {})
    if set(metadata.get("provides-extras", [])) != set(extras):
        raise ValueError("Python dependency lock has stale optional dependency groups")
    expected = {requirement(value) for value in declared.get("dependencies", [])}
    for extra, values in extras.items():
        expected.update(requirement(value, f"extra == '{extra}'") for value in values)
    actual = {
        (normalized_name(entry["name"]), specifiers(entry.get("specifier", "")), entry.get("marker", ""))
        for entry in metadata.get("requires-dist", [])
    }
    if actual != expected:
        raise ValueError("Python dependency lock has stale dependency declarations")
    expected_groups = {
        group: {requirement(value) for value in values}
        for group, values in project.get("dependency-groups", {}).items()
    }
    actual_groups = {
        group: {(normalized_name(entry["name"]), specifiers(entry.get("specifier", "")), entry.get("marker", "")) for entry in values}
        for group, values in metadata.get("requires-dev", {}).items()
    }
    if expected_groups != actual_groups:
        raise ValueError("Python dependency lock has stale development groups")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--lock", type=Path, required=True)
    args = parser.parse_args()
    try:
        check_lock(args.project, args.lock)
    except (ValueError, KeyError, TypeError, tomllib.TOMLDecodeError) as exc:
        parser.exit(1, f"Python dependency lock is not usable: {exc}. Refresh uv.lock from the current pyproject.toml before packaging.\n")
    print("Python dependency lock declarations: PASS")


if __name__ == "__main__":
    main()
