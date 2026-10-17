# FullMag

<a id="readme-top"></a>

<div align="center">
  <a href="https://fullmag.mzelent.pl/">
    <img src="docs/fullmag-logo-traced-optimized.svg" alt="FullMag logo" width="160" />
  </a>

  <h2>FDM and FEM micromagnetics with Python, CPU/CUDA solvers, and an interactive Control Room</h2>

  <p>
    <strong>One study model · multiple numerical engines · advanced relaxation and spectral solvers · explicit provenance</strong>
  </p>

  <p>
    <a href="https://fullmag.mzelent.pl/"><strong>Documentation</strong></a>
    ·
    <a href="https://fullmag.mzelent.pl/frontend/control-room/index.html">Control Room</a>
    ·
    <a href="https://fullmag.mzelent.pl/python-api/index.html">Python API</a>
    ·
    <a href="#quick-start">Quick start</a>
    ·
    <a href="docs/specs/capability-matrix-v0.md">Capability matrix</a>
  </p>
</div>

## Overview

FullMag is active research software for finite-difference (FDM) and finite-element (FEM)
micromagnetics. A model can be authored through the stage-oriented Python API or the Control Room,
lowered to the canonical `ProblemIR`, checked against backend capabilities, and executed as an
ordered study. The runtime records requested and resolved execution settings together with solver
diagnostics and scientific artifacts.

FullMag combines structured and conforming discretizations, CPU and CUDA implementations,
time-domain dynamics, direct relaxation, hysteresis, FEM eigenmodes, driven frequency response,
and interactive 2D/3D analysis in one workflow.

> [!IMPORTANT]
> Support is resolved for a complete execution lane: physics, discretization, device, precision,
> solver, mesh class, and workload. Source code or an API object does not by itself imply
> executable, validated, or production-qualified support. CPU/GPU and FDM/FEM parity is never
> assumed; consult the [capability matrix](docs/specs/capability-matrix-v0.md).

<div align="center">
  <a href="https://fullmag.mzelent.pl/frontend/control-room/index.html">
    <img src="public_docs/site/_static/images/ui/control-room-workspace-overview.png" alt="FullMag Control Room workspace" width="1200" />
  </a>
  <p><sub>Control Room: model authoring, mesh and field inspection, 2D/3D visualization, live analysis, runtime status, and Python export.</sub></p>
</div>

<a id="numerical-engines"></a>

## Numerical engines

| Engine | Best suited to | Main implementation |
|---|---|---|
| **FDM** | Regular films, nanowires, racetracks, disks, pillars, periodic cells, repeated time integration, and disconnected multilayers | Cell-centred Cartesian grids; Newell demagnetization tensors with zero-padded FFTs; Rust/RustFFT CPU paths; C++17/CUDA/cuFFT GPU paths; explicit finite-image PBC and multilayer contracts |
| **FEM** | Curved or irregular 3D bodies, conforming multi-region structures, local refinement, magnetic-plus-air domains, and modal or driven-response studies | Gmsh conforming meshes; C++17/MFEM/hypre/libCEED operators; Poisson Airbox and CPU FEM/BEM demagnetization; bounded CUDA paths and optional PETSc/SLEPc spectral infrastructure |

Each engine owns its mesh, operators, memory layout, dependencies, and validation evidence.
Unsupported combinations fail in `strict` mode instead of being replaced by a hidden backend,
device, or solver fallback.

## Studies and physics

