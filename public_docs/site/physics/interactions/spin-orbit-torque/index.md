---
title: Spin-orbit torque
description: Local damping-like and field-like spin-orbit torque with prescribed signed current or a named vector-current source.
status: partial
doc_kind: reference
---

(public-docs-physics-interactions-sot)=
# Spin-orbit torque

(physics-spin-orbit-torque-problem-statement)=
## Physical problem

`PrescribedSpinOrbitTorque` adds a local damping-like (DL) and field-like (FL)
source to the magnetization equation. It does **not** solve charge accumulation,
spin accumulation, spin diffusion, or an HM/FM interface problem. The authored
efficiencies already represent all conversion and transmission physics that the
model omits.

Use the tabs below to choose the correct model before assigning parameters.

::::{tab-set}
:::{tab-item} Prescribed local SOT

Use `PrescribedSpinOrbitTorque` when the signed current density, spin-polarization
axis, and effective DL/FL efficiencies are known inputs. The heavy-metal layer
does not need to be meshed. Runtime cost is that of a local LLG source.

This is the Fullmag counterpart of a MuMax-style `EnableSOT` model: `J` maps to
the signed drive, `Pol` to `sigma`, `ThetaSH` to `xi_dl`, `ThetaFL` to `xi_fl`,
and `FreeLayerThickness` to `free_layer_thickness_m`. The mapping is a parameter
mapping, not a claim that `xi_dl` equals a bulk spin Hall angle in a real stack.

:::
:::{tab-item} Solved SHE transport

Use the transport model when the torque must follow from material conductivities,
spin Hall angle, spin-relaxation lengths, boundary conditions, and HM/FM mixing
conductance. Fullmag then resolves

```text
CurrentTransport -> SpinDriftDiffusion -> interface absorption -> DriftDiffusionSpinTorque
```

That route produces a generally nonuniform torque and can include backflow and
finite-transparency effects. It is documented separately in
{doc}`Spin Hall drift-diffusion transport </physics/interactions/drift-diffusion-spin-torque/index>`.
Do not add `PrescribedSpinOrbitTorque` on top of the solved transport torque
unless the two sources intentionally represent different physics.

:::
::::

| Question | Prescribed local SOT | Solved SHE transport |
| --- | --- | --- |
| Primary input | signed current and effective `xi_dl`, `xi_fl` | material and interface transport parameters |
| Charge/spin PDE | none | solved |
| HM mesh | optional and not consumed by this torque | part of the transport domain |
| Spatial variation | target mask, material fields, and current-source projection | transport solution and interface absorption |
| Best use | calibrated reduced model, switching scans, MuMax comparison | stack design and spatial spin-transport studies |

(physics-spin-orbit-torque-governing-equations)=
## Governing equations and sign convention

Let $\mathbf m$ be the unit magnetization, $\hat{\boldsymbol\sigma}$ the unit spin
polarization, and $J_{\mathrm{signed}}$ the conventional signed charge-current
density. A thin-film reduction converts an effective spin angular-momentum flux
$(\hbar/2e)\,\xi J_{\mathrm{signed}}$ into a volume source by dividing by the
free-layer thickness $t_F$. Fullmag writes the resulting frequency scale as

```{math}
:label: eq-prescribed-sot-prefactor
\Omega_0 =
\frac{\gamma_e\hbar J_{\mathrm{signed}}}
     {2eM_s t_F},
\qquad
\Omega_{\mathrm{DL}}=\xi_{\mathrm{DL}}\Omega_0,
\qquad
\Omega_{\mathrm{FL}}=\xi_{\mathrm{FL}}\Omega_0.
```

Here $e>0$ is the elementary charge and $\gamma_e>0$ is the magnitude of the
electron gyromagnetic ratio. The canonical Gilbert-form source is

```{math}
:label: eq-prescribed-sot-gilbert
\mathbf T_{\mathrm{SOT}}^{G} =
\Omega_{\mathrm{DL}}\,
\mathbf m\times(\hat{\boldsymbol\sigma}\times\mathbf m)
+
\Omega_{\mathrm{FL}}\,
\mathbf m\times\hat{\boldsymbol\sigma}.
```

The first basis vector points toward the component of
$\hat{\boldsymbol\sigma}$ transverse to $\mathbf m$; the second is orthogonal to
both. Reversing the signed current, reversing `sigma`, or reversing either one
of the signed efficiencies reverses the corresponding source. Reversing both
the current and `sigma` leaves the torque unchanged.

### Gilbert-to-explicit conversion

Backends add an explicit right-hand-side contribution after solving the Gilbert
form once. For damping $\alpha$, the implemented coefficient convention is

