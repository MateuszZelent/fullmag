# FullMag

<a id="readme-top"></a>

<div align="center">
  <a href="https://fullmag.mzelent.pl/">
    <img src="docs/fullmag-logo-traced-optimized.svg" alt="FullMag logo" width="160" />
  </a>

  <h2 align="center">A unified micromagnetic environment for Cartesian FDM, conforming FEM, CPU/CUDA solvers, and interactive scientific analysis</h2>

  <p align="center">
    <strong>Newell–FFT magnetostatics · MFEM/hypre finite elements · LLG dynamics · direct energy minimization · hysteresis · eigenmodes · driven frequency response</strong>
  </p>

  <p align="center">
    Build one physical model in Python or the Control Room, select the discretization and execution
    lane appropriate to the problem, and keep geometry, meshing, simulation, visualization,
    diagnostics, and provenance in one coherent workflow.
  </p>

  <p align="center">
    <a href="https://fullmag.mzelent.pl/"><strong>Explore the public documentation »</strong></a>
    <br />
    <br />
    <a href="#numerical-engines">FDM and FEM engines</a>
    ·
    <a href="#solver-portfolio">Solver portfolio</a>
    ·
    <a href="#technology-stack">Technology stack</a>
    ·
    <a href="#version-baseline">Version baseline</a>
    ·
    <a href="https://fullmag.mzelent.pl/frontend/control-room/index.html">Control Room</a>
    ·
    <a href="https://fullmag.mzelent.pl/python-api/index.html">Python API</a>
    ·
    <a href="examples">Examples</a>
  </p>
</div>

<div align="center">