| Area | Current public scope |
|---|---|
| **Time-domain dynamics** | Gilbert LLG with Heun, RK4, RK23, RK45, and bounded lane-specific ABM3/coupled paths |
| **Relaxation** | `llg_overdamped`, tangent projected-gradient Barzilai–Borwein, and Polak–Ribière+ nonlinear conjugate gradient; availability is lane-specific |
| **Hysteresis** | Ordered field schedules built from the same relaxation, stopping, artifact, and provenance contracts |
| **Eigenmodes and dispersion** | Tangent-space linearized-LLG generalized eigenproblems; the public modal contract is FEM, not production FDM |
| **Driven frequency response** | Complex linear response around equilibrium with dense, sparse, Schur, modal, and GPU-oriented planner families; the public response contract is FEM |
| **Interactions** | Exchange, demagnetization, and Zeeman have public FDM and FEM paths. Anisotropy, DMI, thermal fields, STT/SOT, Oersted fields, magnetoelasticity, and transport have explicit lane-specific statuses |
| **Periodic boundaries** | FDM finite-image kernels and bounded FEM periodic/Floquet formulations are separate capabilities with separate validation requirements |
| **Parallel execution** | Current public execution is single-device. `gpu_count > 1` is rejected; CPU threading and GPU residency depend on the resolved lane |

