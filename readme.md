# FullMag

<a id="readme-top"></a>

<div align="center">
  <a href="https://fullmag.mzelent.pl/">
    <img src="docs/fullmag-logo-traced-optimized.svg" alt="FullMag logo" width="160" />
  </a>

  <h2>FDM and FEM micromagnetics with Python, CPU/CUDA solvers, and an interactive Control Room</h2>

  <p>
    <strong>One study model · multiple numerical engines · interactive live Python (<code>fullmag.live</code>) · Control Room v2 · explicit provenance</strong>
  </p>

  <p>
    <a href="https://pypi.org/project/fullmag/"><img alt="PyPI fullmag" src="https://img.shields.io/badge/PyPI-pip_install_fullmag-3775A9?style=for-the-badge&amp;logo=pypi&amp;logoColor=white" /></a>
    <a href="https://fullmag.mzelent.pl/"><img alt="Public Documentation" src="https://img.shields.io/badge/Docs-fullmag.mzelent.pl-1E66F5?style=for-the-badge" /></a>
    <a href="https://fullmag.mzelent.pl/acknowledgements/index.html"><img alt="EU Horizon Europe MSCA Grant 101208951 CNMA" src="https://img.shields.io/badge/EU_Horizon_Europe-MSCA_101208951_(CNMA)-003399?style=for-the-badge" /></a>
    <a href="LICENSE"><img alt="License GPL-3.0-or-later" src="https://img.shields.io/badge/License-GPL--3.0--or--later-40A02B?style=for-the-badge" /></a>
  </p>

  <p>
    <a href="https://fullmag.mzelent.pl/"><strong>Documentation</strong></a>
    ·
    <a href="https://pypi.org/project/fullmag/"><strong>PyPI (<code>fullmag</code>)</strong></a>
    ·
    <a href="https://fullmag.mzelent.pl/getting-started/interactive-python.html"><strong>Live Python (<code>fm.connect()</code>)</strong></a>
    ·
    <a href="https://fullmag.mzelent.pl/frontend/control-room/index.html"><strong>Control Room v2</strong></a>
    ·
    <a href="https://fullmag.mzelent.pl/python-api/index.html"><strong>Python API</strong></a>
    ·
    <a href="https://fullmag.mzelent.pl/acknowledgements/index.html"><strong>Acknowledgements &amp; EU Grant</strong></a>
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
    <img src="public_docs/site/_static/images/ui/control-room-workspace-overview.png" alt="FullMag Control Room v2 workspace overview" width="1200" />
  </a>
  <p><sub><strong>Control Room v2 (Catppuccin Mocha dark theme):</strong> unified FDM/FEM authoring, semantic explorer, interactive 3D Studio &amp; 2D planar field views, live spectral telemetry, and canonical Python script export.</sub></p>
</div>

| Catppuccin Latte Light Theme | Start Screen Hub (`/home`) &amp; Compute Rail |
|---|---|
| ![Control Room Latte Light Theme](public_docs/site/_static/images/ui/control-room-light-latte-overview.png) | ![Start Screen Hub Overview](public_docs/site/_static/images/ui/start-screen-hub-overview.png) |
| **Benchmark &amp; Study Template Library** | **Multi-Instance Session Tabs (`/session/<slug>`)** |
| ![Start Screen Model Templates](public_docs/site/_static/images/ui/start-screen-model-templates.png) | ![Multi-Instance Session Tabs](public_docs/site/_static/images/ui/multi-instance-session-tabs.png) |

## What's new in FullMag (2026)

