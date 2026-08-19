---
title: DMI validation
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0404-interfacial-dmi.md
---

(public-docs-physics-interactions-dmi-validation)=
# DMI validation

This page summarises the validation strategy and current evidence for the Dzyaloshinskii–
Moriya interaction implementation across all solver/device lanes.

(dmi-validation-problem-statement)=
## Physical problem

Validation must test the implemented energy, effective field, natural boundary behavior,
and planner legality separately. A green constructor test is not a numerical qualification.

(dmi-validation-governing-equations)=
## Governing equations used by validation

The interfacial and bulk energy densities are evaluated with the same sign conventions as
their canonical owners:

```{math}
:label: eq-dmi-validation-interfacial-energy
w_{\mathrm i}=D\left[m_n\nabla\cdot\mathbf m-\mathbf m\cdot\nabla m_n\right],
\qquad
m_n=\mathbf m\cdot\hat{\mathbf n}.
```

```{math}
:label: eq-dmi-validation-bulk-energy
w_{\mathrm b}=D\,\mathbf m\cdot(\nabla\times\mathbf m).
```

(dmi-validation-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $D$ | DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $w_{\mathrm i}$ | interfacial DMI energy density | $\mathrm{J\,m^{-3}}$ |
| $w_{\mathrm b}$ | bulk DMI energy density | $\mathrm{J\,m^{-3}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $m_n$ | normal magnetization component | $1$ |
| $\hat{\mathbf n}$ | interface-symmetry normal | $1$ |
| $\nabla$ | spatial differential operator | $\mathrm{m^{-1}}$ |
| $k$ | helical wave number | $\mathrm{m^{-1}}$ |
| $\varepsilon$ | finite-difference perturbation amplitude | $1$ |

(dmi-validation-assumptions-and-validity)=
## Assumptions and validity

Each test must state DMI variant, coefficient sign, normal convention, geometry, mesh/grid,
boundary policy, precision, and solver tolerance. A uniform-state test cannot validate
boundary twist; a sign test cannot validate the absolute energy scale. Device-capable tests
without executed-device identity remain capability evidence, not GPU qualification.

(dmi-validation-python-api)=
## Python API test request

The following complete stage-first scenario is the executable authoring fixture for the
interfacial-DMI zero-field test. A uniform state makes every spatial derivative vanish; the saved
`H_dmi` field and `e_dmi` scalar must therefore be zero to the tolerance declared by the validation
artifact. This Python example defines the request but does not itself promote a backend lane to
qualified status.

```python
# %% Imports and units
import fullmag as fm

nm = 1.0e-9

# %% Deterministic FDM reference study
study = fm.study("interfacial_dmi_uniform_zero_test")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

# %% Geometry, material, uniform state, and isolated DMI term
film = study.geometry(
    fm.Box(size=(40 * nm, 40 * nm, 2 * nm), name="film"),
    name="film",
)
film.Ms = 5.8e5
film.Aex = 15.0e-12
film.Dind = 3.0e-3
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((0.0, 0.0, 1.0))
study.exchange(enabled=False)
study.demag(enabled=False)
study.solver(integrator="rk4", fix_dt=1.0e-14)

# %% Ordered measurement stage
study.stages.add_run(stage_id="measure_zero_field", until=1.0e-13).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            t_sampl=1.0e-14,
            quantities=["t", "mx", "my", "mz", "e_dmi", "e_total"],
        ),
        fields=[fm.FieldAutosave("H_dmi", every=1.0e-14)],
    )
)
```

The stage-first solver scenarios that execute these terms must use the repository-owned
study/stages pattern. The lowering fixture verifies only canonical normalization, not field output.

(dmi-validation-problem-ir)=
## ProblemIR and provenance

The validation record stores the authored term kind, signed coefficient, and optional normal
before planning. The resolved record stores solver/device/precision, normalized normal,
boundary realization, output quantity, mesh identity, and test artifact identity. The same
test name is not evidence when these resolved values differ.

(dmi-validation-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Round-trip must preserve interfacial versus bulk DMI and must not erase the sign of $D$.
Validation errors include malformed normals, non-finite coefficients, unsupported FDM
orientation, missing matching output terms, and invalid boundary policies. Unsupported
combinations are rejected before execution; a fallback to another DMI variant invalidates
the test.
Requested intent is recorded before planning. Resolved execution is recorded after planning.
Unsupported combinations are rejected before execution.

(dmi-validation-discrete-realization)=
## Discrete realization

FDM validation compares cell-centered finite differences and boundary stencils. FEM
validation compares weak residuals, surface traces, quadrature energy, and recovered fields.
CPU/GPU comparisons must use equal precision, equal coefficient, equal normal, equal mesh/grid,
and equivalent output location before a tolerance is interpreted.

(dmi-validation-implementation-mapping)=
## Implementation mapping

Python term classes own input lowering. FDM and FEM variants have separate field paths;
the planner owns output legality and normal restrictions. The source map records the stable
implementation symbols and tests used by this page.

(dmi-validation-validation)=
## Validation strategy

DMI validation relies on analytic checks, cross-backend comparison, and sign/symmetry
tests. Unlike exchange or demagnetization, DMI has no standard problem with a universally
accepted reference solution. The validation therefore focuses on:

1. **Zero-field test**: uniform magnetization produces zero DMI field and zero DMI energy.
2. **Sign reversal**: $D \to -D$ reverses the field and energy sign.
3. **Linear profile**: a linear $m_z(x,y)$ profile produces known field values that can
   be verified analytically.
4. **Chiral wall reflection**: reflecting a chiral domain wall changes the DMI energy sign.
5. **Variational consistency**: FEM residual matches the energy finite-difference derivative.
6. **Cross-backend parity**: FDM CPU vs FDM GPU, FEM CPU vs FEM GPU.
7. **Tilted normal**: FEM accepts arbitrary normalised normals; non-$+z$ FDM normals are
   rejected.

## Validation status by lane

| Lane | Evidence class | Current status |
|---|---|---|
| FDM CPU reference | Analytic stencil checks: zero-field, sign reversal, linear profile | Implemented and tested; not freshly executed for this revision |
| FDM GPU FP64 | Fused-kernel parity with CPU reference | Device-capable tests present |
| FDM GPU FP32 | FP64–FP32 Tier B parity | Device-capable tests present |
| FEM CPU MFEM | Residual consistency, energy derivative, tilted normal, `Dind_field` | Source contracts pass; managed runtime tests exist |
| FEM GPU CUDA | Element residual kernel parity with CPU residual | Device-capable contracts present |

## Interfacial DMI tests

The key analytic checks for interfacial DMI:

1. **Uniform $\mathbf{m}$**: for any constant $\mathbf{m}$, all spatial derivatives vanish,
   so $\mathbf{H}_{\mathrm{DMI}}=\mathbf{0}$ and $E_{\mathrm{DMI}}=0$. Violations indicate
   stencil boundary errors or quadrature contamination.

2. **Sign of $D$**: reversing $D$ must reverse the effective field direction and the energy
   sign for any non-uniform state.

3. **Linear $m_z$ gradient**: for $\mathbf{m}=(0,0,1)$ with a small $m_z(x)$ perturbation,
   the FDM and FEM fields must agree in sign and magnitude (up to discretization error).

4. **FEM residual derivative**: the FEM weak residual $R_{\mathrm{DMI}}(\mathbf{m};\mathbf{v})$
   must agree with the finite-difference approximation
   $[E(\mathbf{m}+\varepsilon\mathbf{v})-E(\mathbf{m}-\varepsilon\mathbf{v})]/(2\varepsilon)$
   to within quadrature tolerance.

## Bulk DMI tests

Bulk DMI tests follow the same structure with the appropriate energy density
$D\,\mathbf{m}\cdot(\nabla\times\mathbf{m})$:

1. **Uniform $\mathbf{m}$**: zero field and energy.
2. **Helical state**: for a helical magnetization
   $\mathbf{m}(x)=(\cos kx,\sin kx,0)$, the energy density is $Dk$ and the field is
   analytically known.
3. **Sign reversal**: $D\to -D$ reverses chirality preference.

(dmi-validation-limitations)=
## Limitations and known gaps

- No muMAG-style standard problem exists for DMI validation.
- FDM GPU device identity is not captured in current test evidence.
- FEM GPU mixed-P1 element qualification for DMI is incomplete.
- Cross-solver (FDM vs FEM) quantitative convergence comparison has not been published.

(dmi-validation-scientific-bibliography)=
## Scientific bibliography

1. S. Rohart and A. Thiaville, "Skyrmion confinement in ultrathin film nanostructures in
   the presence of Dzyaloshinskii-Moriya interaction," *Physical Review B* **88**, 184422
   (2013). [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422).
2. FullMag internal notes: `docs/physics/0404-interfacial-dmi.md`,
   `docs/physics/0405-bulk-dmi.md`, `docs/physics/0812-fem-dmi-weak-residual-proof-fixture.md`.

(dmi-validation-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Interfacial API | packages/fullmag-py/src/fullmag/model/energy.py | class InterfacialDMI | coefficient and normal lowering | Python |
| Bulk API | packages/fullmag-py/src/fullmag/model/energy.py | class BulkDMI | coefficient lowering | Python |
| Interfacial FEM field | backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp | compute_interfacial_dmi_field | FEM residual/field | FEM CPU |
| Bulk FEM field | backends/fem/cpu/mfem/interactions/dmi_bulk.cpp | compute_bulk_dmi_field | FEM residual/field | FEM CPU |
| Device DMI field/energy | backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu | fullmag_cuda_dmi_field_energy | CUDA field and energy | FEM GPU |
