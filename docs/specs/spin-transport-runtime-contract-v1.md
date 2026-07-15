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

Every envelope value is a dimensionless multiplier with UCUM unit `1`.
Dimensionful source amplitudes remain on the drive or boundary record. The
instantaneous source is always `source_SI(t)=source_base_SI*a(t)`. For a
tabulated envelope the artifact MUST expose one strictly increasing time
column with unit `s` and one finite multiplier column with unit `1`; other
column units, implicit milliseconds, and dimensionful current/voltage columns
are rejected. Interpolation is `linear` or `previous`; extrapolation is
`zero`, `hold`, or `error`. Canonical defaults are `linear` and `error`.

Pulse, piecewise-linear, and tabulated drives used by quasistatic Oersted MUST
provide finite rise-time information or a finite `bandwidth_hz` sufficient for
the quasistatic validity gate. The envelope belongs to the current source. A
consumer MUST NOT define a second independent copy.

### 3.2 Current transport

```text
CurrentDensityDrive =
  | {kind:"uniform_vector", current_density_Apm2:Vector3}
  | {kind:"field_artifact", artifact_ref, domain_ref,
     location:"cell"|"face"|"node", component_order:["x","y","z"],
     unit:"A/m^2", projection_operator_version?}

ChargeTransportMaterial = {
  sigma_Spm:finite>0,
  relative_permittivity:finite>=1,
  validity:{max_displacement_ratio:finite>0}
}

MagnetoresistiveMaterial = {
  sigma_parallel_Spm:finite>0,
  sigma_perp_Spm:finite>0,
  sigma_ahe_Spm:finite,
  parameterization:"conductivity_tensor_3d.fullmag.v1"
}

ElectrodeDrive =
  | {kind:"voltage", driven_boundary_ids:[id,...],
     reference_boundary_ids:[id,...]}
  | {kind:"total_current", driven_boundary_id:id,
     return_boundary_ids:[id,...]}
  | {kind:"periodic_potential_drop", periodic_boundary_id:id}

ChargeBoundary =
  | {kind:"voltage_electrode", id, surface:SurfaceRef, potential_V:finite}
  | {kind:"ground", id, surface:SurfaceRef}
  | {kind:"total_current_electrode", id, surface:SurfaceRef,
     total_current_A:finite, equipotential:true}
  | {kind:"insulating", id, surfaces:[SurfaceRef,...] nonempty}
  | {kind:"periodic_potential_drop", id, minus_surface:SurfaceRef,
     plus_surface:SurfaceRef, translation_m:Vector3 nonzero, drop_V:finite}

ChargeGauge =
  | {kind:"boundary_reference", boundary_id:id}
  | {kind:"zero_mean_potential", weighted_by:"cell_volume"|"fem_mass"}

ChargeSolverPolicy = {
  engine:"auto"|named_engine,
  linear:LinearSolverPolicy,
  physical_residual_version:"transport_balance_integrated_l2.v1"
}
```

An `ElectrodeDrive` references boundaries from the same module and selects the
single independent excitation family. Referenced boundary kinds MUST match the
drive kind. Ground has exactly `0 V`; all other base voltage/current values are
multiplied by the module `TimeEnvelope`. A surface may have at most one charge
boundary assignment, except that the two members of one periodic pair are one
logical assignment. `boundary_reference` must reference `ground` or a voltage
electrode whose potential fixes the nullspace. `zero_mean_potential` is legal
only when no fixed-potential boundary already removes the gauge.

```text
CurrentTransportModule = {
  schema_version: "current_transport.v1",
  id, domain:[RegionRef, ...],
  model:
    | {kind:"prescribed_density", drive:CurrentDensityDrive,
       divergence_policy:"reject"|"explicit_projection"}
    | {kind:"ohmic_quasistatic", drive:ElectrodeDrive,
       materials:{RegionRef:ChargeTransportMaterial},
       boundaries:[ChargeBoundary, ...], gauge:ChargeGauge}
    | {kind:"magnetoresistive", drive:ElectrodeDrive,
       materials:{RegionRef:MagnetoresistiveMaterial},
       boundaries:[ChargeBoundary, ...], gauge:ChargeGauge},
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
SpinBoundary =
  | {kind:"spin_insulating", id, surfaces:[SurfaceRef,...] nonempty}
  | {kind:"spin_sink", id, surfaces:[SurfaceRef,...] nonempty}
  | {kind:"specified_spin_potential", id, surfaces:[SurfaceRef,...],
     spin_potential_V:Vector3, envelope:TimeEnvelope?}
  | {kind:"specified_spin_flux", id, surfaces:[SurfaceRef,...],
     normal_spin_flux_Apm2:Vector3, envelope:TimeEnvelope?}
  | {kind:"periodic_spin", id, minus_surface:SurfaceRef,
     plus_surface:SurfaceRef, translation_m:Vector3 nonzero}

SpinSolverPolicy = {
  engine:"auto"|named_engine,
  linear:LinearSolverPolicy,
  nonlinear:NonlinearSolverPolicy?,
  physical_residual_version:"transport_balance_integrated_l2.v1",
  default_external_boundary:"spin_insulating"|"reject_unassigned"
}
```

