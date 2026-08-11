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
  base:ChargeTransportMaterial,
  sigma_parallel_Spm:finite>0,
  sigma_perp_Spm:finite>0,
  sigma_ahe_Spm:finite,
  parameterization:"conductivity_tensor_3d.fullmag.v1",
  reciprocal_reference_conductivity:"base.sigma_Spm"
}

ElectrodeDrive =
  | {kind:"voltage", driven_boundary_ids:[id,...],
     reference_boundary_ids:[id,...]}
  | {kind:"normal_current", driven_boundary_id:id,
     return_boundary_ids:[id,...]}
  | {kind:"periodic_potential_drop", periodic_boundary_id:id}

ChargeBoundary =
  | {kind:"voltage_electrode", id, surface:SurfaceRef, potential_V:finite}
  | {kind:"ground", id, surface:SurfaceRef}
  | {kind:"normal_current_electrode", id, surfaces:[SurfaceRef,...] nonempty,
     outward_current_density_Apm2:finite}
  | {kind:"insulating", id, surfaces:[SurfaceRef,...] nonempty}
  | {kind:"periodic_potential_drop", id, minus_surface:SurfaceRef,
     plus_surface:SurfaceRef, translation_m:Vector3 nonzero, drop_V:finite}

ResolvedSourceCut = {
  schema_version:"fem_current_source_cut.v1", id,
  minus_face_keys:[FaceKey,...] nonempty,
  plus_face_keys:[FaceKey,...] same length,
  pairing:[{minus:FaceKey,plus:FaceKey},...] bijective,
  transform:{translation_m:Vector3, orientation:"minus_to_plus"},
  excitation:{kind:"potential_jump", drop_V:finite}
}

ChargeGauge =
  | {kind:"boundary_reference", boundary_id:id}
  | {kind:"zero_mean_potential", weighted_by:"cell_volume"|"fem_mass"}

ChargeSolverPolicy = {
  engine:"auto"|named_engine,
  linear:LinearSolverPolicy,
  physical_residual_version:"charge_balance_integrated_l2.v1"
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

`ResolvedSourceCut` is not an additional authored boundary kind. In v1 the
planner materializes it only from a validated authored
`periodic_potential_drop` drive/boundary pair of the same
`CurrentTransportModule`; `closed_geometry` alone never creates an excitation.
Its face keys use stable mesh vertex identities. The charge operator solves a
periodic `H1` quotient problem with an affine jump lift (equivalently duplicated
paired traces) satisfying `V_plus-V_minus=drop_V`. The subsequent RT
reconstruction consumes that converged potential and requires equal/opposite
normal flux on every paired cut face. Pairing must be geometrically bijective.

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
`MagnetoresistiveMaterial` composes that complete base material, including
`relative_permittivity` and its quasistatic validity bounds, then adds one
non-conflicting canonical conductivity-tensor parameterization for
`sigma_parallel_Spm`, `sigma_perp_Spm`, and signed Hall terms. The scalar
`base.sigma_Spm` is the **only** `sigma` used in the reciprocal `P` and
direct/inverse-SHE coefficients and in
`sigma_s_Spm-polarization_p^2*base.sigma_Spm>0`. It is a reference
conductivity for those reciprocal terms, not an additional isotropic current
summed into `J_mr`. Resistivity inputs are authoring adapters only and MUST be
normalized before `ProblemIR`; omitting the base material or supplying a
different reciprocal reference conductivity is invalid.

`ChargeBoundary` is a tagged union of voltage, ground, normal-current-density,
insulating, and periodic-potential-drop conditions. Conflicting boundary
conditions and a missing gauge MUST be rejected.

The public Python/`ProblemIR` boundary is
`NormalCurrentElectrode(outward_current_density_Apm2)` and its prescribed value
is a uniform outward-normal current density in `A/m^2` on every selected
surface. The bounded standalone native FDM CPU charge owner currently also has
an implementation-local total-current electrode in `A`, with one unknown
equipotential value per coordinate boundary. That native-only boundary is not a
public authoring mapping. The opt-in native FDM CPU M1 binding materializes the
public density contract as exact external structured faces. Every selected face
MUST have an active adjacent charge cell; otherwise the planner rejects the
complete source and identifies the source ID, face index, and adjacent cell.
Silently clipping a partly inactive authored electrode scope is forbidden.

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
  requested_execution:RequestedExecution
}

SpinTransportMaterial = {
  sigma_s_Spm>0, polarization_p in [-1,1], theta_sh:finite,
  lambda_sf_m>0,
  lambda_j_m:(positive|"disabled"),
  lambda_phi_m:(positive|"disabled"),
  spin_capacitance_As_per_V_m3:(positive|optional calibrated reduction),
  density_of_states_per_spin_Jinv_m3:(positive|optional per-spin DOS adapter),
  capacitance_formula_version:(nonempty|required with either source)
}
```

For `dos_isotropic_nonmagnetic.fullmag.v1`, the planner derives
`C_s=e^2 N_0` from `density_of_states_per_spin_Jinv_m3`. An explicitly authored
`C_s` is a calibrated scalar susceptibility; when both values are present they
must agree within `1e-12` relative error. A transient material must provide one
of these physical sources; arbitrary capacitance formula strings are rejected.

In ferromagnets the dissipative block MUST satisfy
`sigma_s - polarization_p^2*sigma_ref > 0`, where `sigma_ref` is the bound
current material's `sigma_Spm` (for magnetoresistive M2, exactly
`MagnetoresistiveMaterial.base.sigma_Spm`). M1 one-way transport excludes
spin-to-charge feedback and inverse SHE. Requesting those terms with
the source `CurrentTransportModule.coupling="one_way"` is invalid. M2
bidirectional transport includes the complete reciprocal constitutive block
selected by its formula version.

`CurrentTransportModule.coupling` is the single public owner of coupling.
`SpinTransportModule` has no independently authorable coupling field. Lowering
resolves `current_source_id`, copies the source coupling into the derived
`SpinTransportPlanIR.resolved_coupling`, and validates spin mode, formula, and
requested feedback against that value. Normalization removes a legacy spin-side
coupling field only when it equals the referenced current source; a conflicting
value fails with `conflicting_transport_coupling_owner` and no field is silently
preferred.

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
     spin_memory_loss?:{g_n_Spm2>=0, g_f_Spm2>=0,
       g_lattice_Spm2>0, formula_version:"sml_reservoir.fullmag.v2"},
     absorption:"full_absorption",
     formula_version:"magnetoelectronic.fullmag.v2"}
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
  formula_version:"slonczewski.fullmag.v2"
}

PrescribedSpinOrbitTorque = PrescribedSotV1 | PrescribedSotLegacyV0

PrescribedSotV1 = {
  schema_version:"prescribed_sot.v1", id, target:RegionRef,
  formula_version:"prescribed_sot.fullmag.v1",
  drive:
    | {kind:"signed_scalar", current_density_Apm2, sigma_hat:UnitVector3,
       envelope:TimeEnvelope?}
    | {kind:"vector_current_source", current_source_id,
       drive_direction:UnitVector3, interface_normal:UnitVector3},
  xi_dl:finite, xi_fl:finite, free_layer_thickness_m>0
}

PrescribedSotLegacyV0 = {
  schema_version:"prescribed_sot.v1", id,
  target:RegionRef|null,
  formula_version:"prescribed_sot.legacy_fullmag.v0",
  drive:
    | {kind:"legacy_scalar_magnitude",
       raw_charge_current_density_Apm2:finite}
    | {kind:"legacy_current_source_norm", current_source_id},
  raw_spin_polarization:Vector3 finite, zero permitted,
  xi_dl:finite, xi_fl:finite, free_layer_thickness_m>0,
  compatibility_origin:{source_ir_version:"0.2.0",
                        authored_kind:"spin_orbit_torque"}
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

`formula_version` is the discriminator and MUST be decoded before validating
the drive. Only `PrescribedSotV1` applies `UnitVector3`, signed-current,
drive-direction, interface-normal, and nonzero-axis validation.
`PrescribedSotLegacyV0` instead preserves the raw finite polarization,
including zero, and the raw signed scalar even though its evaluator applies
`abs`, or preserves a source reference whose evaluator applies `norm(J)`.
Only this migration-only variant permits `target:null`. Here `null` means the
exact historical 0.2 scope: every magnetic target selected by the legacy
global solve. It MUST NOT be interpreted as a default region, the first
magnet, or a planner-selected target. Canonical v1 authoring always requires
an explicit `RegionRef`.
The two drive unions are disjoint; a legacy drive cannot appear with v1 and a
v1 drive cannot appear with legacy v0.

New Python/UI authoring MUST NOT create `PrescribedSotLegacyV0`. It is legal
only as the output of the `0.2.0 -> 0.3.0` migrator and for subsequent lossless
read/export of that canonical `0.3.0` document, proven by the required
`compatibility_origin`. Removing that origin, normalizing raw sigma to a unit
axis, rejecting zero sigma under v1 validation, or converting the legacy drive
to `signed_scalar` during ordinary export is semantic loss and MUST fail the
round-trip gate.

Canonical Python export represents this read-only bridge as
`fm.PrescribedSpinOrbitTorque.from_legacy_v0(...)`, including the raw drive,
raw polarization, and compatibility origin verbatim. The ordinary
`fm.PrescribedSpinOrbitTorque(...)` constructor creates only v1. The classmethod
rejects missing/invalid migration origin and exists solely so exported migrated
scripts execute and lower back to the same legacy tagged node; it is not shown
in UI commands or normal API documentation.

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
    | {kind:"closed_geometry", geometry_ref, volume_mesh_intent}
    | {kind:"external_lead_extension", version,
       closure_current_operator:"fem_closed_current_extension.v1",
       geometry_ref, volume_mesh_intent, parameters}
    | {kind:"analytic_return_path", version, parameters},
  method:"auto"|"analytic_cylinder"|"fdm_fft_cell_integrated"
         |"direct_biot_savart"|"fem_vector_potential",
  refresh:"stage_consistent"|"separable_scale"|"accepted_step_approx",
  solver:OerstedSolverPolicy?,
  requested_execution:RequestedExecution
}
```

```text
OerstedSolverPolicy =
  | {
  kind:"direct_tetra_quadrature",
  engine:"fem_oersted_direct_tetra_cpu_v1",
  quadrature_profile:"fem_tetra_singular_adaptive_fp64.v1",
  relative_tolerance>0,
  absolute_tolerance_Apm>=0,
  maximum_subdivision_depth>0,
  deterministic_accumulation:true
  }
  | {
  kind:"fem_vector_potential",
  engine:"fem_oersted_hcurl_h1_gauge_v1"
         |"fem_oersted_hcurl_h1_gauge_device_v1",
  boundary_gauge_variant:"tangential_A_h1_0.v1"
         |"natural_curl_zero_mean_h1.v1",
  relative_tolerance>0,
  absolute_tolerance_Apm>=0,
  max_iterations>0,
  krylov_restart>0,
  preconditioner:"ams_boomeramg_block.v1",
  gauge_solver:"h1_dirichlet_boomeramg.v1"
         |"h1_zero_mean_boomeramg.v1",
  harmonic_policy:"reject_nontrivial"|"constrained_basis.v1"
  };
```

`OerstedSolverPolicy` is absent for analytic and FFT realizations. The FEM
direct-tetra and vector-potential methods require the matching tagged record
above and use the frozen defaults in 8.4 unless explicitly overridden. The
baseline vector-potential variant is `tangential_A_h1_0.v1`: it means
`A in H_0(curl)` and `p in H^1_0`, and therefore requires
`h1_dirichlet_boomeramg.v1`. The natural-boundary variant uses
`p in H1/R` with an explicit mass-weighted zero-mean constraint and is a
different resolved boundary law. A planner or backend MUST NOT exchange the
two variants or combine the baseline with the zero-mean gauge solver.

General Biot–Savart/Oersted execution without a globally closed circuit model
MUST be rejected. `accepted_step_approx` is a degraded approximation, never a
strict default, and requires a workload-specific temporal-order qualification.
For FEM v1, `closed_geometry` and `external_lead_extension` are volumetrically
meshed sources whose current is represented in the conservative RT0 view. The
extension operator certifies equal/opposite oriented flux at every join and a
closed outer balance. `analytic_return_path` is legal only for OE-F1 as the
separate additive realization `oersted_analytic_return_additive.v1`; it is not
RT0 data and is unsupported for OE-F2 `fem_vector_potential`. The planner MUST
reject any attempt to use an analytic line/return field as an OE-F2 range or
closure certificate.

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

FEM direct-tetra and vector-potential Oersted additionally bind one immutable
resolved data-plane view:

```text
ConservativeCurrentViewRef = {
  schema_version:"fem_conservative_current_view.v1",
  operator_version:"fem_conservative_current_rt0_view.v1",
  source_module_id, source_state_revision, source_field_digest,
  mesh_revision, topology_revision, geometry_digest,
  closure_revision, closure_digest,
  unit:"A/m^2", component_convention:"signed_conventional_xyz",
  fe_space:"RT0_Hdiv_3d", canonical_face_record_count,
  face_record_payload_sha256, canonical_face_digest,
  balance_certificate_digest, view_identity_digest, balance_certificate_ref,
  envelope_revision, envelope_digest, evaluated_envelope_multiplier, evaluation_time_s,
  stage_identity
}
```

The referenced data-plane payload is a canonical stream of globally oriented
face-flux records `(face_key, flux_A)`, independent of MFEM numbering/storage
and distinct from the nodal `J_charge` visualization buffer. The transport
owner creates it by a conservative reconstruction and certifies element
divergence, internal-face normal-flux cancellation, electrode balance and
completed circuit closure.
Any stale revision, digest mismatch, unpaired terminal flux or missing
certificate invalidates the Oersted plan/cache. OE-F1 and OE-F2 consume the
same view and cannot independently evaluate `-sigma grad V`.

The v1 construction request is a resolved runtime object, never authored UI
state. It includes stable `u64` vertex identities, classified boundary faces,
terminal and source-cut constraints, potential/conductivity snapshots,
closure support, source/mesh/topology identities, evaluation time and stage
identity. V1 accepts straight affine tetrahedra only. A nonzero
`closed_geometry` current requires either the same current module's authored
`periodic_potential_drop` or a certified imported closed RT0 field. The closure
object alone never creates a drive. An
`external_lead_extension` is solved together with the device in the same
constrained minimum-dissipation system; sequential extrapolation and terminal
zeroing are invalid closure realizations.
Device and lead stable vertex IDs must be globally disjoint, including at
coincident interface coordinates. Interface pairs therefore contain two
distinct one-sided face keys. The combined resolved mesh uses device vertices
followed by lead vertices and concatenates the corresponding stable-ID vectors
in that order; it must not regenerate IDs from coordinates or merge the two
interface faces.

For a potential-jump source, the charge solve precedes the RT KKT. The
versioned operator `fem_charge_h1_periodic_jump.v1` identifies the paired
periodic trace space, applies an affine lift carrying the authored voltage
jump, solves the remaining periodic unknown with one explicit gauge, and
certifies the paired weak flux. `Cj=d` does not impose a voltage jump; it only
enforces RT terminal/cut/interface flux constraints after that potential solve.
V1 has no independently authored total-current source-cut variant.

Both periodic request and accepted snapshot include
`source_module_id`, `source_state_revision`, `source_field_digest`,
`evaluation_time_s`, `stage_identity`, `envelope_revision`,
`envelope_digest` and the finite evaluated envelope multiplier. The RT request
must match every field exactly; source/time/envelope mismatch is stale input,
not a cache hit.

