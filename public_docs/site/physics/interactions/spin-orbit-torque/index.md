---
title: Spin-orbit torque
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-sot)=
# Spin-orbit torque

`PrescribedSpinOrbitTorque` is a local damping-like and field-like torque driven by a signed
prescribed current. It is not a charge/spin transport solve and has no conservative energy.

(physics-spin-orbit-torque-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(physics-spin-orbit-torque-governing-equations)=
## Governing equations

For a vector-current source, fixed drive direction $\hat{\mathbf t}$, and interface normal
oriented from nonmagnet to ferromagnet $\hat{\mathbf n}_{NF}$,

```{math}
:label: eq-public-spin-orbit-torque-sot-drive
J_{\mathrm{signed}}=\mathbf J_c\cdot\hat{\mathbf t},
\qquad
\hat{\boldsymbol\sigma}
=
\frac{\hat{\mathbf n}_{NF}\times\hat{\mathbf t}}
{|\hat{\mathbf n}_{NF}\times\hat{\mathbf t}|}.
```

A scalar drive authors $J_{\mathrm{signed}}$ and
$\hat{\boldsymbol\sigma}$ directly. With positive angular gyromagnetic magnitude
$\gamma_e$,

```{math}
:label: eq-public-spin-orbit-torque-sot-rates
\Omega_{\mathrm{DL,FL}}
=
\frac{\gamma_e\hbar\,\xi_{\mathrm{DL,FL}}J_{\mathrm{signed}}}
{2eM_st_F}.
```

```{math}
:label: eq-public-spin-orbit-torque-sot-gilbert
\mathbf T_{\mathrm{SOT},G}
=
\Omega_{\mathrm{DL}}\,
\mathbf m\times(\hat{\boldsymbol\sigma}\times\mathbf m)
+
\Omega_{\mathrm{FL}}\,
\mathbf m\times\hat{\boldsymbol\sigma}.
```

The common Gilbert-to-explicit conversion is applied exactly once by the LLG layer.

(physics-spin-orbit-torque-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $J_{\mathrm{signed}}$ | signed current-density drive | $\mathrm{A\,m^{-2}}$ |
| $\xi_{\mathrm{DL}},\xi_{\mathrm{FL}}$ | signed torque efficiencies | $1$ |
| $t_F$ | homogenized free-layer thickness | $\mathrm m$ |
| $\hat{\boldsymbol\sigma}$ | spin-polarization direction | $1$ |
| $\mathbf T_{\mathrm{SOT},G}$ | Gilbert-source torque | $\mathrm{s^{-1}}$ |

(physics-spin-orbit-torque-assumptions-and-validity)=
## Assumptions and validity

The model assumes a local homogenized torque. It does not solve spin diffusion, inverse spin Hall
feedback, spin-memory loss, Rashba–Edelstein transport, or circuit closure. Reversing current
changes the signed scalar; it does not silently reverse authored axes.

(physics-spin-orbit-torque-discrete-realization)=
## Capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | canonical prescribed SOT | reference executable | bounded SI and trajectory tests | target masks and envelopes remain lane-gated |
| FDM | GPU | same canonical module | production executable FP64 subset | FP32 and broad physical qualification remain open | native CUDA direct-torque path |
| FEM | CPU | same canonical module | reference executable | bounded mask/time/trajectory evidence | whole-object target support is the conservative boundary |
| FEM | GPU | same canonical module | reference executable subset | not production-qualified | device-resident FP64 direct torque |

(physics-spin-orbit-torque-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
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
    drive=fm.SignedScalarDrive(current_density_Apm2=-4.0e11, sigma=(0.0, 1.0, 0.0)),
    xi_dl=0.12,
    xi_fl=-0.03,
    free_layer_thickness_m=1.5 * nm,
)
study.spin_torque(sot)
study.stages.add_run(stage_id="drive", until=1.0e-12)
```

`SpinOrbitTorque` is a deprecated compatibility input. New documentation and canonical exports
must use `PrescribedSpinOrbitTorque`.

(physics-spin-orbit-torque-problem-ir)=
## ProblemIR and validation

The module lowers to `spin_torque_modules[]` with its stable ID, target, tagged drive,
signed efficiencies, thickness, and formula version. Validation must reject non-finite
coefficients, non-positive thickness, empty/unresolvable target, zero axes, parallel vector-drive
axes, incompatible envelope artifacts, and unsupported target granularity. A strict GPU request
must not fall back to CPU.

(physics-spin-orbit-torque-validation)=
## Required numerical validation

- exact SI prefactor for a single cell/node;
- odd current scaling;
- independent $\xi_{\mathrm{DL}}$ and $\xi_{\mathrm{FL}}$ basis-vector tests;
- axis-orientation and current-reversal tests;
- zero torque for the appropriate collinear state;
- target-mask exclusion;
- stage-time envelope and rollback/retry behavior;
- CPU/GPU trajectory comparison with matched integrator and precision;
- proof of exactly one Gilbert conversion.

(physics-spin-orbit-torque-limitations)=
## Limitations and recommended extensions

Transport-derived SOT belongs to `SpinDriftDiffusion` and `DriftDiffusionSpinTorque`. Add
Rashba–Edelstein or spatially resolved efficiencies as separate typed drive variants rather than
overloading the local efficiency scalars.

(physics-spin-orbit-torque-scientific-bibliography)=
## Scientific bibliography

1. L. Liu et al., *Physical Review Letters* **109**, 096602 (2012),
   DOI: 10.1103/PhysRevLett.109.096602.
2. A. Manchon et al., *Reviews of Modern Physics* **91**, 035004 (2019).

(physics-spin-orbit-torque-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `PrescribedSpinOrbitTorque` | canonical local SOT |
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `SignedScalarDrive, VectorCurrentDrive` | signed drive variants |
| `packages/fullmag-py/src/fullmag/world.py` | `spin_torque` | study registration |
| `crates/fullmag-plan/src/spin_torque.rs` | `SOT planning` | target/drive/lane resolution |
| `backends/fdm/gpu/cuda/interactions` | `SOT kernels` | FDM GPU realization |
| `backends/fem/cpu/mfem/interactions` | `SOT operator` | FEM CPU realization |
| `backends/fem/gpu/cuda/interactions` | `SOT kernels` | FEM GPU realization |

(physics-spin-orbit-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-spin-orbit-torque-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.
