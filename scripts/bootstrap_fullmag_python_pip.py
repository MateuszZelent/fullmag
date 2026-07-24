#!/usr/bin/env python3
"""Bootstrap pip into the repo venv from verified distro wheels, without network."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import zipfile
from pathlib import Path


class BootstrapError(RuntimeError):
    pass


REQUIRED_WHEEL_MEMBERS = (
    ("pip", "pip/__init__.py"),
    ("setuptools", "setuptools/__init__.py"),
    ("wheel", "wheel/__init__.py"),
)


def select_verified_wheels(wheel_dir: Path) -> tuple[Path, ...]:
    resolved_dir = wheel_dir.resolve()
    selected: list[Path] = []
    for package, required_member in REQUIRED_WHEEL_MEMBERS:
        matches = sorted(
            path.resolve()
            for path in wheel_dir.glob(f"{package}-*.whl")
            if path.is_file() and path.resolve().parent == resolved_dir
        )
        if len(matches) != 1:
            raise BootstrapError(
                f"expected exactly one local {package} wheel in {resolved_dir}, "
                f"found {len(matches)}"
            )
        wheel_path = matches[0]
        try:
            with zipfile.ZipFile(wheel_path) as archive:
                if required_member not in archive.namelist():
                    raise BootstrapError(
                        f"local {package} wheel {wheel_path} does not contain "
                        f"{required_member}"
                    )
        except zipfile.BadZipFile as error:
            raise BootstrapError(f"local {package} wheel {wheel_path} is invalid") from error
        selected.append(wheel_path)
    return tuple(selected)


def bootstrap_pip(python: Path, wheel_dir: Path) -> None:
    if not python.is_file() or not os.access(python, os.X_OK):
        raise BootstrapError(f"Fullmag Python interpreter is not executable: {python}")
    wheels = select_verified_wheels(wheel_dir)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(wheels[0])
    command = [
        str(python),
        "-m",
        "pip",
        "install",
        "--no-index",
        "--no-deps",
        *(str(path) for path in wheels),
    ]
    install = subprocess.run(command, env=env, capture_output=True, text=True)
    if install.returncode != 0:
        detail = (install.stderr or install.stdout or f"exit {install.returncode}").strip()
        raise BootstrapError(f"offline distro-wheel pip bootstrap failed: {detail}")
    probe = subprocess.run(
        [str(python), "-m", "pip", "--version"],
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        detail = (probe.stderr or probe.stdout or f"exit {probe.returncode}").strip()
        raise BootstrapError(f"offline distro-wheel bootstrap produced no usable pip: {detail}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("python", type=Path)
    parser.add_argument("--wheel-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        bootstrap_pip(args.python, args.wheel_dir)
    except BootstrapError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