The frozen unit-cube qualification independently checks the solved P1 field at
all element nodes and volume quadrature points against `V=0.5-x V`, its
physical gradient against `(-1,0,0) V/m`, and each cut-face flux against
`sigma grad(V).n` for `sigma=4 S/m`. It separately assembles
`integral sigma grad(V).grad(phi_i) dV` and combines paired cut-side residual
entries according to the periodic quotient basis. A snapshot residual getter,
trace-only comparison, or paired-flux summary cannot substitute for this weak
residual oracle.

The reconstruction uses `Bj=q` for element divergence and a distinct `Cj=d`
for terminal totals, paired source-cut flux and nonconforming closure-interface
constraints. Pointwise zero insulating traces are eliminated as essential RT
DOFs. A deterministic rank analysis of `[B;C]` removes dependent rows and
records them for independent physical re-evaluation; a singular or
incompatible constraint set fails closed.

Rank analysis is exclusively owned by
`cpu/mfem/transport/conservative_constraint_rank.hpp/.cpp` through
`ConservativeConstraintRank::Analyze(vector<ConservativeConstraintRankRow>,
physical_absolute_gate_a=1e-18,physical_relative_gate=1e-10)`. Each row contains a unique canonical
constraint ID, frozen semantic
`ConservativeConstraintRankRowKind:uint8_t {Generic=1,
ClosedComponentDivergence=2}`, a four-ID closed-component anchor, a four-ID
row element key, strictly
increasing stable `u64` column IDs, equal-length exact
signed-integer incidence coefficients and finite `rhs_a`. The immutable
`ConstraintRankCertificate` exposes `rows_before`, `rank`, and canonically
sorted omitted rows containing ID, `ConstraintOmissionReason`, residual and the
stable four-vertex anchor of a closed component. `Build` and `Import` must use
this owner; an implementation-local floating rank heuristic is forbidden.
Generic rows require all-zero anchor and row-key sentinels. Closed-component
divergence rows require both keys to contain four strictly increasing nonzero
stable vertex IDs with `component_anchor<=row_element_key`. Rows group by
anchor, row keys are unique, and exactly one row per component equals its
anchor. Missing/duplicate candidates, duplicate component row metadata and
unknown row-kind codes reject. Omission classification and anchor propagation
come exclusively from these fields; ID parsing and post-hoc relabeling are
forbidden. Canonical processing places generic and closed non-candidate rows
before unique anchor candidates, then uses canonical ID within each class, so
the physical minimum-anchor divergence candidate is considered last and is
the deterministic omission. Physical B-row construction supplies both keys.
The persisted omission enum
is explicitly `ConstraintOmissionReason:uint8_t
{ClosedComponentDivergenceDependency=1,
ConsistentLinearDependency=2}`.
Canonical rows `r1=[1,0], r2=[0,1], r3=[1,1]` with RHS `(1,1,2)` omit exactly
r3 as `ConsistentLinearDependency`; RHS `(1,1,3)` throws typed
`InconsistentDependentConstraint` naming r3 and residual `1 A`.
Coefficient rank is computed by deterministic fraction-free Bareiss elimination
over `boost::multiprecision::cpp_int`; fixed-width integer arithmetic and
floating rank decisions are forbidden. Caps are `rows<=2^20`, distinct
columns `<=2^20`, total nonzeros `<=2^24`, and nonzeros per row `<=4096`, all
checked before matrix allocation. `ResourceCounts` and mandatory
`ConservativeConstraintRank::ValidateResourceCounts` expose bounded validation
for rows, distinct columns, total/row nonzeros, intermediate nonzeros,
aggregate intermediate storage bits, checked Bareiss work units and maximum
observed intermediate bit length without large fixtures. Excess throws
typed fail-closed `ConstraintRankResourceLimitExceeded`. `Analyze` must call
the seam, use checked counters, stop above `2^24` intermediate nonzeros,
`2^31` aggregate intermediate storage bits, `2^32` Bareiss work units, and stop
when an intermediate `cpp_int` exceeds `2^20` bits. Empty/duplicate IDs, unsorted/duplicate
columns, ID/coefficient length mismatch, zero stored coefficients, nonfinite
RHS and cap overflow reject. Dependency consistency applies the frozen current
gate `abs(residual)<=max(physical_absolute_gate_A,
physical_relative_gate*max(abs(rhs_A),1e-30 A))` and exposes that residual in
typed errors/certificates.
The exact qualification uses `M=4,000,000,000` and
`C=-2,446,744,073,709,551,616` with rows `[M,1]`, `[C,M]` and their
exact sum `[M+C,M+1]`. Independent `cpp_int` arithmetic proves
`M*M-C=2^64`; rank is two and the sum row is omitted. It also includes
separate exactly-formulated inside/outside absolute- and
relative-gate cases with the represented residual persisted.

The reference MPI realization gathers the canonical mesh, coefficients and
constraints, reconstructs in deterministic order on rank zero, then broadcasts
the canonical result. This rule, together with canonical stable identities,
is what makes the v1 binary64 records and digest byte-identical for one and two
ranks. It is not permission to hash partition-local or MFEM numbering. A
scalable distributed realization requires a new versioned deterministic
reduction or quantization policy.

The immutable resolved payload owns its mesh snapshot and RT0 storage. It is
published by atomic replacement only after algebraic convergence and an
independent physical certificate computed from Piola-mapped flux quadrature.
Its internal C++ balance summary additionally exposes
`max_closure_interface_mismatch_a`; this diagnostic is retained in the
canonical balance bytes but is not a new field in the frozen Task 2 C ABI
summary. The immutable view exposes those exact bytes through
`canonical_balance_certificate_bytes()` and reports whether canonical face
records were globally gathered and broadcast through
`canonical_face_flux_records_are_global_and_broadcast()`.
The complete certificate artifact retains per-element, per-face, terminal,
source-cut, interface and outer-boundary diagnostics even when the API summary
contains only maxima and normalized balances.

The canonical C++ API returns only
`ConservativeCurrentView::Ptr = std::shared_ptr<const
ConservativeCurrentView>` from static `Build(request)` and `Import(request)`
factories; constructors are private. `canonical_face_flux_records()` returns
the complete globally sorted, rank-broadcast record vector, never a
partition-local subset. The view deep-owns its mesh, RT collection, space,
field, identity and complete certificate bytes. The current-transport owner
stores that `Ptr`; readers obtain a lifetime-safe snapshot with
`std::atomic_load`, and failed publication preserves the prior accepted owner.
The owner type is exactly `ConservativeCurrentViewOwner`; it exposes
`conservative_charge_current()` for the atomic RT0 pointer,
`charge_current_density()` for the separate nodal visualization field, and
`publish_accepted(Ptr)` for accepted-only replacement. Failed Build, Import or
publish retains the previous pointer; the nodal and RT0 buffers may not alias.
The nodal constructor argument is a non-owning borrow whose mesh, finite-element
space and `GridFunction` outlive the owner. `ConservativeCurrentViewOwner` is
explicitly non-copyable and non-movable. Qualification includes four concurrent
reader threads and one publishing writer alternating two accepted immutable
pointers; readers may observe only either complete pointer, never null/torn
state. The same test is run in a dedicated ThreadSanitizer build
(`-fsanitize=thread -fno-omit-frame-pointer`) and any race report fails OE-T0.
The concrete managed command is
`just verify-fem-oersted-oet0-tsan-cpu-contract`: isolated
`oersted-oet0-tsan` build directory, `FULLMAG_OET0_TSAN=ON`, serial contract
CTest only, no MPI launcher, and
`TSAN_OPTIONS=halt_on_error=1:exitcode=66`. OE-T0 GREEN requires this command
and `just verify-fem-oersted-oet0-cpu-contract`.
TSan configure skips the MFEM MPI probe, explicit `MPI::MPI_CXX` link and MPI
CTest registration, and defines `FULLMAG_OET0_DISABLE_MPI=1`; the source guard
is `MFEM_USE_MPI && !FULLMAG_OET0_DISABLE_MPI`. An MPI-enabled shared MFEM may
still have a transitive MPI dependency, which is distinct from Fullmag MPI code
or launcher execution. When GREEN sources exist, rank, periodic-potential and
view cpp files are added directly to the instrumented test target. Partial
existence is configure-fatal; all three must appear in the target object list
and carry TSan compile flags, never arrive through unsanitized `fullmag_fem`.

`OerstedSource` authoring contains only geometry/meshing intent. It MUST NOT
contain `ConservativeCurrentViewRef`, artifact paths, record counts or digests.
Normalization resolves `current_source_id`; after the exact current-source
revision executes, the planner/runner binds the resulting immutable
`ConservativeCurrentViewRef` and artifact revision on the resolved/data-plane
side. An authored attempt to inject that resolved reference fails validation.

The artifact digest uses `fem_rt0_canonical_face_digest.v1`, not MFEM
true-dof order. Each record is `(canonical global face identity, flux_A)`.
The face identity is the sorted triple of stable mesh-vertex identities and
the canonical normal is derived from the versioned ordered triple; every local
RT sign is converted to that normal. Records are globally sorted and encoded
as canonical little-endian values before hashing. Element/face iteration
order, true-dof renumbering and MPI partition changes MUST NOT alter the
digest. Qualification includes element reorder and MPI partition invariance
tests with identical physical current and geometry.

`face_record_payload_sha256` is SHA-256 of the raw 32-byte records exactly as
stored. Define `LP(x)=u64le(byte_length(x)) || UTF8(x)`. There is exactly one
`canonical_face_digest` preimage:

```text
SHA256(
  LP("fem_rt0_canonical_face_digest.v1") ||
  LP("fem_conservative_current_rt0_view.v1") ||
  LP("stable_vertex_lexicographic_normal.v1") ||
  LP(geometry_digest) ||
  u64le(canonical_face_record_count) ||
  decode_hex_32(face_record_payload_sha256)
)
```

No direct-record or alternative composite preimage is valid. The two hashes
are never aliases.

`view_identity_digest` is
`fem_conservative_current_view_identity_digest.v1`. Its fixed-order preimage is
the schema tag followed by `canonical_face_digest`, source module ID, source
state revision, source field digest, mesh revision, topology revision, geometry
digest, closure revision, closure digest, envelope revision, envelope digest,
evaluated envelope multiplier, evaluation time, stage identity and
`balance_certificate_digest`. Strings use `u64le length || UTF-8 bytes`;
multiplier and time use finite binary64 little-endian with negative zero
normalized; stage uses
`u64le`. `balance_certificate_digest` hashes the exact bytes of the persisted
`fem_conservative_current_balance_certificate.v1` artifact, not an in-memory
reference or only the API summary. Revision-only
changes invalidate the resolved view/cache through `view_identity_digest` while
leaving identical physical record bytes content-addressable under the same two
record digests.

Every SHA-256 field named above is represented at persistence/ABI boundaries as
exactly 64 lowercase ASCII hex characters without `sha256:`. Validation rejects
wrong length, non-hex or uppercase. Composite preimages decode nested hashes to
their 32 raw bytes; they never concatenate a textual spelling.

The canonical binary artifact is
`current_transport/<id>.rt0-face-flux.v1.bin`. It contains no header or padding;
each 32-byte record is `(u64le a,u64le b,u64le c,f64le flux_A)` with
`a<b<c`, and records are lexicographically sorted by `(a,b,c)`. The adjacent
manifest fixes schema/orientation versions, record size/count, byte length,
`face_record_payload_sha256`, `canonical_face_digest`,
`balance_certificate_digest` and `view_identity_digest`, plus the entire
identity tuple: `source_module_id`, `source_state_revision`,
`source_field_digest`, `mesh_revision`, `topology_revision`, `geometry_digest`,
`closure_revision`, `closure_digest`, `envelope_revision`, `envelope_digest`,
`evaluated_envelope_multiplier`, `evaluation_time_s` and `stage_identity`.
It also persists schema/operator/orientation versions and SI/component/FE tags.
Restore checks
`byte_length=32*count`, ordering, finite normalized flux bytes, then recomputes
all four hashes from their frozen preimages before publication.

The complete balance artifact is
`current_transport/<id>.current-balance.v1.bin`. It has no padding and uses
little-endian integers/binary64 with finite values and normalized zero. Its
preimage is, in order:

1. `u64le length || UTF-8` schema
   `fem_conservative_current_balance_certificate.v1`;
2. algebraic rtol, physical relative gate and absolute gate in amperes as
   three binary64 values;
3. `u64le rows_before, u64le rank` from the exact `[B;C]` certificate;
4. four `u64le` counts for element, face, circuit and omitted-constraint rows;
5. element rows sorted by four stable vertex IDs:
   `4*u64le key, f64 residual_A, f64 denominator_A, f64 normalized_residual`;
6. face rows sorted by three stable vertex IDs:
   `3*u64le key, u8 side_count, f64 side1_flux_A, f64 side2_flux_A,
   f64 canonical_jump_A`;
7. circuit rows sorted by `(kind,id,face_key_a,face_key_b)`: `u8 kind`
   (`1=terminal,2=source_cut,3=closure_interface,4=outer_boundary`),
   `u64le id_length || UTF-8 id`, two `3*u64le` face keys (zero key when
   absent), then `f64 flux_A, f64 paired_flux_A, f64 mismatch_A`;
8. omitted-constraint rows sorted by canonical constraint ID:
   `LP(id), u8 reason, 4*u64le closed_component_anchor,
   f64 independently_evaluated_residual_A`, where reason is exactly
   `1=ClosedComponentDivergenceDependency` or
   `2=ConsistentLinearDependency`. Reason 1 requires four strictly increasing
   nonzero stable tetrahedron IDs, an exact matching element row, ID
   `divergence:<v0>:<v1>:<v2>:<v3>`, and the exact residual of that element
   row; reason 2 requires the all-zero anchor sentinel;
9. summary values `max_element_divergence_A`, `max_internal_face_jump_A`,
   `net_outer_flux_A`, `electrode_balance_relative` as four binary64 values,
   followed by `u8 closure_complete` restricted to `0|1`.

`balance_certificate_digest=SHA256(these exact bytes)`. Restore validates
ordering, counts, keys, finite values, normalized zero, summary recomputation
and digest before accepting the certificate. The digest covers rank dimensions,
reason codes, anchors and residuals; because its decoded 32 bytes participate
in `view_identity_digest`, rank persistence is also transitively identity-bound.

`side_count` is exactly `1|2`. For `2`, side 1 and side 2 are ordered by the
lexicographic stable adjacent-element key (four sorted stable vertex IDs). For
`1`, `side2_flux_A` is the positive-zero binary64 sentinel. Circuit `kind` is
restricted to `1..4`. Kinds `2` and `3` require two nonzero face keys and a
real paired flux. Kinds `1` and `4` require the absent second key `(0,0,0)` and
`paired_flux_A=+0.0`; stable vertex ID zero is reserved. Every zero sentinel,
including an exact zero mismatch, uses positive-zero bits. Counts are each
bounded by `2^31-1`, IDs by 4096 UTF-8 bytes, and checked total bytes by
`2^63-1`. Unknown enums, invalid counts, overflow, non-strict ordering, and
duplicate element/face/circuit/omitted-constraint keys fail before allocation
or publication.

