---
title: Spin-Orbit Torque Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0800-fdm-sot.md
---

(sot-api-problem-statement)=
# Spin-Orbit Torque Python API

This page documents the public Python object `SpinOrbitTorque`, its canonical
`ProblemIR` representation, the current-source binding, and the realized FDM
CPU/GPU execution paths. Spin-orbit torque is a non-conservative direct torque;
it does not add an energy term. The current implementation is FDM-only. FEM CPU
and FEM GPU reject this module during planning, so their status is not silently
reported as a slower or equivalent implementation.

(sot-api-governing-equations)=
## Governing equations

The reduced magnetization is $\mathbf m=\mathbf M/M_s$ with $|\mathbf m|=1$. For charge-current magnitude
$|J_e|$, damping-like efficiency $\xi_{\mathrm{DL}}$, field-like efficiency
$\xi_{\mathrm{FL}}$, polarization direction $\hat{\boldsymbol\sigma}$, and
ferromagnet thickness $t_F$, the effective amplitude used by the implementation is

```{math}
:label: eq-sot-api-amplitude
H_{\mathrm{SOT}} =
\frac{\hbar\,|J_e|}{2 e \mu_0 M_s t_F}.
```

$H_{\mathrm{SOT}}$ has units of $\mathrm{A\,m^{-1}}$. The direct vector
contribution before the Gilbert-form projection is

```{math}
:label: eq-sot-api-raw
\mathbf R_{\mathrm{SOT}} =
H_{\mathrm{SOT}}
\left[-\xi_{\mathrm{DL}}\,\mathbf m\times
  (\mathbf m\times\hat{\boldsymbol\sigma})
  +\xi_{\mathrm{FL}}\,\mathbf m\times\hat{\boldsymbol\sigma}\right].
```

The native FDM RHS applies the same Gilbert-form conversion as the surrounding
LLG implementation. With $\gamma_{\mu_0}$ and damping $\alpha$, the SOT part of
the exported derivative is

```{math}
:label: eq-sot-api-llg
\left.\frac{\mathrm d\mathbf m}{\mathrm dt}\right|_{\mathrm{SOT}}
=\gamma_{\mu_0} H_{\mathrm{SOT}}
\left(\mathbf r+\alpha\,\mathbf m\times\mathbf r\right),
\qquad
\mathbf r=-\xi_{\mathrm{DL}}\,\mathbf m\times
(\mathbf m\times\hat{\boldsymbol\sigma})
+\xi_{\mathrm{FL}}\,\mathbf m\times\hat{\boldsymbol\sigma}.
```

The CPU reference and CUDA kernels use the equivalent component expressions.
The absolute value $|J_e|$ is deliberate: the current sign is not used to
reverse this SOT source in the present public contract. A sign-dependent spin
polarization must be represented by `spin_polarization` explicitly.

