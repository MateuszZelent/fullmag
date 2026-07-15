# Spin-transport runtime contract v1

- Status: proposed; implementation-blocking until ADR 0019 and physics notes 0960–0980 are accepted
- Date: 2026-07-15
- Governing ADR: `docs/adr/0019-spin-transport-and-prescribed-sot-semantics.md`
- Governing physics: `docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md`, `docs/physics/0970-spin-hall-drift-diffusion-transport.md`, `docs/physics/0980-dynamic-current-and-oersted-coupling.md`
- Browser contract: `docs/specs/resource-first-control-room-api-v2.md`
- Capability vocabulary: `docs/specs/capability-matrix-v0.md`

## 1. Purpose and normative language

This document freezes the typed authoring, planning, execution, state,
observability, persistence, and migration contract for current transport, spin
drift-diffusion, transport-derived torque, prescribed spin-orbit torque, and
dynamic Oersted fields. It is shared by FDM and FEM, CPU and GPU. Backend
descriptors may change storage layout, but must not redefine these semantics.

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative. Missing required data,
unsupported physics, unavailable execution lanes, incompatible versions, and
stale sources fail closed. A warning is not a substitute for rejection where
this contract says `MUST`.

This specification defines the target M0–M3 contract. It does not claim that
all types or lanes are executable at the date above. Capability records and
resolved plans remain the source of truth for what is actually available.

## 2. Frozen physical representation

The runtime consumes the conventions from notes 0960–0980:

- `e>0`; `J_c` is signed conventional charge-current density in `A/m^2`;
- `gamma_e>0` has unit `s^-1 T^-1`, and `gamma0=mu0*gamma_e` applies to fields
  expressed in `A/m`;
- `mu_s` is the full spin-voltage splitting in `V`, with channel potentials
  `V +/- mu_s/2`;
- `Q_ia` has unit `A/m^2`; index `i` is flow direction and index `a` is spin
  polarization; row-major publication order is
  `[Q_xx,Q_xy,Q_xz,Q_yx,Q_yy,Q_yz,Q_zx,Q_zy,Q_zz]`;
- direct spin torques enter as Gilbert-source rates `T_G` in `1/s` and are
  transformed exactly once to explicit RHS form;
- `H_oe` is `H` in `A/m` and its Biot–Savart definition contains no `mu0`;
- a transport-derived torque is an angular-momentum balance. Spin-flip loss is
  not silently reassigned to magnetization torque;
- prescribed SOT is a local torque model and is not a solved SHE capability.

Every numerical operator, interface law, torque law, reconstruction, and
coupling algorithm MUST carry a version string. Version absence is an invalid
plan, not permission to use a backend default.

## 3. Canonical authored schemas

The following algebraic schemas are normative shapes. Language bindings may
use native tagged unions, but canonical JSON uses the shown `kind` tags. All
identifiers are non-empty stable strings and all references are validated
against the same committed `SceneDocument` revision.

### 3.1 Shared value types

```text
Vector3 = {x: finite f64, y: finite f64, z: finite f64}
UnitVector3 = Vector3 with norm > epsilon_axis, normalized once during lowering
RegionRef = {object_id, region_id?}
SurfaceRef = {object_id, surface_id, orientation: UnitVector3}

TimeEnvelope =
  | {kind:"constant", value}
  | {kind:"sinusoidal", amplitude, frequency_hz>=0, phase_rad, offset}
  | {kind:"pulse", amplitude, t_on_s, t_off_s, t_on_s<t_off_s}
  | {kind:"piecewise_linear", points:[{time_s,value}, ...] strictly increasing}
  | {kind:"sinc", amplitude, center_s, bandwidth_hz>0, offset}
  | {kind:"tabulated", artifact_ref, interpolation, extrapolation,
     bandwidth_hz?}
```

Pulse, piecewise-linear, and tabulated drives used by quasistatic Oersted MUST
provide finite rise-time information or a finite `bandwidth_hz` sufficient for
the quasistatic validity gate. The envelope belongs to the current source. A
consumer MUST NOT define a second independent copy.

### 3.2 Current transport