Qualification independently decodes these bytes and reconstructs every row
from field quadrature, classified boundary roles and closure pairs. It must
match outer, source-cut, electrode and closure-interface fluxes, omitted rows,
gates, ordering, summary and `closure_complete`; verifying only the SHA-256 is
insufficient. Import rejects any mismatch between the decoded/recomputed
summary and `fullmag_fem_current_balance_certificate_v1`. Export derives that
struct only from the same decoded canonical bytes and never from a second
summary calculation. The decoder first freezes
`boundary_element -> stable face key -> (role,circuit_id)`, requires all
circuit faces to have `side_count=1`, matches kinds 2/3 to the exact authored
ordered source-cut/lead-interface pairs, and requires the decoded terminal and
outer-boundary key sets to be complete. It validates the `2^31-1` family caps
before reserve/iteration and accepts only at most 4096-byte, shortest-form
UTF-8 IDs without NUL, surrogate, overlong or out-of-range encodings.
Omitted rows are variable, not fixed to one. Qualification imports uniform
`J=(4,0,0) A/m^2` on two disconnected periodic cubes (second shifted in y)
with disjoint stable IDs and unique cuts. An independent exact integer
oracle explicitly materializes free canonical RT0 face columns after
insulating-outer elimination, signed element/outward-face divergence rows B,
and authored source-cut pair rows C, then runs `cpp_int` Bareiss on the real
`D=[B;C]`. It proves B alone is full row rank, D has nullity two, and removing
the exact minimum-anchor divergence row of each component makes reduced D full
row rank. Acceptance requires
`rows_before-rank=2` and exactly two omitted divergence rows, one per stable
component anchor, reason `ClosedComponentDivergenceDependency`, and residual
`<=1e-12 A`. A duplicated physical cut is only a multiple-pairing rejection,
not evidence for rank analysis.

The C ABI has separate directions. Rust-to-native OE import uses const
pointer+length descriptors and deep-copies all accepted record, tag and
certificate bytes during the call. It recomputes all four digests before
publication. Neither direction returns an MFEM/native object pointer.

Native-to-Rust export uses the following exact mutable-buffer and output ABI;
all reserved fields must be zero. For `mut_bytes`, `capacity`, `required_len`
and `written_len` are byte counts. For `mut_u64` and `mut_f64` they are element
counts, never bytes. All count-to-byte conversions use checked multiplication
before pointer validation, allocation or copy:

```c
typedef struct fullmag_fem_current_balance_certificate_v1 {
    double max_element_divergence_a;
    double max_internal_face_jump_a;
    double net_outer_flux_a;
    double electrode_balance_relative;
    uint32_t closure_complete;
    uint32_t reserved_zero;
} fullmag_fem_current_balance_certificate_v1;

typedef struct fullmag_fem_mut_bytes_buffer_v1 {
    uint8_t *data;
    uint64_t capacity;
    uint64_t required_len;
    uint64_t written_len;
} fullmag_fem_mut_bytes_buffer_v1;

typedef struct fullmag_fem_mut_u64_buffer_v1 {
    uint64_t *data;
    uint64_t capacity;
    uint64_t required_len;
    uint64_t written_len;
} fullmag_fem_mut_u64_buffer_v1;

typedef struct fullmag_fem_mut_f64_buffer_v1 {
    double *data;
    uint64_t capacity;
    uint64_t required_len;
    uint64_t written_len;
} fullmag_fem_mut_f64_buffer_v1;

typedef struct fullmag_fem_conservative_current_view_output_v1 {
    uint32_t abi_version;
    uint32_t struct_version;
    uint64_t struct_size;
    fullmag_fem_mut_u64_buffer_v1 canonical_face_vertex_ids;
    fullmag_fem_mut_f64_buffer_v1 canonical_face_flux_a;
    fullmag_fem_mut_bytes_buffer_v1 schema_id;
    fullmag_fem_mut_bytes_buffer_v1 operator_version;
    fullmag_fem_mut_bytes_buffer_v1 source_module_id;
    fullmag_fem_mut_bytes_buffer_v1 source_state_revision;
    fullmag_fem_mut_bytes_buffer_v1 source_field_digest;
    fullmag_fem_mut_bytes_buffer_v1 mesh_revision;
    fullmag_fem_mut_bytes_buffer_v1 topology_revision;
    fullmag_fem_mut_bytes_buffer_v1 geometry_digest;
    fullmag_fem_mut_bytes_buffer_v1 closure_revision;
    fullmag_fem_mut_bytes_buffer_v1 closure_digest;
    fullmag_fem_mut_bytes_buffer_v1 face_record_payload_sha256;
    fullmag_fem_mut_bytes_buffer_v1 canonical_face_digest;
    fullmag_fem_mut_bytes_buffer_v1 balance_certificate_digest;
    fullmag_fem_mut_bytes_buffer_v1 view_identity_digest;
    fullmag_fem_mut_bytes_buffer_v1 envelope_revision;
    fullmag_fem_mut_bytes_buffer_v1 envelope_digest;
    fullmag_fem_mut_bytes_buffer_v1 si_unit;
    fullmag_fem_mut_bytes_buffer_v1 component_convention;
    fullmag_fem_mut_bytes_buffer_v1 fe_space;
    fullmag_fem_mut_bytes_buffer_v1 balance_certificate_bytes;
    fullmag_fem_current_balance_certificate_v1 balance_certificate;
    double evaluated_envelope_multiplier;
    double evaluation_time_s;
    uint64_t stage_identity;
    uint64_t canonical_face_record_count;
    uint64_t accepted_generation;
    uint64_t reserved_zero[4];
} fullmag_fem_conservative_current_view_output_v1;
```

The export function takes an explicit `uint64_t retry_accepted_generation`
immediately before the output descriptor. Zero requests a new solve; nonzero
requests export of exactly that retained generation and never authorizes a
solve. The export protocol is transactional. After an accepted solve is atomically
retained by the transport owner, the adapter computes every required length in
checked arithmetic. If any capacity is short it returns
`FULLMAG_FEM_BUFFER_TOO_SMALL`, atomically publishes all `required_len` values,
sets every `written_len=0`, performs zero payload writes, and publishes
`accepted_generation` as the only result scalar. Every other scalar/result
field and the steady result remains untouched. The caller retries with
the same request identity and that token; the adapter exports the
retained `std::atomic_load` snapshot and MUST NOT re-solve. If generation or
identity changed it returns stale-result instead of exporting a different
view. Only when every capacity is sufficient does one commit copy all payloads,
set every `written_len`, and publish all scalar/result fields. Validation,
overflow, or copy failure likewise produces no partial output.

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

The canonical public selection is `LLG(integrator="coupled_imex_ark2")`.
`SpinSolverPolicy.engine` selects the spatial transport solve and never the
coupled time integrator. Adaptive execution uses the versioned full-step versus
two-half-step estimator; the BDF2 small oracle is validation-only and is not a
production authoring choice.

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

### 8.1 Normative identifier registry

This table is the single registry for PR-00 identifiers. A formula defines
continuum algebra/signs, an operator defines a discretization or time
integration map, a realization selects a physical/numerical strategy, and an
engine names executable code. An identifier MUST NOT be reused in another
category.

| Category | Canonical identifiers |
|---|---|
| formula | `gilbert_transform.fullmag.v1`; `zhang_li.fullmag.v1`; `zhang_li.legacy_fullmag.v0`; `slonczewski.fullmag.v2`; `slonczewski.fullmag.v1` (read-only provenance); `prescribed_sot.fullmag.v1`; `prescribed_sot.legacy_fullmag.v0`; `transport_constitutive.one_way.fullmag.v1`; `transport_constitutive.reciprocal.fullmag.v1`; `conductivity_tensor_3d.fullmag.v1`; `magnetoelectronic.fullmag.v2`; `sml_reservoir.fullmag.v2`; `dos_isotropic_nonmagnetic.fullmag.v1`; `transport_absorption.fullmag.v1`; `current_transport.fullmag.v1`; `current_transport.prescribed_density.legacy_fullmag.v0` |
| operator | `zl_upwind_first_order_v1`; `zl_central_reference_v1`; `fv_charge_harmonic_v1`; `fv_charge_mixing_series_trace.v1`; `fv_spin_upwind_v1`; `fv_spin_central_reference_v1`; `structured_cross_gradient_v1`; `fdm_exact_face_current_electric_reconstruction.v1`; `fdm_transport_torque_cell_surface_balance.v1`; `fdm_face_to_cell_current.v1`; `fdm_oersted_cell_integrated_open.v1`; `fem_charge_spin_broken_h1_mortar.v1`; `fem_conservative_current_rt0_view.v1`; `fem_closed_current_extension.v1`; `fem_oersted_direct_tetra_quadrature.v1`; `fem_oersted_hcurl_h1_gauge.v1`; `fem_oersted_hcurl_h1_zero_mean_natural.v1`; `coupled_imex_ark2.v1`; `coupled_bdf2_small_oracle.v1` |
| realization | `slonczewski_thin_layer_homogenized.v1`; `slonczewski_interface_flux.v1`; `oersted_analytic_cylinder.v1`; `oersted_direct_biot_savart.v1`; `oersted_analytic_return_additive.v1`; `oersted_fdm_fft_open.v1`; `oersted_fem_vector_potential.v1` |
| engine | `fdm_charge_cg_matrix_free_v1`; `fdm_charge_cg_cuda_v1`; `fdm_spin_block_gmres_matrix_free_reference_v1`; `fdm_spin_block_gmres_csr_v1`; `fdm_spin_block_gmres_cuda_v1`; `fdm_charge_spin_block_gmres_v1`; `fdm_charge_spin_block_gmres_cuda_v1`; `fem_charge_h1_hypre_v1`; `fem_charge_h1_hypre_device_v1`; `fem_spin_broken_h1_mortar_v1`; `fem_spin_broken_h1_mortar_device_v1`; `fem_charge_spin_block_gmres_v1`; `fem_charge_spin_block_gmres_device_v1`; `fdm_oersted_fft_open_v1`; `fdm_oersted_cufft_open_v1`; `fem_oersted_direct_tetra_cpu_v1`; `fem_oersted_hcurl_h1_gauge_v1`; `fem_oersted_hcurl_h1_gauge_device_v1` |
| residual | `charge_balance_integrated_l2.v1`; `transport_balance_integrated_l2.v1`; `transport_balance_local_fv.v1` |

Every resolved plan names all applicable IDs by their category. For example,
FDM Oersted uses operator `fdm_oersted_cell_integrated_open.v1`, realization
`oersted_fdm_fft_open.v1`, and engine `fdm_oersted_fft_open_v1` or
`fdm_oersted_cufft_open_v1`; FEM Oersted uses operator
`fem_oersted_hcurl_h1_gauge.v1`, realization
`oersted_fem_vector_potential.v1`, and a correspondingly suffixed engine.
FEM direct quadrature uses operator
`fem_oersted_direct_tetra_quadrature.v1`, realization
`oersted_direct_biot_savart.v1`, and engine
`fem_oersted_direct_tetra_cpu_v1`. Both FEM methods require
`fem_conservative_current_rt0_view.v1`; that prerequisite is not itself an
Oersted realization.

`fdm_spin_block_gmres_matrix_free_reference_v1` is restricted to the bounded
native FDM CPU/FP64 one-way M1 owner. It denotes restarted matrix-free GMRES
without AMG/ILU and MUST NOT be reported as
`fdm_spin_block_gmres_csr_v1`. Its electric reconstruction and torque mapping
are the separate operators
`fdm_exact_face_current_electric_reconstruction.v1` and
`fdm_transport_torque_cell_surface_balance.v1`. Full one-way mixing uses the
charge-interface trace elimination `fv_charge_mixing_series_trace.v1`.
That interface operator composes with, and never replaces, the bulk
`fv_charge_harmonic_v1` face-flux operator. Charge acceptance reports
`charge_balance_integrated_l2.v1`; spin acceptance reports
`transport_balance_integrated_l2.v1` and the additional local gate
`transport_balance_local_fv.v1`.

`current_transport.prescribed_density.legacy_fullmag.v0` identifies only the
existing bounded prescribed-density source bridge used by analytic-cylinder
and midpoint Biot-Savart slices. It does not prove canonical
`current_transport.fullmag.v1` continuity, global circuit closure,
stage-consistent coupling, `oersted_fdm_fft_open.v1`, or
`oersted_fem_vector_potential.v1` conformance.

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

Charge linear policies use
`physical_residual_norm_version="charge_balance_integrated_l2.v1"`; spin
linear policies use
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
| M1 spin bounded native reference | FDM CPU/double | `fdm_spin_block_gmres_matrix_free_reference_v1` | restarted matrix-free GMRES; no preconditioner | `40` / `2000` | FP64; bounded owner only, not production/HPC |
| M1 spin | FDM GPU/double | `fdm_spin_block_gmres_cuda_v1` | device GMRES + component AMG/block-Jacobi | `50` / `1000` | FP64 |
| M1 spin | FDM GPU/single | `fdm_spin_block_gmres_cuda_v1` | device GMRES + component AMG/block-Jacobi | `50` / `1000` | FP32, qualified workloads only |
| M1 spin | FEM CPU/double | `fem_spin_broken_h1_mortar_v1` | hypre GMRES + field-split BoomerAMG/interface Jacobi | `50` / `1000` | FP64 |
| M1 spin | FEM GPU/double | `fem_spin_broken_h1_mortar_device_v1` | device hypre GMRES + device field-split AMG/interface Jacobi | `50` / `1000` | FP64 |
| M1 Oersted | FDM CPU/double | `fdm_oersted_fft_open_v1` | FFT; no Krylov/preconditioner | n/a | kernel/direct-oracle gates |
| M1 Oersted | FDM GPU/double | `fdm_oersted_cufft_open_v1` | cuFFT; no Krylov/preconditioner | n/a | FP64 parity gates |
| M1 Oersted | FDM GPU/single | `fdm_oersted_cufft_open_v1` | cuFFT; no Krylov/preconditioner | n/a | qualified FP32 parity gates only |
| M1 Oersted direct oracle | FEM CPU/double | `fem_oersted_direct_tetra_cpu_v1` | deterministic adaptive tetra/Duffy quadrature; no Krylov | bounded subdivision | direct singular/near/far quadrature and RT0 source gates |
| M1 Oersted | FEM CPU/double | `fem_oersted_hcurl_h1_gauge_v1` | block GMRES + AMS(`A`)/BoomerAMG(`p`) | `100` / `2000` | algebraic `1e-10`; v2 first-block/constraint/weak-Ampere `1e-8`, compatible divergence `1e-12` |
| M1 Oersted | FEM GPU/double | `fem_oersted_hcurl_h1_gauge_device_v1` | device block GMRES + device AMS/BoomerAMG | `100` / `2000` | semantic profile only; no executable claim in this publication |
| M2 coupled | FDM CPU/double | `fdm_charge_spin_block_gmres_v1` | FGMRES + charge-AMG/spin-MG-ILU field split | `50` / `1500` | FP64 |
| M2 coupled | FDM GPU/double | `fdm_charge_spin_block_gmres_cuda_v1` | device FGMRES + device charge/spin AMG field split | `50` / `1500` | FP64 |
| M2 coupled | FEM CPU/double | `fem_charge_spin_block_gmres_v1` | hypre FGMRES + BoomerAMG field split/interface Jacobi | `50` / `1500` | FP64 |
| M2 coupled | FEM GPU/double | `fem_charge_spin_block_gmres_device_v1` | device hypre FGMRES + device AMG field split/interface Jacobi | `50` / `1500` | FP64 |

Realizacja FDM GPU/FP64 M1 charge używa deterministycznej agregacji geometrycznej
`2 x 2 x 2`. Przypisanie agregatów, budowa dokładnego operatora Galerkina
`A_c = R A P`, walidacja unikalności kanonicznych ścian oraz restrykcja mają
koszt liniowy względem liczby komórek lub ścian. Operator coarse ma
ustrukturyzowany stencil i stały koszt dostępu do sąsiadów; zabronione są
skany wszystkich komórek per aggregate, liniowe wyszukiwanie duplikatów
krawędzi coarse oraz skany wcześniejszych ścian per boundary face. Hierarchia,
jej digest, cache identity, telemetry i checkpoint pozostają deterministyczne,
device-resident i FP64.

