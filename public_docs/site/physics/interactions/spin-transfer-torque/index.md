---
title: Spin-transfer torque
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-stt)=
# Spin-transfer torque

Spin-transfer torque (STT) is a non-conservative LLG source. Fullmag exposes local
Slonczewski CPP/MTJ and Zhang–Li CIP models, plus canonical source-binding variants. Legacy
formula versions remain distinguishable in `ProblemIR`; they must not be relabelled as the
canonical SI models.

(physics-spin-transfer-torque-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(physics-spin-transfer-torque-governing-equations)=
## Governing equations

### Common torque convention

A torque module authors a Gilbert-source rate $\mathbf T_G$. Fullmag converts it to the
explicit LLG RHS exactly once:

```{math}
:label: eq-public-spin-transfer-torque-stt-gilbert-explicit
\mathbf T_{\mathrm{explicit}}
=
\frac{\mathbf T_G+\alpha\,\mathbf m\times\mathbf T_G}{1+\alpha^2}.
```

A backend must not pre-convert the same source and then let the LLG layer convert it again.

## Slonczewski CPP/MTJ torque

For spin-polarization direction $\hat{\mathbf p}$,

```{math}
:label: eq-public-spin-transfer-torque-stt-slonczewski
\mathbf T_{\mathrm{SL},G}
=
\Omega_{\mathrm{DL}}\,
\mathbf m\times(\hat{\mathbf p}\times\mathbf m)
+
\Omega_{\mathrm{FL}}\,
\mathbf m\times\hat{\mathbf p}.
```

The canonical model uses a signed normal current density, an oriented stack normal, target
$M_s$, and either a free-layer thickness or an explicitly resolved interface realization.
The angular efficiency is a named formula version based on polarization and asymmetry
parameters. Current sign, stack-normal orientation, and fixed-layer polarization must remain
independent authored quantities.

## Zhang–Li CIP torque

For conventional current density $\mathbf J_c$,

```{math}
:label: eq-public-spin-transfer-torque-stt-zhang-li-velocity
\mathbf u
=
\frac{g\mu_{\mathrm B}P}{2eM_s}\mathbf J_c ,
```

and

```{math}
:label: eq-public-spin-transfer-torque-stt-zhang-li
\mathbf T_{\mathrm{ZL},G}
=
-(\mathbf u\cdot\nabla)\mathbf m
+
\beta\,\mathbf m\times
[(\mathbf u\cdot\nabla)\mathbf m].
```

The exact sign is tied to conventional current, positive elementary charge $e$, and the
Fullmag LLG convention. Documentation must not switch to electron-flow language mid-equation.

(physics-spin-transfer-torque-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf J_c$ | signed conventional charge-current density | $\mathrm{A\,m^{-2}}$ |
| $\hat{\mathbf p}$ | spin-polarization direction | $1$ |
| $P$ | spin polarization degree | $1$ |
| $\beta$ | non-adiabaticity | $1$ |
| $\mathbf u$ | spin-drift velocity | $\mathrm{m\,s^{-1}}$ |
| $\Omega_{\mathrm{DL}},\Omega_{\mathrm{FL}}$ | torque rates | $\mathrm{s^{-1}}$ |
| $\mathbf T_G$ | Gilbert-source torque | $\mathrm{s^{-1}}$ |

(physics-spin-transfer-torque-discrete-realization)=
## Capability matrix

The exact result depends on formula version (legacy versus canonical), target kind, current
source, and realization.

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | legacy and selected canonical IR | reference executable subsets | μMAG SP5 and analytic/current-scaling tests | target/source/formula-version gates apply |
| FDM | GPU | same tagged IR | implemented subsets | device and precision qualification separate | no silent replacement of canonical request by legacy formula |
| FEM | CPU | legacy and selected canonical IR | reference/partial executable | skew-mesh and weak-gradient tests required | target and current-source support narrower |
| FEM | GPU | authoring/IR | partial or unsupported by variant | no generic qualification claim | planner must report exact rejected feature |

(physics-spin-transfer-torque-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("slonczewski_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

stt = fm.SlonczewskiSTT(
    current_density=(0.0, 0.0, 5.0e10),
    spin_polarization=(0.0, 0.0, 1.0),
    degree=0.4,
    lambda_asymmetry=1.0,
    epsilon_prime=0.0,
    free_layer_thickness_m=4 * nm,
)
study.spin_torque(stt)
study.stages.add_run(stage_id="drive", until=1.0e-12)
```

The previous public API example used non-existent parameters (`polarization`, `efficiency`,
`direction_fixed`, `interface_inPlane`), passed a scalar where a three-vector was required, and
declared no stage. The actual compatibility constructors are documented by the parameter tables
below.

At the audited revision, these cells prove constructor and lowering semantics only. Do not claim
a complete executable stage unless the selected study facade, planner, target, formula version,
and current-source route are all registered and accepted. A normal stage shell without an
attached torque is not an STT example.

## Constructor parameters

### `SlonczewskiSTT`

| Parameter | Unit | Meaning |
|---|---:|---|
| `current_density` | $\mathrm{A\,m^{-2}}$ | signed three-vector prescribed current; mutually exclusive with `current_source` |
| `spin_polarization` | $1$ | fixed-layer polarization direction |
| `degree` | $1$ | polarization magnitude |
| `lambda_asymmetry` | $1$ | angular asymmetry parameter |
| `epsilon_prime` | $1$ | field-like coefficient in the selected formula |
| `free_layer_thickness_m` | $\mathrm m$ | local volumetric prefactor realization |
| `id`, `target`, `stack_normal`, `interface_id` | mixed | canonical tagged-module identity and realization |

### `ZhangLiSTT`

| Parameter | Unit | Meaning |
|---|---:|---|
| `current_density` | $\mathrm{A\,m^{-2}}$ | signed three-vector prescribed current |
| `degree` / `xi` | $1$ | polarization parameter/alias under the documented formula |
| `beta` | $1$ | non-adiabaticity |
| `current_source` | $1$ | named solved-current source, exclusive with prescribed current |
| `id`, `target`, `lande_g`, `operator_version` | mixed | canonical tagged-module contract |

(physics-spin-transfer-torque-problem-ir)=
## ProblemIR and provenance

The IR must preserve:

- `kind` and `formula_version`;
- legacy versus canonical semantics;
- signed current source and its identity;
- target and stack/interface orientation;
- thickness/interface realization;
- all polarization/asymmetry parameters.

Canonical export must not erase a legacy formula version or silently upgrade it.

(physics-spin-transfer-torque-validation)=
## Validation requirements

Python validation should reject non-finite vectors/scalars, zero polarization direction, invalid
degree/asymmetry domains, conflicting current sources, incomplete canonical identity, invalid
target, and missing realization. Planner validation additionally owns mesh derivatives, target
materialization, source availability, backend/device support, and current-field cardinality.

## Required numerical validation

- zero-current and zero-polarization limits;
- odd current scaling and exact sign reversal;
- $\mathbf m\parallel\hat{\mathbf p}$ zero damping-like torque;
- finite-difference/analytic single-cell torque oracles;
- Zhang–Li translation of a one-dimensional wall;
- μMAG Standard Problem 5 with fully declared convention;
- source-bound versus prescribed-current equivalence;
- CPU/GPU trajectories with matched timestep, precision, and formula version;
- proof that Gilbert conversion is applied exactly once.

(physics-spin-transfer-torque-limitations)=
## Limitations and extensions

The local Slonczewski model does not solve tunnelling, spin accumulation, backflow, heating, or
bias-dependent polarization. Zhang–Li is a diffusive adiabatic/non-adiabatic local model. Solved
drift–diffusion torque is documented separately and must not be replaced by fitted local
coefficients.

(physics-spin-transfer-torque-scientific-bibliography)=
## Scientific bibliography

1. J. C. Slonczewski, *Journal of Magnetism and Magnetic Materials* **159**, L1–L7 (1996),
   DOI: 10.1016/0304-8853(96)00062-5.
2. S. Zhang and Z. Li, *Physical Review Letters* **93**, 127204 (2004),
   DOI: 10.1103/PhysRevLett.93.127204.
3. NIST μMAG Standard Problem 5.

(physics-spin-transfer-torque-source-code-index)=

## Control Room crosswalk

This is a navigation page; the selected interaction or foundation is configured by its linked Python API and object/stage editor. The category itself has no standalone control. frontend support is not implemented applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-spin-transfer-torque-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(physics-spin-transfer-torque-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `SlonczewskiSTT, ZhangLiSTT` | public constructors and formula versions |
| `packages/fullmag-py/src/fullmag/world.py` | `spin_torque facade` | stage registration boundary |
| `crates/fullmag-plan/src/spin_torque.rs` | `STT planning` | variant/source/target capability |
| `crates/fullmag-plan/src/fdm.rs` | `FDM torque planning` | FDM materialization |
| `crates/fullmag-plan/src/fem.rs` | `FEM torque planning` | FEM materialization |
| `backends/fdm/gpu/cuda/interactions` | `STT kernels` | FDM GPU realization |
| `backends/fem/cpu/mfem/interactions` | `STT operators` | FEM CPU realization |

(physics-spin-transfer-torque-round-trip-and-failure-semantics)=