```text
CurrentTransportModule = {
  schema_version: "current_transport.v1",
  id, domain:[RegionRef, ...],
  model:
    | {kind:"prescribed_density", drive:CurrentDensityDrive,
       divergence_policy:"reject"|"explicit_projection"}
    | {kind:"ohmic_quasistatic", drive:ElectrodeDrive,
       materials:{RegionRef:ChargeTransportMaterial},
       electrodes:[ChargeBoundary, ...], gauge:ChargeGauge}
    | {kind:"magnetoresistive", drive:ElectrodeDrive,
       materials:{RegionRef:MagnetoresistiveMaterial},
       electrodes:[ChargeBoundary, ...], gauge:ChargeGauge},
  envelope:TimeEnvelope,
  coupling:"one_way"|"bidirectional",
  solver:ChargeSolverPolicy,
  requested_execution:RequestedExecution
}
```

`CurrentDensityDrive` is either a signed constant vector or a versioned vector
field artifact with explicit domain and sample-location metadata. Prescribed
fields MUST pass discrete divergence, electrode flux, and insulating-boundary
balance gates. `explicit_projection` is a distinct resolved operator and MUST
be recorded in provenance.

`ChargeTransportMaterial` requires finite `sigma_Spm>0`.
`MagnetoresistiveMaterial` additionally carries one non-conflicting canonical
conductivity parameterization for `sigma_parallel_Spm`, `sigma_perp_Spm`, and
signed Hall terms. Resistivity inputs are authoring adapters only and MUST be
normalized before `ProblemIR`.

`ChargeBoundary` is a tagged union of voltage, ground, total-current,
insulating, and periodic-potential-drop conditions. Conflicting boundary
conditions and a missing gauge MUST be rejected.

### 3.3 Spin transport

```text
SpinTransportModule = {
  schema_version:"spin_transport.v1",
  id, current_source_id, domain:[RegionRef, ...],
  mode:"steady"|"transient",
  materials:{RegionRef:SpinTransportMaterial},
  interfaces:[SpinInterface, ...],
  boundaries:[SpinBoundary, ...],
  solver:SpinSolverPolicy,
  coupling:"one_way"|"bidirectional",
  requested_execution:RequestedExecution
}

SpinTransportMaterial = {
  sigma_s_Spm>0, polarization_p in [-1,1], theta_sh:finite,
  lambda_sf_m>0,
  lambda_j_m:(positive|"disabled"),
  lambda_phi_m:(positive|"disabled"),
  spin_capacitance_As_per_Vm3:(positive|required only for transient)
}
```

In ferromagnets the dissipative block MUST satisfy
`sigma_s - polarization_p^2*sigma > 0`. M1 one-way transport excludes
spin-to-charge feedback and inverse SHE. Requesting those terms with
`coupling="one_way"` is invalid. M2 bidirectional transport includes the
complete reciprocal constitutive block selected by its formula version.

`SpinBoundary` is one of `spin_insulating`, `spin_sink`,
`specified_spin_potential`, `specified_spin_flux`, or `periodic_spin`.
`spin_insulating` may be inserted as the documented default only on otherwise
unassigned external spin boundaries, and the resolved plan MUST list each
inserted boundary.

### 3.4 Interfaces

```text
SpinInterface =
  | {kind:"transparent", id, side_a, side_b, normal_a_to_b}
  | {kind:"mixing_conductance", id, normal_to_ferromagnet,
     normal_side, ferromagnet_side,
     g_up_Spm2>=0, g_down_Spm2>=0, g_r_Spm2>=0, g_i_Spm2:finite,
     g_sml_Spm2>=0,
     absorption:"full_absorption",
     formula_version:"magnetoelectronic.fullmag.v1"}
```

The normal is part of identity and provenance. Reversing it without swapping
the oriented sides changes the authored problem. Backends MUST assemble one
interface flux law, not independent volume sources on both sides. Finite
interface resistance requires independent traces (broken/subdomain spaces,
mortar, or a separately versioned stable realization).

### 3.5 Torque modules