Dedykowany managed gate
`just verify-fdm-gpu-m1-charge-scalability-contract` wykonuje publiczny solve
`1024 x 128 x 8 = 1 048 576` komórek na rzeczywistym GPU. Pomiar referencyjny
z 2026-08-10 na RTX 4080 SUPER wyniósł `0.078187 s` dla uploadu/walidacji oraz
`16.456555 s` dla solve przy `254` iteracjach, `131072` coarse DOF i zerowym
host fallback. Jest to zarejestrowana baza regresyjna, a nie arbitralny limit
promocji: wiążący limit czasowy zostanie dodany dopiero po zebraniu wyników na
reprezentatywnej macierzy urządzeń i obciążeń.
| M3 IMEX | FDM CPU/double | `coupled_imex_ark2.v1` + `fdm_charge_spin_block_gmres_v1` | M2 CPU implicit-stage preconditioner | `50` / `1500` per implicit stage | FP64 |
| M3 IMEX | FDM GPU/double | `coupled_imex_ark2.v1` + `fdm_charge_spin_block_gmres_cuda_v1` | M2 device implicit-stage preconditioner | `50` / `1500` per implicit stage | FP64 |
| M3 IMEX | FEM CPU/double | `coupled_imex_ark2.v1` + `fem_charge_spin_block_gmres_v1` | M2 CPU implicit-stage preconditioner | `50` / `1500` per implicit stage | FP64 |
| M3 IMEX | FEM GPU/double | `coupled_imex_ark2.v1` + `fem_charge_spin_block_gmres_device_v1` | M2 device implicit-stage preconditioner | `50` / `1500` per implicit stage | FP64 |
| M3 oracle | CPU double | `coupled_bdf2_small_oracle.v1` | sparse direct when `dofs<=20000`, otherwise M2 FGMRES | n/a or `50` / `2000` | FP64 |

FEM single, all M2 single, and all M3 single are unsupported in v1 until a
new qualification entry supplies an error budget; `auto` cannot select them.
Oersted FFT qualification additionally enforces direct cell-integrated
Biot–Savart parity. FEM OE-F2 separately enforces the mixed block equations,
the weak Ampere residual, compatible de Rham divergence, source range, and
airbox convergence. None is inferred by differentiating the nodal LLG/display
projection.

FEM Oersted uses `oersted_maxwell_residual.v2`. With free-edge coefficient
vector `a`, Dirichlet-`H1` multiplier coefficients `p`, first-block matrix
`C`, coupling `B`, RT0 source load `f`, AMS-compatible SPD edge
preconditioner `P_A`, and Schur approximation
`P_p=B^T P_A^-1 B`, define:

```text
r_A = C a + B p - f
r_p = B^T a
rho_first = sqrt(r_A^T P_A^-1 r_A) /
            max(sqrt(f^T P_A^-1 f), epsilon_block)
rho_constraint = sqrt(r_p^T P_p^-1 r_p) /
                 max(sqrt(a^T P_A a), epsilon_block)
```

These are preconditioner-scaled dual residuals of the actual discrete saddle
system. `epsilon_block` and the exact application of `P_A^-1/P_p^-1` belong to
the versioned profile and are published. The implementation must report the
unscaled absolute dual norms too. A pointwise or recovered `||div A||` is not a
valid gauge residual for an `H(curl)` unknown and MUST NOT be used for
acceptance.

The physical/source checks remain distinct:

```text
r_ampere_i = (mu0^-1 curl A, curl w_i) - (J_RT0, w_i)
rho_ampere_weak = ||r_ampere||_(P_A^-1) /
                  max(||f||_(P_A^-1), epsilon_block)
b = Curl_ND_to_RT a
rho_div_compatible = ||D_RT_to_L2 b||_M_L2 /
                     max(||b||_M_RT/L_ref, epsilon_de_rham)
```

`rho_ampere_weak` is the weak Ampere residual without the gauge-multiplier
term and therefore also exposes incompatible current/range contamination.
The compatible RT0 `B_oe=curl A` is `b`; its incidence divergence is measured
before division by `mu0`. The separately mass-projected nodal `H_oe` is used by
LLG and visualization only and MUST NOT be reused for either residual.

For the baseline `tangential_A_h1_0.v1`, the discrete scalar space is exactly
`H^1_0`; no zero-mean residual or pinned scalar dof is accepted as equivalent.
For `natural_curl_zero_mean_h1.v1`, diagnostics additionally publish the
mass-weighted mean of `p`. Both publish the topology certificate and harmonic
constraint count. Direct quadrature publishes componentwise embedded-rule
error, maximum subdivision depth reached and unconverged-pair count; any
unconverged pair fails strict execution.

`L_ref` is the conductor-plus-airbox bounding-box diagonal recorded in the
plan. The FP64 starting gates are `rho_first<=1e-8`,
`rho_constraint<=1e-8`, `rho_ampere_weak<=1e-8`, and
`rho_div_compatible<=1e-12`; all are reported independently. These numerical
starting gates do not replace mesh/airbox/direct-oracle convergence. FDM FFT
keeps its separately versioned qualified-interior stencil diagnostics and is
not redefined by this FEM residual contract.

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

For a conservative-current child, the manifest additionally carries the full
immutable identity tuple without abbreviation: source module/state/field,
mesh/topology/geometry, closure revision/digest, envelope revision/digest,
evaluated envelope multiplier, evaluation time, stage identity,
`face_record_payload_sha256`, `canonical_face_digest`,
`balance_certificate_digest`, and `view_identity_digest`, together with the
schema/operator/orientation, record envelope, and SI/component/FE tags.

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

### 11.1 Authoring validation and Control Room projections

Transport authoring uses one versioned, non-mutating validation transaction:

```text
POST /v2/sessions/current/model/transport-validation
```

The request identifies the current, spin, interface, torque, or Oersted
candidate operation and carries `base_revision`. The handler clones the current
`SceneDocument`, applies the candidate to the clone, and invokes the canonical
`validate_scene_document` path without committing or advancing any revision.
The response separates semantic validity (`valid`, stable issue codes and
paths) from execution capability (`status`, reason, requested lane, optional
resolved lane, and qualification). React MUST NOT duplicate the SceneDocument
or ProblemIR validator. Create and Replace remain disabled until the latest
candidate response is semantically valid and its authoring capability permits
the operation.

`status.capabilities.transport_authoring` is a bounded typed summary and the
only active-session gating source. It distinguishes M1 one-way steady
authoring from reciprocal M2, transient M3, GPU, single-precision, and hybrid
requests. A source-visible or semantic-only record may remain inspectable, but
an unsupported authoring combination is read-only and carries its reason.
Requested intent is always shown; a missing resolved lane is displayed as
unresolved, never inferred from the requested lane.

`GET /v2/sessions/current/model/spin-interfaces` is a typed, revisioned
projection of interfaces nested in `spin_transports`. Each item includes its
own interface payload and the owning spin-transport identity. Interface edits
validate and PATCH the complete owner transport; the projection is not an
independent store. Current Transport, Spin Transport, Spin Interfaces, Spin
Torques, and Oersted Fields each have a dedicated Explorer identity and typed
Inspector. Unknown records and unknown variants remain lossless and read-only.

Browser proof is split deliberately. A deterministic contract CDP smoke runs
the exact Control Room build and proves CRUD payloads, canonical export request,
run-command request, result navigation, capability states, and cleanup against
a stateful contract server; it does not claim that physics ran. A separate
managed-runtime gate requires a real runtime, checks command completion and a
published result, and fails nonzero when that runtime or evidence is absent.

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
exactly by the executable FDM behavior at the `0.2.0` boundary.

The normalized node is the `PrescribedSotLegacyV0` tagged variant from 3.5.
Because the 0.2 entry has neither `id` nor `target`, migration assigns
`id="legacy_prescribed_sot_<index>"`, where `<index>` is its zero-based
position in `spin_torque_modules`, and writes `target:null`. The combination
of that deterministic id, the explicit legacy-global null target, raw
drive/polarization and `compatibility_origin` is lossless. Duplicate generated
ids, an authored 0.3 null target, or null without the exact migration origin
fail validation.
Its legacy scalar drive stores the original signed scalar in
`raw_charge_current_density_Apm2`; evaluation alone takes `abs`. Its source
drive stores the source id and evaluation alone takes `norm(J_charge)`. Its
`raw_spin_polarization` is not a `UnitVector3` and is not subjected to v1 axis
validation.

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

(fdm-gpu-m1-abi-v1)=
### 13.4 Append-only FDM GPU M1 ABI and bounded charge implementation

Ten podrozdział pozostaje normatywnym kontraktem ABI PR-15. Header, C11/Rust
mirror oraz ograniczona realizacja CUDA charge-only istnieją, dlatego agregat
FDM GPU M1 ma `implementation_state=partial`. Nie istnieją jeszcze CUDA steady
spin/direct-SHE, mixing ani torque. Publiczny planner/runner wywołuje ten ABI
wyłącznie dla osobno opisanej, bounded `CurrentTransport` charge-only ścieżki
FDM/CUDA/FP64/strict; pozostałe moduły nadal nie mają publicznego wywołania.
Ogólna capability pozostaje `semantic_only`, `validation_state=unvalidated`,
z `validated_workloads=[]`; managed actual-device contract proof nie jest
kwalifikacją ani promocją ogólnej ścieżki.

W tej bounded ścieżce planner i runner dopuszczają dwa, rozłączne profile
ładunkowe. Profil Dirichleta wymaga dokładnie dwóch przeciwnych powierzchni
`Voltage`, czterech `Insulating` i
`gauge_policy=boundary_reference_per_component`. Profil czysto Neumanna wymaga
`gauge_policy=zero_mean_per_free_component`, dokładnie dwóch przeciwnych
powierzchni `NormalCurrentElectrode` o tym samym module gęstości
`n·J_charge` i przeciwnym całkowitym strumieniu przez pełne powierzchnie
siatki, oraz czterech `Insulating`. Runner rekonstruuje dokładnie
`2*(ny*nz + nx*nz + nx*ny)` zewnętrznych records i weryfikuje ich pełne
pokrycie bez duplikatów, canonical geometry oraz komórkę sąsiednią. Dla
skończonych $I_f=A_fJ_{n,f}$ preflight i native owner stosują
`abs(sum(I_f)) <= 64 * f64::EPSILON * sum(abs(I_f))`; przy zerowej skali
wyłącznie dokładny zerowy strumień jest legalny. Profile mieszane,
niezbilansowane, o różnych osiach lub z niezgodną gauge są odrzucane przed
wywołaniem ABI. Nie wynika z tego obsługa częściowych elektrod, masek, domen
nieprostokątnych ani ogólnego Neumanna; rozszerzenie wymaga osobnej
specyfikacji i kwalifikacji.

The ABI is separate from `fullmag_fdm_cpu_*` and from the LLG `Context`. It
uses two opaque, non-interchangeable **handle types** whose names cannot also
name a public descriptor or information record:

```text
fullmag_fdm_gpu_transport_context_handle_v1
fullmag_fdm_gpu_charge_snapshot_handle_v1
```

The context owns one CUDA device, stream/events, allocator/pool, immutable
static descriptor, charge/spin solver state, persistent Krylov workspaces,
telemetry, and snapshot generations. The snapshot owns or retains the exact
device-resident accepted charge state and cannot outlive its context.

Each handle is a fixed by-value capability token with four unsigned 64-bit
words named `registry_cookie`, `slot`, `generation`, and `type_tag`. The fields
are ABI-visible for copying but semantically opaque: callers may compare or
zero-initialize the whole token and must not manufacture or edit individual
words. A token is never a pointer and is never serialized. Context and
snapshot handles have distinct C struct types and distinct constant
`type_tag` values, so C and Rust FFI reject accidental interchange.

One process-local registry owns a bounded slot table. Create chooses an empty
or retired slot, increments its monotonic generation, assigns the registry
cookie and type tag, and publishes the token only after initialization
succeeds. Destroy atomically changes `active` to a retired tombstone while
retaining the token tuple. Repeating destroy on that retired tuple returns
`already_destroyed`; using the tuple for another operation returns
`stale_snapshot` or `invalid_state` according to its type. If a slot has since
been reused, the old generation is stale. A generation exhaustion event never wraps:
the slot is permanently retired and create returns `out_of_resources` when no
fresh slot remains. Context destroy with live snapshots returns
`live_snapshot` and leaves the context active. This registry/tombstone rule
makes stale use and double destroy safe without dereferencing freed memory.

Every public request, result, descriptor, view, and telemetry record starts
with this exact self-description:

The ordered common fields are `abi_version, struct_version, struct_size,
reserved_flags`, followed by the feature word and reserved word shown below.

```text
0:abi_version:u32
4:struct_version:u32
8:struct_size:u32
12:reserved_flags:u32
16:required_features:u64
24:reserved0:u64
COMMON_PREFIX_SIZE=32
COMMON_PREFIX_ALIGNMENT=8
KNOWN_GLOBAL_FEATURES_V1=0x000000000000007f
```

All ABI integers are exact-width two's-complement or unsigned values from
`stdint.h`; all floating values are IEEE-754 binary64. Every enum occupies
`u32`. Every record is `alignas(8)`, uses the offsets below, contains no
implicit padding, and zeroes every explicit `reserved*` byte. The ABI is
little-endian v1; a big-endian host returns `incompatible_abi`. `handle32`
means four consecutive `u64` words in the order
`registry_cookie,slot,generation,type_tag`. `u8[16]` and `u8[32]` have byte
alignment one and do not change the next published offset.

Feature bits are fixed: bit 0 strict residency, bit 1 deterministic
reductions, bit 2 M1 charge, bit 3 steady spin, bit 4 mixing v2, bit 5
checkpoint v1, and bit 6 artifact readback. `required_features` is therefore
inside every `MIN_SIZE_V1`, always at byte 16. A set bit outside the record's
`KNOWN_FEATURES_V1` is rejected before any tail field is read.

For v1, `abi_version=1`, `struct_version=1`, all `reserved_flags=0`, and every
reserved byte/pointer is zero. Each generated record defines a named
`MIN_SIZE_V1`; a caller must pass `struct_size>=MIN_SIZE_V1`. Adding optional
tail fields keeps the same struct_version. A struct_version increases only
when that record gains a new required field or changes semantics. The callee
reads only fields fully covered by `struct_size`, zero-defaults an absent
optional v1 tail, and never writes beyond a result's advertised size.

The negotiation table is normative:

| Caller record | Callee support | Result |
|---|---|---|
| `abi_version=1`, `struct_version=1`, `struct_size=MIN_SIZE_V1` | v1 | accept; absent optional tail has frozen zero/default meaning |
| same struct_version and `struct_size>MIN_SIZE_V1` | v1 | accept only when every set `required_features` bit is known; ignore unknown optional tail bytes |
| `struct_size<MIN_SIZE_V1` | any | `incompatible_abi` before field access |
| `abi_version!=1` | v1 | `incompatible_abi`; major ABI never guesses compatibility |
| unknown struct_version | v1 | `incompatible_abi`; an append-only tail must not increment the version |
| known newer struct version | newer callee with an explicit per-record minimum-size table | accept only against that version's minimum and feature mask |
| any unknown set `required_features` bit | any | `unsupported_required_feature`; no partial execution |
| nonzero reserved flags/bytes | any | `invalid_descriptor` before allocation or pointer access |

Thus an old callee may accept a larger record only at the same struct_version;
it never accepts an unknown struct_version. A new callee accepts an old v1
caller only if the operation does not require a missing later-version field.
Arithmetic overflow in counts or strides also fails before allocation or
pointer dereference.

#### Pointer spaces, layouts, and ownership

Every buffer view carries element type, count, byte stride, component order,
and one of the closed pointer-space values:

```text
host_read_only
host_write_only
device_read_only
device_write_only
```

