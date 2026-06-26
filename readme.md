# Fullmag

<a id="readme-top"></a>

<div align="center">
  <a href="docs/specs/fullmag-application-architecture-v2.md">
    <img src="docs/fullmag-logo-traced-optimized.svg" alt="Fullmag logo" width="140" />
  </a>

  <h3 align="center">A physics-first micromagnetics platform for reproducible FDM/FEM simulation workflows</h3>

  <p align="center">
    Fullmag is a research software platform for authoring, planning, executing, inspecting, and reproducing micromagnetic simulations across finite-difference and finite-element backends.
    <br />
    <a href="docs/specs/fullmag-application-architecture-v2.md"><strong>Explore the architecture »</strong></a>
    <br />
    <br />
    <a href="examples">Examples</a>
    ·
    <a href="docs/physics">Physics notes</a>
    ·
    <a href="docs/specs">Specifications</a>
    ·
    <a href="docs/adr">ADRs</a>
  </p>
</div>

<div align="center">

![Project status](https://img.shields.io/badge/status-active%20research%20prototype-blue)
![Python](https://img.shields.io/badge/Python-DSL%20%26%20bindings-3776AB?logo=python&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-control%20plane%20%26%20reference%20solvers-000000?logo=rust&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-control%20room-3178C6?logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-browser%20control%20room-000000?logo=nextdotjs&logoColor=white)
![CUDA](https://img.shields.io/badge/CUDA-native%20GPU%20paths-76B900?logo=nvidia&logoColor=white)
![MFEM](https://img.shields.io/badge/MFEM-native%20FEM%20backend-5B6EC4)
![Horizon Europe](https://img.shields.io/badge/Horizon%20Europe-MSCA%20PF-003399)

</div>

---

## Table of Contents

1. [About The Project](#about-the-project)
2. [Scientific Scope](#scientific-scope)
3. [Built With](#built-with)
4. [Repository Layout](#repository-layout)
5. [Getting Started](#getting-started)
6. [Usage](#usage)
7. [Roadmap](#roadmap)
8. [Authors and Affiliations](#authors-and-affiliations)
9. [Contributing](#contributing)
10. [License](#license)
11. [Contact](#contact)
12. [Acknowledgments](#acknowledgments)

---

## About The Project

Fullmag is being developed as a full scientific computing application for micromagnetics, not merely as a solver wrapper. Its central design rule is that users should describe a physical problem rather than a numerical memory layout, mesh artifact, or backend-specific execution detail.

The platform is organized around one canonical workflow:

```text
Python DSL
   ↓
ProblemIR
   ↓
validation, planning, and capability checks
   ↓
session / run / stage runtime
   ↓
FDM backend        FEM backend        future hybrid paths
   ↓
artifacts, provenance, and live field resources
   ↓
browser control room, diagnostics, analysis, and export
```

The same physical model should be expressible in Python, inspectable in the browser control room, lowered to a backend-neutral intermediate representation, and executed through a resolved numerical backend while preserving provenance: what the user requested, what the planner selected, and what the solver actually ran.

Fullmag currently focuses on:

- canonical micromagnetic model authoring through an embedded Python DSL;
- shared `ProblemIR` semantics across FDM and FEM execution paths;
- explicit capability reporting instead of hidden backend fallbacks;
- local browser-based observation of live fields, stages, diagnostics, and artifacts;
- reproducible simulation runs with field, scalar, energy, metadata, and provenance outputs;
- production-oriented native FEM and GPU-oriented FDM/CUDA development paths.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Scientific Scope

The physical core is based on the Landau-Lifshitz-Gilbert equation, optionally extended with spin-torque, thermal, transport, and multiphysics terms:

```text
dm/dt = -gamma * mu0 * m x H_eff + alpha * m x dm/dt + tau_spin + eta_th
```

with a typical effective field decomposition:

```text
H_eff = H_ex + H_demag + H_Zeeman + H_anis + H_DMI + H_Oe + H_me + ...
```

Fullmag treats interactions as first-class physical model terms. Each term is expected to carry coherent semantics for energy, effective field, units, operators, observables, backend realization, artifacts, and validation.

### Capability snapshot

| Interaction or workflow | Scientific meaning | Current project status |
|---|---|---|
| Exchange | Local exchange coupling and magnetization smoothing | Public-executable in FDM and FEM |
| Demag / dipolar field | Nonlocal magnetostatic field | Public-executable in FDM and FEM; FEM demag requires ongoing production validation |
| Zeeman field | External applied field | Public-executable in FDM and FEM |
| LLG dynamics | Magnetization time evolution | Public-executable in FDM and FEM |
| Relaxation | Relaxation toward near-equilibrium states | Public-executable for core algorithms; advanced paths remain under validation |
| Slonczewski STT | CPP/MTJ spin-transfer torque | Public-executable for selected FDM and native FEM paths |
| Zhang-Li STT | CIP spin-transfer torque driven by magnetization gradients | Public-executable for selected FDM and native FEM paths |
| Prescribed current density | Current source for STT/Oersted terms | Public-executable in FDM and native FEM |
| Oersted field | Magnetic field generated by current | Public-executable for selected analytical and prescribed-density cases |
| Thermal noise | Brown/FDT-consistent stochastic thermal field | Present in selected thermal/STNO paths; broader validation is ongoing |
| Interfacial and bulk DMI | Chiral interactions | Semantically specified; not yet a general public-executable capability |
| Uniaxial and cubic anisotropy | Easy-axis and crystallographic anisotropy | Planned classical solver capability |
| Magnetoelastic coupling | Magnetization-strain coupling | Internal/reference scope; full two-way coupling is roadmap work |
| Spin-orbit torque and spin diffusion | Extended spintronic transport models | Semantic-only in the current public capability matrix |
| Eigenmodes | Linearized LLG spectral analysis | Bootstrap/reference workflow; production matrix-free implementation is roadmap work |
| NEB, parameter sweeps, optimization | Engineering workflows and transition paths | Roadmap / semantic-only |

The maturity vocabulary is deliberately explicit:

| Status | Meaning |
|---|---|
| `semantic_only` | The API/IR can describe the feature, but no public executable path is provided yet |
| `reference_executable` | The feature runs on a correctness or bootstrap path |
| `production_executable` | The feature runs on a target production backend |
| `validated` | The feature has explicit validation coverage for the stated workload |

Presence in the Python API or `ProblemIR` does not imply validated execution on every backend.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Built With

Fullmag combines a public Python authoring layer, a Rust control and runtime layer, native production backends, and a browser control room.

- [Python](https://www.python.org/) for the public DSL and user-facing simulation scripts.
- [Rust](https://www.rust-lang.org/) for the control plane, planner, runtime, reference solvers, API, and CLI.
- [TypeScript](https://www.typescriptlang.org/), [React](https://react.dev/), and [Next.js](https://nextjs.org/) for the local browser control room.
- [CUDA](https://developer.nvidia.com/cuda-toolkit) for native GPU execution paths.
- [MFEM](https://mfem.org/), [hypre](https://computing.llnl.gov/projects/hypre-scalable-linear-solvers-multigrid-methods), and [libCEED](https://libceed.org/) for native FEM-oriented development.
- OpenAPI-driven local HTTP resources for the browser control-plane/data-plane split.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Repository Layout

| Path | Role |
|---|---|
| `packages/fullmag-py` | Python DSL and user-script loading layer |
| `crates/fullmag-ir` | Canonical `ProblemIR` model |
| `crates/fullmag-plan` | Planner and capability logic |
| `crates/fullmag-cli` | Public `fullmag` launcher |
| `crates/fullmag-api` | Local control-room API |
| `crates/fullmag-runner` | Session, stage, artifact, and runtime execution layer |
| `crates/fullmag-engine` | Reference solvers and executable physics logic |
| `crates/fullmag-py-core` | Python/Rust bridge |
| `apps/control-room` | Current browser control-room application |
| `apps/web` and `apps/legacy_web` | Historical and transitional browser surfaces |
| `native/` | Native production backend sources |
| `docs/physics` | Publication-style physics and numerics notes |
| `docs/specs` | Long-lived application, API, runtime, and frontend specifications |
| `docs/adr` | Architecture decision records |
| `examples/` | Executable and reference workflows |
| `tests/` | Unit, regression, smoke, and benchmark-oriented tests |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting Started

### Prerequisites

The repository is a multi-language workspace. A typical development environment needs:

- a Rust toolchain compatible with `rust-toolchain.toml`;
- Python 3 for the DSL and examples;
- Node.js and `pnpm` for the control room;
- native build dependencies for FEM/GPU paths when those targets are used;
- Docker or a compatible container runtime for managed runtime workflows.

### Environment

```bash
cp .env.example .env
```

Edit `.env` only where local runtime settings are required.

### Development shell

```bash
make up
make shell
```

### Build

```bash
just build fullmag
```

For managed native FEM/GPU runtime work:

```bash
just build fem-gpu-runtime-host
```

### Control room

```bash
just control-room
# or
./scripts/dev-control-room.sh
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Usage

### Run examples

```bash
fullmag examples/exchange_relax.py
fullmag examples/exchange_demag_zeeman.py
fullmag examples/fem_exchange_zeeman.py
fullmag examples/fem_eigenmodes.py --headless
```

Interactive control-room mode:

```bash
fullmag -i examples/exchange_relax.py
```

### Minimal Python DSL example

```python
import fullmag as fm

strip = fm.Box(size=(200e-9, 20e-9, 5e-9), name="strip")

material = fm.Material(
    name="Py",
    Ms=800e3,
    A=13e-12,
    alpha=0.5,
)

magnet = fm.Ferromagnet(
    name="strip",
    geometry=strip,
    material=material,
    m0=fm.texture.random(seed=42),
)

problem = fm.Problem(
    name="exchange_relax",
    magnets=[magnet],
    energy=[fm.Exchange()],
    study=fm.Relaxation(
        algorithm="llg_overdamped",
        torque_tolerance=5e-2,
        energy_tolerance=1e-21,
        max_steps=50_000,
        dynamics=fm.LLG(fixed_timestep=1e-13),
        outputs=[
            fm.SaveField("m", every=100e-12),
            fm.SaveField("H_ex", every=100e-12),
            fm.SaveScalar("E_ex", every=10e-12),
        ],
    ),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2e-9, 2e-9, 5e-9)),
    ),
)

result = fm.Simulation(problem, backend="fdm").run(until=2e-9)
print(result.status)
```

### Typical artifacts

Fullmag is designed to preserve:

- vector and scalar fields such as `m`, `H_ex`, `H_demag`, `H_ext`, and `H_eff`;
- energy contributions such as `E_ex`, `E_demag`, `E_ext`, and `E_total`;
- current-transport artifacts for prescribed-density workflows;
- scalar histories such as `scalars.csv`;
- metadata and provenance records describing requested intent and resolved execution reality.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Roadmap

- [ ] Complete the classical micromagnetic model surface: anisotropy, DMI, boundary-condition validation, and stronger FDM/FEM/GPU parity.
- [ ] Extend current and spintronic workflows: self-consistent current transport, Oersted fields from current solutions, broader STT/SOT support, and spin accumulation.
- [ ] Harden high-fidelity FEM: demag/open-boundary validation, shared-domain meshing, production GPU paths, and matrix-free eigenmode workflows.
- [ ] Extend multiphysics support: two-way magnetoelasticity, mechanics coupling, temperature, and Joule heating.
- [ ] Add engineering workflows: parameter sweeps, optimization studies, NEB, standardized benchmarks, and automated reports.

See `docs/plans/` and `docs/specs/` for active design and implementation plans.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Authors and Affiliations

| Author | Affiliation |
|---|---|
| Dr Mateusz Zelent | Fachbereich Physik and Landesforschungszentrum OPTIMAS, Rheinland-Pfälzische Technische Universität Kaiserslautern-Landau, 67663 Kaiserslautern, Germany |
| Dr Mateusz Gołebiewski | Institute of Spintronics and Quantum Information, Faculty of Physics and Astronomy, Adam Mickiewicz University, Poznań, Poland |
| Prof. Philipp Pirro | Fachbereich Physik and Landesforschungszentrum OPTIMAS, Rheinland-Pfälzische Technische Universität Kaiserslautern-Landau, 67663 Kaiserslautern, Germany |

Affiliations should be treated as project metadata, not as a statement that every repository file is authored equally by all listed contributors.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contributing

Fullmag is an active research codebase. Contributions should preserve the physics-first architecture:

1. Document new physics or numerics in `docs/physics/`.
2. Add or update the Python DSL surface.
3. Lower the semantics into `ProblemIR`.
4. Update planner capability checks and runtime provenance.
5. Implement the backend path or mark it explicitly as `semantic_only`.
6. Add artifacts, observables, tests, and validation evidence.

For code changes:

```bash
git checkout -b feature/your-feature
```

Run the narrow relevant tests first, then the broader gates required by the subsystem you touched. Browser/API work should keep the OpenAPI v2 contract, resource hooks, and control-room facade aligned.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## License

No root-level license file is present in the current checkout. Add an explicit license before public redistribution or reuse outside the intended research collaboration context.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

Project coordination: Mateusz Zelent, RPTU.

Project link: [https://github.com/MateuszZelent/fullmag](https://github.com/MateuszZelent/fullmag)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Acknowledgments

<div align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/b/b7/Flag_of_Europe.svg" alt="European Union emblem" width="110" />
  <br />
  <a href="https://marie-sklodowska-curie-actions.ec.europa.eu/">
    <img src="https://img.shields.io/badge/Marie%20Sk%C5%82odowska--Curie%20Actions-Horizon%20Europe-003399?style=for-the-badge" alt="Marie Skłodowska-Curie Actions project badge" />
  </a>
</div>

Mateusz Zelent acknowledges that this project has received funding from the European Union's Framework Programme for Research and Innovation HORIZON-MSCA-2024-PF-01 under the Marie Skłodowska-Curie Grant Agreement Project No. 101208951–CNMA.

Fullmag also builds on the wider scientific software ecosystem for micromagnetics, high-performance numerical methods, finite-element discretization, GPU computing, and reproducible research infrastructure.

The README structure is adapted from [Best-README-Template](https://github.com/othneildrew/Best-README-Template).

<p align="right">(<a href="#readme-top">back to top</a>)</p>
