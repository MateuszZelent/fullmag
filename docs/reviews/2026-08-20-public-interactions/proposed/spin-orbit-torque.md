---
title: Prescribed spin-orbit torque — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
targets:
  - public_docs/site/physics/interactions/spin-orbit-torque/index.md
  - public_docs/site/python-api/interactions/spin-orbit-torque.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Prescribed spin-orbit torque

## Audit verdict

| Area | Verdict |
|---|---|
| Local damping-like and field-like equations | Correct for the declared signed-current and Gilbert-source convention. |
| Vector-drive orientation | Correctly derives `sigma_hat = n_NF × t_hat` and retains current sign. |
| Public stage-first example | Current and genuinely registerable through `study.spin_torque(...)`. |
| Capability language | Better than most interaction pages, but broad `status: implemented` still hides lane-specific qualification. |
| ProblemIR presentation | Far too large: a full serialized study obscures the interaction contract. |
| Model interpretation | Needs stronger warning that `xi_dl` and `xi_fl` are effective local coefficients, not automatically intrinsic spin Hall angles. |

## Required corrections

1. Retain the existing canonical `PrescribedSpinOrbitTorque` example; replace the deprecated
   `SpinOrbitTorque` alias examples on the API page.
2. Replace the full-study `ProblemIR` dump with the exact `spin_torque_modules[]` record plus a
   downloadable complete serialization fixture.
3. Add a sign/orientation diagram and an explicit transformation table for conventional current,
   interface normal, drive direction, and spin axis.
4. State that `xi_dl` and `xi_fl` are signed effective torque efficiencies. They can include
   interface transparency, spin backflow, current shunting, spin-memory loss, and fitting
   conventions. They are not necessarily equal to a bulk spin Hall angle.
5. Forbid simultaneous use of a local prescribed SOT and a solved drift-diffusion torque on the
   same physical mechanism/target unless the user explicitly declares an additive decomposition.
6. Keep Gilbert-source versus explicit-rate ownership visible and test that the conversion occurs
   exactly once.
7. Record authored axes and normalized axes separately in provenance.

## Proposed canonical model

For reduced magnetization `m`, a signed conventional-current drive, free-layer thickness `t_F`,
and positive angular gyromagnetic magnitude `gamma_e`, define the damping-like and field-like rate
scales

```math
\Omega_{DL}
=\frac{\gamma_e\hbar\xi_{DL}J_{signed}}{2eM_st_F},
\qquad
\Omega_{FL}
=\frac{\gamma_e\hbar\xi_{FL}J_{signed}}{2eM_st_F}.
```

The Gilbert-source torque is

```math
T_{SOT,G}
=\Omega_{DL}\,m\times(\hat\sigma\times m)
+\Omega_{FL}\,m\times\hat\sigma.
```

FullMag converts this source exactly once to the explicit LLG rate:

```math
T_{SOT,explicit}
=\frac{T_{SOT,G}+\alpha m\times T_{SOT,G}}{1+\alpha^2}.
```

No conservative scalar `E_SOT` exists for this driven dissipative source.

## Drive definitions

### Signed scalar drive

The user supplies `J_signed` in A/m² and a nonzero spin axis. FullMag normalizes the axis once:

```math
\hat\sigma=\frac{\sigma_{authored}}{|\sigma_{authored}|}.
```

The sign of `J_signed` is never replaced by its magnitude.

### Vector-current-source drive

For a current source `J_c`, fixed drive direction `t_hat`, and oriented normal `n_NF` from the
nonmagnet/heavy metal to the ferromagnet,

```math
J_{signed}=J_c\cdot\hat t,
\qquad
\hat\sigma
=\frac{\hat n_{NF}\times\hat t}
{|\hat n_{NF}\times\hat t|}.
```

Parallel or nearly parallel `n_NF` and `t_hat` are invalid because the spin axis is undefined.
The tolerance used for this decision is part of the formula/API contract.

## Sign and orientation table

| Transformation | Result under the declared convention |
|---|---|
| `J_signed -> -J_signed` | reverses both damping-like and field-like torque rates |
| `xi_dl -> -xi_dl` | reverses only the damping-like basis amplitude |
| `xi_fl -> -xi_fl` | reverses only the field-like basis amplitude |
| `n_NF -> -n_NF` | reverses `sigma_hat` and therefore both torque bases for fixed current projection |
| `t_hat -> -t_hat` with fixed vector `J_c` | reverses both `J_signed` and `sigma_hat`; the combined result must be evaluated from the full formula |
| `sigma_hat -> -sigma_hat` | reverses both torque bases |

Every tutorial should say explicitly that `J_c` is conventional charge current. Electron flow is
opposite.

## Interpretation of effective efficiencies

`xi_dl` and `xi_fl` are parameters of a local homogenized torque law. Their numerical values may
depend on:

- heavy-metal current density versus total device current density;
- current shunting and layer conductivities;
- spin Hall generation and interfacial transparency;
- spin backflow and spin-memory loss;
- finite heavy-metal and ferromagnet thicknesses;
- the sign convention for `n_NF`, `t_hat`, and `sigma_hat`;
- whether field-like Oersted/Rashba contributions were subtracted experimentally.

