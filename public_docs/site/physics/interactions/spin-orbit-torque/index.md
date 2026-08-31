---
title: Spin-orbit torque
description: Local damping-like and field-like spin-orbit torque with prescribed signed current or a named vector-current source.
status: partial
doc_kind: reference
---

(public-docs-physics-interactions-sot)=
# Spin-orbit torque

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

(physics-spin-orbit-torque-derivation)=
## Physical model and sign convention

Let $\mathbf m$ be the unit magnetization, $\hat{\boldsymbol\sigma}$ the unit spin
polarization, and $J_{\mathrm{signed}}$ the conventional signed charge-current
density. A thin-film reduction converts an effective spin angular-momentum flux
$(\hbar/2e)\,\xi J_{\mathrm{signed}}$ into a volume source by dividing by the
free-layer thickness $t_F$. Fullmag writes the resulting frequency scale as

(eq-prescribed-sot-prefactor)=
$$
\Omega_0 =
\frac{\gamma_e\hbar J_{\mathrm{signed}}}
     {2eM_s t_F},
\qquad
\Omega_{\mathrm{DL}}=\xi_{\mathrm{DL}}\Omega_0,
\qquad
\Omega_{\mathrm{FL}}=\xi_{\mathrm{FL}}\Omega_0.
$$

Here $e>0$ is the elementary charge and $\gamma_e>0$ is the magnitude of the
electron gyromagnetic ratio. The canonical Gilbert-form source is

(eq-prescribed-sot-gilbert)=
$$
\mathbf T_{\mathrm{SOT}}^{G} =
\Omega_{\mathrm{DL}}\,
\mathbf m\times(\hat{\boldsymbol\sigma}\times\mathbf m)
+
\Omega_{\mathrm{FL}}\,
\mathbf m\times\hat{\boldsymbol\sigma}.
$$

The first basis vector points toward the component of
$\hat{\boldsymbol\sigma}$ transverse to $\mathbf m$; the second is orthogonal to
both. Reversing the signed current, reversing `sigma`, or reversing either one
of the signed efficiencies reverses the corresponding source. Reversing both
the current and `sigma` leaves the torque unchanged.

### Gilbert-to-explicit conversion

Backends add an explicit right-hand-side contribution after solving the Gilbert
form once. For damping $\alpha$, the implemented coefficient convention is

(eq-prescribed-sot-explicit)=
$$
\mathbf T_{\mathrm{SOT}} =
\frac{\Omega_0}{1+\alpha^2}
\left[
(\xi_{\mathrm{DL}}-\alpha\xi_{\mathrm{FL}})
\mathbf m\times(\hat{\boldsymbol\sigma}\times\mathbf m)
+
(\xi_{\mathrm{FL}}+\alpha\xi_{\mathrm{DL}})
\mathbf m\times\hat{\boldsymbol\sigma}
\right].
$$

This mixing is why MuMax-style code often contains an apparent compensation
between DL and FL coefficients. Author physical `xi_dl` and `xi_fl`; do not
pre-apply the $1/(1+\alpha^2)$ transform in Python.

(physics-spin-orbit-torque-drives)=
## Drive definitions

### Signed scalar drive

`SignedScalarDrive` is the direct reduced-model input:

(eq-prescribed-sot-scalar-drive)=
$$
J_{\mathrm{signed}}(t)=J_0 f(t),
\qquad
\hat{\boldsymbol\sigma}=
\frac{\boldsymbol\sigma}{\lVert\boldsymbol\sigma\rVert}.
$$

`J_0` may be positive, negative, or zero. `sigma` is normalized during
authoring. The optional envelope must be one of the canonical Fullmag envelope
objects: `ConstantEnvelope`, `SinusoidalEnvelope`, `PulseEnvelope`,
`PiecewiseLinearEnvelope`, `SincEnvelope`, or `TabulatedEnvelope`.

### Vector-current binding

`VectorCurrentDrive` binds the torque to a named vector-current source while
making the geometric convention explicit:

(eq-prescribed-sot-vector-drive)=
$$
J_{\mathrm{signed}} = \mathbf J_c\cdot\hat{\mathbf t},
\qquad
\hat{\boldsymbol\sigma} =
\frac{\hat{\mathbf n}_{NF}\times\hat{\mathbf t}}
     {\lVert\hat{\mathbf n}_{NF}\times\hat{\mathbf t}\rVert}.
$$

