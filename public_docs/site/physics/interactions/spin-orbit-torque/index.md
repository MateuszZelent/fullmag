---
title: Spin-orbit torque
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0800-fdm-sot.md
---

(public-docs-physics-interactions-sot)=
# Spin-orbit torque

Spin-orbit torque (SOT) is a non-conservative, direct contribution to the
Landau–Lifshitz–Gilbert (LLG) right-hand side. It represents angular-momentum
transfer from a prescribed charge-current source in a heavy-metal (HM) layer to
an adjacent ferromagnet (FM). It is not an energy term and therefore does not
create an `E_SOT` observable.

The physical model is defined once here. The FDM CPU and FDM GPU sections describe
two numerical realizations of that model; they do not define two different SOT
equations. FEM CPU and FEM GPU are documented explicitly as unsupported because
the planner rejects this module on the FEM lane.

| Solver | Device | Current status | Exact boundary |
|---|---|---|---|
| FDM | CPU | Reference executable | Native `f64` cell-local direct torque and analytic projection test are present. |
| FDM | GPU | Implemented in CUDA source | FP64 and FP32 fused LLG kernels are present; executed-device parity is a separate qualification claim. |
| FEM | CPU | Unsupported | Planner rejects `spin_orbit_torque`; no FEM field, boundary, or energy operator is selected. |
| FEM | GPU | Unsupported | Planner rejects `spin_orbit_torque`; FDM CUDA code is not a FEM implementation or fallback. |

(sot-problem-statement)=
## Physical problem

Consider a ferromagnetic layer with reduced magnetization
$\mathbf m=\mathbf M/M_s$. A prescribed charge-current-density magnitude
$\lvert J_e\rvert$ in an adjacent heavy metal produces a spin-polarization
direction $\hat{\boldsymbol\sigma}$ at the interface. Fullmag applies the
resulting damping-like (DL) and field-like (FL) terms locally in each active FM
cell. The implementation does not solve the heavy-metal charge transport or a
spin-diffusion boundary-value problem.

For a current along $\hat{\mathbf x}$ and an interface normal along
$\hat{\mathbf z}$, one possible convention is
$\hat{\boldsymbol\sigma}=\hat{\mathbf z}\times\hat{\mathbf x}=\hat{\mathbf y}$.
Fullmag does not infer this direction from a geometry normal or from the sign of
the current. The user supplies `spin_polarization`; its direction is therefore
part of the requested physical intent.

The two implemented components have different physical interpretations:

- the DL term is proportional to
  $-\mathbf m\times(\mathbf m\times\hat{\boldsymbol\sigma})$;
- the FL term is proportional to
  $\mathbf m\times\hat{\boldsymbol\sigma}$.

Both terms are applied throughout the modeled ferromagnet. The current source is
not an interface boundary condition, and `ferromagnet_thickness_m` is the scalar
thickness used in the amplitude denominator, not a mesh-derived FEM thickness.

(sot-governing-equations)=
## Governing equations

The native implementation uses the reduced magnetization and an effective-field-
like SOT amplitude

```{math}
:label: eq-sot-amplitude
H_{\mathrm{SOT}}
=
\frac{\hbar\,\lvert J_e\rvert}
{2e\,\mu_0\,M_s\,t_F}.
```

$H_{\mathrm{SOT}}$ has units of $\mathrm{A\,m^{-1}}$. The raw vector combination
before the LLG conversion is

```{math}
:label: eq-sot-raw-vector
\mathbf r_{\mathrm{SOT}}
=
-\xi_{\mathrm{DL}}\,\mathbf m\times
  (\mathbf m\times\hat{\boldsymbol\sigma})
+\xi_{\mathrm{FL}}\,\mathbf m\times
  \hat{\boldsymbol\sigma}.
```

The native CPU and CUDA implementations use the equivalent identity

```{math}
:label: eq-sot-double-cross
\mathbf m\times(\mathbf m\times\hat{\boldsymbol\sigma})
=
(\mathbf m\cdot\hat{\boldsymbol\sigma})\mathbf m
-\hat{\boldsymbol\sigma}.
```

The SOT contribution exported by the FDM LLG RHS is the Gilbert-form conversion
of that vector:

```{math}
:label: eq-sot-rhs
\left.\frac{\mathrm d\mathbf m}{\mathrm dt}\right|_{\mathrm{SOT}}
=
\gamma_{\mu_0}\,H_{\mathrm{SOT}}
\left(
\mathbf r_{\mathrm{SOT}}
+\alpha\,\mathbf m\times\mathbf r_{\mathrm{SOT}}
\right).
```

Here $\gamma_{\mu_0}$ is the reduced gyromagnetic constant and $\alpha$ is the
material Gilbert damping. The factor $1/(1+\alpha^2)$ is already included in
the native `gamma_bar` value used by both the FDM CPU and CUDA paths; it must not
be multiplied into the public equation a second time.

When the current is bound to a prescribed `CurrentTransport` module, the planner
does not use the vector direction as the SOT polarization. It first resolves the
magnitude

```{math}
:label: eq-sot-source-magnitude
J_e
=\left\lvert\mathbf J_{\mathrm{transport}}\right\rvert
=\sqrt{J_x^2+J_y^2+J_z^2},
```

and inserts that magnitude into {eq}`eq-sot-amplitude`. The source-vector
direction and `spin_polarization` are therefore separate inputs.

The absolute value in {eq}`eq-sot-amplitude` is an implementation contract:
reversing a signed scalar current does not reverse the SOT direction. A physical
sign convention must be represented by changing `spin_polarization` explicitly.