```text
SpinTorqueModule =
  | ZhangLiTorque
  | SlonczewskiTorque
  | PrescribedSpinOrbitTorque
  | DriftDiffusionSpinTorque

ZhangLiTorque = {
  schema_version:"zhang_li_torque.v1", id, target:RegionRef,
  current_source_id, polarization_p in [0,1], beta:finite,
  lande_g>0,
  boundary_policy:{inflow, outflow, mask_boundary, periodic_axes},
  formula_version:"zhang_li.fullmag.v1"
}

SlonczewskiTorque = {
  schema_version:"slonczewski_torque.v1", id, target:RegionRef,
  drive:{kind:"current_source", current_source_id}
        |{kind:"signed_normal_current", current_density_Apm2,
          envelope:TimeEnvelope?},
  polarization_hat:UnitVector3,
  stack_normal:UnitVector3,
  polarization_p in [0,1], lambda>=1, epsilon_prime:finite,
  realization:
    | {kind:"thin_layer_homogenized", free_layer_thickness_m>0}
    | {kind:"interface_flux", interface_id},
  formula_version:"slonczewski.fullmag.v1"
}

PrescribedSpinOrbitTorque = {
  schema_version:"prescribed_sot.v1", id, target:RegionRef,
  drive:
    | {kind:"signed_scalar", current_density_Apm2, sigma_hat:UnitVector3,
       envelope:TimeEnvelope?}
    | {kind:"vector_current_source", current_source_id,
       drive_direction:UnitVector3, interface_normal:UnitVector3},
  xi_dl:finite, xi_fl:finite, free_layer_thickness_m>0,
  formula_version:"prescribed_sot.fullmag.v1"
}

DriftDiffusionSpinTorque = {
  schema_version:"drift_diffusion_torque.v1", id,
  transport_source_id, targets:[RegionRef, ...],
  projection:"volumetric"|"interface_flux",
  formula_version:"transport_absorption.fullmag.v1"
}
```

The public canonical class is `PrescribedSpinOrbitTorque`. Authored
`SpinOrbitTorque` is accepted only as a compatibility alias carrying
deprecation metadata; canonical script and scene export MUST use the canonical
name. A module MUST NOT combine `signed_scalar` and `vector_current_source`.
The vector-source form derives signed amplitude and polarization once; current
reversal MUST NOT also reverse the authored drive axis.

`DriftDiffusionSpinTorque` references a solved spin transport. It MUST NOT own
an independent current density, polarization, or spin solver.

Zhang–Li consumes the signed vector current without replacing it by a norm.
Slonczewski derives `J_n=J_c dot stack_normal`; `stack_normal` is not a hidden
current-sign switch. Homogenized and interface-flux realizations are mutually
exclusive for the same target/interface, and only the homogenized realization
contains the explicit `1/free_layer_thickness_m` rate conversion.

### 3.6 Oersted source

```text
OerstedSource = {
  schema_version:"oersted_source.v1", id, current_source_id,
  circuit_closure:
    | {kind:"closed_geometry"}
    | {kind:"external_lead_extension", version, parameters}
    | {kind:"analytic_return_path", version, parameters},
  method:"auto"|"analytic_cylinder"|"fdm_fft_cell_integrated"
         |"direct_biot_savart"|"fem_vector_potential",
  refresh:"stage_consistent"|"separable_scale"|"accepted_step_approx",
  requested_execution:RequestedExecution
}
```

General Biot–Savart/Oersted execution without a globally closed circuit model
MUST be rejected. `accepted_step_approx` is a degraded approximation, never a
strict default, and requires a workload-specific temporal-order qualification.

## 4. ProblemIR and resolved plan

### 4.1 Serializer versions

The first contract implementation MUST introduce named constants rather than
implicit serde shape changes:

```text
problem_ir_schema = "fullmag.problem_ir.spin_transport.v1"
plan_abi_schema   = "fullmag.plan_abi.spin_transport.v1"
native_descriptor_abi = "fullmag.spin_transport_descriptor.v1"
checkpoint_schema = "fullmag.spin_transport_checkpoint.v1"
```

The concrete numeric `ir_version` and ABI integer assigned during
implementation MUST be monotonically greater than the then-current published
values. Numeric values are intentionally not guessed in this docs-only PR.

`ProblemIR` owns typed authored semantics:

```text
SpinTransportModuleIR
ChargeTransportMaterialIR
SpinTransportMaterialIR
SpinInterfaceIR
SpinBoundaryIR
PrescribedSotIR
DriftDiffusionTorqueIR
OerstedSourceIR
```

The resolved plan owns:

```text
ResolvedCurrentTransportPlanIR
SpinTransportPlanIR
Vec<ResolvedSpinTorquePlanIR>
ResolvedOerstedPlanIR
CoupledIntegratorPlanIR
```

Flat `stt_*` and `sot_*` fields MAY exist only inside the old-ABI input
adapter. They MUST NOT be added to new backend context state.

### 4.2 Requested and resolved execution