Optional boundary envelopes are dimensionless and multiply all three
components of the base vector. Per-component envelopes require a future schema
version. A surface receives exactly one spin boundary or one side of an
interface. Periodic spin pairs cannot overlap a sink, potential, flux, or
mixing boundary. `nonlinear` is absent for linear M1 and required for M2/M3
when the resolved constitutive/operator block is nonlinear.

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
    | {kind:"thin_layer_homogenized", free_layer_thickness_m>0,
       realization_version:"slonczewski_thin_layer_homogenized.v1"}
    | {kind:"interface_flux", interface_id,
       realization_version:"slonczewski_interface_flux.v1"},
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
`ResolvedSpinTorquePlanIR::Slonczewski` MUST retain the selected realization,
its realization version, resolved target/interface identity, thickness source
(`authored` or `geometry_derived`) and value for homogenized execution, and
the oriented surface plus flux-to-weak-form projection version for interface
execution. A missing or ambiguous realization is invalid; no backend default
may select between them.

`ZhangLiTorque.boundary_policy` is exactly:

```text
ZhangLiBoundaryPolicy = {
  inflow:{kind:"specified_m", value:UnitVector3}|{kind:"interior_trace"},
  outflow:"zero_gradient",
  mask_boundary:"no_inflow"|"specified_m",
  periodic_axes:["x"|"y"|"z", ...]
}
```

The shorthand field in the torque schema has this record type. Periodic axes
must match the domain PBC; `interior_trace` is legal only when the signed
velocity is outflow at that face. Ambiguous inflow fails planning.

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
  solver:OerstedSolverPolicy?,
  requested_execution:RequestedExecution
}
```

```text
OerstedSolverPolicy = {
  engine:"fem_oersted_hcurl_h1_gauge_v1"
         |"fem_oersted_hcurl_h1_gauge_device_v1",
  relative_tolerance>0,
  absolute_tolerance_Am>=0,
  max_iterations>0,
  krylov_restart>0,
  preconditioner:"ams_boomeramg_block.v1",
  gauge_solver:"h1_zero_mean_boomeramg.v1"
}
```

`OerstedSolverPolicy` is absent for analytic, direct-quadrature, and FFT
realizations. FEM vector potential requires the record above and uses the
frozen defaults in 8.4 unless explicitly overridden.

General Biot–Savart/Oersted execution without a globally closed circuit model
MUST be rejected. `accepted_step_approx` is a degraded approximation, never a
strict default, and requires a workload-specific temporal-order qualification.

## 4. ProblemIR and resolved plan

### 4.1 Serializer versions

The repository currently writes `ProblemIR 0.2.0` and reads `0.2.0` plus the
previous public `0.1.0`. Spin-transport semantics are a public meaning change,
so the exact target matrix is:

| Payload | `0.3.0` reader | Canonical writer |
|---|---|---|
| `0.3.0` | read directly | writes `0.3.0` |
| `0.2.0` | read through the `0.2.0 -> 0.3.0` migrator | never writes `0.2.0` |
| `0.1.0` | not a direct supported-read version | never writes `0.1.0` |
| any other version | reject | n/a |

The standard reader continues the current-plus-one-previous policy:
`CURRENT_IR_VERSION="0.3.0"`,
`PREVIOUS_PUBLIC_IR_VERSION="0.2.0"`, and
`SUPPORTED_READ_IR_VERSIONS=["0.3.0","0.2.0"]`. A `0.1.0` payload must use
the explicit migration-chain tool, which runs the archived, fixture-locked
`0.1.0 -> 0.2.0` transform and then the current `0.2.0 -> 0.3.0` transform.
The normal deserializer MUST NOT silently chain or directly accept `0.1.0`.
The chain tool emits the intermediate digest, both migration versions, all
warnings, and the final `0.3.0` digest.

The first implementation introduces these exact constants rather than
implicit serde shape changes:

```text
CURRENT_IR_VERSION = "0.3.0"
problem_ir_schema = "fullmag.problem_ir.0.3.0"
plan_abi_schema   = "fullmag.plan_abi.spin_transport.v1"
checkpoint_schema = "fullmag.spin_transport_checkpoint.v1"