(sot-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization used in the amplitude | $\mathrm{A\,m^{-1}}$ |
| $J_e$ | charge-current-density magnitude used by SOT | $\mathrm{A\,m^{-2}}$ |
| $\mathbf J_{\mathrm{transport}}$ | resolved current-density vector from `CurrentTransport` | $\mathrm{A\,m^{-2}}$ |
| $\hat{\boldsymbol\sigma}$ | user-supplied spin-polarization direction | $1$ |
| $\xi_{\mathrm{DL}}$ | damping-like SOT efficiency | $1$ |
| $\xi_{\mathrm{FL}}$ | field-like SOT efficiency | $1$ |
| $t_F$ | ferromagnet thickness in the amplitude denominator | $\mathrm{m}$ |
| $H_{\mathrm{SOT}}$ | effective-field-like SOT amplitude | $\mathrm{A\,m^{-1}}$ |
| $\mathbf r_{\mathrm{SOT}}$ | dimensionless raw DL/FL vector combination | $1$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant | $\mathrm{m\,(A\,s)^{-1}}$ |
| $\alpha$ | Gilbert damping of the resolved material | $1$ |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ |
| $e$ | elementary-charge magnitude | $\mathrm{C}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $J_x,J_y,J_z$ | Cartesian components of the resolved current-density vector | $\mathrm{A\,m^{-2}}$ |

The implementation stores $\hat{\boldsymbol\sigma}$ as the user-provided vector
and normalizes it in the FDM CPU and GPU runtime before evaluating cross products.
The current Python constructor checks the vector length, while the IR validator
checks that all three components are finite. A zero vector is not rejected by the
current validator, but it has no defined physical polarization and the runtime
normalization floor makes its computed contribution zero; it should not be used
as a physical SOT direction.

(sot-assumptions-and-validity)=
## Assumptions and validity limits

The implemented model has the following exact scope:

1. **Prescribed current.** A scalar `charge_current_density_a_per_m2` or a named
   `CurrentTransport` source supplies the current. `current_source` is a reference
   to a source already present in `Problem.current_modules`; it is not a request
   to solve Ohm's law.
2. **One current binding.** The public object requires exactly one of the direct
   scalar and `current_source`. The IR and planner preserve this distinction even
   when both paths would resolve to the same magnitude.
3. **Uniform FM thickness.** `ferromagnet_thickness_m` is a positive scalar used
   in {eq}`eq-sot-amplitude` for every active cell of the resolved material.
4. **Uniform polarization.** `spin_polarization` is one vector for the module;
   there is no spatially varying spin accumulation or interface transparency.
5. **No self-consistent transport.** `CurrentTransport(model="ohmic_poisson")`
   is a semantic transport object, but it does not provide an executable SOT
   current vector on the current FDM path.
6. **No SOT energy.** The term is a direct non-conservative RHS contribution. It
   must not be included in a conservative relaxation energy or reported as
   `E_SOT`.
7. **Active-cell masking.** The FDM CPU and GPU direct-torque paths skip inactive
   cells. The torque is evaluated using the stage-time magnetization at each LLG
   right-hand-side evaluation.

(sot-python-api)=
## Python API

### Complete low-level Problem example

The canonical executable Python surface currently represents SOT through a
low-level `fm.Problem` snapshot. The example below is intentionally complete and
copyable. It records the field output `m`; SOT itself has no scalar energy output.

```python
# %% Imports and units
import fullmag as fm

nm = 1e-9

# %% FDM SOT problem
problem = fm.Problem(
    name="sot_switching",
    magnets=[
        fm.Ferromagnet(
            name="free_layer",
            geometry=fm.Box(size=(100 * nm, 100 * nm, 1 * nm)),
            material=fm.Material(name="CoFeB", Ms=1.0e6, A=15e-12, alpha=0.1),
            m0=fm.texture.uniform((0.0, 0.0, 1.0)),
        ),
    ],
    energy=[fm.Exchange(), fm.Demag()],
    spin_torques=[
        fm.SpinOrbitTorque(
            charge_current_density_a_per_m2=1.0e11,
            damping_like_efficiency=0.10,
            field_like_efficiency=0.0,
            spin_polarization=(0.0, 1.0, 0.0),
            ferromagnet_thickness_m=1 * nm,
        ),
    ],
    study=fm.TimeEvolution(
        dynamics=fm.LLG(),
        outputs=[fm.SaveField("m", every=1e-12)],
    ),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2 * nm, 2 * nm, 1 * nm)),
    ),
)

# %% Canonical ProblemIR inspection
problem_ir = problem.to_ir()
sot_ir = problem_ir["spin_torque_modules"][0]
assert sot_ir == {
    "kind": "spin_orbit_torque",
    "charge_current_density_a_per_m2": 1.0e11,
    "damping_like_efficiency": 0.10,
    "field_like_efficiency": 0.0,
    "spin_polarization": [0.0, 1.0, 0.0],
    "ferromagnet_thickness_m": 1e-9,
}
assert problem_ir["study"]["sampling"]["outputs"] == [
    {"kind": "field", "name": "m", "every_seconds": 1e-12},
]
```

This example lowers `SpinOrbitTorque` into
`ProblemIR.spin_torque_modules[]`. The `Exchange` and `Demag` terms are included
only to make the physical problem executable; their parameters are owned by
their respective documentation pages and are not SOT parameters.

### Named prescribed-current source

`current_source` is useful when the same prescribed current vector is shared by
several modules. It does not make `ohmic_poisson` executable for SOT.

```python
# %% Named CurrentTransport source
import fullmag as fm

nm = 1e-9
transport = fm.CurrentTransport(
    name="heavy_metal_drive",
    model="prescribed_density",
    current_density=(0.0, 1.5e11, 0.0),
)
torque = fm.SpinOrbitTorque(
    current_source="heavy_metal_drive",
    damping_like_efficiency=0.12,
    field_like_efficiency=0.01,
    spin_polarization=(0.0, 0.0, 1.0),
    ferromagnet_thickness_m=1.2 * nm,
)
problem = fm.Problem(
    name="sot_named_source",
    magnets=[
        fm.Ferromagnet(
            name="free_layer",
            geometry=fm.Box(size=(40 * nm, 40 * nm, 1.2 * nm)),
            material=fm.Material(name="FM", Ms=8.0e5, A=12e-12, alpha=0.05),
            m0=fm.texture.uniform((1.0, 0.0, 0.0)),
        ),
    ],
    energy=[fm.Exchange()],
    current_modules=[transport],
    spin_torques=[torque],
    study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
)

# %% Source binding and magnitude are preserved in IR
problem_ir = problem.to_ir()
assert problem_ir["current_modules"][0]["name"] == "heavy_metal_drive"
assert problem_ir["spin_torque_modules"][0]["current_source"] == "heavy_metal_drive"
```

### Stage-first public boundary

The stage-first `fm.study(...).stages` authoring surface is the normal way to
express ordered relaxation and time-evolution stages. It currently has no SOT
registration method. The following is therefore a valid stage boundary example,
not a claim that it enables SOT; SOT remains available through the low-level
`fm.Problem` route above until a stage-level interaction hook is implemented.

```python
# %% Stage-first boundary currently available to public scripts
import fullmag as fm

study = fm.study("sot-stage-boundary")
study.engine("fdm")
study.cell(2e-9, 2e-9, 1e-9)
body = study.geometry(fm.Box(40e-9, 40e-9, 1e-9), name="free_layer")
body.Ms = 1.0e6
body.Aex = 15e-12
body.alpha = 0.1
body.m = fm.texture.uniform(0.0, 0.0, 1.0)
study.stages.add_run(stage_id="run", until=2e-12)
```

### Complete parameter reference: `SpinOrbitTorque`

The following table is exhaustive for the current public constructor. There is
no separate public sign, interface-normal, spin-Hall-angle, conductivity,
solver-tolerance, or spatial-profile parameter on `SpinOrbitTorque`.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `SpinOrbitTorque.charge_current_density_a_per_m2` | `float or None` | `None` | $\mathrm{A\,m^{-2}}$ | strictly positive and finite when supplied; mutually exclusive with `current_source` | direct HM charge-current-density magnitude | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].charge_current_density_a_per_m2` |
| `SpinOrbitTorque.current_source` | `str or None` | `None` | $1$ | non-empty; mutually exclusive with `charge_current_density_a_per_m2`; must name a `CurrentTransport` in `Problem.current_modules` | named prescribed-current binding | FDM when source resolves; FEM rejected | `spin_torque_modules[].current_source` |
| `SpinOrbitTorque.damping_like_efficiency` | `float` | `0.0` | $1$ | converted to float; no explicit finite or range check in the current Python constructor or IR validator | damping-like efficiency $\xi_{\mathrm{DL}}$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].damping_like_efficiency` |
| `SpinOrbitTorque.field_like_efficiency` | `float` | `0.0` | $1$ | converted to float; no explicit finite or range check in the current Python constructor or IR validator | field-like efficiency $\xi_{\mathrm{FL}}$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].field_like_efficiency` |
| `SpinOrbitTorque.spin_polarization` | `Sequence[float]` | `(0.0, 0.0, 1.0)` | $1$ | exactly three values in Python; IR requires finite components; runtime normalizes the vector | supplied spin-polarization direction $\hat{\boldsymbol\sigma}$ | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].spin_polarization` |
| `SpinOrbitTorque.ferromagnet_thickness_m` | `float` | `1e-9` | $\mathrm{m}$ | strictly positive and finite | FM thickness $t_F$ in the amplitude denominator | FDM CPU/GPU; FEM rejected | `spin_torque_modules[].ferromagnet_thickness_m` |