```{math}
:label: eq-prescribed-sot-explicit
\mathbf T_{\mathrm{SOT}} =
\frac{\Omega_0}{1+\alpha^2}
\left[
(\xi_{\mathrm{DL}}-\alpha\xi_{\mathrm{FL}})
\mathbf m\times(\hat{\boldsymbol\sigma}\times\mathbf m)
+
(\xi_{\mathrm{FL}}+\alpha\xi_{\mathrm{DL}})
\mathbf m\times\hat{\boldsymbol\sigma}
\right].
```

This mixing is why MuMax-style code often contains an apparent compensation
between DL and FL coefficients. Author physical `xi_dl` and `xi_fl`; do not
pre-apply the $1/(1+\alpha^2)$ transform in Python.

(physics-spin-orbit-torque-drives)=
## Drive definitions

### Signed scalar drive

`SignedScalarDrive` is the direct reduced-model input:

```{math}
:label: eq-prescribed-sot-scalar-drive
J_{\mathrm{signed}}(t)=J_0 f(t),
\qquad
\hat{\boldsymbol\sigma}=
\frac{\boldsymbol\sigma}{\lVert\boldsymbol\sigma\rVert}.
```

`J_0` may be positive, negative, or zero. `sigma` is normalized during
authoring. The optional envelope must be one of the canonical Fullmag envelope
objects: `ConstantEnvelope`, `SinusoidalEnvelope`, `PulseEnvelope`,
`PiecewiseLinearEnvelope`, `SincEnvelope`, or `TabulatedEnvelope`.

### Vector-current binding

`VectorCurrentDrive` binds the torque to a named vector-current source while
making the geometric convention explicit:

```{math}
:label: eq-prescribed-sot-vector-drive
J_{\mathrm{signed}} = \mathbf J_c\cdot\hat{\mathbf t},
\qquad
\hat{\boldsymbol\sigma} =
\frac{\hat{\mathbf n}_{NF}\times\hat{\mathbf t}}
     {\lVert\hat{\mathbf n}_{NF}\times\hat{\mathbf t}\rVert}.
```

`drive_direction` defines $\hat{\mathbf t}$ and `interface_normal` defines the
oriented normal $\hat{\mathbf n}_{NF}$ from the nonmagnetic layer toward the
ferromagnet. Both authored axes are normalized. They must be nonzero and must
not be parallel within the canonical axis tolerance $10^{-12}$. The projection
preserves current reversal; the polarization axis does not flip when only the
source current reverses.

