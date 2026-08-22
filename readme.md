# FullMag

<div align="center">
  <img src="docs/fullmag-logo-traced-optimized.svg" alt="FullMag logo" width="150" />
  <p><strong>Computational framework for reproducible finite-difference and finite-element micromagnetics</strong></p>
  <p>
    <a href="https://fullmag.mzelent.pl/"><strong>Public documentation</strong></a>
    ·
    <a href="https://fullmag.mzelent.pl/getting-started/index.html">Getting started</a>
    ·
    <a href="https://fullmag.mzelent.pl/physics/index.html">Physics reference</a>
    ·
    <a href="https://fullmag.mzelent.pl/python-api/index.html">Python API</a>
  </p>
</div>

## Abstract

FullMag is research software for defining, executing, analysing, and reproducing micromagnetic simulations with finite-difference (FDM) and finite-element (FEM) discretizations. A simulation is authored through the public Python interface, lowered to the canonical `ProblemIR`, checked against backend capabilities, and executed as an ordered sequence of stages. The runtime records both the requested numerical configuration and the configuration that was actually resolved, together with solver diagnostics and scientific artifacts.

The repository combines:

- a stage-oriented Python authoring API;
- a backend-neutral intermediate representation and capability planner;
- Rust control-plane, runtime, API, and reference-solver components;
- native FDM and FEM implementations for CPU and GPU execution;
- a browser-based Control Room for authoring, monitoring, inspection, and result analysis;
- validation scenarios, standard problems, and provenance-oriented artifact handling.

The canonical user and scientific documentation is published at **[fullmag.mzelent.pl](https://fullmag.mzelent.pl/)**.

## Micromagnetic model

FullMag evolves the reduced magnetization

$$
\mathbf{m}(\mathbf{r},t)=\frac{\mathbf{M}(\mathbf{r},t)}{M_s(\mathbf{r})},
\qquad |\mathbf{m}|=1,
$$

using the explicit Gilbert form of the Landau–Lifshitz–Gilbert equation,

$$
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
$$

Here, $\gamma_{\mu_0}=\mu_0|\gamma_e|$, $\alpha$ is the Gilbert damping parameter, $\mathbf{H}_{\mathrm{eff}}$ is expressed in $\mathrm{A\,m^{-1}}$, and $\boldsymbol{\tau}_{\mathrm{direct}}$ contains non-conservative torque contributions in $\mathrm{s^{-1}}$.

Field-form interactions are assembled as

$$
\mathbf{H}_{\mathrm{eff}}=\sum_i\mathbf{H}_i,
\qquad
\mathbf{H}_i
=
-\frac{1}{\mu_0M_s}
\frac{\delta E_i}{\delta\mathbf{m}}.
$$

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
| Dynamics and relaxation | LLG time integration and several relaxation algorithms are available on defined lanes; exact integrator and stopping-criterion support is backend-specific |
| Core interactions | Exchange, demagnetization, and Zeeman terms have public executable paths in FDM and FEM |
| Extended physics | Anisotropy, DMI, thermal, STT/SOT, Oersted, magnetoelastic, and transport features have explicit statuses ranging from semantic-only to bounded executable or validated scopes |
| Spectral and driven studies | Eigenmode and frequency-response workflows exist, with reference, development, or bounded production status depending on the lane |
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

study.demag(realization="poisson_robin")
study.b_ext(0.0, 0.0, 1e-3)
study.solver(dt=1e-13, g=2.115)

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

The public documentation is the authoritative user-facing reference:

- **[Getting started](https://fullmag.mzelent.pl/getting-started/index.html)** — installation, first FDM/FEM simulations, solver selection, and Control Room use.
- **[Python API](https://fullmag.mzelent.pl/python-api/index.html)** — study construction, objects, parameters, interactions, stages, and lowering.
- **[Physics](https://fullmag.mzelent.pl/physics/index.html)** — governing equations, conventions, interactions, textures, and implementation mappings.
- **[Numerical methods](https://fullmag.mzelent.pl/numerical-methods/index.html)** — FDM/FEM discretization, solvers, time integration, and computational methods.
- **[Validation](https://fullmag.mzelent.pl/validation/index.html)** — analytical tests, standard problems, parity studies, tolerances, and qualification status.
- **[Architecture](https://fullmag.mzelent.pl/architecture/index.html)** — data flow, runtime boundaries, backend contracts, and provenance.

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

## Funding

Mateusz Zelent acknowledges funding from the European Union's Framework Programme for Research and Innovation under HORIZON-MSCA-2024-PF-01, Marie Skłodowska-Curie Grant Agreement No. **101208951 (CNMA)**.

## Contributing

Changes that alter a physical model or numerical capability should update, as applicable, the Python API, `ProblemIR`, planner capability data, executable backend, observables, tests, validation evidence, and public documentation. A capability claim must state its backend, device, precision, mode, solver, mesh, and workload scope.

## License

The repository currently does not contain a root-level license file. Contact the project coordinator before reuse or redistribution.