Detailed equations, discretizations, implementation mappings, and validation evidence are maintained
in the [physics](https://fullmag.mzelent.pl/physics/index.html) and
[numerical-methods](https://fullmag.mzelent.pl/numerical-methods/index.html) references.

## Execution model

```text
Python study or Control Room
            │
            ▼
         ProblemIR
            │
            ▼
validation and capability planning
            │
            ▼
 session → run → ordered stages
            │
      ┌─────┴─────┐
      ▼           ▼
     FDM         FEM
      └─────┬─────┘
            ▼
fields, observables, diagnostics, artifacts, and provenance
```

The public authoring contract is `fm.study(...)`. Requested intent and resolved execution remain
separate in provenance. Automatic selection, where available, is recorded as a planner decision
and is not treated as scientific validation.

<a id="quick-start"></a>

## Quick start

The commands in this section install and smoke-test the authoring/runtime
packages. For daily application development with source HMR and persistent
Docker state, use the [Docker development workspace](#docker-development-workspace)
below.

Install the Python authoring layer:

```bash
git clone https://github.com/MateuszZelent/fullmag
cd fullmag
python -m pip install ./packages/fullmag-py
```

Install optional geometry and meshing dependencies when needed:

```bash
python -m pip install "./packages/fullmag-py[meshing]"
```

Run the repository-owned FDM CPU smoke scenario:

```bash
just run-headless examples/fdm_cpu_relax_smoke.py
```

This smoke test verifies the execution path; it is not a convergence or scientific qualification
benchmark. Native FEM/MFEM/hypre/libCEED/CUDA builds use the managed container recipes owned by the
repository `justfile`:

```bash
just ensure-managed-fem-runtime
```

Platform-specific setup is documented in the
[installation guide](https://fullmag.mzelent.pl/getting-started/installation.html).

## Docker development workspace

Recipes are defined in [`justfile`](justfile); run `just --list` from the
selected checkout to list them. The two-service topology, mounts, and network
are defined in [`compose.dev.yaml`](compose.dev.yaml). See the
[Docker development guide](docs/guides/docker-development-architecture.md)
for the detailed architecture and lifecycle contract and
[ADR 0061](docs/adr/0061-docker-development-build-and-runtime-container.md)
for the same-container build and runtime decision.

Each checkout group has two persistent application services: `frontend` and
`backend`. The backend container compiles the selected source using its durable
ext4 cache and then starts API and native runtime in that same container. Its
Docker Desktop Logs show compilation and service startup together. Development
does not use a separate one-shot backend-build container or transfer the built
package through Windows storage. This lifecycle is being integrated; the new
end-to-end startup and controlled restart remain **NOT VERIFIED**.

Daily FullMag development uses the direct Docker Compose workspace. Run the
launcher from native Windows PowerShell with Docker Desktop using Linux
containers and NVIDIA support. WSL is suitable for reading and editing the
checkout, but `scripts/setup_docker.py` and `scripts/docker_dev.py` reject WSL
as the development start path.

Git and a native Windows Python are required. Docker Desktop must use the
Linux engine and Compose; NVIDIA support is required for GPU lanes. `just` is
optional when invoking the native Python CLI directly, but is required by the
`just` recipes and by the complete `setup_docker.py --check` preflight. The
host Python only runs the managed launcher; backend code is compiled inside the
Docker Compose backend service, so host Cargo and CMake are not development
prerequisites.

### Clone, select a checkout, and configure storage

The resolver identifies the project from Git. Keep the main checkout and any
worktrees under one project parent, and keep durable storage outside every
checkout. Replace the placeholder values below with paths on the host:

```powershell
$projectRoot = "C:\path\to\fullmag-project"
$main = "$projectRoot\fullmag"
$worktree = "$projectRoot\worktrees\cofeb-dev"
$storage = "C:\path\to\fullmag-storage"

git clone https://github.com/MateuszZelent/fullmag $main
Set-Location $main
git worktree add $worktree -b codex/cofeb-dev master
git worktree list --porcelain

python -B scripts/setup_docker.py `
  --repo-root $main `
  --storage-root $storage `
  --source-root $worktree `
  --port 3197
python -B scripts/setup_docker.py --repo-root $main --check
```

The setup wizard keeps the existing `.env` comments and secrets, writes the
selected `FULLMAG_PROJECT_STORAGE_ROOT`, source checkout, and frontend port to
the main checkout, and initializes only the validated storage marker. It does
not build images, start containers, stop a running group, or remove data. The
interactive prompts show the values supplied above; accept them only after
checking the displayed paths.

### Start and iterate

Run the commands from the selected checkout. The first command prepares the
pinned toolchain image; the second builds the complete backend in its Compose
service and starts the `backend` and `frontend` services:

```powershell
Set-Location $worktree
just docker-dev-toolchain
just docker-dev "$worktree" 3197
```

The development frontend enables the Node Inspector on container loopback,
without publishing a host debug port or waiting for a debugger to attach. The
frontend log reports the Inspector address. Release processes keep it disabled;
see the [development debugger guide](docs/guides/docker-development-architecture.md#debugger-frontendu-dev).

The equivalent native Python commands are useful when `just` is unavailable:

```powershell
python -B "$main\scripts\bootstrap_docker_toolchain.py" --repo-root $main --direct-development
# Start without a startup script:
python -B "$main\scripts\docker_dev.py" --repo-root $main up --source-root $worktree --port 3197
# Or start with a startup script:
# python -B "$main\scripts\docker_dev.py" --repo-root $main up --source-root $worktree --port 3197 --script "examples/fem_relax_gpu_smoke.py"
```

The `up` command starts the two services. The backend itself checks current
mounted source, builds as needed with its persistent cache, and then starts API.
Open `http://127.0.0.1:3197/workspace` after startup. A startup script without
`study.wait_for_solve(True)` is activated and executed automatically; a script
with that call publishes an interactive workspace waiting for Compute.

The selected checkout must be a Git-registered checkout of this project. Both
services receive the same checkout as a read-only source bind. Frontend edits
are picked up by Next.js HMR; `FULLMAG_WATCHPACK_POLLING_MS` defaults to `5000`
milliseconds and can be set in the main checkout `.env` when Docker Desktop
does not forward Windows file events reliably. Frontend dependencies, Next
output, and watcher state stay in the group cache rather than being written to
the checkout.

After editing backend code, save the project, finish active simulations, and
restart the **backend service in the selected group** in Docker Desktop:

```powershell
docker ps --filter "label=com.docker.compose.project=<compose-project>" --filter "label=com.docker.compose.service=backend"
docker restart <backend-container-id>
docker logs -f <backend-container-id>
```

Every backend start checks the current mounted source and dependencies itself.
Unchanged inputs reuse the existing result; changed modules and their dependants
are compiled incrementally. No separate host manifest refresh, build container,
package transfer, or second startup command is required. The frontend stays
running. With unchanged image and mounts, the backend keeps its container ID.
Changing the image or mount configuration can require service recreation.

Stopping must preserve the native drain and ownership checks. An unconfirmed
owner requires canonical recovery; do not reset it, take over another group,
remove volumes, or restart an active simulation. Cache, sessions, results, and
workspace settings remain durable. The new lifecycle remains **NOT VERIFIED**
until its actual container startup and restart checks are recorded.

An optional third `just docker-dev` argument selects a Python startup script
inside the same checkout. The path is contained, hashed, and recorded in
startup provenance:

```powershell
just docker-dev "$worktree" 3197 `
  "examples/fem_relax_gpu_smoke.py"
```

The referenced example is tracked in this repository. The requested
`examples/permalloy_layer_cofeb_rings_relax_300nm.py` is also tracked, but the
current startup validation rejects this two-material rings example with
`material_count_not_one`; it is not a current FEM GPU smoke proof. A script
that sets `study.wait_for_solve(True)` (for example,
`examples/fem_de_smoke_numeric.py`) publishes an interactive activation that
waits for Compute and does not silently switch from GPU to CPU. A start without
`--script` opens Home and does not select an arbitrary saved session.

### Ports, isolation, and persistence

The frontend binds one manually chosen loopback port, such as
`127.0.0.1:3197`, to its container port `8080`; it never auto-selects a free
port, so each active group needs a unique operator-selected port. The main
checkout uses Compose project `fullmag-master`; a registered worktree uses
`fullmag-worktree-<worktree_id>`. The backend publishes no host port; the
frontend reaches it as `backend:8081` over the private bridge network for the
selected Compose project. Project name, network, port, workspace settings, and
user data are derived per registered checkout, so a worktree does not share a
frontend port or `workspace.db` with the main checkout. The launcher persists sessions,
results, logs, receipts, and build/cache state under the configured storage
resolver; group user data includes `storage/user-data/<compose-project>/workspace.db`.

Do not run a plain `docker compose up` for this workspace. The managed launcher
attests the source bind, package and dependency identities, Windows storage,
host ledger, owner record, startup response, and resolved Compose configuration
before it starts the services. Keep the exact receipts and stop evidence when a
start or build fails.

### Development and release inputs

The default `dev` profile uses Cargo `backend-dev`, `live-shadow-v1`, persistent
incremental cache, and a live source bind for the running services. The backend
build is isolated in a Linux ext4 shadow of the validated source manifest, so a
checkout edit during compilation cannot mix versions; the next backend start
captures current sources itself. Release or frozen inputs use the separate `release`
profile and immutable archive/snapshot path and do not provide the HMR workflow.

The dependency declarations are repository-owned: CUDA, CMake, MFEM, hypre,
libCEED, and the native toolchain are pinned in
`docker/fem-gpu/Dockerfile`; Rust uses `rust-toolchain.toml`, the workspace
Cargo manifests, and the repository-root `Cargo.lock`; Python uses
`packages/fullmag-py/pyproject.toml`; and the Control Room uses
`apps/control-room/package.json` plus the repository-root `pnpm-lock.yaml`.
`just docker-dev-toolchain` consumes these declarations inside Docker. Do not
install a second host toolchain or edit a runtime image by hand for daily dev.

<details>
<summary><strong>Show the FDM CPU relaxation example</strong></summary>

```python
import fullmag as fm

study = fm.study("fdm_cpu_relax_smoke")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=(80e-9, 160e-9, 10e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(5e-9, 5e-9, 5e-9)

film = study.geometry(
    fm.Box(size=(40e-9, 120e-9, 10e-9), name="smoke_box"),
    name="smoke_box",
)
film.Ms = 752000.0
film.Aex = 1.55e-11
film.alpha = 0.1
film.m = fm.texture.uniform(0.0, 1.0, 0.0)

study.demag()
study.b_ext(0.0, 0.0, 1e-3)
study.solver(fix_dt=1e-13, g=2.115)
study.stages.add_relax(
    algorithm="llg_overdamped",
    dt=1e-13,
    tolA=1e-4,
    max_steps=4,
).tableautosave(
    every_steps=1,
    quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"],
)
```

The tracked source is [`examples/fdm_cpu_relax_smoke.py`](examples/fdm_cpu_relax_smoke.py).

</details>

## Repository map

| Path | Responsibility |
|---|---|
| `packages/fullmag-py/` | Public Python API, geometry, materials, interactions, stages, outputs, and lowering |
| `crates/fullmag-ir/` | Canonical backend-neutral `ProblemIR` |
| `crates/fullmag-plan/` | Validation, capability checks, and execution-lane resolution |
| `crates/fullmag-engine/` | Reference and public executable solver logic |
| `backends/`, `native/` | Native FDM/FEM CPU and GPU implementations and ABI |
| `crates/fullmag-api/`, `crates/fullmag-runner/`, `crates/fullmag-cli/` | Sessions, runs, API, CLI, artifacts, and provenance |
| `apps/control-room/` | Next.js/React/TypeScript Control Room with Three.js and ECharts |
| `public_docs/site/` | Sphinx/MyST public documentation |
| `tests/`, `tests/standard_problems/` | Unit, regression, parity, benchmark, and standard-problem cases |

The supporting stack includes Python/NumPy/Zarr/HDF5, Rust/Axum/Tokio/PyO3,
C++17/CUDA/cuFFT, Gmsh/MFEM/hypre/libCEED, and optional PETSc/SLEPc. Exact
repository-declared versions are shown below.

## Documentation and validation

Use the public documentation as the user-facing and scientific reference:

- [Getting started](https://fullmag.mzelent.pl/getting-started/index.html)
- [Control Room](https://fullmag.mzelent.pl/frontend/index.html)
- [Python API](https://fullmag.mzelent.pl/python-api/index.html)
- [Physics](https://fullmag.mzelent.pl/physics/index.html)
- [Numerical methods](https://fullmag.mzelent.pl/numerical-methods/index.html)
- [Validation](https://fullmag.mzelent.pl/validation/index.html)
- [Architecture](https://fullmag.mzelent.pl/architecture/index.html)

Internal plans, audits, and engineering notes under `docs/` are not automatically part of the
public contract.

<!-- fullmag-version-dashboard:start -->
<a id="version-dashboard"></a>

## Version and compatibility dashboard

The badges below are generated from repository-owned manifests. They distinguish exact
toolchain pins from supported dependency ranges; `contract-guard` fails when this README
no longer matches the source files.

<p align="center">
  <strong>Continuous verification</strong><br />
  <a href="https://github.com/MateuszZelent/fullmag/actions/workflows/contract-guard.yml"><img alt="contract-guard" src="https://github.com/MateuszZelent/fullmag/actions/workflows/contract-guard.yml/badge.svg?branch=master" /></a>
  <a href="https://github.com/MateuszZelent/fullmag/actions/workflows/react-doctor.yml"><img alt="React Doctor" src="https://github.com/MateuszZelent/fullmag/actions/workflows/react-doctor.yml/badge.svg?branch=master" /></a>
  <a href="https://github.com/MateuszZelent/fullmag/actions/workflows/documentation.yml"><img alt="Public documentation" src="https://github.com/MateuszZelent/fullmag/actions/workflows/documentation.yml/badge.svg?branch=master" /></a>
</p>

<p align="center">
  <strong>Core toolchain</strong><br />
  <a href="Cargo.toml"><img alt="FullMag v0.1.0" src="https://img.shields.io/badge/FullMag-v0.1.0-2563EB?style=for-the-badge" /></a>
  <a href="packages/fullmag-py/pyproject.toml"><img alt="Python &gt;=3.10" src="https://img.shields.io/badge/Python-%3E%3D3.10-3776AB?style=for-the-badge&amp;logo=python&amp;logoColor=white" /></a>
  <a href=".node-version"><img alt="Node.js 24.18.0" src="https://img.shields.io/badge/Node.js-24.18.0-339933?style=for-the-badge&amp;logo=nodedotjs&amp;logoColor=white" /></a>
  <a href="rust-toolchain.toml"><img alt="Rust stable | edition 2021" src="https://img.shields.io/badge/Rust-stable%20%7C%20edition%202021-000000?style=for-the-badge&amp;logo=rust&amp;logoColor=white" /></a>
  <a href="docker/fem-gpu/Dockerfile"><img alt="CUDA 12.4.1" src="https://img.shields.io/badge/CUDA-12.4.1-76B900?style=for-the-badge&amp;logo=nvidia&amp;logoColor=white" /></a>
  <a href="docker/fem-gpu/Dockerfile"><img alt="CMake 3.30.5" src="https://img.shields.io/badge/CMake-3.30.5-064F8C?style=for-the-badge&amp;logo=cmake&amp;logoColor=white" /></a>
  <a href="docker/fem-gpu/Dockerfile"><img alt="pnpm 10.8.1" src="https://img.shields.io/badge/pnpm-10.8.1-F69220?style=for-the-badge&amp;logo=pnpm&amp;logoColor=white" /></a>
</p>

<p align="center">
  <strong>Scientific backends</strong><br />
  <a href="docker/fem-gpu/Dockerfile"><img alt="MFEM 4.10" src="https://img.shields.io/badge/MFEM-4.10-5B6EC4?style=for-the-badge" /></a>
  <a href="docker/fem-gpu/Dockerfile"><img alt="hypre 3.1.0" src="https://img.shields.io/badge/hypre-3.1.0-6B7280?style=for-the-badge" /></a>
  <a href="docker/fem-gpu/Dockerfile"><img alt="libCEED 0.12.0" src="https://img.shields.io/badge/libCEED-0.12.0-7C3AED?style=for-the-badge" /></a>
  <a href="Cargo.toml"><img alt="PyO3 0.29" src="https://img.shields.io/badge/PyO3-0.29-FFD43B?style=for-the-badge&amp;logo=rust&amp;logoColor=000000" /></a>
  <a href="packages/fullmag-py/pyproject.toml"><img alt="NumPy &gt;=1.24,&lt;3" src="https://img.shields.io/badge/NumPy-%3E%3D1.24%2C%3C3-013243?style=for-the-badge&amp;logo=numpy&amp;logoColor=white" /></a>
  <a href="packages/fullmag-py/pyproject.toml"><img alt="Gmsh &gt;=4.12,&lt;5" src="https://img.shields.io/badge/Gmsh-%3E%3D4.12%2C%3C5-5B6EC4?style=for-the-badge" /></a>
</p>

<p align="center">
  <strong>Control Room</strong><br />
  <a href="apps/control-room/package.json"><img alt="Next.js 16.3.8" src="https://img.shields.io/badge/Next.js-16.3.8-000000?style=for-the-badge&amp;logo=nextdotjs&amp;logoColor=white" /></a>
  <a href="apps/control-room/package.json"><img alt="React 19.2.4" src="https://img.shields.io/badge/React-19.2.4-20232A?style=for-the-badge&amp;logo=react&amp;logoColor=61DAFB" /></a>
  <a href="apps/control-room/package.json"><img alt="TypeScript npm:@typescript/typescript6@6.0.2" src="https://img.shields.io/badge/TypeScript-npm%3A%40typescript%2Ftypescript6%406.0.2-3178C6?style=for-the-badge&amp;logo=typescript&amp;logoColor=white" /></a>
  <a href="apps/control-room/package.json"><img alt="Three.js ^0.186.1" src="https://img.shields.io/badge/Three.js-%5E0.186.1-000000?style=for-the-badge&amp;logo=threedotjs&amp;logoColor=white" /></a>
  <a href="apps/control-room/package.json"><img alt="ECharts ^6.1.0" src="https://img.shields.io/badge/ECharts-%5E6.1.0-AA344D?style=for-the-badge&amp;logo=apacheecharts&amp;logoColor=white" /></a>
  <a href="Cargo.toml"><img alt="Tauri 2.11.1" src="https://img.shields.io/badge/Tauri-2.11.1-24C8DB?style=for-the-badge&amp;logo=tauri&amp;logoColor=000000" /></a>
</p>

<details>
<summary><strong>Version policy and sources of truth</strong></summary>

| Contract | Current manifest value | Source of truth | Policy |
|---|---|---|---|
| FullMag packages | `0.1.0` | `Cargo.toml`, `packages/fullmag-py/pyproject.toml`, `apps/control-room/package.json` | package versions must agree |
| Core toolchain | Python `>=3.10`; Node `24.18.0`; Rust `stable` / edition `2021` | `pyproject.toml`, `.node-version`, `rust-toolchain.toml`, `Cargo.toml` | compatibility range or pinned channel/version |
| Managed FEM/GPU bundle | CUDA `12.4.1`; CMake `3.30.5`; MFEM `4.10`; hypre `3.1.0`; libCEED `0.12.0` | `docker/fem-gpu/Dockerfile` | exact reproducible build pins |
| Python scientific API | NumPy `>=1.24,<3`; Zarr `>=2.18,<4`; h5py `>=3.9,<4`; Gmsh `>=4.12,<5` | `packages/fullmag-py/pyproject.toml` | declared compatibility ranges |
| Control Room direct stack | Next.js `16.3.8`; React `19.2.4`; TypeScript `npm:@typescript/typescript6@6.0.2`; Three.js `^0.186.1`; ECharts `^6.1.0` | `apps/control-room/package.json`, repository-root `pnpm-lock.yaml` | direct constraints; complete transitive resolution is pinned in the repository-root lockfile |
| Rust/Python and desktop bridge | PyO3 `0.29`; Tauri `2.11.1` | `Cargo.toml`, repository-root `Cargo.lock` | workspace dependency constraints and resolved dependencies |

Regenerate after changing a version source:

```bash
python3 scripts/update_readme_version_dashboard.py --write
```

</details>
<!-- fullmag-version-dashboard:end -->

## Contributing

Read [`AGENTS.md`](AGENTS.md) before changing the repository. A capability change should update the
relevant authoring API, `ProblemIR`, planner data, executable backend, tests, validation evidence,
and public documentation. Capability claims must name their backend, device, precision, mode,
solver, mesh, and workload scope.

## Citation and authors

Until a versioned release with a persistent identifier is available, cite the repository and the
exact commit used for the reported result:

> M. Zelent, M. Gołebiewski, and P. Pirro, *FullMag: a computational framework for reproducible finite-difference and finite-element micromagnetics*, research software, 2026. Repository: [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag). Documentation: [fullmag.mzelent.pl](https://fullmag.mzelent.pl/).

<details>
<summary><strong>BibTeX</strong></summary>

```bibtex
@software{fullmag_2026,
  author = {Zelent, Mateusz and Gołebiewski, Mateusz and Pirro, Philipp},
  title  = {FullMag: A Computational Framework for Reproducible
            Finite-Difference and Finite-Element Micromagnetics},
  year   = {2026},
  url    = {https://github.com/MateuszZelent/fullmag},
  note   = {Research software; cite the exact release or commit used}
}
```

</details>

| Author | Affiliation |
|---|---|
| Dr Mateusz Zelent | Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany |
| Dr Mateusz Gołebiewski | Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland |
| Prof. Philipp Pirro | Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany |

Project coordination: **Mateusz Zelent, RPTU Kaiserslautern-Landau**.

## License

The repository does not currently contain a root-level license file. Contact the project
coordinator before reuse or redistribution.

## Funding

Mateusz Zelent acknowledges funding from the European Union's Horizon Europe programme under
HORIZON-MSCA-2024-PF-01, Marie Skłodowska-Curie Grant Agreement No. **101208951 (CNMA)**.