![Project status](https://img.shields.io/badge/status-active%20research%20software-2563EB?style=flat-square)
![FDM](https://img.shields.io/badge/FDM-Newell%20%2B%20FFT-0F766E?style=flat-square)
![FEM](https://img.shields.io/badge/FEM-MFEM%20%2B%20hypre-7C3AED?style=flat-square)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](packages/fullmag-py/pyproject.toml)
[![Rust](https://img.shields.io/badge/Rust-edition%202021-000000?style=flat-square&logo=rust&logoColor=white)](Cargo.toml)
[![CUDA](https://img.shields.io/badge/CUDA-12.4.1-76B900?style=flat-square&logo=nvidia&logoColor=white)](docker/fem-gpu/Dockerfile)
[![MFEM](https://img.shields.io/badge/MFEM-4.9-7C3AED?style=flat-square)](docker/fem-gpu/Dockerfile)
[![hypre](https://img.shields.io/badge/hypre-3.1.0-2563EB?style=flat-square)](docker/fem-gpu/Dockerfile)
[![Next.js](https://img.shields.io/badge/Next.js-16.2.11-000000?style=flat-square&logo=nextdotjs&logoColor=white)](apps/control-room/package.json)
[![React](https://img.shields.io/badge/React-19.2.4-61DAFB?style=flat-square&logo=react&logoColor=000000)](apps/control-room/package.json)
[![Three.js](https://img.shields.io/badge/Three.js-0.183.x-000000?style=flat-square&logo=threedotjs&logoColor=white)](apps/control-room/package.json)
![Horizon Europe](https://img.shields.io/badge/Horizon%20Europe-MSCA%20PF-003399?style=flat-square)

</div>

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
  <a href="docker/fem-gpu/Dockerfile"><img alt="MFEM 4.9" src="https://img.shields.io/badge/MFEM-4.9-5B6EC4?style=for-the-badge" /></a>
  <a href="docker/fem-gpu/Dockerfile"><img alt="hypre 3.1.0" src="https://img.shields.io/badge/hypre-3.1.0-6B7280?style=for-the-badge" /></a>
  <a href="docker/fem-gpu/Dockerfile"><img alt="libCEED 0.12.0" src="https://img.shields.io/badge/libCEED-0.12.0-7C3AED?style=for-the-badge" /></a>
  <a href="Cargo.toml"><img alt="PyO3 0.29" src="https://img.shields.io/badge/PyO3-0.29-FFD43B?style=for-the-badge&amp;logo=rust&amp;logoColor=000000" /></a>
  <a href="packages/fullmag-py/pyproject.toml"><img alt="NumPy &gt;=1.24,&lt;3" src="https://img.shields.io/badge/NumPy-%3E%3D1.24%2C%3C3-013243?style=for-the-badge&amp;logo=numpy&amp;logoColor=white" /></a>
  <a href="packages/fullmag-py/pyproject.toml"><img alt="Gmsh &gt;=4.12,&lt;5" src="https://img.shields.io/badge/Gmsh-%3E%3D4.12%2C%3C5-5B6EC4?style=for-the-badge" /></a>
</p>

<p align="center">
  <strong>Control Room</strong><br />
  <a href="apps/control-room/package.json"><img alt="Next.js 16.2.11" src="https://img.shields.io/badge/Next.js-16.2.11-000000?style=for-the-badge&amp;logo=nextdotjs&amp;logoColor=white" /></a>
  <a href="apps/control-room/package.json"><img alt="React 19.2.4" src="https://img.shields.io/badge/React-19.2.4-20232A?style=for-the-badge&amp;logo=react&amp;logoColor=61DAFB" /></a>
  <a href="apps/control-room/package.json"><img alt="TypeScript 5.8.3" src="https://img.shields.io/badge/TypeScript-5.8.3-3178C6?style=for-the-badge&amp;logo=typescript&amp;logoColor=white" /></a>
  <a href="apps/control-room/package.json"><img alt="Three.js ^0.183.2" src="https://img.shields.io/badge/Three.js-%5E0.183.2-000000?style=for-the-badge&amp;logo=threedotjs&amp;logoColor=white" /></a>
  <a href="apps/control-room/package.json"><img alt="ECharts ^6.1.0" src="https://img.shields.io/badge/ECharts-%5E6.1.0-AA344D?style=for-the-badge&amp;logo=apacheecharts&amp;logoColor=white" /></a>
  <a href="Cargo.toml"><img alt="Tauri 2.11.1" src="https://img.shields.io/badge/Tauri-2.11.1-24C8DB?style=for-the-badge&amp;logo=tauri&amp;logoColor=000000" /></a>
</p>

<details>
<summary><strong>Version policy and sources of truth</strong></summary>

| Contract | Current manifest value | Source of truth | Policy |
|---|---|---|---|
| FullMag packages | `0.1.0` | `Cargo.toml`, `packages/fullmag-py/pyproject.toml`, `apps/control-room/package.json` | package versions must agree |
| Core toolchain | Python `>=3.10`; Node `24.18.0`; Rust `stable` / edition `2021` | `pyproject.toml`, `.node-version`, `rust-toolchain.toml`, `Cargo.toml` | compatibility range or pinned channel/version |
| Managed FEM/GPU bundle | CUDA `12.4.1`; CMake `3.30.5`; MFEM `4.9`; hypre `3.1.0`; libCEED `0.12.0` | `docker/fem-gpu/Dockerfile` | exact reproducible build pins |
| Python scientific API | NumPy `>=1.24,<3`; Zarr `>=2.18,<4`; h5py `>=3.9,<4`; Gmsh `>=4.12,<5` | `packages/fullmag-py/pyproject.toml` | declared compatibility ranges |
| Control Room direct stack | Next.js `16.2.11`; React `19.2.4`; TypeScript `5.8.3`; Three.js `^0.183.2`; ECharts `^6.1.0` | `apps/control-room/package.json` | direct constraints; complete transitive resolution is pinned in `pnpm-lock.yaml` |
| Rust/Python and desktop bridge | PyO3 `0.29`; Tauri `2.11.1` | `Cargo.toml` | workspace dependency constraints |

Regenerate after changing a version source:

```bash
python3 scripts/update_readme_version_dashboard.py --write
```

</details>
<!-- fullmag-version-dashboard:end -->

## What makes FullMag different?

**FullMag is not a single-purpose LLG time-stepper wrapped in a GUI.** It is a complete
micromagnetic workbench in which structured-grid FDM, conforming-mesh FEM, CPU reference paths,
native CUDA paths, advanced equilibrium algorithms, spectral solvers, visualization, and
reproducibility share one stage-oriented study model.

<div align="center">
  <a href="https://fullmag.mzelent.pl/frontend/control-room/index.html">
    <img src="public_docs/site/_static/images/ui/control-room-workspace-overview.png" alt="FullMag Control Room workspace with ribbon, Explorer, Inspector, viewport, and runtime status" width="1200" />
  </a>
  <p><sub>The Control Room combines model authoring, Explorer and Inspector workflows, mesh and field inspection, interactive 2D/3D visualization, live analysis, runtime status, and Python export.</sub></p>
</div>

<a id="numerical-engines"></a>

## Two numerical formulations, one study model

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>FDM — structured-grid throughput</h3>
      <p><strong>Best suited to:</strong> regular thin films, nanowires, racetracks, disks and pillars represented on Cartesian cells, periodic unit cells, large repeated time integrations, and disconnected multilayer stacks.</p>
      <ul>
        <li><strong>State space:</strong> cell-centred Cartesian grids, active masks, per-object native grids, volume-fraction and full embedded-boundary correction, and explicit periodic-grid policies.</li>
        <li><strong>Magnetostatics:</strong> cell-averaged Newell demagnetization tensors accelerated by zero-padded FFTs; separate single-grid and multilayer-convolution contracts; finite periodic-image spectra.</li>
        <li><strong>CPU implementation:</strong> Rust reference solvers with RustFFT and optional Rayon parallelism.</li>
        <li><strong>GPU implementation:</strong> C++17/CUDA kernels, cuFFT, FP32/FP64 interaction and LLG lanes, device reductions, streams, and runtime telemetry.</li>
        <li><strong>Dynamics:</strong> Heun, RK4, RK23, RK45, and lane-specific ABM3 integration.</li>
        <li><strong>Equilibrium:</strong> overdamped LLG, projected-gradient Barzilai–Borwein, and nonlinear conjugate gradient.</li>
      </ul>
      <p><a href="https://fullmag.mzelent.pl/numerical-methods/meshing/fdm/index.html"><strong>FDM meshing and grid contracts »</strong></a></p>
    </td>
    <td width="50%" valign="top">
      <h3>FEM — conforming geometry and operator flexibility</h3>
      <p><strong>Best suited to:</strong> curved or irregular three-dimensional bodies, conforming multi-region structures, strong local refinement, magnetic-plus-air domains, open-boundary magnetostatics, and modal or driven-response studies.</p>
      <ul>
        <li><strong>State space:</strong> one conforming shared domain with free or thin-film tetrahedra, swept prisms and hexahedra, boundary layers, imported meshes, mixed elements, periodic pairs, and graded Airboxes.</li>
        <li><strong>Magnetostatics:</strong> scalar-potential Poisson Airbox with Dirichlet or Robin closure, Fredkin–Koehler FEM/BEM on body-only meshes, and reduced periodic-potential formulations.</li>
        <li><strong>CPU implementation:</strong> C++17/MFEM operators with hypre linear solvers and explicit field, energy, rollback, and convergence contracts.</li>
        <li><strong>GPU implementation:</strong> native CUDA field, integrator, reduction, and direct-minimizer paths with hypre device components; support remains operator- and lane-specific.</li>
        <li><strong>Meshing stack:</strong> Gmsh, Manifold3D, meshio, SciPy, and Trimesh in the optional Python meshing workflow.</li>
        <li><strong>Spectral stack:</strong> linearized-LLG eigenmodes and driven frequency response with optional PETSc/SLEPc infrastructure and explicit dense, sparse, Schur, modal, and GPU planner lanes.</li>
      </ul>
      <p><a href="https://fullmag.mzelent.pl/numerical-methods/meshing/fem/index.html"><strong>FEM meshing and shared-domain contracts »</strong></a></p>
    </td>
  </tr>
</table>

FullMag does not pretend that FDM and FEM are interchangeable labels. Each formulation owns its
mesh, discrete operators, memory layout, solver dependencies, and validation evidence. The public
study records requested intent separately from the resolved backend, device, precision, solver,
and mesh. In `strict` mode, an unsupported combination fails before expensive allocation rather
than being replaced by a hidden CPU, FDM, FEM, or solver fallback.

<a id="solver-portfolio"></a>

## Concrete solver portfolio

| Scientific task | Implemented numerical solutions | Current public boundary |
|---|---|---|
| **Time-domain magnetization dynamics** | Explicit Gilbert LLG with Heun, RK4, Bogacki–Shampine RK23, Dormand–Prince RK45, adaptive embedded-error control, and lane-specific ABM3/coupled integration | FDM and FEM have distinct CPU/GPU implementations; exact interaction and precision coverage is lane-specific |
| **Energy minimization and relaxation** | `llg_overdamped`; tangent projected gradient with alternating BB1/BB2 steps and Armijo backtracking; Polak–Ribière+ nonlinear CG with tangent transport, Armijo acceptance, and periodic restart | Source-backed FDM CPU/GPU and FEM CPU/GPU implementations exist; multilayer and device qualification restrictions remain explicit |
| **Open-boundary demagnetization** | FDM Newell tensor with zero-padded FFT; FDM multilayer convolution on separate native grids; FEM Poisson Airbox with Robin/Dirichlet closure; CPU Fredkin–Koehler FEM/BEM | These solve different discrete boundary-value problems and are never silently substituted |
| **Periodic magnetostatics** | FDM truncated-image kernel spectra and FEM reduced periodic scalar-potential systems with explicit gauge and zero-mode policy | Periodic-image convergence, mesh pairing, and GPU support are separate qualification dimensions |
| **Hysteresis** | Ordered field schedules and relaxation stages using the same material, interaction, stopping, artifact, and provenance contracts as ordinary studies | Availability follows the resolved relaxation and field lanes |
| **Eigenmodes and dispersion** | Tangent-space linearized-LLG generalized eigenproblems, damping include/ignore policy, lowest/nearest/window targeting, mode normalization, and Bloch/Floquet wave-vector sampling | The native public modal contract is FEM; production FDM eigenmode execution is not claimed |
| **Driven frequency response** | Complex linear response around equilibrium with dense reference, CPU sparse direct, full-coupled field split, Schur-reduced, modal-reduced, GPU-operator/host-Krylov, and device-Krylov planner families | The native public response contract is FEM; every sample retains true-residual and resolved-lane diagnostics |
| **Current-driven and coupled physics** | Slonczewski and Zhang–Li STT, SOT, Oersted fields, thermal Brown fields, magnetoelastic coupling, and charge/spin drift–diffusion modules | Representability, execution, and validation are reported separately for each FDM/FEM and CPU/GPU lane |

The full method definitions and support boundaries are maintained in the
**[relaxation](https://fullmag.mzelent.pl/numerical-methods/relaxation/index.html)**,
**[demagnetization](https://fullmag.mzelent.pl/numerical-methods/demag-solvers/index.html)**,
**[eigensolver](https://fullmag.mzelent.pl/numerical-methods/eigensolvers/index.html)**, and
**[frequency-domain](https://fullmag.mzelent.pl/numerical-methods/frequency-domain/index.html)** references.

<a id="technology-stack"></a>

## Technology stack

| Layer | Technologies used in the repository | Responsibility |
|---|---|---|
| **Python authoring and scientific data** | Python 3.10+, NumPy 1.24–2.x, Zarr 2.18–3.x, h5py 3.x, PyO3 0.29 | Stage-oriented DSL, model construction, artifacts, arrays, and Python–Rust integration |
| **Geometry and meshing** | Gmsh 4.12–4.x, Manifold3D 3.x, meshio 5.3–5.x, SciPy 1.x, Trimesh 4.x | Constructive geometry, surface processing, conforming FEM generation, import/export, and mesh preparation |
| **Rust control plane** | Rust 2021, Axum 0.7, Tokio 1.45, Serde 1.x, Clap 4.5, tracing 0.1 | `ProblemIR`, validation, capability planning, sessions, CLI/API, runtime orchestration, and provenance |
| **FDM CPU** | RustFFT 6.4, optional Rayon 1.10, Rust reference operators | Cartesian field evaluation, Newell spectra, FFT convolution, reference dynamics, relaxation, and numerical oracles |
| **Native FDM/GPU** | C++17, CUDA 12.4.1, cuFFT, native C ABI | FP32/FP64 kernels, LLG integrators, demagnetization, multilayer execution, transport, reductions, streams, and device telemetry |
| **FEM CPU/GPU** | C++17, MFEM 4.9, hypre 3.1.0, libCEED 0.12.0, CUDA 12.4.1 | Conforming finite-element operators, Poisson Airbox, FEM/BEM, time integration, direct minimization, and device execution |
| **Spectral and linear algebra** | PETSc, SLEPc, hypre, dense/sparse direct and Krylov implementations | Eigenmodes, frequency response, field-split, Schur, modal reduction, and solver diagnostics |
| **Control Room** | Next.js 16.2.11, React 19.2.4, TypeScript 5.8.3, Three.js 0.183.x, React Three Fiber 9.5+, ECharts 6.x | Interactive authoring, Explorer/Inspector, 2D/3D visualization, mesh inspection, live charts, and analysis |
| **Interfaces and desktop** | OpenAPI v2, `openapi-fetch` 0.17+, WebSocket, SSE, binary typed-array codecs, Tauri 2.11 | Typed frontend/backend contracts, live runtime communication, large field transfer, and desktop packaging |
| **Verification and documentation** | Vitest 4.1+, Playwright 1.60+, Storybook 10.5+, CTest, Rust tests, Sphinx, MyST | API/ABI contracts, numerical regression, browser/WebGL checks, component testing, and scientific documentation |

<a id="version-baseline"></a>

## Versioned dependency baseline

The badges below report the **repository-declared build baseline at this revision**, not the newest
version available upstream. Each badge links to the manifest, lockfile, or managed image that owns
the value.

<div align="center">
  <p>
    <img src="https://img.shields.io/badge/exact%20pin-managed%20baseline-2EA44F?style=flat-square" alt="Exact pin" />
    <img src="https://img.shields.io/badge/bounded%20range-public%20compatibility-2563EB?style=flat-square" alt="Bounded compatibility range" />
    <img src="https://img.shields.io/badge/lockfile-exact%20resolution-F59E0B?style=flat-square" alt="Lockfile resolution" />
    <img src="https://img.shields.io/badge/rolling-explicitly%20marked-D97706?style=flat-square" alt="Rolling toolchain" />
  </p>

  <h3>Core toolchains</h3>
  <p>
    <a href="Cargo.toml"><img src="https://img.shields.io/badge/FullMag%20workspace-0.1.0-334155?style=for-the-badge" alt="FullMag workspace 0.1.0" /></a>
    <a href="packages/fullmag-py/pyproject.toml"><img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&amp;logo=python&amp;logoColor=white" alt="Python 3.10 or newer" /></a>
    <a href=".node-version"><img src="https://img.shields.io/badge/Node.js-24.18.0-339933?style=for-the-badge&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 24.18.0" /></a>
    <a href="package.json"><img src="https://img.shields.io/badge/pnpm-10.8.1-F69220?style=for-the-badge&amp;logo=pnpm&amp;logoColor=white" alt="pnpm 10.8.1" /></a>
    <a href="Cargo.toml"><img src="https://img.shields.io/badge/Rust-edition%202021-000000?style=for-the-badge&amp;logo=rust&amp;logoColor=white" alt="Rust edition 2021" /></a>
    <a href="native/CMakeLists.txt"><img src="https://img.shields.io/badge/C%2B%2B-17-00599C?style=for-the-badge&amp;logo=cplusplus&amp;logoColor=white" alt="C++17" /></a>
    <a href="docker/fem-gpu/Dockerfile"><img src="https://img.shields.io/badge/CMake-3.30.5-064F8C?style=for-the-badge&amp;logo=cmake&amp;logoColor=white" alt="CMake 3.30.5" /></a>
    <a href="docker/fem-gpu/Dockerfile"><img src="https://img.shields.io/badge/CUDA-12.4.1-76B900?style=for-the-badge&amp;logo=nvidia&amp;logoColor=white" alt="CUDA 12.4.1" /></a>
  </p>

  <h3>Numerical and meshing stack</h3>
  <p>
    <a href="packages/fullmag-py/pyproject.toml"><img src="https://img.shields.io/badge/NumPy-1.24%20to%202.x-013243?style=for-the-badge&amp;logo=numpy&amp;logoColor=white" alt="NumPy 1.24 to 2.x" /></a>
    <a href="packages/fullmag-py/pyproject.toml"><img src="https://img.shields.io/badge/Gmsh-4.12%20to%204.x-5B6EC4?style=for-the-badge" alt="Gmsh 4.12 to 4.x" /></a>
    <a href="crates/fullmag-engine/Cargo.toml"><img src="https://img.shields.io/badge/RustFFT-6.4-B7410E?style=for-the-badge" alt="RustFFT 6.4" /></a>
    <a href="Cargo.toml"><img src="https://img.shields.io/badge/PyO3-0.29-FFD43B?style=for-the-badge&amp;logo=python&amp;logoColor=111827" alt="PyO3 0.29" /></a>
    <a href="docker/fem-gpu/Dockerfile"><img src="https://img.shields.io/badge/MFEM-4.9-7C3AED?style=for-the-badge" alt="MFEM 4.9" /></a>
    <a href="docker/fem-gpu/Dockerfile"><img src="https://img.shields.io/badge/hypre-3.1.0-2563EB?style=for-the-badge" alt="hypre 3.1.0" /></a>
    <a href="docker/fem-gpu/Dockerfile"><img src="https://img.shields.io/badge/libCEED-0.12.0-0F766E?style=for-the-badge" alt="libCEED 0.12.0" /></a>
    <a href="docker/fem-gpu/Dockerfile"><img src="https://img.shields.io/badge/Umpire-2024.07%20optional-92400E?style=for-the-badge" alt="Umpire 2024.07 optional" /></a>
  </p>

  <h3>Control Room and verification</h3>
  <p>
    <a href="apps/control-room/package.json"><img src="https://img.shields.io/badge/Next.js-16.2.11-000000?style=for-the-badge&amp;logo=nextdotjs&amp;logoColor=white" alt="Next.js 16.2.11" /></a>
    <a href="apps/control-room/package.json"><img src="https://img.shields.io/badge/React-19.2.4-61DAFB?style=for-the-badge&amp;logo=react&amp;logoColor=000000" alt="React 19.2.4" /></a>
    <a href="apps/control-room/package.json"><img src="https://img.shields.io/badge/TypeScript-5.8.3-3178C6?style=for-the-badge&amp;logo=typescript&amp;logoColor=white" alt="TypeScript 5.8.3" /></a>
    <a href="apps/control-room/package.json"><img src="https://img.shields.io/badge/Three.js-0.183.x-000000?style=for-the-badge&amp;logo=threedotjs&amp;logoColor=white" alt="Three.js 0.183.x" /></a>
    <a href="apps/control-room/package.json"><img src="https://img.shields.io/badge/React%20Three%20Fiber-9.5%2B-20232A?style=for-the-badge&amp;logo=react&amp;logoColor=61DAFB" alt="React Three Fiber 9.5 or newer compatible version" /></a>
    <a href="apps/control-room/package.json"><img src="https://img.shields.io/badge/ECharts-6.x-AA344D?style=for-the-badge&amp;logo=apacheecharts&amp;logoColor=white" alt="ECharts 6.x" /></a>
    <a href="apps/control-room/package.json"><img src="https://img.shields.io/badge/Playwright-1.60%2B-2EAD33?style=for-the-badge&amp;logo=playwright&amp;logoColor=white" alt="Playwright 1.60 or newer compatible version" /></a>
    <a href="apps/control-room/package.json"><img src="https://img.shields.io/badge/Storybook-10.5%2B-FF4785?style=for-the-badge&amp;logo=storybook&amp;logoColor=white" alt="Storybook 10.5 or newer compatible version" /></a>
    <a href="apps/control-room/package.json"><img src="https://img.shields.io/badge/Vitest-4.1%2B-6E9F18?style=for-the-badge&amp;logo=vitest&amp;logoColor=white" alt="Vitest 4.1 or newer compatible version" /></a>
  </p>
</div>

| Scope | Version-control mechanism | Source of truth |
|---|---|---|
| **Public Python API** | Minimum Python version and bounded compatibility intervals prevent unreviewed major-version jumps | [`packages/fullmag-py/pyproject.toml`](packages/fullmag-py/pyproject.toml) |
| **Rust workspace** | Workspace dependency constraints define accepted releases; the committed lockfile fixes the resolved crate graph | [`Cargo.toml`](Cargo.toml), [`Cargo.lock`](Cargo.lock) |
| **Control Room** | Direct dependencies are declared per application; Node and pnpm are pinned; the committed lockfile fixes the resolved JavaScript graph | [`apps/control-room/package.json`](apps/control-room/package.json), [`.node-version`](.node-version), [`package.json`](package.json), [`pnpm-lock.yaml`](pnpm-lock.yaml) |
| **Native FDM/CUDA** | The native build requires C++17 and uses a CUDA 12.4.1 managed image for the documented container baseline | [`native/CMakeLists.txt`](native/CMakeLists.txt), [`native/Containerfile`](native/Containerfile) |
| **Managed FEM/GPU runtime** | CUDA, CMake, MFEM, hypre, libCEED, optional Umpire, GPU architectures, and relevant build flags are pinned in one image recipe | [`docker/fem-gpu/Dockerfile`](docker/fem-gpu/Dockerfile) |

The managed FEM image currently installs the Rust **nightly** toolchain without a date pin. It is
therefore a deliberately visible rolling component, not an exact reproducibility claim. Version
updates should change the owning manifest or image, the corresponding lockfile where applicable,
and this baseline in the same reviewed change.

## Integrated workflow rather than disconnected tools

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>One canonical model in Python and the UI</strong><br /><br />
      Geometry, materials, interactions, solver policy, stages, and outputs lower to the same
      `ProblemIR`. The Control Room can export the stage-oriented Python representation instead of
      maintaining a separate GUI-only simulation format.
    </td>
    <td width="50%" valign="top">
      <strong>An interactive scientific workspace</strong><br /><br />
      Ribbon commands, resource Explorer, transactional Inspector with Apply/Revert, mesh-build
      monitors, 2D/3D WebGL views, field and mesh targets, time-series and energy charts, device
      status, and result analysis are available in one application.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Explicit numerical planning</strong><br /><br />
      Backend, device, precision, mesh class, demagnetization realization, integrator,
      preconditioner, and spectral lane are resolved explicitly. Unsupported requests fail closed;
      automatic selection is recorded as a planner decision rather than hidden behavior.
    </td>
    <td width="50%" valign="top">
      <strong>Evidence-rich and reproducible results</strong><br /><br />
      Results can retain grid/mesh identity, enabled physics, requested and resolved execution,
      stopping reason, residuals, iteration histories, fields, energies, device identity, and
      artifact provenance. Source presence, executability, runtime verification, physical
      validation, and production qualification remain distinct claims.
    </td>
  </tr>
</table>

## Abstract

FullMag is a unified research environment for authoring, meshing, executing, visualizing,
analysing, and reproducing micromagnetic studies with finite-difference (FDM) and finite-element
(FEM) discretizations. A simulation is authored through the public Python interface or the Control
Room, lowered to the canonical `ProblemIR`, checked against backend capabilities, and executed as
an ordered sequence of stages. The runtime records both the requested numerical configuration and
the configuration that was actually resolved, together with solver diagnostics and scientific
artifacts.

The repository combines:

- a stage-oriented Python authoring API for dynamics, relaxation, hysteresis, eigenmodes, and
  frequency response;
- a backend-neutral intermediate representation and capability planner;
- Rust control-plane, runtime, API, and reference-solver components;
- native FDM and FEM implementations for CPU and GPU execution;
- a browser-based Control Room for authoring, meshing, monitoring, visualization, and result
  analysis;
- validation scenarios, standard problems, and provenance-oriented artifact handling.

The canonical user and scientific documentation is published at **[fullmag.mzelent.pl](https://fullmag.mzelent.pl/)**.

## Micromagnetic model

FullMag evolves the reduced magnetization

```math
\mathbf{m}(\mathbf{r},t)=\frac{\mathbf{M}(\mathbf{r},t)}{M_s(\mathbf{r})},
\qquad \lvert\mathbf{m}\rvert=1,
```

using the explicit Gilbert form of the Landau–Lifshitz–Gilbert equation,

```math
\frac{\partial \mathbf{m}}{\partial t}
=
-\frac{\gamma_{\mu_0}}{1+\alpha^2}
\left[
\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}
+
\alpha\,\mathbf{m}\times
\left(\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}\right)
\right]
+
\boldsymbol{\tau}_{\mathrm{direct}}.
```

Here, $\gamma_{\mu_0}=\mu_0\lvert\gamma_e\rvert$, $\alpha$ is the Gilbert damping parameter, $\mathbf{H}_{\mathrm{eff}}$ is expressed in $\mathrm{A\,m^{-1}}$, and $\boldsymbol{\tau}_{\mathrm{direct}}$ contains non-conservative torque contributions in $\mathrm{s^{-1}}$.

Field-form interactions are assembled as

```math
\mathbf{H}_{\mathrm{eff}}=\sum_i\mathbf{H}_i,
\qquad
\mathbf{H}_i
=
-\frac{1}{\mu_0M_s}
\frac{\delta E_i}{\delta\mathbf{m}}.
```

The public reference documents the governing equations, sign conventions, SI units, discretizations, implementation mappings, validation evidence, and known limits for exchange, demagnetization, Zeeman fields, anisotropy, Dzyaloshinskii–Moriya interaction, thermal noise, Oersted fields, magnetoelastic coupling, and spin-torque terms. Availability is evaluated for a complete execution lane rather than inferred from the presence of an API object or source file.

## Execution model

```text
Python study definition or Control Room authoring
                         │
                         ▼
                    ProblemIR
                         │
                         ▼
        validation and capability resolution
                         │
                         ▼
             session → run → ordered stages
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
          FDM backend           FEM backend
              │                     │
              └──────────┬──────────┘
                         ▼
       fields, observables, artifacts, diagnostics,
       requested/resolved execution and provenance
```

The public simulation contract is the stage-oriented `fm.study(...)` interface. Direct construction of low-level problem snapshots is not the documented user workflow.

In `strict` mode, an unsupported combination of interaction, discretization, device, precision, solver, or study type is rejected rather than replaced by an implicit fallback. Requested intent and resolved execution remain separate in runtime provenance. Automatic selection, where available, is an explicit planner policy and does not constitute validation of the selected lane.

## Numerical scope and qualification

FullMag contains executable FDM and FEM paths, but support is not a single project-wide Boolean. A capability is defined by the complete tuple of physical model, backend, device, precision, execution mode, solver, mesh class, and workload.

| Area | Current public scope |
|---|---|
| Authoring | Python `fm.study(...)` workflow with ordered `study.stages.add_*` stages and a canonical `ProblemIR` representation |
| FDM | Structured-grid CPU and CUDA execution paths; interaction and integrator coverage is lane-specific |
| FEM | Unstructured-mesh CPU and GPU paths built around MFEM, hypre, libCEED, and CUDA; qualification is bounded by mesh, operator, device, precision, and workload |
| Time integration | Heun, RK4, RK23, RK45, and lane-specific ABM3/coupled integration paths |
| Relaxation | `llg_overdamped`, `projected_gradient_bb`, and `nonlinear_cg`, with lane-specific FDM/FEM CPU/GPU realizations |
| Study types | Time evolution, relaxation, hysteresis, eigenmodes, and frequency response; support is backend- and device-specific |
| Core interactions | Exchange, demagnetization, and Zeeman terms have public executable paths in FDM and FEM |
| Extended physics | Anisotropy, DMI, thermal, STT/SOT, Oersted, magnetoelastic, and transport features have explicit statuses ranging from semantic-only to bounded executable or validated scopes |
| Device parallelism | Current public execution is single-device; `gpu_count > 1` is rejected |

The normative status vocabulary and feature-level evidence are maintained in [`docs/specs/capability-matrix-v0.md`](docs/specs/capability-matrix-v0.md), its machine-readable companion, and the corresponding public reference pages. Source visibility, successful compilation, executable availability, and scientific validation are treated as distinct states.

## Software architecture

| Layer | Responsibility | Principal location |
|---|---|---|
| Python API | Study construction, geometry, materials, interactions, stages, outputs, and lowering | `packages/fullmag-py/` |
| Intermediate representation | Canonical backend-neutral problem model | `crates/fullmag-ir/` |
| Planner | Validation, capability checks, and lane resolution | `crates/fullmag-plan/` |
| Runtime and interfaces | CLI, API, sessions, runs, stages, artifacts, and provenance | `crates/fullmag-cli/`, `crates/fullmag-api/`, `crates/fullmag-runner/` |
| Reference execution | Correctness-oriented and public executable solver logic | `crates/fullmag-engine/` |
| Native backends | FDM/FEM CPU and GPU implementations and native ABI | `backends/`, `native/` |
| Control Room | Browser-based authoring, monitoring, visualization, and analysis | `apps/control-room/` |
| Public documentation | Sphinx/MyST scientific and user documentation | `public_docs/site/` |
| Validation | Unit, regression, standard-problem, parity, and benchmark-oriented cases | `tests/`, `tests/standard_problems/` |

## Installation

### Python authoring layer

```bash
git clone https://github.com/MateuszZelent/fullmag
cd fullmag
python -m pip install ./packages/fullmag-py
```

Optional geometry and meshing dependencies:

```bash
python -m pip install "./packages/fullmag-py[meshing]"
```

### Local runtime

The repository `justfile` owns the supported build and execution recipes:

```bash
just build fullmag
just run-headless examples/fdm_cpu_relax_smoke.py
```

Native FEM development uses the managed container recipes because MFEM, hypre, libCEED, and CUDA must be built and resolved as one runtime:

```bash
just ensure-managed-fem-runtime
```

Platform requirements and backend-specific installation procedures are maintained in the **[installation guide](https://fullmag.mzelent.pl/getting-started/installation.html)**.

## Minimal stage-oriented example

The following example is the repository-owned FDM CPU smoke scenario from `examples/fdm_cpu_relax_smoke.py`:

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

Run the tracked scenario with:

```bash
just run-headless examples/fdm_cpu_relax_smoke.py
```

This is a smoke workload for verifying the execution path. It is not a discretization-convergence study or a scientific qualification benchmark.

## Results and reproducibility

A FullMag result may contain:

- magnetization and interaction fields;
- scalar observables and energy contributions;
- stage tables and solver histories;
- mesh and geometry artifacts;
- backend, device, precision, solver, and stopping-reason metadata;
- requested and resolved execution descriptors;
- version, configuration, and artifact provenance.

The exact artifact set is controlled by the study and stage output policy. Scientific conclusions should be tied to the repository revision, resolved execution lane, mesh, material parameters, solver settings, stopping criteria, and retained result artifacts.

## Documentation

The public documentation is organized by responsibility:

- **[Getting started](https://fullmag.mzelent.pl/getting-started/index.html)** — installation, first FDM/FEM simulations, solver selection, and Control Room use.
- **[Frontend](https://fullmag.mzelent.pl/frontend/index.html)** — Control Room, meshing UI, visualization, state, commands, and Python round-trip.
- **[Backend](https://fullmag.mzelent.pl/backend/index.html)** — physical equations, runtime boundaries, meshing realizations, numerical solvers, and execution evidence.
- **[Python API](https://fullmag.mzelent.pl/python-api/index.html)** — study construction, geometry, materials, interactions, stages, and lowering.
- **[Physics](https://fullmag.mzelent.pl/physics/index.html)** — governing equations, conventions, interactions, assumptions, and implementation mappings.
- **[Numerical methods](https://fullmag.mzelent.pl/numerical-methods/index.html)** — time integration, relaxation, demagnetization solvers, eigensolvers, frequency response, and state transfer.
- **[Validation](https://fullmag.mzelent.pl/validation/index.html)** — analytical tests, standard problems, parity studies, tolerances, and qualification status.
- **[Architecture](https://fullmag.mzelent.pl/architecture/index.html)** — data flow, runtime boundaries, backend contracts, artifacts, and provenance.

Internal plans, audits, and engineering notes under `docs/` are not automatically part of the public contract.

## Documentation verification

The public site is built strictly with Sphinx. The principal local checks are:

```bash
python -m pip install -r public_docs/site/requirements.txt
python scripts/check_public_docs_information_architecture.py --root public_docs/site
python scripts/check_public_doc_examples.py --root public_docs/site
sphinx-build -b html -W -n --keep-going \
  public_docs/site public_docs/site/_build/html
```

The documentation workflow also executes the public Python API contract tests and validates source mappings for changed scientific pages.

## Citation

Until a versioned software release with a persistent identifier is available, cite the repository and the exact commit used for the reported result:

> M. Zelent, M. Gołebiewski, and P. Pirro, *FullMag: a computational framework for reproducible finite-difference and finite-element micromagnetics*, research software, 2026. Repository: [github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag). Documentation: [fullmag.mzelent.pl](https://fullmag.mzelent.pl/).

A BibTeX template is:

```bibtex
@software{fullmag_2026,
  author  = {Zelent, Mateusz and Gołebiewski, Mateusz and Pirro, Philipp},
  title   = {FullMag: A Computational Framework for Reproducible
             Finite-Difference and Finite-Element Micromagnetics},
  year    = {2026},
  url     = {https://github.com/MateuszZelent/fullmag},
  note    = {Research software; cite the exact release or commit used}
}
```

## Authors and affiliations

| Author | Affiliation |
|---|---|
| Dr Mateusz Zelent | Fachbereich Physik and Landesforschungszentrum OPTIMAS, Rheinland-Pfälzische Technische Universität Kaiserslautern-Landau, 67663 Kaiserslautern, Germany |
| Dr Mateusz Gołebiewski | Institute of Spintronics and Quantum Information, Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland |
| Prof. Philipp Pirro | Fachbereich Physik and Landesforschungszentrum OPTIMAS, Rheinland-Pfälzische Technische Universität Kaiserslautern-Landau, 67663 Kaiserslautern, Germany |

Project coordination: **Mateusz Zelent, RPTU Kaiserslautern-Landau**.

## Contributing

Changes that alter a physical model or numerical capability should update, as applicable, the Python API, `ProblemIR`, planner capability data, executable backend, observables, tests, validation evidence, and public documentation. A capability claim must state its backend, device, precision, mode, solver, mesh, and workload scope.

## License

The repository currently does not contain a root-level license file. Contact the project coordinator before reuse or redistribution.

## Funding and acknowledgements

<div align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/b/b7/Flag_of_Europe.svg" alt="European Union emblem" width="110" />
  <br />
  <a href="https://marie-sklodowska-curie-actions.ec.europa.eu/">
    <img src="https://img.shields.io/badge/Marie%20Sk%C5%82odowska--Curie%20Actions-Horizon%20Europe-003399?style=for-the-badge" alt="Marie Skłodowska-Curie Actions — Horizon Europe" />
  </a>
</div>

Mateusz Zelent acknowledges funding from the European Union's Framework Programme for Research and Innovation under HORIZON-MSCA-2024-PF-01, Marie Skłodowska-Curie Grant Agreement No. **101208951 (CNMA)**.