(sot-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $J_e$ | charge-current density magnitude | $\mathrm{A\,m^{-2}}$ |
| $\hat{\boldsymbol\sigma}$ | spin-polarization direction | $1$ |
| $\xi_{\mathrm{DL}}$ | damping-like efficiency | $1$ |
| $\xi_{\mathrm{FL}}$ | field-like efficiency | $1$ |
| $t_F$ | ferromagnet thickness | $\mathrm{m}$ |
| $H_{\mathrm{SOT}}$ | SOT effective-field amplitude | $\mathrm{A\,m^{-1}}$ |
| $\mathbf R_{\mathrm{SOT}}$ | effective-field-like SOT vector | $\mathrm{A\,m^{-1}}$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant | $\mathrm{m\,(A\,s)^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ |
| $e$ | elementary-charge magnitude | $\mathrm{C}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf J_{\mathrm{transport}}$ | resolved current-density vector | $\mathrm{A\,m^{-2}}$ |

The vector supplied as `spin_polarization` may have any finite non-zero norm at
the Python boundary. The FDM runtime normalizes it before constructing the
cross products. A zero vector therefore produces no defined polarization and is
not a valid physical input even if it survives the Python vector-shape check.

(sot-api-assumptions-and-validity)=
## Assumptions and validity limits

The public object represents a prescribed-current, single-ferromagnet SOT model.
It does not solve charge transport, spin diffusion, interfacial transparency, or
spin back-flow. The torque is applied cell-locally and uniformly through the
modeled ferromagnet thickness. Consequently, it is not a boundary-element
interface condition and it cannot represent a spatially varying spin
accumulation.

The amplitude uses the resolved material $M_s$ and the positive scalar
`ferromagnet_thickness_m`. The current may be supplied directly or by a named
`CurrentTransport` module, but not both. `current_source` is a reference, not a
request to run an Ohmic solve: the present executable source path resolves a
prescribed current-density vector and uses its magnitude.

(sot-api-python-api)=
## Python API

### Direct prescribed current

The following notebook cell is complete and executable. It lowers the public
problem to `ProblemIR` and checks the exact SOT module fields.

```python
# %% Direct FDM SOT problem
import fullmag as fm

nm = 1e-9
problem = fm.Problem(
    name="sot_direct_current",
    magnets=[
        fm.Ferromagnet(
            name="free_layer",
            geometry=fm.Box(size=(100 * nm, 100 * nm, 1 * nm)),
            material=fm.Material(name="CoFeB", Ms=1.0e6, A=15e-12, alpha=0.1),
            m0=fm.texture.uniform((0.0, 0.0, 1.0)),
        )
    ],
    energy=[fm.Exchange(), fm.Demag()],
    spin_torques=[
        fm.SpinOrbitTorque(
            charge_current_density_a_per_m2=1.0e11,
            damping_like_efficiency=0.10,
            field_like_efficiency=0.01,
            spin_polarization=(0.0, 1.0, 0.0),
            ferromagnet_thickness_m=1 * nm,
        )
    ],
    study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2 * nm, 2 * nm, 1 * nm))
    ),
)

ir = problem.to_ir()
sot_ir = ir["spin_torque_modules"][0]
assert sot_ir["kind"] == "spin_orbit_torque"
assert sot_ir["charge_current_density_a_per_m2"] == 1.0e11
assert sot_ir["damping_like_efficiency"] == 0.10
assert sot_ir["field_like_efficiency"] == 0.01
assert sot_ir["spin_polarization"] == [0.0, 1.0, 0.0]
```

### Named current source

Use `current_source` when the source must be shared by several physics modules.
The source is exclusive with the direct scalar current argument.

```python
# %% SOT bound to a prescribed current-transport module
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
        )
    ],
    energy=[fm.Exchange()],
    current_modules=[transport],
    spin_torques=[torque],
    study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
)

ir = problem.to_ir()
assert ir["current_modules"][0]["name"] == "heavy_metal_drive"
assert ir["spin_torque_modules"][0]["current_source"] == "heavy_metal_drive"
```

### Inspecting the standalone object

`to_ir_module()` is useful for tests and tooling that need the canonical module
without constructing a complete simulation.

```python
# %% Standalone canonical module inspection
import fullmag as fm

torque = fm.SpinOrbitTorque(
    charge_current_density_a_per_m2=2.0e11,
    damping_like_efficiency=0.08,
    field_like_efficiency=-0.02,
    spin_polarization=(1.0, 0.0, 0.0),
    ferromagnet_thickness_m=2.0e-9,
)
module_ir = torque.to_ir_module()
assert module_ir == {
    "kind": "spin_orbit_torque",
    "charge_current_density_a_per_m2": 2.0e11,
    "damping_like_efficiency": 0.08,
    "field_like_efficiency": -0.02,
    "spin_polarization": [1.0, 0.0, 0.0],
    "ferromagnet_thickness_m": 2.0e-9,
}
```

(sot-api-parameter-reference)=
## Complete parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| SpinOrbitTorque.charge_current_density_a_per_m2 | float or None | None | $\mathrm{A\,m^{-2}}$ | positive when supplied; mutually exclusive with current_source | direct current-density magnitude | FDM CPU/GPU; FEM rejected | spin_torque_modules[].charge_current_density_a_per_m2 |
| SpinOrbitTorque.current_source | str or None | None | $1$ | non-empty and must reference CurrentTransport; mutually exclusive with direct current | named current source | prescribed-density FDM source resolution | spin_torque_modules[].current_source |
| SpinOrbitTorque.damping_like_efficiency | float | 0.0 | $1$ | dimensionless; signed values are preserved | damping-like SOT efficiency | FDM CPU/GPU | spin_torque_modules[].damping_like_efficiency |
| SpinOrbitTorque.field_like_efficiency | float | 0.0 | $1$ | dimensionless; signed values are preserved | field-like SOT efficiency | FDM CPU/GPU | spin_torque_modules[].field_like_efficiency |
| SpinOrbitTorque.spin_polarization | Sequence[float] | (0, 0, 1) | $1$ | three finite components; normalized by FDM runtime | spin-polarization direction | FDM CPU/GPU | spin_torque_modules[].spin_polarization |
| SpinOrbitTorque.ferromagnet_thickness_m | float | 1e-9 | $\mathrm{m}$ | strictly positive | ferromagnet thickness in amplitude denominator | FDM CPU/GPU | spin_torque_modules[].ferromagnet_thickness_m |

The public constructor does not expose a separate sign parameter, interface
normal, spin Hall angle, conductivity, or solver tolerance. Adding one of these
to a script does not change the IR and is not a supported API extension. The
present contract treats `damping_like_efficiency` and `field_like_efficiency` as
dimensionless resolved coefficients.

### CurrentTransport parameters used by `current_source`

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| CurrentTransport.name | str | required | $1$ | non-empty and unique | named source key | source lookup | current_modules[].name |
| CurrentTransport.model | str | prescribed_density | $1$ | prescribed_density or ohmic_poisson | transport model | prescribed_density executable; ohmic_poisson semantic-only | current_modules[].model |
| CurrentTransport.current_density | Sequence[float] or None | None | $\mathrm{A\,m^{-2}}$ | required for prescribed_density; forbidden for ohmic_poisson | source vector | prescribed-density source resolution | current_modules[].current_density |
| CurrentTransport.solve_region | str or None | None | $1$ | non-empty when supplied | source region identifier | serialized source metadata | current_modules[].solve_region |
| CurrentTransport.conductivity_s_per_m | float or None | None | $\mathrm{S\,m^{-1}}$ | positive when supplied | conductivity metadata | serialized; not an Ohmic execution proof | current_modules[].conductivity_s_per_m |

For SOT source resolution, the planner computes

```{math}
:label: eq-sot-api-source-magnitude
J_e = \left|\mathbf J_{\mathrm{transport}}\right|
=\sqrt{J_x^2+J_y^2+J_z^2}.
```

This magnitude then enters `eq-sot-api-amplitude`. The source vector direction
does not replace `spin_polarization`.

(sot-api-problem-ir)=
## Python to ProblemIR lowering

`SpinOrbitTorque.to_ir_module()` emits a tagged object with
`kind="spin_orbit_torque"`. It emits exactly one current binding and the four
physical parameters:

```json
{
  "kind": "spin_orbit_torque",
  "charge_current_density_a_per_m2": 200000000000.0,
  "damping_like_efficiency": 0.08,
  "field_like_efficiency": -0.02,
  "spin_polarization": [1.0, 0.0, 0.0],
  "ferromagnet_thickness_m": 2e-9
}
```

When a named source is used, the direct current key is absent and
`current_source` is emitted instead. `Problem.to_ir()` places the module in
`spin_torque_modules`; it does not convert SOT into an energy term or into legacy
Slonczewski fields. The IR validator additionally checks source existence,
finite polarization components, and positive thickness.

(sot-api-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The canonical round-trip is Python object → `ProblemIR.spin_torque_modules[]` →
planner. A direct current and a source binding are distinct requested intents,
even if they resolve to the same numerical magnitude. The resolved execution
record must preserve which binding was requested and which source vector was
resolved.

These validation errors are raised before execution. The following unsupported combinations are errors:

- neither current binding is supplied;
- both current bindings are supplied;
- a direct current is not positive;
- `current_source` is empty or names no current module;
- a prescribed-density source has no three-component current vector;
- the polarization vector contains non-finite values;
- `ferromagnet_thickness_m` is not strictly positive;
- a FEM lane is requested for a SOT module.

`ohmic_poisson` is accepted by `CurrentTransport` as semantic input but is not a
claim that an Ohmic current solve has executed. Its use with SOT remains outside
the qualified executable source path.

(sot-api-discrete-realization)=
## Discrete realization by solver and device

### FDM CPU

The CPU reference builds a cell-local `SotConfig` from the resolved plan. It
computes the normalized polarization, the amplitude, and the two cross-product
terms for each cell. No spatial derivative is used. The term is evaluated at
each LLG/RK stage and inactive cells receive no direct torque. The CPU path is
the semantic reference for signs and units, but its current qualification is
separate from source inspection.

### FDM GPU

CUDA passes a compact `SotParams` value into the fused LLG RHS. The FP64 and FP32
implementations evaluate the same normalized polarization, amplitude, damping-
like vector, field-like vector, and Gilbert cross term. The GPU lane therefore
shares the public equation but has a distinct floating-point realization. A
successful kernel build is not equivalent to executed-device parity evidence.

### FEM CPU

The planner rejects SOT for the FEM lane with an explicit
`spin_orbit_torque is not executable on the FEM lane` error. There is no FEM CPU
field, energy, or boundary realization to document as implemented.

### FEM GPU

FEM GPU is subject to the same planner rejection. No FEM GPU SOT kernel exists
in the current public contract. It must not be inferred from the existence of
FDM CUDA kernels.

(sot-api-implementation-mapping)=
## Implementation mapping

The public API maps to the implementation as follows:

| Layer | Source and stable symbol | Responsibility |
|---|---|---|
| Python DSL | `packages/fullmag-py/src/fullmag/model/spin_torque.py`, `class SpinOrbitTorque` | exclusive current binding and parameter validation |
| Python lowering | same file, `class SpinOrbitTorque` | canonical tagged module |
| Problem lowering | `packages/fullmag-py/src/fullmag/model/problem.py`, `_spin_torque_modules_ir` | placement in `spin_torque_modules` |
| IR validation | `crates/fullmag-ir/src/validation.rs`, `validate_spin_torque_modules` | binding, finiteness, and domain checks |
| FDM planning | `crates/fullmag-plan/src/spin_torque.rs`, `resolve_sot_fields` | source resolution and FEM legality boundary |
| FDM plan fields | `crates/fullmag-plan/src/fdm.rs`, `plan_fdm` | copies resolved SOT values into FDM plan |
| FDM CPU | `crates/fullmag-runner/src/fdm/cpu/reference/interactions.rs`, `build_sot` | builds `SotConfig` |
| FDM CPU kernel | `crates/fullmag-engine/src/fdm/cpu/fields.rs`, `sot_torque_add_into` and `sot_torque_add_into_soa` | cell-local direct torque |
| FDM GPU state | `backends/fdm/include/context.hpp`, `sot_params_from_ctx` | normalization and amplitude construction |
| FDM GPU RHS | `backends/fdm/gpu/cuda/integrators/llg_fp64.cu`, `llg_rhs_fp64_kernel`; FP32 analogue | fused CUDA stage contribution |
| C API transfer | `backends/fdm/api/c_api.cpp`, `fullmag_fdm_backend_create` | copies plan fields into native context |

(sot-api-validation)=
## Validation and qualification

The contract-level validation required for this page is:

1. execute every Python code block with the repository Python package;
2. validate this source map against the documentation contract;
3. render the complete Sphinx site with warnings and nitpicky reference checks;
4. validate the rendered SOT API page for equations, symbols, anchors, and source
   references;
5. run the Python IA and scientific-documentation contract test suites.

Scientific qualification remains lane-specific:

| Lane | Current status | What is and is not proven |
|---|---|---|
| FDM CPU | partial | source-backed reference path; analytic checks are not a device qualification |
| FDM GPU | partial | FP64/FP32 CUDA implementation exists; executed-device parity must be recorded separately |
| FEM CPU | not executable | planner rejection is the current contract |
| FEM GPU | not executable | planner rejection is the current contract |

The direct torque has no standalone energy observable. A correct energy report
must not include an `E_SOT` term merely because SOT was enabled.

(sot-api-limitations)=
## Limitations and deferred work

- no self-consistent charge or spin drift-diffusion solve;
- no spatially varying polarization or interface transparency;
- no anisotropic efficiency tensor;
- no explicit interface-boundary FEM realization;
- no FEM CPU or FEM GPU implementation;
- no claim of fresh executed-device CUDA qualification on this reference page;
- current direction reversal is not a separate public sign parameter;
- `ohmic_poisson` current transport remains semantic-only for this torque path.

(sot-api-scientific-bibliography)=
## Scientific bibliography

1. A. Manchon and S. Zhang, “Theory of spin torque due to spin-orbit coupling,”
   *Physical Review B* **79**, 094422 (2009),
   [doi:10.1103/PhysRevB.79.094422](https://doi.org/10.1103/PhysRevB.79.094422).
2. L. Liu, O. J. Lee, T. J. Gudmundsen, D. C. Ralph, and R. A. Buhrman,
   “Current-induced switching of perpendicularly magnetized magnetic layers using
   spin torque from the spin Hall effect,” *Physical Review Letters* **109**,
   096602 (2012), [doi:10.1103/PhysRevLett.109.096602](https://doi.org/10.1103/PhysRevLett.109.096602).
3. K. Garello et al., “Symmetry and magnitude of spin–orbit torques in ferromagnetic
   heterostructures,” *Nature Nanotechnology* **8**, 587 (2013),
   [doi:10.1038/nnano.2013.145](https://doi.org/10.1038/nnano.2013.145).

(sot-api-source-code-index)=
## Source-code index

| Claim | File | Stable symbol |
|---|---|---|
| public constructor and module | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SpinOrbitTorque` |
| canonical module lowering | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SpinOrbitTorque` |
| problem placement | `packages/fullmag-py/src/fullmag/model/problem.py` | `_spin_torque_modules_ir` |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_spin_torque_modules` |
| SOT source resolution | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_sot_fields` |
| FDM CPU configuration | `crates/fullmag-runner/src/fdm/cpu/reference/interactions.rs` | `build_sot` |
| FDM CPU AoS torque | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque_add_into` |
| FDM CPU SoA torque | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `sot_torque_add_into_soa` |
| FDM GPU amplitude | `backends/fdm/include/context.hpp` | `sot_params_from_ctx` |
| FDM GPU FP64 RHS | `backends/fdm/gpu/cuda/integrators/llg_fp64.cu` | `llg_rhs_fp64_kernel` |
| FDM GPU FP32 RHS | `backends/fdm/gpu/cuda/integrators/llg_fp32.cu` | `llg_rhs_fp32_kernel` |

The page is `partial` because FDM implementation exists but current qualification
evidence is revision- and device-dependent; FEM lanes are explicitly not
executable.