(physics-spin-orbit-torque-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $m$ | unit magnetization | $1$ |
| $\hat{\boldsymbol\sigma}$ | unit spin-polarization axis | $1$ |
| $J_{\mathrm{signed}}$ | signed conventional charge-current density driving the local source | $\mathrm{A\,m^{-2}}$ (`A/m^2`) |
| $\mathbf J_c$ | named vector charge-current density | $\mathrm{A\,m^{-2}}$ (`A/m^2`) |
| $\hat{\mathbf t}$ | normalized current-projection direction | $1$ |
| $\hat{\mathbf n}_{NF}$ | normalized oriented nonmagnet-to-ferromagnet interface normal | $1$ |
| $\xi_{\mathrm{DL}}$ | signed effective damping-like efficiency | $1$ |
| $\xi_{\mathrm{FL}}$ | signed effective field-like efficiency | $1$ |
| $t_F$ | physical free-layer thickness | $\mathrm{m}$ (`m`) |
| $M_s$ | local saturation magnetization | $\mathrm{A\,m^{-1}}$ (`A/m`) |
| $\gamma_e$ | positive magnitude of electron gyromagnetic ratio | $\mathrm{s^{-1}\,T^{-1}}$ (`1/(s T)`) |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ (`J s`) |
| $e$ | positive elementary charge | $\mathrm{C}$ (`C`) |
| $\alpha$ | Gilbert damping | $1$ |
| $\Omega_0$ | signed base torque frequency | $\mathrm{s^{-1}}$ (`1/s`) |
| $\mathbf T_{\mathrm{SOT}}$ | prescribed spin-orbit torque contribution | $\mathrm{s^{-1}}$ (`1/s`) |
| $f(t)$ | canonical scalar time-envelope multiplier | $1$ |

(physics-spin-orbit-torque-assumptions-and-validity)=
## Assumptions and validity

- The ferromagnet is represented by a unit magnetization with positive local $M_s$.
- The HM/FM conversion is reduced to signed effective efficiencies; bulk spin Hall angle,
  interface transparency, spin backflow, and diffusion are not solved.
- The free-layer thickness is an authored physical parameter and is not inferred from mesh cells.
- `VectorCurrentDrive` uses fixed authored axes and one signed projection of a named current source.
- The source is local to the resolved target mask; it does not generate an Oersted field.

(physics-spin-orbit-torque-python-api)=
## Python authoring

### Complete stage-first example

```python
# %% Study and execution policy
import fullmag as fm

nm = 1.0e-9
study = fm.study("prescribed_sot_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

# %% Geometry, material, and initial state
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Canonical prescribed SOT
sot = fm.PrescribedSpinOrbitTorque(
    name="hm_sot",
    target=fm.RegionRef("film"),
    drive=fm.SignedScalarDrive(
        current_density_Apm2=-4.0e11,
        sigma=(0.0, 1.0, 0.0),
    ),
    xi_dl=0.12,
    xi_fl=-0.03,
    free_layer_thickness_m=1.5 * nm,
)
study.spin_torque(sot)

# %% Ordered run stage
study.stages.add_run(stage_id="drive", until=1.0e-12)
```

The sign in `current_density_Apm2` is retained in ProblemIR. The authored
`sigma=(0, 1, 0)` is normalized and serialized as `sigma_hat`.

### Binding to an existing vector-current source

If the study already contains a current module named `charge`, replace the
drive object only:

```python
# %% Alternative object-level vector-current binding
drive = fm.VectorCurrentDrive(
    current_source="charge",
    drive_direction=(1.0, 0.0, 0.0),
    interface_normal=(0.0, 0.0, 1.0),
)

sot = fm.PrescribedSpinOrbitTorque(
    name="hm_sot_from_charge",
    target=fm.RegionRef("film"),
    drive=drive,
    xi_dl=0.12,
    xi_fl=-0.03,
    free_layer_thickness_m=1.5e-9,
)
sot.to_ir_module()
```

For these axes, $\hat{\boldsymbol\sigma}=\hat{\mathbf z}\times\hat{\mathbf x}
=\hat{\mathbf y}$ and only the $x$ projection of the named current contributes.
`VectorCurrentDrive` has no independent envelope argument; timing belongs to the
named current source.

### Constructor reference

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PrescribedSpinOrbitTorque.name` | `str` | `required` | $1$ | non-empty | stable module ID | all prescribed-SOT lanes | `spin_torque_modules[].id` |
| `PrescribedSpinOrbitTorque.target` | `RegionRef` | `required` | $1$ | exact RegionRef resolving to magnetic target | torque target | all prescribed-SOT lanes | `spin_torque_modules[].target` |
| `PrescribedSpinOrbitTorque.drive` | `SignedScalarDrive or VectorCurrentDrive` | `required` | $1$ | exact canonical drive type | signed current and polarization definition | all prescribed-SOT lanes after planning | `spin_torque_modules[].drive` |
| `PrescribedSpinOrbitTorque.xi_dl` | `float` | `required` | $1$ | finite | signed damping-like efficiency | all prescribed-SOT lanes | `spin_torque_modules[].xi_dl` |
| `PrescribedSpinOrbitTorque.xi_fl` | `float` | `0.0` | $1$ | finite | signed field-like efficiency | all prescribed-SOT lanes | `spin_torque_modules[].xi_fl` |
| `PrescribedSpinOrbitTorque.free_layer_thickness_m` | `float` | `required` | $\mathrm{m}$ (`m`) | finite and positive | physical free-layer thickness | all prescribed-SOT lanes | `spin_torque_modules[].free_layer_thickness_m` |
| `SignedScalarDrive.current_density_Apm2` | `float` | `required` | $\mathrm{A\,m^{-2}}$ (`A/m^2`) | finite; sign retained | prescribed scalar current amplitude | all prescribed-SOT lanes | `spin_torque_modules[].drive.current_density_Apm2` |
| `SignedScalarDrive.sigma` | `Sequence[float]` | `required` | $1$ | finite nonzero three-axis vector; normalized | authored spin-polarization direction | all prescribed-SOT lanes | `spin_torque_modules[].drive.sigma_hat` |
| `SignedScalarDrive.envelope` | `TimeEnvelope or None` | `None` | $1$ | canonical supported envelope type | scalar time multiplier | bounded prescribed-SOT lanes | `spin_torque_modules[].drive.envelope` |
| `VectorCurrentDrive.current_source` | `str` | `required` | $1$ | non-empty and resolvable named current source | vector-current producer | planner-resolved prescribed-SOT lanes | `spin_torque_modules[].drive.current_source_id` |
| `VectorCurrentDrive.drive_direction` | `Sequence[float]` | `required` | $1$ | finite nonzero axis; normalized; not parallel to interface normal | signed current projection axis | planner-resolved prescribed-SOT lanes | `spin_torque_modules[].drive.drive_direction` |
| `VectorCurrentDrive.interface_normal` | `Sequence[float]` | `required` | $1$ | finite nonzero axis; normalized; not parallel to drive direction | oriented nonmagnet-to-ferromagnet normal | planner-resolved prescribed-SOT lanes | `spin_torque_modules[].drive.interface_normal` |

`SpinOrbitTorque` is a deprecated compatibility constructor. New scripts and
canonical exports must use `PrescribedSpinOrbitTorque`.

(physics-spin-orbit-torque-problem-ir)=
## ProblemIR contract

The scalar example lowers to the following module record:

```json
{
  "kind": "prescribed_sot",
  "schema_version": "prescribed_sot.v1",
  "id": "hm_sot",
  "target": {"object_id": "film", "region_id": null},
  "formula_version": "prescribed_sot.fullmag.v1",
  "drive": {
    "kind": "signed_scalar",
    "current_density_Apm2": -400000000000.0,
    "sigma_hat": [0.0, 1.0, 0.0]
  },
  "xi_dl": 0.12,
  "xi_fl": -0.03,
  "free_layer_thickness_m": 1.5e-9
}
```

Validation fails closed for duplicate IDs, non-finite coefficients, non-positive
thickness, unresolved targets or current sources, invalid axes, parallel vector
axes, and incompatible envelope artifacts. The legacy wire formula
`prescribed_sot.legacy_fullmag.v0` is retained only for migration and is not the
authoring contract documented here.

(physics-spin-orbit-torque-round-trip-and-failure-semantics)=
## Round trip and failure semantics

The **requested intent** preserves the authored target, drive variant, signed values,
axes, envelope, efficiencies, thickness, execution mode, device, and precision. The
planner records **resolved execution** separately, including the selected lane and the
projected signed current. Python and ProblemIR **validation errors** reject malformed
or unresolved inputs before runtime. Strict **unsupported combinations** fail closed;
they are not silently rebound to another solver or device. Provenance therefore keeps
both the canonical authored module and the planner/runtime resolution.

(physics-spin-orbit-torque-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Evidence boundary |
| --- | --- | --- | --- |
| FDM | CPU | Partial | executable double-precision reference path, signed current, target mask, and envelope contracts; broad scientific qualification is not claimed |
| FDM | GPU | Partial | native CUDA implementation with fixed-trajectory CPU parity and bounded current-scaling tests when CUDA is available; no implicit CPU fallback |
| FEM | CPU | Partial | executable MFEM reference source with SI-prefactor, damping conversion, mask, and time-envelope checks |
| FEM | GPU | Partial | native CUDA RHS kernel with independent SI oracle and CPU comparison; device availability and wider production qualification remain separate gates |

`Partial` means the interaction is executable in the bounded lanes above, not
that every mesh, precision, integrator, or deployment route is production
qualified.

### FDM CPU

The reference evaluator consumes a per-cell active mask, local $M_s$ and $\alpha$,
the signed scalar amplitude, normalized polarization, and the stage-time envelope.

### FDM GPU

The native CUDA path selects `prescribed_sot.fullmag.v1` explicitly and is bounded
by fixed-trajectory CPU parity and current-scaling tests when a CUDA device is present.

### FEM CPU

The MFEM local-interaction path evaluates the same SI prefactor at magnetic nodes,
applies the active mask, and performs the Gilbert-to-explicit conversion once.

### FEM GPU

The CUDA RK source adds the canonical local RHS on device. Its bounded contract checks
the independent SI oracle, active-mask exclusion, and CPU parity; this does not by
itself qualify every runtime or mesh configuration.

(physics-spin-orbit-torque-validation)=
## Validation requirements

A trustworthy SOT result should demonstrate all of the following for the chosen
backend and device:

- exact SI prefactor for a single cell or node;
- odd scaling under current reversal;
- independent DL-only and FL-only basis-vector cases;
- the $\alpha$-dependent Gilbert-to-explicit coefficient mixing;
- target-mask exclusion and zero contribution outside the magnetic target;
- envelope value at stage time, including retry or rollback behavior;
- CPU/GPU parity on the same trajectory when GPU execution is claimed;
- no silent CPU fallback for a strict GPU request.

(physics-spin-orbit-torque-limitations)=
## Limitations

- `xi_dl` and `xi_fl` are effective reduced-model inputs, not independently solved
  bulk and interface observables.
- The model cannot predict spin accumulation, spin backflow, diffusion-length effects,
  interface hot spots, or a self-consistent inverse spin Hall response.
- A spatially resolved SHE stack must use the separate drift-diffusion transport model.
- Published backend statuses are bounded evidence statements, not universal production
  qualification for every precision, integrator, device, and deployment route.

(physics-spin-orbit-torque-implementation-mapping)=
## Implementation mapping

| Layer | File and stable symbol | Responsibility |
| --- | --- | --- |
| Python API | `packages/fullmag-py/src/fullmag/model/spin_torque.py`, `class PrescribedSpinOrbitTorque` | validates module arguments and emits canonical v1 ProblemIR |
| Scalar drive | same file, `class SignedScalarDrive` | preserves signed current, normalizes `sigma`, validates envelope |
| Vector drive | same file, `class VectorCurrentDrive` | validates axes and emits named-current binding |
| ProblemIR | `crates/fullmag-ir/src/study.rs`, `PrescribedSotV1DriveIR` | owns tagged drive variants and formula fields |
| Planner | `crates/fullmag-plan/src/spin_torque.rs`, `resolve_sot_fields` | resolves current projection, polarization, target, and lane eligibility |
| FDM CPU | `crates/fullmag-runner/src/fdm/cpu/reference/interactions.rs`, `build_sot` | maps the plan into the CPU evaluator configuration |
| FDM GPU | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`, `ffi_prescribed_sot_formula` | selects canonical versus legacy native CUDA formula |
| FEM CPU | `backends/fem/cpu/mfem/interactions/sot.cpp`, `add_sot_rhs_aos` | evaluates the canonical SI torque and damping conversion |
| FEM GPU | `backends/fem/gpu/cuda/integrators/rk/rk_sot_torque.cu`, `fullmag_cuda_add_prescribed_sot_rhs` | adds the canonical source to the device RHS |
| UI | `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx`, `SpinAuthoringInspector` | exposes prescribed SOT and its DL/FL efficiencies |

(physics-spin-orbit-torque-scientific-bibliography)=
## Scientific bibliography

- L. Liu et al., "Current-Induced Switching of Perpendicularly Magnetized Magnetic Layers Using Spin Torque from the Spin Hall Effect," *Physical Review Letters* **109**, 096602 (2012), [doi:10.1103/PhysRevLett.109.096602](https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.109.096602).
- A. Manchon et al., "Current-induced spin-orbit torques in ferromagnetic and antiferromagnetic systems," *Reviews of Modern Physics* **91**, 035004 (2019), [doi:10.1103/RevModPhys.91.035004](https://journals.aps.org/rmp/abstract/10.1103/RevModPhys.91.035004).

(physics-spin-orbit-torque-source-code-index)=
## Source-code index

| Claim | Path | Symbol | Responsibility and evidence |
| --- | --- | --- | --- |
| Python torque API | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class PrescribedSpinOrbitTorque` | canonical validation and ProblemIR lowering |
| Scalar drive | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SignedScalarDrive` | signed current, normalized polarization, envelope validation |
| Vector drive | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class VectorCurrentDrive` | axes and named-current binding |
| ProblemIR | `crates/fullmag-ir/src/study.rs` | `PrescribedSotV1DriveIR` | canonical tagged drive variants |
| Planner | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_sot_fields` | projection, target, envelope, and executable fields |
| FDM CPU | `crates/fullmag-runner/src/fdm/cpu/reference/interactions.rs` | `build_sot` | CPU evaluator configuration |
| FDM GPU | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `ffi_prescribed_sot_formula` | canonical native formula selection |
| FEM CPU | `backends/fem/cpu/mfem/interactions/sot.cpp` | `add_sot_rhs_aos` | SI torque and damping conversion |
| FEM GPU | `backends/fem/gpu/cuda/integrators/rk/rk_sot_torque.cu` | `fullmag_cuda_add_prescribed_sot_rhs` | device RHS source |
| Python tests | `packages/fullmag-py/tests/test_prescribed_sot.py` | `class TestPrescribedSpinOrbitTorque` | exact JSON and fail-closed authoring tests |
| Planner test | `crates/fullmag-plan/src/spin_torque.rs` | `canonical_prescribed_sot_vector_binding_preserves_axes_and_reverses_signed_projection` | signed vector projection contract |
| FDM GPU test | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `native_fdm_prescribed_sot_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available` | bounded CUDA/CPU trajectory parity |
| FEM GPU test | `backends/fem/tests/cuda_sot_contract.cpp` | `main` | independent oracle and CPU/CUDA contract runner |
| Control Room | `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx` | `SpinAuthoringInspector` | prescribed-SOT authoring fields |
