---
title: Observables
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: docs/physics/0870-active-observable-and-energy-availability.md
---

(public-docs-physics-foundations-observables)=
# Observables

(observables-problem-statement)=
## Problem statement

An observable is a reproducible projection of the accepted solver state, not an arbitrary label
attached to an output file. FullMag preserves the requested quantity, spatial support, sampling
cadence, units, availability prerequisites, resolved backend, and provenance. A field observable
retains its mesh/grid support (or planar-monitor slice); a scalar observable is a reduction over
the active magnetic domain or an explicitly defined state metric.

(observables-governing-equations)=
## Governing equations

For an accepted state at time $t_n$, the total energy and a sampled quantity are defined by

```{math}
:label: eq-observables-total-energy
E_{\mathrm{total}}(t_n)=\sum_{k\in\mathcal K}E_k(t_n),
\qquad Q_n=Q[\mathbf m(t_n),\mathcal G,\mathcal M,\mathcal P],
```

For a volume-weighted scalar reduction over active magnetic locations $i \in \Omega_m$,

```{math}
:label: eq-observables-volume-reduction
Q_{\mathrm{scalar}}=\sum_{i=1}^{N}w_i q_i.
```

The reduction weights $w_i$ are resolved by the selected discretisation and exclude nonmagnetic
airbox elements ($w_i = 0$ on $\Omega_a \setminus \Omega_m$). A request for a field that is
not enabled or materialisable is an error; it is never represented as a zero field.

```{figure} /_static/diagrams/observables-materialization-pipeline.svg
:alt: Four-stage observables pipeline showing (a) accepted-step sampling discarding rejected adaptive RK trials, (b) fail-closed planner legality gate checking interaction prerequisites and backend capability, (c) native FDM/FEM field support and volume-weighted scalar reductions excluding the FEM airbox, and (d) provenance-preserving Zarr, HDF5, and CSV artifacts.
:width: 100%
:name: fig-observables-materialization-pipeline
:figclass: fm-physics-figure

Observables legality, accepted-step sampling, and support-scoped materialisation: **(a)** adaptive RK steppers emit scalar rows and field snapshots strictly on accepted steps while discarding rejected trials; **(b)** `validate_executable_outputs` enforces enabling-interaction prerequisites and lane capabilities fail-closed (never emitting silent `0.0`); **(c)** field observables keep native FDM/FEM support while scalar reductions `QuantityRegistry::evaluate_by_name` sum only over $\Omega_m$ ($w_i = 0$ in the FEM airbox); **(d)** `OutputStorage` writes Zarr/HDF5/CSV outputs with full execution provenance (Vansteenkiste et al. 2014, [arXiv:1406.7635](https://arxiv.org/abs/1406.7635); Abert 2019, [arXiv:1810.12365](https://arxiv.org/abs/1810.12365)).
```