Every module and run preserves:

```text
RequestedExecution = {
  discretization:"fdm"|"fem"|"auto"|"hybrid",
  device:"cpu"|"gpu"|"auto",
  precision:"single"|"double",
  execution_mode:"strict"|"extended"|"hybrid",
  ui_mode:"headless"|"ui"|"auto",
  requested_engine?:string
}

ResolvedExecution = {
  discretization:"fdm"|"fem",
  device:"cpu"|"gpu",
  precision:"single"|"double",
  runtime_family, runtime_id, engine_id,
  operator_versions:{string:string},
  implementation_state, validation_state, validated_scope?,
  degradation?:{code,reason}, fallback?:{from,to,reason}
}
```

`strict` MUST reject any unavailable requested lane or physics. In particular,
requested strict GPU MUST NOT execute a CPU solve, CPU operator, host-side
transport iteration, or CPU Oersted solve while retaining GPU provenance.
Extended mode MAY resolve a scientifically equivalent fallback only when the
capability explicitly permits it; requested and resolved records and a typed
warning are mandatory. `hybrid` is future opt-in and MUST NOT be inferred from
`auto`.

### 4.3 Source binding and cache identity

Bindings are directed and named:

```text
CurrentTransport -> J_charge
J_charge -> SpinTransport, ZhangLi, Slonczewski, PrescribedSOT, Oersted
SpinTransport -> spin_potential, spin_current_tensor
SpinTransport -> DriftDiffusionSpinTorque
```

The planner validates domains, sample locations, interface orientations,
stage availability, and cycles. Consumers MUST read the exact published source
revision; recomputing `J_charge` independently is forbidden.

Cache identity includes module/schema/formula/operator versions, normalized
materials, BCs, oriented interfaces, source bindings, envelope, geometry,
mesh/domain revisions, precision, solver policy, current state revision,
magnetization revision where applicable, and stage time. A cache hit is valid
only when every identity component matches.

## 5. Runtime ownership and revisions

### 5.1 Single owners

| State | Owner | Consumers |
|---|---|---|
| authored transport/torque/Oersted model | `SceneDocument` | lowering, UI, script export |
| current transport numerical state | current-transport workflow | spin transport, torques, Oersted, fields |
| spin transport numerical state | spin-transport workflow | transport torque, fields, checkpoints |
| magnetization and outer integrator state | LLG workflow/integrator | transport coefficients, all interactions |
| torque evaluation | direct-torque interaction owner | integrator, field store |
| Oersted solve/cache | Oersted interaction owner | integrator, field store |
| orchestration, artifacts, provenance | runner | API and persistence |

The integrator coordinates stage evaluation but does not implement charge,
spin, torque, or Oersted physics. Backend contexts store typed handles and
descriptors, not duplicate semantic parameter sets.

### 5.2 Revision vocabulary

```text
scene_revision              authored canonical scene
plan_revision               normalized resolved plan
mesh_revision               topology/geometry used by operators
material_revision           normalized coefficient fields
magnetization_revision      committed accepted m state
current_operator_revision   assembled charge operator and BC identity
current_state_revision      committed V/J solution
spin_operator_revision      assembled spin operator/interface identity
spin_state_revision         committed mu_s/Q solution
transport_coupling_revision consistent V/mu_s/J/Q tuple for M2/M3
oersted_operator_revision   kernel/vector-potential operator identity
oersted_state_revision      committed H_oe from one J revision
field_revision              materialized binary field samples
checkpoint_revision         durable restart state
```

Each state resource carries `source_revisions`, `evaluated_time_s`,
`stage_id`, `outer_step`, `stage_index`, `accepted`, and `freshness`.
`freshness` is one of `fresh`, `stale_source`, `stale_time`, `provisional`, or
`unavailable`, with a typed reason. Provisional evaluations do not advance
committed revisions or public field freshness.

## 6. Stage cadence and coupled evaluation

Every RHS evaluation uses
`t_stage=t_n+c_i*dt` and the corresponding `m_stage`. Observable fields MUST
be the values used by that RHS or a separately identified accepted-state final
refresh; they MUST NOT mix stages.

### 6.1 M0 direct modules

Prescribed current, torque, and Oersted evaluate their common source envelope
at `t_stage`. A separable source MAY cache spatial `J_0` and `H_0`; scale and
time remain stage-local. FSAL reuse requires an exact accepted-state cache key.