There is no ambiguous `auto`/unified pointer space in v1. Static descriptors
and exact face lists enter as `host_read_only` during the explicit upload
transaction and are copied once into context-owned device storage. `m_stage`
and the torque destination are `device_read_only` and `device_write_only` on
the context device. Charge and spin fields are exposed only as opaque snapshot
or artifact views; callers cannot forge device ownership by casting a host
pointer. The ABI validates device ordinal, pointer attributes, alignment,
count, stride, shape product, aliasing rules, and context identity.

The frozen FP64 layouts are x-fastest SoA: `V[N]`,
`Jx[(nx+1)ny nz]`, `Jy[nx(ny+1)nz]`, `Jz[nx ny(nz+1)]`, three spin-potential
arrays, three-vector face-spin arrays per flow axis, and three torque arrays.
Public tensor artifacts remain `row_major_Q_ia`; internal SoA does not change
that order. A `canonical_face_index` is local to its flux axis: the same
numeric index may occur once in each of the `Jx`, `Jy`, and `Jz` streams and is
identified by the pair `(axis, canonical_face_index)`. It is not a single
globally offset index across the three streams. Every size is derived with
checked integer arithmetic. Misaligned,
undersized, overlapping where forbidden, wrong-device, or wrong-space views
return `invalid_descriptor`.

`transport_observations` (artifact field 7) is the sole typed observation
stream and does not extend the closed artifact-field registry. It is a
range-bounded array of 288-byte `spin_observation_record_v1` values with
`raw_bytes/scalar` destination metadata. Its closed kind registry is
`0 invalid`, `1 reaction`, `2 torque`, `3 interface`. Reaction records carry
`R_sf/R_J/R_phi` in lanes 0--2 with units `A/m^3`; torque records carry
volume/surface/total torque in lanes 0--2 with units `1/s`; interface records
carry incoming, backflow, absorbed, negative one-sided, positive one-sided and
SML flux in lanes 0--5 with units `A/m^2`. Every lane is ordered `xyz`; unused
lanes and metadata are exact zero. Stream order is increasing-cell reaction,
increasing-cell torque, then interfaces sorted lexicographically by
`(source_id,topology_id,axis,canonical_face_index,negative_cell,positive_cell,
from_cell,to_cell)`. Unknown kinds and non-canonical destination metadata fail
closed. Artifact field 5 remains the final total-torque SoA.
Interface records also carry the accepted oriented charge `from`, `to`, and
`delta` traces used by the M1 law; those fields are exact zero for cell records.

#### Frozen v1 records

##### Typed steady-spin payload records outside the manifest

The 18-record operation manifest is closed and unchanged. Static payload
records are selected by the six existing views and therefore do not consume
record IDs. A steady-spin descriptor uses these exact 8-byte-aligned layouts:

| Payload | Size | Ordered tail after the common 32-byte prefix | Known features |
|---|---:|---|---:|
| `spin_cell_v1` | 72 | `active:u32`, `conductor:u32`, `material_index:u32`, `reserved1:u32`, `spin_active:u32`, `torque_target:u32`, `region_id:u32`, `reserved2:u32`, `saturation_magnetization:f64` | `0x0c` |
| `spin_material_v1` | 112 | charge-material fields `material_index`, `reserved1`, `conductivity`, `material_revision`, followed by `spin_conductivity:f64`, `polarization:f64`, `spin_hall_angle:f64`, `spin_flip_length:f64`, `exchange_length:f64`, `dephasing_length:f64`, `spin_revision:u64` | `0x0c` |
| `spin_boundary_face_v1` | 104 | `kind:u32`, `axis:u32`, `side:i32`, `outward_sign:i32`, `adjacent_cell:u64`, `canonical_face_index:u64`, `area:f64`, `potential_xyz:f64[3]`, `source_id:u64` | `0x08` |
| `spin_interface_v1` | 176 | `kind:u32`, `axis:u32`, `orientation:i32`, `reserved1:u32`, `negative_cell:u64`, `positive_cell:u64`, `from_cell:u64`, `to_cell:u64`, `canonical_face_index:u64`, `area:f64`, `G_up/G_down/G_r/G_i:f64`, `magnetization_xyz:f64[3]`, `source_id:u64`, `topology_id:u64`, `charge_edge_enabled:u32`, `reserved2:u32` | `0x1c` |
| `formula_ids_v1` | 144 | charge formula fields through byte 63, then nine spin IDs at offsets 64--99, `reserved2:u32`, `spin_operator_revision:u64`, `preconditioner_revision:u64`, `gamma_e:f64`, `gmres_restart:u64`, `reserved3:u64` | `0x1c` |
| `spin_observation_record_v1` | 288 | `kind:u32`, `axis:u32`, `orientation:i32`, `reserved1:u32`, `cell_index:u64`, `source_id:u64`, `topology_id:u64`, `canonical_face_index:u64`, `negative_cell:u64`, `positive_cell:u64`, `from_cell:u64`, `to_cell:u64`, `region_id:u32`, `reserved2:u32`, `charge_from_trace_v:f64`, `charge_to_trace_v:f64`, `charge_delta_trace_v:f64`, `lane0_xyz` through `lane5_xyz:f64[3]` | exactly `0x48` |

The exact offsets and C names are normative in the physics note under
`DOC-ANCHOR:fdm-gpu-m1-fp64-contract`. View order remains cells/materials/
interfaces/charge-faces/spin-faces/formula-IDs. The first, second and sixth
records are strict supersets of their existing charge records. Mixed positional
interface matching is forbidden: the full source-plus-topology tuple is the
identity and input order has no semantic effect. Boundary enum values are
`0 invalid`, `1 insulating`, `2 sink`, `3 specified_potential`. Interface enum
values are `0 invalid`, `1 transparent`, `2 mixing_conductance_v2`,
`3 sml_reservoir_v2`; v1 bounded GPU rejects value 3. Every unlisted enum,
nonzero reserved field, invalid feature mask, malformed extent, duplicate
identity, inactive endpoint, wrong face area/sign/index, nonunit magnetization,
or nonfinite physical value is rejected before static publication.

For `M1_CHARGE|STEADY_SPIN`, every view is `host_read_only/raw_bytes/scalar`,
all nonempty addresses and record strides are 8-byte aligned, and nonempty byte
ranges are pairwise disjoint. Exact `(count,stride,required_features)` is:
cells `(nx*ny*nz,72,0x04)`; materials `(unique referenced IDs,112,0x04)`;
interfaces `(authored count,176,0x04 transparent or 0x14 mixing)`; charge faces
`(all external structured faces,88,0x04)`; spin faces
`(all external structured faces,104,0x08)`; formula IDs `(1,144,0x04)`.
Only interfaces may be empty, with address and byte length zero but stride 176.
Every byte length equals checked `count*stride`. Charge-prefix records keep
exact required mask `0x04`; spin tail presence is enforced by descriptor feature
mask plus exact stride/minimum size. This is what makes the extension readable
by the existing charge-prefix parser without weakening steady-spin validation.

The future ABI records have these complete semantic responsibilities:

| Record | Required v1 content |
|---|---|
| `fullmag_fdm_gpu_transport_context_create_request_v1` | device ordinal/UUID constraint, precision=`double`, strict residency=true, deterministic-reduction policy, allocator/workspace byte limits, required features |
| `fullmag_fdm_gpu_transport_context_create_result_v1` | typed context handle, resolved device UUID/runtime/build identity, registry generation, supported feature bits and initial telemetry cursor |
| `fullmag_fdm_gpu_transport_static_descriptor_v1` | grid/cell sizes, active/conductor/torque masks, region/material tables, formula/operator IDs, oriented transparent/mixing interfaces, exact external charge/spin faces, descriptor and source revisions |
| `fullmag_fdm_gpu_charge_solve_request_v1` | context handle, charge solver policy, component-gauge policy, attempt/stage/source identity, expected static revision |
| `fullmag_fdm_gpu_charge_solve_result_v1` | provisional generation, algebraic/physical residuals, component/electrode balances, iterations/reason, transfer and peak-memory counters; no host vector pointers |
| `fullmag_fdm_gpu_charge_snapshot_info_v1` | typed snapshot handle plus context, `snapshot_lineage_id`, `accepted_sequence`, local generation, source/operator revisions, `snapshot_content_digest`, convergence digest and device-resident byte count; no field pointers |
| `fullmag_fdm_gpu_steady_spin_solve_request_v1` | context and accepted snapshot handles/generation, device `m_stage`, spin solver policy, torque destination, attempt/stage identity, expected revisions |
| `fullmag_fdm_gpu_steady_spin_solve_result_v1` | algebraic/local/global/interface/torque balances, iterations/reason, snapshot identity, transfer/synchronization and peak-memory counters; no host vector pointers |
| `fullmag_fdm_gpu_transport_telemetry_v1` | versioned event cursor plus direction, bytes, reason, count, attempt/stage/iteration scope, stream/event identity, convergence reductions, `host_fallback_count` |
| `fullmag_fdm_gpu_transport_artifact_request_v1` | explicit accepted snapshot/field id, output cadence authorization, host destination, layout/unit/component metadata, bounded range |
| `fullmag_fdm_gpu_transport_checkpoint_size_request_v1` | context/snapshot handles, accepted sequence, checkpoint schema version, inclusion mask and expected identities |
| `fullmag_fdm_gpu_transport_checkpoint_size_result_v1` | exact required bytes, section count, alignment, schema/feature mask and current accepted-state digest |
| `fullmag_fdm_gpu_transport_checkpoint_export_request_v1` | context/snapshot handles, accepted sequence, explicit checkpoint cadence authorization, host-write destination and exact capacity |
| `fullmag_fdm_gpu_transport_checkpoint_export_result_v1` | committed byte count, payload SHA-256, snapshot/spin/warm-start digests, telemetry event and immutable accepted identities |
| `fullmag_fdm_gpu_transport_checkpoint_import_request_v1` | fresh context in `static_uploaded`, host-read checkpoint bytes, expected SHA-256, expected device/build/static descriptor and restore policy |
| `fullmag_fdm_gpu_transport_checkpoint_restore_result_v1` | new local snapshot handle/info, restored lineage/sequence/content digests, restored spin/warm-start state, transfer event and atomic commit status |
| `fullmag_fdm_gpu_transport_error_v1` | stable status code, failed record/field, requested and available versions/features, context/snapshot/attempt ids, bounded UTF-8 diagnostic |

The normative byte layouts use shortened record IDs below; generated C names
prepend `fullmag_fdm_gpu_transport_` except for the already frozen charge and
spin solve/snapshot names. The ordered tail is complete through `MIN_SIZE_V1`.

| Record ID | MIN_SIZE_V1 | KNOWN_FEATURES_V1 | Ordered tail fields (`offset:name:type`) |
|---|---:|---:|---|
| `buffer_view_v1` | `80` | `0x0000000000000000` | `32:address:u64;40:element_count:u64;48:byte_stride:u64;56:byte_length:u64;64:element_type:u32;68:pointer_space:u32;72:component_order:u32;76:reserved0:u32` |
| `context_create_request_v1` | `104` | `0x000000000000007f` | `32:device_uuid:u8[16];48:device_ordinal:i32;52:precision:u32;56:strict_residency:u32;60:deterministic:u32;64:allocator_limit:u64;72:workspace_limit:u64;80:stream_policy:u32;84:reserved0:u32;88:requested_device_features:u64;96:reserved1:u64` |
| `context_create_result_v1` | `136` | `0x000000000000007f` | `32:context_handle:handle32;64:device_uuid:u8[16];80:compute_major:u32;84:compute_minor:u32;88:cuda_runtime:u32;92:cuda_driver:u32;96:build_digest:u8[32];128:supported_features:u64` |
| `static_descriptor_v1` | `184` | `0x000000000000001c` | `32:grid:u64[3];56:cell_size:f64[3];80:descriptor_revision:u64;88:source_revision:u64;96:descriptor_digest:u8[32];128:masks_view_ptr:u64;136:materials_view_ptr:u64;144:interfaces_view_ptr:u64;152:charge_faces_view_ptr:u64;160:spin_faces_view_ptr:u64;168:formula_ids_view_ptr:u64;176:reserved0:u64` |
| `charge_solve_request_v1` | `120` | `0x0000000000000007` | `32:context_handle:handle32;64:solver_policy:u32;68:gauge_policy:u32;72:attempt_id:u64;80:stage_id:u64;88:source_revision:u64;96:static_revision:u64;104:relative_tolerance:f64;112:max_iterations:u64` |
| `charge_solve_result_v1` | `144` | `0x0000000000000007` | `32:provisional_generation:u64;40:iterations:u64;48:reason:u32;52:reserved0:u32;56:algebraic_residual:f64;64:physical_residual:f64;72:component_balance:f64;80:electrode_balance:f64;88:transfer_count:u64;96:transfer_bytes:u64;104:peak_bytes:u64;112:candidate_digest:u8[32]` |
| `charge_snapshot_info_v1` | `216` | `0x0000000000000027` | `32:snapshot_handle:handle32;64:context_handle:handle32;96:snapshot_lineage_id:u8[16];112:accepted_sequence:u64;120:local_generation:u64;128:source_revision:u64;136:operator_revision:u64;144:snapshot_content_digest:u8[32];176:convergence_digest:u8[32];208:device_bytes:u64` |
| `steady_spin_solve_request_v1` | `176` | `0x000000000000001f` | `32:context_handle:handle32;64:snapshot_handle:handle32;96:accepted_sequence:u64;104:m_stage_view_ptr:u64;112:torque_view_ptr:u64;120:solver_policy:u32;124:reserved0:u32;128:attempt_id:u64;136:stage_id:u64;144:source_revision:u64;152:operator_revision:u64;160:relative_tolerance:f64;168:max_iterations:u64` |
| `steady_spin_solve_result_v1` | `176` | `0x000000000000001f` | `32:iterations:u64;40:reason:u32;44:reserved0:u32;48:algebraic_residual:f64;56:local_balance:f64;64:global_balance:f64;72:interface_balance:f64;80:torque_balance:f64;88:transfer_count:u64;96:transfer_bytes:u64;104:peak_bytes:u64;112:snapshot_content_digest:u8[32];144:deterministic_compute_digest:u8[32]` |
| `transport_telemetry_v1` | `176` | `0x000000000000007f` | `32:audit_sequence:u64;40:direction:u32;44:reason:u32;48:status:u32;52:event_flags:u32;56:bytes:u64;64:count:u64;72:attempt_id:u64;80:stage_id:u64;88:iteration:u64;96:stream_id:u64;104:event_id:u64;112:operation_audit_digest:u8[32];144:scientific_continuation_digest:u8[32]` |
| `artifact_request_v1` | `144` | `0x0000000000000044` | `32:context_handle:handle32;64:snapshot_handle:handle32;96:field_id:u32;100:cadence:u32;104:range_begin:u64;112:range_count:u64;120:destination_view_ptr:u64;128:expected_bytes:u64;136:accepted_sequence:u64` |
| `checkpoint_size_request_v1` | `144` | `0x000000000000003f` | `32:context_handle:handle32;64:snapshot_handle:handle32;96:accepted_sequence:u64;104:schema_version:u32;108:inclusion_mask:u32;112:static_descriptor_digest:u8[32]` |
| `checkpoint_size_result_v1` | `88` | `0x000000000000003f` | `32:required_bytes:u64;40:section_count:u32;44:alignment:u32;48:schema_version:u32;52:inclusion_mask:u32;56:snapshot_content_digest:u8[32]` |
| `checkpoint_export_request_v1` | `144` | `0x000000000000003f` | `32:context_handle:handle32;64:snapshot_handle:handle32;96:accepted_sequence:u64;104:cadence_id:u64;112:destination_view_ptr:u64;120:exact_capacity:u64;128:expected_size:u64;136:inclusion_mask:u32;140:reserved0:u32` |
| `checkpoint_export_result_v1` | `232` | `0x000000000000003f` | `32:committed_bytes:u64;40:payload_sha256:u8[32];72:snapshot_digest:u8[32];104:spin_digest:u8[32];136:warm_start_digest:u8[32];168:audit_sequence:u64;176:snapshot_lineage_id:u8[16];192:accepted_sequence:u64;200:operation_audit_digest:u8[32]` |
| `checkpoint_import_request_v1` | `232` | `0x000000000000003f` | `32:context_handle:handle32;64:source_view_ptr:u64;72:expected_payload_sha256:u8[32];104:device_uuid:u8[16];120:build_digest:u8[32];152:static_descriptor_digest:u8[32];184:restore_policy:u32;188:reserved0:u32;192:expected_bytes:u64;200:audit_parent_digest:u8[32]` |
| `checkpoint_restore_result_v1` | `232` | `0x000000000000003f` | `32:snapshot_handle:handle32;64:snapshot_lineage_id:u8[16];80:accepted_sequence:u64;88:snapshot_content_digest:u8[32];120:spin_digest:u8[32];152:warm_start_digest:u8[32];184:audit_sequence:u64;192:restored_state:u32;196:reserved0:u32;200:operation_audit_digest:u8[32]` |
| `transport_error_v1` | `176` | `0x000000000000007f` | `32:status:u32;36:record_id:u32;40:field_offset:u32;44:reserved0:u32;48:requested_abi:u32;52:available_abi:u32;56:requested_struct:u32;60:available_struct:u32;64:requested_features:u64;72:available_features:u64;80:context_handle:handle32;112:snapshot_handle:handle32;144:attempt_id:u64;152:diagnostic_ptr:u64;160:diagnostic_capacity:u64;168:diagnostic_length:u64` |