FULLMAG_FDM_SPIN_TRANSPORT_ABI_VERSION    = 1u
FULLMAG_FDM_SPIN_TRANSPORT_STRUCT_VERSION = 1u
FULLMAG_FEM_SPIN_TRANSPORT_ABI_VERSION    = 1u
FULLMAG_FEM_SPIN_TRANSPORT_STRUCT_VERSION = 1u
FDM descriptor schema = "fullmag.fdm.spin_transport_descriptor.v1"
FEM descriptor schema = "fullmag.fem.spin_transport_descriptor.v1"
```

The new spin-transport descriptors are independent ABI families and therefore
start at version `1`; they do not inherit frequency-domain ABI `12`. Each C
descriptor begins, in order, with `uint32_t abi_version`,
`uint32_t struct_version`, and `uint64_t struct_size`. All three fields are
mandatory and nonzero. FDM rejects values other than `(1,1,sizeof(v1 FDM
descriptor))`; FEM applies the corresponding exact FEM size. Rust FFI mirrors
the layout and constants with compile-time size/offset assertions. The existing
unversioned wide time-domain plan structs may reference these descriptors by
pointer/count during migration, but spin-transport fields MUST NOT be appended
flat to those structs.

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
slonczewski_thin_layer_homogenized.v1
slonczewski_interface_flux.v1
prescribed_sot.fullmag.v1 | prescribed_sot.legacy_fullmag.v0
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
  relative_tolerance>0, absolute_tolerance_A>=0,
  max_iterations>0, krylov_restart?, preconditioner,
  algebraic_residual_norm_version, physical_residual_norm_version,
  deterministic_reductions?:bool
}

NonlinearSolverPolicy = {
  engine:"picard"|"newton"|"jfnk",
  relative_state_tolerance>0, absolute_spin_potential_tolerance_V>=0,
  absolute_current_tolerance_Apm2>=0, max_iterations>0,
  relaxation in (0,1], line_search?, eta_transport in (0,1),
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

### 8.3 Physical residual normalization

All charge/spin linear policies use
`physical_residual_norm_version="transport_balance_integrated_l2.v1"`.
For each control volume or FEM test-function row `K`, after essential-row
elimination, define integrated residuals in amperes:

```text
R_c,K = sum_f A_f (J_c,f dot n_Kf) - b_c,K
D_c,K = sum_f A_f |J_c,f dot n_Kf| + |b_c,K|

R_s,K,a = C_s V_K delta_t(mu_s,K,a)
          + sum_f A_f q_s,f,a + V_K R_K,a - b_s,K,a
D_s,K,a = |C_s V_K delta_t(mu_s,K,a)|
          + sum_f A_f |q_s,f,a| + V_K |R_K,a| + |b_s,K,a|
```

For steady solves the accumulation term is zero. FEM uses the assembled weak
row and the same decomposition of accumulation, flux, reaction, and source.
The reported physical norms are

```text
rho_charge = sqrt(sum_K R_c,K^2) /
             max(sqrt(sum_K D_c,K^2), 1e-30 A)
rho_spin   = sqrt(sum_K,a R_s,K,a^2) /
             max(sqrt(sum_K,a D_s,K,a^2), 1e-30 A)