The documentation should use “effective torque efficiency” unless a separate transport model
justifies an intrinsic material parameter interpretation.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `J_c`, `J_signed` | vector and signed projected conventional-current density | A/m² |
| `m` | reduced magnetization | 1 |
| `sigma_hat` | normalized spin axis | 1 |
| `n_NF`, `t_hat` | oriented interface normal and drive direction | 1 |
| `xi_dl`, `xi_fl` | signed effective torque efficiencies | 1 |
| `t_F` | homogenized ferromagnet thickness | m |
| `Omega_dl`, `Omega_fl` | torque-rate scales | 1/s |
| `T_SOT` | direct torque contribution | 1/s |

## Stage-first example

```python
# %% Canonical prescribed SOT
import fullmag as fm

study = fm.study("prescribed_sot_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 1e-9))

free_layer = study.geometry(fm.Box(40e-9, 20e-9, 1e-9), name="free_layer")
free_layer.Ms = 8.0e5
free_layer.Aex = 13.0e-12
free_layer.alpha = 0.02
free_layer.m = fm.texture.uniform(1.0, 0.0, 0.0)

sot = fm.PrescribedSpinOrbitTorque(
    name="hm_sot",
    target=fm.RegionRef("free_layer"),
    drive=fm.SignedScalarDrive(
        current_density_Apm2=-4.0e11,
        sigma=(0.0, 1.0, 0.0),
    ),
    xi_dl=0.12,
    xi_fl=-0.03,
    free_layer_thickness_m=1.5e-9,
)
study.spin_torque(sot)
study.stages.add_run(2.0e-12, stage_id="sot_run")
```

Documentation CI should execute this block, compare the exact torque-module IR, and assert that the
signed current remains negative after serialization and round-trip.

## Canonical interaction fragment

The page should show only the module owned by the interaction:

```json
{
  "kind": "prescribed_sot",
  "schema_version": "prescribed_sot.v1",
  "id": "hm_sot",
  "target": {"object_id": "free_layer"},
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

The exact fragment must be generated and asserted by the serializer test rather than copied
independently into multiple pages.

## Capability statement

| Solver/device | Recommended public status | Qualification boundary |
|---|---|---|
| FDM CPU | `reference_executable` | FP64 algebra, target masks, drive scaling, bounded trajectories |
| FDM GPU | `production_executable` only for qualified precision/envelope slices | executed-device field/torque parity and no host fallback |
| FEM CPU | `reference_executable` | object-target resolution, weak/RHS assembly, rollback and stage-time tests |
| FEM GPU | `reference_executable` | device-resident FP64 path; broader production evidence still required |

The matrix should be generated from one capability registry. A page-wide `implemented` status is
not precise enough.

## Required validation suite

1. **Tangent property:** `m·T = 0` for both torque bases and after explicit conversion.
2. **Zero/current scaling:** zero current gives exact zero; torque is linear in signed current.
3. **Sign transformations:** test every row of the orientation table.
4. **Basis states:** evaluate `m parallel sigma`, `m perpendicular sigma`, and arbitrary oblique
   states against analytic vectors.
5. **Gilbert conversion:** compare direct algebra and detect double application.
6. **Thickness scaling:** verify `T proportional to 1/t_F` for the homogenized law.
7. **Target masking:** zero torque outside the target and exact region/object semantics.
8. **Envelope timing:** constant, sinusoidal, pulse, piecewise-linear, and tabulated gates according
   to the selected lane.
9. **Vector source:** verify current projection and normalized cross-product orientation.
10. **Macrospin threshold:** compare a fully specified switching/auto-oscillation stability problem
    with linear stability theory.
11. **CPU/GPU:** compare torque arrays before integration and then selected trajectory observables.
12. **Round-trip:** preserve signed current, axes, formula version, target, thickness, efficiencies,
    and source identity.

## Recommended extensions

- spatially resolved local efficiencies and thickness fields with strict cardinality semantics;
- explicit Rashba–Edelstein local source as a separately versioned model;
- device-current conversion utilities that record shunting assumptions;
- automatic sign/orientation diagrams generated from geometry metadata;
- prevention or warning for double counting with drift-diffusion torque;
- harmonic-response and switching-threshold benchmark notebooks.

## Bibliography

- L. Liu et al., “Spin-torque ferromagnetic resonance induced by the spin Hall effect,”
  *Physical Review Letters* **106**, 036601 (2011), DOI `10.1103/PhysRevLett.106.036601`.
- L. Liu et al., “Spin-torque switching with the giant spin Hall effect of tantalum,”
  *Science* **336**, 555–558 (2012), DOI `10.1126/science.1218197`.
- A. Manchon et al., “Current-induced spin-orbit torques in ferromagnetic and antiferromagnetic
  systems,” *Reviews of Modern Physics* **91**, 035004 (2019).