All ABI discriminants use the following closed numeric registries. Generated C
and Rust bindings copy these values; they do not choose them. `u32_bool` owns
both `strict_residency` and `deterministic`. `reason` in both solve-result
records uses `convergence_reason`; charge and spin requests use their separate
solver-policy registries. `schema_version` is u32 value 1 in every checkpoint
request/result that carries it.

| U32 registry | Name | Exact value | Zero/unknown rule |
|---|---|---:|---|
| `u32_bool` | `false` | `0` | zero/sentinel as named; other values rejected |
| `u32_bool` | `true` | `1` | closed value |
| `element_type` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `element_type` | `u8` | `1` | closed value |
| `element_type` | `u32` | `2` | closed value |
| `element_type` | `u64` | `3` | closed value |
| `element_type` | `i32` | `4` | closed value |
| `element_type` | `f64` | `5` | closed value |
| `element_type` | `raw_bytes` | `6` | closed value |
| `pointer_space` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `pointer_space` | `host_read_only` | `1` | closed value |
| `pointer_space` | `host_write_only` | `2` | closed value |
| `pointer_space` | `device_read_only` | `3` | closed value |
| `pointer_space` | `device_write_only` | `4` | closed value |
| `component_order` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `component_order` | `scalar` | `1` | closed value |
| `component_order` | `xyz` | `2` | closed value |
| `component_order` | `soa_xyz` | `3` | closed value |
| `component_order` | `row_major_Q_ia` | `4` | closed value |
| `component_order` | `oriented_face_xyz` | `5` | closed value |
| `precision` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `precision` | `double` | `1` | closed value |
| `precision` | `single_known_unsupported` | `2` | closed value |
| `stream_policy` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `stream_policy` | `context_owned_single_stream` | `1` | closed value |
| `charge_solver_policy` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `charge_solver_policy` | `cg_device_amg_v1` | `1` | closed value |
| `spin_solver_policy` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `spin_solver_policy` | `restarted_gmres_component_amg_v1` | `1` | closed value |
| `spin_solver_policy` | `restarted_gmres_block_jacobi_prototype_v1` | `2` | closed value |
| `gauge_policy` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `gauge_policy` | `boundary_reference_per_component` | `1` | closed value |
| `gauge_policy` | `zero_mean_per_free_component` | `2` | closed value |
| `convergence_reason` | `unset` | `0` | zero/sentinel as named; other values rejected |
| `convergence_reason` | `converged` | `1` | closed value |
| `convergence_reason` | `max_iterations` | `2` | closed value |
| `convergence_reason` | `non_finite` | `3` | closed value |
| `convergence_reason` | `algebraic_failure` | `4` | closed value |
| `convergence_reason` | `physical_balance_failure` | `5` | closed value |
| `convergence_reason` | `cancelled` | `6` | closed value |
| `telemetry_direction` | `none` | `0` | zero/sentinel as named; other values rejected |
| `telemetry_direction` | `h2d` | `1` | closed value |
| `telemetry_direction` | `d2h` | `2` | closed value |
| `telemetry_direction` | `device_internal` | `3` | closed value |
| `telemetry_direction` | `d2d` | `4` | closed value |
| `telemetry_reason` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `telemetry_reason` | `static_upload_h2d` | `1` | closed value |
| `telemetry_reason` | `scalar_reduction_d2h` | `2` | closed value |
| `telemetry_reason` | `artifact_readback_d2h` | `3` | closed value |
| `telemetry_reason` | `checkpoint_export_d2h` | `4` | closed value |
| `telemetry_reason` | `checkpoint_import_h2d` | `5` | closed value |
| `telemetry_reason` | `stream_synchronize` | `6` | closed value |
| `telemetry_reason` | `event_wait` | `7` | closed value |
| `telemetry_reason` | `rejected_attempt` | `8` | closed value |
| `telemetry_reason` | `solve_state_d2d` | `9` | closed value |
| `telemetry_status` | `success` | `0` | zero/sentinel as named; other values rejected |
| `telemetry_status` | `failed` | `1` | closed value |
| `telemetry_status` | `rejected` | `2` | closed value |
| `artifact_field_id` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `artifact_field_id` | `V` | `1` | closed value |
| `artifact_field_id` | `J_c` | `2` | closed value |
| `artifact_field_id` | `mu_s` | `3` | closed value |
| `artifact_field_id` | `Q_ia` | `4` | closed value |
| `artifact_field_id` | `torque_stt` | `5` | closed value |
| `artifact_field_id` | `charge_interface_trace` | `6` | closed value |
| `artifact_field_id` | `transport_observations` | `7` | closed value |
| `artifact_cadence` | `forbidden` | `0` | zero/sentinel as named; other values rejected |
| `artifact_cadence` | `accepted_step` | `1` | closed value |
| `artifact_cadence` | `final_state` | `2` | closed value |
| `artifact_cadence` | `explicit_request` | `3` | closed value |
| `checkpoint_schema_version` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `checkpoint_schema_version` | `v1` | `1` | closed value |
| `checkpoint_restore_policy` | `invalid` | `0` | zero/sentinel as named; other values rejected |
| `checkpoint_restore_policy` | `exact_same_device_build` | `1` | closed value |
| `checkpoint_restored_state` | `not_restored` | `0` | zero/sentinel as named; other values rejected |
| `checkpoint_restored_state` | `restored_charge_accepted` | `1` | closed value |
| `checkpoint_restored_state` | `restored_spin_accepted` | `2` | closed value |
| `error_status` | `ok` | `0` | zero/sentinel as named; other values rejected |
| `error_status` | `unsupported` | `1` | closed value |
| `error_status` | `incompatible_abi` | `2` | closed value |
| `error_status` | `invalid_descriptor` | `3` | closed value |
| `error_status` | `invalid_pointer_space` | `4` | closed value |
| `error_status` | `invalid_state` | `5` | closed value |
| `error_status` | `out_of_memory` | `6` | closed value |
| `error_status` | `nonconverged` | `7` | closed value |
| `error_status` | `balance_failure` | `8` | closed value |
| `error_status` | `stale_snapshot` | `9` | closed value |
| `error_status` | `strict_gpu_residency_violation` | `10` | closed value |
| `error_status` | `cuda_runtime_error` | `11` | closed value |
| `error_status` | `live_snapshot` | `12` | closed value |
| `error_status` | `already_destroyed` | `13` | closed value |
| `error_status` | `out_of_resources` | `14` | closed value |
| `error_status` | `unsupported_required_feature` | `15` | closed value |
| `error_status` | `checkpoint_incompatible` | `16` | closed value |
| `record_id` | `none` | `0` | zero/sentinel as named; other values rejected |
| `record_id` | `buffer_view_v1` | `1` | closed value |
| `record_id` | `context_create_request_v1` | `2` | closed value |
| `record_id` | `context_create_result_v1` | `3` | closed value |
| `record_id` | `static_descriptor_v1` | `4` | closed value |
| `record_id` | `charge_solve_request_v1` | `5` | closed value |
| `record_id` | `charge_solve_result_v1` | `6` | closed value |
| `record_id` | `charge_snapshot_info_v1` | `7` | closed value |
| `record_id` | `steady_spin_solve_request_v1` | `8` | closed value |
| `record_id` | `steady_spin_solve_result_v1` | `9` | closed value |
| `record_id` | `transport_telemetry_v1` | `10` | closed value |
| `record_id` | `artifact_request_v1` | `11` | closed value |
| `record_id` | `checkpoint_size_request_v1` | `12` | closed value |
| `record_id` | `checkpoint_size_result_v1` | `13` | closed value |
| `record_id` | `checkpoint_export_request_v1` | `14` | closed value |
| `record_id` | `checkpoint_export_result_v1` | `15` | closed value |
| `record_id` | `checkpoint_import_request_v1` | `16` | closed value |
| `record_id` | `checkpoint_restore_result_v1` | `17` | closed value |
| `record_id` | `transport_error_v1` | `18` | closed value |

Pole `charge_interface_trace` (`6`) zwraca tablicę rekordów
`fullmag_fdm_gpu_transport_charge_interface_trace_v1` w niezmiennej kolejności
deskryptora statycznego. Rekord ma 136 bajtów, wyrównanie 8 bajtów i zawiera:
`axis`, `orientation`, `source_id`, `topology_id`, `canonical_face_index`,
`negative_cell`, `positive_cell`, `from_cell`, `to_cell`, `from_trace_v`,
`to_trace_v`, `delta_trace_v` oraz `oriented_current_density`. Widok docelowy
musi być `HOST_WRITE_ONLY`, `RAW_BYTES`, `SCALAR`, z krokiem dokładnie 136
bajtów. Odczyt jest dozwolonym transferem D2H tylko na jawne żądanie artefaktu;
telemetria raportuje cztery rzeczywiste transfery FP64 na rekord i jedno
synchronizowanie strumienia. Import checkpointu odtwarza te same cztery tablice
na urządzeniu bez ponownego rozwiązania równania ładunku.

Bitmask fields use these exact bits:

| U32 flag registry | Name | Exact bit | Legality |
|---|---|---:|---|
| `telemetry_event_flags` | `none` | `0x00000000` | known v1 bit/value |
| `telemetry_event_flags` | `transfer` | `0x00000001` | known v1 bit/value |
| `telemetry_event_flags` | `synchronization` | `0x00000002` | known v1 bit/value |
| `telemetry_event_flags` | `cadence_authorized` | `0x00000004` | known v1 bit/value |
| `telemetry_event_flags` | `scientific_commit` | `0x00000008` | known v1 bit/value |
| `telemetry_event_flags` | `provisional` | `0x00000010` | known v1 bit/value |
| `telemetry_event_flags` | `failed` | `0x00000020` | known v1 bit/value |
| `checkpoint_inclusion_mask` | `none` | `0x00000000` | known v1 bit/value |
| `checkpoint_inclusion_mask` | `charge_arrays` | `0x00000001` | known v1 bit/value |
| `checkpoint_inclusion_mask` | `charge_observations` | `0x00000002` | known v1 bit/value |
| `checkpoint_inclusion_mask` | `spin_arrays` | `0x00000004` | known v1 bit/value |
| `checkpoint_inclusion_mask` | `spin_observations_and_torque` | `0x00000008` | known v1 bit/value |
| `checkpoint_inclusion_mask` | `warm_starts` | `0x00000010` | known v1 bit/value |
| `checkpoint_inclusion_mask` | `continuation_meta` | `0x00000020` | known v1 bit/value |

| U32 flag registry | LEGAL_MASK_V1 |
|---|---:|
| `telemetry_event_flags` | `0x0000003f` |
| `checkpoint_inclusion_mask` | `0x0000003f` |

For every registry, closed enum unknown u32 values are invalid_descriptor. The zero entry is
the only sentinel: it is legal only where named `none`, `unset`, `success`,
`forbidden`, `not_restored`, or `ok`; every `invalid` entry is rejected.
`error_status ok=0 is forbidden in transport_error_v1`; `record_id none=0` is
legal only when no error record is emitted. `strict_residency and deterministic
are u32 booleans restricted to 0 or 1`. `schema_version is u32 value 1`.

`telemetry_event_flags unknown bits are incompatible_abi`. A transfer event
sets `transfer`, uses direction `h2d`, `d2h`, or `d2d`, and has an exact transfer
reason. A synchronization event sets `synchronization` and uses direction
`device_internal`. `failed` and `scientific_commit` are mutually exclusive;
`cadence_authorized` is legal only for artifact/checkpoint transfer reasons.
`checkpoint_inclusion_mask unknown bits are unsupported_required_feature`.
The checkpoint charge-only required mask is 0x00000033; the checkpoint
spin-required mask is 0x0000003f. Other inclusion combinations are rejected in
v1 rather than silently dropping state.

`struct_size` may exceed the listed minimum only for an optional same-version
tail. Old-v1/new-v1 accepts that tail only when `required_features` is a subset
of the row mask. A v1 callee rejects struct version 2 even when its size is
larger; a v2 callee uses a separately published `MIN_SIZE_V2` and may accept
the exact v1 prefix only for operations whose v2-required mask is empty. These
rules, the offsets above and the common prefix are the independent ABI layout
oracle; generated headers must match them, not define them.

#### Operations and state machine

The append-only operation family is semantically:

```text
context_create
upload_static_descriptor
solve_charge
accept_charge_snapshot
solve_steady_spin
query_telemetry
readback_artifact
checkpoint_query_size
checkpoint_export
checkpoint_import
charge_snapshot_destroy
context_destroy
```

`context_create` selects one device and FP64 strict policy. A successful
`upload_static_descriptor` atomically replaces no state: the first upload
establishes the immutable operator identity; a changed descriptor requires a
new context in v1. `solve_charge` creates provisional device state. Only
`accept_charge_snapshot` after all charge gates pass creates the next immutable
accepted generation. `solve_steady_spin` requires that exact generation and
does not read or reconstruct charge data on the host.

`query_telemetry` returns bounded scalar/event records by cursor without
transferring fields. `readback_artifact` is legal only for an accepted state
and explicit configured cadence; it records direction, bytes, reason, and
field metadata. Checkpoint operations follow the separate committed-payload
contract below. Snapshot destruction retires its registry token without
free-pointer reuse. Context destruction fails while live snapshots or
operations remain. Reusing a retired token is safe and typed as specified by
the registry state; it never dereferences released storage.

The state machine is:

```text
empty -> static_uploaded -> charge_provisional -> charge_accepted
charge_accepted -> spin_provisional -> spin_accepted
*_provisional -> rejected -> previous accepted state
charge_accepted|spin_accepted -> checkpoint_exporting -> same accepted state
fresh static_uploaded -> checkpoint_importing -> restored_charge_accepted|restored_spin_accepted
checkpoint_importing -> rejected -> static_uploaded
```