(observables-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $Q_n$ | sampled observable at accepted state $n$ | $1$ |
| $E_{\mathrm{total}}$ | total magnetic energy | $\mathrm{J}$ |
| $E_k$ | energy contribution of interaction $k$ | $\mathrm{J}$ |
| $w_i$ | discrete integration/reduction weight | $\mathrm{m^3}$ |
| $q_i$ | local scalar density or contribution | $\mathrm{J\,m^{-3}}$ |
| $N$ | number of active discrete locations | $1$ |
| $t_n$ | accepted physical time | $\mathrm{s}$ |

An observable in FullMag is a named physical quantity from the 56-entry canonical `QuantityId`
catalog (`crates/fullmag-quantities/src/catalog.rs`) or an accepted-step table telemetry column.
Spatial quantities carry explicit shape metadata (`VectorField`, `SpatialScalar`, or rank-2
`TensorField`), component count, discretization location, and domain scope (`MagneticOnly` vs.
`FullDomain`).

## Canonical quantity catalog (56 `QuantityId` entries)

### Vector field observables (23 entries)

| Canonical ID | Symbol | Comp. | SI unit | Domain / enabling contract |
|---|---|---:|---:|---|
| `m` | $\mathbf{m}$ | 3 | $1$ | `MagneticOnly`; always available |
| `H_eff` | $\mathbf{H}_{\mathrm{eff}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `FullDomain`; at least one active field term |
| `H_ex` | $\mathbf{H}_{\mathrm{ex}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `MagneticOnly`; `Exchange()` |
| `H_demag` | $\mathbf{H}_{\mathrm{d}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `FullDomain`; `Demag()` |
| `H_ext` | $\mathbf{H}_{\mathrm{ext}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `FullDomain`; `Zeeman()` |
| `H_ant` | $\mathbf{H}_{\mathrm{ant}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `FullDomain`; microwave antenna excitation |
| `H_drive` | $\mathbf{H}_{\mathrm{drive}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `MagneticOnly`; regional time-domain magnetic drive |
| `H_ani` | $\mathbf{H}_{\mathrm{ani}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `MagneticOnly`; `UniaxialAnisotropy()` |
| `H_ani_cubic` | $\mathbf{H}_{\mathrm{ani,c}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `MagneticOnly`; `CubicAnisotropy()` |
| `H_dmi` | $\mathbf{H}_{\mathrm{DMI}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `MagneticOnly`; `InterfacialDMI()` |
| `H_rotated_dmi` | $\mathbf{H}_{\mathrm{DMI,rot}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `MagneticOnly`; `RotatedInterfacialDMI()` |
| `H_dmi_bulk` | $\mathbf{H}_{\mathrm{DMI,bulk}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `MagneticOnly`; `BulkDMI()` |
| `H_oe` | $\mathbf{H}_{\mathrm{oe}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `FullDomain`; `OerstedField()` or `OerstedCylinder()` |
| `H_mel` | $\mathbf{H}_{\mathrm{mel}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `MagneticOnly`; `Magnetoelastic()` |
| `H_therm` | $\mathbf{H}_{\mathrm{therm}}$ | 3 | $\mathrm{A\,m^{-1}}$ | `MagneticOnly`; `ThermalNoise()` |
| `torque` | $\boldsymbol{\tau}/\gamma_0$ | 3 | $\mathrm{T}$ | `MagneticOnly`; total LL torque divided by $\gamma_0$ |
| `dm_dt` | $\partial_t\mathbf{m}$ | 3 | $\mathrm{s^{-1}}$ | `MagneticOnly`; explicit LLG magnetization rate |
| `torque_stt` | $\boldsymbol{\tau}_{\mathrm{STT}}$ | 3 | $\mathrm{s^{-1}}$ | `FullDomain`; STT or drift–diffusion transport torque |
| `torque_sot` | $\boldsymbol{\tau}_{\mathrm{SOT}}$ | 3 | $\mathrm{s^{-1}}$ | `MagneticOnly`; `PrescribedSpinOrbitTorque` |
| `J_charge` | $\mathbf{J}_c$ | 3 | $\mathrm{A\,m^{-2}}$ | `FullDomain`; `CurrentTransport` solve |
| `spin_potential` | $\boldsymbol{\mu}_s$ | 3 | $\mathrm{V}$ | `FullDomain`; `SpinDriftDiffusion` solve |
| `u`, `eps`, `sigma` | $\mathbf{u},\,\boldsymbol{\varepsilon},\,\boldsymbol{\sigma}$ | 3 / 6 / 6 | $\mathrm{m}$, $1$, $\mathrm{Pa}$ | `FullDomain`; mechanical displacement and Voigt strain/stress (planner-gated; not interactively previewed) |
| `mode_real`, `mode_imag` | $\operatorname{Re}\delta\mathbf{m},\,\operatorname{Im}\delta\mathbf{m}$ | 3 | $1$ | `MagneticOnly`; eigenmode solver outputs |

*(Note: counting `u`, `eps`, `sigma`, `mode_real`, and `mode_imag` individually yields 26 vector/Voigt-field `QuantityId` entries in the catalog.)*

### Spatial scalar and rank-2 tensor field observables (19 entries)

| Canonical ID | Symbol | Comp. | SI unit | Domain / enabling contract |
|---|---|---:|---:|---|
| `frozen_spins` | $I_{\mathrm{frozen}}$ | 1 | $1$ | `MagneticOnly`; resolved `FrozenSpins` mask ($1$ frozen, $0$ free) |
| `demag_phi` | $\phi$ | 1 | $\mathrm{A}$ | `FullDomain`; magnetostatic scalar potential from Poisson demag |
| `V_electric` | $V$ | 1 | $\mathrm{V}$ | `FullDomain`; electric scalar potential from `CurrentTransport` |
| `spin_current_tensor` | $Q_{ia}$ | 9 ($3\times 3$) | $\mathrm{A\,m^{-2}}$ | `FullDomain`; `TensorField`, rank-2 flow-major (`Q_xx` … `Q_zz`) from `SpinDriftDiffusion` |
| `eden_ex`, `eden_demag`, `eden_ext`, `eden_drive`, `eden_ani`, `eden_dmi`, `eden_rotated_dmi`, `eden_total` | $\varepsilon_k$ | 1 | $\mathrm{J\,m^{-3}}$ | `MagneticOnly`; spatial energy densities per interaction and total |
| `mat_ms`, `mat_aex`, `mat_alpha`, `mat_dind`, `mat_dbulk` | $M_s, A_{\mathrm{ex}}, \alpha, D_{\mathrm{ind}}, D_{\mathrm{bulk}}$ | 1 | $\mathrm{A\,m^{-1}}, \mathrm{J\,m^{-1}}, 1, \mathrm{J\,m^{-2}}$ | `MagneticOnly`; resolved material parameter distributions |
| `mode_amplitude`, `mode_phase` | $\lvert\delta\mathbf{m}\rvert,\,\arg(\delta\mathbf{m})$ | 1 | $1,\,\mathrm{rad}$ | `MagneticOnly`; eigenmode amplitude and phase |

### Global scalar observables and table telemetry (11 catalog entries + step metrics)

| Canonical ID (table key) | Symbol | SI unit | Enabling contract |
|---|---|---:|---|
| `E_ex` (`e_ex`) | $E_{\mathrm{ex}}$ | $\mathrm{J}$ | `Exchange()` |
| `E_demag` (`e_demag`) | $E_{\mathrm{d}}$ | $\mathrm{J}$ | `Demag()` |
| `E_ext` (`e_ext`) | $E_{\mathrm{ext}}$ | $\mathrm{J}$ | `Zeeman()` |
| `E_drive` (`e_drive`) | $E_{\mathrm{drive}}$ | $\mathrm{J}$ | regional time-domain magnetic drive |
| `E_ani` (`e_ani`) | $E_{\mathrm{ani}}$ | $\mathrm{J}$ | uniaxial or cubic anisotropy |
| `E_dmi` (`e_dmi`) | $E_{\mathrm{DMI}}$ | $\mathrm{J}$ | interfacial or bulk DMI |
| `E_rotated_dmi` (`e_rotated_dmi`) | $E_{\mathrm{DMI,rot}}$ | $\mathrm{J}$ | `RotatedInterfacialDMI()` |
| `E_el` (`e_el`), `E_kin_el` (`e_kin_el`) | $E_{\mathrm{el}},\,E_{\mathrm{kin,el}}$ | $\mathrm{J}$ | mechanical elastic strain and kinetic energy (planner-gated) |
| `elastic_residual_norm` | $\|r_{\mathrm{el}}\|$ | $1$ | mechanical solver residual norm (planner-gated) |
| `E_total` (`e_total`) | $E_{\mathrm{tot}}$ | $\mathrm{J}$ | sum of active energy terms |

In addition to the 11 global scalar `QuantityId` entries above, scalar table autosaves record accepted-step solver telemetry such as `step`, `t` ($\mathrm{s}$), `dt` ($\mathrm{s}$), `max_torque_T` ($\mathrm{T}$, $\max\lvert\mu_0\,\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}\rvert$), `max_torque_Apm` ($\mathrm{A\,m^{-1}}$, $\max\lvert\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}\rvert$), and component averages (`mx`, `my`, `mz`). Note that `E_mel` is not a separate catalog `QuantityId` (magnetoelastic field extraction uses `H_mel`, while elastic energies use `E_el` and `E_kin_el`).

## Planar monitors

In addition to full-volume `FieldAutosave` snapshots and global `TableAutosave` rows, `fm.PlanarMonitor` samples a field observable on a structured 2D plane (`PlanarFrame`) with an explicit sampling operator (`PlanarOperator`, such as a slice or thickness-averaged projection) registered via `study.monitors.add(...)`. Planar monitors preserve plane frame, spatial resolution, target object/region scope, and sampling cadence inside `ProblemIR`, and are validated fail-closed alongside field autosaves.

## Requesting observables

Observables are requested through stage autosaves and monitors on a stage-first study:

```python
# %% Observable requests in a stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("observable-example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.exchange()
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 1 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.01
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=100,
    tolT=1.0e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=1,
            quantities=["step", "e_ex", "e_total", "max_torque_T"],
        ),
        fields=[
            fm.FieldAutosave("m", every_steps=10),
            fm.FieldAutosave("H_eff", every_steps=10),
        ],
    )
)
```

The planner validates that the requested observables are compatible with the declared energy
terms. Requesting `H_ex` without `Exchange()` in the energy list is a validation error.

## Legality and materialisation

An observable is **legal** if the required interaction is declared and the selected backend
can materialise it. The legality check happens during planning:

1. **Authoring validation**: the Python DSL checks that the observable name is known.
2. **Planner validation**: the planner verifies that the energy term enabling the
   observable is declared and the concrete backend supports it.
3. **Runtime materialisation**: the solver computes the field/scalar and writes it to the
   output channel.

An observable that is declared but unmaterialisable (e.g. a GPU lane that does not implement
the energy reduction) is a planner error, not a silent zero.

## Table autosave

FullMag's table autosave captures scalar observables at every accepted step into a CSV or
structured output. This provides a continuous record of energies, maximum torque (`max_torque_T`
and `max_torque_Apm`), and timestep evolution without explicit `SaveScalar` declarations.

(observables-scientific-bibliography)=
## Scientific bibliography

1. A. Vansteenkiste, J. Leliaert, M. Dvornik, F. Garcia-Sanchez, and B. Van Waeyenberge, "The design and verification of MuMax3," *AIP Advances* **4**(10), 107133 (2014). [doi:10.1063/1.4899186](https://doi.org/10.1063/1.4899186) · [Open Access (CC-BY PDF)](https://pubs.aip.org/aip/adv/article-pdf/doi/10.1063/1.4899186/12878560/107133_1_online.pdf) · [arXiv:1406.7635](https://arxiv.org/abs/1406.7635).
2. J. Leliaert, M. Dvornik, J. Mulkers, J. De Clercq, M. V. Milošević, and B. Van Waeyenberge, "Fast micromagnetic simulations on GPU—recent advances made with mumax3," *Journal of Physics D: Applied Physics* **51**(12), 123002 (2018). [doi:10.1088/1361-6463/aaab1c](https://doi.org/10.1088/1361-6463/aaab1c) (CC-BY).
3. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *The European Physical Journal B* **92**(6), 120 (2019). [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6) · [Open Access (CC-BY PDF)](https://link.springer.com/content/pdf/10.1140/epjb/e2019-90599-6.pdf) · [arXiv:1810.12365](https://arxiv.org/abs/1810.12365).
4. J. Leliaert and J. Mulkers, "Tomorrow's micromagnetic simulations," *Journal of Applied Physics* **125**(18) (2019). [doi:10.1063/1.5093730](https://doi.org/10.1063/1.5093730) · [Open Access (Ghent Biblio PDF)](https://biblio.ugent.be/publication/8617712/file/8619141.pdf).

(observables-assumptions-and-validity)=
## Assumptions and validity

- A field is interpreted on the support and ordering supplied by the resolved FDM grid or FEM
  mesh; values from different supports must not be compared without an explicit transfer.
- Scalar energies are reduced over the magnetic support only, even when a FEM airbox exists.
- A table row is emitted for an accepted state, not for a rejected adaptive trial.
- Availability is backend- and stage-dependent. Source presence or a Python constructor alone is
  not evidence of executed-device qualification.

(observables-python-api)=
## Python API

The stage-first request above is the executable public pattern. The output objects configure the
sampling policy; they do not create a second physical problem.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `TableAutosave.every_steps` | `int \| None` | `None` | $1$ | positive integer; exclusive with `t_sampl` | accepted-step cadence for scalar rows | FDM/FEM CPU/GPU where table autosave is materialised | `study.sampling.outputs[].every_steps` |
| `TableAutosave.quantities` | `Sequence[str] \| None` | default registry | $1$ | every name must be a supported scalar quantity | scalar columns to evaluate | FDM/FEM CPU/GPU subject to quantity availability | `study.sampling.outputs[].quantities` |
| `FieldAutosave.quantity` | `str` | required | $1$ | known field identifier | spatial field to write | lane-dependent; planner rejects unavailable fields | `study.sampling.outputs[].name` |
| `FieldAutosave.every_steps` | `int \| None` | `None` | $1$ | positive integer; exclusive with `every` | accepted-step field cadence | FDM/FEM CPU/GPU where the field is materialised | `study.sampling.outputs[].every_steps` |
| `PlanarMonitor.target` | `MonitorTarget` | required | $1$ | valid object or region target | spatial domain sampled by 2D planar monitor | planner-resolved FDM/FEM lanes | `monitors[].target` |
| `PlanarMonitor.frame` | `PlanarFrame` | required | $\mathrm{m}$ | finite origin, orthonormal basis, positive extents | 2D sampling plane geometry and resolution | planner-resolved FDM/FEM lanes | `monitors[].frame` |

(observables-problem-ir)=
## Canonical ProblemIR

The lowered request keeps the authored quantity and cadence explicit:

```json
{
  "kind": "table_autosave",
  "table_id": "default",
  "every_steps": 10,
  "quantities": ["step", "e_ex", "e_total", "max_torque_T"]
}
```

The planner adds stage-resolved field outputs without changing the requested names. Resolved
backend, device, precision, support, and materialisation status belong to execution provenance.

(observables-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The round trip preserves requested intent (quantity names, cadence, table identity, field target,
planar-monitor frame) and records resolved execution (backend, device, precision, support, and
actual availability). Validation errors include unknown quantities, duplicate field requests,
invalid cadence, and a field whose enabling interaction is absent. Unsupported combinations are
rejected by the planner; there is no silent CPU fallback, zero substitution, or hidden unit
conversion.

(observables-discrete-realization)=
## Discrete realization

| Solver | Device | Materialisation behavior |
|---|---|---|
| FDM | CPU | Reference lane evaluating cell fields, spatial energy densities, and volume-weighted reductions in deterministic host storage. |
| FDM | GPU | CUDA lane evaluating device-resident fields and reductions; full CUDA SHE steady-spin observation reconstruction is deferred until accepted steps explicitly request those quantities (see {ref}`numerical-methods-performance-fdm-transport`). |
| FEM | CPU | Native MFEM lane recovering nodal/cell fields and applying selected lumped or quadrature weights (`context_copy_field_f64`); airbox values are excluded from magnetic energy reductions. |
| FEM | GPU | Device-resident field evaluation with packed AoS/SoA staging kernels and contiguous PCIe transfer (`13.93×` faster `state_io` copies and `40.5×` faster D2H transfers vs strided `cudaMemcpy2D`; see {ref}`numerical-methods-performance-fem-gpu-kernels`). Transfer counts and executed-device identity are recorded in provenance. |

(observables-implementation-mapping)=
## Implementation mapping

Python declares sampling (`TableAutosave`, `FieldAutosave`, `PlanarMonitor`), the planner
validates legality (`validate_executable_outputs`), the quantity catalog and registry define and
evaluate all 56 canonical `QuantityId` entries (`quantity_catalog`, `evaluate_by_name`), and
backend state I/O copies resolved fields (`context_copy_field_f64`). Interactive Control Room
equation editing is not exposed directly; use the Study and Results panels documented in
{doc}`/frontend/capability-register`.

(observables-validation)=
## Validation

Validation covers quantity-name normalization across all 56 catalog entries (including rotated
interfacial DMI, steady transport tensor/vector fields, energy densities, material distributions,
and mechanical descriptors), enabling-interaction checks, cadence semantics, accepted-step
ordering, scalar reduction units, FDM CPU/GPU parity, FEM CPU/GPU parity, field support/ordering,
and fail-closed unavailable quantities. Qualification requires executed-device identity for GPU
claims.

(observables-limitations)=
## Limitations

Some interaction fields and mechanical quantities (`u`, `eps`, `sigma`, `E_el`, `E_kin_el`,
`elastic_residual_norm`) remain planner-gated and are not interactively previewed. A quantity
listed in the catalog does not imply that every solver/device lane currently materialises it.
Spatial transfer between FDM and FEM supports is outside this observable contract.

(observables-source-code-index)=
## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Stage capture | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7612) | [`study`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7612) |
| Scalar autosave contract | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L340) | [`class TableAutosave`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L340) |
| Field autosave contract | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L413) | [`class FieldAutosave`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L413) |
| Planar monitor contract | [`packages/fullmag-py/src/fullmag/model/planar_monitor.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/planar_monitor.py#L393) | [`class PlanarMonitor`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/planar_monitor.py#L393) |
| Planner output legality | [`crates/fullmag-plan/src/validate.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/validate.rs#L676) | [`validate_executable_outputs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/validate.rs#L676) |
| Canonical quantity catalog | [`crates/fullmag-quantities/src/catalog.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-quantities/src/catalog.rs#L1211) | [`quantity_catalog`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-quantities/src/catalog.rs#L1211) |
| Quantity evaluation registry | [`crates/fullmag-quantities/src/registry.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-quantities/src/registry.rs#L41) | [`evaluate_by_name`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-quantities/src/registry.rs#L41) |
| FEM field extraction | [`backends/fem/cpu/mfem/runtime/state_io.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/runtime/state_io.cpp#L346) | [`context_copy_field_f64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/runtime/state_io.cpp#L346) |
