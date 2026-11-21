#!/usr/bin/env python3
"""Record the resolved PETSc build configuration of one installation prefix.

Writes ``<prefix>/share/fullmag/petsc-build-metadata.json`` with the configure
options, the external-package ``PETSC_HAVE_*`` macros and the SHA-256 of the
installed ``petscconf.h``.  ``--require`` names packages whose macro must be
defined; a missing one fails the image build instead of silently producing a
PETSc without the requested direct solver.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

TRACKED_PACKAGES = ("MUMPS", "METIS", "PARMETIS", "SCALAPACK", "OPENBLAS", "HYPRE", "CUDA", "SUPERLU", "SUPERLU_DIST")


def configure_options(variables: str) -> str:
    match = re.search(r"^CONFIGURE_OPTIONS\s*=\s*(.*)$", variables, re.M)
    return match.group(1).strip() if match else ""


def defined_macros(header: str) -> dict[str, bool]:
    return {
        name: bool(re.search(r"^#define\s+PETSC_HAVE_" + name + r"(?:\s+1)?\s*$", header, re.M))
        for name in TRACKED_PACKAGES
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", required=True, type=Path)
    parser.add_argument("--require", nargs="*", default=[])
    args = parser.parse_args(argv)

    header_path = args.prefix / "include" / "petscconf.h"
    variables_path = args.prefix / "lib" / "petsc" / "conf" / "petscvariables"
    header = header_path.read_text(encoding="utf-8")
    macros = defined_macros(header)
    missing = [name for name in args.require if not macros.get(name, False)]
    if missing:
        print(f"PETSc at {args.prefix} lacks required packages: {', '.join(missing)}", file=sys.stderr)
        return 2

    metadata = {
        "schema": "fullmag.petsc_build_metadata.v1",
        "prefix": str(args.prefix),
        "configure_options": configure_options(variables_path.read_text(encoding="utf-8")),
        "external_package_macros": macros,
        "petscconf_sha256": hashlib.sha256(header_path.read_bytes()).hexdigest(),
    }
    output = args.prefix / "share" / "fullmag" / "petsc-build-metadata.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