A rejected attempt appends telemetry but does not advance snapshot, field,
cache, or accepted-stage revisions. New charge acceptance invalidates spin
cache entries that name an older generation but does not mutate already held
snapshots. Cache keys and checkpoints include ABI/layout, device/build,
descriptor/source/operator, precision/determinism, snapshot generation, and
formula/operator/engine/residual identities. Restart validates all identities
before allocation and never performs an implicit cross-device migration.

#### Checkpoint payload and atomic restore

FDM GPU M1 uses full committed-state export/import; restart never silently
re-solves charge. The canonical payload schema is
`fullmag.fdm_gpu_transport_checkpoint.v1`. Its integer fields and IEEE-754
binary64 payloads are little-endian. Raw pointers, process registry tokens,
CUDA handles, stream/event handles and allocator addresses are forbidden.

The fixed v1 header is exactly 320 bytes:

| Offset | Field | Type and v1 rule |
|---:|---|---|
| 0 | `magic` | `u8[8]`, exactly `FMGPUTR1` |
| 8 | `schema_major` | `u16`, exactly 1 |
| 10 | `schema_minor` | `u16`, exactly 0 |
| 12 | `header_size` | `u32`, exactly 320 |
| 16 | `endian_tag` | `u32`, exactly `0x01020304` |
| 20 | `section_descriptor_size` | `u32`, exactly 96 |
| 24 | `section_count` | `u32` |
| 28 | `reserved0` | `u32`, zero |
| 32 | `total_size` | `u64`, complete file bytes |
| 40 | `section_table_offset` | `u64`, exactly 320 |
| 48 | `payload_offset` | `u64`, first 64-byte-aligned section |
| 56 | `flags` | `u64`, zero in v1 |
| 64 | `required_features` | `u64`, subset of `KNOWN_GLOBAL_FEATURES_V1` |
| 72 | `accepted_sequence` | `u64` |
| 80 | `snapshot_lineage_id` | `u8[16]` |
| 96 | `device_uuid` | `u8[16]` |
| 112 | `build_digest` | `u8[32]` |
| 144 | `static_descriptor_digest` | `u8[32]` |
| 176 | `snapshot_content_digest` | `u8[32]` |
| 208 | `descriptor_table_sha256` | `u8[32]` |
| 240 | `ordered_section_data_sha256` | `u8[32]` |
| 272 | `file_sha256` | `u8[32]` |
| 304 | `reserved1` | `u8[16]`, zero |

Every section descriptor is exactly 96 bytes:

| Offset | Field | Type and v1 rule |
|---:|---|---|
| 0 | `section_id` | `u32`, strictly ascending |
| 4 | `section_version` | `u16`, exactly 1 for known v1 IDs |
| 6 | `section_flags` | `u16`; bit 0 means required, all other bits zero |
| 8 | `element_type` | `u32`: 1=`u8`, 2=`u32`, 3=`u64`, 4=`i32`, 5=`f64`, 6=raw bytes |
| 12 | `element_size` | `u32`, exact width for the element type |
| 16 | `element_count` | `u64` |
| 24 | `file_offset` | `u64`, 64-byte aligned |
| 32 | `byte_length` | `u64`, checked `element_count*element_size` |
| 40 | `uncompressed_length` | `u64`, equal to `byte_length` in v1 |
| 48 | `section_sha256` | `u8[32]` over exactly `byte_length` bytes at `file_offset` |
| 80 | `reserved` | `u8[16]`, zero |

Descriptors are contiguous at byte 320. The first payload offset is
`align_up(320 + 96*section_count, 64)`. Sections occur in ascending ID order,
each starts at `align_up(previous_end,64)`, and `total_size` is
`align_up(last_end,64)`. Every byte in header, descriptor, inter-section and
final padding is zero unless assigned above. Checked arithmetic rejects
overlap, wraparound, a section outside `total_size`, inconsistent element
length, duplicate/out-of-order IDs, or non-canonical padding.

Every equality in that layout algorithm is exact and minimal. A section
`file_offset` must equal, not merely exceed,
`align_up(previous_end,64)`. File length, header `total_size`, and
`align_up(last_section_end,64)` must be identical. Therefore an additional
aligned zero block after canonical trailing padding or an extra zero gap before
a section is non-canonical and rejected even when every digest is recomputed.

Hash domains are exact. `descriptor_table_sha256` covers only the
`96*section_count` descriptor bytes. `ordered_section_data_sha256` covers the
concatenation of section data in descriptor order and excludes padding.
`file_sha256` covers bytes `[0,total_size)` with only bytes 272--303 replaced
by zero. The published file retains the computed digest in those bytes. The
external payload SHA-256 in the ABI result is the ordinary SHA-256 over all
published file bytes, including the populated `file_sha256` field.

The complete v1 section-ID registry is:

| ID | Name | Presence |
|---:|---|---|
| 1 | `charge_meta` | required |
| 2 | `V` | required |
| 3--5 | `Jx`, `Jy`, `Jz` | required |
| 6 | `masks` | required |
| 7 | `exact_density_faces` | required |
| 8 | `charge_interface_traces` | required |
| 9 | `charge_observations` | required |
| 10 | `spin_meta` | optional; when present, IDs 11--17 are required |
| 11 | `mu_s` | conditional |
| 12--14 | `Qx`, `Qy`, `Qz` | conditional |
| 15 | `spin_reactions` | conditional |
| 16 | `spin_interface_observations` | conditional |
| 17 | `torque` | conditional |
| 18 | `charge_warm_start` | required |
| 19 | `spin_warm_start` | required when ID 10 is present |
| 20 | `solver_continuation_meta` | required |

IDs 2--5 and 11--14 contain raw little-endian FP64 values in the frozen SoA
order above. Every other section uses the following exact canonical subrecord
codec and has descriptor `element_type=6`, `element_size=1`, and
`element_count=byte_length`:

```text
subrecord header (16 bytes)
0:record_version:u16 = 1
2:record_flags:u16 = 0
4:field_count:u32
8:record_bytes:u64 = section byte_length

field descriptor (32 bytes, repeated field_count times)
0:field_id:u16
2:field_type:u16
4:field_flags:u32       # bit 0 required; other bits zero
8:element_count:u64
16:data_offset:u64      # from section start, 8-byte aligned
24:byte_length:u64
```

Field descriptors start at byte 16, are strictly ascending by `field_id`, and
do not overlap. First data is at `align_up(16+32*field_count,8)`; each later
field is at `align_up(previous_end,8)` and `record_bytes` is
`align_up(last_end,8)`. All padding is zero. Field types are 1=`u8`, 2=`u32`,
3=`u64`, 4=`i32`, 5=`f64`, 6=`u8[16]`, 7=`u8[32]`, 8=`UTF-8`, and 9=`UTF-8
list`. Fixed-width fields require exact `count*width`. Type 8 has one
NFC-normalized UTF-8 string, no NUL. Type 9 has exactly `element_count`
strings encoded consecutively as `byte_count:u32` plus NFC-normalized bytes,
without NUL, and `byte_length` covers the complete sequence.

Those subrecord offsets are also exact minimal equalities: every `data_offset`
must equal the stated `align_up`, and `record_bytes` must equal the first
aligned byte after the final field. Extra zero bytes before field data or after
canonical record padding are invalid even when descriptor lengths and hashes
are internally consistent.

The per-section v1 field registry is normative; every listed field is required
and its position in the list is its `field_id`:

| Section | Ordered field names and types |
|---|---|
| 1 `charge_meta` | `compute_capability:u32[2]`, `cuda_driver:u32`, `cuda_runtime:u32`, `compiler_identity:utf8`, `deterministic_policy_digest:sha256`, `formula_id:utf8`, `operator_id:utf8`, `engine_id:utf8`, `residual_id:utf8`, `grid:u64[3]`, `cell_size:f64[3]`, `descriptor_revision:u64`, `source_revision:u64`, `operator_revision:u64`, `component_count:u64`, `gauge_component_ids:u32[]`, `gauge_values:f64[]`, `convergence_reason:u32`, `iterations:u64`, `work_budget:u64` |
| 6 `masks` | `active:u8[]`, `conductor:u8[]`, `torque_target:u8[]`, `material_region:u32[]`, `conductivity_revision:u64` |
| 7 `exact_density_faces` | `cell_linear:u64[]`, `axis:u32[]`, `side:i32[]`, `area:f64[]`, `density:f64[]`, `source_ids:utf8_list` |
| 8 `charge_interface_traces` | `interface_ids:utf8_list`, `face_linear:u64[]`, `orientation:i32[]`, `V_N:f64[]`, `V_F:f64[]`, `J_N:f64[]`, `J_F:f64[]` |
| 9 `charge_observations` | `electrode_ids:utf8_list`, `electrode_current:f64[]`, `component_balance:f64[]`, `physical_residual:f64[]` |
| 10 `spin_meta` | `formula_id:utf8`, `operator_id:utf8`, `electric_reconstruction_id:utf8`, `interface_formula_id:utf8`, `torque_operator_id:utf8`, `engine_id:utf8`, `preconditioner_id:utf8`, `residual_id:utf8`, `local_residual_id:utf8`, `source_revision:u64`, `operator_revision:u64`, `preconditioner_revision:u64`, `convergence_reason:u32`, `iterations:u64`, `work_budget:u64`, `local_balance:f64`, `global_balance:f64`, `interface_balance:f64`, `torque_balance:f64`, `deterministic_compute_digest:sha256` |
| 15 `spin_reactions` | `R_sf_x:f64[]`, `R_sf_y:f64[]`, `R_sf_z:f64[]`, `R_J_x:f64[]`, `R_J_y:f64[]`, `R_J_z:f64[]`, `R_phi_x:f64[]`, `R_phi_y:f64[]`, `R_phi_z:f64[]` |
| 16 `spin_interface_observations` | `source_ids:u64[]`, `topology_ids:u64[]`, `axis:u32[]`, `face_linear:u64[]`, `negative_cell:u64[]`, `positive_cell:u64[]`, `from_cell:u64[]`, `to_cell:u64[]`, `orientation:i32[]`, `incoming_x:f64[]`, `incoming_y:f64[]`, `incoming_z:f64[]`, `backflow_x:f64[]`, `backflow_y:f64[]`, `backflow_z:f64[]`, `absorbed_x:f64[]`, `absorbed_y:f64[]`, `absorbed_z:f64[]`, `negative_flux_x:f64[]`, `negative_flux_y:f64[]`, `negative_flux_z:f64[]`, `positive_flux_x:f64[]`, `positive_flux_y:f64[]`, `positive_flux_z:f64[]`, `sml_x:f64[]`, `sml_y:f64[]`, `sml_z:f64[]` |
| 17 `torque` | `volume_x:f64[]`, `volume_y:f64[]`, `volume_z:f64[]`, `surface_x:f64[]`, `surface_y:f64[]`, `surface_z:f64[]`, `final_x:f64[]`, `final_y:f64[]`, `final_z:f64[]`, `balance:f64[]` |
| 18 `charge_warm_start` | `engine_id:utf8`, `preconditioner_revision:u64`, `restart_position:u64`, `basis_count:u64`, `iterate:f64[]`, `basis:f64[]`, `deterministic_reduction_state:u8[]` |
| 19 `spin_warm_start` | same seven fields and types as section 18, for the spin engine |
| 20 `solver_continuation_meta` | `accepted_sequence:u64`, `attempt_id:u64`, `stage_id:u64`, `telemetry_cursor:u64`, `charge_work_budget:u64`, `spin_work_budget:u64`, `scientific_continuation_digest:sha256` |

For a spin-accepted state, the inclusion mask is exactly `0x3f` and sections
10--17, 19 and 20 are mandatory in addition to charge sections 1--9 and 18.
Section 10 fixes formula/operator/electric/interface/torque/engine/
preconditioner/residual IDs, revisions, convergence reason, iteration/work
budget and deterministic compute digest. Section 15 contains separate SoA
`R_sf`, `R_J` and `R_phi`; section 16 keys each observation by the complete
source-plus-topology tuple and stores incoming, backflow, absorbed, both
one-sided fluxes and explicit zero-or-valued SML channels; section 17 stores
volume, surface and final torque plus closure; section 19 stores the restarted
GMRES iterate, component-AMG/block-Jacobi revision, restart position, basis and
fixed-tree reduction continuation. Spin checkpoint size is dynamic and must
never reuse the charge-only 4352-byte oracle as an expected size.

The four published scientific digest byte domains are exact:

```text
snapshot_content_digest = SHA256(section[1] || ... || section[17])
spin_digest = SHA256(section[10] || ... || section[17])
warm_start_digest = SHA256(section[18] || section[19])
scientific_continuation_digest = SHA256(
    header.snapshot_content_digest[32] ||
    section[18] || section[19] ||
    section[20] with only field 7 data bytes replaced by zero)
```

Each `section[id]` means exactly its canonical `byte_length` data bytes and
excludes section descriptors and inter-section padding; concatenation is in
strict ascending numeric ID. For a charge-only accepted state,
`snapshot_content_digest=SHA256(section[1]||...||section[9])`,
`spin_digest` is 32 zero bytes, `warm_start_digest=SHA256(section[18])`, and the
continuation domain omits absent section 19 while retaining the same field-7
zeroing rule. No other header field, file padding, export/import event or audit
digest enters these domains. The header and frozen result/restore records carry
the resulting bytes verbatim. The operation-audit chain remains a separate
domain over canonical telemetry events and is never folded into any of these
four digests.

Parallel arrays within one subrecord have equal element counts unless a field
is explicitly scalar; vector component arrays have the corresponding cell or
face count from section 1. A mismatch is `checkpoint_incompatible`. A v1
exporter emits only known IDs and exactly the listed fields. An unknown
required section or field is rejected. An unknown optional section or field
may be skipped only at schema minor 0 with no unknown required feature bit; it
remains inside its containing hash domains.

`checkpoint_query_size` uses the same checked alignment algorithm and returns
the exact `total_size`; export rejects any capacity other than that value.

Two byte oracles have separate jobs. The codec-only golden contains complete
section 1 `charge_meta` with all 20 registered fields and section 2
`V=[1.0]`. Both section descriptors and the complete subrecord are canonical,
so the independent decoder must accept its byte grammar. It deliberately lacks
required charge sections 3--9, 18, and 20, so a scientific importer rejects it
as incomplete and a runtime exporter never emits it. codec-only golden
length=1600 bytes; codec-only golden SHA-256=ad8d00c7c4d3c349ee203946145b9d02f8e34f331ee9687645c9c981bb33b803; its embedded
zeroed-field file hash is `89a625b9d60665cb3af867bd648da62dbb4ea255e23ef785139d43bc08bfed02`.