| Area | Highlights | Reference |
|---|---|---|
| **PyPI `fullmag` package** | Pure-Python DSL + HTTP/WebSocket live client installable via `pip install fullmag` or `uv add fullmag` with `[meshing]`, `[figures]`, `[jupyter]` extras | [PyPI `fullmag`](https://pypi.org/project/fullmag/) |
| **Interactive Live Python (`fullmag.live`)** | Attach REPLs, scripts, or Jupyter notebooks with `fm.connect()` while Control Room updates live; transactional edits (`fm.transaction()`), conditional `fm.run_until()`, binary `FMVP`/`FMTB` field/table readback, and 10 s presence heartbeats | [Live Python guide](https://fullmag.mzelent.pl/getting-started/interactive-python.html) |
| **Control Room v2 Workspace** | Unified Start Screen (`/home`), per-session tabs (`/session/<slug>`), domain Ribbon (`File -> Save canonical copy as...`), `Ctrl+Shift+P` Command Search, 5-tab Semantic Explorer, and Latte/Mocha themes | [Control Room v2](https://fullmag.mzelent.pl/frontend/control-room/index.html) |
| **Dedicated Semantic Inspectors** | Draft/Apply isolation across purpose-built panels for CSG Geometry, Materials &amp; Regions, Magnetic Textures, Physics/Couplings/Frozen Spins, RF Antennas &amp; Sinc Waveforms, SOT/STT Spin Transport, FEM Airbox &amp; Study Stage re-execution | [Semantic Inspectors](https://fullmag.mzelent.pl/frontend/inspectors/index.html) |
| **3D Studio, 2D Planar &amp; Spectral Views** | Three.js HDRI Studio PNG export, Poisson Airbox FEM mesh cutaway, reworked 2D Planar Field Map (streamlines, contours, line profiles, multi-slice), plus live ECharts time series, hysteresis playback, eigenmode dispersion, and FMR spectra | [Visualization UI](https://fullmag.mzelent.pl/frontend/visualization/index.html) |

<a id="quick-start"></a>

## Quick start: PyPI package &amp; interactive Live Python (`fullmag.live`)

Install the public Python authoring library and live HTTP/WebSocket client directly from
[PyPI (`fullmag`)](https://pypi.org/project/fullmag/):

```bash
pip install fullmag
# or with uv
uv add fullmag          # inside a uv project
uv pip install fullmag  # into an active virtual environment
```

Optional extras add FEM geometry and Gmsh/manifold/trimesh meshing (`meshing`), image-based
textures (`figures`), and Jupyter notebook live monitoring (`jupyter`):

```bash
pip install "fullmag[meshing,figures,jupyter]"
```

The PyPI distribution provides `fm.study(...)`, `ProblemIR` lowering, FEM mesh authoring, and the
live session client `fm.connect()`. Native FDM/FEM solver binaries execute inside the repository
[Docker Compose development workspace](#docker-development-workspace). For editable development from source:

```bash
git clone https://github.com/MateuszZelent/fullmag
cd fullmag
python -m pip install "./packages/fullmag-py[meshing,jupyter]"
```

### Interactive Live Python (`fm.connect()`)

With a Docker Compose DEV group running (`just docker-dev "$PWD"`), drive the live workspace from a
Python REPL, script, or Jupyter notebook and watch every scene edit, field update, and scalar sample
in Control Room:

```python
import fullmag as fm

fm.connect("http://127.0.0.1:3197")  # or read $FULLMAG_URL
fm.engine("fdm")
fm.device("cpu", precision="double")
fm.cell(5e-9, 5e-9, 10e-9)
fm.solver(fix_dt=1e-13)

film = fm.geometry(fm.Box(200e-9, 100e-9, 10e-9, name="film"), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.5
film.m = fm.texture.uniform(1, 1, 0)

fm.relax(dt=1e-13, tolT=1e-4, max_steps=1_000)

with fm.transaction():
    film.alpha = 0.02
    fm.b_ext(0.05, 0.0, 0.0)

fm.run_until(
    lambda s: s.table("scalars", columns=("mx",)).column("mx")[-1] < 0.5,
    chunk_time=10e-12,
    max_time=500e-12,
)
m = fm.field("m").to_numpy()       # (point_count, 3) binary FMVP readback
grid = fm.field("m").as_grid()     # structured FDM grid readback
script_py = fm.export_script()     # canonical reproducible script from live session
fm.disconnect()
```

| Active Live Python Session (`fm.connect()` + Heartbeat) | Canonical Python Script Export (`File` Menu) |
|---|---|
| ![Start Screen Python Live Connect](public_docs/site/_static/images/ui/start-screen-python-live-connect.png) | ![Control Room File menu Save canonical copy as](public_docs/site/_static/images/ui/ribbon-tabs-automation-python.png) |

See the [Interactive Live Python &amp; REPL guide](https://fullmag.mzelent.pl/getting-started/interactive-python.html),
[`live-session` API reference](https://fullmag.mzelent.pl/python-api/runtime/live-session.html), and
[`examples/live`](examples/live) (`fm.on`, `fullmag.live.jupyter.monitor`, `fm.sweep`).

<details>
<summary><strong>Show canonical stage-first batch study example (<code>fm.study(...)</code>)</strong></summary>

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

Tracked source: [`examples/fdm_cpu_relax_smoke.py`](examples/fdm_cpu_relax_smoke.py). Run inside your
Docker DEV group with `just fullmag-dev-container examples/fdm_cpu_relax_smoke.py` or `just docker-dev-script examples/fdm_cpu_relax_smoke.py`.

</details>

## Control Room v2 &amp; semantic inspectors

Control Room v2 organizes authoring around a unified session workspace: domain **Ribbon** tabs,
global **Command Search (`Ctrl+Shift+P`)**, a **5-tab Explorer** (`Model`, `Resources`, `Results`,
`Jobs`, `Diagnostics`), and dedicated **Semantic Inspectors** with Draft/Apply transaction isolation.

| Geometry Ribbon Tab | Physics &amp; Interactions Ribbon Tab |
|---|---|
| ![Geometry Ribbon Tab](public_docs/site/_static/images/ui/ribbon-tabs-geometry.png) | ![Physics Ribbon Tab](public_docs/site/_static/images/ui/ribbon-tabs-physics.png) |
| **Command Search (`Ctrl+Shift+P`)** | **Semantic Model Explorer Tree** |
| ![Command Search Palette](public_docs/site/_static/images/ui/command-palette-ctrl-k.png) | ![Explorer Tree Structure](public_docs/site/_static/images/ui/explorer-tree-structure.png) |
| **Primitive Geometry &amp; CSG Inspector** | **Materials &amp; Regions Inspector** |
| ![Primitive Geometry Inspector](public_docs/site/_static/images/ui/inspector-geometry-and-csg.png) | ![Materials and Regions Inspector](public_docs/site/_static/images/ui/inspector-material-and-regions.png) |
| **Magnetic Texture Inspector** | **RF Antenna &amp; Sinc Waveforms Inspector** |
| ![Magnetic Texture Inspector](public_docs/site/_static/images/ui/inspector-magnetic-texture.png) | ![RF Antenna and Waveforms Inspector](public_docs/site/_static/images/ui/inspector-antenna-rf-and-waveforms.png) |
| **Spin Transport (`SOT` / `STT`) Inspector** | **Study Stages &amp; Interactive Re-Execution** |
| ![Spin Transport SOT STT Inspector](public_docs/site/_static/images/ui/inspector-spin-transport-sot-stt.png) | ![Study Stages and Rerun Inspector](public_docs/site/_static/images/ui/inspector-study-stages-and-rerun.png) |
| **Inspector Draft Isolation** | **Footer Telemetry &amp; Diagnostics Bar** |
| ![Inspector Draft Mode](public_docs/site/_static/images/ui/inspector-panel-draft.png) | ![Footer Status Bar](public_docs/site/_static/images/ui/status-bar-footer.png) |

## 3D Studio viewport, 2D planar field maps &amp; spectral analysis

Real-time WebGL visualization pairs Three.js vector-field and conforming FEM airbox rendering with
the reworked 2D planar section analyzer, live ECharts telemetry, hysteresis playback, linearized-LLG
eigenmode dispersion, FMR spectra, and cross-run saved results comparison.

| 3D Interactive Viewport &amp; Vector Glyphs | 3D Studio HDRI Lighting &amp; Publication Export |
|---|---|
| ![Interactive 3D Viewport](public_docs/site/_static/images/ui/viewport-3d-interactive.png) | ![Studio Rendering Mode](public_docs/site/_static/images/ui/viewport-3d-studio-rendering.png) |
| **FEM Conformal Mesh &amp; Poisson Airbox** | **Spatial Eigenmode Profile Visualization** |
| ![3D FEM Mesh and Airbox](public_docs/site/_static/images/ui/viewport-3d-fem-mesh-airbox.png) | ![Eigenmode Spatial Profile](public_docs/site/_static/images/ui/viewport-3d-eigenmode-spatial-profile.png) |
| **2D Planar Field Map &amp; Section Plane** | **2D Streamlines, Contours &amp; Overlay Tools** |
| ![2D Planar Field Map](public_docs/site/_static/images/ui/planar-2d-field-map-overview.png) | ![Planar 2D Streamlines and Contours](public_docs/site/_static/images/ui/planar-2d-streamlines-and-contours.png) |
| **Live Time-Series Telemetry** | **Hysteresis Loop Interactive Playback** |
| ![Live Time-Series Charts](public_docs/site/_static/images/ui/charts-live-time-series.png) | ![Hysteresis Loop Playback](public_docs/site/_static/images/ui/charts-hysteresis-loop-playback.png) |
| **Spin-Wave Dispersion &amp; FMR Spectrum** | **Saved Results Navigator &amp; Comparison** |
| ![Dispersion and FMR Spectrum](public_docs/site/_static/images/ui/charts-dispersion-and-fmr-spectrum.png) | ![Saved Results Navigator](public_docs/site/_static/images/ui/results-saved-navigator-comparison.png) |

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

<a id="docker-development-workspace"></a>

### Live control from Python and Jupyter

A plain Python process, an interactive interpreter or a Jupyter kernel can drive a running
Fullmag instance. After `fm.connect()` every DSL call that changes the model is committed to the
current session of a [Docker DEV group](#docker-development-workspace) at once, the Control Room
shows each change, and `fm.relax()` / `fm.run()` become runtime commands whose results come back
as numpy arrays:

```python
import fullmag as fm

fm.connect("http://127.0.0.1:3197")   # or set FULLMAG_URL
fm.engine("fdm")
fm.device("cpu")
fm.cell(5e-9, 5e-9, 10e-9)
fm.solver(fix_dt=1e-13)
layer = fm.geometry(fm.Box(400e-9, 100e-9, 10e-9), name="layer")
layer.Ms, layer.Aex, layer.alpha = 800e3, 13e-12, 0.02
layer.m = fm.texture.uniform(1, 0.1, 0)
fm.relax(dt=1e-13, tolT=1e-5, max_steps=20_000)
print(fm.m.average())
m = fm.field("m").to_numpy()
```

[`examples/live/`](examples/live/) holds runnable scripts, each with a matching Jupyter notebook
(`.ipynb`): FDM relaxation and field readout, FEM Airbox demagnetizing fields, transactions and
dynamics, a parameter sweep, and a live Jupyter monitor (`pip install "./packages/fullmag-py[jupyter]"`).
Run one against a started group with
`FULLMAG_URL=http://127.0.0.1:<port> python examples/live/01_fdm_relax_read_m.py`. The contract,
parameters and failure semantics are documented in
[Live Session](https://fullmag.mzelent.pl/python-api/runtime/live-session.html).

## Docker development workspace

FullMag builds and runs natively inside a per-checkout Docker Compose DEV group (`backend` +
`frontend`, isolated per [ADR 0067](docs/adr/0067-docker-dev-group-isolation.md) and
[ADR 0076](docs/adr/0076-single-private-volume-per-dev-group.md)):

- **Recommended checkout location**: ext4 inside WSL2 (e.g. `~/git/fullmag/fullmag`) for native
  `inotify` Next.js HMR and fast source capture; Windows NTFS checkouts work through Docker Desktop's
  `desktop-linux` context (`just docker-dev`).
- **One-time host storage &amp; port wizard**:

```bash
python3 -B scripts/setup_docker.py         # PowerShell: python -B scripts\setup_docker.py
python3 -B scripts/setup_docker.py --check
```

- **Start the container toolchain, backend runtime, and Control Room v2**:

```bash
just docker-dev-toolchain                  # prepare pinned C++/CUDA/MFEM/hypre/libCEED image
just docker-dev "$PWD"                     # start backend + Control Room; prints hub URL (/home)
just docker-dev-script examples/fdm_cpu_relax_smoke.py
```

- **Multi-instance routing**: `backend` serves the API on container port `8081`; `frontend` opens
  the Start Screen at `/home` and per-instance workspaces at `/session/<slug>` (preserving `workspace.db`
  and user runs in `FULLMAG_PROJECT_STORAGE_ROOT`, while build caches stay in Docker named volumes).

See [`justfile`](justfile), [`compose.dev.yaml`](compose.dev.yaml),
[Docker development architecture](docs/guides/docker-development-architecture.md),
[Linux/WSL setup](docs/guides/docker-setup-linux-wsl.md),
[Docker build and storage lifecycle](docs/guides/docker-build-storage-lifecycle.md), and
[Installation guide](https://fullmag.mzelent.pl/getting-started/installation.html).

## Repository map

| Path | Responsibility |
|---|---|
| `packages/fullmag-py/` | Public PyPI Python API (`fullmag`), `fullmag.live`, geometry, materials, stages, and lowering |
| `crates/fullmag-ir/` | Canonical backend-neutral `ProblemIR` |
| `crates/fullmag-plan/` | Validation, capability checks, and execution-lane resolution |
| `crates/fullmag-engine/` | Reference and public executable solver logic |
| `backends/`, `native/` | Native FDM/FEM CPU and CUDA implementations and ABI |
| `crates/fullmag-api/`, `crates/fullmag-runner/`, `crates/fullmag-cli/` | Sessions, runs, API, live WebSocket gateway, artifacts, and provenance |
| `apps/control-room/` | Control Room v2 (Next.js / React / TypeScript / Three.js / ECharts) |
| `public_docs/site/` | Sphinx/MyST public documentation (`fullmag.mzelent.pl`) |
| `tests/`, `tests/standard_problems/` | Unit, regression, parity, benchmark, and `µMAG` standard-problem cases |
| `external_solvers/` | Reference upstream solvers used for clean-room traceability and independent cross-validation |

## Documentation and validation

Use the public documentation as the user-facing and scientific reference:

- [Getting started](https://fullmag.mzelent.pl/getting-started/index.html) &amp; [Interactive Live Python](https://fullmag.mzelent.pl/getting-started/interactive-python.html)
- [Control Room v2 &amp; Semantic Inspectors](https://fullmag.mzelent.pl/frontend/index.html)
- [Python API](https://fullmag.mzelent.pl/python-api/index.html)
- [Physics](https://fullmag.mzelent.pl/physics/index.html) &amp; [Numerical methods](https://fullmag.mzelent.pl/numerical-methods/index.html)
- [Validation](https://fullmag.mzelent.pl/validation/index.html)
- [Acknowledgements, EU Grant &amp; Citations](https://fullmag.mzelent.pl/acknowledgements/index.html)

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
  <a href="apps/control-room/package.json"><img alt="Next.js 16.4.6" src="https://img.shields.io/badge/Next.js-16.4.6-000000?style=for-the-badge&amp;logo=nextdotjs&amp;logoColor=white" /></a>
  <a href="apps/control-room/package.json"><img alt="React 19.3.1" src="https://img.shields.io/badge/React-19.3.1-20232A?style=for-the-badge&amp;logo=react&amp;logoColor=61DAFB" /></a>
  <a href="apps/control-room/package.json"><img alt="TypeScript npm:@typescript/typescript6@6.0.2" src="https://img.shields.io/badge/TypeScript-npm%3A%40typescript%2Ftypescript6%406.0.2-3178C6?style=for-the-badge&amp;logo=typescript&amp;logoColor=white" /></a>
  <a href="apps/control-room/package.json"><img alt="Three.js ^0.187.0" src="https://img.shields.io/badge/Three.js-%5E0.187.0-000000?style=for-the-badge&amp;logo=threedotjs&amp;logoColor=white" /></a>
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
| Control Room direct stack | Next.js `16.4.6`; React `19.3.1`; TypeScript `npm:@typescript/typescript6@6.0.2`; Three.js `^0.187.0`; ECharts `^6.1.0` | `apps/control-room/package.json`, repository-root `pnpm-lock.yaml` | direct constraints; complete transitive resolution is pinned in the repository-root lockfile |
| Rust/Python and desktop bridge | PyO3 `0.29`; Tauri `2.11.1` | `Cargo.toml`, repository-root `Cargo.lock` | workspace dependency constraints and resolved dependencies |

Regenerate after changing a version source:

```bash
python3 scripts/update_readme_version_dashboard.py --write
```

</details>
<!-- fullmag-version-dashboard:end -->

## Scientific heritage and related micromagnetic packages

FullMag is an independent clean-room platform whose workflows, physical conventions, numerical
abstractions, and cross-validation benchmarks draw direct inspiration from foundational open-source
micromagnetics and spintronics software (reference repositories tracked under `external_solvers/` for
traceability and independent comparison):

| Package | Contribution &amp; how it informs FullMag | Key citation |
|---|---|---|
| **[MuMax3](https://mumax.github.io/)** (`mumax³`) | Pioneering GPU finite-difference LLG engine, Newell FFT demagnetization, and analytical texture presets | A. Vansteenkiste et al., *AIP Advances* **4**, 107133 (2014), [doi:10.1063/1.4899186](https://doi.org/10.1063/1.4899186) |
| **[Amumax](https://github.com/MathieuMoalic/amumax)** | Python-oriented MuMax3 fork with Zarr (`pyzfn`) data bundles and browser WebUI enhancements | M. Moalic et al., <https://github.com/MathieuMoalic/amumax> |
| **[mumax⁺](https://github.com/mumax/plus)** (`mumax+`) | Extensible C++/CUDA/Python micromagnetic and multiphysics framework | L. Moreels et al., *npj Comput. Mater.* (2026), [doi:10.1038/s41524-025-01893-y](https://doi.org/10.1038/s41524-025-01893-y) |
| **[Boris Computational Spintronics](https://boris-spintronics.uk/)** | Multi-mesh micromagnetics, multilayered demagnetization convolution, and 3D spin transport (`STT`/`SOT`/`SHE`) | S. Lepadatu, *J. Appl. Phys.* **128**, 243902 (2020); *J. Appl. Phys.* **126**, 103903 (2019), [doi:10.1063/1.5116754](https://doi.org/10.1063/1.5116754); *Sci. Rep.* **7**, 12937 (2017); *J. Appl. Phys.* **134**, 163903 (2023), [doi:10.1063/5.0172657](https://doi.org/10.1063/5.0172657) |
| **[OOMMF](https://math.nist.gov/oommf/)** | NIST's reference finite-difference micromagnetics suite and `µMAG` standard benchmarks | M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376 (1999) |
| **[TetraX](https://www.tetrax.software/)** | Finite-element dynamic-matrix spin-wave dispersion ($\omega(k)$) and magnonic eigenmodes | L. Körber et al., *AIP Advances* **11**, 095006 (2021), [doi:10.1063/5.0054169](https://doi.org/10.1063/5.0054169); Rodare (2022), [doi:10.14278/rodare.1418](https://doi.org/10.14278/rodare.1418) |
| **[Tetmag](https://github.com/R-Hertel/tetmag)** | Conforming tetrahedral finite-element micromagnetics and open-boundary `FEM/BEM` magnetostatics | R. Hertel, <https://github.com/R-Hertel/tetmag> |
| **[NeuralMag](https://gitlab.com/neuralmag/neuralmag)** | Nodal finite-difference micromagnetics with symbolic/modular Python composition | C. Abert et al., *npj Comput. Mater.* **11**, 193 (2025), [doi:10.1038/s41524-025-01688-1](https://doi.org/10.1038/s41524-025-01688-1) |

Core scientific libraries used directly in FullMag's FEM, meshing, and spectral backends include
**MFEM** ([doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009)),
**Gmsh** ([doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579)), **hypre**, **libCEED**, and
**PETSc / SLEPc** (*ACM Trans. Math. Softw.* **31**, 351–362, 2005). Complete attributions,
algorithmic lineage, and BibTeX references appear on the
[Acknowledgements &amp; EU Grant page](https://fullmag.mzelent.pl/acknowledgements/index.html).

## Contributing

Read [`AGENTS.md`](AGENTS.md) before changing the repository. A capability change should update the
relevant authoring API, `ProblemIR`, planner data, executable backend, tests, validation evidence,
and public documentation. Capability claims must name their backend, device, precision, mode,
solver, mesh, and workload scope.

## Citation and authors

Until a versioned release with a persistent identifier is available, cite the repository and the
exact commit used for the reported result (together with the installed [`fullmag`](https://pypi.org/project/fullmag/) PyPI package version when applicable):

> M. Zelent, M. Gołebiewski, U. Makartsou, and P. Pirro, *FullMag: a computational framework for reproducible finite-difference and finite-element micromagnetics*, research software, 2026. Repository: [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag). Documentation: [fullmag.mzelent.pl](https://fullmag.mzelent.pl/).

<details>
<summary><strong>BibTeX</strong></summary>

```bibtex
@software{fullmag_2026,
  author = {Zelent, Mateusz and Gołebiewski, Mateusz and Makartsou, Uladzislau and Pirro, Philipp},
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
| Uladzislau Makartsou | Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland |
| Prof. Philipp Pirro | Fachbereich Physik and Landesforschungszentrum OPTIMAS, RPTU Kaiserslautern-Landau, Germany |

Project coordination: **Mateusz Zelent, RPTU Kaiserslautern-Landau**.

## License

FullMag is free software, licensed under the GNU General Public License, version 3 or any later version (`GPL-3.0-or-later`). The full text is in the LICENSE file at
the repository root; the `fullmag` Python package ships the same text.

## Funding and EU grant acknowledgement

Mateusz Zelent acknowledges funding from the European Union's Horizon Europe programme under
HORIZON-MSCA-2024-PF-01, Marie Skłodowska-Curie Grant Agreement No. **101208951 (CNMA)**.

| Programme | Action | Grant Agreement | Project | Host Institution |
|---|---|---|---|---|
| European Union — **Horizon Europe** | Marie Skłodowska-Curie Actions (`HORIZON-MSCA-2024-PF-01`) | `101208951` | **CNMA** | Fachbereich Physik &amp; OPTIMAS, RPTU Kaiserslautern-Landau |

> [!NOTE]
> **European Union Disclaimer:** Funded by the European Union. Views and opinions expressed are
> however those of the author(s) only and do not necessarily reflect those of the European Union or
> the European Research Executive Agency (REA). Neither the European Union nor the granting
> authority can be held responsible for them. See also the public
> [Acknowledgements page](https://fullmag.mzelent.pl/acknowledgements/index.html).
