#!/usr/bin/env python3
"""Generate and verify the README version and compatibility dashboard.

The dashboard is derived from repository-owned manifests. Do not edit the
generated block manually: change the manifest and run this script with
``--write``.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

START_MARKER = "<!-- fullmag-version-dashboard:start -->"
END_MARKER = "<!-- fullmag-version-dashboard:end -->"


class VersionSourceError(RuntimeError):
    """A required version source is missing or internally inconsistent."""


def read_text(root: Path, relative: str) -> str:
    path = root / relative
    if not path.is_file():
        raise VersionSourceError(f"required version source is missing: {relative}")
    return path.read_text(encoding="utf-8")


def toml_section(text: str, section: str, source: str) -> str:
    match = re.search(
        rf"(?ms)^\[{re.escape(section)}\]\s*$\n(?P<body>.*?)(?=^\[|\Z)",
        text,
    )
    if match is None:
        raise VersionSourceError(f"{source}: section [{section}] is missing")
    return match.group("body")


def toml_string(text: str, section: str, key: str, source: str) -> str:
    body = toml_section(text, section, source)
    match = re.search(
        rf'(?m)^{re.escape(key)}\s*=\s*"(?P<value>[^"]+)"\s*$',
        body,
    )
    if match is None:
        raise VersionSourceError(f"{source}: {section}.{key} is missing")
    return match.group("value").strip()


def toml_dependency(text: str, section: str, key: str, source: str) -> str:
    body = toml_section(text, section, source)
    match = re.search(
        rf'(?m)^{re.escape(key)}\s*=\s*(?:'
        rf'"(?P<simple>[^"]+)"|'
        rf'\{{[^\n]*\bversion\s*=\s*"(?P<table>[^"]+)"[^\n]*\}}'
        rf')\s*$',
        body,
    )
    if match is None:
        raise VersionSourceError(
            f"{source}: dependency {section}.{key} has no version"
        )
    return (match.group("simple") or match.group("table")).strip()


def toml_array(text: str, section: str, key: str, source: str) -> list[str]:
    body = toml_section(text, section, source)
    match = re.search(
        rf"(?ms)^{re.escape(key)}\s*=\s*\[(?P<value>.*?)^\]\s*$",
        body,
    )
    if match is None:
        raise VersionSourceError(f"{source}: {section}.{key} array is missing")
    return re.findall(r'"([^"]+)"', match.group("value"))


def dependency_constraint(entries: list[str], name: str, source: str) -> str:
    for entry in entries:
        if entry == name:
            return "*"
        if entry.startswith(name):
            return entry[len(name) :]
    raise VersionSourceError(f"{source}: dependency {name!r} is missing")


def assignment(text: str, pattern: str, source: str, label: str) -> str:
    match = re.search(pattern, text, flags=re.MULTILINE)
    if match is None:
        raise VersionSourceError(f"{source}: {label} is missing")
    return match.group("value").strip()


def collect_versions(root: Path) -> dict[str, str]:
    cargo_path = "Cargo.toml"
    pyproject_path = "packages/fullmag-py/pyproject.toml"
    frontend_path = "apps/control-room/package.json"
    docker_path = "docker/fem-gpu/Dockerfile"
    rust_path = "rust-toolchain.toml"

    cargo = read_text(root, cargo_path)
    pyproject = read_text(root, pyproject_path)
    frontend = json.loads(read_text(root, frontend_path))
    docker = read_text(root, docker_path)
    rust = read_text(root, rust_path)
    node = read_text(root, ".node-version").strip()

    package_versions = {
        "Cargo": toml_string(cargo, "workspace.package", "version", cargo_path),
        "Python": toml_string(pyproject, "project", "version", pyproject_path),
        "Control Room": str(frontend.get("version", "")).strip(),
    }
    if "" in package_versions.values() or len(set(package_versions.values())) != 1:
        details = ", ".join(
            f"{name}={value or '<missing>'}"
            for name, value in package_versions.items()
        )
        raise VersionSourceError(f"FullMag package versions disagree: {details}")

    docker_node = assignment(
        docker,
        r"^ARG NODE_VERSION=(?P<value>[^\s]+)$",
        docker_path,
        "ARG NODE_VERSION",
    )
    if node != docker_node:
        raise VersionSourceError(
            f"Node versions disagree: .node-version={node}, Dockerfile={docker_node}"
        )

    dependencies = frontend.get("dependencies")
    dev_dependencies = frontend.get("devDependencies")
    if not isinstance(dependencies, dict) or not isinstance(dev_dependencies, dict):
        raise VersionSourceError(
            f"{frontend_path}: dependencies/devDependencies must be objects"
        )

    next_version = str(dependencies.get("next", "")).strip()
    react_version = str(dependencies.get("react", "")).strip()
    if react_version != str(dependencies.get("react-dom", "")).strip():
        raise VersionSourceError(f"{frontend_path}: react and react-dom disagree")
    if next_version != str(dev_dependencies.get("eslint-config-next", "")).strip():
        raise VersionSourceError(
            f"{frontend_path}: next and eslint-config-next disagree"
        )

    py_dependencies = toml_array(
        pyproject, "project", "dependencies", pyproject_path
    )
    meshing_dependencies = toml_array(
        pyproject, "project.optional-dependencies", "meshing", pyproject_path
    )

    values = {
        "fullmag": next(iter(package_versions.values())),
        "python": toml_string(
            pyproject, "project", "requires-python", pyproject_path
        ),
        "numpy": dependency_constraint(py_dependencies, "numpy", pyproject_path),
        "zarr": dependency_constraint(py_dependencies, "zarr", pyproject_path),
        "h5py": dependency_constraint(py_dependencies, "h5py", pyproject_path),
        "gmsh": dependency_constraint(
            meshing_dependencies, "gmsh", pyproject_path
        ),
        "node": node,
        "rust_channel": toml_string(rust, "toolchain", "channel", rust_path),
        "rust_edition": toml_string(
            cargo, "workspace.package", "edition", cargo_path
        ),
        "pyo3": toml_dependency(
            cargo, "workspace.dependencies", "pyo3", cargo_path
        ),
        "tauri": toml_dependency(
            cargo, "workspace.dependencies", "tauri", cargo_path
        ),
        "cuda": assignment(
            docker,
            r"^FROM nvidia/cuda:(?P<value>[^-\s]+)-devel-ubuntu[^\s]+ AS deps$",
            docker_path,
            "CUDA base image",
        ),
        "cmake": assignment(
            docker,
            r"^ENV CMAKE_VERSION=(?P<value>[^\s]+)$",
            docker_path,
            "CMAKE_VERSION",
        ),
        "mfem": assignment(
            docker,
            r"^ENV MFEM_REF=v?(?P<value>[^\s]+)$",
            docker_path,
            "MFEM_REF",
        ),
        "hypre": assignment(
            docker,
            r"^ENV HYPRE_REF=v?(?P<value>[^\s]+)$",
            docker_path,
            "HYPRE_REF",
        ),
        "libceed": assignment(
            docker,
            r"^ENV LIBCEED_REF=v?(?P<value>[^\s]+)$",
            docker_path,
            "LIBCEED_REF",
        ),
        "pnpm": assignment(
            docker,
            r"^RUN corepack enable && corepack prepare pnpm@(?P<value>[^ ]+) --activate$",
            docker_path,
            "pnpm version",
        ),
        "next": next_version,
        "react": react_version,
        "typescript": str(dev_dependencies.get("typescript", "")).strip(),
        "three": str(dependencies.get("three", "")).strip(),
        "echarts": str(dependencies.get("echarts", "")).strip(),
    }
    missing = sorted(key for key, value in values.items() if not value)
    if missing:
        raise VersionSourceError("empty version values: " + ", ".join(missing))
    return values


def badge_url(
    label: str,
    value: str,
    color: str,
    logo: str | None = None,
    logo_color: str = "white",
) -> str:
    safe_label = quote(label.replace("-", "--"), safe=".")
    safe_value = quote(value.replace("-", "--"), safe=".")
    url = (
        f"https://img.shields.io/badge/{safe_label}-{safe_value}-{color}"
        "?style=for-the-badge"
    )
    if logo:
        url += (
            f"&logo={quote(logo, safe='')}"
            f"&logoColor={quote(logo_color, safe='')}"
        )
    return url


def badge(
    label: str,
    value: str,
    color: str,
    href: str,
    logo: str | None = None,
    logo_color: str = "white",
) -> str:
    alt = html.escape(f"{label} {value}", quote=True)
    src = html.escape(
        badge_url(label, value, color, logo, logo_color), quote=True
    )
    return f'  <a href="{href}"><img alt="{alt}" src="{src}" /></a>'


def badge_group(
    title: str,
    specs: list[tuple[str, str, str, str, str | None, str]],
) -> list[str]:
    lines = ['<p align="center">', f"  <strong>{title}</strong><br />"]
    lines.extend(badge(*spec) for spec in specs)
    lines.append("</p>")
    return lines


def render_dashboard(v: dict[str, str]) -> str:
    workflows = [
        ("contract-guard", "contract-guard.yml"),
        ("React Doctor", "react-doctor.yml"),
        ("Public documentation", "documentation.yml"),
    ]
    core = [
        ("FullMag", f"v{v['fullmag']}", "2563EB", "Cargo.toml", None, "white"),
        (
            "Python",
            v["python"],
            "3776AB",
            "packages/fullmag-py/pyproject.toml",
            "python",
            "white",
        ),
        ("Node.js", v["node"], "339933", ".node-version", "nodedotjs", "white"),
        (
            "Rust",
            f"{v['rust_channel']} | edition {v['rust_edition']}",
            "000000",
            "rust-toolchain.toml",
            "rust",
            "white",
        ),
        (
            "CUDA",
            v["cuda"],
            "76B900",
            "docker/fem-gpu/Dockerfile",
            "nvidia",
            "white",
        ),
        (
            "CMake",
            v["cmake"],
            "064F8C",
            "docker/fem-gpu/Dockerfile",
            "cmake",
            "white",
        ),
        (
            "pnpm",
            v["pnpm"],
            "F69220",
            "docker/fem-gpu/Dockerfile",
            "pnpm",
            "white",
        ),
    ]
    scientific = [
        ("MFEM", v["mfem"], "5B6EC4", "docker/fem-gpu/Dockerfile", None, "white"),
        ("hypre", v["hypre"], "6B7280", "docker/fem-gpu/Dockerfile", None, "white"),
        (
            "libCEED",
            v["libceed"],
            "7C3AED",
            "docker/fem-gpu/Dockerfile",
            None,
            "white",
        ),
        ("PyO3", v["pyo3"], "FFD43B", "Cargo.toml", "rust", "000000"),
        (
            "NumPy",
            v["numpy"],
            "013243",
            "packages/fullmag-py/pyproject.toml",
            "numpy",
            "white",
        ),
        (
            "Gmsh",
            v["gmsh"],
            "5B6EC4",
            "packages/fullmag-py/pyproject.toml",
            None,
            "white",
        ),
    ]
    frontend = [
        (
            "Next.js",
            v["next"],
            "000000",
            "apps/control-room/package.json",
            "nextdotjs",
            "white",
        ),
        (
            "React",
            v["react"],
            "20232A",
            "apps/control-room/package.json",
            "react",
            "61DAFB",
        ),
        (
            "TypeScript",
            v["typescript"],
            "3178C6",
            "apps/control-room/package.json",
            "typescript",
            "white",
        ),
        (
            "Three.js",
            v["three"],
            "000000",
            "apps/control-room/package.json",
            "threedotjs",
            "white",
        ),
        (
            "ECharts",
            v["echarts"],
            "AA344D",
            "apps/control-room/package.json",
            "apacheecharts",
            "white",
        ),
        ("Tauri", v["tauri"], "24C8DB", "Cargo.toml", "tauri", "000000"),
    ]

    lines = [
        START_MARKER,
        '<a id="version-dashboard"></a>',
        "",
        "## Version and compatibility dashboard",
        "",
        "The badges below are generated from repository-owned manifests. They distinguish exact",
        "toolchain pins from supported dependency ranges; `contract-guard` fails when this README",
        "no longer matches the source files.",
        "",
        '<p align="center">',
        "  <strong>Continuous verification</strong><br />",
    ]
    for alt, workflow in workflows:
        href = (
            "https://github.com/MateuszZelent/fullmag/actions/workflows/"
            f"{workflow}"
        )
        src = f"{href}/badge.svg?branch=master"
        lines.append(
            f'  <a href="{href}"><img alt="{html.escape(alt, quote=True)}" '
            f'src="{html.escape(src, quote=True)}" /></a>'
        )
    lines.extend(["</p>", ""])
    lines.extend(badge_group("Core toolchain", core))
    lines.append("")
    lines.extend(badge_group("Scientific backends", scientific))
    lines.append("")
    lines.extend(badge_group("Control Room", frontend))
    lines.extend(
        [
            "",
            "<details>",
            '<summary><strong>Version policy and sources of truth</strong></summary>',
            "",
            "| Contract | Current manifest value | Source of truth | Policy |",
            "|---|---|---|---|",
            f"| FullMag packages | `{v['fullmag']}` | `Cargo.toml`, `packages/fullmag-py/pyproject.toml`, `apps/control-room/package.json` | package versions must agree |",
            f"| Core toolchain | Python `{v['python']}`; Node `{v['node']}`; Rust `{v['rust_channel']}` / edition `{v['rust_edition']}` | `pyproject.toml`, `.node-version`, `rust-toolchain.toml`, `Cargo.toml` | compatibility range or pinned channel/version |",
            f"| Managed FEM/GPU bundle | CUDA `{v['cuda']}`; CMake `{v['cmake']}`; MFEM `{v['mfem']}`; hypre `{v['hypre']}`; libCEED `{v['libceed']}` | `docker/fem-gpu/Dockerfile` | exact reproducible build pins |",
            f"| Python scientific API | NumPy `{v['numpy']}`; Zarr `{v['zarr']}`; h5py `{v['h5py']}`; Gmsh `{v['gmsh']}` | `packages/fullmag-py/pyproject.toml` | declared compatibility ranges |",
            f"| Control Room direct stack | Next.js `{v['next']}`; React `{v['react']}`; TypeScript `{v['typescript']}`; Three.js `{v['three']}`; ECharts `{v['echarts']}` | `apps/control-room/package.json` | direct constraints; complete transitive resolution is pinned in `pnpm-lock.yaml` |",
            f"| Rust/Python and desktop bridge | PyO3 `{v['pyo3']}`; Tauri `{v['tauri']}` | `Cargo.toml` | workspace dependency constraints |",
            "",
            "Regenerate after changing a version source:",
            "",
            "```bash",
            "python3 scripts/update_readme_version_dashboard.py --write",
            "```",
            "",
            "</details>",
            END_MARKER,
        ]
    )
    return "\n".join(lines)


def replace_dashboard(readme: str, dashboard: str) -> str:
    pattern = re.compile(
        rf"{re.escape(START_MARKER)}.*?{re.escape(END_MARKER)}",
        flags=re.DOTALL,
    )
    if len(pattern.findall(readme)) != 1:
        raise VersionSourceError(
            "readme.md must contain exactly one generated version dashboard"
        )
    return pattern.sub(dashboard, readme, count=1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parents[1]
    readme_path = root / "readme.md"
    try:
        current = readme_path.read_text(encoding="utf-8")
        expected = replace_dashboard(
            current, render_dashboard(collect_versions(root))
        )
    except (OSError, ValueError, json.JSONDecodeError, VersionSourceError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if args.write:
        if current != expected:
            readme_path.write_text(expected, encoding="utf-8")
            print("Updated readme.md version dashboard.")
        else:
            print("readme.md version dashboard is already current.")
        return 0

    if current != expected:
        print(
            "ERROR: readme.md version dashboard is stale. Run:\n"
            "  python3 scripts/update_readme_version_dashboard.py --write",
            file=sys.stderr,
        )
        return 1

    print("README version dashboard matches repository manifests.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