### 6.2 M1 one-way quasistatic

Strict stage cadence is:

1. evaluate/solve `J_c(t_stage)`;
2. evaluate `H_oe[J_c]` if active;
3. solve steady spin transport using `m_stage`;
4. calculate absorbed-spin torque;
5. assemble and Gilbert-transform the complete RHS once.

An accepted-step-only spin refresh is allowed only as
`accepted_step_approx`, with explicit degradation provenance and validation.

### 6.3 M2 bidirectional quasistatic

At every required stage, charge and spin solve one coupled nonlinear problem
through the resolved Picard/Newton/JFNK engine. Convergence requires scaled
charge and spin residuals, relative changes in `J_c` and `mu_s`, electrode
balance, spin-angular-momentum balance, and
`dt*||delta T_transport|| <= eta_transport*LTE_m`. Converged state is published
as one `transport_coupling_revision`; partial block updates are not committed.

### 6.4 M3 transient

M3 uses `coupled_imex_ark2` as the production baseline: diffusion and spin
reaction are implicit; LLG/local terms follow the resolved partition. A
physical positive `C_s` is required. `explicit_dp45` with transient spin is
unsupported until a separately validated partition exists. Optional
subcycling requires its own formula version, error controller, interpolation
order proof, and provenance.

## 7. Acceptance, rejection, and rollback

Before a trial step the integrator creates a transaction containing committed
`m`, `V`, `J_c`, `mu_s`, `Q`, `H_oe`, nonlinear/Krylov histories, cache keys,
operator/state revision counters, and telemetry accumulators.

The step is rejected when any required transport solve fails, a physical
balance exceeds its gate, a value is nonfinite, the outer error controller
rejects, a source revision changes during evaluation, or a strict residency
invariant is violated. On rejection:

- all committed states, cache heads, warm starts, and revision counters revert;
- provisional buffers may be retained only as uncommitted scratch and MUST
  never be addressable as accepted state;
- `field_revision`, artifact indexes, and accepted-step counters do not advance;
- rejected-attempt telemetry is appended with attempt identity and reason;
- a retry uses the rolled-back accepted state, not the last nonlinear iterate.

On acceptance, all coupled state is atomically promoted, accepted revisions
advance exactly once, and final accepted-state observables are refreshed when
the integrator contract requires it. Common rollback is mandatory for M3.

## 8. Operator and solver contract

### 8.1 Required version families

At minimum, resolved plans name versions for:

```text
gilbert_transform.fullmag.v1
zhang_li.fullmag.v1 | zhang_li.legacy_fullmag.v0
slonczewski.fullmag.v1
prescribed_sot.fullmag.v1
transport_constitutive.one_way.fullmag.v1
transport_constitutive.reciprocal.fullmag.v1
magnetoelectronic.fullmag.v1
sml_surface_conductance.fullmag.v1
transport_absorption.fullmag.v1
fv_charge_face_flux.v1
fv_spin_upwind_v1 | fv_spin_central_reference_v1
structured_cross_gradient_v1
fdm_oersted_cell_integrated_open.v1
fdm_face_to_cell_current.v1
fem_charge_spin_broken_h1_mortar.v1
fem_oersted_hcurl_h1_gauge.v1
coupled_imex_ark2.v1
```

A backend may expose additional engine versions, but MUST map them to the same
formula versions. Changing signs, prefactors, index order, weak form, boundary
law, reconstruction, stabilization, kernel quadrature, padding/crop, or gauge
is a new version.

### 8.2 Solver policies

```text
LinearSolverPolicy = {
  engine:"auto"|named_engine,
  relative_tolerance>0, absolute_tolerance>=0,
  max_iterations>0, preconditioner, residual_norm_version,
  deterministic_reductions?:bool
}

NonlinearSolverPolicy = {
  engine:"picard"|"newton"|"jfnk",
  relative_tolerance>0, absolute_tolerance>=0,
  max_iterations>0, line_search?, eta_transport in (0,1),
  linear:LinearSolverPolicy
}
```

Defaults are contract data, not backend library defaults: linear relative
tolerance begins at `1e-10` for double and `1e-6` for qualified single;
absolute tolerances use versioned physical scales. Charge balance targets are
`1e-10` double and `1e-6` single, with a versioned absolute reference for open
circuit. Interface spin balance is at most `10*linear_solver_rtol`. Any default
or tolerance change requires a versioned error-budget note.