`drive_direction` defines $\hat{\mathbf t}$ and `interface_normal` defines the
oriented normal $\hat{\mathbf n}_{NF}$ from the nonmagnetic layer toward the
ferromagnet. Both authored axes are normalized. They must be nonzero and must
not be parallel within the canonical axis tolerance $10^{-12}$. The projection
preserves current reversal; the polarization axis does not flip when only the
source current reverses.

(physics-spin-orbit-torque-python)=
## Python authoring

### Complete stage-first example

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("prescribed_sot_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

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
study.stages.add_run(stage_id="drive", until=1.0e-12)
```

The sign in `current_density_Apm2` is retained in ProblemIR. The authored
`sigma=(0, 1, 0)` is normalized and serialized as `sigma_hat`.

### Binding to an existing vector-current source

If the study already contains a current module named `charge`, replace the
drive object only:

```python
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
study.spin_torque(sot)
```

For these axes, $\hat{\boldsymbol\sigma}=\hat{\mathbf z}\times\hat{\mathbf x}
=\hat{\mathbf y}$ and only the $x$ projection of the named current contributes.
`VectorCurrentDrive` has no independent envelope argument; timing belongs to the
named current source.

### Constructor reference

| Argument | Type | Default | Validation | Meaning |
| --- | --- | --- | --- | --- |
| `name` | `str` | required | non-empty | stable module ID |
| `target` | `RegionRef` | required | exact type; must resolve to a magnetic target | cells/nodes receiving the torque |
| `drive` | `SignedScalarDrive` or `VectorCurrentDrive` | required | exact canonical drive type | current and polarization definition |
| `xi_dl` | `float` | required | finite | signed damping-like efficiency |
| `xi_fl` | `float` | `0.0` | finite | signed field-like efficiency |
| `free_layer_thickness_m` | `float` | required | finite and positive | physical FM thickness in metres |

| `SignedScalarDrive` argument | Type | Default | Validation | Meaning |
| --- | --- | --- | --- | --- |
| `current_density_Apm2` | `float` | required | finite; sign retained | $J_0$ in A/m2 |
| `sigma` | three-vector | required | finite norm above axis tolerance; normalized | spin-polarization direction |
| `envelope` | canonical `TimeEnvelope` or `None` | `None` | exact supported envelope type | multiplier $f(t)$ |

| `VectorCurrentDrive` argument | Type | Default | Validation | Meaning |
| --- | --- | --- | --- | --- |
| `current_source` | `str` | required | non-empty and resolvable | named vector-current module |
| `drive_direction` | three-vector | required | finite, nonzero; normalized | projection axis $\hat{\mathbf t}$ |
| `interface_normal` | three-vector | required | finite, nonzero, nonparallel; normalized | oriented normal $\hat{\mathbf n}_{NF}$ |

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

(physics-spin-orbit-torque-backends)=
## Backend status

| Solver | Device | Status | Evidence boundary |
| --- | --- | --- | --- |
| FDM | CPU | Partial | executable double-precision reference path, signed current, target mask, and envelope contracts; broad scientific qualification is not claimed |
| FDM | GPU | Partial | native CUDA implementation with fixed-trajectory CPU parity and bounded current-scaling tests when CUDA is available; no implicit CPU fallback |
| FEM | CPU | Partial | executable MFEM reference source with SI-prefactor, damping conversion, mask, and time-envelope checks |
| FEM | GPU | Partial | native CUDA RHS kernel with independent SI oracle and CPU comparison; device availability and wider production qualification remain separate gates |

`Partial` means the interaction is executable in the bounded lanes above, not
that every mesh, precision, integrator, or deployment route is production
qualified.

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

(physics-spin-orbit-torque-source-index)=
## Source-code reference

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

(physics-spin-orbit-torque-bibliography)=
## Bibliography

- L. Liu et al., "Current-Induced Switching of Perpendicularly Magnetized Magnetic Layers Using Spin Torque from the Spin Hall Effect," *Physical Review Letters* **109**, 096602 (2012), [doi:10.1103/PhysRevLett.109.096602](https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.109.096602).
- A. Manchon et al., "Current-induced spin-orbit torques in ferromagnetic and antiferromagnetic systems," *Reviews of Modern Physics* **91**, 035004 (2019), [doi:10.1103/RevModPhys.91.035004](https://journals.aps.org/rmp/abstract/10.1103/RevModPhys.91.035004).