### Complete parameter reference: `CurrentTransport` used by SOT

These are the current-transport parameters that can appear in the SOT
`current_source` path. They describe the source object; they do not add a
transport solve to SOT.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CurrentTransport.name` | `str` | required | $1$ | non-empty and unique within `Problem.current_modules` | source key referenced by `current_source` | FDM source lookup; no SOT FEM execution | `current_modules[].name` |
| `CurrentTransport.model` | `str` | `prescribed_density` | $1$ | `prescribed_density` or `ohmic_poisson`; normalized to lowercase | transport-model tag | `prescribed_density` is the executable SOT source; `ohmic_poisson` is semantic-only here | `current_modules[].model` |
| `CurrentTransport.current_density` | `Sequence[float] or None` | `None` | $\mathrm{A\,m^{-2}}$ per component | required for `prescribed_density`; forbidden for `ohmic_poisson`; IR requires finite components | prescribed current-density vector $\mathbf J_{\mathrm{transport}}$ | FDM prescribed-source resolution | `current_modules[].current_density` |
| `CurrentTransport.solve_region` | `str or None` | `None` | $1$ | non-empty when supplied | optional source-region metadata | serialized metadata; not an SOT transport solve | `current_modules[].solve_region` |
| `CurrentTransport.conductivity_s_per_m` | `float or None` | `None` | $\mathrm{S\,m^{-1}}$ | strictly positive when supplied | conductivity metadata | not used by the prescribed-density SOT lowering | `current_modules[].conductivity_s_per_m` |

(sot-problem-ir)=
## Python to ProblemIR lowering

`SpinOrbitTorque.to_ir_module()` emits one tagged object. The direct-current
variant is:

```json
{
  "kind": "spin_orbit_torque",
  "charge_current_density_a_per_m2": 100000000000.0,
  "damping_like_efficiency": 0.1,
  "field_like_efficiency": 0.0,
  "spin_polarization": [0.0, 1.0, 0.0],
  "ferromagnet_thickness_m": 1e-9
}
```

When a named source is used, the direct scalar key is absent and
`current_source` is emitted instead:

```json
{
  "kind": "spin_orbit_torque",
  "current_source": "heavy_metal_drive",
  "damping_like_efficiency": 0.12,
  "field_like_efficiency": 0.01,
  "spin_polarization": [0.0, 0.0, 1.0],
  "ferromagnet_thickness_m": 1.2e-9
}
```

`Problem.to_ir()` places the object in `spin_torque_modules`. It does not move
SOT into `energy_terms`, legacy Slonczewski fields, `current_modules`, or an
energy observable. The planner later resolves a source vector, if requested,
into the scalar $J_e$ in {eq}`eq-sot-source-magnitude`; that resolved value is
execution data, not a replacement for the requested IR binding.

(sot-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The canonical path is:

```text
Python SpinOrbitTorque
        ↓ to_ir_module()
