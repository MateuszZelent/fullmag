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
- `pip` with network access to install runtime wheels and the Python dependencies.
- A Cargo/Rust toolchain is **not** required for Python authoring alone, but the repository build
  tooling uses it to produce the native FDM/FEM solver bundle.
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
owns a `justfile` that wraps the container and host build paths. Before a repository build, configure `FULLMAG_PROJECT_STORAGE_ROOT` in the main
checkout's local `.env`, using `.env.example`. Worktrees inherit that configuration;
do not copy an unrelated host's storage paths. On a host enrolled with
`Fullmag_build_runner`, submit full builds through its queue with an explicit source
checkout and snapshot or commit. The following is the repository recipe for hosts
using the local build route:

```console
just build fullmag
```

This stages the launcher and the finite-difference library under `.fullmag/local`. The easiest
headless run is then:

```console
just run-headless examples/fdm_cpu_relax_smoke.py
```

For a first interactive launch, `just fullmag build=True fdm cpu <script>` builds on first use and
then runs the script with the Control Room.

The finite-element runtime uses MFEM, hypre, libCEED and (on GPU) CUDA. It is built and executed
through the repository's managed container recipes rather than ad-hoc host commands:

```console
just ensure-managed-fem-runtime
```

FDM CUDA and FEM GPU paths additionally require a managed CUDA runtime. GPU execution must be
qualified with device identity recorded in the result; compiling on a host is not proof that GPU
code executed.

## Native Windows workspace

For the native Windows development route, use the managed launcher recipes:

```console
just windows-workspace-build dev dev 3197 auto
just windows-ui dev
```

The first command prepares the dev package without launching the UI. The second
starts an empty workspace on port 3197 with frontend HMR and a backend source watcher.
`auto` checks source/package identity; it is not a request to reuse an arbitrary old
binary. A completed background backend build does not restart an active simulation.
The native route does not establish FEM/MFEM support; FEM uses its separate managed
container runtime and must satisfy the selected device requirements.

## Checking the installation

Bare imports validate the Python layer only. A complete check is to run one of the repository's
small stage-first smoke scripts headlessly and confirm that a result artifact is produced. The
{ref}`first FDM simulation <public-docs-getting-started-first-fdm-simulation>` and
{ref}`first FEM simulation <public-docs-getting-started-first-fem-simulation>` pages use the same
workflow.
## Control Room crosswalk

Use the authoring path stated in this guide, normally `Model Explorer -> Objects` followed by the relevant Geometry, Material, Physics, Mesh, or Stage panel. Any parameter shown in Python but not shown in that path is `TODO: frontend support`; do not describe it as configurable in the UI. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

The runnable Python example and exact argument contract are authoritative. If this guide is conceptual or does not contain a runnable example, it explicitly defers to the linked {doc}`/python-api/index` page rather than duplicating an unverified signature.

## Physics, limitations, and bibliography

Use the linked physics or numerical-methods page for governing equations and assumptions. This onboarding page does not add a new physical model. Bibliography: see the linked terminal API or physics page; no additional source is claimed here.
## Source-code index

- `packages/fullmag-py/pyproject.toml` — `[project]`, `[project.optional-dependencies]`: Python requirement and meshing extras.
- `justfile` — `build`, `run-headless`, `ensure-managed-fem-runtime`, `windows-workspace-build`, `windows-ui`: repository launch/build entry points.
- `scripts/fullmag_storage.py` — `resolve_layout`: project/worktree/storage identity and path validation.
- `scripts/windows/run_fullmag.ps1`: native Windows launcher; see the recipe argument mapping before overriding a runtime.