CG is legal only for a proven symmetric positive-definite operator. Hall,
iSHE, mixing, and full M2 blocks resolve to nonsymmetric block solvers such as
GMRES. The plan records the actual preconditioner and stopping norm.

### 8.3 Residual and balance telemetry

Each solve record includes:

```text
solve_id, module_id, attempt_id, stage_id, outer_step, stage_index,
evaluated_time_s, engine_id, operator_revision, state_revision,
initial_residual, final_residual, residual_norm_version,
absolute_tolerance, relative_tolerance, iterations, nonlinear_iterations,
convergence_reason, preconditioner, wall_time_s,
charge_balance_error, spin_balance_error,
electrode_currents_A, interface_flux_balance,
transport_torque_uncertainty_per_s,
source_revisions, freshness, accepted
```

Library residual alone is insufficient; physical cell/element residual and
global charge/spin balances are independently evaluated.

## 9. Residency and transfer rules

CPU and GPU are separate runtime realizations sharing physics descriptors.
Strict GPU requires device-resident current, spin, Oersted, and coupled state,
device operator application, and device solve for every active module.

Allowed host interaction in strict GPU is limited to bounded scalar
convergence/status readback and configured output/checkpoint cadence. Every
transfer is counted. Per-stage vector H2D/D2H, CPU solve, CPU fallback, and
host reconstruction of a field used by the GPU RHS are forbidden.

Runtime telemetry includes `device_residency`, bytes and count by H2D/D2H,
transfer reason, synchronization count, and
`validation_fallback_used=false`. Any invariant violation aborts the strict
run with `strict_gpu_residency_violation`; it cannot silently downgrade
provenance. FP32 is a separate qualified lane, never inferred from FP64.

## 10. Quantities and artifacts

### 10.1 Stable quantity IDs

The following existing IDs are preserved exactly:

| ID | Shape | SI unit |
|---|---|---|
| `V_electric` | scalar | V |
| `J_charge` | vector | A/m^2 |
| `H_oe` | vector | A/m |
| `torque_stt` | vector | 1/s |
| `torque_sot` | vector | 1/s |

New canonical IDs are `spin_potential`, `spin_current_tensor`,
`spin_flux_normal`, `torque_zhang_li`, `torque_slonczewski`,
`torque_transport`, `torque_spin_total`, `oersted_zeeman_energy`,
`oersted_zeeman_work_snapshot`, and `joule_power_density` with the units and
shapes from the governing physics notes. Aggregate legacy torque IDs remain;
component quantities do not replace them.

`spin_current_tensor` uses FMVP `n_comp=9` with mandatory metadata:
`component_order=row_major_Q_ia`, `flow_axes=[x,y,z]`,
`spin_axes=[x,y,z]`, sample location, domain/scope, source revisions, and
formula version. It MUST NOT be flattened semantically to a 3-vector.

Every field sample carries `evaluated_time_s`, `stage_index` or
`accepted_state`, source state revisions, operator/formula versions, freshness,
domain identity, and precision. Materialized observable values MUST equal the
values consumed by the associated RHS evaluation.

### 10.2 Oersted energy semantics

For current independent of `m`, the scalar is
`oersted_zeeman_energy` with `energy_semantics="external_zeeman"` and may join
`E_total`; it has no factor `1/2`. For M2 current depending on `m`, the scalar
is `oersted_zeeman_work_snapshot` with
`energy_semantics="coupled_diagnostic_nonvariational"`. It MUST be excluded
from `E_total`, energy minimizers, and conservative-field derivative checks.

### 10.3 Artifact manifests

`spin_transport_manifest.v1` references heavy data-plane children and stores:
authored/canonical class, alias/deprecation, normalized parameters and units,
source graph, formula/operator versions, oriented interfaces, solver policies,
requested/resolved execution, capability evidence scope, runtime/package/image
identity, state/source revisions, balances/residuals, coupling cadence,
accepted/rejected counts, Oersted circuit/method metadata, transfer audit,
warnings/degradations, code commit, and child hashes.

Thin JSON manifests never inline large `V`, `J`, `mu_s`, `Q`, torque, or
Oersted arrays. Those use the existing versioned field data plane.

## 11. Resource-first API and revisions

Typed projections over one `SceneDocument` and one `scene_revision` are:

```text
/v2/sessions/current/model/current-transports
/v2/sessions/current/model/spin-transports
/v2/sessions/current/model/spin-interfaces
/v2/sessions/current/model/spin-torques
/v2/sessions/current/model/oersted-fields
```

Collections support `GET` and `POST`; item routes support `GET`, `PATCH`, and
`DELETE`. Mutations require `base_revision`, validate a complete typed draft,
and return the committed scene plus new `scene_revision`. A stale base returns
`409 revision_conflict`. These are projections, not independent stores.

Execution resources remain under `simulation`; quantity catalogs, field
samples, and manifests remain under `data`; checkpoint operations remain under
`persistence`; solver/transfer details may be projected under `diagnostics`.
`status` contains only capability summaries and revision pointers. Websocket
events invalidate exact resources and do not carry numerical payloads.

Required independent revision pointers include current/spin transport state,
transport diagnostics, field samples, artifacts, and checkpoints. UI-only
mutations MUST NOT advance them. `status.capabilities` remains the only active
session UI gating source.

## 12. Checkpoint and restart

M0–M2 checkpoints store committed magnetization, simulation time/step, source
envelope state, accepted current/spin/Oersted revisions, resolved plan identity,
and any warm-start state required for deterministic continuation. M3 additionally
stores:

- `V`, `J_c`, `mu_s`, and `Q` committed state;
- IMEX stage/history vectors and error-controller state;
- nonlinear/Krylov warm starts when they affect deterministic continuation;
- current/spin/Oersted cache keys and operator revisions;
- accepted/rejected counters, RNG state where applicable, and telemetry cursor;
- complete requested/resolved runtime and precision identity.

Restore validates checkpoint schema, ProblemIR/plan ABI, scene/mesh/material
identity, formula/operator versions, vector sizes/layouts, endianness,
precision, and lane compatibility before allocating mutable runtime state.
Mismatch returns a typed `checkpoint_incompatible` reason. No field is silently
dropped or recomputed under a different formula version. Cross-device restart
is permitted only by an explicit migrated checkpoint path with provenance and
parity validation; strict restart does not infer it.

A restart must reproduce the uninterrupted run bitwise where the documented
lane promises determinism, otherwise within an explicit workload tolerance.

## 13. ABI/schema migration and compatibility

The v1 migration matrix is:

| Legacy input | Canonical result | Rule |
|---|---|---|
| `SpinOrbitTorque` / `spin_orbit_torque` | `PrescribedSpinOrbitTorque` / `prescribed_sot` | read alias; emit deprecation; canonical export uses new name |
| `fixed_layer_position` | oriented `n_stack` | deterministic conversion with migration warning |
| legacy Zhang–Li prefactor | `formula_version=zhang_li.legacy_fullmag.v0` | preserve result; explicit upgrade tool is required for v1 |
| flat `stt_*`/`sot_*` plan fields | `Vec<ResolvedSpinTorquePlanIR>` | old plan ABI input adapter only |
| placeholder drift diffusion | none | fail closed unless domains, materials, BCs, and source binding are complete |

Readers support the immediately previous published ProblemIR version and the
new spin-transport v1 version. Writers emit only the new canonical version.
Unknown fields in a physics module, unknown formula/operator versions, or
conflicting alias and canonical fields are errors. Alias use is recorded in
scene diagnostics and run provenance. Removal of a legacy reader requires a
new ADR, usage telemetry evidence, fixtures proving canonical export, and a
declared release boundary.

Native C ABI descriptors carry `struct_size`, numeric ABI version, schema id,
required feature bits, and reserved zero fields. The wrapper validates all of
them before access. Old and new ABI translation occurs in a dedicated adapter,
not in solver hot paths. ABI mismatch MUST fail before execution with
`incompatible_spin_transport_abi`.

Required migration fixtures cover deserialize legacy, normalize, canonical
export, deserialize again, lower to `ProblemIR`, and field-by-field semantic
comparison. Unsupported legacy payloads produce a versioned error containing
the exact missing semantic fields.

## 14. Capability gates M0–M3

Capability records use
`unsupported | source_visible | semantic_only | reference_executable |
production_executable | validated`, plus independent implementation and
validation states and workload-scoped evidence. A status is resolved per
discretization, device, precision, execution mode, BC/interface family,
formula/operator version, and workload envelope.

### 14.1 M0