abs_charge = max_K |R_c,K|                    [A]
abs_spin   = max_K,a |R_s,K,a|                [A]
```

Interface rows are counted once per oriented interface; their paired
normal-flux mismatch is additionally normalized by the sum of incoming and
outgoing absolute integrated flux with the same `1e-30 A` floor. Electrode
balance is `|sum_e I_e|/max(sum_e|I_e|,1e-30 A)`. Library residual norms are
reported separately and cannot satisfy a physical gate by themselves.

Linear convergence requires both the algebraic relative tolerance and either
the physical relative tolerance or the physical absolute tolerance. The
absolute check prevents a zero-source system from dividing by a numerical
floor; it does not waive interface or electrode balance.

### 8.4 Frozen v1 default profiles

The default precision profiles are exhaustive for the v1 operators below:

| Profile | algebraic rtol | physical relative gate | physical absolute gate | interface/electrode balance |
|---|---:|---:|---:|---:|
| `transport_solver_fp64.v1` | `1e-10` | `1e-10` | `1e-18 A` | `1e-10` and interface `<=10*rtol` |
| `transport_solver_fp32.v1` | `1e-6` | `1e-6` | `1e-12 A` | `1e-6` and interface `<=10*rtol` |

FDM CPU and FEM CPU are double-only for this contract. GPU single rows are
`unsupported` unless a capability row explicitly qualifies the operator and
workload; qualifying them uses the frozen FP32 profile, not a backend-library
default. `auto` resolves exactly to the row selected by milestone, lane, and
precision:

| Milestone | Lane/precision | Operator/engine | Krylov and preconditioner | restart / max iterations | Profile |
|---|---|---|---|---:|---|
| M0 | all legal direct lanes | direct algebra; no transport linear solve | none | n/a | FP64 vector oracle `rtol=atol=1e-12` by quantity scale; FP32 `rtol=5e-5` after qualification |
| M1 charge | FDM CPU/double | `fdm_charge_cg_matrix_free_v1` | CG + geometric AMG | n/a / `500` | FP64 |
| M1 charge | FDM GPU/double | `fdm_charge_cg_cuda_v1` | device CG + device AMG | n/a / `500` | FP64 |
| M1 charge | FDM GPU/single | `fdm_charge_cg_cuda_v1` | device CG + device AMG | n/a / `500` | FP32, qualified workloads only |
| M1 charge | FEM CPU/double | `fem_charge_h1_hypre_v1` | hypre PCG + BoomerAMG | n/a / `500` | FP64 |
| M1 charge | FEM GPU/double | `fem_charge_h1_hypre_device_v1` | device hypre PCG + device BoomerAMG | n/a / `500` | FP64 |
| M1 spin | FDM CPU/double | `fdm_spin_block_gmres_csr_v1` | GMRES + component geometric-MG/ILU(0) | `50` / `1000` | FP64 |
| M1 spin | FDM GPU/double | `fdm_spin_block_gmres_cuda_v1` | device GMRES + component AMG/block-Jacobi | `50` / `1000` | FP64 |
| M1 spin | FDM GPU/single | `fdm_spin_block_gmres_cuda_v1` | device GMRES + component AMG/block-Jacobi | `50` / `1000` | FP32, qualified workloads only |
| M1 spin | FEM CPU/double | `fem_spin_broken_h1_mortar_v1` | hypre GMRES + field-split BoomerAMG/interface Jacobi | `50` / `1000` | FP64 |
| M1 spin | FEM GPU/double | `fem_spin_broken_h1_mortar_device_v1` | device hypre GMRES + device field-split AMG/interface Jacobi | `50` / `1000` | FP64 |
| M1 Oersted | FDM CPU/double | `fdm_oersted_fft_open_v1` | FFT; no Krylov/preconditioner | n/a | kernel/direct-oracle gates |
| M1 Oersted | FDM GPU/double | `fdm_oersted_cufft_open_v1` | cuFFT; no Krylov/preconditioner | n/a | FP64 parity gates |
| M1 Oersted | FDM GPU/single | `fdm_oersted_cufft_open_v1` | cuFFT; no Krylov/preconditioner | n/a | qualified FP32 parity gates only |
| M1 Oersted | FEM CPU/double | `fem_oersted_hcurl_h1_gauge_v1` | block GMRES + AMS(`A`)/BoomerAMG(`p`) | `100` / `2000` | algebraic `1e-10`; physical curl/div `1e-8` |
| M1 Oersted | FEM GPU/double | `fem_oersted_hcurl_h1_gauge_device_v1` | device block GMRES + device AMS/BoomerAMG | `100` / `2000` | algebraic `1e-10`; physical curl/div `1e-8` |
| M2 coupled | FDM CPU/double | `fdm_charge_spin_block_gmres_v1` | FGMRES + charge-AMG/spin-MG-ILU field split | `50` / `1500` | FP64 |
| M2 coupled | FDM GPU/double | `fdm_charge_spin_block_gmres_cuda_v1` | device FGMRES + device charge/spin AMG field split | `50` / `1500` | FP64 |
| M2 coupled | FEM CPU/double | `fem_charge_spin_block_gmres_v1` | hypre FGMRES + BoomerAMG field split/interface Jacobi | `50` / `1500` | FP64 |
| M2 coupled | FEM GPU/double | `fem_charge_spin_block_gmres_device_v1` | device hypre FGMRES + device AMG field split/interface Jacobi | `50` / `1500` | FP64 |
| M3 IMEX | FDM CPU/double | `coupled_imex_ark2.v1` + `fdm_charge_spin_block_gmres_v1` | M2 CPU implicit-stage preconditioner | `50` / `1500` per implicit stage | FP64 |
| M3 IMEX | FDM GPU/double | `coupled_imex_ark2.v1` + `fdm_charge_spin_block_gmres_cuda_v1` | M2 device implicit-stage preconditioner | `50` / `1500` per implicit stage | FP64 |
| M3 IMEX | FEM CPU/double | `coupled_imex_ark2.v1` + `fem_charge_spin_block_gmres_v1` | M2 CPU implicit-stage preconditioner | `50` / `1500` per implicit stage | FP64 |
| M3 IMEX | FEM GPU/double | `coupled_imex_ark2.v1` + `fem_charge_spin_block_gmres_device_v1` | M2 device implicit-stage preconditioner | `50` / `1500` per implicit stage | FP64 |
| M3 oracle | CPU double | `coupled_bdf2_small_oracle.v1` | sparse direct when `dofs<=20000`, otherwise M2 FGMRES | n/a or `50` / `2000` | FP64 |

FEM single, all M2 single, and all M3 single are unsupported in v1 until a
new qualification entry supplies an error budget; `auto` cannot select them.
Oersted FFT qualification additionally enforces direct cell-integrated
Biot–Savart parity, while FEM Oersted enforces `curl(H)-J`, `div(B)`, gauge,
and airbox convergence; the displayed curl/div gate is a starting solver gate,
not a substitute for the continuum study.

FEM Oersted uses `oersted_maxwell_residual.v1`:

```text
rho_curl = ||curl(H_oe)-J_c||_L2 /
           max(||J_c||_L2, 1e-30 A/m^2)