```text
FMGPUTR1_GOLDEN_HEX_BEGIN
464d4750555452310100000040010000040302016000000002000000000000004006000000000000400100000000000000020000000000000000000000000000
20000000000000000700000000000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f11111111111111111111111111111111
1111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221bac8a12f6f01e209eb89003bf85ec6a
32ec36c5a0e2db7bd358c821686a1178946642161d639a63c9393149a1f6f4238e097c92abbd87d046479ff8d4d98a691bac8a12f6f01e209eb89003bf85ec6a
32ec36c5a0e2db7bd358c821686a117889a625b9d60665cb3af867bd648da62dbb4ea255e23ef785139d43bc08bfed0200000000000000000000000000000000
01000000010001000600000001000000d8030000000000000002000000000000d803000000000000d80300000000000050665af27e6eea713655954d8c26eabc
137cb7853cde6cc2096a3c800e775f80000000000000000000000000000000000200000001000100050000000800000001000000000000000006000000000000
080000000000000008000000000000006c3c396ed6b5c36dcae172271f462051b1266b851e92df3deea8ac65478fd71200000000000000000000000000000000
0100000014000000d803000000000000010002000100000002000000000000009002000000000000080000000000000002000200010000000100000000000000
9802000000000000040000000000000003000200010000000100000000000000a002000000000000040000000000000004000800010000000100000000000000
a8020000000000000b0000000000000005000700010000000100000000000000b802000000000000200000000000000006000800010000000100000000000000
d8020000000000002900000000000000070008000100000001000000000000000803000000000000150000000000000008000800010000000100000000000000
200300000000000020000000000000000900080001000000010000000000000040030000000000001f000000000000000a000300010000000300000000000000
600300000000000018000000000000000b000500010000000300000000000000780300000000000018000000000000000c000300010000000100000000000000
900300000000000008000000000000000d000300010000000100000000000000980300000000000008000000000000000e000300010000000100000000000000
a00300000000000008000000000000000f000300010000000100000000000000a803000000000000080000000000000010000200010000000100000000000000
b003000000000000040000000000000011000500010000000100000000000000b803000000000000080000000000000012000200010000000100000000000000
c003000000000000040000000000000013000300010000000100000000000000c803000000000000080000000000000014000300010000000100000000000000
d00300000000000008000000000000000800000000000000e02e000000000000e02e0000000000006e7663632d676f6c64656e00000000004444444444444444
4444444444444444444444444444444444444444444444447472616e73706f72745f636f6e7374697475746976652e6f6e655f7761792e66756c6c6d61672e76
310000000000000066765f6368617267655f6861726d6f6e69635f763100000066646d5f6368617267655f63675f6465766963655f616d675f637564615f7631
6368617267655f62616c616e63655f696e74656772617465645f6c322e763100010000000000000001000000000000000100000000000000000000000000f03f
000000000000f03f000000000000f03f01000000000000000100000000000000010000000000000001000000000000000000000000000000000000000000f03f
01000000000000000100000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000f03f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
FMGPUTR1_GOLDEN_HEX_END
```

The restore-valid charge-only golden is a distinct conforming codec payload for
a one-cell `grid=[1,1,1]`, `V=[1.0]`, two zero x/y/z boundary-face currents,
one active conductor/material cell, no density or interface faces, one zero
ground-current observation, one charge warm start, and accepted sequence 7.
It contains exactly required IDs 1--9, 18, and 20. Its charge-only inclusion
mask is `0x00000033`. Snapshot content is SHA-256 over section data IDs 1--9
in order. Its `scientific_continuation_digest` is SHA-256 over the header
`snapshot_content_digest`, section 18 bytes, and section 20 bytes with field
7 data zeroed. restore-valid checkpoint length=4352 bytes;
restore-valid checkpoint SHA-256=ae8d3c13853297760f2d9b19156067b52a502dfcb3e006e82ac590310200f6d5; its embedded zeroed-field file hash
is `bc3bcc1b51314fe46e0bbd2f71e94f1517f8e438943853e33b8e79b1495c7b60`.

Ten frozen payload jest **torem A**: ma syntetyczne pola device UUID, build
digest i static-descriptor digest. Niezależny validator musi zaakceptować jego
gramatykę, section set, hashe i scientific content, lecz actual-runtime import
do kontekstu o bieżącej tożsamości musi zwrócić `checkpoint_incompatible`.
Nie jest to błąd oracla i nie wolno konstruować fikcyjnego kontekstu, aby
przepchnąć syntetyczną tożsamość przez exact-identity policy.

**Tor B** jest osobnym actual-runtime dowodem: backend rozwiązuje rzeczywisty
one-cell charge state do accepted sequence 7, eksportuje ten sam kanoniczny
11-section layout o rozmiarze 4352 bajty, a następnie importuje go do świeżego
kontekstu z dokładnie zgodnym device/build/static identity. Payload SHA-256
toru B zależy od tej tożsamości oraz builda i nie ma być równy frozen SHA toru
A. W runie z build digest
`700e798c56bdde3029759e3460a39762e325d5108401e5907819a7b064a9ca3d`
wyniósł
`d2b25960eb31376b1b2fe6aa8ba07944ba69a695125a381a398da46f891123f9`.
Po imporcie odczyty $V$ i $J_c$ muszą być bitowo równe stanowi eksportowanemu
bez deterministycznego re-solve. Frozen SHA toru A jest stabilnym oraclem
kodeka; observed SHA toru B jest dowodem konkretnego runtime runu, nie nową
stałą ABI.

```text
FMGPUTR1_RESTORE_GOLDEN_HEX_BEGIN
464d475055545231010000004001000004030201600000000b000000000000000011000000000000400100000000000080050000000000000000000000000000
20000000000000000700000000000000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f11111111111111111111111111111111
111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222ec18e12165a6161b4b055050c2fdff1b
fc2e55a5c9ea42e282793ac12ec5c5d756e2f29d17e3c58d64abc40007d755e614fd8114afee6a225a3bc8ecda2f69d036f78555d34b7ac31363d38b4737f469
fefcab013e91260d434976b32e45f420bc3bcc1b51314fe46e0bbd2f71e94f1517f8e438943853e33b8e79b1495c7b6000000000000000000000000000000000
01000000010001000600000001000000d8030000000000008005000000000000d803000000000000d80300000000000050665af27e6eea713655954d8c26eabc
137cb7853cde6cc2096a3c800e775f80000000000000000000000000000000000200000001000100050000000800000001000000000000008009000000000000
080000000000000008000000000000006c3c396ed6b5c36dcae172271f462051b1266b851e92df3deea8ac65478fd71200000000000000000000000000000000
030000000100010005000000080000000200000000000000c00900000000000010000000000000001000000000000000374708fff7719dd5979ec875d56cd228
6f6d3cf7ec317a3b25632aab28ec37bb00000000000000000000000000000000040000000100010005000000080000000200000000000000000a000000000000
10000000000000001000000000000000374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb00000000000000000000000000000000
050000000100010005000000080000000200000000000000400a00000000000010000000000000001000000000000000374708fff7719dd5979ec875d56cd228
6f6d3cf7ec317a3b25632aab28ec37bb0000000000000000000000000000000006000000010001000600000001000000d800000000000000800a000000000000
d800000000000000d800000000000000ae6cc629869bf1d3d7f94bcfba569723fff5c5a820304a87b21b8c294f0bbc0900000000000000000000000000000000
07000000010001000600000001000000d000000000000000800b000000000000d000000000000000d0000000000000005824bc51c8067b278ac68716a2596152
26b3ddf4c8ad42d02cfa46ecc2d9ee8a0000000000000000000000000000000008000000010001000600000001000000f000000000000000800c000000000000
f000000000000000f000000000000000aca69bbaceb0278503bdfffd1b3d1b60095581d0be723385e685b2cb6d35cf5c00000000000000000000000000000000
09000000010001000600000001000000b800000000000000800d000000000000b800000000000000b800000000000000c1aef0f0d15961f0524f80cc45f12fb2
4f6135ff02d964b3de8f202843acb2b400000000000000000000000000000000120000000100010006000000010000005001000000000000400e000000000000
50010000000000005001000000000000c71895e9f128587ed5085bf7fb65d8ee39481717a7f11eac6df28de27be66b9600000000000000000000000000000000
140000000100010006000000010000004001000000000000c00f000000000000400100000000000040010000000000000df7cd3187feac0851e8022841d9c49c
38a6305043c90b946425b3b259a54140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0100000014000000d803000000000000010002000100000002000000000000009002000000000000080000000000000002000200010000000100000000000000
9802000000000000040000000000000003000200010000000100000000000000a002000000000000040000000000000004000800010000000100000000000000
a8020000000000000b0000000000000005000700010000000100000000000000b802000000000000200000000000000006000800010000000100000000000000
d8020000000000002900000000000000070008000100000001000000000000000803000000000000150000000000000008000800010000000100000000000000
200300000000000020000000000000000900080001000000010000000000000040030000000000001f000000000000000a000300010000000300000000000000
600300000000000018000000000000000b000500010000000300000000000000780300000000000018000000000000000c000300010000000100000000000000
900300000000000008000000000000000d000300010000000100000000000000980300000000000008000000000000000e000300010000000100000000000000
a00300000000000008000000000000000f000300010000000100000000000000a803000000000000080000000000000010000200010000000100000000000000
b003000000000000040000000000000011000500010000000100000000000000b803000000000000080000000000000012000200010000000100000000000000
c003000000000000040000000000000013000300010000000100000000000000c803000000000000080000000000000014000300010000000100000000000000
d00300000000000008000000000000000800000000000000e02e000000000000e02e0000000000006e7663632d676f6c64656e00000000004444444444444444
4444444444444444444444444444444444444444444444447472616e73706f72745f636f6e7374697475746976652e6f6e655f7761792e66756c6c6d61672e76
310000000000000066765f6368617267655f6861726d6f6e69635f763100000066646d5f6368617267655f63675f6465766963655f616d675f637564615f7631
6368617267655f62616c616e63655f696e74656772617465645f6c322e763100010000000000000001000000000000000100000000000000000000000000f03f
000000000000f03f000000000000f03f01000000000000000100000000000000010000000000000001000000000000000000000000000000000000000000f03f
01000000000000000100000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
000000000000f03f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0100000005000000d80000000000000001000100010000000100000000000000b000000000000000010000000000000002000100010000000100000000000000
b800000000000000010000000000000003000100010000000100000000000000c000000000000000010000000000000004000200010000000100000000000000
c800000000000000040000000000000005000300010000000100000000000000d000000000000000080000000000000001000000000000000100000000000000
00000000000000000100000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0100000006000000d00000000000000001000300010000000000000000000000d000000000000000000000000000000002000200010000000000000000000000
d000000000000000000000000000000003000400010000000000000000000000d000000000000000000000000000000004000500010000000000000000000000
d000000000000000000000000000000005000500010000000000000000000000d000000000000000000000000000000006000900010000000000000000000000
d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0100000007000000f00000000000000001000900010000000000000000000000f000000000000000000000000000000002000300010000000000000000000000
f000000000000000000000000000000003000400010000000000000000000000f000000000000000000000000000000004000500010000000000000000000000
f000000000000000000000000000000005000500010000000000000000000000f000000000000000000000000000000006000500010000000000000000000000
f000000000000000000000000000000007000500010000000000000000000000f000000000000000000000000000000000000000000000000000000000000000
0100000004000000b8000000000000000100090001000000010000000000000090000000000000000a0000000000000002000500010000000100000000000000
a000000000000000080000000000000003000500010000000100000000000000a800000000000000080000000000000004000500010000000100000000000000
b00000000000000008000000000000000600000067726f756e640000000000000000000000000000000000000000000000000000000000000000000000000000
0100000007000000500100000000000001000800010000000100000000000000f000000000000000200000000000000002000300010000000100000000000000
10010000000000000800000000000000030003000100000001000000000000001801000000000000080000000000000004000300010000000100000000000000
20010000000000000800000000000000050005000100000001000000000000002801000000000000080000000000000006000500010000000000000000000000
30010000000000000000000000000000070001000100000020000000000000003001000000000000200000000000000066646d5f6368617267655f63675f6465
766963655f616d675f637564615f7631010000000000000000000000000000000000000000000000000000000000f03f00000000000000000000000000000000
00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
0100000007000000400100000000000001000300010000000100000000000000f000000000000000080000000000000002000300010000000100000000000000
f8000000000000000800000000000000030003000100000001000000000000000001000000000000080000000000000004000300010000000100000000000000
08010000000000000800000000000000050003000100000001000000000000001001000000000000080000000000000006000300010000000100000000000000
18010000000000000800000000000000070007000100000001000000000000002001000000000000200000000000000007000000000000000100000000000000
0100000000000000000000000000000008000000000000000000000000000000861efbdc60cca6a24e74e9b60d2ca391567bd1e5ec4e08b9c4acd93b6c754000
FMGPUTR1_RESTORE_GOLDEN_HEX_END
```

`snapshot_content_digest` covers canonical scientific arrays, metadata and
accepted identities but excludes process-local handle tokens. Export is legal
only from `charge_accepted` or `spin_accepted` at explicit checkpoint cadence.
Its D2H event reason is exactly `checkpoint_export_d2h`; query-size transfers
no vectors. Export failure leaves the accepted state unchanged and the caller
must not publish a partial payload.

Two digest lanes are normative and deliberately non-equivalent. The
append-only operation audit is never rolled back.
`scientific_continuation_digest` covers accepted scientific arrays,
continuation metadata, deterministic reductions, solver restart positions and
warm starts needed to make the next accepted computation identical. It
excludes checkpoint transfer, artifact readback, synchronization and other
operational audit events. `operation_audit_digest` is an append-only SHA-256
chain over every actual transfer, synchronization, and explicitly classified
rejected attempt, successful or failed. Pure handle/state operations without
CUDA activity do not invent zero-byte transfer records:
`SHA256(previous_operation_audit_digest || canonical_event_bytes)`,
where `canonical_event_bytes` is the exact 112-byte telemetry prefix through
`event_id` plus a zeroed 32-byte audit-digest field. `audit_sequence` increments
once per appended event; event bytes include status, direction, reason, bytes,
count and operation scope.

Import requires a newly created context with the same explicit CUDA device
UUID/runtime/build/deterministic identity and an already uploaded static
descriptor whose digest matches the payload. Its H2D event reason is exactly
`checkpoint_import_h2d`. The runtime validates header, checked sizes,
endianness, feature/version table, every section digest, overall SHA-256,
device/build/layout/operator/source IDs and workspace limit before allocating
provisional restore buffers. It then uploads all committed arrays and warm
starts, recomputes device digests, and performs one atomic restore only if
every digest matches. Failure frees provisional buffers and returns to
`static_uploaded` without an accepted snapshot, field revision, warm start or
scientific-state commit. Every actual transfer remains observable: an import
that fails after H2D appends the failure event with the actual bytes, count and
status before provisional scientific rollback. No
failure path deletes or rewinds the operation audit.
A failed checkpoint_import_h2d therefore remains a first-class audit event.

Successful restore creates fresh process-local handle tokens while preserving
`snapshot_lineage_id`, `accepted_sequence` and `snapshot_content_digest`; the
new registry generation is deliberately not serialized. `checkpoint_import`
commits either `restored_charge_accepted` or `restored_spin_accepted` and
continues from the serialized warm-start/restart position. Bitwise restart
means that, on the same device UUID/runtime/build and deterministic policy,
the restored content digest is identical and the next accepted field,
balance, iteration, deterministic-compute and
`scientific_continuation_digest` values equal the uninterrupted run. The
full telemetry stream is not compared: uninterrupted and restarted runs have
different valid export/import events. Qualification instead verifies those
events and their `operation_audit_digest` parent chain separately. Cross-
device, cross-build, cross-layout, partial-section and deterministic-policy
mismatches return `checkpoint_incompatible`; there is no migration or
deterministic re-solve fallback.

#### Error model and fail-closed combinations

All operations return a stable status and, when the result prefix permits, a
`fullmag_fdm_gpu_transport_error_v1`. Required v1 statuses are:

```text
ok
unsupported
incompatible_abi
invalid_descriptor
invalid_pointer_space
invalid_state
out_of_memory
nonconverged
balance_failure
stale_snapshot
strict_gpu_residency_violation
cuda_runtime_error
live_snapshot
already_destroyed
out_of_resources
unsupported_required_feature
checkpoint_incompatible
```

GPU unavailable, CUDA/device mismatch, precision other than FP64, FP32,
non-strict residency, unsupported periodic/M2/M3/SML/multi-device features,
missing component gauge, invalid exact-density face, missing interface trace,
wrong-context or stale snapshot, workspace exhaustion, nonconvergence, balance
failure, and forbidden transfer all fail closed. No status authorizes CPU
charge/spin solve, host field reconstruction, precision downgrade, or another
backend. Capability query reports only the implemented and qualified tuple; a
future ABI symbol alone must not report this milestone executable.

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