M0 covers corrected canonical direct torque/Oersted semantics and complete
round-trip. Exit requires all P0 sign/unit/Gilbert, signed-current, mask,
stage-time/FSAL/final-refresh, arbitrary-axis-or-reject, strict-GPU provenance,
observable, and energy-semantic gates; FP64 macrospin oracle; documented FP32
budget; all integrator stage-time tests; legacy and canonical round-trip; and
managed FEM runtime proof. Prescribed SOT MUST be advertised only as
`spin_torque.prescribed_sot`; it MUST NOT satisfy any SHE transport capability.

### 14.2 M1

M1 is one-way quasistatic charge-to-spin-to-torque/Oersted. Lane promotion
requires conservative charge balance, analytic 1D spin diffusion/SHE limits,
transparent and mixing-interface balance, absorbed-spin torque balance,
closed-circuit Oersted oracle, FDM/FEM convergence, GPU-double parity and
residency, artifact/API/UI inspection, and complete provenance. `validated` is
limited to named workloads, meshes/BCs, parameter ranges, lane, and precision.

### 14.3 M2

M2 is reciprocal bidirectional quasistatic transport. Promotion requires the
full constitutive block, Onsager/sign oracle, nonnegative dissipative
production, AMR/PHE/AHE manufactured solutions, SHE/iSHE reciprocity,
spin-backflow and SML balances, nonlinear convergence map, outer-step rejection
on transport failure, rollback/freshness tests, FDM/FEM convergence, CPU/GPU
parity/residency, and provenance for every feedback term.

### 14.4 M3

M3 is transient spin transport with physical `C_s` and common rollback.
Promotion requires IMEX-ARK2 production execution, independent implicit/BDF2
oracle, exponential and diffusion-mode decay, temporal-order evidence,
stiff-limit convergence to M1/M2, pulse phase/amplitude, deterministic rejected
steps, complete checkpoint/restart equivalence, and managed CPU/GPU workloads.

No milestone inherits `validated` from an earlier milestone. Unsupported
combinations return a typed capability diagnostic at planning time. Source
visibility, compilation, a small algebra test, or one green backend does not
promote another lane.

## 15. Canonical rejection codes

At minimum planners/runtimes expose stable codes for:

```text
unsupported_physics_regime
unsupported_spin_transport_capability
incomplete_spin_transport_definition
invalid_current_source_binding
invalid_interface_orientation
current_continuity_violation
missing_charge_gauge
conflicting_transport_boundary_condition
missing_oersted_circuit_closure
unsupported_oersted_periodicity
transport_nonconvergence
transport_balance_violation
stale_transport_source
outer_step_rejected
strict_gpu_residency_violation
incompatible_problem_ir_version
incompatible_spin_transport_abi
checkpoint_incompatible
```

Diagnostics include module/source ids, requested and resolved lane, exact
unsupported feature or failed gate, relevant revisions, and remediation. They
MUST NOT suggest a fallback that the current execution mode forbids.

## 16. Verification obligations

Implementation is incomplete until tests cover:

1. Python, UI, SceneDocument, canonical script, and ProblemIR normalized
   round-trip for every field and alias;
2. schema/ABI migration, conflict, unknown-version, and fail-closed fixtures;
3. planner requested/resolved and strict/extended/hybrid decisions;
4. stage time, FSAL, final refresh, rejection, atomic commit, and rollback;
5. independent physical residual and balance telemetry;
6. quantity IDs, units, tensor metadata, source revisions, and freshness;
7. checkpoint corruption/incompatibility and restart equivalence;
8. strict GPU zero-hot-loop-transfer and no-CPU-fallback assertions;
9. OpenAPI generation, generated frontend types, resource hooks, exact
   invalidation, and unavailable/degraded UI states;
10. workload-scoped analytic, convergence, cross-backend, precision, and
    managed-runtime gates from notes 0960–0980.

Native FEM/MFEM/CUDA/hypre/libCEED build and runtime evidence MUST use the
container-backed repository `just` recipes. Host-only builds are diagnostics,
not capability proof.

## 17. Deferred work

Full-wave Maxwell, displacement current, skin/proximity effects outside the
qualified envelope, ballistic transport, first-principles tunnelling,
Rashba–Edelstein transport, spin pumping, higher-order FEM, periodic Oersted
Ewald kernels, and general hybrid execution require separate physics notes,
capability rows, versions, and validation. They MUST NOT be inferred from this
v1 contract.