rho_div  = L_ref ||div(mu0 H_oe)||_L2 /
           max(||mu0 H_oe||_L2, 1e-30 T)
rho_gauge = ||div(A)||_L2 /
            max(||A||_L2/L_ref, 1e-30 T m / L_ref)
```

`L_ref` is the conductor-plus-airbox bounding-box diagonal recorded in the
plan. The FP64 starting gates are `rho_curl<=1e-8`, `rho_div<=1e-8`, and
`rho_gauge<=1e-8`; all are reported independently. FDM FFT reports the same
curl/div definitions on the qualified interior stencil, with excluded boundary
width and `L_ref` in provenance, but acceptance is primarily direct-integral
parity plus convergence because open-boundary truncation controls the stencil
residual.

The frozen nonlinear default is `transport_nonlinear_picard.v1`:

| Setting | FP64 | FP32 if later qualified |
|---|---:|---:|
| engine | Picard | Picard |
| maximum iterations | `25` | `25` |
| relaxation | `1.0` | `0.7` |
| relative state change for both `J_c` and `mu_s` | `1e-8` | `1e-5` |
| absolute `mu_s` change | `1e-12 V` | `1e-7 V` |
| absolute `J_c` change | `1e-6 A/m^2` | `1e0 A/m^2` |
| `eta_transport` | `0.1` | `0.1` |
| line search | halve on residual growth; minimum factor `1/64`; at most `6` cuts | same |
| inner forcing | `min(1e-2, max(1e-10, 0.5*r_nonlinear))` | `min(1e-2, max(1e-6, 0.5*r_nonlinear))` |

M2 uses this Picard profile as baseline. Newton/JFNK are explicit named
overrides and cannot be selected by `auto` until separately qualified. M3 uses
the same nonlinear profile independently at every implicit stage and rejects
the outer step after any stage exhausts it. Warm start is enabled only when all
source/operator/state revisions match; otherwise the zero/equilibrium initial
guess specified by the milestone is used.

### 8.5 Residual and balance telemetry

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

### 13.1 Sign-preserving Slonczewski migration

The legacy runtime computes `current_sign*|J_c|`, where `top` (and an omitted
legacy field) means `+1` and `bottom` means `-1`. Migration to oriented
`stack_normal` is therefore exact only for a nonzero, direction-uniform source:

```text
d = J_ref/|J_ref|
top or omitted: stack_normal =  d
bottom:         stack_normal = -d
J_n = J_c dot stack_normal = current_sign*|J_c|
```

For a constant vector, `J_ref` is that vector. For a field source, every sample
on the torque target must be finite, satisfy `|J_k|>0`, and satisfy
`1-(J_k/|J_k|) dot d <= 1e-12` against the first sample. A zero vector, a zero
target sample, a direction reversal, a nonuniform direction outside this
tolerance, a missing source, or an unresolved target fails with
`legacy_fixed_layer_position_not_migratable`. The migrator MUST NOT choose a
geometry axis, use the largest component, average opposing currents, or retain
`fixed_layer_position` in normalized `0.3.0` IR. It records the derived normal,
source digest, maximum angular residual, and legacy position in provenance.

If the source has a `TimeEnvelope`, its dimensionless multiplier must be
nonnegative over the declared execution interval. Isolated/pulse-off zeros are
allowed because both legacy and canonical torque are zero there, but a negative
interval would reverse canonical `J_n` while legacy `|J_c|` would not; such a
source is therefore not automatically migratable. Unbounded/tabulated support
whose sign cannot be certified also fails closed.

### 13.2 Prescribed-SOT legacy formula

Every `0.2.0` `SpinOrbitTorque` payload lowers to canonical class
`PrescribedSpinOrbitTorque` but retains
`formula_version="prescribed_sot.legacy_fullmag.v0"`. That version is defined
exactly by the executable FDM behavior at the `0.2.0` boundary:

```text
J_legacy = abs(charge_current_density_a_per_m2)
           or norm(J_charge) for a current_source
