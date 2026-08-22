---
title: FullMag documentation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: readme.md
---

(public-docs-root)=
# FullMag

<div class="fm-home-masthead">
  <div class="fm-home-masthead__brand">
    <img src="https://raw.githubusercontent.com/MateuszZelent/fullmag/master/docs/fullmag-logo-traced-optimized.svg" alt="FullMag logo" loading="lazy" />
    <p class="fm-home-eyebrow">Finite-difference and finite-element micromagnetics</p>
  </div>
  <div class="fm-home-masthead__authors">
    <p class="fm-home-label">Authors</p>
    <p><strong>Dr Mateusz Zelent</strong><br />RPTU Kaiserslautern-Landau</p>
    <p><strong>Dr Mateusz Gołebiewski</strong><br />Adam Mickiewicz University, Poznań</p>
    <p><strong>Prof. Philipp Pirro</strong><br />RPTU Kaiserslautern-Landau</p>
  </div>
  <div class="fm-home-masthead__funding">
    <img src="https://upload.wikimedia.org/wikipedia/commons/b/b7/Flag_of_Europe.svg" alt="European Union emblem" loading="lazy" />
    <div>
      <p class="fm-home-label">Funding</p>
      <p>Mateusz Zelent acknowledges funding from the European Union's Framework Programme for Research and Innovation under HORIZON-MSCA-2024-PF-01, Marie Skłodowska-Curie Grant Agreement No. <strong>101208951 (CNMA)</strong>.</p>
      <a href="https://marie-sklodowska-curie-actions.ec.europa.eu/">
        <img class="fm-home-funding-badge" src="https://img.shields.io/badge/Marie%20Sk%C5%82odowska--Curie%20Actions-Horizon%20Europe-003399?style=for-the-badge" alt="Marie Skłodowska-Curie Actions — Horizon Europe" loading="lazy" />
      </a>
    </div>
  </div>
</div>

<div class="fm-home-intro">
  <p class="fm-home-eyebrow">Scientific and implementation reference</p>
  <h2>Physical models, numerical methods, execution contracts, and validation evidence.</h2>
  <p>FullMag is research software for authoring, executing, inspecting, and reproducing micromagnetic simulations with finite-difference and finite-element discretizations. This site defines the public Python interface, governing equations, numerical realizations, backend-specific capability boundaries, and validation status.</p>
  <div class="fm-home-actions">
    <a class="fm-home-action fm-home-action--primary" href="getting-started/index.html">Getting started</a>
    <a class="fm-home-action" href="physics/index.html">Physics reference</a>
    <a class="fm-home-action" href="numerical-methods/index.html">Numerical methods</a>
    <a class="fm-home-action" href="python-api/index.html">Python API</a>
    <a class="fm-home-action" href="validation/index.html">Validation</a>
  </div>
</div>

```{toctree}
:hidden:
:maxdepth: 4

getting-started/index
python-api/index
physics/index
numerical-methods/index
validation/index
architecture/index
```

## Scope

FullMag uses one canonical physical-model description across the Python API, browser Control Room,
`ProblemIR`, planner, runtime, and numerical backends. A study is validated before execution and
resolved to a concrete backend, device, precision, solver, mesh class, and execution mode.
Requested intent and resolved execution are retained independently in the result provenance.

The public simulation interface is stage-oriented:

```text
Python study or Control Room
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
      FDM or FEM backend
            │
            ▼
fields, observables, diagnostics, artifacts, and provenance
```

The documented user workflow is `fm.study(...)` followed by ordered
`study.stages.add_*` calls. Direct construction of low-level problem snapshots is not the public authoring contract.

## Governing model

FullMag evolves the reduced magnetization
$\mathbf{m}=\mathbf{M}/M_s$ using the explicit Gilbert form of the
Landau–Lifshitz–Gilbert equation,

```{math}
:label: eq-home-llg
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

Field-form interactions satisfy

```{math}
:label: eq-home-effective-field
\mathbf{H}_{\mathrm{eff}}=\sum_i\mathbf{H}_i,
\qquad
\mathbf{H}_i
=
-\frac{1}{\mu_0M_s}
\frac{\delta E_i}{\delta\mathbf{m}}.
```

The {doc}`physics reference <physics/index>` defines the symbols, SI units, sign conventions,
boundary conditions, energy and field expressions, direct-torque terms, implementation mappings,
and scientific bibliography. The {doc}`numerical-methods/index` section documents FDM/FEM
discretization, integration, relaxation, linear algebra, and backend realization.

## Capability and evidence

Capability claims are lane-specific. A feature is identified by its physical model, backend,
device, precision, execution mode, solver, mesh class, and workload. The following statements are
not interchangeable:

| Statement | Interpretation |
|---|---|
| API or source exists | The feature can be represented or inspected; no execution claim follows |
| Executable | The stated lane can run the stated workload |
| Production executable | The intended production lane is available for the documented bounded scope |
| Validated | Explicit benchmark, regression, and qualification evidence exists for the stated scope |

An executable FDM path does not imply FEM parity; a CPU result does not imply CUDA execution; and
successful compilation does not establish scientific validation. In strict mode, unsupported
combinations fail before backend execution rather than being replaced by an implicit fallback.

The feature-level status, known limits, source mapping, and validation evidence are stated on each
reference page. The repository capability matrix remains the normative machine-readable source for
planner decisions.

## Scientific coverage

The public reference covers:

- LLG dynamics, overdamped relaxation, time-integration methods, stopping criteria, and
  magnetization normalization;
- exchange, demagnetization, Zeeman fields, anisotropy, interfacial and bulk DMI, thermal noise,
  Oersted fields, magnetoelastic coupling, and spin-torque terms;
- structured FDM grids and unstructured FEM meshes, including CPU/GPU execution boundaries;
- eigenmode and frequency-response workflows where a public reference or bounded executable lane
  exists;
- observables, field and energy artifacts, provenance, analytical tests, standard problems,
  cross-backend comparisons, and qualification limits.

Coverage in this manual does not mean that every item is executable on every backend. Use the
status and limitations section of the relevant page before selecting a solver lane.

## Documentation map

- {doc}`getting-started/index` — installation, first FDM/FEM runs, solver selection, and Control Room.
- {doc}`python-api/index` — study construction, geometry, materials, interactions, stages, and lowering.
- {doc}`physics/index` — equations, units, interactions, textures, assumptions, and references.
- {doc}`numerical-methods/index` — discretization, solvers, integration, relaxation, and computational methods.
- {doc}`validation/index` — analytical cases, standard problems, parity evidence, tolerances, and qualification.
- {doc}`architecture/index` — data flow, runtime boundaries, backend contracts, artifacts, and provenance.
- {doc}`changelog/index` — public-documentation changes.

## Citation

Until a versioned release with a persistent identifier is available, cite the repository and the
exact commit used for the reported result:

> M. Zelent, M. Gołebiewski, and P. Pirro, *FullMag: a computational framework for reproducible
> finite-difference and finite-element micromagnetics*, research software, 2026.
> [Repository](https://github.com/MateuszZelent/fullmag);
> [public documentation](https://fullmag.mzelent.pl/).

Project coordination: **Mateusz Zelent, RPTU Kaiserslautern-Landau**.
