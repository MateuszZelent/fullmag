---
title: Installation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-installation)=
# Installation

FullMag separates the **Python authoring layer** from the **solver runtime**. The Python package
defines the `fm.study(...)` workflow and lowers it to the canonical `ProblemIR`; a compiled
backend then executes the solve. This page installs both from a source checkout.

## Requirements

- Python 3.10 or newer.
- `pip`; network access is needed unless the declared Python dependencies are already cached.
- A Cargo/Rust toolchain is **not** required for Python authoring alone. Building the source-checkout
  launcher and native runtime also requires the repository's `just`/Make workflow and its Rust,
  C/C++, and CMake prerequisites; managed FEM builds additionally require the configured container
  runtime. The checked-in recipes, rather than ad-hoc host commands, define the supported build
  paths.
- Finite-element meshing with the geometry workflow additionally needs the optional `meshing`
  extras (`gmsh`, `manifold3d`, `meshio`, `scipy`, `trimesh`).

## Install the Python DSL

Clone the repository and install the embedded Python package:

```console
git clone https://github.com/MateuszZelent/fullmag
cd fullmag
python -m pip install ./packages/fullmag-py
```

Install the optional meshing dependencies when you author FEM geometry:

```console
python -m pip install "./packages/fullmag-py[meshing]"
```

Verify that the module imports:

```console
python -c "import fullmag; print(fullmag.__file__)"
```

## Prepare a solver runtime

The `fm.study(...)` API is solver-agnostic, but execution needs a compiled backend. The repository
owns a `justfile` that wraps the supported build paths. Build the source-checkout launcher and its
local runtime with:

```console
just build fullmag
```

This stages the launcher and available local native libraries under `.fullmag/local`. The easiest
headless FDM check is then:

```console
just run-headless examples/fdm_cpu_relax_smoke.py
```

For a first interactive launch, `just fullmag build=True fdm cpu <script>` requests an FDM CPU
session, rebuilds as needed, and opens the script with the Control Room.

The finite-element runtime uses MFEM, hypre, libCEED and (on GPU) CUDA. It is built and executed
through the repository's managed container recipes rather than ad-hoc host commands:

```console
just ensure-managed-fem-runtime
```

With CUDA build tools present, `just build fullmag` can install a local CUDA-only launcher for the
FDM GPU path when FEM GPU support is unavailable or managed FEM export is skipped. The FEM GPU path
uses the separate managed MFEM, hypre, libCEED and CUDA runtime described above. Execution on either
GPU lane must be qualified with device identity recorded in the result; compiling on a host is not
proof that GPU code executed.

## Checking the installation

Bare imports validate the Python layer only. A complete check is to run one of the repository's
small stage-first smoke scripts headlessly and confirm that a result artifact is produced. The
{ref}`first FDM simulation <public-docs-getting-started-first-fdm-simulation>` and
{ref}`first FEM simulation <public-docs-getting-started-first-fem-simulation>` pages use the same
workflow.