ProblemIR.spin_torque_modules[0]
        ↓ IR validation
planner.resolve_sot_fields()
        ↓ resolved scalar current + SOT coefficients
FDM CPU reference or FDM CUDA LLG RHS
```

The round-trip must preserve both requested intent and resolved execution:

- **Requested intent** contains whether the user supplied a direct scalar or a
  named source, all six SOT constructor values, the `kind` tag, and the source
  identity when present.
- **Resolved execution** contains the selected FDM lane, the scalar magnitude
  resolved from a `CurrentTransport` vector when applicable, the material
  $M_s$ and $\alpha$, the effective thickness, precision, and runtime/device
  provenance.
- A source resolution must not rewrite the requested `current_source` into a
  direct-current request. That would destroy reproducibility and make two
  distinct authoring intents indistinguishable.

Validation errors and planner failures are fail-closed:

- neither current binding is supplied;
- both current bindings are supplied;
- a direct current is zero, negative, or non-finite;
- `current_source` is empty, unresolved, or names a non-`CurrentTransport` module;
- a prescribed-density source omits its current vector or contains non-finite
  components;
- the polarization vector is not length three or contains non-finite IR values;
- `ferromagnet_thickness_m` is not strictly positive and finite;
- more than one executable spin-torque module is sent to the current planner;
- a FEM CPU or FEM GPU lane is requested for SOT;
- `ohmic_poisson` is treated as though it had already produced a current vector.

These are unsupported combinations, not implicit requests to change the model or
fall back to another solver lane.

There is no silent CPU fallback for FEM requests and no conversion of the
non-conservative term into an energy term. A source vector with exactly zero
magnitude is representable by the current IR validation; the FDM reference
builder then returns no SOT configuration, so the realized direct contribution
is zero rather than an inferred polarization reversal.

(sot-discrete-realization)=
## Discrete realization by solver and device

### FDM CPU — `f64` reference lane

The planner resolves `SotConfig` fields and the CPU reference builds the
configuration with `build_sot`. For each active cell, the native path:

1. computes $H_{\mathrm{SOT}}$ from the absolute scalar current, resolved material
   $M_s$, and `thickness`;
2. normalizes `sigma` with a $10^{-30}$ lower norm floor;
3. evaluates the DL and FL cross products using the stage-time magnetization;
4. applies the Gilbert-form term with `gamma_bar` and the material $\alpha$;
5. adds the result into the AoS or persistent SoA RHS buffer.

No spatial derivative is used. This is different from Zhang–Li STT, which needs
a magnetization derivative. Inactive cells are skipped and receive no direct SOT
addition. The allocating `sot_torque` method and the in-place AoS/SoA methods
are separate source functions but implement the same local equation.

### FDM GPU — CUDA fused LLG RHS

The host-side `sot_params_from_ctx` creates a POD `SotParams` value containing
the normalized polarization, efficiencies, and the amplitude in $\mathrm{A\,m^{-1}}$.
The CUDA `llg_rhs_fp64_kernel` and `llg_rhs_fp32_kernel` receive those values by
value and add the SOT contribution to the fused stage RHS. FP64 and FP32 use the
same cross-product ordering and Gilbert term, but they are different floating-
point realizations. A source-level kernel declaration or a successful build is
not an executed-device parity result.

The CUDA path is used by the supported LLG integrator kernels that pass
`sot_params_from_ctx(ctx)` into the RHS. The stage predictor/corrector normalizes
the magnetization after the step; SOT itself is evaluated at each RHS stage.

### FEM CPU

The FEM planner rejects `SpinOrbitTorque` before a FEM field operator, boundary
condition, or energy reduction is selected. There is no FEM CPU SOT
implementation to compare with the FDM local-cell model, and no FEM boundary
condition may be inferred from the physical HM/FM description.

### FEM GPU

The FEM GPU lane has the same fail-closed planner boundary. The presence of
FDM CUDA RHS kernels does not provide a FEM GPU implementation, a nodal operator,
or a CPU fallback. A request for FEM GPU SOT is therefore an unsupported
combination, not a lower-performance implementation.

(sot-implementation-mapping)=
## Implementation mapping

| Layer | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python API | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SpinOrbitTorque` | constructor, scalar/source binding, and SOT IR | Python |
| Python binding | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `_resolve_scalar_current_binding` | exactly-one current binding and direct-scalar positivity | Python |
| Current source API | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | prescribed-density versus semantic Ohmic source object | Python |
| Problem lowering | `packages/fullmag-py/src/fullmag/model/problem.py` | `_spin_torque_modules_ir` | places canonical modules in `ProblemIR.spin_torque_modules` | Python/IR |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_spin_torque_modules` | binding, finite polarization, thickness, and source-reference checks | IR |
| FDM planner | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_sot_fields` | current-source magnitude resolution and SOT plan fields | FDM |
| FDM/FEM lane gate | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_legacy_spin_torque` | executable-lane policy and FEM rejection | FDM/FEM |
| FDM CPU configuration | `crates/fullmag-runner/src/fdm/cpu/reference/interactions.rs` | `build_sot` | converts resolved plan fields to `SotConfig` | FDM CPU |
| FDM CPU reference | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque` | allocating local SOT reference | FDM CPU |
| FDM CPU AoS | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque_add_into` | in-place array-of-structures RHS addition | FDM CPU |
| FDM CPU SoA | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque_add_into_soa` | persistent structure-of-arrays RHS addition | FDM CPU |
| FDM GPU parameters | `backends/fdm/include/context.hpp` | `sot_params_from_ctx` | normalization and amplitude construction for CUDA | FDM GPU |
| FDM GPU FP64 | `backends/fdm/gpu/cuda/integrators/llg_fp64.cu` | `llg_rhs_fp64_kernel` | fused double-precision SOT RHS contribution | FDM GPU |
| FDM GPU FP32 | `backends/fdm/gpu/cuda/integrators/llg_fp32.cu` | `llg_rhs_fp32_kernel` | fused single-precision SOT RHS contribution | FDM GPU |
| CPU analytic test | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_macrospin_is_converted_to_rhs_with_gilbert_projection` | sign, amplitude, and Gilbert projection contract | test |

(sot-validation)=
## Validation and qualification

### Contract validation

This page is complete only when all of the following are checked:

1. every Python block parses and executes with the repository `fullmag` package;
2. the adjacent source map validates all source declarations, equations,
   symbols, exhaustive parameter rows, and four backend lanes;
3. strict Sphinx builds the page with warnings and nitpicky-reference checks;
4. rendered HTML contains MathJax nodes and code-block copy controls;
5. the source-backed Python and native tests remain green.

### Scientific status

| Lane | Source evidence | Qualification status |
|---|---|---|
| FDM CPU | `sot_torque`, `sot_torque_add_into`, `sot_torque_add_into_soa`, and `sot_macrospin_is_converted_to_rhs_with_gilbert_projection` | Source-backed `f64` reference; analytic test is not a full production runtime qualification. |
| FDM GPU FP64 | `sot_params_from_ctx` and `llg_rhs_fp64_kernel` | CUDA implementation present; current executed-device parity evidence is separate. |
| FDM GPU FP32 | `sot_params_from_ctx` and `llg_rhs_fp32_kernel` | CUDA implementation present; FP64/FP32 numerical qualification is separate. |
| FEM CPU | planner rejection through `resolve_legacy_spin_torque` | Not executable. |
| FEM GPU | planner rejection through `resolve_legacy_spin_torque` | Not executable. |

The minimum analytic checks are:

- with $\mathbf m=\hat{\mathbf x}$ and
  $\hat{\boldsymbol\sigma}=\hat{\mathbf z}$, the raw FL contribution points
  along $-\hat{\mathbf y}$ and the raw DL contribution along $+\hat{\mathbf z}$
  for positive efficiencies;
- doubling $\lvert J_e\rvert$ doubles $H_{\mathrm{SOT}}$;
- doubling $t_F$ halves $H_{\mathrm{SOT}}$;
- setting both efficiencies to zero produces a zero direct contribution;
- inactive cells do not receive a direct SOT addition;
- a resolved zero-magnitude current source produces no SOT configuration in the
  FDM reference builder.

(sot-limitations)=
## Limitations and deferred work

- no self-consistent heavy-metal charge solve or spin drift-diffusion solve;
- no spin back-flow, interface transparency, or spatially varying spin
  accumulation;
- no anisotropic efficiency tensor or spatially varying efficiency field;
- no geometry-derived interface normal or automatic sign convention;
- no FEM CPU or FEM GPU realization;
- no standalone SOT energy observable;
- no public stage-builder method that registers SOT;
- the current IR validator does not impose a finite/range restriction on DL/FL
  efficiencies beyond their conversion to floating-point values;
- source-level CUDA presence is not fresh executed-device qualification;
- `CurrentTransport(model="ohmic_poisson")` remains semantic-only for this SOT
  path.

(sot-scientific-bibliography)=
## Scientific bibliography

1. A. Manchon and S. Zhang, “Theory of spin torque due to spin-orbit coupling,”
   *Physical Review B* **79**, 094422 (2009),
   [doi:10.1103/PhysRevB.79.094422](https://doi.org/10.1103/PhysRevB.79.094422).
2. L. Liu, O. J. Lee, T. J. Gudmundsen, D. C. Ralph, and R. A. Buhrman,
   “Current-induced switching of perpendicularly magnetized magnetic layers using
   spin torque from the spin Hall effect,” *Physical Review Letters* **109**,
   096602 (2012),
   [doi:10.1103/PhysRevLett.109.096602](https://doi.org/10.1103/PhysRevLett.109.096602).
3. K. Garello et al., “Symmetry and magnitude of spin–orbit torques in
   ferromagnetic heterostructures,” *Nature Nanotechnology* **8**, 587 (2013),
   [doi:10.1038/nnano.2013.145](https://doi.org/10.1038/nnano.2013.145).
4. P. M. Haney, H.-W. Lee, K.-J. Lee, A. Manchon, and M. D. Stiles, “Current
   induced torques and interfacial spin-orbit coupling: semiclassical modeling,”
   *Physical Review B* **87**, 174411 (2013),
   [doi:10.1103/PhysRevB.87.174411](https://doi.org/10.1103/PhysRevB.87.174411).

(sot-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Public SOT object | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SpinOrbitTorque` | constructor and `spin_orbit_torque` IR module | Python |
| Current binding | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `_resolve_scalar_current_binding` | direct scalar/source exclusivity | Python |
| Current source object | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | prescribed-density source contract | Python |
| Problem placement | `packages/fullmag-py/src/fullmag/model/problem.py` | `_spin_torque_modules_ir` | canonical module collection | Python/IR |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_spin_torque_modules` | SOT binding and domain validation | IR |
| SOT source resolution | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_sot_fields` | vector-to-magnitude source resolution | planner |
| FEM lane rejection | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_legacy_spin_torque` | fail-closed FEM policy | planner |
| FDM CPU plan conversion | `crates/fullmag-runner/src/fdm/cpu/reference/interactions.rs` | `build_sot` | `SotConfig` construction | FDM CPU |
| FDM CPU allocating reference | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque` | reference direct torque | FDM CPU |
| FDM CPU AoS | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque_add_into` | in-place direct torque | FDM CPU |
| FDM CPU SoA | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque_add_into_soa` | persistent direct torque | FDM CPU |
| FDM GPU parameter pack | `backends/fdm/include/context.hpp` | `sot_params_from_ctx` | normalized CUDA parameter pack | FDM GPU |
| FDM GPU FP64 RHS | `backends/fdm/gpu/cuda/integrators/llg_fp64.cu` | `llg_rhs_fp64_kernel` | fused SOT contribution | FDM GPU |
| FDM GPU FP32 RHS | `backends/fdm/gpu/cuda/integrators/llg_fp32.cu` | `llg_rhs_fp32_kernel` | fused SOT contribution | FDM GPU |
| Analytic projection test | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_macrospin_is_converted_to_rhs_with_gilbert_projection` | macrospin sign and magnitude check | test |