sigma_legacy = sigma/|sigma| when |sigma|>1e-30, otherwise (0,0,0)
A_legacy = hbar J_legacy/(2 e mu0 M_s t_F)
T_legacy,explicit = A_legacy [
    -xi_DL m x (m x sigma_legacy) + xi_FL m x sigma_legacy]
```

`T_legacy,explicit` is added directly to `dm/dt`: it has the historical missing
`gamma0`/rate conversion and receives no Gilbert-source transform. It also
loses current sign by construction. These defects are reproduced only to keep
old trajectories reproducible; they are never described as canonical physics.
A finite zero polarization preserves the historical exact-zero contribution
under v0 with a deprecation diagnostic; v1 rejects a zero axis.

Canonical `0.3.0` scene and Python export always use the canonical class name
and explicitly emit `formula_version="prescribed_sot.legacy_fullmag.v0"` for a
migrated old payload. Export MUST NOT relabel it as
`prescribed_sot.fullmag.v1`, inject `gamma0`, infer a current sign, or silently
change the trajectory. Provenance preserves authored alias, old fields, source
resolution, and migration warning.

The explicit `fullmag migrate --upgrade-prescribed-sot-v1` operation requires
the user to provide or confirm signed `J_signed` plus `sigma_hat`, or a
`current_source`, `drive_direction`, and `interface_normal`. It emits a new
`prescribed_sot.fullmag.v1` module and a before/after macrospin comparison. It
never promises trajectory identity and does not overwrite input without the
normal migration transaction/backup. Normal deserialization and canonical
export do not perform this physics upgrade.

### 13.3 Compatibility matrix

The v1 migration matrix is:

| Legacy input | Canonical result | Rule |
|---|---|---|
| `SpinOrbitTorque` / `spin_orbit_torque` | `PrescribedSpinOrbitTorque` / `prescribed_sot` | read alias; preserve `prescribed_sot.legacy_fullmag.v0`; canonical export uses new name and explicit legacy formula |
| `fixed_layer_position` | oriented `n_stack` | exact directional conversion from 13.1 or fail closed |
| legacy Zhang–Li prefactor | `formula_version=zhang_li.legacy_fullmag.v0` | preserve result; explicit upgrade tool is required for v1 |
| flat `stt_*`/`sot_*` plan fields | `Vec<ResolvedSpinTorquePlanIR>` | old plan ABI input adapter only |
| placeholder drift diffusion | none | fail closed unless domains, materials, BCs, and source binding are complete |

Readers support `0.3.0` and immediately previous `0.2.0`; `0.1.0` uses the
explicit two-step chain defined in 4.1. Writers emit only `0.3.0`.
Unknown fields in a physics module, unknown formula/operator versions, or
conflicting alias and canonical fields are errors. Alias use is recorded in
scene diagnostics and run provenance. Removal of a legacy reader requires a
new ADR, usage telemetry evidence, fixtures proving canonical export, and a
declared release boundary.

Native C ABI descriptors carry the exact `(abi_version=1, struct_version=1,
struct_size=sizeof(v1 lane descriptor))` triplet, schema id, required feature
bits, and reserved zero fields. The wrapper validates all of them before
access. Old and new ABI translation occurs in a dedicated adapter, not in
solver hot paths. ABI mismatch MUST fail before execution with
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
