# Frequency-driven solver - COMSOL-aligned V5.1 full pack

<!-- BEGIN 00_README_CANONICAL_FULL_READ.md -->
---
title: FEM frequency-domain documentation entrypoint
version: COMSOL-aligned v5.1 decision-complete
status: canonical
scope: FEM frequency-domain documentation
---

# FEM frequency-domain documentation

This directory is the canonical FEM frequency-domain masterplan package. Its
manifest assigns a role to every active document and identifies generated and
historical material.

## Authority hierarchy

1. `docs/physics` defines equations and units.
2. `docs/architecture` and `docs/specs` define ownership and public architecture.
3. Masterplan normative documents define implementation order.
4. Status and readiness documents record current evidence only.
5. `old/` is historical and never normative.

The V5 full pack is a deterministic generated projection of manifest-declared
Markdown inputs. It is not an independent authority; update source documents
and regenerate it through the declared Task 10 tooling when those inputs change.

## Document roles

- **normative** documents define durable required design and implementation
  order and cannot contain dated append-only implementation evidence.
- **validation** documents define certification and benchmark expectations.
- **implementation_status** documents record source, artifact, or runtime evidence.
- **supporting** documents provide inventory, migration, and traceability context.

Documents `08`, `16`, and `18` are transitional
**implementation_status** documents with `target_role=normative` in the
manifest. Their owner Tasks 5, 4, and 6 respectively must rewrite the active
bodies before promotion.

## Production-claim schema

Every production claim must include `validated_scope` as `null` when
unvalidated or as a content-addressed readiness-scope binding when validated,
plus exactly one `implementation_state` from `absent`, `contract_only`,
`source_visible`, or `executable`, and one `validation_state` from `unvalidated`,
`algebra_validated`, `physics_validated`, or `production_qualified`.
`production_executable` does not imply `production_qualified`, and a narrow
validated scope cannot promote a broader capability. The manifest is the
machine-readable definition of this schema.

## Read order for implementers

1. Read the applicable physics note and architecture/specification document.
2. Read this entrypoint and `01_full_read_inventory_and_resolution.md`.
3. Read normative documents in manifest order: `02` through `07`, `12`, then
   planned `23` and `24` when they are created.
4. Use validation documents `09` and `15` to define acceptance evidence.
5. Consult implementation-status documents only to establish the current
   boundary; they do not alter normative requirements.

## Read order for status auditors

1. Read this entrypoint, the manifest, and the applicable physics and
   architecture/specification documents.
2. Read implementation-status documents `08`, `10`, `11`, `16`, `17`, `18`,
   `19`, and `20` in manifest order.
3. Read the readiness matrix and content-addressed scope catalog `25`; they are
   linked by the Markdown status chapter rather than duplicated in the full pack.
4. Validate claims with the named runtime gates and their artifacts.

FDM is outside this package's scope. Documentation and source inspection do
not establish production proof; required runtime gates and their evidence do.

## Historical material

The `old/` directory contains frozen source snapshots for superseded documents.
They may be consulted for provenance but must not define current physics,
algorithms, implementation order, or implementation status.
<!-- END 00_README_CANONICAL_FULL_READ.md -->

<!-- BEGIN 01_full_read_inventory_and_resolution.md -->
---
title: FEM frequency-domain inventory and document resolution
version: COMSOL-aligned v5.1 decision-complete
status: supporting
scope: documentation roles and source provenance
---

# Inventory and resolution

`documentation_manifest.json` is the machine-readable inventory of active
documents. It supplies ordering, roles, full-pack inclusion, and planned
availability. The README supplies the human read order.

## Resolution policy

The authority hierarchy in `00_README_CANONICAL_FULL_READ.md` resolves all
conflicts. Physics notes own equations and units; architecture and
specifications own public and subsystem contracts; normative masterplan
documents own implementation order; status documents own current evidence.
Historical copies have no authority outside provenance review.

The active root contains no historical document role. Superseded source bodies
are frozen under `old/` with an explicit historical header. Their names are:

- `09_validation_certification_benchmarks_legacy_2026-07-10.md`
- `10_patch_queue_current_status_legacy_2026-07-10.md`
- `11_runtime_telemetry_performance_legacy_2026-07-10.md`
- `16_implementation_plan_Kittel_D2_completed_2026-07-10.md`
- `17_eigen_k0_gpu_readiness_audit_legacy_2026-07-10.md`
- `18_poisson_airbox_eigensolve_cpu_gpu_legacy_2026-07-10.md`
- `19_physics_numerics_audit_original_2026-07-10.md`
- `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5_legacy_2026-07-10.md`

## Active-package rules

- The V5 full pack is stale and disabled: `full_pack_generated=false` and its
  active file is a non-authoritative pointer to the README and manifest.
- Task 10 may regenerate the full pack only after all manifest-declared
  canonical inputs are complete and transitional documents are promoted.
- The readiness matrix is JSON evidence and is excluded from the full pack.
- The Markdown status chapter links the readiness matrix rather than copying it.
- Documents `23`, `24`, and `25` are planned manifest entries until their
  assigned tasks create them.
- Document `20` is an active implementation-status document owned by the
  parallel remediation plan.
- Documents `08`, `16`, and `18` are transitional implementation-status
  documents. Their `target_role` is normative, but only Tasks 5, 4, and 6 may
  promote them after rewriting their dated append-only evidence.
- Numbers `21` and `22` are intentionally not assigned by this plan.

Every production claim uses the manifest-required `implementation_state`,
`validation_state`, and non-empty `validated_scope`. Production-executable
does not mean production-qualified, and narrow validation cannot promote a
broader capability.

This package concerns FEM frequency-domain work only. Runtime gates and their
artifacts, not document text, establish executable or production status.
<!-- END 01_full_read_inventory_and_resolution.md -->

<!-- BEGIN 02_physics_contract.md -->
---
title: Frequency-driven solver - COMSOL-aligned physics contract
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# COMSOL-aligned physics contract

Every backend must solve the same physics.

Current authority is split across
[physics note 0700](../../../physics/0700-frequency-domain-linearized-llg.md)
for absorbed power and the existing physics/sign rules,
[physics note 0830](../../../physics/0830-fem-poisson-airbox-modal-eigen.md)
for the Poisson modal-eigen contract, and
[`FrequencyOperatorDictionary.v1` in physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md)
for the dynamic-pencil dictionary portions it currently defines. The equations
below are normative masterplan requirements and do not define backend-selectable
conventions. Consolidating the general `D_R`/`D_I` split and
`p_abs`/`absorbed_by_magnetization` into note 0831 remains parallel-plan work;
once complete, that note is the target sole dictionary authority.

## 1. Canonical ansatz and equation

```text
m(r,t) = m0(r) + Re(delta_m(r) exp(+i omega t))
delta_m << m0
m0 · delta_m = 0
H_eff(r,t) = h_eff0(r) + Re(delta_h_eff(r) exp(+i omega t))
gamma0 = mu0 * abs(gamma)
```

All effective fields and drive phasors are in `A/m`. Here `gamma` is the
gyromagnetic ratio magnitude in `rad/(s T)` and `gamma0` is the coefficient for
`A/m` fields, in `rad s^-1 per (A/m)`.

Linearized LLG:

```text
i omega delta_m
  = - gamma0 [m0 x delta_h_eff[delta_m] + delta_m x h_eff0]
    + i omega alpha m0 x delta_m
    + tau_lin[delta_m]
```

The canonical phase convention is:

```text
exp_plus_i_omega_t
```

## 2. Public and internal unknowns

Public physical unknown:

```text
delta_m_i = (dmX_i, dmY_i, dmZ_i) in C^3
m0_i · delta_m_i = 0
```

Internal tangent unknown:

```text
T_i = [e1_i, e2_i]
q_i = (u_i, v_i) in C^2
delta_m_i = T_i q_i
```

Public artifacts must expose Cartesian fields. Tangent `u/v` is provenance or internal debug data.

## 3. Dynamic drive

Default user drive is a dynamic external field phasor:

```text
delta_h in C^3, unit A/m
```

No user-supplied sinusoid belongs in the value. The solver attaches `exp(+i omega t)`.

Canonical projection into RHS:

```text
b_cart = - gamma0 (m0 x delta_h)
b_tangent = T^T b_cart
```

This sign follows from moving the external-drive term to the RHS of the canonical equation. It must be locked by macrospin and dense Cartesian sign tests.

## 4. DriveKind

```cpp
enum class FrequencyDriveKind : std::uint32_t {
    dynamic_field_phasor_a_per_m = 1,
    tangent_rhs = 2,
    cartesian_torque_phasor = 3,
    stt_current_phasor = 4,
    coupled_external_provider = 5,
};
```

Rules:

```text
dynamic_field_phasor_a_per_m: public COMSOL-style drive.
tangent_rhs: low-level solver/benchmark/debug input.
cartesian_torque_phasor: physical torque-source input.
stt_current_phasor: current/STT source.
coupled_external_provider: source from another physics subsystem.
```

## 5. Zero-drive policy

```text
FrequencyResponse + physical drive_kind + zero drive:
    valid zero response + warning.

SolverBenchmark + tangent_rhs + require_nonzero_rhs=true:
    validation_error.

Eigenfrequency/modal:
    no drive required.
```

## 6. Static linearization state

Frequency-domain solve must use a consistent static state:

```text
|m0| = 1
m0 x h_eff0 approximately 0
```

The equilibrium may be nonuniform and metastable. It still must carry diagnostics:

```text
max_m0_norm_error
max_relative_torque_residual
max_m0_cross_heff0_relative
energy trend acceptance
```

## 7. Effective fields

Static:

```text
h_eff0 = h_exchange0
       + h_anisotropy0
       + h_external0
       + h_DMI0
       + h_demag0
       + h_custom0
```

Dynamic:

```text
delta_h_eff[delta_m] = delta_h_exchange[delta_m]
                         + delta_h_anisotropy[delta_m]
                         + delta_h_DMI[delta_m]
                         + delta_h_demag[delta_m]
                         + delta_h_custom[delta_m]
delta_h_total = delta_h_eff[delta_m] + delta_h_drive
```

Linearized non-field torques belong to `tau_lin[delta_m]`; the external field
drive appears once, in the canonical RHS.

Fields are in `A/m` unless a source explicitly declares otherwise with conversion provenance.

## 8. Modal, driven, and internal real-split contract

The canonical modal and driven equations are:

```text
L q = lambda B q
lambda = i omega
(i omega B - L) q = b
b = T^T[-gamma0 (m0 x delta_h_drive)]
```

`B` denotes the damping-aware `B_alpha` of note 0831. In the physical
energy-Hessian form, `L=K` and `B=-G` for `alpha=0`, so the modal equation is
`K phi = -i omega G phi`.

For the general complex driven operator,

```text
D(omega) = i omega B - L = D_R + i D_I
[ D_R  -D_I ] [q_R] = [b_R]
[ D_I   D_R ] [q_I]   [b_I]
```

For real `K=-L` and `M=B`, `D=K+i*omega*M`, so the corresponding shortcut is

```text
[ K        -omega M ] [q_R] = [b_R]
[ +omega M  K       ] [q_I]   [b_I]
```

This shortcut is permitted only with that explicit `K`/`M` mapping. The real
split is an algebraic representation, not a second physics convention.

For `lambda=lambda_r+i lambda_i`, `omega=-i lambda`. The positive undamped
branch has `lambda_i>0`, and
`frequency_hz=Re(omega)/(2*pi)=lambda_i/(2*pi)`. A requested angular-frequency
target maps to `sigma=i*omega_target`. A real PETSc/SLEPc build must encode that
complex target through the explicit real-split transformed pencil; passing a
real `EPSSetTarget(omega_target)` is forbidden unless a separately named
real-frequency pencil and its mapping have been derived.

## 9. Damping, linewidth, and absorbed power

For the canonical phasor convention:

```text
omega_complex = omega_r + i Gamma
exp(i omega_complex t) = exp(i omega_r t - Gamma t)
Gamma > 0 for decay
damping_rate_hz = Gamma/(2*pi)
linewidth_fwhm_hz = Gamma/pi
```

The absorbed-power observable and its SI derivation are currently authoritative
in [note 0700](../../../physics/0700-frequency-domain-linearized-llg.md):

```text
p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)
observable = absorbed_by_magnetization
```

`delta_m` is dimensionless, so `Ms` is required. Positive Gilbert damping must
produce positive absorbed power near resonance.

## 10. DMI status

```text
DMI volume operator: production only after Cartesian/tangent tests.
DMI frequency-domain boundary terms: experimental/unsupported unless separately certified.
Only one DMI kind may be active at once.
```

## 11. Minimal result JSON

```json
{
  "physics_contract": "micromagnetics_frequency_domain_v5",
  "phasor_convention": "exp_plus_i_omega_t",
  "unknown_physics_representation": "cartesian3_complex_constrained",
  "unknown_internal_representation": "tangent2_complex",
  "constraint": "m0_dot_delta_m_zero",
  "drive_kind": "dynamic_field_phasor_a_per_m",
  "effective_field_units": "A_per_m",
  "operator_dictionary": "FrequencyOperatorDictionary.v1",
  "eigenvalue_mapping": "lambda=i*omega",
  "absorbed_power_observable": "absorbed_by_magnetization",
  "time_reconstruction": "m(t)=m0+Re(delta_m*exp(+i*omega*t))"
}
```
<!-- END 02_physics_contract.md -->

<!-- BEGIN 03_relaxed_texture_linearization.md -->
---
title: Frequency-driven solver - relaxed texture linearization
version: target v6 contract over current v5 runtime
date: 2026-07-10
status: normative target; v6 runtime schema and consumers not yet implemented
---

# Relaxed texture handoff and LinearizationState

## 1. Authority and target status

This chapter consumes `FrequencyOperatorDictionary.v1` from
[physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md).
It defines the target `EquilibriumArtifact.v6` and `LinearizationState.v6`
documentation contracts. It does not claim that the target-v6 schemas,
materializers, builder, planner consumers, or runtime consumers exist.

The current executable contract remains v5 until every producer and consumer
has migrated and the corresponding runtime evidence has been accepted. A v5
artifact must not be relabelled as v6 without explicit migration and validation.

## 2. Accepted equilibrium is a hard input

Frequency-domain analysis around a nonlinear magnetic state consumes an
accepted equilibrium artifact. Driven and modal solvers must not relax,
reconstruct, or silently substitute equilibrium state.

```text
relaxation or certified static solve
  -> accepted EquilibriumArtifact.v6
  -> LinearizationState.v6 builder
  -> tangent frames and periodic mesh certificate
  -> FrequencySolvePlanner
  -> selected backend
```

The target artifact has a conditional shape selected by the required
`phi0_requirement` discriminator. The branch in which scalar-potential restart
or provenance is required is:

```json
{
  "schema_version": "EquilibriumArtifact.v6",
  "accepted_for_linearization": true,
  "stop_reason": "torque_tolerance",
  "m0": "fields/m0_unit.zarr",
  "h_eff0_a_per_m": "fields/h_eff0_a_per_m.zarr",
  "h_demag0_a_per_m": "fields/h_demag0_a_per_m.zarr",
  "phi0_requirement": "required_for_restart_or_provenance",
  "phi0_a": "fields/phi_demag0_a.zarr",
  "mesh_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "material_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "physics_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "boundary_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "static_demag_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "max_m0_norm_error": 0.0,
  "max_m0_cross_h_eff0_relative": 0.0
}
```

`accepted_for_linearization=true` is valid only when `stop_reason` is an
accepted convergence or independently certified equilibrium reason under the
producer schema. Reaching a step, iteration, or wall-time limit is not implicit
acceptance. The artifact records the acceptance tolerances and producer run ID
in its provenance envelope.

`m0`, `h_eff0_a_per_m`, and `h_demag0_a_per_m` are required in both branches.
`phi0_requirement` is also required and has exactly these conditional-schema
rules:

| `phi0_requirement` | Canonical `phi0_a` shape |
|---|---|
| `required_for_restart_or_provenance` | required nonempty artifact reference |
| `not_required_by_resolved_demag_realization` | field must be absent |

Omission is the sole canonical representation for the not-required branch;
JSON `null` is invalid in both branches. The selected resolved static-demag
realization determines the discriminator. Validation rejects a missing or
unknown discriminator, a discriminator inconsistent with that realization, a
missing/empty `phi0_a` in the required branch, or any present `phi0_a` in the
not-required branch.

## 3. Static-field provenance and comparison

Every stored static field carries:

```text
field role and SI unit
content sha256
producer run and implementation identity
mesh/material/physics/boundary/static-demag signatures
resolved demag realization and BC/gauge tuple where applicable
```

If the builder recomputes `h_eff0`, `h_demag0`, or conditionally required
`phi0`, the recomputation must use the same five signatures as the accepted
artifact. It records the recomputed content hash, implementation identity,
comparison norm, comparison tolerance, and pass/fail result against the stored
field. A passing recomputed field may be selected only with explicit
`field_source=recomputed_verified` provenance. It cannot silently replace the
stored field. A signature mismatch, missing comparison, or failed comparison
invalidates the handoff.

Static and dynamic demag remain separate:

```text
static:  m0 -> h_demag0, phi0 -> component of h_eff0
dynamic: delta_m -> delta_h_demag[delta_m], delta_phi -> operator block
```

The static term enters the dictionary contribution
`-gamma0 * (delta_m x h_eff0)`. Dynamic demag is assembled or applied by the
linearized operator and is never recovered from static-field provenance.

## 4. LinearizationState.v6

The builder emits an immutable state only after all acceptance and identity
checks pass:

```json
{
  "schema_version": "LinearizationState.v6",
  "source_equilibrium_artifact": "sha256:...",
  "operator_dictionary": "FrequencyOperatorDictionary.v1",
  "accepted_for_frequency_operator": true,
  "m0": "fields/m0_unit.zarr",
  "h_eff0_a_per_m": "fields/h_eff0_a_per_m.zarr",
  "h_demag0_a_per_m": "fields/h_demag0_a_per_m.zarr",
  "phi0_requirement": "required_for_restart_or_provenance",
  "phi0_a": "fields/phi_demag0_a.zarr",
  "mesh_signature": "sha256:...",
  "material_signature": "sha256:...",
  "physics_signature": "sha256:...",
  "boundary_signature": "sha256:...",
  "static_demag_signature": "sha256:...",
  "static_field_provenance": "sha256:...",
  "tangent_frame_policy": "sha256:...",
  "periodic_mesh_certificate": "sha256:..."
}
```

`LinearizationState.v6` copies `phi0_requirement` from the accepted artifact and
validates it again against the selected resolved static-demag realization. In
the required branch, `phi0_a` is a required nonempty reference to the verified
potential payload. In the not-required branch, `phi0_a` must be absent. JSON
`null` is invalid, and the builder must not change branches or synthesize a
not-required reason. The periodic certificate is required only for a
periodic/Floquet request; otherwise its explicit value is `not_applicable`. The
builder records frame orthogonality, handedness, and equilibrium residual
diagnostics in the state provenance.

Required checks are:

```text
accepted_for_linearization is true and stop_reason is acceptable
all required field payloads exist and their content hashes verify
mesh/material/physics/boundary/static-demag signatures match the request
m0 ordering matches the magnetic FE space and max_m0_norm_error passes
max_m0_cross_h_eff0_relative passes the declared acceptance tolerance
stored or recomputed static fields satisfy the provenance comparison policy
periodic_mesh_certificate.v6 is accepted when periodic/Floquet is requested
```

## 5. Invalidation and reject reasons

The state key covers the source artifact digest, all five signatures, required
field content hashes, static-field provenance, tangent-frame policy, and the
periodic certificate identity. Any covered input change creates a new state;
cache reuse under an old state ID is forbidden.

| Change | Required result |
|---|---|
| magnetic or airbox mesh/topology/FE ordering | invalidate fields, frames, periodic certificate, and state |
| material coefficients or region assignment | invalidate static fields and state |
| enabled physics, parameters, or static external field | invalidate static fields and state |
| static boundary or periodic policy | invalidate static fields, certificate, and state |
| static demag realization, assembly, BC/gauge, or solver-defining policy | invalidate static-demag fields and state |
| `m0` or required static-field content | invalidate state and rebuild from a newly accepted artifact |
| drive, output selection, or frequency window only | retain state if no covered signature changes |

Machine-readable rejection uses exact reasons:

```text
equilibrium_artifact_missing
equilibrium_artifact_not_accepted_for_linearization
equilibrium_stop_reason_not_accepted
equilibrium_mesh_hash_mismatch
equilibrium_material_hash_mismatch
equilibrium_physics_hash_mismatch
equilibrium_boundary_hash_mismatch
equilibrium_static_demag_hash_mismatch
equilibrium_required_field_missing
equilibrium_field_content_hash_mismatch
equilibrium_static_field_comparison_missing
equilibrium_static_field_comparison_failed
equilibrium_phi0_requirement_mismatch
equilibrium_phi0_required_missing
equilibrium_phi0_forbidden_present
equilibrium_m0_norm_error_too_large
equilibrium_torque_residual_too_large
equilibrium_periodic_certificate_missing_or_stale
```

## 6. Current-v5 to target-v6 migration

| Current v5 | Target v6 | Migration rule |
|---|---|---|
| `frequency_domain_equilibrium.v5` | `EquilibriumArtifact.v6` | create a new artifact; do not change the version token in place |
| `accepted_for_linearization` | same field plus `stop_reason` | recover an accepted producer reason or reject migration |
| nested `fields.m0_unit` | top-level `m0` | copy path and verify content hash |
| nested `fields.h_eff0_a_per_m` | top-level `h_eff0_a_per_m` | copy path, unit, signatures, and field provenance |
| nested `fields.h_demag0_a_per_m` | top-level `h_demag0_a_per_m` | copy path and bind `static_demag_signature` |
| implicit scalar-potential requirement | required `phi0_requirement` discriminator | derive from the resolved static-demag realization or reject migration |
| nested `fields.phi_demag0` | conditional top-level `phi0_a` | required branch: copy with unit `A`; not-required branch: omit the field; never emit `null` |
| snapshot and mesh IDs | five canonical signatures | recompute canonical sha256 signatures; IDs alone are insufficient |
| `max_relative_torque_residual` | `max_m0_cross_h_eff0_relative` | recompute under the v6 normalization; do not rename blindly |
| implicit static-field reuse | explicit stored/recomputed comparison provenance | compare or reject migration |
| v5 builder output | `LinearizationState.v6` | rebuild after all v6 checks; no wrapper-only conversion |

## 7. Production boundary

This file closes the target documentation contract only. Current v5 planner and
builder checks are not evidence of target-v6 artifact materialization,
migration, ingestion, or runtime consumption. Production status may advance
only after the v6 schemas, all producers and consumers, rejection paths, and
managed validation evidence exist.
<!-- END 03_relaxed_texture_linearization.md -->

<!-- BEGIN 04_mesh_periodic_floquet_airbox.md -->
---
title: Frequency-driven solver - mesh symmetry, periodic, Floquet and airbox
version: target v6 contract over current v5 runtime
date: 2026-07-10
status: normative target; v6 runtime schema and consumers not yet implemented
---

# Mesh symmetry, periodic/Floquet and airbox contract

## 1. Authority and strict matched-mesh policy

This chapter consumes the nonzero-k phase and dynamic-demag semantics from
[physics note 0828](../../../physics/0828-fem-frequency-domain-floquet-demag.md)
and the K0 Poisson boundary/gauge semantics from
[physics note 0830](../../../physics/0830-fem-poisson-airbox-modal-eigen.md).

Target-v6 production FEM periodic/Floquet frequency-domain uses a matched
symmetric mesh and complete periodic equivalence classes. Nonmatching faces
require a separately named mortar/interpolation backend and are not accepted by
this contract. This chapter defines `periodic_mesh_certificate.v6`; it does not
claim that its schema or runtime consumers are implemented.

## 2. Complete periodic equivalence classes

A pair list is input evidence, not the canonical topology. The certificate
closes the transitive relation and stores one class for every periodic orbit:

```text
representative_dof
members[]
translation_from_representative[]
orientation_transform[]
material_region
boundary_role
```

`members`, translations, and orientation transforms have identical ordering.
The representative is included with zero translation and identity transform.
Magnetic classes cover the magnetic FE space. Scalar classes independently
cover the full shared magnetic-plus-airbox scalar FE space.

Corners and edges touched by more than one periodic face belong to one closed
class. The builder must merge all paths to the same member and verify identical
lattice translation and orientation transform within tolerance. It emits one
representative-to-member constraint per nonrepresentative member. Contradictory
duplicate constraints, path-dependent corner phases, incomplete side coverage,
or one DOF assigned to multiple representatives reject the certificate.

The target certificate contains at least:

```json
{
  "schema_version": "periodic_mesh_certificate.v6",
  "certificate_status": "accepted",
  "magnetic_class_count": 0,
  "magnetic_pair_count": 0,
  "scalar_class_count": 0,
  "scalar_pair_count": 0,
  "magnetic_equivalence_classes_sha256": "sha256:...",
  "scalar_equivalence_classes_sha256": "sha256:...",
  "translation_residual_max_m": 0.0,
  "orientation_residual_max": 0.0,
  "normal_mismatch_max": 0.0,
  "boundary_topology_match": true,
  "fe_order_match": true,
  "material_region_match": true,
  "corner_edge_cycle_unique": true,
  "m0_seam_mismatch_max": 0.0,
  "h_demag0_seam_mismatch_max": 0.0
}
```

For each space, `class_count` is the number of nontrivial closed classes and
`pair_count = sum(class.members.length - 1)`. Hash input is canonicalized by
representative, member, translation, orientation, material region, boundary
role, FE-space identity, and tolerance policy. Magnetic and scalar hashes are
separate and neither may stand in for the other. The certificate also records
input relation counts, unmatched counts, and topology/orientation/translation
residual tolerances in its provenance envelope.

## 3. Physical and tangent-coordinate transfer

For a source/destination relation, let `R_orient` be the physical vector
orientation transform, `R_lattice = r_dst - r_src` the lattice translation,
and `phase = exp(-i*k dot R_lattice)`. The Cartesian conditions are:

```text
delta_m_dst = phase R_orient delta_m_src
delta_phi_dst = phase delta_phi_src
```

With `delta_m = T q`, the magnetic transfer is exactly:

```text
G_pair = T_dst^T R_orient T_src
q_dst = exp(-i*k dot R_lattice) G_pair q_src
```

Phase-only scalar periodicity must not be imposed on tangent coordinates `q`
unless `G_pair` is certified as identity within tolerance.

### Tangent-frame gauge invariance

Let arbitrary independent local frame rotations be
`T'_src = T_src S_src` and `T'_dst = T_dst S_dst`, with
`S_src,S_dst in SO(2)`. Coordinates and transfer then transform as:

```text
q'_i = S_i^T q_i
G'_pair = S_dst^T G_pair S_src
q'_dst = phase G'_pair q'_src
```

The production Bloch operator and the matched-constraint oracle must transform
by the corresponding block-coordinate similarity/congruence. Arbitrary SO(2)
frame-gauge rotations must preserve the eigenvalue set, original-operator
residuals, and reconstructed Cartesian fields `T'_i q'_i = T_i q_i` within
declared tolerances. Testing only a globally constant frame rotation is
insufficient.

## 4. Exact K0 outer-boundary and gauge tuple

The scalar block accepts only these tuples:

```text
poisson_robin(beta>0) -> gauge_policy=none, no eta row
poisson_dirichlet     -> gauge_policy=none, eliminated boundary DOFs, no eta row
pure_neumann          -> gauge_policy=mean_zero_augmented, eta row present
```

For `pure_neumann`, the augmented rows are `P phi + c eta = rhs` and
`c^T phi = 0`. The mean functional `c` is assembled from the active scalar FE
space and its quadrature. It may contain zero weights for eliminated or
inactive entries. A global strictly positive weight rule is forbidden.

Lateral periodic constraints alone do not create a gauge nullspace. Robin and
Dirichlet open-boundary policies remain coercive after lateral K0 reduction and
must not receive an eta row or a mean-zero projection.

## 5. Production nonzero-k operator and matched-mesh oracle

The target-v6 production nonzero-k dynamic-demag realization assembles the
complex Bloch `grad_k`/`div_k` weak forms on the shared magnetic-plus-airbox
domain. The magnetic source, scalar Poisson block, and potential-to-field
feedback must all use that k-dependent complex assembly. Reusing the K0
operator with phase-modified inputs or outputs is forbidden.

The production Bloch differential operators and their complex weak forms use
the same `exp(-i*k dot R_lattice)` convention as the periodic transfer in
Section 3. Their k-dependent signs must be derived consistently from that
negative-phase convention; an opposite-sign assembly is a different contract,
not an interchangeable implementation.

Matched-mesh complex constraints remain an independent reference/oracle for
both magnetic tangent unknowns and scalar potential:

```text
q_full = C_m(k) q_reduced
phi_full = C_phi(k) phi_reduced
C(k) = block_diag(C_m(k), C_phi(k))
A_reduced(k) = C(k)^H A_full C(k)
```

Every representative-to-member entry in both `C_m(k)` and `C_phi(k)` uses the
same `exp(-i*k dot R_lattice)` convention, where `R_lattice` is that member's
lattice translation from its representative. `C_m(k)` additionally applies
`G_pair`; `C_phi(k)` is phase-only. The oracle uses the same maps to reduce
every coupled operator block, mass block, RHS, and residual reconstruction.
Oracle constraint application occurs before solving and is part of the oracle
operator.

For a real split, the complex phase is represented by its exact 2x2 real block;
it is not dropped or approximated as a real periodic constraint.

The production `grad_k`/`div_k` representation and matched-constraint oracle
may be declared equivalent only after automated matrix parity on assembled
fixtures and action parity on matrix-free fixtures over the accepted k domain.
Parity includes magnetic/scalar coupling, signs, BC/gauge handling, residuals,
and reconstructed Cartesian fields. Passing at K0 alone is insufficient. Until
that evidence exists, the oracle is not a production substitute or fallback
for missing complex Bloch assembly.

Applying phase to a solved K0 field, viewport payload, or exported mode is a
postsolve projection. Postsolve projection is not an operator and cannot
implement nonzero-k exchange, DMI, or dynamic demag.

## 6. Static and dynamic airbox requirements

```text
magnetic and scalar equivalence-class hashes are accepted
static equilibrium uses the matching mesh, boundary, and static-demag signatures
magnetic q and scalar phi use one exp(-i*k dot R_lattice) phase convention
corner/edge cycles are unique in both FE spaces
normal-flux checks account for opposite outward normals on paired faces
the exact outer-boundary/gauge tuple is recorded
```

Static `h_demag0`/`phi0` provenance belongs to `EquilibriumArtifact.v6`.
Dynamic `delta_phi` and `delta_H_demag` belong to the complex Bloch coupled
operator. A K0 static Poisson solve, a magnetic-only phase constraint, or a
postsolve phase projection is not nonzero-k dynamic demag.

## 7. Current-v5 to target-v6 migration

| Current v5 | Target v6 | Migration rule |
|---|---|---|
| `periodic_mesh_certificate.v5` | `periodic_mesh_certificate.v6` | build and validate a new certificate; do not relabel v5 |
| magnetic/airbox pair maps | closed magnetic/scalar equivalence classes | compute transitive closure and reject contradictory paths |
| pair-map fingerprints and hashes | canonical class hashes per FE space | hash full classes, transforms, roles, regions, and policy |
| one aggregate `pair_count` | class and representative-pair counts per FE space | derive counts after corner/edge merging |
| stored pairwise 2x2 blocks | class-consistent `G_pair` transfers | validate every representative-to-member path |
| duplicate-pair rejection | corner/edge cycle uniqueness | reject duplicate representatives and path-dependent closure |
| gauge-policy presence check | exact BC/gauge/eta tuple | rebuild scalar block policy from boundary kind |
| pairwise phase metadata | production complex Bloch `grad_k`/`div_k` plus independent `C_m(k)`/`C_phi(k)` oracle | assemble both representations with the same negative phase convention; require accepted-domain matrix/action parity before equivalence |
| no frame-gauge certificate | local SO(2) invariance evidence | rerun operator/eigenfield parity under independent frame rotations |

## 8. Production boundary

This file closes the target documentation contract only. Existing v5 pair-map
artifacts, candidate certificates, K0 providers, or planner checks do not prove
target-v6 equivalence-class construction, complex Bloch `grad_k`/`div_k`
assembly, matched-constraint oracle parity, frame-gauge invariance, or runtime
consumption. Production status may advance only after v6 schemas and consumers
exist and the required CPU/GPU, K0/nonzero-k, modal/driven validation scopes are
separately evidenced.
<!-- END 04_mesh_periodic_floquet_airbox.md -->

<!-- BEGIN 05_algebra_and_operator_representations.md -->
---
title: Frequency-driven solver - algebra and operator representations
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Algebra and operator representations

Current authority is split across
[physics note 0700](../../../physics/0700-frequency-domain-linearized-llg.md)
for absorbed power and the existing physics/sign rules,
[physics note 0830](../../../physics/0830-fem-poisson-airbox-modal-eigen.md)
for the Poisson modal-eigen contract, and
[`FrequencyOperatorDictionary.v1` in physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md)
for the dynamic-pencil dictionary portions it currently defines. The equations
below remain normative masterplan requirements. Consolidating the general
`D_R`/`D_I` split and `p_abs`/`absorbed_by_magnetization` into note 0831 remains
parallel-plan work; once complete, that note is the target sole dictionary
authority.

## 1. Layer separation

```text
Physics:       Cartesian delta_m, constraint m0·delta_m=0, fields in A/m
Adapter:       delta_m = T q
Algebra:       D(omega)q=(i omega B-L)q=b
Representation: dense/sparse/full-coupled/Schur/modal/GPU
Engine:        backend-specific solve
```

Callbacks must not secretly mix those layers without diagnostics.

## 2. Cartesian constrained oracle

Tiny physical oracle:

```text
[ A_cart  C^T ] [delta_m] = [b]
[ C       0   ] [lambda ]   [0]
```

or tangent elimination:

```text
A_t = T^T A_cart T
b_t = T^T b_cart
```

## 3. Tangent 2-DOF operator

```text
q in C^(2N)
delta_m = T q
```

Canonical modal and driven forms:

```text
L q = lambda B q
lambda = i omega
D(omega) q = (i omega B - L) q = b
b = T^T[-gamma0 (m0 x delta_h_drive)]
gamma0 = mu0 * abs(gamma)
```

Here fields are in `A/m`, `gamma` is explicitly typed in `rad/(s T)`, and
`gamma0` is in `rad s^-1 per (A/m)`. For `L=K` in the physical energy-Hessian
form, `B=-G` at `alpha=0`, giving `K phi=-i omega G phi`.

The general real split is:

```text
D(omega) = D_R + i D_I
[ D_R  -D_I ] [q_R] = [b_R]
[ D_I   D_R ] [q_I]   [b_I]
```

For real `K=-L` and `M=B`, `D=K+i*omega*M`, so the corresponding shortcut is

```text
[ K        -omega M ] [q_R] = [b_R]
[ +omega M  K       ] [q_I]   [b_I]
```

Backends may use this shortcut only with that explicit mapping and may not infer
it from matrix shape.

## 4. Full-coupled demag/airbox

Reference production form:

```text
[ A_qq(omega)  A_qphi   ] [q]   = [b_q]
[ A_phiq       A_phiphi ] [phi] = [b_phi]
```

Full-coupled is needed for:

```text
true residual
Poisson/gauge/nullspace diagnostics
field-split preconditioner
Schur certification
```

For the Poisson-airbox descriptor, the accepted residual is reconstructed on
the original blocks:

```text
r_q     = A_qq q + A_qphi phi - lambda B_qq q
r_phi   = A_phiq q + P phi + c eta
r_gauge = c^T phi
eps_full = max(eps_q, eps_phi, eps_gauge)
```

The boundary/gauge tuple follows
[note 0830](../../../physics/0830-fem-poisson-airbox-modal-eigen.md): Robin with
`beta>0` and Dirichlet use no gauge; pure Neumann uses the quadrature-assembled
mean-zero augmentation. A lateral periodic constraint does not create a gauge
nullspace when the open boundary is coercive.

## 5. Schur reduced

```text
S(omega) = A_qq(omega) - A_qphi A_phiphi^-1 A_phiq
b_S      = b_q - A_qphi A_phiphi^-1 b_phi
```

Schur is only a certified fast path.

## 6. Sparse/direct

```text
assemble CSR/BSR real split
solve with direct sparse solver
compute true residual
```

In v5 status, the patch queue reports a PETSc `KSPPREONLY + PCLU` MVP for CPU sparse/direct baseline. This is a diagnostic production slice, not the final scalable sparse architecture.

## 7. Modal/eigen

Frequency sweeps should use modal or reduced-basis response when certified:

```text
x(omega) ≈ V c(omega)
```

The spectral mapping is:

```text
lambda = lambda_r + i lambda_i
omega = -i lambda
positive undamped branch: lambda_i > 0
frequency_hz = Re(omega)/(2*pi) = lambda_i/(2*pi)
sigma = i*omega_target
```

For real PETSc/SLEPc, `sigma` must be represented by the explicit real-split
transformed pencil. A real `EPSSetTarget(omega_target)` on the original
imaginary-eigenvalue spectrum is forbidden unless a separately named
real-frequency pencil is derived and its mapping is published.

Gilbert damping and nonconservative torques make the pencil non-Hermitian.
Those paths must not use Hermitian-only solvers or right-eigenvector-only modal
projection. Direct modal response requires left and right eigenvectors,
declared normalization, biorthogonality and conditioning diagnostics; otherwise
use a residual-certified Petrov-Galerkin/rational Krylov model or the full
solver.

Basis provenance must include:

```text
operator hash
equilibrium hash
material hash
boundary hash
demag hash
phase convention
frequency window
completeness certificate
```

## 8. Damping and response observables

```text
omega_complex = omega_r + i Gamma
exp(i omega_complex t) = exp(i omega_r t - Gamma t)
Gamma > 0 for decay
```

The dynamic-pencil definition and decay direction follow
[note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md),
which currently requires artifacts to carry the damping-rate and linewidth
mapping but does not define the exact formulas.

```text
damping_rate_hz = Gamma/(2*pi)
linewidth_fwhm_hz = Gamma/pi
p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)
observable = absorbed_by_magnetization
```

The exact damping-rate and FWHM-linewidth formulas, absorbed-power observable,
and absorbed-power formula are currently authoritative in
[note 0700](../../../physics/0700-frequency-domain-linearized-llg.md). These are
not backend-selectable signs. Positive Gilbert damping must yield positive
absorbed power near resonance.

## 9. GPU device representation

`gpu_device_krylov` requires device residency for:

```text
x, b, r, w, V, Z
operator buffers
preconditioner buffers
orthogonalization
residual estimate
```

Current host GMRES with GPU-backed operators remains `gpu_operator_host_krylov`.
<!-- END 05_algebra_and_operator_representations.md -->

<!-- BEGIN 06_solver_tree_planner_and_lanes.md -->
---
title: Frequency-domain solver tree, planner and engines
version: COMSOL-aligned v5.1 decision-complete
date: 2026-07-10
status: canonical
role: normative
---

# Solver tree, planner and engines

## 1. Scope and authority

This chapter defines the target FEM frequency-domain engine vocabulary and the
deterministic planner policy for `modal_eigen` and `driven_response`. Physics,
signs, units, scalar conventions and residual definitions remain owned by
`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`. Backend
ownership remains governed by `docs/architecture/backend-golden-masterplan.md`.

An engine name identifies a numerical algorithm and its residency. It is not a
synonym for device, product status or the current C ABI compatibility lane.

## 2. Normative engine vocabulary

Every accepted solve resolves to exactly one of these engines:

| Engine | Product and contract |
|---|---|
| `dense_cartesian_reference` | Tiny CPU/double Cartesian `3N` oracle with the physical constraint/projection applied explicitly. Reference only. |
| `dense_tangent_reference` | Tiny CPU/double tangent `2N` oracle for modal or driven parity, signs and residuals. Reference only. |
| `cpu_sparse_direct` | CPU PETSc AIJ direct diagnostic for one or a few driven frequencies after legal assembly and memory admission. |
| `cpu_host_krylov` | CPU host-resident Krylov solve of an assembled or matrix-free legal operator. |
| `full_coupled_field_split` | CPU full `delta_m`/auxiliary-field block solve using nested blocks and field-split preconditioning. |
| `schur_reduced` | CPU Schur modal or driven solve admitted only by a certificate keyed to the exact problem signature. |
| `modal_reduced` | CPU reduced-order sweep admitted only by modal completeness and independent sample checks. |
| `gpu_operator_host_krylov` | GPU operator or preconditioner with host-resident Krylov state and host reductions. This is not a device-resident solver. |
| `gpu_device_krylov` | GPU driven solve with device-resident vectors, operator, preconditioner and Krylov hot loop. |
| `gpu_modal_device_krylov` | GPU modal solve with device-resident PETSc/SLEPc vectors, operators, spectral-transform solves and eigensolver hot loop. |

The engine set is closed for this plan revision. New engines require an
explicit algorithm, legality, residual, residency, fallback and ownership
contract before they can enter planner output.

## 3. Legacy ABI lanes are compatibility inputs

The current ABI tokens `validation`, `production_cpu` and `production_gpu` are
legacy compatibility lanes. They do not prove an algorithm, validation level
or residency. The compatibility adapter must feed the requested product,
problem signature and lane constraint into this planner and emit one explicit
target engine in diagnostics before solve execution.

| Legacy lane | Required target interpretation |
|---|---|
| `validation` | Resolve to exactly one of `dense_cartesian_reference` or `dense_tangent_reference` from the actual representation. |
| `production_cpu` | Constrain candidates to CPU engines. The current driven compatibility path normally resolves to `cpu_host_krylov`; a different engine requires an explicit legal planner decision. |
| `production_gpu` | Constrain candidates to GPU engines. The current driven compatibility path is `gpu_operator_host_krylov` unless the complete device-residency contract proves `gpu_device_krylov`. The token alone can never imply device residency. |

The narrow dense K0 GPU modal validation exception is not the general
`gpu_modal_device_krylov` engine and must retain its validation-only name and
scope. A legacy lane that cannot be mapped legally is rejected; it is never
reported as a partially resolved engine.

Diagnostics and artifacts record at least:

```text
requested_execution
legacy_abi_lane, when present
resolved_execution
resolved_engine
selection_reason
fallback_used
fallback_reason, when fallback_used=true
```

## 4. FrequencySolvePlan target contract

The planner output is a single immutable decision, not a set of booleans from
which the runner chooses again:

```cpp
struct FrequencySolvePlan {
    FrequencyProduct product;
    FrequencyExecutionEngine engine;
    OperatorRepresentation representation;
    ScalarRepresentation scalar_representation;
    LinearSolverFamily linear_solver;
    SpectralTransform spectral_transform;
    PreconditionerFamily preconditioner;
    ExecutionDevice resolved_device;
    ExecutionPrecision resolved_precision;
    ResidencyContract residency;
    ResidualContract residual;
    CertificateSet certificate_set;
    std::string selection_reason;
    std::optional<FallbackDecision> fallback;
};
```

`engine` is exactly one concrete token from section 2. A successful plan may
not contain `auto`, a legacy lane, multiple candidate engines, or contradictory
flags such as both full-coupled and Schur-reduced. The runner materializes this
plan and may not reselect an engine.

## 5. Ordered legality-before-heuristics planner

The planner executes these stages in order and stops on rejection:

1. Validate physics, phase, equilibrium, boundary-condition and mesh
   certificates. This includes the exact product, k domain, dynamic-demag
   requirement, shared-domain topology, gauge and operator dictionary.
2. Resolve explicit requested device, precision and solver method. Preserve
   each requested value even when it is `auto`.
3. Reject unavailable strict requests. For a non-strict request, construct and
   record only a documented fallback that solves the same physical problem.
4. Build the candidate engine set legal for the exact product and algebra.
5. Filter candidates by problem-signature certificates, scalar support,
   residency prerequisites and memory admission.
6. Apply performance heuristics only among the remaining legal candidates.
7. Emit exactly one engine and a stable selection reason, or reject with one
   primary rejection reason plus supporting diagnostics.

Legality keys include at least:

```text
(product, k-domain, dynamic-demag, magnetostatic BC, outer BC, gauge,
 assembly kind, equilibrium hash, mesh/certificate hash, material hash,
 device, precision, scalar representation, requested method)
```

The planner must never use a K0 certificate, operator or preconditioner for a
nonzero-k problem. A candidate that lacks a required key is illegal rather
than merely low priority.

## 6. Requested intent, strictness and fallback

In `strict` execution mode, every explicit device, precision and method value
is a hard constraint. Missing support rejects the request before heuristics.
In particular, strict GPU never runs CPU; strict `single` never runs `double`;
and an unavailable explicit method never resolves to `auto` or another method.

In a non-strict mode, fallback is legal only when all of the following hold:

1. the public execution policy permits fallback for that requested field;
2. the replacement solves the identical physical, BC, k-domain and observable
   contract;
3. the replacement engine passes all legality and certificate gates;
4. requested and resolved device, precision and method are both preserved;
5. diagnostics and provenance set `fallback_used=true` and give a concrete
   `fallback_reason` before execution.

Resolving an `auto` field among legal candidates is normal resolution, not a
fallback, but the requested `auto` value is still preserved. Validation,
synthetic assembly, K0 demag, open boundaries, disabled demag or post-solve
phase projection are never fallbacks for a missing production operator.

## 7. Permitted heuristics

After legality filtering, heuristics may rank candidates using problem size,
frequency count, requested spectrum, memory estimate, accepted preconditioner
contraction and measured historical telemetry for the same signature class.
Typical rankings are:

- tiny certified oracle work: a matching dense reference engine;
- one or a few CPU driven frequencies with admitted factorization memory:
  `cpu_sparse_direct`;
- scalable CPU driven response: `cpu_host_krylov`,
  `full_coupled_field_split` or certified `schur_reduced`;
- many-frequency CPU sweep with a certified basis: `modal_reduced`;
- explicit or resolved GPU driven response: `gpu_device_krylov` when the full
  residency/preconditioner contract is available, otherwise the explicitly
  host-Krylov `gpu_operator_host_krylov` when that degradation is legal;
- explicit or resolved GPU modal spectrum: `gpu_modal_device_krylov` only when
  the SLEPc/device spectral-transform contract is available.

`prefer_existing_host_krylov` is only a same-device ranking preference. It
cannot mutate a CPU request into GPU, create GPU availability, bypass strict
method intent or defeat a certificate gate.

## 8. Non-negotiable planner invariants

```text
CPU cannot become GPU from prefer_existing_host_krylov.
Forced GPU cannot be preempted by CPU sparse-direct.
Nonzero-k dynamic demag cannot select a K0 operator.
Schur requires an accepted certificate keyed to the exact problem signature.
Modal-reduced requires completeness and independent full/direct sample checks.
A device-resident engine requires zero per-iteration vector/matrix H2D or D2H.
Exactly one engine and one selection reason are emitted for every accepted plan.
```

Memory rejection is deterministic and occurs before performance ranking. A
certificate invalidated by any signature component is absent, not degraded.

## 9. Current implementation boundary

The target policy above is not yet the current runtime policy:

| Current evidence | Honest status |
|---|---|
| `frequency_solve_plan.hpp` exposes seven coarse lane names. | `dense_cartesian_reference`, `dense_tangent_reference`, `cpu_host_krylov` and `gpu_modal_device_krylov` are not yet distinct planner outputs. |
| `frequency_solve_planner.hpp` is a header-level conservative descriptor. | It is not the single authoritative runtime route and does not implement the ordered policy above. Sparse-direct can be considered before GPU intent, and `prefer_existing_host_krylov` currently contributes to `requested_gpu`; both are target contract gaps. |
| The driven C ABI exposes `validation`, `production_cpu`, `production_gpu`. | These remain compatibility lanes and current diagnostics do not consistently publish one target engine for every path. |
| The Rust frequency-response runner rejects an implemented subset and also derives a resolved method name. | This is transitional orchestration logic; target engine selection belongs to the canonical planner and must not be repeated in the runner. |
| Current FEM frequency-domain planning rejects `single`. | This is honest current behavior, not permission to change precision in non-strict execution without an explicit fallback contract. |

No implementation or validation status is promoted by this documentation
chapter. Current-vs-target engine details are maintained in
`08_backend_algorithms_and_status.md` and the capability matrix.
<!-- END 06_solver_tree_planner_and_lanes.md -->

<!-- BEGIN 07_api_abi_artifacts.md -->
---
title: Frequency-domain public API, native ABI and artifact boundary
version: target v6 contract over current native ABI v12
date: 2026-07-10
status: normative target with explicit current ABI gaps
---

# API, ABI and artifact boundary

## 1. Scope and source of truth

The public contract is physics-first:

```text
Python DSL / UI -> ProblemIR -> planner -> runner materialization
  -> native C ABI -> FEM engine -> artifacts -> OpenAPI resources -> UI
```

The C ABI is an internal compiled-backend boundary. It must not redefine
public physics, infer missing intent, or expose a legacy lane as if it were a
resolved engine. The current ABI version is
`FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION = 12u`. The target stable ABI
described below is not yet fully implemented; every missing rule is
`contract_gap`.

## 2. Current ABI surfaces

| Surface | Current request/version fields | Result and release | Current role |
|---|---|---|---|
| Production driven response | `fullmag_fem_frequency_domain_driven_response_request`; tail fields `abi_version`, `reserved_contract_flags`, `struct_size` | `fullmag_fem_frequency_domain_solve_result`; release with `fullmag_fem_frequency_domain_solve_result_release()` | executable validation/CPU/GPU lane entry point |
| Modal contract | `FullmagFemModalEigenRequest.abi_version`; nested `FullmagFemLinearizedOperatorRequest.abi_version`; no public `struct_size` | `FullmagFemFrequencyDomainResult`; destroy with `fullmag_fem_frequency_domain_result_destroy()` | modal validation/selected-spectrum and Poisson-airbox contract entry point |
| Driven compatibility contract | `FullmagFemDrivenResponseRequest.abi_version`; nested operator version; no public `struct_size` | `FullmagFemFrequencyDomainResult`; same destroy function | compact compatibility/contract path, not the production request |
| Internal C++ modal request | `ModalEigenRequest.abi_version`, `.struct_size` | C++ `FrequencyDomainContractResult` copied into the public result | internal shape; its `struct_size` is not exposed by `FullmagFemModalEigenRequest` |
| Internal C++ driven request | `DrivenFrequencyResponseSolveRequest.abi_version`, `.struct_size` | `DrivenFrequencyResponseSolveResult`; internal idempotent release | implementation shape behind the production C request |

The coexistence of two driven request families and two result families is
current reality. They must not be presented as one already-stable target ABI.

## 3. Current versus target ABI

| Topic | Current ABI v12 behavior | Target stable behavior | Status |
|---|---|---|---|
| Version negotiation | Production driven accepts `abi_version` 0, 9 or 12. Modal/compact driven require exact v12. | Every public frequency-domain request/result starts with a common version/size header and follows one compatibility policy. | `contract_gap` |
| Size negotiation | Production driven accepts `struct_size=0` or exactly `sizeof(current request)`; it does not accept a known shorter prefix. Modal public request has no `struct_size`. | Caller sets the bytes it provides; callee reads only fields whose complete extent is within `struct_size`, requires a documented minimum prefix, defaults absent tail fields, and rejects impossible/interior sizes. | `contract_gap` |
| Enums | Public enums exist, but several C++ enums rely on declaration order and not every public concept is carried. | Every FFI enum is a fixed `uint32_t` value with `0=unspecified` only where compatibility requires it; unknown values reject. | partial |
| Booleans | Public fields use C `int` and Rust `i32`. The production-driven adapter currently maps any nonzero `require_nonzero_rhs` value to C++ `true`. | Public FFI booleans use an ABI-defined fixed-width `uint32_t`/integer representation, reject every value except `0` or `1`, and convert to C++ `bool` only after validation. | `contract_gap` |
| Pointer lengths | Many arrays have counts, including v12 tail value counts. Legacy/compact structs still use `int` lengths and some strict checks are skipped for version/size zero. | Every pointer has an adjacent fixed-width count and one nullability rule; overflow is checked before multiplication. | partial |
| Requested/resolved execution | Production driven carries broad `requested_execution_lane`; modal carries no device/lane/precision. | Request carries requested device/precision/mode/method; result names one resolved engine, residency and fallback. | `contract_gap` |
| Device pointers | Current numerical input pointers are host pointers; device work is hidden behind native contexts/callback `user_data`. | Host and device views are different tagged types; address space, owner, stream/context and synchronization contract are explicit. | `contract_gap` |
| Result lifetime | Native result structs own four allocated C strings. Rust wrappers copy those strings while the guard is alive, then `Drop` invokes the matching native release/destroy function; native cleanup frees all four allocations and zeroes the result. | Preserve this ownership rule across a consolidated result family: copy or borrow under one documented policy and always invoke the matching idempotent cleanup. | implemented |
| Error contract | Status enums and JSON/string fields exist, but error shape varies by entry point. | One status vocabulary and one diagnostics envelope with stable reason, requested/resolved execution and partial-artifact state. | partial |

## 4. Target version and size negotiation

Every new or migrated public request/result begins with this prefix:

```c
typedef struct {
    uint32_t abi_version;
    uint32_t reserved_contract_flags;
    uint64_t struct_size;
} fullmag_fem_frequency_domain_abi_header;
```

Rules:

1. Callers zero-initialize the complete local struct, set `abi_version` to a
   supported version, and set `struct_size` to `sizeof(the caller's struct)`.
2. `abi_version=0` and `struct_size=0` remain legacy compatibility only on the
   already-shipped production driven entry point. New entry points reject zero.
3. The callee validates `struct_size >= minimum_size_for(abi_version)` and
   reads a field only when `offsetof(field)+sizeof(field) <= struct_size`.
4. Missing known tail fields receive documented defaults. A callee never reads
   beyond caller-provided bytes and never guesses an older layout from content.
5. A larger size with a known version is accepted only when the known prefix is
   layout-compatible; unknown tail bytes are ignored.
6. An unknown enum, nonzero reserved flag, impossible size, overflowed extent
   or version/layout mismatch returns `validation_error` with a stable reason.
7. ABI layout tests use `fullmag_fem_get_frequency_domain_abi_layout()` or its
   successor to compare sizes and offsets across C, C++ and Rust.

Version increments are required for incompatible layout or semantic changes.
Adding an optional tail field under a size-negotiated version is allowed only
when its zero value has the documented old behavior.

## 5. Enums and FFI-normalized booleans

Current public enum values that remain stable include:

```text
status: ok=0, unavailable=1, validation_error=2, operator_error=3,
        solve_error=4, artifact_error=5, interrupted=6
study:  response=1, eigenmodes=2
lane:   validation=0, production_cpu=1, production_gpu=2
phase:  exp_i_omega_t=0, exp_minus_i_omega_t=1
drive:  unspecified=0, dynamic_field_phasor_a_per_m=1, tangent_rhs=2,
        cartesian_torque_phasor=3, stt_current_phasor=4,
        coupled_external_provider=5
```

The lane enum is compatibility routing, not engine selection. The target
engine ID is a string/enum owned by `FrequencySolvePlanner` and returned in
diagnostics/artifacts.

The current production-driven public field `require_nonzero_rhs` is a C `int`
and a Rust `i32`. Its C-to-C++ adapter currently evaluates
`request->require_nonzero_rhs != 0`, so every nonzero value becomes `true`.
That permissive conversion is a current `contract_gap`.

The target stable ABI uses an FFI-normalized fixed-width `uint32_t` or
otherwise ABI-defined integer representation with these strict values:

```text
0 = false
1 = true
other = validation_error
```

Rust converts to/from the declared FFI integer at the boundary. Native C++
validates the raw value first and converts to `bool` only after accepting `0`
or `1`. Public structs never contain C++ `bool`.

## 6. Pointer, length and nullability rules

For every `(pointer,count)` pair:

```text
count == 0  -> pointer may be null; callee must not dereference it
count > 0   -> pointer must be non-null and readable/writable as declared
```

The callee validates element-count multiplication and shape products before
forming spans. The v12 tail counts such as
`mfem_equilibrium_m_value_count`, `mfem_drive_real_value_count`,
`mfem_drive_imag_value_count` and coupled-block value counts are mandatory
when the corresponding strict v12 feature is enabled.

Additional rules:

- `const char *` inputs are borrowed UTF-8 NUL-terminated strings. Null means
  absent only for fields explicitly documented optional; an empty required
  string is invalid.
- Callback function pointers may be null. A non-null callback's `user_data`
  remains caller-owned and valid until the solve returns.
- The callee does not retain request pointers, spans, strings, callbacks or
  `user_data` after the synchronous call returns.
- Output buffers supplied by the caller remain caller-owned.
- Native result strings are callee-owned until the matching release/destroy.
- A direct device pointer is invalid on the current ABI. Device memory is
  reachable only through a separately owned native context/callback contract.

## 7. Real/imaginary layout and node ordering

The physical and internal layouts are different and must never share one
ambiguous field name.

| Payload | Current exact layout | Required metadata |
|---|---|---|
| `mfem_equilibrium_m` | host AoS `[mx0,my0,mz0,mx1,my1,mz1,...]`, length `3*node_count` | magnetic node ordering and mesh/FE-space identity |
| `mfem_h_ext_a_per_m` | Cartesian `[Hx,Hy,Hz]` | A/m |
| `mfem_drive_real`, `mfem_drive_imag` | tangent order `[u0,v0,u1,v1,...]`, each length `tangent_dof_count=2*magnetic_node_count`; current runner materialization places tangent-coordinate physical-field components here, while production solvers consume the buffers as `b` | `drive_kind`, physical-field versus tangent-RHS units, and projection provenance; integrating `project_dynamic_field_drive_to_tangent_rhs()` exactly once is a current `contract_gap` |
| coupled block drive | `[q,phi]` block order defined by the supplied coupled operator; real and imaginary buffers have equal count | q/phi offsets, gauge/eta presence and FE ordering |
| modal dense matrices | current row-major arrays where the field name says `_row_major`; CSR uses `row_offsets`, `column_indices`, `values` | dimensions, scalar mode and block dictionary |
| Floquet pairs | pair ID, node A/B, optional translation and phase | node ordering, `phase=-k dot translation`, magnetic versus scalar space |
| artifact XYZ complex fields | logical Zarr `[node,component,complex]`; compatibility binary `x_re,x_im,y_re,y_im,z_re,z_im,...` | mesh ID, FE space, basis, component order, units and revision |

The target ABI carries an explicit node-ordering/FE-space identity or a digest
that is checked against `LinearizationState.v6` and
`periodic_mesh_certificate.v6`. Pointer length alone cannot prove ordering.

## 8. Host/device ownership and synchronization

Current v12 request pointers are host-accessible for the duration of the call.
A label such as `production_gpu` does not change their address space and does
not prove device-resident Krylov.

The target resolved result records:

```text
operator_residency = host | device | mixed
vector_residency = host | device | mixed
krylov_residency = host | device | mixed
preconditioner_residency = host | device | mixed
hot_loop_h2d_bytes
hot_loop_d2h_bytes
hot_loop_host_sync_count
```

Device-resident claims require no per-iteration vector/matrix migration.
Bounded control-scalar reductions are reported separately. Callback-owned
device contexts must remain alive and synchronized under the callback's own
contract until the native solve returns.

## 9. Result allocation, release and diagnostics lifetime

### Production driven result

`fullmag_fem_frequency_domain_solve_result` owns its four allocated strings:

```text
error_message
diagnostics_json
result_json
artifact_manifest_path
```

Call `fullmag_fem_frequency_domain_solve_result_release(&result)` exactly once
after the last read. The current implementation is idempotent and clears the
struct, so cleanup after partial initialization is valid. Rust uses
`NativeDrivenFrequencyResponseFfiResult` as the RAII owner and copies strings
before the guard is dropped.

### Modal/compact contract result

`FullmagFemFrequencyDomainResult` owns the same four allocated strings and is
released with `fullmag_fem_frequency_domain_result_destroy(&result)`. The
destroy function is idempotent and clears the struct.

The Rust wrapper copies all four strings while its result guard is alive. The
guard's `Drop` implementation then invokes
`fullmag_fem_frequency_domain_result_destroy()`, whose native implementation
deletes all four allocations and zeroes the result. This ownership path is the
current contract, not a `contract_gap`.

### Error and callback strings

- Result strings remain valid until release/destroy.
- `progress_json` passed to a callback is borrowed only for that callback
  invocation; the receiver copies it if it needs persistence.
- Fixed callback error buffers are caller-provided for the duration of one
  callback call.
- `diagnostics_json` is the machine-readable explanation. `error_message` is
  concise human-readable context and does not replace a stable reason code.

## 10. Error and fallback semantics

Transport return and solve status are separate:

- a nonzero C function return means the ABI call itself failed before a valid
  owned result was transferred;
- a zero C function return may still carry `validation_error`, `unavailable`,
  `operator_error`, `solve_error`, `artifact_error` or `interrupted` in the
  result status;
- callers always release a successfully transferred result, regardless of its
  solve status.

Diagnostics for unavailable/rejected execution include:

```text
status
complete
reason or unsupported_reason
requested_execution
resolved_execution
fallback_used
partial_artifacts_available
```

Forced GPU, explicit precision and explicit solver method never silently
fallback. Validation/dense, CPU, K0, open-boundary, no-demag, synthetic or
postsolve-phase paths cannot replace a different requested physical operator.

## 11. Public artifact and resource boundary

The native ABI returns only control-plane JSON/string summaries and an
artifact-manifest path. Large modal and response arrays are published as Zarr
or another specified data-plane store and discovered through:

```text
frequency_domain/manifest.v1.json
OpenAPI /v2/sessions/current/analysis/frequency-domain/...
/v2/sessions/current/data/fields/{field_id}/samples/vector
ControlRoomApi.analysis.frequencyDomain
useFrequencyDomain*Resource hooks
```

The hardened manifest requirements live in
`docs/specs/frequency-domain-artifacts-v2.md`. ABI fields and artifacts use the
same requested/resolved execution, phase, equilibrium/certificate, assembly,
BC/gauge, spectral shift, residual and fallback meanings. Artifact publication
must fail if those meanings disagree with native diagnostics.

## 12. Backward compatibility and migration

1. Keep the current production driven v12 entry point and its v9/zero legacy
   acceptance while existing callers migrate.
2. Treat zero version/size as legacy, report that fact in diagnostics, and do
   not enable tail-dependent features without their validated lengths.
3. Add size headers to modal and compact driven requests in a new ABI version;
   do not reinterpret their current layout in place.
4. Keep both release functions until all callers use one consolidated result
   family.
5. Preserve current numeric enum values. New enum values append; they never
   renumber old values.
6. Preserve current ABI lane names as compatibility input, but resolve them to
   one target engine in diagnostics.
7. Reject mixed-version nested requests unless the version contract explicitly
   permits that pair.
8. Maintain C/C++/Rust size-and-offset tests and add allocation/release tests
   for success, every failure status and partial initialization.

The target stable ABI is complete only after all request families implement
the same negotiation, ownership, status and requested/resolved semantics. Until
then, documentation and artifacts must retain the current-vs-target boundary.
<!-- END 07_api_abi_artifacts.md -->

<!-- BEGIN 08_backend_algorithms_and_status.md -->
---
title: Frequency-domain backend algorithm contracts and status
version: COMSOL-aligned v5.1 decision-complete
date: 2026-07-10
status: canonical
role: normative
---

# Backend algorithm contracts and status

## 1. Authority and status vocabulary

The common algebra is the `FrequencyOperatorDictionary.v1` contract in
`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`:

```text
modal:  L q = lambda B q, lambda = i omega
driven: D(omega) q = (i omega B - L) q = b
```

Each backend may use complex scalars or the documented real split, but must
publish the scalar representation and certify the residual of the original
full operator. Transformed, preconditioned, Schur or reduced residuals are
additional diagnostics and cannot replace the full residual.

Status rows use three independent fields:

```text
implementation_state: absent | contract_only | source_visible | executable
validation_state: unvalidated | algebra_validated | physics_validated | production_qualified
validated_scope: non-empty bounded workload and evidence description
```

`product_status` is a separate compatibility label from the capability matrix,
not an implementation or validation axis. In particular,
`partial_production_executable` means executable only for the explicitly
documented bounded product workload; it does not imply `physics_validated` or
`production_qualified`. Runtime evidence is recorded in `validated_scope` or a
status note and is not itself a validation state. This documentation task
inspected source and current parallel documentation only; it did not rerun any
runtime evidence.

## 2. Common P1 shared-domain assembly contract

Production FEM assembly is P1 MFEM assembly over the accepted magnetic/shared
airbox domain. It produces the exact tangent magnetic blocks and, when dynamic
demag is requested, scalar-potential coupling and Poisson blocks required by
the selected BC/gauge tuple. Production assembly must publish
`assembly_kind=mfem_weak_form_shared_domain`; dense row-major payloads and
`synthetic_algebraic_oracle` remain reference inputs.

For a complex implementation, PETSc/SLEPc consumes the canonical complex
operator directly. For a real PETSc build, the implementation uses the general
real split

```text
[D_R -D_I; D_I D_R] [q_R; q_I] = [b_R; b_I]
```

and the corresponding generalized real representation for modal solve. It
must not assume the special `[K,+omega*M;-omega*M,K]` form unless `K=-L` and
`M=B` have been established for the exact operator.

K0 and nonzero-k assembly are separate legal products. Nonzero-k dynamic demag
requires the Floquet scalar/magnetic equivalence classes and complex Bloch
operator; it may not reuse a K0 matrix.

## 3. CPU reference and direct engines

| Engine | Matrix/scalar contract | Solver and transform | Preconditioner | Required residual | Failure and fallback |
|---|---|---|---|---|---|
| `dense_cartesian_reference` | Explicit CPU/double Cartesian operator, including constraints/projection and any auxiliary blocks. Tiny bounded dimension only. | Dense generalized eigensolve or dense direct harmonic solve; no production spectral shortcut. | None or exact dense factorization. | Original Cartesian equation plus tangent-leakage/constraint residual and cross-oracle parity. | Reject outside the bounded oracle size. Never a production fallback. |
| `dense_tangent_reference` | Explicit CPU/double tangent operator, complex or documented real split. | Dense generalized eigensolve or dense direct driven solve. | None or exact dense factorization. | Original tangent operator residual; full block residual when scalar potential is present. | Reject outside the bounded oracle size. Never replaces unavailable production physics. |
| `cpu_sparse_direct` | Per-frequency PETSc AIJ matrix for the legal complex or general real-split driven system. | `KSPPREONLY` plus `PCLU`; factorization package and ordering are diagnostics. No eigen use. | LU factorization is the solve, not an iterative preconditioner. | Recompute `||D(omega)q-b||` from the original operator and publish block residuals where applicable. | Strict explicit direct rejects if PETSc/factorization/memory is unavailable. Non-strict auto may replan to another legal CPU engine with recorded fallback. |

Current status:

| Engine/slice | implementation_state | validation_state | product_status | validated_scope |
|---|---|---|---|---|
| Cartesian dense reference | `source_visible` | `unvalidated` | Not separately classified. | No validated scope: no distinct end-to-end target engine token is proven by current planner/ABI. |
| Tangent dense reference | `executable` | `algebra_validated` | `reference_executable` | Tiny CPU/double modal and block-real driven algebra fixtures only; not large-object or production physics validation. |
| PETSc AIJ sparse direct helper | `source_visible` | `algebra_validated` | Not separately classified. | Isolated dense-input-to-AIJ real-split helper using `KSPPREONLY/PCLU` and true-residual recomputation; current production dispatch does not select it as an end-to-end engine. |

## 4. CPU selected-spectrum modal engines

### 4.1 Full descriptor selected spectrum

The scalable full modal path constructs the legal P1 MFEM descriptor and gives
PETSc/SLEPc either assembled sparse blocks or matrix-free actions. SLEPc uses a
generalized non-Hermitian problem with Krylov-Schur or Arnoldi. Interior-window
selection uses shift-invert or another explicitly named transform with
`sigma=i*omega_target` in the canonical complex representation, or its exact
real-split equivalent. A real-axis target is forbidden unless a separately
derived real-frequency pencil is named and validated.

The shifted KSP and PC are part of the engine contract. PETSc/hypre provide the
linear solve and preconditioning; the selected transform, tolerances,
factorization or iterative policy, and convergence reason are diagnostics.
Every accepted mode is remapped through `lambda=i*omega`, normalized according
to the public policy and checked against the original full descriptor.

### 4.2 Schur MatShell selected spectrum

The Schur modal engine exposes a SLEPc `MatShell` action

```text
S(lambda) q = A_qq(lambda)q
              - A_qphi solve(A_phiphi, A_phiq q)
```

with the exact BC/gauge-constrained Poisson inverse. It is legal only with an
accepted `SchurCertificate` keyed by the full problem signature, including
equilibrium, mesh, materials, k, BC/gauge, assembly and scalar representation.
Krylov-Schur/Arnoldi and the spectral transform follow the same target rules as
the full descriptor path. Each mode reconstructs `phi` and publishes magnetic,
Poisson/gauge and complete descriptor residuals. A Schur residual alone cannot
accept a mode.

Current status:

| Slice | implementation_state | validation_state | product_status | validated_scope |
|---|---|---|---|---|
| CPU SLEPc selected spectrum | `executable` | `unvalidated` | `partial_production_executable` | No validated scope for the target engine. Managed runtime evidence is limited to selected-spectrum CPU no-demag/Full2x2 Floquet and gamma-equivalent slices plus tiny/macrospin adapters; real shared-domain dynamic-demag qualification and the target imaginary-axis transform remain open. |
| Poisson-airbox Schur `MatShell` | `source_visible` | `algebra_validated` | Not separately classified. | Synthetic/algebraic K0 certificate fixtures with reconstructed full and Poisson residuals. This is not real shared-domain P1 production assembly. |

## 5. CPU driven Krylov engines

### 5.1 `cpu_host_krylov`

This is the generic CPU host-resident driven engine. It applies the accepted
assembled or matrix-free `D(omega)` and runs host GMRES/FGMRES. The operator,
preconditioner, restart, tolerances and stopping reason are explicit. The
engine recomputes the original unpreconditioned residual at controlled cadence
and at completion. Preconditioner pilot heuristics may choose only among legal
preconditioners; they may not change product, device, precision or method.

### 5.2 `full_coupled_field_split`

The production algorithm uses PETSc `MatNest` or equivalent nested `MatShell`
blocks for the full magnetic/scalar system and PETSc KSP GMRES/FGMRES with
`PCFIELDSPLIT`. The magnetic block uses an accepted tangent operator
preconditioner; the scalar block uses the BC/gauge-correct PETSc/hypre Poisson
solve. The preconditioner may be block triangular or Schur-based, but the
solved operator remains full coupled. Acceptance requires total, magnetic,
scalar-potential and gauge residuals from the original full system.

### 5.3 Certified `schur_reduced` driven solve

The driven Schur engine uses a PETSc `MatShell` for the frequency-dependent
reduced action and a certified Poisson inverse. Its certificate is keyed to the
same exact problem signature as modal Schur. It reconstructs `phi` at every
accepted frequency and verifies the original full driven residual. If the
certificate is missing, invalidated or fails a runtime quality bound, explicit
strict Schur rejects. A non-strict auto request may replan to the legal full
coupled engine and must record the fallback before solve execution.

Current status:

| Engine/slice | implementation_state | validation_state | product_status | validated_scope |
|---|---|---|---|---|
| `cpu_host_krylov` compatibility path | `executable` | `unvalidated` | `partial_production_executable` | No validated scope for the target PETSc engine. Managed runtime evidence covers only the listed gamma/free-boundary, k0 static-periodic, no-demag nonzero-k phase-projection and narrow K0 periodic-airbox provider slices; the current implementation is a custom host GMRES path. |
| Full-coupled field-split helper | `source_visible` | `algebra_validated` | Not separately classified. | Bounded dense prototype with a cached dense scalar-block inverse and iterative residual diagnostics; no production PETSc `MatNest/PCFIELDSPLIT` integration. |
| Driven Schur/provider paths | `executable` | `unvalidated` | `partial_production_executable` | No validated scope. Managed runtime evidence is limited to narrow K0 periodic-airbox matrix-free provider/Schur response and does not prove general full assembly, nonzero-k demag-k or selected-spectrum modal support. |

## 6. Modal, rational and recycling sweep engine

`modal_reduced` starts from modes produced by a qualified full or certified
Schur modal engine for the same problem signature. The basis certificate
contains the frequency interval, mode count, normalization, left/right basis
requirements for non-Hermitian damping, maximum eigen residual, completeness
test and cache key. The driven sweep projects the physical RHS once, solves the
reduced complex system, and reconstructs requested observables.

Rational Krylov or recycling may enrich the basis, but each accepted sweep must
pass independently selected full/direct sample solves and declared response
error tolerances. A failed completeness or sample check invalidates the basis.
Strict explicit `modal_reduced` rejects; a permitted non-strict fallback
replans to a legal full driven engine and records the basis failure. It never
silently continues with an uncertified basis.

Current status:

| implementation_state | validation_state | product_status | validated_scope |
|---|---|---|---|
| `source_visible` | `algebra_validated` | Not separately classified. | Diagonal validation helper, completeness-policy types and sparse-direct sample hooks. No integrated production modal/rational/recycling sweep engine. |

## 7. GPU library-first engines

The primary production path uses the established solver stack:

| Layer | Driven `gpu_device_krylov` | Modal `gpu_modal_device_krylov` |
|---|---|---|
| Operator | MFEM/libCEED/CUDA matrix-free apply, including the exact dynamic-demag operator required by the problem. | The same device operator contract for `L`, `B` and any full coupled descriptor blocks. |
| PETSc objects | CUDA vectors and device-capable `MatShell`/`MatNest`; no host shadow as the iteration source of truth. | CUDA PETSc vectors/matrices consumed by SLEPc. |
| Auxiliary solve | hypre device Poisson or shifted preconditioner with accepted BC/gauge and contraction evidence. | hypre/PETSc device shifted solve used by the SLEPc spectral transform. |
| Iteration | PETSc KSP GMRES/FGMRES with device-resident vector algebra. | SLEPc Krylov-Schur/Arnoldi with the exact complex or real-split spectral target. |
| Acceptance | Original driven full/block residual and device-residency telemetry. | Original descriptor/block residual for every accepted mode and device-residency telemetry. |

Host orchestration, launch decisions, progress publication and bounded scalar
reductions are allowed. Setup H2D and final/output-cadence D2H are allowed and
counted. A device-resident claim forbids per-iteration vector or matrix H2D/D2H
migration, host dot/norm/axpy, host Arnoldi/Hessenberg updates, and host
preconditioner state. Required diagnostics include:

```text
krylov_vector_location=device
operator_buffer_location=device
preconditioner_buffer_location=device
per_iteration_h2d_transfer_count=0
per_iteration_d2h_transfer_count=0
```

A custom CUDA Krylov or eigensolver loop is considered only after a recorded
benchmark and profiler report shows that the PETSc/SLEPc/hypre/libCEED path
cannot meet the numerical or residency contract. Convenience or an existing
callback loop is not sufficient justification.

## 8. Honest GPU distinction and current status

`gpu_operator_host_krylov` is an explicit compatibility engine: operator and
possibly Poisson/preconditioner work may run on GPU, while Krylov vectors,
orthogonalization, Hessenberg state, dot/norm/axpy and convergence control stay
on host. Host/device vector movement at operator callback boundaries is legal
for this engine only when reported. It must never set
`gpu_device_resident_solver=true`.

| Engine/slice | implementation_state | validation_state | product_status | validated_scope |
|---|---|---|---|---|
| `gpu_operator_host_krylov` driven compatibility path | `executable` | `unvalidated` | `partial_production_executable` | No validated scope for a device Krylov engine. Managed runtime evidence covers narrow gamma/free-boundary, k0 static-periodic, no-demag nonzero-k phase-projection and K0 periodic-airbox provider slices; the source reports host Krylov residency. |
| GPU persistent operator context | `executable` | `unvalidated` | Not separately classified. | No validated engine scope. Runtime evidence covers static device buffers and CUDA local/exchange/DMI operator application for supported driven slices and proves operator residency only. |
| `gpu_device_krylov` contract skeleton | `source_visible` | `unvalidated` | Not separately classified. | No validated scope: descriptor, callback, transfer and residual gates exist, but `production_loop_available=false`; no PETSc device KSP engine is integrated. |
| Narrow K0 GPU macrospin modal exception | `executable` | `physics_validated` | `partial_production_executable` | Managed K0 no-demag macrospin/Kittel modal fixture on GPU/double only; non-scalable and not general `gpu_modal_device_krylov`. |
| GPU Poisson-airbox dense G5a oracle | `executable` | `algebra_validated` | Not separately classified. | Bounded one-thread dense GPU synthetic full-descriptor fixture only; it does not validate real shared-domain Poisson physics or implement general `gpu_modal_device_krylov`. |
| `gpu_modal_device_krylov` | `absent` | `unvalidated` | Not separately classified. | No validated scope: no general PETSc/SLEPc device-resident modal engine for real shared-domain meshes, dynamic demag or nonzero-k Floquet exists. |

Nonzero-k numerical FEM dynamic demag remains a contract gap. Neither a K0
operator nor a no-demag phase-projection slice may satisfy that request.

## 9. Task 4 contract-gap correlation

The planner and engine targets consume, but do not close, the end-to-end gaps
recorded by Task 4:

| Task 4 gap | Consequence for this chapter |
|---|---|
| `EquilibriumArtifact.v6 -> LinearizationState.v6` and `periodic_mesh_certificate.v6` are not consumed end to end. | Target legality requires their hashes/certificates; current isolated native descriptors cannot be treated as accepted planner input. |
| Modal plan/native request lacks complete requested device, precision, method and magnetostatic-BC fields; current common artifact writing may hardcode CPU/double. | General CPU/GPU modal engine resolution and requested/resolved provenance remain contract gaps even where a narrow solver adapter executes. |
| Nonzero-k numerical dynamic demag and general Floquet-airbox modal/GPU support are missing. | Planner must reject those signatures and cannot select a K0, no-demag or driven-response engine as a substitute. |
| Production driven materialization does not yet integrate the physical-field-to-tangent-RHS conversion helper. | No driven engine is production-qualified for the target physical RHS contract merely because its linear solve converges. |
| Current host/device pointers and legacy lanes do not prove vector, operator, preconditioner and Krylov residency. | `production_gpu` resolves honestly to `gpu_operator_host_krylov` unless independent transfer telemetry proves a device engine. |
| Hardened engine, residual, BC/gauge, hash, readiness and residency fields are not consistently published through artifacts/OpenAPI/UI. | Planner acceptance and solver convergence are insufficient for product qualification until the selected engine and full evidence envelope are inspectable. |

These are current implementation boundaries. This task does not edit code,
the capability matrix, ABI, artifacts or runtime behavior.

## 10. Backend ownership

Production numerical implementations live under:

```text
backends/fem/cpu/frequency_domain/
  engines/
  operators/
  preconditioners/
  modal/
  validation/

backends/fem/gpu/cuda/frequency_domain/
  engines/
  operators/
  preconditioners/
  residency/
  modal/
```

Backend-neutral descriptors, planner input/output types, certificates and
diagnostic schemas may live under `backends/fem/include/frequency_domain/` and
shared implementation support under `backends/fem/src/frequency_domain/`, but
those shared directories do not own a CPU or GPU production engine.

`crates/fullmag-runner` owns orchestration, ABI request/result lifetime,
cancellation, progress, artifacts and provenance. It consumes the single
selected engine; it does not own MFEM assembly, PETSc/SLEPc setup, hypre
preconditioners, CPU solver loops, GPU Krylov state or numerical fallback
selection.

Current ownership is transitional: the large
`backends/fem/src/frequency_domain/driven_response_solver.cpp` still contains
production routing and numerical behavior, and the runner still performs some
method rejection/resolution. Their existence is current code truth, not the
target ownership boundary. Moving behavior must be a later behavior-preserving
implementation task, not part of this documentation change.

## 11. Promotion gate

An engine can be called production-qualified only for an exact
`(product,k-domain,demag,device,precision,engine,assembly,BC/gauge)` scope after
it has:

1. deterministic planner legality and strict/fallback tests;
2. original full/block residual certification;
3. reference parity and mesh/order convergence where applicable;
4. requested/resolved engine, scalar, transform and residency provenance;
5. managed runtime evidence for the exact lane;
6. performance and memory evidence at the intended scale;
7. for GPU device engines, zero per-iteration vector/matrix migration evidence.

Source visibility, isolated contract tests, an operator callback on GPU or a
successful compatibility lane does not satisfy this gate.
<!-- END 08_backend_algorithms_and_status.md -->

<!-- BEGIN 09_validation_certification_benchmarks.md -->
---
title: FEM frequency-domain validation, certification and benchmark gates
version: COMSOL-aligned v5.2 decision-complete
status: normative validation contract; no capability promotion implied
role: validation
---

# Validation, certification and benchmark gates

## 1. Scope and promotion rule

This chapter defines independent acceptance gates for FEM frequency-domain
`modal_eigen` and `driven_response`. It consumes the K0 Poisson-airbox
algorithms in chapter 18, the nonzero-k Floquet-airbox algorithms in chapter
23, and the physics contracts in notes 0700, 0830 and 0831. It does not record
dated evidence and does not claim that any gate has run.

Each gate has seven mandatory fields: **fixture**, **independent oracle**,
**metric**, **initial tolerance**, **production tolerance**, **required
artifacts**, and **promotable readiness cells**. A result may promote only the
exact cells named by its accepted artifact bundle. Passing a nearby synthetic,
CPU, K0, no-demag, modal, or tiny case cannot promote another cell.

A readiness cell can be summarized for human review by these dimensions:

```text
study_product
device
precision
k_scope and sampled k domain
dynamic_demag_scope
geometry/material/equilibrium class
boundary/gauge tuple
FE order and mesh/DOF envelope
operator and interaction set
damping/nonconservative policy
solver engine, preconditioner and target/sweep policy
```

This list is deliberately abbreviated and is not the canonical
`validated_scope`. Chapter 24 section 2 exclusively defines the complete scope,
its deterministic `scope_id`, and its required physics/mode/k/BC/gauge/runtime,
device, precision, problem-size, bounded geometry/material, fixture and oracle
fields. `initial` means a gate is usable during implementation. `production`
means it is eligible to satisfy chapter 24 for the canonical scope bound to the
artifact. Production tolerances supersede initial tolerances; a
fixture-specific physics note may tighten them but may not loosen them silently.

Analytical values and trusted reference solutions are verifier-side data. They
must not construct the production operator, choose its target, select a mode,
set convergence, certify solver success, or alter the artifact under test.

Every JSON-object artifact named in every gate row below includes a mandatory
top-level `verified_coverage_of` field whose value is this
`validation_scope_binding.v1` object from Chapter 24. CSV, Zarr and other
non-object artifacts instead require the Chapter 24
`validation_artifact_manifest.v1` sidecar with the same binding:

```text
verified_coverage_of:
  schema: validation_scope_binding.v1
  scope_schema: frequency_domain_validation_scope.v1
  scope_catalog_uri: validation/scopes/scope_catalog.v1.json
  scope_catalog_sha256: Sha256Id
  exactly one closed variant:
    kind: direct
    scope_id: Sha256Id
  or:
    kind: coverage
    coverage_rule:
      schema: coverage_rule.v1
      relation: exact | subset
      subject_scope_id: Sha256Id
      covered_scope_ids: non-empty ordered unique Sha256Id array
      field_predicates: complete Chapter 24 FieldPredicate array
```

`scope_catalog_uri` and `scope_catalog_sha256` are mandatory in both variants;
an embedded catalog is not a valid alternative. The direct variant binds the
recomputed hash of the one catalog-resolved scope evaluated by the artifact.
The coverage variant is legal only with a complete typed rule; a record cannot
use both variants. Chapter 24 validates the closed scope, catalog and coverage
schemas, comparator direction, catalog digest and every referenced hash. A
fixture nickname, abbreviated readiness tuple, matching path, implicit parent
scope, opaque scope hash or prose assertion of exact coverage or exact
`validated_scope` is invalid. In particular, evidence whose subject is narrower
than a target cannot promote that broader target.

## 2. Common acceptance and convergence contract

All numerical comparisons use double precision unless the cell explicitly
states another qualified precision. Relative errors use a declared scale and
an absolute floor stored in the artifact. Matrix/action comparisons use

```text
eps_action = ||y_test-y_oracle||_2 /
  max(||y_oracle||_2, absolute_scale_floor).
```

Modal and driven acceptance uses the reconstructed original, unscaled operator:

```text
eps_modal = max(eps_q, eps_phi, eps_gauge)
eps_driven = max(eps_q, eps_phi, eps_gauge)
```

Library, transformed, preconditioned and tracked residuals remain separate
diagnostics. None may cap or replace the original-operator residual.

Every convergence artifact must contain raw, distinct solve rows. It must
identify the varied parameter, hold all other declared parameters fixed, and
include at least three levels. Acceptance requires one of:

1. monotone entry into the asymptotic regime followed by a finest-two delta;
2. a documented asymptotic fit with residual and confidence diagnostics when
   strict monotonicity is not expected; or
3. Richardson extrapolation when a stable observed order is available.

Where an order is applicable, publish `observed_order`. Always publish the raw
levels, `finest_two_relative_delta`, any `richardson_extrapolated_value`, and
the fit residual. Mesh error and airbox/truncation error have separate budgets.
Duplicated synthetic rows, relabelled copies of one solve, or rows that reuse
one numerical result under several levels fail the gate.

## 3. Physics gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| PHY-1 units, phasor and Larmor | Uniform magnet, positive bias sweep, no demag, no damping, K0 | Closed-form `f=gamma0 H/(2*pi)` evaluated only after branch selection; independent SI-token audit | Maximum/median relative frequency error; `lambda=i*omega`; gamma/mu0 consistency | max `2e-2`; median `1e-2`; mapping/token mismatches `0` | max `5e-3`; median `2e-3`; mapping/token mismatches `0` | `validation/physics/larmor.v1.json`, selected branch rows, solver diagnostics | `modal_eigen/*/k0/demag_none`; driven cells only through PHY-4 |
| PHY-2 demag sign and energy | Uniformly magnetized sphere and at least two ellipsoids, open boundary | Analytical demag tensor and positive magnetostatic energy, generated outside assembly | Componentwise field error, energy error, sign failures | field/energy `<=3e-2`; sign failures `0` | field/energy `<=1e-2`; sign failures `0` | `validation/physics/demag_ellipsoid.v1.json`, raw mesh/padding rows | K0 demag cells for the evidenced BC/geometry envelope |
| PHY-3 Kittel thin film | Chapter 15 K0-3 real-film suite | Fixture-owned, independently provenanced, postsolve-only `M_eff_reference`; postsolve Kittel evaluator and fitted `M_eff`; none is a solver/request/selection/certificate input | Maximum/median field-sweep frequency error; `abs(fitted_M_eff-M_eff_reference)/abs(M_eff_reference)`; fitted-parameter uncertainty and scaled-Jacobian conditioning; separate frequency and fitted-`M_eff` mesh/truncation budgets | frequency max `5e-2`, median `2e-2`; fitted `M_eff` relative error `2e-2`; relative standard uncertainty `1e-2`; scaled-Jacobian condition number `1e8`; mesh `2e-2`; truncation `2e-2` | frequency max `2e-2`, median `1e-2`; fitted `M_eff` relative error `5e-3`; relative standard uncertainty `2.5e-3`; scaled-Jacobian condition number `1e6`; mesh `1e-2`; truncation `5e-3` | Chapter 15 fixture/reference provenance, fit, summary, points, selection, independence and convergence artifacts, each with the required `verified_coverage_of` binding | `modal_eigen/{cpu,gpu}/k0/periodic_airbox_k0` only after all predecessor gates |
| PHY-4 modal/driven resonance | Same assembled blocks, physical transverse drive, frequency sweep bracketing independently selected modes | Driven full solve is the modal oracle and modal spectrum is the driven-location oracle; neither selects the other | Resonance-frequency delta, complex observable delta, original residual | frequency `1e-2`; observable `5e-2`; residual `1e-6` | frequency `2e-3`; observable `1e-2`; residual `1e-8` | spectrum, response sweep, point diagnostics and cross-link artifact | Matching modal and driven cells only |

## 4. Manufactured assembly gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| ASM-1 scalar Poisson BC/gauge | Manufactured P1 potential/source on Robin, Dirichlet and pure-Neumann shared domains | Symbolic potential differentiated outside the FEM assembler | L2/H1 error, observed order, boundary residual, gauge residual | L2 order `>=1.7`; H1 order `>=0.8`; residuals `<=1e-7` | L2 order `>=1.9`; H1 order `>=0.95`; residuals `<=1e-9` | `validation/k0_poisson_airbox/manufactured_poisson.v1.json`, raw levels | K0 modal/driven demag cells for each passed BC/gauge tuple |
| ASM-2 magnetic/scalar reciprocity | Deterministic element fixtures plus sphere/ellipsoid assembled meshes | Separate element quadrature implementation and energy variation identity | Element/global adjoint-energy relative error; sign-negative-control outcome | `<=1e-9`; negative control must fail | `<=1e-11`; negative control must fail | `validation/k0_poisson_airbox/reciprocity.v1.json` | K0 demag cells using the evidenced material/quadrature order |
| ASM-3 full descriptor assembly | Tiny real shared-domain P1 cases for every BC/gauge tuple | Independently assembled dense descriptor and seeded random-vector actions | Per-block/action error; ordering/signature mismatch count | action `<=1e-9`; mismatch count `0` | action `<=1e-11`; mismatch count `0` | assembly section of solver diagnostics and `descriptor_parity.v1.json` | Exact K0 modal/driven CPU cells; GPU only after GPU parity |
| ASM-4 analytical-input isolation | Same physical problem solved with absent, perturbed and nonsensical Kittel verifier metadata | Hash/action invariance oracle; solver request inspection | Changes in blocks, target/window, preconditioner, selected spectrum before verifier, certificate or solve status | all changes `0` | all changes `0` | `validation/k0_poisson_airbox/analytical_isolation.v1.json` | Every Kittel-dependent promotion cell; failure blocks all production qualification |

## 5. Algebra parity gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| ALG-1 operator dictionary | Seeded complex tangent vectors over admitted local/exchange/demag blocks | Direct application of note 0831's `L`, `B_alpha` and `i*omega*B_alpha-L` dictionary | Modal/driven action relative error and sign/unit mismatch count | action `<=1e-9`; mismatches `0` | action `<=1e-11`; mismatches `0` | `validation/algebra/operator_dictionary.v1.json` | All exact operator-set cells |
| ALG-2 complex/real split | Multi-mode interior-window descriptor with known complex representation | Complex arithmetic path versus named `real_frequency_rotated` realization | Action error, frequency-cluster error, invariant-subspace sine, J-closure | action `1e-9`; cluster/subspace `1e-7`; J failures `0` | action `1e-11`; cluster/subspace `1e-9`; J failures `0` | `validation/k0_poisson_airbox/interior_window.v1.json` | CPU modal cells using the passed scalar representation |
| ALG-3 full/Schur parity | Same descriptor and exact-signature Schur certificate | Full descriptor direct solve | Modal cluster, driven complex response and reconstructed full residual | modal `1e-6`; response `1e-5`; residual `1e-6` | modal `1e-8`; response `1e-7`; residual `1e-8` | `validation/algebra/full_schur_parity.v1.json` and certificate | Only Schur-engine cells with the exact certificate signature |
| ALG-4 dense/sparse/action parity | Bounded deterministic descriptors with multiple sparsity patterns | Dense oracle assembled independently from sparse and MatShell paths | Matrix/action error and accepted/rejected outcome equality | `<=1e-9`; outcome mismatches `0` | `<=1e-11`; outcome mismatches `0` | `validation/algebra/dense_sparse_action.v1.json` | Exact CPU engines; no physical promotion without physics gates |

## 6. Modal gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| MOD-1 finite-mode and full residual | Descriptors containing finite, algebraic, zero and rejected modes | Direct dense finite-spectrum classification plus original block action | Classification mismatch, `eps_full`, positive-branch/mapping mismatch | mismatches `0`; `eps_full<=1e-6` | mismatches `0`; `eps_full<=1e-8` | spectrum and solver diagnostics with all block residuals | Exact modal cells |
| MOD-2 interior-window completeness | At least three positive modes around a nonzero interior target and a wrong-axis negative control | Dense full spectrum outside the production selection path | Missing/extra physical classes, multiplicity/subspace error, negative-control outcome | missing/extra `0`; subspace `<=1e-6`; negative control fails | missing/extra `0`; subspace `<=1e-8`; negative control fails | `validation/k0_poisson_airbox/interior_window.v1.json` | Exact modal target/window/engine cells |
| MOD-3 shape-first branch tracking | Field or k sweep with crossings and a uniform branch | Mass-inner-product Hungarian/cluster tracker using exported modes; no analytical frequency | Uniform overlap, previous-point overlap, tangent leakage, seam mismatch, branch gaps | uniform `>=0.85`; overlap `>=0.70`; leakage/seam `<=1e-6`; gaps `0` | uniform `>=0.95`; overlap `>=0.85`; leakage/seam `<=1e-8`; gaps `0` | `eigen/branches.v2.json`, mode metadata/fields and selection audit | Exact modal sweep/path cells, including chapter 15 Kittel |
| MOD-4 damped/nonnormal spectrum | Small damped or nonconservative problem with left/right vectors | Independent dense QZ or direct response oracle | Eigenvalue cluster, biorthogonality, damping sign, response reconstruction | cluster/biorthogonality `1e-6`; sign failures `0`; response `1e-4` | `1e-8`; sign failures `0`; response `1e-6` | damped spectrum, left/right metadata and response cross-check | Only exact damped/nonconservative cells |

## 7. Driven gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| DRV-1 physical RHS and original residual | Nonzero transverse RF drive plus zero-RHS negative/degenerate case | Direct projected RHS from `T^T[-gamma0(m0 x delta_h)]` and direct operator action | RHS action error, `eps_full`, stop-reason mismatch | RHS `1e-9`; residual `1e-6`; mismatches `0` | RHS `1e-11`; residual `1e-8`; mismatches `0` | response diagnostics and per-frequency artifacts | Exact driven engine/drive cells |
| DRV-2 full/field-split/Schur | Same blocks and sweep through all admitted CPU engines | Sparse-direct full solve on bounded samples | Complex field/observable delta, residual and accepted/rejected equality | field/observable `1e-4`; residual `1e-6`; mismatches `0` | `1e-6`; residual `1e-8`; mismatches `0` | `validation/response/engine_parity.v1.json` | Each engine independently, only over sampled size/frequency envelope |
| DRV-3 reduced response | Resonant and off-resonant sweep with omitted-mode negative control | Full coupled solve not used to construct the reduced basis | Observable/field error, original residual, enrichment/fallback outcome | error `1e-2`; residual `1e-5`; negative control rejects/enriches | error `2e-3`; residual `1e-7`; negative control rejects/enriches | basis certificate, response sweep and reduction audit | Exact ROM method/window/operator cells only |

## 8. Periodic and Floquet gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| PBC-1 equivalence classes and frame transport | Corner/edge-rich periodic mesh with varying tangent frames | Independent graph closure and Cartesian reconstruction | Missing/duplicate members, cycle phase/frame residual, orientation/topology mismatch | counts `0`; phase `<=1e-10` rad; frame `<=1e-9` | counts `0`; phase `<=1e-12` rad; frame `<=1e-11` | periodic mesh certificate and pair/class artifacts | Exact periodic K0/nonzero-k cells using that topology |
| PBC-2 K0 reduction parity | Same primitive cell through chapter 18 and chapter 23 at Gamma | Direct equality of assembled K0 blocks/actions after explicit permutation | Per-block/action error, gauge transition mismatch, spectrum/response delta | action `1e-9`; observable `1e-6`; mismatches `0` | action `1e-11`; observable `1e-8`; mismatches `0` | `validation/floquet/k0_limit.v1.json` | Nonzero-k cells only after their matching K0 cell passes |
| PBC-3 manufactured Bloch Poisson | Complex manufactured potential/source at axial and oblique signed k | Independent matched-mesh `C_phi(k)^H P C_phi(k)` oracle or separate refinement sequence | L2/H1 order, phase/flux/seam error, sign-negative-control outcome | L2 `>=1.7`; H1 `>=0.8`; seam/flux `<=1e-6`; negative control fails | L2 `>=1.9`; H1 `>=0.95`; seam/flux `<=1e-8`; negative control fails | `validation/floquet/manufactured_poisson.v1.json`, raw levels | Nonzero-k demag cells for the exact k/BC domain |
| PBC-4 production/oracle operator parity | Signed axial/oblique k samples with all five Task 7 blocks | Independent `C_m(k)`/`C_phi(k)` reduction when matching basis exists; otherwise independent three-level sequence | Raw action error or bounded convergence/observable error; demag sign | raw `1e-8` or convergence `5e-2`; sign failures `0` | raw `1e-10` or convergence `2e-2`; sign failures `0` | Floquet parity certificate with declared comparison mode | Exact nonzero-k operator-set cells |
| PBC-5 DE/BV dispersion and symmetry | Signed DE/BV k paths, K0 endpoint, declared symmetry-map cases | Postsolve analytical/semi-analytical limits and transformed symmetry pairs | Branch/cluster error, K0 limit, transformed `k<->-k` error | `<=5e-2`; K0 `<=1e-2`; symmetry `<=1e-3` | `<=2e-2`; K0 `<=2e-3`; symmetry `<=1e-5` | dispersion, branches, mode fields, symmetry-map and convergence artifacts | Exact modal nonzero-k cells; driven cells need matched response evidence |

## 9. CPU/GPU parity gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| GPU-1 block and operator apply | Identical CPU/GPU problem signatures and seeded vectors over each qualified block | Qualified CPU double path | Per-block/action and reconstructed-field relative error | `<=1e-8` | `<=1e-10` | `validation/cpu_gpu/operator_parity.v1.json` | GPU cells for the exact operator/k/demag scope |
| GPU-2 scalar and shifted solves | Identical Poisson and shifted systems with repeated solves | Qualified CPU residual-certified solve | Solution/action error, contraction, original residual and setup reuse | solution `1e-7`; residual `1e-6`; reuse failures `0` | solution `1e-9`; residual `1e-8`; reuse failures `0` | scalar/shifted parity plus transfer audit | GPU solver/preconditioner cells only |
| GPU-3 modal parity | Exact CPU/GPU modal bundles including degeneracies | Qualified CPU cluster/subspace result | Frequency cluster, invariant-subspace sine, residual/outcome mismatch | cluster/subspace `1e-6`; residual `1e-6`; mismatches `0` | cluster/subspace `1e-8`; residual `1e-8`; mismatches `0` | `validation/k0_poisson_airbox/cpu_gpu_parity.v1.json` or Floquet equivalent | Exact GPU modal cells |
| GPU-4 driven parity | Exact CPU/GPU complex sweeps | Qualified CPU full response | Complex field/observable error, residual and stop-reason mismatch | error `1e-5`; residual `1e-6`; mismatches `0` | error `1e-7`; residual `1e-8`; mismatches `0` | response CPU/GPU parity and point diagnostics | Exact GPU driven cells |

CPU/GPU parity never promotes CPU evidence into GPU residency. Single precision
requires its own error budget and physics qualification; double-precision
parity cannot promote a single-precision cell.

## 10. Performance and residency gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| PERF-1 GPU hot-loop residency | At least one restart and enough iterations to exercise operator and preconditioner reuse | Transfer counters plus profiler/runtime trace from an independent instrumentation layer | Per-iteration H2D/D2H transfers, hidden host solve count, hot-loop buffer locations | all forbidden counts `0`; all hot-loop buffers `device` | same, with no waiver | `gpu_transfer_audit.v1.json` and trace summary | GPU modal or driven cells only; probes cannot satisfy it |
| PERF-2 persistent setup and memory | Repeated k/frequency/target solves within one unchanged signature, plus signature-change invalidation | Allocation tracker and context-key audit | Rebuild count, leaked bytes, peak device/host bytes, invalid reuse | unchanged-signature rebuilds `0`; leaks `0`; peak within declared initial envelope | same; peak `<=1.05` of accepted release baseline | context lifecycle and memory artifact | Exact persistent GPU engine cells |
| PERF-3 runtime envelope | Checked-in small, medium and largest-qualified workloads with fixed hardware/software identity | Previous accepted release baseline and CPU reference where applicable | Median and p95 wall time, setup/solve split, iterations, throughput | p95 `<=1.25` baseline or explicitly lower provisional ceiling | p95 `<=1.10` accepted baseline; no unexplained iteration regression | benchmark manifest, raw samples and environment identity | Exact engine/size/hardware envelope only |
| PERF-4 bounded scaling | At least three distinct DOF levels without duplicated rows | Complexity fit and memory accounting independent of solver success | Observed time/memory slope and out-of-memory boundary | finite fit; no superlinear memory beyond declared algorithm | fitted slope within declared engine model plus `10%`; no leak or hidden dense allocation | raw scaling table and fit artifact | Exact size envelope, not larger unmeasured problems |

Performance gates are not correctness substitutes. A slower but bounded CPU
cell may qualify if it meets its declared product envelope; a GPU cell cannot
qualify as device resident without PERF-1 even when wall time is low.

## 11. Artifact and provenance gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| ART-1 schema and cross-artifact identity | Complete, failed and interrupted modal/driven bundles | Independent schema/resource validator | Missing fields, invalid direct/coverage binding, missing `validation_artifact_manifest.v1` sidecar for CSV/Zarr/non-object artifacts, scope-catalog digest failure, scope or coverage-rule schema failure, hash/signature mismatch, dangling path, status contradiction | all counts `0` | all counts `0` | manifest, solver diagnostics, spectra/response, mesh and validation artifacts | All cells |
| ART-2 requested/resolved truth | Strict CPU, strict GPU, auto and explicit-fallback fixtures | Planner request compared with runtime and artifact provenance | Hidden fallback, device/precision/engine mismatch, absent rejection token | all counts `0` | all counts `0` | plan, manifest, diagnostics and rejection artifact | All cells; strict GPU mismatch blocks GPU promotion |
| ART-3 validation isolation | Kittel, DE/BV, manufactured and CPU-reference bundles | Data-flow audit from solver request through postsolve verifier | Analytical/fitted/reference fields present in assembly, target, selection, certificate or solver pass/fail payload | occurrences `0` | occurrences `0` | validation-isolation report and request/artifact schemas | Every analytical-validation cell |
| ART-4 product/API/UI consistency | Published modal and driven resource bundles | OpenAPI/type/resource validator and browser-facing resource inventory | Missing resource, unit mismatch, stale revision, UI claim beyond artifact state | all counts `0` | all counts `0` | API contract report and artifact resource index | Cells exposed through API/UI |
| ART-5 promotion record | Candidate canonical-scope release bundle | Chapter 24 machine-readable checklist validator | Missing applicable item, invalid canonical scope/hash/catalog/coverage binding, empty/wildcard `validated_scope`, stale evidence, unresolved blocker | all counts `0` | all counts `0` | production DoD record linked to immutable evidence | Only the canonical recorded readiness cell |

## 12. Promotion boundaries and current truth

The matrices above are requirements, not evidence that they pass. Current
source-visible helpers, synthetic descriptors, old managed artifacts, tiny
dense GPU exceptions and partial driven-response lanes retain only their
existing bounded status. In particular:

- `synthetic_algebraic_oracle` can satisfy algebra gates but cannot promote
  real shared-domain Poisson-airbox physics;
- a no-demag K0 macrospin GPU result cannot promote GPU Poisson-airbox modal,
  nonzero-k Floquet, or driven-response cells;
- operator/apply probes cannot satisfy a solver or residency gate;
- a best observed convergence row without raw independent levels cannot
  satisfy convergence; and
- `production_executable` remains distinct from `production_qualified`.

Promotion occurs only when chapter 24 accepts every applicable
`verified_coverage_of`/`validation_scope_binding.v1` for one recomputed
canonical `scope_id`, and the readiness/capability status is updated by its own
owning task.
<!-- END 09_validation_certification_benchmarks.md -->

<!-- BEGIN 10_patch_queue_current_status.md -->
---
title: Frequency-domain readiness current status
date: 2026-07-10
status: implementation_status
source_of_truth:
  - 25_frequency_domain_readiness_matrix.json
  - 25_frequency_domain_readiness_scope_catalog.json
runtime_revalidated_in_this_update: false
scope:
  - FEM modal_eigen
  - FEM driven_response
  - CPU and GPU
  - k0 and nonzero_k
  - no-demag and dynamic-demag scopes
---

# Frequency-domain readiness current status

This chapter is a strict human-readable projection of
`25_frequency_domain_readiness_matrix.json`. The JSON file is the detailed
status source for the active masterplan. This file must not carry a separate
patch diary, alternate scope schema or promotion claim.

No tests, builds, examples, managed runtimes or solvers were run for this
update:

```text
runtime_revalidated_in_this_update = false
```

## Status axes

Every readiness claim uses independent implementation and validation axes:

| Axis | Values | Meaning |
|---|---|---|
| `implementation_state` | `absent`, `contract_only`, `source_visible`, `executable` | What exists or can run. |
| `validation_state` | `unvalidated`, `algebra_validated`, `physics_validated`, `production_qualified` | What evidence validates. |
| `validated_scope` | `null` or `readiness_scope_binding.v1` direct reference | `null` for unvalidated cells; otherwise contains semantic `scope_id`, `scope_catalog_uri` and `scope_catalog_sha256`. The full scope resolves in `25_frequency_domain_readiness_scope_catalog.json`. |
| `executable_scope` | `null` or `readiness_scope_binding.v1` direct reference | Present only when a narrow executable slice exists while `validated_scope=null`; the full executable scope resolves in the same external catalog. |

The cited legacy artifacts do not yet emit `scope_catalog.v1`. Non-null
`validated_scope` and `executable_scope` references are readiness projection
bindings that future runtime artifacts must carry before production promotion.
They are not fresh runtime revalidation.

All non-null scope references in this matrix use:

```text
scope_catalog_uri = urn:fullmag:frequency-domain:readiness-scope-catalog:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
scope_catalog_sha256 = sha256:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
scope_catalog_path = docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json
scope_catalog_status = readiness_projection_pending_runtime_scope_catalog_v1_emission
```

## JSON-derived readiness table

| Cell ID | Implementation | Validation | `validated_scope` | Evidence or executable scope | Production blocker |
|---|---|---|---|---|---|
| `modal_cpu_k0_none_macrospin_larmor` | `executable` | `physics_validated` | `modal_cpu_k0_none_macrospin_larmor.validation` | K0-1 no-demag macrospin/Larmor field sweep, CPU dense SLEPc path; precision=`double`. | No K0 dynamic-demag coverage; no production DoD closure for broader modal eigensolve. |
| `modal_gpu_k0_none_macrospin_larmor` | `executable` | `physics_validated` | `modal_gpu_k0_none_macrospin_larmor.validation` | K0-1 no-demag macrospin/Larmor field sweep using `gpu_dense_k0_macrospin_modal_eigen`; precision=`double`. | Does not qualify nonzero-k, demag, sparse, matrix-free or persistent GPU modal eigensolve. |
| `modal_gpu_k0_none_general_modal` | `source_visible` | `unvalidated` | `null` | Source evidence only. | The macrospin slice is not a general GPU modal eigensolver. |
| `modal_cpu_nonzero_k_none_selected_spectrum` | `executable` | `unvalidated` | `null` | Executable scope `modal_cpu_nonzero_k_none_selected_spectrum.executable`: managed native CPU selected-spectrum no-demag Floquet k-path slice with labelled Bloch/Floquet tangent payload and analytic/reciprocal exchange-only gates. | Dynamic demag-k and broad production DoD remain open. |
| `modal_gpu_nonzero_k_none` | `absent` | `unvalidated` | `null` | None. | No nonzero-k Floquet GPU modal operator/eigensolver exists. |
| `modal_cpu_k0_periodic_airbox_synthetic_oracle` | `executable` | `algebra_validated` | `modal_cpu_k0_periodic_airbox_synthetic_oracle.validation` | Tiny synthetic full-descriptor Poisson-airbox fixtures and SLEPc algebra/oracle coverage only; precision=`double`. | Not real shared-domain FEM assembly or K0-3 physics validation. |
| `modal_cpu_k0_periodic_airbox_real_shared_domain` | `source_visible` | `unvalidated` | `null` | Source evidence only. | Real MFEM weak-form assembly, imaginary-axis target, Kittel independence and convergence remain open. |
| `modal_gpu_k0_periodic_airbox_dense_probe` | `source_visible` | `unvalidated` | `null` | Target label: `gpu_dense_contract_eigensolver`; current emitted GPU modal validation lane remains `gpu_dense_k0_macrospin_modal_eigen` for the no-demag macrospin cell only. | Target label is not emitted as a production modal artifact; no scalable GPU selected-spectrum eigensolver; no real shared-domain physics qualification. |
| `modal_gpu_k0_periodic_airbox_scalable` | `absent` | `unvalidated` | `null` | None. | Persistent GPU modal context, Ritz extraction, restart, convergence and transfer audit are missing. |
| `modal_cpu_nonzero_k_floquet_airbox` | `contract_only` | `unvalidated` | `null` | Contract evidence only. | `missing_numeric_fem_demag_k`; production CPU modal dynamic-demag-k operator unavailable. |
| `modal_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | Nonzero-k GPU modal dynamic-demag operator unavailable. |
| `driven_cpu_k0_none` | `executable` | `unvalidated` | `null` | Executable scope `driven_cpu_k0_none.executable`: bounded gamma/free-boundary and k0 static-periodic no-demag slices. | Needs exact-scope DoD and validation record. |
| `driven_gpu_k0_none` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_k0_none.executable`: bounded gamma/free-boundary and k0 static-periodic GPU operator-host Krylov slices; not `gpu_device_krylov`. | No full device-resident Krylov loop; no production qualification record. |
| `driven_cpu_k0_periodic_airbox` | `executable` | `unvalidated` | `null` | Executable scope `driven_cpu_k0_periodic_airbox.executable`: partial periodic_airbox_k0 Schur/provider response artifacts, not full assembled coupled `[delta_m, delta_phi]` production qualification. | Production validation gates are not closed; no fresh runtime revalidation. |
| `driven_gpu_k0_periodic_airbox_gpu_operator_host_krylov` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_k0_periodic_airbox_operator_host_krylov.executable`: partial periodic_airbox_k0 GPU operator-host Krylov artifacts with hybrid or host Poisson demag provider. | Hybrid/host Poisson residency and operator-host Krylov do not satisfy strict GPU demag or device-Krylov claims. |
| `driven_gpu_k0_periodic_airbox_gpu_device_krylov` | `source_visible` | `unvalidated` | `null` | Source evidence only. | `production_loop_available=false`; no integrated device Krylov loop; no zero-per-iteration-transfer proof. |
| `driven_cpu_nonzero_k_none_phase_projection` | `executable` | `unvalidated` | `null` | Executable scope `driven_cpu_nonzero_k_none_phase_projection.executable`: no-demag/non-DMI Floquet phase-projection response slice with complete pair metadata and Bloch-phased tangent drive. | Not full nonzero-k Floquet assembly; no dynamic demag-k. |
| `driven_gpu_nonzero_k_none_phase_projection` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_nonzero_k_none_phase_projection.executable`: no-demag/non-DMI Floquet phase-projection response slice; local/exchange CUDA operator support only. | Not full nonzero-k Floquet assembly; no GPU dynamic demag-k; no `gpu_device_krylov` proof. |
| `driven_cpu_nonzero_k_floquet_airbox` | `contract_only` | `unvalidated` | `null` | Contract evidence only. | `floquet_airbox_dynamic_demag_k_unimplemented`; `missing_numeric_fem_demag_k`. |
| `driven_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | No strict GPU fallback to CPU is allowed. |

## Current high-signal truths

1. GPU K0 no-demag macrospin modal is a real narrow legacy-evidenced slice
   through `gpu_dense_k0_macrospin_modal_eigen`. The readiness projection
   scopes that evidence to precision=`double` and to the no-demag macrospin
   field sweep only.
2. GPU K0 Poisson-airbox modal is not production qualified. The target
   `gpu_dense_contract_eigensolver` label is retained as a target/source-visible
   contract, not as an emitted production modal artifact.
3. CPU K0 real shared-domain Poisson-airbox modal is not production qualified.
   Current source still shows the topology-shaped Kittel payload and the real
   PETSc target issue. The owned docs mark that as a blocker, not a closed
   production path.
4. Nonzero-k dynamic demag is not production qualified on CPU or GPU. No
   modal or driven cell may replace it with K0 demag, open-boundary demag,
   no-demag phase projection or a CPU fallback for strict GPU.
5. Driven `periodic_airbox_k0` CPU/GPU paths are partial executable slices.
   Existing artifacts show useful Schur/provider and phi-consistency telemetry,
   but they are not blanket `production_qualified` status and do not promote
   modal eigensolve.
6. `gpu_device_krylov` is not executable as a production loop without the full
   device-resident Krylov implementation, transfer audit and true residual
   proof. Current executable GPU driven response is `gpu_operator_host_krylov`
   or a compatibility lane unless a future cell proves otherwise.

## Capability matrix integration

`docs/specs/capability-matrix-v0.md` and `.json` are consumed here but remain
owned by the parallel dynamic-solver remediation plan. This task does not edit
them.

External ownership for the parallel plan:

- correct any stale heading or downstream copy that calls the seven
  product-facing statuses a "four-state status vocabulary";
- add links from capability-matrix frequency-domain rows to
  `25_frequency_domain_readiness_matrix.json`;
- keep the product-facing status summary separate from
  `implementation_state`, `validation_state` and `validated_scope`;
- preserve broad runtime booleans such as `supports_frequency_response=false`
  as coarse capability gates, while using `frequency_domain_capabilities.v1`
  and this JSON matrix for the narrow executable slices.

When those broad booleans coexist with a narrow executable FEM
`driven_response` slice, the boolean is not a contradiction: it says the broad
solver family is not generally supported, while the readiness cell says a
bounded slice can execute under explicit prerequisites.

## Evidence read for this update

Static evidence used:

- `docs/specs/capability-matrix-v0.md`
- `docs/specs/capability-matrix-v0.json`
- `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json`
- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
- `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`
- `.superpowers/sdd/fd-masterplan-task-4-report.md`
- `.superpowers/sdd/fd-masterplan-task-5-report.md`
- `.superpowers/sdd/fd-masterplan-task-6-report.md`
- `.superpowers/sdd/fd-masterplan-task-7-report.md`
- `.superpowers/sdd/fd-masterplan-task-8-report.md`
- `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-cpu-gpu-comparison-summary.v1.json`
- `.fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/diagnostics/solver.v1.json`
- `.fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts/response/diagnostics/solver.v1.json`
- `.fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts/response/diagnostics/solver.v1.json`
<!-- END 10_patch_queue_current_status.md -->

<!-- BEGIN 11_runtime_telemetry_performance.md -->
---
title: Frequency-domain runtime telemetry and performance contract
date: 2026-07-10
status: implementation_status
runtime_revalidated_in_this_update: false
---

# Runtime telemetry and performance contract

This file defines the telemetry fields and threshold rules required before a
FEM frequency-domain readiness cell may move beyond executable source/runtime
availability. It is normative for artifact shape and interpretation. It is not
a chronology of managed runs.

No tests, builds, examples, runtimes or solvers were run for this update.

## 1. Placement and migration rule

The existing response-diagnostics root remains canonical. This chapter does
not introduce a competing root diagnostic schema. Frequency-domain runtime
telemetry is a named object directly under that existing response diagnostics
root:

```json
{
  "schema_version": "existing_response_diagnostics_schema",
  "runtime_telemetry": {
    "schema_version": "frequency_domain_runtime_telemetry.v1",
    "study_product": "modal_eigen|driven_response",
    "requested_execution": {},
    "resolved_execution": {},
    "implementation_state": "absent|contract_only|source_visible|executable",
    "validation_state": "unvalidated|algebra_validated|physics_validated|production_qualified",
    "validated_scope": null,
    "runtime_revalidated_in_this_update": false
  }
}
```

Migration rule:

1. Existing root diagnostic fields remain readable until their owning artifact
   schema is migrated.
2. New or rewritten frequency-domain diagnostics write the canonical values
   under root `runtime_telemetry`.
3. During migration, duplicate root fields are compatibility mirrors only.
   If a root mirror and `runtime_telemetry` disagree, `runtime_telemetry` is
   authoritative and the artifact is degraded.
4. No artifact may publish a second root `schema_version` named
   `frequency_domain_runtime_telemetry.v1`.
5. A response diagnostics artifact that is already the diagnostics root must
   not add a phantom `diagnostics` wrapper around `runtime_telemetry`.

For GPU, the nested object must distinguish:

```text
requested device = gpu
resolved device = gpu
resolved solver method = gpu_operator_host_krylov | gpu_device_krylov | gpu_modal_device_krylov | gpu_dense_k0_macrospin_modal_eigen | ...
demag provider residency = cpu | gpu | none
```

`resolved_execution.device=gpu` does not by itself prove device-resident Krylov
or strict GPU demag residency.

## 2. Acceptance residual contract

The only residual that may satisfy readiness or production acceptance is the
reconstructed original-unscaled block/full residual for the original operator
or descriptor. Scaled, transformed, preconditioned, normalized, shifted or
solver-reported residuals are diagnostics with distinct names; they cannot
satisfy acceptance and cannot be silently substituted.

### Driven response

Driven response must report:

```json
{
  "residual_acceptance_name": "driven_original_unscaled_full_relative_residual",
  "driven_original_unscaled_full_relative_residual": 0.0,
  "driven_original_unscaled_magnetic_block_relative_residual": 0.0,
  "driven_original_unscaled_scalar_block_relative_residual": 0.0,
  "driven_original_unscaled_residual_threshold": 0.0,
  "tracked_krylov_relative_residual_diagnostic": 0.0,
  "preconditioned_relative_residual_diagnostic": 0.0,
  "scaled_block_relative_residual_diagnostic": 0.0,
  "transformed_operator_relative_residual_diagnostic": 0.0,
  "residual_consistency_relative_gap": 0.0,
  "residual_consistency_relative_gap_threshold": 0.1,
  "residual_consistency_status": "ok|degraded|not_available",
  "coupled_residual_partition_status": "none|magnetic_only|scalar_only|coupled|provider_specific"
}
```

Acceptance rules:

- `status=ready` requires
  `driven_original_unscaled_full_relative_residual <= driven_original_unscaled_residual_threshold`.
- The magnetic and scalar block residuals must be reconstructed against the
  original unscaled block equations and must be reported even when the
  implementation also publishes scaled diagnostics.
- A tracked GMRES residual alone is diagnostic only.
- If `residual_consistency_relative_gap > residual_consistency_relative_gap_threshold`,
  the solve is degraded or failed even when the tracked residual is small.
- `scaled_block_relative_residual_diagnostic` and
  `transformed_operator_relative_residual_diagnostic` are never acceptance
  residuals.

### Modal eigensolve

Modal artifacts must report:

```json
{
  "residual_acceptance_name": "modal_original_unscaled_full_descriptor_backward_error",
  "modal_original_unscaled_full_descriptor_backward_error": 0.0,
  "modal_original_unscaled_magnetic_block_backward_error": 0.0,
  "modal_original_unscaled_poisson_block_backward_error": 0.0,
  "modal_original_unscaled_gauge_constraint_backward_error": 0.0,
  "modal_original_unscaled_full_descriptor_threshold": 0.0,
  "slepc_reported_backward_error_diagnostic": 0.0,
  "scaled_descriptor_backward_error_diagnostic": 0.0,
  "transformed_pencil_backward_error_diagnostic": 0.0,
  "reconstruction_vs_slepc_ratio": 0.0,
  "eps_full_original_unscaled": 0.0,
  "finite_mode_filter_status": "passed|failed|not_applicable"
}
```

Acceptance rules:

- `eps_full_original_unscaled = max(eps_q, eps_phi, eps_gauge)`, with all
  components reconstructed against the original unscaled descriptor blocks.
- `modal_original_unscaled_full_descriptor_backward_error` is derived from the
  reconstructed original descriptor, never from the smaller of the SLEPc
  residual and reconstruction residual.
- SLEPc-reported, shifted, scaled or transformed residuals remain diagnostics.
- Candidate conjugates are evaluated only as the mathematically paired
  `(conj(lambda), conj(x))` mode and cannot hide a wrong positive branch.
- A monolithic descriptor solve must identify and reject algebraic or infinite
  modes before reporting modal readiness.

## 3. Iteration and stop telemetry

Every solver result and progress/partial artifact must include:

```json
{
  "outer_iteration_count": 0,
  "inner_iteration_count": 0,
  "total_iteration_count": 0,
  "restart_iterations": 0,
  "max_iterations": 0,
  "stop_reason": "converged|stagnated|max_iterations|residual_consistency_degraded|cancelled|interrupted|validation_error|operator_error",
  "stagnation_detected": false,
  "stagnation_iteration": 0,
  "stagnation_relative_residual_ratio": 0.0
}
```

Rules:

- Long runs must publish enough progress telemetry that an interrupted solve
  still identifies the solver method, preconditioner, residual status and
  requested/resolved execution.
- A stagnation stop is a failed or degraded solve unless the readiness cell
  explicitly describes a failure-observability gate.
- `max_iterations` exhaustion cannot be reinterpreted as validation.

## 4. Schur and preconditioner quality

Right-preconditioner and Schur-provider diagnostics must include:

```json
{
  "krylov_preconditioner_requested_variant": "auto|graph_demag_coarse|demag_coarse|block_jacobi|none",
  "krylov_preconditioner_variant": "auto|graph_demag_coarse|demag_coarse|block_jacobi|none",
  "right_preconditioner_auto_disabled": false,
  "right_preconditioner_auto_disable_reason": "",
  "right_preconditioner_probe_original_unscaled_relative_residual": 0.0,
  "schur_preconditioner_quality_available": false,
  "schur_preconditioner_quality_status": "helpful|neutral|harmful|not_available|not_applicable",
  "schur_preconditioner_initial_original_unscaled_relative_residual": null,
  "schur_preconditioner_last_original_unscaled_relative_residual": null,
  "schur_preconditioner_contraction_ratio": null,
  "schur_preconditioner_contraction_ratio_threshold": 1.0,
  "schur_preconditioner_quality_apply_count": 0
}
```

Normative interpretation:

- `schur_preconditioner_contraction_ratio` is
  `last_original_unscaled / initial_original_unscaled`; values greater than
  `schur_preconditioner_contraction_ratio_threshold` are not helpful.
- If no Schur/preconditioner path applies to the selected lane, publish
  `schur_preconditioner_quality_status=not_applicable` and set the Schur
  residuals and contraction ratio to `null`.
- If a Schur/preconditioner path applies but the quality probe was not emitted,
  publish `schur_preconditioner_quality_status=not_available` and set the
  Schur residuals and contraction ratio to `null`.
- A contraction ratio is defined only when both residuals are finite and the
  initial original-unscaled residual is positive. Otherwise the ratio is
  `null` and cannot be used as helpfulness evidence.
- A preconditioner is `helpful` only when its application lowers the true
  original-unscaled residual under the same original operator.
- `harmful` or auto-disabled preconditioners are useful diagnostics but not
  production qualification evidence.
- A Schur/provider response can be executable while still unqualified if it
  lacks full coupled block assembly, original-unscaled residual proof or
  validation gates for the exact physics scope.

## 5. Poisson setup and solve-count invariants

Dynamic-demag or Poisson-airbox paths must publish:

```json
{
  "poisson_setup_count": 0,
  "poisson_solve_count": 0,
  "poisson_operator_apply_count": 0,
  "poisson_operator_signature": null,
  "poisson_operator_signature_status": "available|not_applicable",
  "poisson_setup_signature_count": 0,
  "poisson_setup_reuse_count": 0,
  "poisson_operator_mode": "none|host_mfem_poisson_provider|hybrid_cpu_poisson|device_hypre_poisson|mfem_weak_form_shared_domain",
  "phi_gauge_policy": "none|mean_zero|mean_zero_augmented|matrix_free_provider_responsibility",
  "phi_gauge_constraint_applied": false,
  "delta_phi_seam_validation_status": "ok|mismatch|not_run",
  "delta_phi_flux_validation_status": "ok|mismatch|not_run",
  "h_demag_seam_validation_status": "ok|mismatch|not_run"
}
```

Invariants:

- `poisson_operator_mode=none` requires setup, solve, apply, signature and
  reuse counts to be zero, `poisson_operator_signature=null` and
  `poisson_operator_signature_status=not_applicable`.
- `poisson_operator_signature` is a content signature only when a Poisson or
  dynamic-demag operator exists. The string `"none"` is not a valid
  no-Poisson signature.
- For a frequency-invariant operator signature, setup count is exactly one per
  unique `poisson_operator_signature`; additional right-hand sides increase
  solve/apply counts, not setup count.
- `poisson_setup_reuse_count` must account for every solve/apply that reused a
  previously built operator or preconditioner.
- `poisson_solve_count` and `poisson_operator_apply_count` must not decrease
  across progress snapshots for one run.
- `hybrid_cpu_poisson` and `host_mfem_poisson_provider` are compatibility or
  CPU-resident demag provider modes. They do not satisfy strict GPU demag
  residency.
- For `poisson_robin` and `poisson_dirichlet`, modal descriptor artifacts must
  use `gauge_policy=none`; pure Neumann may use mean-zero gauge.
- Seam and flux checks are necessary observability fields, but they do not
  replace residual, convergence, energy or independent physical validation.

## 6. CPU/GPU memory, workspace and transfer audit

Every artifact must publish CPU memory counters. GPU artifacts must publish
both CPU and GPU counters. Counter units are bytes unless the field name says
otherwise.

```json
{
  "cpu_allocated_bytes": 0,
  "cpu_peak_bytes": 0,
  "cpu_setup_allocated_bytes": 0,
  "gpu_allocated_bytes": 0,
  "gpu_peak_bytes": 0,
  "gpu_setup_allocated_bytes": 0,
  "workspace_reuse_count": 0,
  "workspace_rebuild_count": 0,
  "workspace_reuse_required": false,
  "hot_loop_host_allocated_bytes": 0,
  "hot_loop_device_allocated_bytes": 0,
  "hot_loop_h2d_bytes": 0,
  "hot_loop_d2h_bytes": 0,
  "hot_loop_allocation_count": 0,
  "scalar_reduction_count": 0,
  "scalar_reduction_bytes": 0,
  "scalar_reduction_bytes_threshold": 0,
  "krylov_vector_location": "host|device|not_applicable",
  "operator_input_location": "host|device|mixed",
  "operator_output_location": "host|device|mixed",
  "preconditioner_input_location": "host|device|mixed|not_applicable",
  "preconditioner_output_location": "host|device|mixed|not_applicable",
  "gpu_device_resident_solver": false,
  "gpu_device_resident_operator_apply": false,
  "gpu_device_resident_modal_eigensolver": false
}
```

Interpretation:

- `allocated_bytes` is current live allocation at artifact close; `peak_bytes`
  is the maximum observed live allocation during the run.
- `setup_allocated_bytes` is the portion allocated before the hot solve loop.
- `hot_loop_host_allocated_bytes` and `hot_loop_device_allocated_bytes` count
  allocations made after the hot loop begins; production GPU loop claims
  require `hot_loop_allocation_count == 0`.
- `workspace_reuse_required=true` requires `workspace_reuse_count > 0` and
  `workspace_rebuild_count == 0` inside the hot loop.
- `scalar_reduction_bytes` must stay at or below
  `scalar_reduction_bytes_threshold`; scalar reductions are diagnostics and
  progress signals, not hidden vector readback.

`gpu_device_krylov` or `gpu_modal_device_krylov` may be claimed only when all
of the following are true:

1. Krylov vectors, modal basis vectors, operator buffers and preconditioner
   buffers remain device resident through the loop.
2. `hot_loop_h2d_bytes == 0` and `hot_loop_d2h_bytes == 0`.
3. `hot_loop_host_allocated_bytes == 0` and `hot_loop_allocation_count == 0`.
4. Per-run setup bytes and library workspace creation are outside the hot loop
   and are identified by setup counters.
5. Orthogonalization, recurrence, residual update and preconditioner
   application are device side, with only bounded scalar/progress reductions.
6. The reconstructed original-unscaled residual trend matches a CPU oracle for
   the exact validated scope.

One-shot descriptor apply, dense inverse iteration or GPU operator callbacks
inside a host Krylov loop must report a narrower label such as
`gpu_operator_host_krylov` or `gpu_dense_k0_macrospin_modal_eigen`. The target
label `gpu_dense_contract_eigensolver` is not emitted until a modal artifact
publishes that label with the fields above.

## 7. Progress throttling

Progress policy is mode-dependent:

| Mode | Required behavior |
|---|---|
| Benchmark or validation batch | `progress_callback=null`, no live snapshots, no blocking GPU sync, partial artifacts only at controlled checkpoints. |
| UI | progress interval at least 128 iterations or 250 ms, snapshot interval at least 2000 ms, no synchronous GPU readback solely for display. |
| Debug | may emit more detail, but artifacts must mark debug mode and must not be used for performance/residency promotion. |

`progress_interval_iterations=0` never means "every iteration". It means the
solver uses the default throttled policy for the selected mode.

## 8. Partial and interrupted artifacts

Partial artifacts are first-class diagnostics. They must include:

```json
{
  "partial_artifacts_available": true,
  "partial_artifact_reason": "cancelled|interrupted|solve_error|validation_error|operator_error|progress_checkpoint",
  "complete": false,
  "solver_method": "string",
  "solver_preconditioner": "string",
  "requested_execution": {},
  "resolved_execution": {},
  "latest_residual_acceptance_name": "string",
  "latest_original_unscaled_residual_status": "ok|degraded|not_available",
  "latest_stop_reason": "string"
}
```

Rules:

- Partial artifacts may prove observability and failure classification.
- Partial artifacts do not prove production validation unless the readiness
  cell explicitly defines a failure-observability validation scope.
- Cancelled or interrupted runs must preserve enough provenance to avoid being
  mistaken for unsupported or successfully converged results.

## 9. Promotion requirements

A readiness cell may move to `production_qualified` only when telemetry shows:

1. exact requested/resolved execution for the cell;
2. reconstructed original-unscaled modal or driven residuals under the cell
   tolerance;
3. finite-mode, branch, tangent and seam checks where applicable;
4. preconditioner quality that is not harmful for the selected solver and has
   a Schur contraction ratio at or below its threshold when Schur is used;
5. Poisson/gauge policy and setup/solve-count invariants that match the
   boundary condition;
6. CPU/GPU allocated, peak, setup, workspace-reuse, hot-loop transfer and
   scalar-reduction counters matching any GPU claim;
7. complete immutable artifacts for the exact Task8 `validated_scope`;
8. validation gates from chapter 09 and production DoD from chapter 24.

No current broad periodic-airbox, nonzero-k dynamic-demag or device-Krylov
cell satisfies this full list.
<!-- END 11_runtime_telemetry_performance.md -->

<!-- BEGIN 12_adr_decisions.md -->
---
title: Frequency-driven solver - accepted ADR decisions
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# ADR decisions

## ADR-001 - GPU lane names

```text
gpu_operator_host_krylov: public transitional/provenance lane.
gpu_device_krylov: true device-resident Krylov only.
production_gpu: legacy alias.
```

## ADR-002 - Drive/RHS

```text
default drive_kind = dynamic_field_phasor_a_per_m
raw tangent_rhs = expert/debug/benchmark mode
```

## ADR-003 - Zero drive

```text
physical zero drive -> zero response + warning
required nonzero tangent RHS -> validation error
```

## ADR-004 - Phase token

```text
canonical output token = exp_plus_i_omega_t
input aliases may include exp_i_omega_t
```

## ADR-005 - Public field representation

```text
public = Cartesian dmX/dmY/dmZ
internal = tangent u/v
```

## ADR-006 - Schur certificate scope

Certificate key includes:

```text
mesh, FE space, material, m0, h_eff0, static demag, physics terms, boundary conditions, periodic/Floquet pairs, k-vector, demag operator, tangent frame policy, phase convention, backend version, frequency/frequency window.
```

## ADR-007 - Schur gates

```text
tiny/dense: 1e-10
CPU matrix-free: 1e-8
GPU/HYPRE: 1e-6
runtime eta gates as in validation doc
```

## ADR-008 - Direct sparse backend

```text
first backend = PETSc Mat AIJ + KSPPREONLY + PCLU.
```

## ADR-009 - Modal reduced basis policy

```text
use_existing_required
use_existing_or_compute
force_recompute
```

## ADR-010 - GPU device Krylov entry gate

```text
no runtime device FGMRES before phase, drive, equilibrium, sparse/direct, Schur/preconditioner, residual and transfer gates pass.
```

## ADR-011 - Relaxed texture handoff

```text
frequency-domain must consume accepted EquilibriumArtifact.
```

## ADR-012 - Symmetric mesh v1

```text
strict matched mesh for periodic/Floquet FEM v1.
```

## ADR-013 - DMI boundary status

```text
volume DMI after tests; frequency-domain DMI boundary terms experimental unless certified.
```

## ADR-014 - Gyromagnetic coefficient and field units

```text
effective fields and drive phasors = A/m
gamma = abs(gyromagnetic ratio) only when explicitly typed in rad/(s T)
gamma0 = mu0 * abs(gamma), in rad s^-1 per (A/m)
all A/m-field LLG and drive equations use gamma0
```

Authority: [`FrequencyOperatorDictionary.v1` in physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md).

## ADR-015 - Canonical sign and eigenvalue dictionary

```text
phasor = exp(+i omega t)
L q = lambda B q
lambda = i omega
driven operator = i omega B - L
drive = T^T[-gamma0 (m0 x delta_h_drive)]
energy-Hessian mapping at alpha=0: L=K, B=-G, K phi=-i omega G phi
```

These operator and sign definitions are the current
[`FrequencyOperatorDictionary.v1` in physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md).
Modal, driven, reduced, CPU, GPU, and real-split adapters consume this
dictionary. They may not define local sign conventions.

The absorbed-power contract remains separately authoritative in
[physics note 0700](../../../physics/0700-frequency-domain-linearized-llg.md):

```text
absorbed-power observable = absorbed_by_magnetization
p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)
```

The parallel plan may consolidate this observable and formula into note 0831
later, at which point note 0831 becomes the target sole dictionary authority.

## ADR-016 - Poisson boundary and gauge tuple

```text
poisson_robin with beta>0 -> gauge_policy=none,
                               gauge_reason=coercive_outer_boundary
poisson_dirichlet -> gauge_policy=none,
                     gauge_reason=coercive_outer_boundary
pure_neumann -> gauge_policy=mean_zero_augmented,
                gauge_reason=pure_neumann_nullspace
```

The tuple includes `outer_boundary_kind`, `gauge_policy`, and `gauge_reason`.
Mean-zero weights come from the active scalar FE quadrature. Periodic lateral
constraints do not imply a constant nullspace when the open boundary is
coercive. Authority:
[physics note 0830](../../../physics/0830-fem-poisson-airbox-modal-eigen.md).

## ADR-017 - Spectral target in real PETSc/SLEPc

```text
lambda = lambda_r + i lambda_i
omega = -i lambda
positive undamped branch: lambda_i > 0
frequency_hz = lambda_i/(2*pi)
sigma = i*omega_target
```

The managed runtime is `libpetsc-real-dev` plus `libslepc-real-dev`. It must
use the explicit ADR-017 real-split `real_frequency_rotated` pencil:

```text
R(L)y = omega R(i B_alpha)y
tau = omega_target
```

`EPSSetTarget(tau)` is legal only on `real_frequency_rotated`. A real
`EPSSetTarget(omega_target)` on the original `lambda=i omega` spectrum is
forbidden; it is not an approximation, fallback, or alternate production
representation. The artifact records the complex intent
`sigma=i*omega_target` and the real realization together.

## ADR-018 - Original-operator blockwise residual

Modal Poisson-airbox acceptance uses the reconstructed descriptor residuals:

```text
r_q     = A_qq q + A_qphi phi - lambda B_qq q
r_phi   = A_phiq q + P phi + c eta
r_gauge = c^T phi
eps_q = ||r_q|| / (||A_qq q|| + ||A_qphi phi|| + |lambda| ||B_qq q|| + eps)
eps_phi = ||r_phi|| / (||A_phiq q|| + ||P phi|| + ||c eta|| + eps)
eps_gauge = |r_gauge| / (||c|| ||phi|| + eps)
eps_full = max(eps_q, eps_phi, eps_gauge)
```

The accepted residual is dimensionless and blockwise scaled as specified by
notes 0830 and 0831. A transformed-, reduced-, preconditioned-, or
backend-reported residual is diagnostic only and cannot replace or cap it.

## ADR-019 - Damping and non-Hermitian modal policy

```text
omega_complex = omega_r + i Gamma
Gamma > 0 means decay for exp(+i omega t)
damping_rate_hz = Gamma/(2*pi)
linewidth_fwhm_hz = Gamma/pi
```

Gilbert damping or nonconservative torque makes the pencil non-Hermitian.
Hermitian-only eigensolvers are then forbidden. Direct modal response requires
left and right eigenvectors, declared normalization, biorthogonality and
conditioning diagnostics. A Petrov-Galerkin or rational Krylov alternative
must report the original-operator residual and retain a full-solver fallback.
<!-- END 12_adr_decisions.md -->

<!-- BEGIN 13_repo_migration_cleanup.md -->
---
title: FEM frequency-domain documentation migration policy
version: COMSOL-aligned v5.1 decision-complete
status: supporting
scope: documentation lifecycle
---

# Documentation migration policy

## Active-root policy

The active masterplan root contains current documents only. Historical diaries,
superseded plans, and append-only evidence records are forbidden in the active
root. Preserve those bodies under `old/` with the required historical header.

## Canonical discovery

Start with `00_README_CANONICAL_FULL_READ.md` and
`documentation_manifest.json`. Apply the documented authority hierarchy before
using any document as a design, implementation-order, validation, or status
source.

## Generated full pack

`fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md` is currently a disabled stale
generated snapshot, with `full_pack_generated=false` and
`full_pack_status=stale_disabled` in the manifest. Its preserved V5 body is
`old/fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5_legacy_2026-07-10.md` under the
standard historical-exclusion header.

Task 10 alone may regenerate the active full pack from manifest entries whose
`include_in_full_pack` value is true, and only after every manifest-declared
canonical input is complete and every transitional document is promotion-ready.
The regenerated pack remains non-authoritative, must not be hand-edited, and
cannot override the active source documents or the manifest. Historical
snapshots, the PDF, the readiness-matrix JSON body, and the full pack itself
are excluded from generated input.

## Status handling

Status and readiness documents record evidence scope. They cannot promote a
runtime lane from source inspection alone. Production proof requires the
applicable runtime gates and their artifacts.

Every production claim must carry the manifest-required `implementation_state`,
`validation_state`, and non-empty `validated_scope`. A production-executable
claim is not production-qualified, and narrow validation cannot promote a
broader capability.
<!-- END 13_repo_migration_cleanup.md -->

<!-- BEGIN 14_sources_traceability.md -->
---
title: Frequency-driven solver - sources and traceability
version: COMSOL-aligned v5.1 deterministic static contract
date: 2026-07-10
status: canonical
source_policy: external manuals and parity references are evidence inputs; Fullmag physics notes, specs, readiness matrix, and validation gates are the normative contract
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Sources and Traceability

This document records source lineage for the active frequency-domain masterplan.
It is a static documentation contract, not runtime proof. Source-visible code
vocabulary and existing artifacts must not be promoted to validated production
unless the validation gate listed here is satisfied.

## 1. Source Classes

| Class | Role | Current authority boundary |
|---|---|---|
| External manual | Parity reference for product behavior and user-facing study vocabulary. | The Micromagnetics Module User's Guide V2.13 informs the COMSOL-aligned contract but is not a Fullmag normative source. |
| Fullmag physics notes | Normative equations, signs, gauges, units, and validity limits. | `docs/physics/0700-frequency-domain-linearized-llg.md`, `docs/physics/0828-fem-frequency-domain-floquet-demag.md`, `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`, and `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`. |
| Fullmag specs | Normative artifact, API, capability, and provenance contracts. | `docs/specs/frequency-domain-artifacts-v2.md` and `docs/specs/capability-matrix-v0.md`. |
| Active masterplan | Implementation sequencing and status governance. | This directory, with read order and full-pack inclusion defined by `documentation_manifest.json`. |
| Readiness matrix/catalog | Current static status projection. | `25_frequency_domain_readiness_matrix.json` plus the consume-only scope catalog `25_frequency_domain_readiness_scope_catalog.json`. |
| Runtime gates | Only accepted route for executable and validation claims. | Managed `just` recipes and artifact verifiers named by the relevant plan chapter; this update did not rerun them. |

## 2. Physics Claim Traceability

| Claim | External parity reference | Fullmag normative source | Required validation gate |
|---|---|---|---|
| Frequency-domain response linearizes LLG around an accepted equilibrium using `exp(+i omega t)`. | Micromagnetics Module User's Guide V2.13 Frequency Domain study description. | `0700-frequency-domain-linearized-llg.md`; `02_physics_contract.md`; `03_relaxed_texture_linearization.md`. | Damped macrospin response and artifact sign checks in `09_validation_certification_benchmarks.md`. |
| Dynamic magnetization is tangent to `m0`; Cartesian payloads are adapters, not independent semantics. | Manual dependent-variable and small-signal description. | `0700-frequency-domain-linearized-llg.md`; `0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `05_algebra_and_operator_representations.md`. | Tangent leakage, tangent/Cartesian parity, and fused/apply parity gates in `09_validation_certification_benchmarks.md`. |
| Static demag belongs to equilibrium provenance; dynamic demag belongs to the linearized operator. | Manual dynamic magnetostatic coupling workflow. | `0830-fem-poisson-airbox-modal-eigen.md`; `0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `03_relaxed_texture_linearization.md`. | Operator digest, Schur certificate, and static/dynamic demag provenance gates in `09_validation_certification_benchmarks.md`. |
| K0 Poisson-airbox Robin/Dirichlet scalar blocks are coercive and do not use mean-zero augmentation; pure Neumann uses the mean-zero gauge. | External FEM magnetostatics practice and COMSOL parity expectation. | `0830-fem-poisson-airbox-modal-eigen.md`; `04_mesh_periodic_floquet_airbox.md`; `12_adr_decisions.md`. | BC/gauge tuple validation plus reconstructed residual certification in `09_validation_certification_benchmarks.md`. |
| Nonzero-k Floquet magnetic and scalar constraints use one Bloch phase and must fail closed when dynamic demag-k is unavailable. | Manual Floquet periodicity concept. | `0828-fem-frequency-domain-floquet-demag.md`; `04_mesh_periodic_floquet_airbox.md`; `23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`. | Nonzero-k no-demag gates, seam-transfer tests, and explicit `missing_numeric_fem_demag_k` failure checks. |
| Modal eigensolve targeting must publish the selected spectral transform and certify residuals in the original descriptor contract. | External selected-spectrum eigensolver practice. | `0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`; `19_eigensolve_frequency_driven_physics_numerics_audit.md`. | Findings F-03 and F-04 closure plus SLEPc/PETSc residual artifact gates. |
| GPU macrospin K0 no-demag modal validation is a narrow double-precision scope, not broad GPU modal production. | External CPU/GPU parity expectation. | `17_eigen_k0_gpu_readiness_audit.md`; `24_production_definition_of_done.md`; `25_frequency_domain_readiness_matrix.json`. | Scope binding `modal_gpu_k0_none_macrospin_larmor.validation`; broader GPU modal gates remain open. |

## 3. Current Source Evidence, Not Runtime Validation

The active source tree exposes vocabulary and partial implementation surfaces
for planner lanes, ABI fields, artifact diagnostics, GPU callback probes,
Poisson-airbox modal payloads, and Floquet failure reasons. These names are
source evidence only:

```text
FrequencySolvePlanner
FrequencySolvePlan
dense_reference
cpu_sparse_direct
full_coupled_field_split
schur_reduced
modal_reduced
gpu_operator_host_krylov
gpu_device_krylov
gpu_dense_k0_macrospin_modal_eigen
gpu_dense_contract_eigensolver
gpu_modal_device_krylov
production_cpu_modal_dynamic_demag_k_operator_missing
missing_numeric_fem_demag_k
```

Runtime validation requires the managed gates and artifact verifiers named by
the relevant chapters. This Task 10 update did not run scripts, tests, builds,
examples, managed runtimes, or solvers.

## 4. Traceability Outputs

| Artifact | Traceability role |
|---|---|
| `documentation_manifest.json` | Declares active document classification, full-pack order, readiness matrix, and readiness scope catalog. |
| `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md` | Deterministic manifest-ordered pack of active Markdown bodies only. It excludes historical snapshots, PDF input, JSON readiness bodies, and itself. |
| `25_frequency_domain_readiness_matrix.json` | Static status projection with object/null readiness bindings. |
| `25_frequency_domain_readiness_scope_catalog.json` | Consume-only scope catalog whose exact-byte SHA-256 is bound by the matrix and checked by tooling. |
| `scripts/check_fd_solver_masterplan_contract.py` | Static contract checker for classification, normative placeholders/sign/gauge guards, audit finding coverage, readiness scope bindings, catalog digest, and full-pack drift. |
<!-- END 14_sources_traceability.md -->

<!-- BEGIN 15_self_weryfication_Kittel.md -->
---
title: Independent Kittel postsolve verification contract
version: COMSOL-aligned v5.2 decision-complete
status: target validation contract with current implementation blockers
role: validation
---

# Independent Kittel postsolve verification contract

## 1. Purpose, authority and non-claim

The Kittel suite validates a solved FEM frequency-domain result. It does not
define the operator being tested. Physics and numerical semantics remain owned
by notes 0700, 0830 and 0831; K0 assembly and solve algorithms remain owned by
chapter 18; product promotion remains owned by chapters 09 and 24.

This chapter defines prospective gates. It does not claim that real
shared-domain K0-3 assembly, convergence, CPU/GPU parity or production
qualification has completed. Existing narrow no-demag and synthetic evidence
retains only its independently established scope.

The central independence rule is absolute:

```text
solve first -> freeze raw artifacts -> select branch without Kittel values
-> compute expected Kittel values and fitted M_eff -> compare -> report
```

The expected Kittel frequency and fitted `M_eff` are verifier outputs only.
The fixture-owned `M_eff_reference` is a verifier input with independent
provenance, loaded only after the raw branch is selected and frozen. All three
are forbidden from assembly, request target/window construction,
preconditioning, mode selection, solver convergence, solver certificate and
solver pass/fail paths. A Kittel-specific `demag_delta` is also forbidden from
those paths. Physical material `Ms` remains a legitimate assembly input; a
Kittel reference or fitted `M_eff` is not a substitute for it.

## 2. Current blockers and required runtime removal

The current repository violates the target independence contract. These are
active blockers, not accepted validation evidence.

| Current contamination | Why it invalidates independent Kittel validation | Required runtime removal work |
|---|---|---|
| `crates/fullmag-runner/src/fem_eigen.rs::build_pa_e4b_k0_kittel_poisson_airbox_payload` reads validation `effective_magnetisation`, computes `demag_delta=gyromagnetic_ratio*M_eff`, and uses it in `A_qphi`. | The analytical Kittel parameter constructs the operator under test. | Delete the Kittel/macrocell production payload builder from real execution. Assemble `A_qphi`, `A_phiq` and `P` from the shared-domain MFEM weak forms, physical `Ms`, mesh, BC and accepted equilibrium only. Keep synthetic builders explicitly algebra-only. |
| The same builder computes `expected_reference_frequency_hz` and assigns it to both `target_frequency_hz` and `expected_reference_frequency_hz`. | The expected answer determines where the solver searches. | Build the spectral target/window only from the user-authored modal request frozen before verifier execution. Remove expected Kittel values from runner-to-native solve requests. |
| `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` configures `EPS_TARGET_MAGNITUDE` from that target and retains the accepted positive mode with the smallest target distance. | Because the current target is the analytical answer, this is nearest expected frequency selection inside the solver. | Return the complete requested finite mode set/window. Move shape-first branch selection to the postsolve selector and keep user-authored target proximity only as a generic window policy, never as Kittel branch evidence. |
| `native/include/fullmag_fem.h`, `ModalEigenRequest`, the Rust native bridge and `PoissonAirboxEigenBlockProblem` carry `poisson_airbox_expected_reference_frequency_hz` or equivalent fields. | An analytical answer remains available to assembly and solver code even if a caller intends postsolve-only use. | Remove the field from the solve ABI/request/problem/result path in a versioned ABI change. Put expected values only in the postsolve validation artifact schema. |
| `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` validates the expected value, computes `reference_frequency_certified`, and fails the solver with `poisson_airbox_eigen_dense_reference_mismatch`. | Kittel/dense-reference agreement participates in solver certificate and pass/fail. | Solver success must depend only on legality, convergence, finite-mode/window completeness and reconstructed original residuals. Move reference comparison and its failure class into the independent verifier. |
| Current Kittel artifact verification chooses the complete branch with the smallest error against the expected Kittel formula. | The analytical answer selects the reported branch, so comparison is circular even though it occurs in a script. | Select and freeze the branch by mode shape, continuity and numerical quality first. Compute expected frequencies and fit `M_eff` only for that frozen branch. |
| Current Kittel metadata/verifier accepts a three-field sweep, and the periodic-airbox convergence validator accepts any nonempty table then checks only its best error. | The current gate does not establish 15-field extended coverage, independent three-level mesh/padding convergence, uniqueness, monotonicity/asymptotics, observed order or a finest-two budget. | Introduce the v2 artifacts in section 10, enforce distinct raw run signatures, at least 15 positive fields for extended validation, and separate three-level mesh and `airbox.padding` sequences with section 9 acceptance. |
| GPU Poisson-airbox diagnostics compute relative reference-frequency error from the expected field carried in the problem. | GPU diagnostics preserve the same forbidden solver-side dependency. | Remove the expected value from GPU problem state and diagnostics. Compare CPU/GPU solved outputs first; run Kittel comparison only in the common postsolve verifier. |

Removal is complete only when a data-flow audit proves that changing, deleting
or corrupting Kittel verifier metadata changes no assembled block, operator
signature, target/window, selected raw mode set, solver certificate, native
status or solver pass/fail outcome. The postsolve validation artifact may
change, which is the intended boundary.

## 3. Validation families

| Case | Physical fixture | Primary purpose | Eligible promotion |
|---|---|---|---|
| K0-1 | Uniform magnet, positive in-plane bias, no demag, no anisotropy, no damping | `gamma0`, Hz/rad/s, `lambda=i*omega`, positive branch, uniform mode | Bounded K0 no-demag modal cell only |
| K0-2 | Uniform magnet with one independently specified local stiffness term, no dynamic demag | Static effective-field and local Hessian contribution | Exact local-interaction K0 modal cell only |
| K0-3 | Real thin film with x/y PBC, open z, symmetric top/bottom airbox and numeric shared-domain dynamic demag | Demag sign/scale, Poisson-airbox coupling, truncation and Kittel behavior | Exact K0 periodic-airbox modal cell after all gates |

K0-1 and K0-2 cannot substitute for K0-3. A synthetic demag factor may be an
algebra oracle but cannot satisfy K0-3 or carry a production periodic-airbox
claim.

## 4. K0-3 fixture constraints and canonical scope binding

Each production candidate records the following immutable K0-3 constraints:

```text
study_product = modal_eigen
discretization = fem
k_vector_rad_per_m = [0,0,0]
periodicity = [x,y]
open_direction = z
airbox.padding.top_m = airbox.padding.bottom_m
airbox lateral periodicity = identical to magnetic cell
dynamic_demag = periodic_airbox_k0
assembly_kind = mfem_weak_form_shared_domain
magnetic FE = tangent P1
potential FE = scalar P1 on magnetic-plus-air domain
precision = double
initial damping policy = alpha=0
equilibrium = accepted relaxed state for every positive bias
```

The top and bottom airbox regions use the same material policy, mesh policy,
outer-boundary family and padding distance. The lateral x/y cuts are periodic;
Robin or Dirichlet truncation belongs only on the open-z exterior. Pure
Neumann uses the documented mean-zero augmentation. A fully periodic z
direction is not K0-3.

This list is only a human-readable fixture summary. The fixture instantiates
the closed, typed `frequency_domain_validation_scope.v1` object from Chapter
24, including its mandatory `SolverScope` tolerances, iteration/restart,
linear-solver family, preconditioner object, transform/target representation,
residency, precision, block-residual contract and typed certificate
references. The complete object also binds physics, problem, runtime, device,
material, geometry, fixture and oracle fields. Chapter 24 canonicalizes that
object and recomputes its `scope_id`; any hash-input change creates another
readiness cell.

The fixture also records geometry dimensions, material constants, physical
`Ms`, `gamma`/`gamma0`, bias direction, equilibrium signatures, BC/gauge tuple,
mesh generator/version, FE order, quadrature, solver request, target/window,
device, engine and all artifact hashes. The fixture publishes an external
content-addressed Chapter 24 `scope_catalog.v1` and records its
`scope_catalog_uri` plus `scope_catalog_sha256`; that catalog contains every
canonical scope object named by its solver, postsolve, convergence and summary
artifacts. An aggregate or convergence artifact that covers multiple canonical
cells uses Chapter 24's typed `coverage_rule.v1`, including the subject and
covered scope IDs resolved from that catalog and one unambiguous field
predicate for every canonical comparison address. It never invents a shorter
local scope or covers a target broader than its evaluated subject.

## 5. Field sweep

Extended validation uses at least 15 field values with strictly positive bias.
The fields must span the declared stable uniform-equilibrium interval and must
not be chosen after inspecting solved resonance errors. Linear, logarithmic or
hybrid spacing is allowed when the spacing rule, endpoints and units are fixed
in the fixture before solving.

Every production mesh and airbox-padding sequence uses the same field set.
Each field has its own accepted equilibrium or an accepted continuation whose
provenance proves the correct field value and signatures.

A fast CI gate may use a documented subset of at least three positive-bias
fields. Its artifact records `coverage=fast_ci_subset`, the parent extended
fixture ID, omitted field indices and the direct `scope_id` of its own narrower
`frequency_domain_validation_scope.v1` object resolved through the same
`scope_catalog.v1` contract. It may record the parent scope ID as non-binding
provenance, but it must not use a coverage binding whose
`coverage_rule.v1` names that broader parent as a covered scope: Chapter 24's
comparator direction rejects that promotion. Fast CI can detect regressions but
cannot satisfy analytical validation, convergence or `production_qualified`.

A near-zero field is optional. If present, it has a separately declared
zero-mode/degeneracy policy and is excluded from relative-error denominators
when that denominator is ill-conditioned. It cannot replace any positive-bias
gate and cannot reduce the required 15 field count.

## 6. Solver-side protocol

Before any Kittel value is computed:

1. build and accept the equilibrium, mesh and periodic certificates;
2. assemble from physical inputs only and freeze block/operator signatures;
3. execute the user-authored broad positive-frequency window or mode-count
   request; the request must not be derived from Kittel expectations;
4. classify finite positive-branch modes and reconstruct full fields;
5. compute original `eps_q`, `eps_phi`, `eps_gauge` and `eps_full`;
6. export every admitted candidate mode needed for independent branch
   selection, including mode fields and overlap inputs; and
7. close the solver artifact with native status based only on legality,
   convergence, completeness and residual certification.

The closed solver artifact contains no expected Kittel frequency, fitted
`M_eff`, Kittel relative error, `reference_frequency_certified`, or Kittel
pass/fail status. Those fields exist only in validation outputs linked to the
immutable solver artifact.

## 7. Independent mode and branch selection

Mode selection never minimizes distance to an expected Kittel frequency. It
uses the following ordered evidence:

1. **eligibility:** finite positive-frequency branch, accepted original full
   residual, accepted tangent leakage and accepted periodic seam mismatch;
2. **uniform overlap:** mass-weighted overlap with the uniform Cartesian
   transverse subspace, evaluated from exported mode fields;
3. **branch continuity:** mass-inner-product overlap or cluster subspace
   overlap with the previously selected field point;
4. **numerical quality:** lower original residual, tangent leakage and seam
   mismatch; and
5. **deterministic tie-break:** stable raw mode key, never expected frequency.

At the first positive field, select the eligible mode/cluster with maximum
uniform overlap. At later fields, use overlap-based Hungarian/cluster matching
from the previous selected subspace, then uniform overlap and numerical
quality. Frequency continuity may reject an unphysical jump using only prior
solved points and a documented local predictor; no Kittel formula or fitted
parameter may enter that predictor.

Initial selection thresholds are:

```text
uniform_overlap >= 0.85
branch_overlap_previous >= 0.70 for non-seed points
eps_full <= 1e-6
tangent_leakage_max_abs <= 1e-6
periodic_seam_mismatch_max_abs <= 1e-6
```

Production thresholds are:

```text
uniform_overlap >= 0.95
branch_overlap_previous >= 0.85 for non-seed points
eps_full <= 1e-8
tangent_leakage_max_abs <= 1e-8
periodic_seam_mismatch_max_abs <= 1e-8
```

Degenerate or near-degenerate modes are tracked as invariant subspaces; an
arbitrary eigenvector basis inside the cluster is not a branch failure.
Selection artifacts publish all eligible candidates and scores so the chosen
branch can be reproduced without analytical values.

## 8. Postsolve Kittel evaluation

Only after the selected branch and solver artifacts are immutable does the
verifier load `M_eff_reference` and evaluate:

```text
K0-1: f_expected(H) = gamma0 H / (2*pi)

K0-3 in-plane thin-film form:
f_expected(H) = gamma0 sqrt((H+H_k1)(H+H_k2+M_eff_reference)) / (2*pi)
```

`M_eff_reference` is owned by the immutable validation fixture, not by the
solver request or production material object. Its provenance record is frozen
before solving and contains:

```text
reference_id and oracle_id
source kind, URI/version and content sha256
derivation identifier and exact formula
independently measured or published SI inputs and their uncertainties
M_eff_reference_A_per_m and standard_uncertainty_A_per_m
fixture_id, fixture_sha256 and applicable bounded material/geometry range
```

The reference may use independently specified fixture quantities such as
`Ms_reference-Hk_perp_reference`; it must not be inferred from solved
frequencies, selected modes, assembled matrices, mesh/truncation results or a
fit to the artifact under test. The physical `Ms` supplied to assembly remains
a separate physics input even when both values trace to the same independently
versioned material characterization. The reference record is available only to
the postsolve verifier and is included in the canonical `oracle_ids`; changing
it changes `scope_id`.

The exact admitted analytical form, anisotropy fields, units and validity
limits are recorded by the validation fixture. The verifier emits expected
frequency rows; the solver does not consume them.

The verifier fits `M_eff` from the frozen solved branch using the fixture-fixed
model, field indices, weights and parameter bounds. It reports estimate,
standard uncertainty, confidence interval, covariance, rank, dimensionless
scaled-Jacobian condition number, residuals and included field indices. Fitted
`M_eff` is a verifier output only. It cannot be written back into material
input, reused as a Kittel demag delta, or used to rerun, retarget, reselect or
retroactively certify the solver.

The primary agreement metric is

```text
fitted_M_eff_relative_error =
  abs(fitted_M_eff_A_per_m - M_eff_reference_A_per_m) /
  abs(M_eff_reference_A_per_m)
```

`M_eff_reference_A_per_m` must be finite, nonzero and inside the fixture's
predeclared physical range. Initial acceptance requires
`fitted_M_eff_relative_error<=2e-2`; production requires `<=5e-3`. These are
the existing 2% initial and 0.5% production K0-3 fit limits and remain separate
from the frequency, mesh and airbox-truncation budgets.

The fit is rejected, irrespective of agreement, when the scaled Jacobian is
rank deficient, the covariance/uncertainty is absent or non-finite, a fitted
parameter is pinned to an undeclared bound, or the fit uses fewer than the
fixture-declared positive-field indices. It is also rejected when either staged
diagnostic exceeds its limit:

| Fit diagnostic | Initial | Production |
|---|---:|---:|
| `fitted_M_eff_standard_uncertainty / abs(M_eff_reference)` | `1e-2` | `2.5e-3` |
| dimensionless scaled-Jacobian condition number | `1e8` | `1e6` |

Parameter scaling and weights are fixture-fixed before solving and are emitted
with the fit, so conditioning cannot be improved post hoc by rescaling or
dropping inconvenient fields.

The postsolve verifier executes in this order:

1. recompute the canonical `scope_id` and validate the immutable solver hashes;
2. reproduce and freeze `selection.v2.json` without loading expected
   frequencies or `M_eff_reference`;
3. load and validate the fixture-owned reference and oracle provenance;
4. evaluate expected-frequency rows for the already selected branch;
5. fit `M_eff` using only the predeclared model, fields, weights, scaling and
   bounds;
6. reject rank, covariance, uncertainty, conditioning, bound or field-coverage
   failures before evaluating agreement;
7. evaluate frequency, fitted-`M_eff`, mesh and truncation thresholds; and
8. emit validation outcomes without modifying the request, selection, solver
   artifact or solver certificate.

For K0-3, compare both the prescribed analytical reference and the fitted
curve. A good fit alone cannot pass if the fitted value is physically wrong;
agreement with a prescribed value alone cannot pass if residuals show the
wrong field dependence.

Initial analytical tolerance is maximum relative frequency error `<=5e-2` and
median `<=2e-2`. Production tolerance is maximum `<=2e-2` and median `<=1e-2`.
The fit must have finite uncertainty, no excluded solved point unless the
fixture declared the exclusion before solving, and no single point may control
the fit undiagnosed.

## 9. Mesh and airbox convergence

Production K0-3 requires two independent sequences over the same positive
field set:

1. **mesh sequence:** minimum three mesh levels, fixed magnetic geometry,
   fixed symmetric top/bottom airbox padding and fixed BC/gauge policy;
2. **truncation sequence:** minimum three `airbox.padding` levels at one fixed
   magnetic mesh, with equal top/bottom padding at every level.

Changing mesh and padding in the same row does not satisfy either independent
sequence. The fixed mesh used for the padding sequence is the finest or a
separately justified production-candidate magnetic mesh. The fixed padding
used for the mesh sequence is the largest or a separately justified
production-candidate padding.

Every row is a distinct runtime solve with a distinct problem signature. Raw
rows include all 15 or more extended-validation fields. Duplicating one result,
copying analytical values into solved columns, or emitting repeated synthetic
rows fails the suite.

For each selected field and for aggregate fitted `M_eff`, report:

```text
raw level values
monotonicity classification
asymptotic-fit model and fit residual when used
observed_order when applicable
Richardson extrapolation when stable
finest_two_relative_delta
estimated_mesh_error
estimated_truncation_error
```

P1 expected-order checks use the directly measured quantity and norm; no
frequency observed-order claim is required when the model does not justify a
single order. In that case an accepted asymptotic fit and finest-two delta are
mandatory.

Acceptance budgets are separate:

| Budget | Initial | Production |
|---|---:|---:|
| Maximum finest-two mesh delta over positive fields | `2e-2` | `1e-2` |
| Maximum finest-two airbox-truncation delta | `2e-2` | `5e-3` |
| Aggregate fitted `M_eff` mesh delta | `2e-2` | `1e-2` |
| Aggregate fitted `M_eff` truncation delta | `2e-2` | `5e-3` |
| Maximum postsolve Kittel frequency error | `5e-2` | `2e-2` |
| Fitted `M_eff` relative error against fixture reference | `2e-2` | `5e-3` |
| Fitted `M_eff` relative standard uncertainty | `1e-2` | `2.5e-3` |
| Fitted `M_eff` scaled-Jacobian condition number | `1e8` | `1e6` |
| Poisson original constraint residual | `1e-6` | `1e-8` |

If the last three levels are not monotone, the verifier must demonstrate a
resolved asymptotic fit with a declared residual below one quarter of the
applicable budget. Otherwise the convergence gate fails; selecting only the
best row is forbidden.

## 10. Required artifacts

### 10.1 Immutable solver artifacts

```text
frequency_domain/manifest.v1.json
eigen/diagnostics/solver.v1.json
eigen/spectrum.v2.json
eigen/branches.v2.json
eigen/modes/sample_XXXX/mode_YYYY.json
eigen/mode_fields.zarr/
mesh/periodic_pairs.v1.json
```

They contain requested/resolved execution, equilibrium and mesh signatures,
BC/gauge, assembly kind, block/operator signatures, target/window provenance,
candidate modes, original residuals and mode fields. They contain no Kittel
expected values or Kittel pass/fail decision.

### 10.2 Postsolve validation artifacts

```text
validation/kittel_k0_pbc/selection.v2.json
validation/kittel_k0_pbc/points.v2.csv
validation/kittel_k0_pbc/points.v2.csv.validation_manifest.v1.json
validation/kittel_k0_pbc/mesh_convergence.v2.csv
validation/kittel_k0_pbc/mesh_convergence.v2.csv.validation_manifest.v1.json
validation/kittel_k0_pbc/airbox_convergence.v2.csv
validation/kittel_k0_pbc/airbox_convergence.v2.csv.validation_manifest.v1.json
validation/kittel_k0_pbc/fit.v2.json
validation/kittel_k0_pbc/summary.v2.json
validation/kittel_k0_pbc/independence_audit.v1.json
```

The three CSV artifacts require the listed
`validation_artifact_manifest.v1` sidecars. Each sidecar names the CSV
`artifact_uri`, CSV `artifact_sha256`, `artifact_kind=csv`, the table schema
and the same direct or coverage `validation_scope_binding.v1` that a JSON
object would carry at top level. The sidecar is immutable evidence and is
validated before any CSV row is consumed.

Every JSON-object immutable solver artifact and postsolve validation artifact
above carries a mandatory top-level `verified_coverage_of` field whose value is
one `validation_scope_binding.v1` object from Chapter 24:

```text
verified_coverage_of:
  schema: validation_scope_binding.v1
  scope_schema: frequency_domain_validation_scope.v1
  scope_catalog_uri: validation/scopes/scope_catalog.v1.json
  scope_catalog_sha256: Sha256Id
  exactly one closed variant:
    kind: direct
    scope_id: Sha256Id
  or:
    kind: coverage
    coverage_rule:
      schema: coverage_rule.v1
      relation: exact | subset
      subject_scope_id: Sha256Id
      covered_scope_ids: non-empty ordered unique Sha256Id array
      field_predicates: complete Chapter 24 FieldPredicate array
```

`scope_catalog_uri` and `scope_catalog_sha256` are mandatory in both binding
variants; an embedded catalog is not a valid alternative. Exactly one binding
variant is legal. The coverage variant is reserved for a multi-level
convergence or CPU/GPU aggregate whose evaluated subject contains every covered
target after the catalog digest and every referenced `scope_id` are verified. A
subject narrower in fields, mesh/padding interval, device, precision, solver
configuration or any other canonical dimension cannot cover the broader target.
`validated_scope_id`, fixture names, run directories, abbreviated K0-3 tuples,
bare `validated_scope` claims, standalone scope hashes and prose assertions of
exact scope are not accepted aliases.

`selection.v2.json` contains candidate scores and the frozen selected branch
without expected frequencies. `points.v2.csv` may add expected frequencies and
relative errors only after selection and only when its sidecar manifest has
validated the CSV hash and direct scope binding. The two convergence CSV files
are separate, contain raw unique run IDs and signatures, and carry their
aggregate coverage binding only through their required sidecar manifests.

Each convergence row contains at least:

```text
run_id, solver_artifact_sha256, solver_artifact_scope_id
field_index, H0_A_per_m
mesh_level, magnetic_h_m, magnetic_dof_count
airbox_padding_top_m, airbox_padding_bottom_m, phi_dof_count
selected_raw_mode_index, selected_branch_id
frequency_hz, eps_q, eps_phi, eps_gauge, eps_full
uniform_overlap, branch_overlap_previous
tangent_leakage_max_abs, periodic_seam_mismatch_max_abs
```

`solver_artifact_scope_id` must equal the direct
`verified_coverage_of.scope_id` in the immutable solver artifact named by
`solver_artifact_sha256`. A convergence CSV may be an aggregate whose
sidecar manifest uses a coverage binding, but it cannot replace any raw solve
row's direct binding with a bare scope ID or coverage-rule hash.

Verifier-enriched rows additionally contain `expected_frequency_hz`,
`relative_frequency_error` and the fit membership flag. `fit.v2.json` contains
the complete `M_eff_reference` provenance, fit model/weights/scaling, fitted
value, `fitted_M_eff_relative_error`, uncertainty/confidence interval,
covariance/rank/condition number and all rejection reasons. Summary artifacts
publish the complete `verified_coverage_of` binding, fixture/oracle/reference
IDs and hashes, initial/production tolerance
sets, raw row counts, distinct signature
counts, field coverage, observed orders/fits, finest-two deltas, separate
frequency and fitted-`M_eff` mesh/truncation budgets, fit conditioning and
uncertainty outcomes, and final gate outcomes.

`fit.v2.json` and `summary.v2.json` expose these exact fit fields:

```text
M_eff_reference_A_per_m
M_eff_reference_standard_uncertainty_A_per_m
M_eff_reference_id
M_eff_reference_oracle_id
M_eff_reference_source_sha256
fitted_M_eff_A_per_m
fitted_M_eff_standard_uncertainty_A_per_m
fitted_M_eff_relative_error
fitted_M_eff_scaled_jacobian_condition_number
fitted_M_eff_covariance_rank
fitted_M_eff_initial_threshold
fitted_M_eff_production_threshold
fitted_M_eff_uncertainty_initial_threshold
fitted_M_eff_uncertainty_production_threshold
fitted_M_eff_condition_initial_threshold
fitted_M_eff_condition_production_threshold
fitted_M_eff_agreement_outcome
fitted_M_eff_uncertainty_outcome
fitted_M_eff_conditioning_outcome
```

## 11. CPU/GPU parity and residency

GPU Kittel qualification starts only after the exact CPU K0-3 scope is
production-qualified. CPU and GPU consume byte-identical physical inputs and
equivalent assembled operator signatures. They compare the branch selected by
the same shape-first protocol, not by expected frequency.

Production double-precision tolerances are:

```text
frequency cluster relative delta <= 1e-8
invariant-subspace sine <= 1e-8
complex reconstructed-field relative delta <= 1e-7
original eps_full <= 1e-8 on both devices
accepted/rejected outcome mismatches = 0
```

The GPU artifact must identify `gpu_modal_device_krylov`, keep operator,
preconditioner, vectors, Krylov basis and hot-loop state on device, and report:

```text
per_iteration_h2d_transfer_count = 0
per_iteration_d2h_transfer_count = 0
hidden_host_solve_count = 0
```

Setup uploads, bounded scalar reductions and final exports are counted and
declared. A dense K0 macrospin solve, descriptor apply probe, shifted-action
probe or host-Krylov GPU operator path cannot satisfy GPU K0-3 residency.

## 12. Gate outcomes and promotion

The verifier emits independent outcomes for:

```text
solver_artifact_integrity
analytical_input_isolation
shape_first_branch_selection
positive_bias_field_coverage
mesh_convergence
airbox_truncation_convergence
kittel_frequency_agreement
fitted_M_eff_agreement
fitted_M_eff_uncertainty
fitted_M_eff_conditioning
cpu_gpu_parity when applicable
gpu_residency when applicable
```

`production_qualified` is legal only when every applicable outcome is `pass`,
the promotion record's `validated_scope` passes the closed v1 schema and hash
check, every JSON-object artifact has an accepted top-level
`verified_coverage_of` direct or typed coverage binding, every CSV/non-object
artifact has an accepted `validation_artifact_manifest.v1` sidecar, all
bindings resolve through a verified external `scope_catalog.v1`, and
chapter 24 is complete for the same immutable evidence bundle. `fast_ci_subset`, synthetic demag,
absent raw levels, mixed mesh/padding variation, solver-side expected values,
ill-conditioned/uncertain fits, or analytical-value-based branch selection cap
the result below production.

The current contamination listed in section 2 blocks K0-3 production
qualification until the specified runtime removal work is implemented and an
independence audit passes. This documentation change does not remove that
runtime blocker.
<!-- END 15_self_weryfication_Kittel.md -->

<!-- BEGIN 16_end_to_end_fem_frequency_domain_implementation.md -->
---
title: End-to-end FEM frequency-domain implementation contract
version: target v6 contract over current v5 runtime and native ABI v12
date: 2026-07-10
status: normative target with explicit current contract gaps
---

# End-to-end FEM frequency-domain implementation

## 1. Authority and status vocabulary

This chapter specifies the complete public-to-native data flow for FEM modal
eigen and driven response. Equations, signs, units, equilibrium acceptance and
periodic/Floquet semantics remain owned by:

- `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`,
- `03_relaxed_texture_linearization.md`,
- `04_mesh_periodic_floquet_airbox.md`,
- `docs/specs/frequency-domain-artifacts-v2.md`.

The tables below use exact current names where a field exists. `contract_gap`
means that no current field or propagation link exists at that layer. A target
name beside `contract_gap` is a requirement, not a claim of current support.
Implementation, execution and validation are independent states:

```text
implemented != executable != validated != production_qualified
```

## 2. Mandatory stage order

Every modal or driven solve follows this order. No later stage may recreate,
override or silently weaken an earlier decision.

```text
1  Python DSL / UI authoring
2  ProblemIR lowering
3  semantic validation
4  capability and requested/resolved execution planning
5  EquilibriumArtifact -> LinearizationState
6  periodic/Floquet certificate
7  native request materialization
8  MFEM operator/block assembly
9  FrequencySolvePlanner
10 one selected engine
11 full residual certification
12 artifact publication
13 OpenAPI/resource/UI inspection
```

The current runtime does not yet implement this complete chain. In particular,
`EquilibriumArtifact.v6`, `LinearizationState.v6`,
`periodic_mesh_certificate.v6`, target engine selection for modal solves, and
the hardened manifest envelope are `contract_gap`. Existing v5 structs,
pair-list metadata and artifacts remain evidence only for their exact scope.

## 3. Current lanes versus target engines

The current C ABI lane enum is not the target solver-engine vocabulary.

| Layer | Current exact names | Meaning | Target requirement |
|---|---|---|---|
| C ABI driven lane | `FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_VALIDATION`, `..._PRODUCTION_CPU`, `..._PRODUCTION_GPU` | broad request/routing class | retain as compatibility input only; diagnostics must resolve one engine |
| Rust native lane | `NativeFrequencyDomainExecutionLane::{Validation,ProductionCpu,ProductionGpu}` | maps one-to-one to the C ABI enum | do not expose as proof of algorithm or residency |
| C++ driven lane | `DrivenFrequencyResponseExecutionLane::{validation,production_cpu,production_gpu}` | current native routing | same compatibility role |
| Current planner engines | `dense_reference`, `cpu_sparse_direct`, `full_coupled_field_split`, `schur_reduced`, `modal_reduced`, `gpu_operator_host_krylov`, `gpu_device_krylov` | current `FrequencyExecutionLane` values | preserve exact names where implemented |
| Target-only engine split | `dense_cartesian_reference`, `dense_tangent_reference`, `gpu_modal_device_krylov` | target distinctions from the hardening plan | `contract_gap`; do not publish these as current engines |
| Current ad hoc runtime labels | `production_cpu_host_gmres`, `k0_poisson_airbox_cpu_full_coupled_slepc`, `gpu_operator_host_modal_eigen_compatibility` and solver-specific `solver_adapter` values | implementation diagnostics, not planner enums | map to a target engine plus `implementation_id`; do not silently rename them |

`requested_execution_lane` and `resolved_execution_lane` remain compatibility
fields while they exist. The target manifest additionally records
`requested_execution` and `resolved_execution`, where the resolved object names
the single engine, solver library, device, precision, assembly, residency and
fallback decision.

## 4. Modal eigen traceability

| Concern | Python DSL / UI authoring | `StudyIR` | `ExecutionPlanIR` | Current native ABI/runtime | Artifact, OpenAPI and UI | Unit/default | Validation owner and unsupported behavior |
|---|---|---|---|---|---|---|---|
| Frequency window and count | `Eigenmodes.count` default `20`; `target` is `lowest`, `nearest` or `frequency_window`; `target_frequency`, `frequency_min`, `frequency_max`. UI: `StudyStageDraft.count`, `target`, `targetFrequency`, `frequencyMin`, `frequencyMax`. | `StudyIR::Eigenmodes { count, target: EigenTargetIR::{Lowest,Nearest { frequency_hz },FrequencyWindow { frequency_min_hz,frequency_max_hz }} }`. | `FemEigenPlanIR.count`, `.target`. | `FullmagFemModalEigenRequest.requested_mode_count`, `target_kind`, `target_frequency_hz`, `frequency_min_hz`, `frequency_max_hz`, `residual_tolerance`, `max_outer_iterations`, `max_linear_iterations`. | `eigen/diagnostics/solver.v1.json`: `requested_window_hz`, `resolved_search_window_hz`, `requested_mode_count`, `mode_count`, `window_completeness`, `subwindows[]`; spectrum through `/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2` and `useFrequencyDomainEigenSpectrumResource()`. | Hz; count `20`; native runner currently injects residual/iteration defaults rather than receiving public modal policy. | Python/IR validate positive ordered bounds and count. Certified window completeness is not current general support; false completeness is an artifact failure. |
| k sampling and phase convention | `k_sampling`, legacy `k_vector`; `KPoint`, `KPath(points,samples_per_segment,closed)`; `FloquetBC.phase_convention` default `exp_minus_i_k_dot_delta_r`. UI: `kSampling`, `kVector`, `kPath`, `bc`. | `KSamplingIR::{Single { k_vector },Path { points,samples_per_segment,closed }}`; `SpinWaveBoundaryConditionIR`; `PhaseConventionIR::ExpMinusIKDotDeltaR`. | `FemEigenPlanIR.k_sampling`, `.spin_wave_bc`; no independent target certificate ID: `contract_gap`. | `FullmagFemLinearizedOperatorRequest.k_vector_rad_m/k_vector_len`; `FullmagFemModalEigenRequest.has_floquet_k_vector`, `floquet_k_vector_rad_per_m[3]`, `phase_convention`, `mfem_floquet_periodic_pairs/count`. | `spectrum.v2.json.samples[].k_vector`, `dispersion.csv`, `eigen/dispersion/path.json`; API `eigen/dispersion`; UI hooks `useFrequencyDomainEigenDispersionResource()` and `useFrequencyDomainEigenBranchesResource()`. | k in rad/m; translation in m; phase exactly `exp(-i*k dot R)`. | Pair metadata alone is not an operator. Nonzero-k modal dynamic demag and target v6 magnetic/scalar equivalence-class consumption are `contract_gap`; reject rather than reuse K0 or post-project a phase. |
| Equilibrium source and artifact identity | `equilibrium_source` is `provided`, `relax` or `artifact`; `equilibrium_artifact` is required for `artifact`. UI fields have the same semantic names. | `EquilibriumSourceIR::{Provided,RelaxedInitialState,Artifact { path }}`. | `FemEigenPlanIR.equilibrium` and `.equilibrium_magnetization`; accepted artifact digest, five signatures and `LinearizationState.v6` ID are `contract_gap`. | `FullmagFemLinearizedOperatorRequest.equilibrium_source_kind`; modal runner passes equilibrium arrays through operator materialization. Native `EquilibriumArtifactDescriptor` and `build_linearization_state_from_equilibrium()` exist but are not connected to planner/runner: `contract_gap`. | Current modal manifest writes `requested_execution.equilibrium_source = "provided_or_planned"`, so exact source/artifact identity is `contract_gap`. Target: equilibrium and linearization hashes in the manifest and mode metadata. | `m0` dimensionless; `h_eff0` and `h_demag0` A/m; `phi0` A when required. | `03_relaxed_texture_linearization.md` owns acceptance and exact reject reasons. Solvers must not relax or reconstruct an artifact-selected equilibrium. |
| `include_demag` and magnetostatic BC | `Eigenmodes.include_demag`; no modal `magnetostatic_bc` field: `contract_gap`. The demag realization is authored outside the stage through the common physics/backend policy. | `EigenOperatorConfigIR.include_demag`; no modal `MagnetostaticBoundaryConditionIR`: `contract_gap`. | `FemEigenPlanIR.enable_demag`, `.demag_realization`, `.air_box_config`; no modal `magnetostatic_bc`: `contract_gap`. | `FullmagFemLinearizedOperatorRequest.include_demag`, `demag_realization`; Poisson block enabled by `poisson_airbox_block_enabled`. | Current manifest has `requested_execution.include_demag` and `resolved_execution.demag_realization`; target requires exact requested/resolved BC and demag tuples. | Boolean default Python `True`; demag fields A/m. | Floquet modal demag is rejected except explicitly labelled analytic/synthetic validation paths. Nonzero-k numerical FEM demag-k is `contract_gap`. |
| Outer boundary, Robin beta and gauge | No modal-stage field. Common airbox policy can resolve lower-layer `bc_kind`, `robin_beta_mode`, `robin_beta_factor`, but public stage-to-ABI traceability is `contract_gap`. | No fields in `StudyIR::Eigenmodes`: `contract_gap`. | `FemEigenPlanIR.air_box_config.{bc_kind,robin_beta_mode,robin_beta_factor}`. Exact target `outer_boundary_kind/gauge_policy/gauge_reason` tuple is not carried as one plan object: `contract_gap`. | `FullmagFemModalEigenRequest.poisson_airbox_outer_boundary_kind`, `poisson_airbox_robin_beta`, `poisson_airbox_gauge_policy`, `poisson_airbox_gauge_reason`, `poisson_airbox_assembly_kind`. Current runner Poisson payload is labelled `synthetic_algebraic_oracle`, commonly `pure_neumann/mean_zero_augmented`. | Current diagnostics expose some of these fields; target manifest requires `assembly_kind` and one BC/gauge tuple. | `robin_beta` in 1/m; valid target tuples are `poisson_robin(beta>0)/none`, `poisson_dirichlet/none`, `pure_neumann/mean_zero_augmented`. | `04_mesh_periodic_floquet_airbox.md` owns tuple validation. Coercive Robin/Dirichlet must not receive an eta row; pure Neumann must. Real shared-domain `mfem_weak_form_shared_domain` promotion is `contract_gap`. |
| Requested device and precision | `RuntimeSelection.device_target`, `execution_precision`, `execution_mode`; UI uses `change_device`/`StudyStageDraft.deviceTarget`. | Device is in backend/runtime policy, not `StudyIR::Eigenmodes`. | `FemEigenPlanIR.precision`; requested device is absent: `contract_gap`. `CommonPlanMeta` carries requested/resolved backend and execution mode only. | Modal `FullmagFemModalEigenRequest` has no requested lane/device/precision field: `contract_gap`. Dispatch chooses CPU/GPU outside the request. | Modal manifest currently hardcodes requested/resolved CPU/double in the common writer, so GPU/request intent traceability is `contract_gap`. | default double; current FEM modal rejects single. | Forced GPU must not silently run CPU. The narrow K0 no-demag Kittel GPU path does not imply general modal GPU or Poisson-airbox GPU eigensolve support. |
| Solver method and spectral transform | `Eigenmodes` has no solver policy or spectral transform field: `contract_gap`. UI has no modal solver-method control. | No modal solver-policy fields: `contract_gap`. | `FemEigenPlanIR` has no solver policy: `contract_gap`. | `FullmagFemModalEigenRequest.eigensolver_family`, `spectral_transform_kind`; Poisson shift action uses `poisson_airbox_shift_sigma_real/imag`. Runner currently supplies fixed numeric values. | Diagnostics currently use `solver_adapter`, `solver_family`, `spectral_transform`, `shift_frequency_hz` and related fields. Target adds `spectral_scalar_mode`, `sigma_real_per_s`, `sigma_imag_rad_per_s`. | sigma in rad/s; target `sigma = i*omega_target`; current defaults depend on runner path. | Real PETSc requires `spectral_scalar_mode=real_split`; a real-axis shift for an imaginary spectrum is invalid. Public round-trip and deterministic planner selection are `contract_gap`. |
| Normalization and output fields | `normalization` is `unit_l2` or `unit_max_amplitude`; outputs are `SaveSpectrum`, `SaveMode`, `SaveDispersion`, `SaveEigenDiagnostics`. | `EigenNormalizationIR`; `SamplingIR.outputs` with matching `OutputIR` variants. | `FemEigenPlanIR.normalization`; `OutputPlanIR.outputs`. | Native request controls partial artifacts and solver payloads, but does not carry the complete public output selection: `contract_gap`. | `spectrum.v2.json`, `branches.v2.json`, `dispersion.csv`, per-mode metadata and `mode_fields.zarr`; API mode metadata and binary field resources; UI spectrum/dispersion charts, mode tables and 3D mode overlay. | `delta_m` dimensionless; mode Zarr `[node,component,complex]`, XYZ, real/imag; production validation prefers float64. | Artifact writer/validator owns normalization identity, mode count, residual, tangent leakage and payload shape. Missing requested public output is an artifact failure, not permission to synthesize data. |

## 5. Driven-response traceability

| Concern | Python DSL / UI authoring | `StudyIR` | `ExecutionPlanIR` | Current native ABI/runtime | Artifact, OpenAPI and UI | Unit/default | Validation owner and unsupported behavior |
|---|---|---|---|---|---|---|---|
| Frequency sweep | `FrequencyResponse.frequencies_hz`; UI `StudyStageDraft.frequenciesHz`. | `FrequencySweepIR.values_hz`. | `FemFrequencyResponsePlanIR.frequencies_hz`. | `fullmag_fem_frequency_domain_driven_response_request.frequencies_hz/frequency_count`. | `magnetic_response_sweep.v2.json.points[]`, per-frequency artifacts, progress resource; API `response/magnetic-sweep`; `useFrequencyDomainResponseSweepResource()`. | finite positive Hz; no empty default is accepted. | Python, IR/planner, runner and native request validation reject empty, nonfinite or nonpositive values. A native path currently accepts only a single k sample even when frequency count is many. |
| Dynamic field phasor real/imag | Current public field is misspelled but exact: `excitation_field_au_per_m` plus `excitation_phase_rad`; it represents one real vector with one global phase. UI fields: `excitationField`, `excitationPhaseRad`. Independent per-component real/imag authoring is `contract_gap`. | `FrequencyExcitationIR.field_au_per_m`, `.phase_rad`; independent complex vectors are `contract_gap`. | `FemFrequencyResponsePlanIR.excitation`; runner projects the physical Cartesian field into `drive_tangent_real`/`drive_tangent_imag`. | C ABI consumes `mfem_drive_real/imag` with value counts and internal order `[u0,v0,u1,v1,...]`. Current buffers are tangent-coordinate physical-field components in A/m, while the solver consumes them as `b`; `project_dynamic_field_drive_to_tangent_rhs` exists but is not integrated into a production caller. The target conversion is the explicit LLG torque projection `T^T[-gamma0(m0 x delta_h_drive)]`. This is a `contract_gap`, not current RHS support. | Point/sweep `excitation_provenance`; target manifest records physical phasor representation, projection identity, and whether buffers represent `dynamic_field` or `tangent_rhs`. | Physical `h_drive` A/m; phase rad. Internal tangent RHS has operator-dictionary units only after explicit LLG conversion. | Runner/native must own exactly one conversion from physical field to internal RHS. Arbitrary complex XYZ phasors and production use of the existing conversion helper are `contract_gap`. |
| `drive_kind` and zero-drive policy | No public `drive_kind` or zero-drive policy: `contract_gap`. Current runner rejects zero physical field before native production execution. | No fields: `contract_gap`. | No fields: `contract_gap`. | ABI enum includes `DYNAMIC_FIELD_PHASOR_A_PER_M`, `TANGENT_RHS`, `CARTESIAN_TORQUE_PHASOR`, `STT_CURRENT_PHASOR`, `COUPLED_EXTERNAL_PROVIDER`; `require_nonzero_rhs` exists. Rust materialization currently sends `DRIVE_UNSPECIFIED` and `0`, which normalizes to dynamic field and zero-response-allowed in native code: incomplete propagation. | Native diagnostics may emit `zero_drive_warning` and `zero_drive_policy="zero_response_allowed"`; target manifest must publish requested and resolved drive policy. | default public drive `(0,0,1)` A/m, phase `0`; target physical zero drive yields a valid zero response only when explicitly allowed. | Physical-drive semantics must be separated from internal `tangent_rhs`. Current public rejection versus native zero-response allowance is a `contract_gap` that must be closed before claiming one policy. |
| k sampling and BC | `k_sampling`/legacy `k_vector`, `spin_wave_bc`, `magnetostatic_bc` default `open`. | `KSamplingIR`, `SpinWaveBoundaryConditionIR`, `MagnetostaticBoundaryConditionIR::{Open,PeriodicAirboxK0,FloquetAirbox}`. | Same fields plus `periodic_constraint_sets`. | ABI uses static pairs, Floquet pair records, `has_floquet_k_vector`, `phase_convention`, `requires_periodic_airbox_dynamic_demag`, `requires_floquet_airbox_dynamic_demag`, and magnetic/magnetostatic constraint counts. | Manifest physics/diagnostics, periodic-pair artifacts, point fields and API/UI resources. | k rad/m; `exp(-i*k dot R)`; default open/free and no k sample. | `periodic_airbox_k0` requires k=0 and periodic magnetic BC. `floquet_airbox` requires nonzero k, Floquet magnetic BC and dynamic scalar constraints. K0 substitution, open-boundary substitution and postsolve phase projection are forbidden. |
| Normalization and observables | `normalization`; outputs may include `SaveResponse(observable)` with current IDs `m_complex`, `u_complex`, `strain_complex`, `stress_complex`, `susceptibility_tensor`, `absorbed_power_density`, `response_amplitude`, `response_phase`, `mode_hybridization_index`. UI currently authors one `observable`. | `FrequencyResponseNormalizationIR`; `OutputIR::FrequencyResponseOutput { observable }` through sampling. | `FemFrequencyResponsePlanIR.normalization`; `OutputPlanIR.outputs`. | ABI writes response fields under `write_response_fields`; complete observable selection is not carried to native: `contract_gap`. | sweep/point observables, `field_payloads.zarr`, metadata and binary data plane; Analysis Plots response chart, frequency-point inspector and 3D response field. | `delta_m` dimensionless; `delta_M=Ms*delta_m`; SI chi dimensionless; normalized `delta_m/h_drive` m/A; physical power W/m3 only with volume weighting. | Artifact contract owns units/provenance. Unsupported mechanics/magnetoelastic observables must be rejected or marked unavailable, not emitted as magnetic proxies. |
| Solver method, preconditioner, rtol, max and restart | `FrequencyResponseSolverPolicy.{method,preconditioner,rtol,max_iterations,restart_iterations}`. UI only persists `solverMethod`; preconditioner/tolerances/iteration controls are `contract_gap`. | `FrequencyResponseSolverPolicyIR` with the same exact fields. | `FemFrequencyResponsePlanIR.solver_policy`. | ABI fields: `solver_relative_tolerance`, `solver_absolute_tolerance`, `solver_max_iterations`, `solver_restart_iterations`, `solver_progress_interval_iterations`. Runner currently threads public policy through temporary environment variables; `method` is not an ABI field. | `response/diagnostics/solver.v1.json`: requested/resolved solver method, Krylov/preconditioner fields, tolerances, iterations and residual history. | rtol positive dimensionless; iteration counts positive; zero ABI values select native defaults. | Implemented method subset is checked in runner. `cpu_sparse_direct`, `full_coupled_field_split`, `modal_reduced`, `gpu_device_krylov` public enum values are currently rejected by runtime. Forced concrete preconditioners must not auto-resolve to `none`. |
| Requested device and precision | Common `RuntimeSelection.device_target`, `execution_precision`, `execution_mode`; UI `change_device` and `deviceTarget`. | Backend/runtime policy outside the stage. | `FemFrequencyResponsePlanIR.requested_device`, `.precision`; `CommonPlanMeta` requested/resolved backend and execution mode. | Compatibility lane enum is `validation/production_cpu/production_gpu`; no ABI precision field because current native response is double-only. | Native diagnostics publish `requested_execution_lane`, `resolved_execution_lane`, `validation_fallback_used`; target manifest publishes full requested/resolved objects and device residency. | current FEM response double only. | Forced GPU unavailability writes/resolves `unavailable`, never CPU. Single precision rejects in planner. A GPU operator with host Krylov must not be labelled device-resident. |
| Progress and snapshot policy | No public response progress/snapshot policy object: `contract_gap`; outputs choose result artifacts only. | No progress policy: `contract_gap`. | No progress policy; runner/native defaults apply. | ABI callbacks plus `solver_progress_interval_iterations`; cancellation callback; `write_response_fields`, `write_partial_artifacts`. | `response/progress.v1.json`, `cancel_requested.v1.json`, `frequency_points[]`, field payloads; live source `/simulation/stages/execution`; durable hooks `useFrequencyDomainResponseProgressResource()` and cancel resource hook. | progress `[0,1]` or percent; current interval default comes from native runtime when ABI value is zero. | Live stage progress is authoritative while running; durable progress is authoritative after interruption/completion. Progress is not convergence evidence. Missing partial artifacts must not be presented as a completed sweep. |

## 6. Product and k-domain legality

| Product/scope | Current executable boundary | Required hardening behavior |
|---|---|---|
| Modal, k0, no demag | CPU production selected-spectrum paths and a narrow Kittel GPU exception exist in separate implementations. | Preserve exact lane and validation scope; never infer general GPU modal support. |
| Modal, k0, Poisson airbox | Current ABI and CPU SLEPc adapter accept Poisson block payloads; current runner evidence includes synthetic/algebraic payloads and v5 certificates. | Require real `mfem_weak_form_shared_domain`, exact BC/gauge tuple, v6 equilibrium/certificate hashes and block residual certification before production qualification. |
| Modal, nonzero-k, no demag | Narrow Bloch/Floquet pair/operator paths exist; artifact acceptance remains scope-specific. | Require per-sample operator materialization and exact requested/resolved provenance. |
| Modal, nonzero-k, dynamic demag | `contract_gap`. | Reject with the documented missing dynamic-demag-k/operator reason; no K0 or analytic fallback may be relabelled numerical FEM. |
| Driven, k0, open/free | Native CPU and GPU routing exists for supported magnetic terms. | Publish selected engine and host/device residency independently from ABI lane. |
| Driven, k0, `periodic_airbox_k0` | Native provider/Schur response path exists with explicit no-dense-fallback behavior. | Require accepted equilibrium provenance, scalar/magnetic constraint counts, seam/flux diagnostics and exact assembly/BC/gauge provenance. |
| Driven, nonzero-k, no demag | Narrow single-k Floquet projection/operator slices exist. | Keep single-k limitation explicit; `KSamplingIR::Path` native materialization is `contract_gap`. |
| Driven, nonzero-k, `floquet_airbox` dynamic demag | Planner/native metadata exists, but the production numeric coupled demag-k implementation/qualification is `contract_gap`. | Reject without CPU/K0/open fallback and publish the exact unavailable reason. |

## 7. Error and fallback contract

Native statuses remain exact and product-independent:

```text
ok
unavailable
validation_error
operator_error
solve_error
artifact_error
interrupted
```

Every failure or unavailable result that has an artifact directory publishes:

```text
status
complete=false
requested_execution
resolved_execution or resolved_execution.status=unavailable
unsupported_reason or rejection_reason
fallback_used
partial_artifacts_available
diagnostics resource identity
```

Rules:

1. Strict CPU/GPU/precision/method intent cannot migrate silently.
2. Validation/reference execution is never a fallback for a missing production
   operator.
3. K0, open boundary, no demag, synthetic assembly, analytic demag or postsolve
   projection cannot replace requested nonzero-k coupled demag.
4. A fallback is legal only when the public execution mode permits it, the
   replacement solves the same physical contract, and requested/resolved plus
   `fallback_used=true` and `fallback_reason` are published.
5. Missing optional API resources return diagnostic `404`; malformed or
   contradictory artifacts fail resource publication rather than appearing as
   empty successful charts.

## 8. Artifact, API and UI inspection chain

The artifact manifest is the discovery root, not a screen-shaped payload. The
resource-first inspection chain is:

```text
frequency_domain/manifest.v1.json
  -> named modal or response artifact
  -> /v2/sessions/current/analysis/frequency-domain/... metadata resource
  -> /v2/sessions/current/data/fields/{field_id}/samples/vector for heavy fields
  -> ControlRoomApi.analysis.frequencyDomain
  -> useFrequencyDomain*Resource hooks
  -> Analysis Plots / dedicated inspectors / unified 3D viewport
```

Current named resources include:

```text
eigen/spectrum.v2
eigen/branches.v2
eigen/dispersion
eigen/diagnostics.v2
eigen/mode-field/{sample_index}/{mode_index}/meta
response/magnetic-sweep
response/progress.v1
response/cancel-requested.v1
response/diagnostics/solver.v1
response/frequency-points/{frequency_index}
response/field/{frequency_index}/meta
```

The target manifest fields defined in the artifact specification must be
inspectable in the run, solver, operator, periodic-certificate and field
provenance views. UI must show requested versus resolved execution, exact
validation scope, fallback, assembly, phase, equilibrium/certificate identity,
BC/gauge and residual blocks without reconstructing them from labels.

## 9. Implementation gates

The end-to-end contract is complete only when all applicable gates pass for an
exact `(product,k-domain,demag,device,precision,engine)` scope:

1. Python and UI author the same canonical fields and round-trip.
2. `StudyIR` validates units, discriminators and unsupported combinations.
3. The planner preserves requested intent and emits one resolved engine.
4. `EquilibriumArtifact.v6 -> LinearizationState.v6` is materialized and
   consumed, not merely implemented as an isolated helper.
5. `periodic_mesh_certificate.v6` is materialized and consumed when required.
6. Native ABI version/size, pointer, ownership and release rules satisfy
   `07_api_abi_artifacts.md`.
7. MFEM assembly publishes `assembly_kind` and exact operator dictionary.
8. Modal and driven solvers certify the original full operator residual.
9. Artifacts publish the hardened manifest envelope and heavy-field metadata.
10. OpenAPI resources expose the same fields and return explicit errors.
11. Control Room consumes resources through the central facade/hooks and shows
    all requested/resolved and validation boundaries.
12. Independent validation promotes only the exact `validated_scope`.

Until every applicable gate is evidenced, the missing link remains
`contract_gap` and production qualification is forbidden.
<!-- END 16_end_to_end_fem_frequency_domain_implementation.md -->

<!-- BEGIN 17_eigen_k0_gpu_readiness_audit.md -->
# Eigen K0 GPU readiness audit

- Date: 2026-08-01
- Status: implementation_status
- Source of truth: `25_frequency_domain_readiness_matrix.json`
- Managed runtime bundle identity revalidated in this update: `true`
- Executed GPU-device solver revalidated in this update: `false`
- Historical audit: `old/17_eigen_k0_gpu_readiness_audit_legacy_2026-07-10.md`

This file is a strict GPU-focused projection of
`25_frequency_domain_readiness_matrix.json`. The old before/after audit is
archived under `old/` and must not be used as current status when it conflicts
with the readiness matrix.

## Current GPU status

All non-null `validated_scope` and `executable_scope` references use the
readiness projection catalog:

```text
scope_catalog_uri = urn:fullmag:frequency-domain:readiness-scope-catalog:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
scope_catalog_sha256 = sha256:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
scope_catalog_path = docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json
```

| Cell ID | Implementation state | Validation state | `validated_scope` | Evidence or executable scope | Current conclusion |
|---|---|---|---|---|---|
| `modal_gpu_k0_none_macrospin_larmor` | `executable` | `physics_validated` | `modal_gpu_k0_none_macrospin_larmor.validation` | K0-1 no-demag macrospin/Larmor field sweep using `gpu_dense_k0_macrospin_modal_eigen`; precision=`double`. | Real narrow GPU modal slice exists through the current emitted GPU modal validation lane. |
| `modal_gpu_k0_none_general_modal` | `source_visible` | `unvalidated` | `null` | Source evidence only. | The macrospin slice does not promote a general GPU modal eigensolver. |
| `modal_gpu_k0_periodic_airbox_dense_probe` | `source_visible` | `unvalidated` | `null` | Target label: `gpu_dense_contract_eigensolver`; current emitted GPU modal validation lane remains `gpu_dense_k0_macrospin_modal_eigen` for the no-demag macrospin cell only. | The target dense-contract label is not emitted as a production modal artifact and does not validate Poisson-airbox modal physics. |
| `modal_gpu_k0_periodic_airbox_scalable` | `absent` | `unvalidated` | `null` | None. | No persistent GPU modal selected-spectrum solver exists. |
| `modal_gpu_nonzero_k_none` | `absent` | `unvalidated` | `null` | None. | Nonzero-k Floquet GPU modal remains unavailable. |
| `modal_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | Dynamic demag-k GPU modal remains unavailable. |
| `driven_gpu_k0_none` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_k0_none.executable`: bounded gamma/free-boundary and k0 static-periodic GPU operator-host Krylov slices; not `gpu_device_krylov`. | This is driven response, not modal eigensolve; no full device-resident Krylov loop is proven. |
| `driven_gpu_k0_periodic_airbox_gpu_operator_host_krylov` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_k0_periodic_airbox_operator_host_krylov.executable`: partial periodic_airbox_k0 GPU operator-host Krylov artifacts with hybrid or host Poisson demag provider. | This is driven response, not modal eigensolve; current reliable lane is `gpu_operator_host_krylov` with host or hybrid Poisson provider. |
| `driven_gpu_k0_periodic_airbox_gpu_device_krylov` | `source_visible` | `unvalidated` | `null` | Source evidence only. | `production_loop_available=false`; no full device Krylov loop. |
| `driven_gpu_nonzero_k_none_phase_projection` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_nonzero_k_none_phase_projection.executable`: no-demag/non-DMI Floquet phase-projection response slice with local/exchange CUDA operator support only. | This is driven response, not modal eigensolve; it does not prove nonzero-k GPU modal or GPU dynamic demag-k. |
| `driven_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | Nonzero-k GPU driven dynamic-demag-k is unavailable; strict GPU fallback to CPU is forbidden. |

## What is validated

The only GPU modal cell with `validation_state=physics_validated` is:

```text
cell_id = modal_gpu_k0_none_macrospin_larmor
study_product = modal_eigen
device = gpu
precision = double
wavevector_scope = k0
demag_scope = none
solver_lane = gpu_dense_k0_macrospin_modal_eigen
validated_scope.scope_id = modal_gpu_k0_none_macrospin_larmor.validation
validated_scope.scope_catalog_uri = urn:fullmag:frequency-domain:readiness-scope-catalog:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
validated_scope.scope_catalog_sha256 = sha256:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
```

Existing static evidence:

- `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/diagnostics/solver.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-cpu-gpu-comparison-summary.v1.json`

Those artifacts report GPU execution and roundoff-level CPU/GPU agreement for
the no-demag macrospin field sweep. They do not prove:

- K0 Poisson-airbox demag;
- real shared-domain FEM assembly;
- nonzero-k Floquet modal dispersion on GPU;
- dynamic demag-k;
- DMI or damping modal qualification;
- broad sparse/matrix-free selected-spectrum GPU modal execution;
- Task8 runtime `scope_catalog.v1` emission.

## What is not production qualified

### GPU K0 Poisson-airbox modal

`modal_gpu_k0_periodic_airbox_dense_probe` is source-visible and unvalidated in
the current matrix. The target label remains:

```text
target_solver_label = gpu_dense_contract_eigensolver
implementation_state = source_visible
validation_state = unvalidated
validated_scope = null
```

That target must not be described as emitted until a runtime artifact actually
publishes the label with Task8 scope binding and the telemetry required by
chapter 11. The current emitted GPU modal validation lane is
`gpu_dense_k0_macrospin_modal_eigen`, and it is scoped only to the no-demag
macrospin cell.

GPU K0 Poisson-airbox production qualification still requires:

- persistent GPU modal context;
- full selected-spectrum Krylov-Schur or Arnoldi loop;
- shifted preconditioner;
- Ritz extraction, restart and convergence;
- real shared-domain `mfem_weak_form_shared_domain` assembly;
- CPU/GPU parity for real Poisson-airbox blocks;
- mesh and airbox convergence;
- K0-3 Kittel independence.

### GPU nonzero-k modal

No GPU modal nonzero-k Floquet operator/eigensolver is production available.
The driven-response no-demag phase-projection slice is not modal proof. A
strict GPU request for nonzero-k modal dynamic demag must fail explicitly.

### GPU device Krylov

`gpu_device_krylov` and `gpu_modal_device_krylov` may be claimed only after
the telemetry contract in chapter 11 proves a full device-resident loop with
zero per-iteration host transfers. Current status remains:

```text
implementation_state = source_visible
validation_state = unvalidated
validated_scope = null
```

## Required promotion gates

A future broad GPU modal promotion must add all of the following for the exact
cell being promoted:

1. backend-owned GPU modal source under the GPU frequency-domain owner, not a
   modal proof hidden inside driven-response source;
2. persistent device context for blocks, vectors, basis and preconditioner;
3. scalable selected-spectrum solver with restart, convergence and Ritz
   extraction;
4. reconstructed original-unscaled descriptor residual and finite-mode
   certification;
5. transfer audit showing no per-iteration H2D/D2H;
6. CPU/GPU parity on real assembled blocks;
7. validation matrix gates for the exact `validated_scope`;
8. artifact fields with requested/resolved execution, implementation state,
   validation state, Task8 scope binding and evidence scope.

Until those gates pass, only the narrow K0 no-demag macrospin GPU modal cell is
`physics_validated`, and only for precision=`double`.

## Revalidation after the master branch update (2026-08-01)

The working branch was first brought up to the current `origin/master` before
this audit. The merge commit is `d5f63b35a4f4a57798089915b312c4695caea917`;
`origin/master` is `eee245ac200bf138d880b793791848106b7386ba`, and
`git rev-list --left-right --count HEAD...origin/master` reports `25 0`.
This is branch-integration evidence, not solver qualification.

The managed FEM bundle was rebuilt and validated against the exact source
snapshot. Its manifest reports commit `d5f63b35a4f4a57798089915b312c4695caea917`,
`source_identity_compatibility=exact-schema-3`, `worktree_state=clean`, and
`compute_capability=8.9`. The container reported that no NVIDIA driver was
available, so no executed-device GPU result was produced.

The aggregate native-contract recipe was attempted after the rebuild but
stopped before compilation because the fresh worktree did not contain
`native/build`; this is a recipe/bootstrap failure, not evidence that the
frequency-domain contracts passed or failed. The explicit K0 CPU recipe then
configured its own managed CMake build and produced the contract binary, but
the small SLEPc fixture did not emit a result after approximately 19 minutes.
The recipe was terminated with exit code 130; this is a timeout/non-convergence
boundary, not a pass.

The source-level boundary is unchanged and is anchored by:

| Source anchor | Revalidated conclusion |
|---|---|
| `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu::fullmag_fem_frequency_domain_apply_modal_shift_invert_gpu_action` | A device dense shifted action exists, but its diagnostics explicitly set `gpu_device_resident_modal_eigensolver=false`; it is not a modal Krylov loop. |
| `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu::fullmag_fem_frequency_domain_solve_modal_poisson_airbox_gpu_dense_eigensolver` | The bounded dense Poisson-airbox lane remains `validation_only=true`, `production_modal_claim=false`, and `persistent_solver_context=false`. |
| `backends/fem/include/frequency_domain/gpu_device_krylov.hpp::validate_fgmres_device_engine` | Device workspace validation is present, but `production_loop_available=false`; no promotion follows from the contract structure alone. |

Therefore `modal_gpu_k0_periodic_airbox_scalable` remains `absent/unvalidated`
and the only physics-validated GPU modal cell remains the double-precision,
no-demag macrospin/Larmor slice.
<!-- END 17_eigen_k0_gpu_readiness_audit.md -->

<!-- BEGIN 18_poisson_airbox_eigensolve_cpu_gpu_implementation.md -->
---
title: K0 Poisson-airbox modal and driven implementation contract
version: COMSOL-aligned v5.1 decision-complete
status: scoped K0 target contract with explicit current implementation boundaries
role: scoped_normative_implementation_contract_subordinate_to_plan_20_and_physics_notes
---

# K0 Poisson-airbox modal and driven implementation contract

## 1. Scope and current-vs-target boundary

This chapter is the scoped normative implementation contract for FEM `k=0`
dynamic demag on a shared magnetic-plus-airbox domain for both `modal_eigen`
and `driven_response`. The authority order is:

1. physics semantics in `docs/physics/0700-frequency-domain-linearized-llg.md`,
   `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` and
   `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`;
2. the active overarching dynamic-solver audit and remediation contract in
   `20_dynamic_solver_audit_revalidation_and_remediation.md`; and
3. this chapter for the subordinate K0 Poisson-airbox implementation details.

Within that hierarchy, this chapter consumes, without redefining:

- the phasor, sign, unit, damping and operator dictionary in
  `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`;
- the K0 Poisson-airbox physics and residual contract in
  `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`;
- the accepted equilibrium and periodic-certificate contracts in chapters 03
  and 04;
- the end-to-end propagation contract in chapter 16;
- the planner and engine vocabulary in chapters 06 and 08; and
- backend ownership in `docs/architecture/backend-golden-masterplan.md`.

This chapter does not supersede plan 20, does not alter the authority of the
physics notes and is not authority to promote a capability. It is a scoped
target implementation contract only. Implementation, execution and validation
remain independent axes.

### 1.1 Supported target scope

The first qualification scope is:

```text
discretization = fem
product = modal_eigen | driven_response
k = (0,0,0)
dynamic_demag = periodic_airbox_k0
magnetic FE = tangent P1, two DOFs per active magnetic node
potential FE = scalar P1 on magnetic plus airbox domain
periodicity = x and y
open direction = z
outer BC = poisson_robin | poisson_dirichlet | pure_neumann
precision = double
initial modal qualification = alpha=0
```

Nonzero-k dynamic demag, fully periodic three-dimensional K0 demag, arbitrary
high-order FE, broad damped/nonconservative modal qualification and hidden CPU
fallback for strict GPU are outside this contract and reject explicitly.

### 1.2 Current implementation boundary

| Current repository evidence | Honest current status | Target boundary |
|---|---|---|
| `dense_poisson_airbox_eigen_oracle.cpp` and PA-E1 fixtures construct tiny dense blocks. | `synthetic_algebraic_oracle`; bounded algebra evidence only. | Never selected for physical K0 Poisson-airbox execution and never a production fallback. |
| `PoissonAirboxEigenBlockProblem` accepts CSR blocks through ABI v2. | The current validator accepts only `synthetic_algebraic_oracle`; Robin and Dirichlet are rejected because the current descriptor assumes a gauge row. | Replace supplied synthetic blocks with backend-owned `mfem_weak_form_shared_domain` assembly and the exact BC-dependent descriptor. |
| `poisson_airbox_modal_eigen.cpp` creates a monolithic SeqAIJ descriptor and calls SLEPc. | Source-visible/executable for bounded synthetic payloads. It currently passes real `omega_target` to the unrotated lambda pencil. | Use the real-PETSc representation in section 6 and qualify selected interior spectra. |
| Current residual code reports SLEPc backward error and reconstructed magnetic, scalar and gauge blocks. | Useful source evidence; current input validation still requires a pure-Neumann augmentation and overconstrains mean weights. | Certify every accepted mode or response from the original unscaled BC-correct blocks. |
| `poisson_airbox_schur_matshell.cpp` builds and certifies a Schur MatShell. | Algebra-validated against synthetic fixtures only. | Admit Schur only with an exact-signature certificate generated from real shared-domain blocks. |
| Current driven periodic-airbox provider/Schur paths execute for bounded CPU/GPU slices. | They are not the target full coupled `MatNest/PCFIELDSPLIT` solve and do not qualify modal solving. | Cross-check full coupled and Schur driven results on the same P1 blocks and physical RHS. |
| The CUDA frequency-domain source owns a persistent magnetic operator context and bounded dense/apply probes. | Operator residency or a one-shot dense solve is not device Krylov residency. `production_loop_available=false` remains current device-Krylov truth. | Only `gpu_device_krylov` and `gpu_modal_device_krylov` are scalable GPU solver claims. |
| No dedicated frequency-domain shared-domain modal assembler exists. | Real K0 Poisson-airbox modal production is not implemented or qualified. | Modal promotion requires K0-P1 through K0-P6 and K0-G1 through K0-G4. K0-P7 is a separate driven-response cross-check and does not gate modal promotion. |
| `crates/fullmag-runner/src/fem_eigen.rs::build_pa_e4b_k0_kittel_poisson_airbox_payload` computes `expected_reference_frequency_hz` from the analytical Kittel expression and assigns it to both `target_frequency_hz` and `expected_reference_frequency_hz`. | The analytical answer currently contaminates the synthetic PA-E4b solve request; it is not postsolve-only validation. | K0-P3 removes analytical reference data from descriptor assembly/request construction; only a user-requested target or window may reach the eigensolver. |
| `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` converts that `target_frequency_hz` into the SLEPc target, selects the nearest accepted mode by distance to it, and uses `expected_reference_frequency_hz` for `reference_frequency_certified` pass/fail. | Kittel data currently influences targeting, nearest-mode selection and solver success. | K0-P4 removes analytical-reference selection and pass/fail from the solver. Analytical Kittel comparison is postsolve validation owned by K0-P6 and its independent verifier only. |

Analytical frequencies and demag factors are verifier inputs only. They must
not enter block assembly, spectral targeting, preconditioning, convergence,
mode selection or solver pass/fail. The current
`expected_reference_frequency_hz` payload field is active contamination, not
solver evidence; K0-P3/P4 remove it from solve construction and acceptance,
while K0-P6 performs the analytical Kittel comparison after the solve.

## 2. Mathematical model and FE spaces

### 2.1 Physical equations

Fullmag uses `exp(+i omega t)`, fields in `A/m`, and
`gamma0=mu0*abs(gamma)`. On the magnetic region `Omega_m` and shared domain
`D=Omega_m union Omega_air`:

```text
delta_m = T q
m0 dot delta_m = 0
delta_H_demag = -grad(delta_phi)

int_D grad(psi) dot grad(delta_phi) dV
  + beta int_Gamma_open psi delta_phi dS
  = int_Omega_m Ms delta_m dot grad(psi) dV.
```

The modal and driven contracts are:

```text
modal:  A x = lambda B x,  lambda = i omega
driven: (i omega B - A) x = [b_q, b_phi, 0]
```

Here `A` is the block realization of the dictionary operator `L` together with
the algebraic scalar-potential constraint, and `B` is `B_alpha` on magnetic
rows with zero scalar/gauge rows. This notation does not introduce a second
dynamic-operator convention.

The final zero entry is present only for the pure-Neumann gauge row. A usual
magnetic RF drive has `b_phi=0`; a future scalar source must be explicitly
typed and obey the same row units and signs.

### 2.2 Discrete spaces

Let `N_a` be scalar P1 shape functions on active magnetic nodes, `Psi_i` scalar
P1 shape functions on the shared domain, and `T_a=[t_a1,t_a2]` an orthonormal
tangent frame at magnetic node `a`.

```text
Q_h = {delta_m_h = sum_a N_a T_a q_a}, q_a in C^2
V_h = scalar continuous P1 on D after K0 periodic reduction
V_h^0 = V_h with homogeneous outer Dirichlet classes eliminated
```

The first implementation accepts P1 only. A request with `fe_order != 1`
rejects until every magnetic, scalar, coupling, residual and convergence path
implements that order; silently evaluating a P1 operator on a higher-order
request is forbidden.

### 2.3 Canonical ordering

Ordering is part of the operator signature:

```text
q = [q_0,1, q_0,2, q_1,1, q_1,2, ...]       node-major magnetic order
phi = [phi_0, phi_1, ...]                      reduced scalar true-DOF order
x_R/D = [q, phi]                               Robin or Dirichlet
x_N   = [q, phi, eta]                          pure Neumann
real split = [x_real, x_imag]                  field blocks first, then copy
```

`phi` ordering is produced after complete scalar equivalence classes are
formed and, for Dirichlet, after every reduced class touching the essential
outer boundary is marked and eliminated. The magnetic and scalar reduction
maps, source true-DOF maps and all offsets are artifact fields. A backend may
use another internal layout only through an explicit permutation whose parity
with this canonical ordering is tested and recorded.

## 3. Shared-domain P1 assembly

### 3.1 Blocks and weak forms

For tangent test `v_h=sum_a N_a T_a p_a` and scalar test `psi_h`, the assembler
produces:

```text
P_ij = int_D grad(Psi_i) dot grad(Psi_j) dV
     + beta int_Gamma_open Psi_i Psi_j dS

(C_phi_q q)_i = int_Omega_m Ms (T q) dot grad(Psi_i) dV
A_phiq = -C_phi_q

p^H A_qphi phi
  = int_Omega_m v_h dot [-gamma0 m0 x (-grad(delta_phi_h))] dV

p^H A_qq q
  = weak tangent projection of the accepted static-restoring,
    local, exchange, DMI and other admitted frequency-independent
    derivatives in FrequencyOperatorDictionary.v1

p^H B_qq q
  = gyrotropic/Gilbert tangent mass form from
    FrequencyOperatorDictionary.v1.
```

The sign `A_phiq=-C_phi_q` follows from `P phi=C_phi_q q` and the descriptor
row `A_phiq q+P phi=0`. `A_qq` excludes dynamic demag because that derivative
is represented by `A_qphi`, `A_phiq` and `P`. Static demag remains in the
accepted `h_eff0` contribution to the linearization.

Every block is assembled from the same accepted `LinearizationState`, magnetic
region map, P1 geometry, quadrature rule, `Ms` source and tangent frames. No
block may infer material values from an expected analytical frequency.

### 3.2 SI units by row and column

| Quantity | Unit | Consequence |
|---|---|---|
| `q`, magnetic test coefficient | `1` | normalized tangent perturbation |
| `phi` | `A` | `-grad(phi)` is `A/m` |
| `eta` with normalized `c` | `A m` | `c eta` has scalar-row unit `A m` |
| `P` | `m` | `P phi` is `A m` |
| `C_phi_q`, `A_phiq` | `A m` per unit `q` | same unit as `P phi` |
| `A_qphi` | `m^3/(A s)` | `A_qphi phi` is `m^3/s` |
| `A_qq` | `m^3/s` | magnetic dynamic row |
| `B_qq` | `m^3` | `lambda B_qq q` is `m^3/s` |
| `b_q` | `m^3/s` | projected physical drive RHS |
| `b_phi` | `A m` | scalar equation RHS |
| gauge row `c^T phi` | `A` | mean-potential constraint |

The matrix is not made dimensionally uniform by pretending these blocks have
the same units. Solver scaling is explicit and residual certification returns
to the original physical blocks.

### 3.3 Reciprocal coupling and energy check

`C_phi_q` and the field recovery used by `A_qphi` share element traversal,
quadrature points, Jacobians, `Ms`, tangent frames and periodic maps. For every
test pair `(p,phi)`, use the sesquilinear inner product that is conjugate-linear
in its first argument. The pre-LLG field map must satisfy:

```text
<Ms T p, H_phi(phi)>_Omega_m = -p^H C_phi_q^H phi
H_phi(phi) = -grad(phi).
```

Equivalently, the mixed magnetostatic energy Hessian uses `mu0 C_phi_q^H`
before the `-gamma0 m0 x` dynamic projection. The production gate checks this
identity by element and globally. For each element `e` and for the assembled
global operator it forms

```text
r_rec,e(p,phi) = <Ms T p,H_phi(phi)>_e + p^H C_phi_q,e^H phi
eps_rec,e = |r_rec,e| /
  (|<Ms T p,H_phi(phi)>_e| + |p^H C_phi_q,e^H phi| + eps)
```

and requires both the maximum element residual and the global residual to meet
their declared tolerances for deterministic basis vectors and seeded complex
random pairs. A sign-flip negative control must fail. The gate also checks the
assembled conjugate-adjoint action and verifies the demag energy and field sign
on sphere/ellipsoid oracles. `A_qphi` is not asserted to equal `A_phiq^H`
because the LLG cross-product projection and units are applied after this
energy/field adjoint identity.

### 3.4 Common block scaling

The assembler publishes positive reference scales `L_ref`, `V_m`, `H_ref`,
`Ms_ref` and `gamma0_ref`, then uses one scaling for full, Schur, CPU and GPU
paths:

```text
X = diag(q*=1, phi*=H_ref L_ref, eta*=Ms_ref V_m/L_ref)
R = diag(r_q*=gamma0_ref H_ref V_m,
         r_phi*=Ms_ref V_m/L_ref,
         r_eta*=H_ref L_ref)

A_hat = R^-1 A X
B_hat = R^-1 B X
b_hat = R^-1 b.
```

For Robin/Dirichlet, the `eta` entries are absent. The same `X` and `R` are
duplicated for real and imaginary blocks. Their values and hash are part of
the problem signature and Schur certificate. Scaling may improve conditioning
but may not change signs, branch selection or acceptance; `eps_q`, `eps_phi`,
`eps_gauge` and `eps_full` are recomputed from unscaled original blocks.

## 4. Periodic reduction and outer BC

### 4.1 K0 reduction

The mesh certificate supplies complete magnetic and scalar equivalence classes,
lattice translations and tangent-frame transforms. At K0 the scalar phase is
one, while the magnetic constraint still transports tangent frames:

```text
T_dst q_dst = Q T_src q_src
q_dst = (T_dst^T Q T_src) q_src
phi_dst = phi_src
Q = I for a pure translation.
```

The assembler forms unconstrained element contributions once and reduces them
with magnetic and scalar prolongations `R_q`, `R_phi`:

```text
A_qq   <- R_q^H A_qq R_q
B_qq   <- R_q^H B_qq R_q
A_qphi <- R_q^H A_qphi R_phi
A_phiq <- R_phi^H A_phiq R_q
P      <- R_phi^H P R_phi.
```

Complete corner/edge classes, cycle consistency and independent magnetic and
scalar hashes are mandatory. Pair-only postsolve projection is not an operator.

### 4.2 Closed BC/gauge tuple

| `outer_boundary_kind` | Required parameters | Scalar space and descriptor | Required tuple |
|---|---|---|---|
| `poisson_robin` | finite `beta>0`; Robin mass only on non-periodic open faces | all reduced scalar DOFs; no multiplier | `gauge_policy=none`, `gauge_reason=coercive_outer_boundary` |
| `poisson_dirichlet` | `beta=0`; homogeneous perturbation potential on declared outer faces | essential reduced classes eliminated from `P`, both couplings and vectors; no multiplier | `gauge_policy=none`, `gauge_reason=coercive_outer_boundary` |
| `pure_neumann` | `beta=0`; no essential outer potential | normalized quadrature mean vector `c` and multiplier `eta` | `gauge_policy=mean_zero_augmented`, `gauge_reason=pure_neumann_nullspace` |

For pure Neumann, `c_i=int_D Psi_i dV / int_D 1 dV` on the active reduced
scalar space and `sum_i c_i=1` within assembly tolerance. Eliminated or
inactive entries may have zero weight. Robin or Dirichlet must not carry `c`
or `eta`. Lateral periodicity alone does not create a gauge when the open
boundary is coercive.

Fully periodic 3D K0 rejects before assembly because no macroscopic-field
convention is defined.

## 5. Descriptor and driven block systems

### 5.1 Full systems

For Robin or Dirichlet:

```text
A = [A_qq    A_qphi]       B = [B_qq  0]
    [A_phiq  P     ]           [0     0]
x = [q,phi].
```

For pure Neumann:

```text
A_N = [A_qq    A_qphi  0]
      [A_phiq  P       c]
      [0       c^T     0]

B_N = [B_qq  0  0]
      [0     0  0]
      [0     0  0]

x_N = [q,phi,eta].
```

The modal equation is `A x=lambda B x`. The driven equation is
`(i omega B-A)x=[b_q,b_phi,0]`; signs in any row-rescaled implementation must
map exactly back to this equation.

### 5.2 Schur systems

Let `K_phi=P` for no-gauge boundaries and
`K_phi=[[P,c],[c^T,0]]` for pure Neumann. With the obvious zero extension of
the couplings, define:

```text
S = A_qq - [A_qphi,0] K_phi^-1 [A_phiq;0]

modal:  S q = lambda B_qq q

driven: (i omega B_qq-S) q = b_S
b_S = b_q - [A_qphi,0] K_phi^-1 [b_phi;0].
```

Reconstruction is mandatory:

```text
[phi;eta] = -K_phi^-1 ([A_phiq;0] q + [b_phi;0])
```

with `b_phi=0` for modal solve. The Schur path and full path consume the same
assembled blocks, BC elimination, scaling and Poisson solver policy. A dense
inverse is allowed only in a bounded oracle and is never production evidence.

### 5.3 Finite modes, branch and window

Because `B` is zero on scalar and gauge rows, the full descriptor contains
algebraic/infinite modes. An accepted modal result must:

1. have finite `lambda`, `omega=-i lambda` and nonzero magnetic norm;
2. pass the selected solver's finite-eigenvalue classification;
3. satisfy the requested frequency window after canonical mapping;
4. for the first undamped qualification, satisfy `lambda_imag>0` and exclude
   the declared zero-frequency policy;
5. reconstruct `phi` and `eta` and pass the original full residual; and
6. satisfy window-completeness and conjugate/positive-branch accounting for the
   requested count, where `mode_count` counts physical complex modes rather
   than duplicated real-split vectors.

Sorting or filtering after a wrongly targeted solve does not certify an
interior window.

### 5.4 Residual certification

For every modal candidate:

```text
r_q     = A_qq q + A_qphi phi - lambda B_qq q
r_phi   = A_phiq q + P phi + c eta
r_gauge = c^T phi

eps_q = ||r_q|| /
  (||A_qq q|| + ||A_qphi phi|| + |lambda| ||B_qq q|| + eps)
eps_phi = ||r_phi|| /
  (||A_phiq q|| + ||P phi|| + ||c eta|| + eps)
eps_gauge = |c^T phi| / (||c|| ||phi|| + eps)
eps_full = max(eps_q,eps_phi,eps_gauge).
```

Terms involving `c` and `eta` are zero and `eps_gauge=0` when no gauge exists.
For driven response, residuals are formed directly from
`(i omega B-A)x-b`; the block denominators add the corresponding RHS norm.
The tracked preconditioned/Krylov residual and SLEPc-reported backward error
are diagnostics only. They cannot cap or replace `eps_full`.

## 6. CPU selected-spectrum algorithm

### 6.1 Complex PETSc/SLEPc

With complex scalars, SLEPc consumes the scaled generalized pencil directly.
For an interior target:

```text
sigma=i*omega_target
EPS problem = generalized non-Hermitian
EPS type = Krylov-Schur or Arnoldi
ST = shift-invert or another named, artifact-recorded transform
selection = EPS_TARGET_MAGNITUDE around complex sigma
```

The shifted KSP/PC and its tolerances are part of the engine. A direct shifted
factorization is a bounded CPU baseline; scalable work uses a certified
iterative shifted solve.

### 6.2 Real PETSc target representation

For any complex matrix `M=M_R+i M_I`, define only the algebraic realification
map

```text
R(M) = [ M_R  -M_I ]
       [ M_I   M_R ]

J = [ 0  -I ]
    [ I   0 ]
```

Realification maps a fixed complex operator action to real block form; it does
not turn a generalized eigenproblem with complex `lambda` into a real
generalized eigensystem. The initial real-PETSc lane is narrower: `alpha=0`,
admitted conservative K0 operators, and real `omega`. With the Task 2
dictionary `A=L`, `B=B_alpha`, `lambda=i omega`, and `y=[x_R;x_I]`, its directly
specified real-frequency pencil is

```text
A x = i omega B x
R(A) y = omega R(i B) y

R(i B) = J R(B) = R(B) J.
```

For the energy-Hessian notation `A=K` and `B_alpha=-G`, the exact same pencil
is

```text
R(K) y = omega R(-i G) y.
```

Thus a notation that calls the energy gyrotropic operator `G` by the local name
`B` writes `R(A)y=omega R(-i B)y`; this document keeps `B` reserved for the
Task 2 dictionary operator `B_alpha=-G` and therefore uses `R(i B)`. The complex
lambda target and real-frequency target are linked exactly:

```text
sigma=i*omega_target
tau=omega_target.
```

`EPSSetTarget(tau)` with `EPS_TARGET_MAGNITUDE` is legal only on this named
`real_frequency_rotated` pencil. Its shift-invert solve uses
`R(A)-tau R(i B)=R(A-i tau B)`, which is the real representation of the same
complex shift, not a real-axis approximation to `sigma`. Artifacts record
`spectral_scalar_mode=real_split`, `spectral_pencil_kind=real_frequency_rotated`,
`sigma_real_per_s=0`, `sigma_imag_rad_per_s=omega_target` and `tau=omega_target`.

Multiplication of `x` by `i` maps `y` to `Jy`. Because the real-frequency
pencil commutes with this complex structure, `y` and `Jy` are not two physical
modes. One physical mode is the J-equivalence class

```text
[y]_J = span_R{y,Jy},
q = q_R + i q_I.
```

After the existing positive mass normalization, a simple class receives a
deterministic representative by choosing the smallest canonical magnetic DOF
index `j` attaining `max_k |q_k|`, multiplying the reconstructed full complex
state by `exp(-i arg(q_j))`, and requiring `q_j` to be real and positive within
tolerance. This rule canonicalizes `y` and `Jy` identically. A candidate with
zero magnetic norm is not a physical class.

`requested_mode_count` counts these physical J-equivalence classes. A simple
physical frequency has real eigenspace `span_R{y,Jy}` and therefore real
multiplicity two. A frequency cluster with physical multiplicity `d` must have
an even, J-closed real invariant subspace of dimension `2d`; degenerate-cluster
tests compare frequency multiplicity and subspace projectors, not arbitrary
solver basis vectors. Acceptance requires J-partner residual parity, canonical
reconstruction parity, the declared frequency tolerance, and at least the
requested number of complete physical classes in a certified window.

This rotated real-frequency pencil does not cover Gilbert damping or another
non-Hermitian case with complex `omega`. Such a spectrum requires a separately
specified real generalized formulation with its own eigenvalue mapping and
tests, or a complex PETSc/SLEPc lane. The undamped pencil must not be reused as
if it represented that spectrum.

### 6.3 Selected-spectrum execution and acceptance

The CPU algorithm is:

1. validate the equilibrium, P1 shared-domain mesh, periodic certificate,
   BC/gauge tuple, material sources and exact problem signatures;
2. assemble and scale real FEM blocks once;
3. choose full descriptor or certified Schur before SLEPc setup;
4. create the complex or `real_frequency_rotated` pencil and exact target;
5. configure the selected transform, KSP/PC, count, subspace, tolerance and
   maximum iterations;
6. solve, classify finite modes, form complete J-equivalence classes, map
   `lambda` and `omega`, filter the positive branch and enforce the requested
   physical window/count;
7. undo solver scaling, reconstruct scalar/gauge fields and compute every
   original block residual; and
8. publish converged, rejected and accepted counts plus the exact stop reason.

A mandatory multi-mode interior-window case contains at least three positive
modes around a nonzero interior target. It must select the same mode set in
complex and rotated-real representations. A negative control using a real
target on the unrotated lambda pencil must select the wrong set or fail the
window gate, so a real-axis shift regression cannot pass by post-filtering.

## 7. CPU driven field-split algorithm

The production full-coupled CPU driven engine uses the same blocks as modal
solve:

```text
operator = PETSc MatNest or equivalent nested MatShell for i omega B-A
outer solve = GMRES or FGMRES
preconditioner = PCFIELDSPLIT
magnetic split = accepted tangent dynamic preconditioner
scalar split = BC/gauge-correct PETSc/hypre Poisson solve
```

The physical RF field is converted once to
`b_q=T^T[-gamma0(m0 x delta_h_drive)]` with the magnetic weak mass pairing.
No native solve may reinterpret tangent field samples as an already projected
RHS without the explicit conversion and provenance required by chapter 16.

For a sweep, frequency-independent assembly, reduction, scaling and Poisson
setup are reused under one immutable problem signature. Frequency-dependent
state is limited to `i omega B`, the selected preconditioner update and solve
vectors. Every accepted frequency reports tracked residual history and a
recomputed unpreconditioned full/block residual. Explicit strict field-split
rejects when unavailable. A permitted non-strict fallback may select another
full CPU engine for the identical physical problem only before execution and
must publish requested/resolved engines and `fallback_reason`.

K0-P7 is a separate driven-response scope. It compares full coupled response
against direct/Schur response on identical blocks and against modal resonance
only after the modal basis has its own completeness and full-residual
certificate. It is not a predecessor for the K0 modal CPU/GPU promotion scope,
which ends at K0-P6 and K0-G4.

## 8. Certified Schur algorithms

### 8.1 Certificate

`schur_reduced` is legal only with a `SchurCertificate` keyed by:

```text
equilibrium, mesh, magnetic/scalar periodic certificate, material, physics,
boundary/gauge, k=(0,0,0), FE order, assembly, operator dictionary, tangent
frame, block ordering, block scaling, scalar representation, precision,
Poisson solver and preconditioner signatures.
```

Any changed key invalidates the certificate. The certificate contains random
and basis-vector apply parity, scalar solve residuals, reciprocal-coupling
checks, full-versus-Schur modal parity, full-versus-Schur driven samples,
reconstruction residuals and accepted tolerances.

### 8.2 Modal Schur

The SLEPc MatShell applies `S q` without forming `P^-1` and uses the same
complex or rotated-real target as the full descriptor. The scalar solve is
reused through an owned PETSc/hypre context. Ritz vectors are magnetic only;
every candidate reconstructs `phi`/`eta` before acceptance. A Schur eigen
residual alone never accepts a mode.

### 8.3 Driven Schur

The driven MatShell applies `i omega B_qq-S` and constructs `b_S` with the same
scalar context. It reconstructs the full response at every accepted frequency.
A runtime scalar-solve or apply-quality violation invalidates the certificate
for the run. Strict Schur rejects. A permitted auto request may replan to the
full coupled CPU engine only before the next solve and records the invalidation
and fallback.

## 9. GPU persistent context and solvers

### 9.1 Truthful GPU labels

| Label | Contract | Solver claim |
|---|---|---|
| `gpu_dense_contract_eigensolver` | bounded dense synthetic algebra oracle | validation only; non-scalable |
| `gpu_descriptor_apply_probe` | one-shot parity of full descriptor action | probe only |
| `gpu_shifted_apply_probe` | one-shot parity of the correctly shifted/rotated action or solve | probe only |
| `gpu_persistent_operator_context` | setup-once device ownership of accepted blocks and reusable actions | context/readiness only |
| `gpu_modal_device_krylov` | device-resident SLEPc modal iteration, shifted solves and Ritz state | scalable modal solver |
| `gpu_device_krylov` | device-resident PETSc KSP driven iteration and preconditioner | scalable driven solver |

Only the final two labels are scalable solver claims. A probe or dense result
cannot set either label, even when its arithmetic ran on a GPU.

### 9.2 Persistent allocation and lifetime

`gpu_persistent_operator_context` is created once per exact problem signature
and owns, on device:

- reduced mesh/geometry, region maps, tangent frames, material fields and
  periodic/Dirichlet maps;
- `A_qq`, `A_qphi`, `A_phiq`, `P`, `B_qq`, `c`, scaling and permutations, as
  assembled matrices or equivalent MFEM/libCEED/CUDA actions;
- PETSc CUDA vectors, MatShell/MatNest state, hypre device Poisson/shifted
  preconditioner state and reusable work vectors; and
- for solver contexts, Krylov basis, restart workspace, Ritz vectors and all
  device-side orthogonalization/reduction state required by PETSc/SLEPc.

Setup H2D is allowed and counted. Final eigenvector/response export and
explicit output-cadence snapshots may copy D2H and are counted. Per-iteration
vector or matrix H2D/D2H, host dot/norm/axpy, host Arnoldi/Hessenberg updates
or host preconditioner state invalidate a device-resident solver claim.
Context destruction is deterministic on success, rejection, interruption and
exception; a changed signature creates a new context rather than mutating an
accepted one in place.

### 9.3 Modal and driven execution

`gpu_modal_device_krylov` uses PETSc CUDA objects and SLEPc Krylov-Schur or
Arnoldi. The complex/rotated-real target, restart/subspace size, converged Ritz
count, rejected finite-mode count and stop reason are explicit. Shift-invert
uses a PETSc/hypre device solve with measured contraction and no hidden host
factorization. Accepted Ritz vectors are reconstructed and certified against
the original full blocks before final D2H export.

`gpu_device_krylov` uses PETSc KSP GMRES/FGMRES over the full or certified Schur
driven action. Restart, right preconditioner, tracked residual, periodically
recomputed true residual and convergence reason are device-engine state.

Both engines publish:

```text
krylov_vector_location=device
operator_buffer_location=device
preconditioner_buffer_location=device
setup_h2d_transfer_count
final_d2h_transfer_count
per_iteration_h2d_transfer_count=0
per_iteration_d2h_transfer_count=0
operator_apply_count
preconditioner_apply_count
krylov_iteration_count
restart_count
```

Strict GPU rejects when any required block, device scalar representation,
Poisson/shifted preconditioner, memory admission or transfer audit is missing.
It never routes to CPU or to `gpu_operator_host_krylov` while retaining a
device-resident label.

## 10. Artifacts and exact rejection reasons

### 10.1 Required artifact envelope

Every attempted solve publishes the available subset of the common artifact
envelope; successful promotion requires all applicable fields:

| Area | Required fields or target artifact |
|---|---|
| Identity | git/build/run identity; `physics_contract_version`; `operator_dictionary_version` |
| Intent | product, frequency/window/count, K0, demag, requested device/precision/method/strictness |
| Resolution | resolved engine/device/precision, selection reason, fallback flag/reason |
| Inputs | equilibrium, mesh, material, physics, boundary, tangent-frame and certificate hashes |
| FE assembly | `assembly_kind=mfem_weak_form_shared_domain`, `fe_order=1`, quadrature, DOF counts/maps/orderings, block/scaling hashes, reciprocity diagnostics |
| BC/gauge | outer boundary, beta, gauge policy/reason, eliminated DOFs or normalized `c` diagnostics |
| Spectrum | scalar mode, pencil kind, `sigma`/`tau`, transform, KSP/PC, finite/converged/rejected/accepted counts, branch/window completeness |
| Driven | physical drive and projected-RHS provenance, frequency point, KSP/PC/restart/stop reason |
| Certification | `eps_q`, `eps_phi`, `eps_gauge`, `eps_full`, tracked/backend residuals as separate diagnostics |
| Residency | context identity, buffer locations, allocation bytes, setup/final/per-iteration transfer counts |
| Status | independent `implementation_state`, `validation_state`, `validated_scope`, native status, `complete` |

Target named artifacts include:

```text
eigen/diagnostics/solver.v1.json
eigen/spectrum.v2.json
response/diagnostics/solver.v1.json
response/frequency-points/{frequency_index}.json
validation/k0_poisson_airbox/manufactured_poisson.v1.json
validation/k0_poisson_airbox/reciprocity.v1.json
validation/k0_poisson_airbox/interior_window.v1.json
validation/k0_poisson_airbox/kittel_convergence.v1.csv
validation/k0_poisson_airbox/cpu_gpu_parity.v1.json
validation/k0_poisson_airbox/gpu_transfer_audit.v1.json
```

Analytical reference values appear only in validation artifacts produced or
consumed by an independent verifier after the solve. They are not accepted as
assembly or eigensolver inputs.

### 10.2 Rejection tokens

| Exact token | Trigger | Fallback |
|---|---|---|
| `k0_poisson_airbox_requires_accepted_equilibrium` | missing or unaccepted equilibrium | none |
| `k0_poisson_airbox_signature_mismatch` | any equilibrium/mesh/material/physics/boundary hash mismatch | none |
| `k0_poisson_airbox_requires_shared_domain_mesh` | magnetic-plus-airbox coverage or region map absent | none |
| `k0_poisson_airbox_requires_periodic_mesh_certificate_v6` | required complete magnetic/scalar classes or hashes absent | none |
| `k0_poisson_airbox_unsupported_fe_order` | any accepted space is not P1 | none |
| `k0_poisson_airbox_unsupported_k` | any k component is nonzero beyond canonical tolerance | none |
| `k0_poisson_airbox_fully_periodic_3d_unsupported` | no open direction/macroscopic convention | none |
| `k0_poisson_airbox_invalid_boundary_gauge_tuple` | BC, beta, gauge, reason, weights or multiplier disagree | none |
| `k0_poisson_airbox_real_fem_assembly_unavailable` | real shared-domain assembler is absent for the request | no synthetic substitution |
| `k0_poisson_airbox_scalar_manufactured_validation_failed` | scalar P1 sign, BC, gauge or convergence oracle fails | none |
| `k0_poisson_airbox_reciprocity_check_failed` | energy/field coupling identity exceeds tolerance | none |
| `k0_poisson_airbox_descriptor_parity_failed` | assembled full descriptor disagrees with independent action/oracle | none |
| `k0_poisson_airbox_real_split_target_unavailable` | real PETSc path cannot form `real_frequency_rotated` | no unrotated real target |
| `k0_poisson_airbox_cpu_solver_parity_failed` | direct, complex and rotated-real selected spectra disagree | none |
| `k0_poisson_airbox_no_finite_modes` | no finite magnetic mode survives classification | none |
| `k0_poisson_airbox_interior_window_incomplete` | requested count/window completeness is not certified | none |
| `k0_poisson_airbox_full_residual_not_certified` | any required original block residual exceeds tolerance | none |
| `k0_poisson_airbox_kittel_convergence_failed` | real-film mesh, padding, field-sweep or demag-physics gate fails | none |
| `k0_poisson_airbox_schur_certificate_missing` | explicit Schur request has no exact-signature certificate | strict: none; auto may choose a legal full engine before solve |
| `k0_poisson_airbox_schur_certificate_invalid` | certificate key or runtime quality check fails | strict: none; auto may choose a legal full engine before solve |
| `k0_poisson_airbox_physical_drive_rhs_invalid` | field-to-RHS conversion/provenance absent or inconsistent | none |
| `k0_poisson_airbox_driven_crosscheck_failed` | full, Schur, direct or qualified modal response comparisons disagree | none |
| `k0_poisson_airbox_gpu_persistent_context_unavailable` | required device allocation/action/context is absent | strict GPU: none |
| `k0_poisson_airbox_gpu_operator_parity_failed` | GPU block/action/Poisson result disagrees with CPU | none |
| `k0_poisson_airbox_gpu_shifted_solve_failed` | persistent shifted action/solve fails parity or contraction | none |
| `k0_poisson_airbox_gpu_device_krylov_unavailable` | scalable device modal/driven loop is absent | strict GPU: none |
| `k0_poisson_airbox_gpu_solver_parity_failed` | device Krylov modal/driven result disagrees with qualified CPU result | none |
| `k0_poisson_airbox_gpu_transfer_audit_failed` | per-iteration migration or host hot-loop state is observed | none |
| `k0_poisson_airbox_cpu_gpu_qualification_failed` | exact-scope physics, parity, residency, performance or memory gate fails | none |
| `k0_poisson_airbox_synthetic_assembly_not_production` | synthetic oracle attempts a production claim | none |

Native status is `validation_error` for malformed or contradictory inputs,
`unavailable` for a legal request whose engine is absent, `operator_error` for
assembly/action failures and `solve_error` for convergence or certification
failure. Failed and interrupted attempts retain requested/resolved provenance,
the primary token, supporting diagnostics and available partial artifacts.

## 11. Implementation sequence

Stages are ordered. A later stage may be developed behind a probe, but it may
not promote until all predecessor gates for its claimed scope pass.

### 11.1 CPU stages

| Stage | Owner paths | Inputs | Outputs | Required artifacts | Exact stage rejections | Promotion gate |
|---|---|---|---|---|---|---|
| K0-P1 manufactured scalar Poisson assembly | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.*`; `backends/fem/tests/frequency_domain/` | P1 shared mesh, scalar classes, BC tuple, beta | reduced `P`, Dirichlet map or `c/eta` layout | `manufactured_poisson.v1.json` | `k0_poisson_airbox_requires_shared_domain_mesh`; `k0_poisson_airbox_invalid_boundary_gauge_tuple`; `k0_poisson_airbox_scalar_manufactured_validation_failed` | Robin, Dirichlet and pure-Neumann manufactured solutions converge at P1 order; only Neumann has a gauge. |
| K0-P2 reciprocal magnetic/scalar coupling | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.*`; `backends/fem/cpu/mfem/` | K0-P1 output, `Ms`, tangent frames, magnetic classes | `C_phi_q`, `A_phiq`, field recovery and `A_qphi` | `validation/k0_poisson_airbox/reciprocity.v1.json` | `k0_poisson_airbox_reciprocity_check_failed` | Element/global adjoint-energy checks, sign-flip negative control and sphere/ellipsoid field-energy checks pass. |
| K0-P3 real full descriptor assembly | `backends/fem/cpu/frequency_domain/operators/`; `backends/fem/include/frequency_domain/` | accepted linearization, K0-P1/P2, `A_qq`, `B_qq`, scaling; no analytical reference | BC-correct sparse `A`, `B`, canonical maps/signatures; production request with analytical Kittel fields removed | `eigen/diagnostics/solver.v1.json#assembly` | `k0_poisson_airbox_unsupported_fe_order`; `k0_poisson_airbox_real_fem_assembly_unavailable`; `k0_poisson_airbox_descriptor_parity_failed` | Random-vector parity against independent element assembly and dense tiny full descriptor passes; changing Kittel metadata cannot change any block, target or signature. |
| K0-P4 CPU sparse-direct and SLEPc parity | `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.*`; `backends/fem/cpu/frequency_domain/slepc_modal_eigen.*`; `backends/fem/cpu/frequency_domain/engines/sparse_direct/` | K0-P3 descriptor, user-requested complex or rotated-real target/window, tiny admitted case; no expected frequency | direct baseline and selected finite physical mode classes | `validation/k0_poisson_airbox/interior_window.v1.json` | `k0_poisson_airbox_real_split_target_unavailable`; `k0_poisson_airbox_cpu_solver_parity_failed`; `k0_poisson_airbox_no_finite_modes` | Complex/real-split and direct/SLEPc frequency clusters, physical multiplicities and invariant subspaces agree; wrong-axis negative control fails; analytical Kittel data cannot affect selection or solver pass/fail. |
| K0-P5 residual and finite-mode certification | `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.*` | K0-P4 candidates, original unscaled blocks | accepted/rejected modes, reconstructed `phi/eta`, block errors | `eigen/diagnostics/solver.v1.json#residuals`; `eigen/spectrum.v2.json` | `k0_poisson_airbox_interior_window_incomplete`; `k0_poisson_airbox_full_residual_not_certified` | Every accepted mode passes finite classification, branch/window completeness and all original block tolerances. |
| K0-P6 real-film Kittel convergence | `examples/`; `scripts/verify_fem_frequency_domain_eigen_artifacts.py`; managed `justfile` gate | accepted real equilibria, at least three mesh levels, independent airbox-padding levels, field sweep | solved spectra and independent Kittel comparison | `kittel_convergence.v1.csv` plus equilibrium/mesh/airbox provenance | `k0_poisson_airbox_kittel_convergence_failed` plus any exact predecessor token | Mesh and padding convergence, field sweep, demag sign and managed-runtime evidence pass without analytical data entering the solver. |
| K0-P7 separate driven full-coupled/modal cross-check | `backends/fem/cpu/frequency_domain/engines/field_split/`; `backends/fem/cpu/frequency_domain/production_cpu_driven_response.*`; `backends/fem/cpu/frequency_domain/modal_response.*` | same K0-P3 blocks, physical drive, frequency sweep, qualified modal basis when used | full coupled, Schur and qualified reduced responses | `response/diagnostics/solver.v1.json`; `response/frequency-points/{frequency_index}.json` | `k0_poisson_airbox_physical_drive_rhs_invalid`; `k0_poisson_airbox_schur_certificate_invalid`; `k0_poisson_airbox_full_residual_not_certified`; `k0_poisson_airbox_driven_crosscheck_failed` | This separate driven-response promotion is not a prerequisite for modal K0 CPU/GPU promotion; its own claim requires full/Schur agreement, modal resonance with independently qualified modes, and original driven residuals at every point. |

The planned `operators/poisson_airbox_shared_domain.*` owner is a dedicated
frequency-domain subsystem. It may reuse static demag mesh, boundary and MFEM
utilities, but it must not add frequency-domain assembly or solver ownership to
`Context` or `mfem_bridge.cpp`.

### 11.2 GPU stages

| Stage | Owner paths | Inputs | Outputs | Required artifacts | Exact stage rejections | Promotion gate |
|---|---|---|---|---|---|---|
| K0-G1 GPU operator and Poisson parity | `backends/fem/gpu/cuda/frequency_domain/operators/`; `backends/fem/gpu/cuda/demag_poisson/`; GPU FD tests | K0-P3 blocks/signatures and CPU probe vectors | `gpu_descriptor_apply_probe`, Poisson and coupling action parity | GPU apply/Poisson section in `cpu_gpu_parity.v1.json` | `k0_poisson_airbox_gpu_persistent_context_unavailable`; `k0_poisson_airbox_reciprocity_check_failed`; `k0_poisson_airbox_gpu_operator_parity_failed` | Double-precision CPU/GPU action, scalar solve, BC/gauge and reconstructed field parity pass on identical assembled inputs. |
| K0-G2 persistent shifted solve | `backends/fem/gpu/cuda/frequency_domain/preconditioners/`; `backends/fem/gpu/cuda/frequency_domain/residency/`; PETSc/hypre adapters | K0-G1 context, rotated-real or complex shift, admitted memory | `gpu_persistent_operator_context`, `gpu_shifted_apply_probe`, contraction/transfer telemetry | `validation/k0_poisson_airbox/gpu_transfer_audit.v1.json` | `k0_poisson_airbox_gpu_persistent_context_unavailable`; `k0_poisson_airbox_gpu_shifted_solve_failed`; `k0_poisson_airbox_gpu_transfer_audit_failed` | Repeated shifted applies/solves reuse allocations, match CPU and show zero per-iteration migration. |
| K0-G3 GPU modal/driven Krylov | `backends/fem/gpu/cuda/frequency_domain/engines/`; `backends/fem/gpu/cuda/frequency_domain/modal/`; `backends/fem/include/frequency_domain/gpu_device_krylov.hpp` | K0-G2 context, selected modal or driven request | `gpu_modal_device_krylov` and `gpu_device_krylov` results | `eigen/diagnostics/solver.v1.json`; `response/diagnostics/solver.v1.json`; GPU transfer audit | `k0_poisson_airbox_gpu_device_krylov_unavailable`; `k0_poisson_airbox_gpu_solver_parity_failed`; `k0_poisson_airbox_interior_window_incomplete`; `k0_poisson_airbox_full_residual_not_certified` | PETSc/SLEPc device hot loops converge, restart correctly, reconstruct full fields and pass original residuals without host hot-loop state. |
| K0-G4 CPU/GPU production qualification | `backends/fem/tests/frequency_domain/`; `scripts/`; managed `justfile` gates | exact CPU/GPU problem bundles over qualified size/field/mesh/padding sets | bounded capability evidence and performance/memory envelope | `cpu_gpu_parity.v1.json`, Kittel convergence, response parity, transfer audit | `k0_poisson_airbox_cpu_gpu_qualification_failed` plus any exact predecessor token | Exact scoped CPU/GPU parity, physics convergence, residency, strict intent, managed runtime and performance gates pass; only that `validated_scope` may be promoted. |

## 12. Definition of done

The K0 modal production scope is implemented for an exact CPU or GPU scope
only when all of the following modal requirements are true:

1. A physical request consumes an accepted equilibrium, shared-domain P1 mesh,
   complete K0 magnetic/scalar certificate and valid BC/gauge tuple.
2. Backend-owned MFEM assembly emits `mfem_weak_form_shared_domain` blocks with
   canonical ordering, units, scaling, signatures and reciprocal-coupling
   evidence. No synthetic or analytical builder participates.
3. Modal full and certified Schur paths represent `sigma=i*omega_target`
   correctly for the PETSc scalar build, detect the wrong-axis negative control,
   select finite positive-window modes and reconstruct the full descriptor.
4. A driven-response claim, if made, separately completes K0-P7: its full
   field-split and certified Schur paths consume the physical drive conversion,
   reuse the same blocks, and pass full/block residuals at every accepted
   frequency. K0-P7 is not required for modal promotion.
5. `eps_full=max(eps_q,eps_phi,eps_gauge)` from the original unscaled operator
   is within tolerance; backend, transformed and preconditioned residuals remain
   separate diagnostics.
6. Real-film mesh and airbox-padding convergence, field-swept Kittel comparison,
   demag sign/energy and modal-driven cross-checks pass through independent
   verifiers. Expected values are never solver inputs.
7. A GPU promotion uses `gpu_modal_device_krylov` or `gpu_device_krylov`, owns a
   persistent device context, passes CPU parity and records zero per-iteration
   migration. Dense and apply probes remain probe-labelled.
8. Strict requested intent never falls back silently; every rejection uses an
   exact token and preserves partial diagnostics.
9. Artifacts expose requested/resolved execution, implementation and validation
   axes, bounded `validated_scope`, all signatures, BC/gauge, scalar/target,
   residual and residency evidence.
10. Authoritative runtime proof uses the repository's container-backed managed
    `just` gates. Host-only or source-only evidence cannot promote capability.

Until these conditions pass, current capability rows remain bounded by their
existing exact evidence and the target stage remains unimplemented or
unqualified as appropriate.

### 12.1 Production-scope documentation assertions

The following assertions are normative documentation gates. They deliberately
do not claim that the feature is qualified today; they define the complete
evidence set that the final production record must bind for each exact CPU or
GPU scope:

1. CPU stages `K0-P1` through `K0-P6` and GPU stages `K0-G1` through `K0-G4`
   have passed with their required artifacts and exact rejection controls.
2. The managed `libpetsc-real-dev`/`libslepc-real-dev` runtime records
   `spectral_scalar_mode=real_split`,
   `spectral_pencil_kind=real_frequency_rotated`, `sigma=i*omega_target`, and
   `tau=omega_target`; a real target on the original `lambda=i omega` pencil
   is a required wrong-axis negative control.
3. `Spectrum` publishes bounded selected-window metadata, physical
   J-equivalence classes, counts, branch completeness, residuals, stop reason,
   requested/resolved execution, and the exact validation-scope identity.
4. Native `q` and reconstructed `phi` are published as revisioned Cartesian
   mode fields on the binary data plane, with mesh/topology identity, units,
   representation, mode identity, and validation sidecars. Fabricated or
   runner-synthesized mode vectors cannot satisfy this assertion.
5. The unified viewport proves selected-mode real, imaginary, magnitude, and
   phase-rotated rendering through a visible, non-lost WebGL canvas with a
   nonzero drawing buffer, a selected-mode visual difference, a phase-change
   visual difference, and bounded memory across repeated mode switches.
6. `frequency_domain_production_dod.v1` binds immutable passing evidence for
   `DOD-01` through `DOD-14` for the exact CPU or GPU scope. A partial,
   stale, hidden-fallback, or scope-mismatched record cannot promote a
   capability.

## 13. Revalidation after the master branch update (2026-08-01)

This chapter was rechecked only after the eigensolve branch was merged with
the current master. The branch is now based on `origin/master` (`25 0` ahead/
behind), with merge commit
`d5f63b35a4f4a57798089915b312c4695caea917` and master
`eee245ac200bf138d880b793791848106b7386ba`. No implementation claim below is
changed by that merge.

### 13.1 Current CPU implementation evidence

`crates/fullmag-runner/src/fem_eigen.rs::build_pa_e4b_k0_kittel_poisson_airbox_payload`
still derives `expected_reference_frequency_hz` from the Kittel expression,
assigns it to `target_frequency_hz`, constructs dense matrices and labels the
payload `synthetic_algebraic_oracle`. This is the exact contamination that
K0-P3/K0-P4 must remove. The payload also hard-codes the v6 schema string
without transporting a certificate identity or digest.

`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp::validate_problem`
still rejects every assembly kind except `synthetic_algebraic_oracle` and
rejects Robin/Dirichlet modal solves. Its SLEPc setup
(`solve_poisson_airbox_modal_eigen_cpu_slepc`) still applies a real
`EPSSetTarget(target_omega)` to the original lambda pencil, selects one mode,
and uses `expected_reference_frequency_hz` in solver acceptance. The current
native result ABI
(`backends/fem/include/frequency_domain/modal_eigen_result.hpp::FrequencyDomainContractResult`)
does not carry a multi-mode q/phi result collection. These are open production
gates, not documentation-only gaps.

### 13.2 Current GPU implementation evidence

The CUDA source contains bounded dense/action probes and explicit diagnostics,
but not a persistent selected-spectrum modal engine. In particular,
`fullmag_fem_frequency_domain_apply_modal_shift_invert_gpu_action` reports
zero per-action transfers while also reporting
`gpu_device_resident_modal_eigensolver=false`; that is compatible with a
one-shot action and does not establish a device-resident Arnoldi/Krylov loop.
`gpu_device_krylov.hpp::validate_fgmres_device_engine` continues to report
`production_loop_available=false`.

### 13.3 Product-chain boundary

The Python/IR authoring and negative-validation paths, the v2 spectrum/branch
resources, and the mode-field metadata/preview UI are present as reference or
artifact-backed surfaces. They do not make a physical K0 result available:
the current capability snapshot still marks production CPU/GPU modal solving
unsupported, and the inspector explicitly reports 3D plotting as waiting for
mode-field artifacts. Production mode fields must be native q and reconstructed
phi vectors from the accepted solve; the runner test
`native_poisson_airbox_result_without_modes_maps_to_uniform_k0_mode` documents
the fallback that K0-P5 must remove.

### 13.4 Verification boundary

The managed runtime bundle was rebuilt and identity-validated for the merge
commit. The aggregate native-contract recipe was attempted but failed before
build because a fresh worktree had no `native/build` directory. The explicit
K0 CPU SLEPc recipe configured PETSc/SLEPc and built the contract binary, but
the small SLEPc fixture produced no result after approximately 19 minutes and
was terminated with exit code 130. This is a timeout/non-convergence boundary,
not a passing contract.
Neither event changes the readiness matrix or qualifies a CPU/GPU production
cell. The authoritative completion gates remain K0-P1 through K0-P6,
K0-G1 through K0-G4, and DOD-01 through DOD-14.
<!-- END 18_poisson_airbox_eigensolve_cpu_gpu_implementation.md -->

<!-- BEGIN 19_eigensolve_frequency_driven_physics_numerics_audit.md -->
---
title: Frequency-domain physics and numerics audit register
date: 2026-08-01
status: implementation_status
runtime_revalidated_in_this_update: false
source_revision_basis: static code and existing repository evidence
---

# Physics and numerics audit register

This file replaces the previous narrative audit with a current finding
register. The source-level findings remain current after the master update.
The dated revalidation below records the limited build/runtime evidence from
this update; it does not promote any readiness cell.

Required state fields:

```text
documentation_state = open | resolved_in_docs
code_state = open | source_visible | implemented
verification_state = not_run | runtime_verified
```

`implemented` means the inspected source currently contains the corrective
guard, label or behavior for the finding. It does not imply production
qualification. `source_visible` means source or target labels are visible but
the production artifact path has not emitted the integrated behavior. It is
still open for production promotion. `runtime_verified` is used only for
previously existing runtime evidence and is not used for this update unless a
runtime was actually rerun, which it was not.

## Capability matrix integration

`docs/specs/capability-matrix-v0.md` and `.json` are consumed without editing.
Parallel dynamic-solver remediation owns:

- correcting any stale heading or downstream copy that calls the seven
  product-facing statuses a "four-state status vocabulary";
- adding links from capability-matrix rows to
  `25_frequency_domain_readiness_matrix.json`;
- preserving the distinction between product-facing availability and the
  independent axes `implementation_state`, `validation_state` and
  `validated_scope`;
- explaining broad booleans such as `supports_frequency_response=false` as
  coarse family gates that may coexist with narrow executable readiness cells
  exposed through `frequency_domain_capabilities.v1`.

This task intentionally does not edit the capability matrix to avoid
overwriting parallel work.

## Finding register

| ID | Severity | Affected scope | Finding | Required disposition | Documentation state | Code state | Verification state | Evidence paths |
|---|---|---|---|---|---|---|---|---|
| F-01 | BLOCKER | K0-3 CPU Poisson-airbox modal, Kittel demag, GPU promotion | PA-E4b/topology-shaped Kittel payload is not real shared-domain FEM Poisson-airbox assembly. | Keep synthetic/topology-shaped payload as algebra evidence only; require `production_periodic_airbox_claim=false`; build separate `mfem_weak_form_shared_domain` assembly with Kittel answer removed from operator inputs. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`; `crates/fullmag-runner/src/fem_eigen.rs`; `25_frequency_domain_readiness_matrix.json` |
| F-02 | BLOCKER | K0 Poisson-airbox modal BC/gauge | Mean-zero gauge is invalid for Robin/Dirichlet coercive scalar blocks. | Enforce boundary/gauge tuple: Robin/Dirichlet use `gauge_policy=none`; pure Neumann uses mean-zero; keep unsupported combinations fail-closed until implemented. | resolved_in_docs | implemented | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-03 | BLOCKER | CPU SLEPc modal selected spectrum | `spectral_transform.cpp` converts the requested Hz target to a positive real `omega`; `slepc_modal_eigen.cpp` and `poisson_airbox_modal_eigen.cpp` then use `EPS_TARGET_MAGNITUDE` with that real target. This is not the canonical `sigma=i*omega` transform or a proven real-split equivalent. | Implement one explicit target realization: complex PETSc, real-split transformed pencil, or a rigorously derived real Hamiltonian/gyrotropic pencil; artifact must publish sigma components and scalar mode. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/spectral_transform.cpp`; `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-04 | BLOCKER | Modal descriptor residual certification | Full residual certification previously could hide bad reconstruction by taking the smaller SLEPc residual. | Certify only the reconstructed blockwise original-unscaled descriptor residual; publish SLEPc, scaled and transformed residuals separately as diagnostics; use `eps_full_original_unscaled=max(eps_q,eps_phi,eps_gauge)`. | resolved_in_docs | implemented | not_run | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`; `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md` |
| F-05 | BLOCKER | K0-3 Kittel geometry | The K0-3 validation fixture must be x/y periodic and open-z; a one-axis PBC strip is not the ideal film oracle. | Require x/y periodic magnetic and airbox pair metadata or relabel the fixture as a finite strip with a different independent oracle. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `examples/fem_eigen_k0_kittel_periodic_airbox.py`; `docs/plans/active/fd_sovler_masterplan/24_production_definition_of_done.md` |
| F-06 | HIGH | K0-3 convergence and production validation | The old convergence gate did not require real mesh/airbox convergence. | Enforce at least three mesh levels and at least three airbox-padding levels with independent oracle, branch tracking, raw rows and separate budgets. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md`; `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py` |
| F-07 | HIGH | Kittel verifier and mode-quality artifacts | The verifier must enforce mode-quality thresholds, not only metric presence. | Enforce residual, uniformity, overlap, tangent leakage, seam mismatch and equilibrium thresholds from the validation metadata. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md`; `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `scripts/verify_fem_frequency_domain_eigen_artifacts.py` |
| F-08 | HIGH | Equilibrium handoff for modal/driven sweeps | Native `EquilibriumArtifactDescriptor -> LinearizationStateNative` validation exists, including static-demag availability, but planner and runner do not materialize or consume the state; modal execution still passes equilibrium arrays independently. Relaxation step count is not evidence. | Connect accepted `EquilibriumArtifact -> LinearizationState` with mesh/material/physics hashes, torque residual, static demag and bias-field identity into every modal/driven sample, or require an explicit analytic proof. | resolved_in_docs | source_visible | not_run | `docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md`; `docs/plans/active/fd_sovler_masterplan/16_end_to_end_fem_frequency_domain_implementation.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/include/frequency_domain/linearization_state.hpp`; `backends/fem/src/frequency_domain/linearization_state.cpp` |
| F-09 | HIGH | Demag block signs, reciprocity and energy | Nonzero coupling blocks alone do not prove the demag operator's weak-form reciprocity or energy sign. | Add directional-derivative, Hessian reciprocity and energy-sign gates independent of Kittel. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`; `docs/plans/active/fd_sovler_masterplan/09_validation_certification_benchmarks.md` |
| F-10 | HIGH | Singular descriptor modal pencil | Singular `B` needs finite-mode policy, algebraic-mode rejection and full descriptor reconstruction. | Prefer certified Schur-reduced magnetic pencil; if monolithic descriptor remains, publish finite-mode filters, regularity, `q^H B q` and algebraic-mode rejection. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-11 | HIGH | Kittel demag oracle and `M_eff` | One scalar `M_eff` is not a general Kittel oracle and must not leak into operator construction. | Keep `H1`, `H2`, `N0`, `N1`, `N2` or fitted stiffnesses as verifier-only outputs; remove expected Kittel values from builder, targeting, selection and solver pass/fail. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`; `crates/fullmag-runner/src/fem_eigen.rs`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-12 | HIGH | Status governance and capability labels | Historical status text mixed normative contract, implementation evidence, runtime capability and validated production status. | Use `25_frequency_domain_readiness_matrix.json` as the current active status source and let parallel remediation link capability rows to it. | resolved_in_docs | implemented | not_run | `docs/plans/active/fd_sovler_masterplan/10_patch_queue_current_status.md`; `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`; `docs/specs/capability-matrix-v0.md` |
| F-13 | HIGH | Driven response absorbed-power sign | The emitted `absorbed_power_density` is explicitly a `drive_projected_absorption_proxy` with `physical_power_density=false`, not `absorbed_by_magnetization`. Its units and sign cannot certify the physical power law under `exp(+i*omega*t)`. | Add a separate physical observable `absorbed_by_magnetization` using `p_abs = -0.5*mu0*Ms*omega*Im(conj(h_drive) dot delta_m)` and damped-macrospin sign checks. Preserve the proxy under its existing explicit provenance. | resolved_in_docs | source_visible | not_run | `docs/physics/0700-frequency-domain-linearized-llg.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/plans/active/fd_sovler_masterplan/02_physics_contract.md`; `backends/fem/src/frequency_domain/driven_response_solver.cpp` |
| F-14 | HIGH | Modal/driven sign dictionary | Modal, driven and real-split paths need one operator dictionary for `L`, `B_alpha`, `A_omega`, `lambda`, `omega` and `b`. | Keep 0831 as the single dictionary; production code must use one canonical dynamic pencil and prove fused/apply parity before promotion. | resolved_in_docs | source_visible | not_run | `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/physics/0700-frequency-domain-linearized-llg.md`; `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`; `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp`; `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md` |
| F-15 | HIGH | Static and dynamic demag consistency | Static demag in `h_eff0` and dynamic demag derivative must share mesh/material/BC/operator provenance. | Require common operator/equilibrium digest; invalidate Schur certificates and artifacts when any static/dynamic demag input changes. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `docs/specs/frequency-domain-artifacts-v2.md` |
| F-16 | HIGH | Nonzero-k dynamic demag | Nonzero-k dynamic demag must remain hard blocked until complex Bloch `grad_k/div_k` assembly exists. | Reject `k!=0 && include_demag` without `floquet_airbox` dynamic-demag-k operator; no fallback to K0, no-demag projection, open boundary, dense validation or CPU for strict GPU. | resolved_in_docs | implemented | not_run | `docs/physics/0828-fem-frequency-domain-floquet-demag.md`; `docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`; `backends/fem/src/frequency_domain/driven_response_solver.cpp`; `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` |
| F-17 | MEDIUM_HIGH | Driven residuals and preconditioners | Driven response needs reconstructed original-unscaled block/full residuals and preconditioner quality, not only tracked GMRES residual; the target acceptance lane is not yet claimed as emitted. | Publish tracked residuals only as diagnostics; accept only `driven_original_unscaled_full_relative_residual` and original-unscaled block residuals against the original operator; publish Schur contraction ratio and threshold when defined, otherwise `null` plus `not_applicable`/`not_available`; keep the target lane open until artifacts emit the full contract under root `runtime_telemetry`. | resolved_in_docs | source_visible | not_run | `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md`; `.fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts/response/diagnostics/solver.v1.json`; `backends/fem/src/frequency_domain/driven_response_solver.cpp` |
| F-18 | MEDIUM | Gauge weights | Gauge weights must match the active scalar FE space and BC; strict positivity everywhere is not generally correct. | Use no gauge for Robin/Dirichlet; for pure Neumann assemble a valid mean functional over active scalar DOFs, allowing inactive/eliminated DOFs to be absent. | resolved_in_docs | open | not_run | `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`; `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`; `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| F-19 | MEDIUM_HIGH | Periodic tangent transport | `mesh_symmetry_certificate.cpp` computes and stores pairwise `T_dst^T T_src` blocks, but no single canonical constraint consumes them consistently in assembly, RHS projection, output lift and residual reconstruction; gauge-rotation/nonuniform-frame tests are also absent. | Add arbitrary tangent-basis rotation invariance, nonuniform texture projection and periodic seam transfer tests, then use one phase-plus-frame constraint in every Floquet consumer before broad promotion. | resolved_in_docs | source_visible | not_run | `docs/physics/0828-fem-frequency-domain-floquet-demag.md`; `docs/plans/active/fd_sovler_masterplan/23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md`; `backends/fem/include/frequency_domain/mesh_symmetry_certificate.hpp`; `backends/fem/src/frequency_domain/mesh_symmetry_certificate.cpp` |
| F-20 | BLOCKER | GPU modal production claims | GPU macrospin dense proof is not a scalable eigensolver. | Keep the current `gpu_dense_k0_macrospin_modal_eigen` lane scoped to the double-precision no-demag macrospin cell; do not publish broad `gpu_device_resident_modal_eigensolver=true` from one-shot dense paths. | resolved_in_docs | implemented | not_run | `docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md`; `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`; `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/diagnostics/solver.v1.json` |
| F-21 | MEDIUM | GPU descriptor apply residency | One-shot GPU descriptor apply allocates/transfers per call and is not a persistent device context. The current device-Krylov transfer diagnostics expose counts but not the Chapter 11 byte/allocation/workspace-reuse telemetry, so zero transfer counts alone cannot certify persistence. | Build persistent modal context before using GPU apply inside Arnoldi/Krylov; bind `hot_loop_h2d_bytes`, `hot_loop_d2h_bytes`, host/device allocated bytes, allocation count and workspace reuse/rebuild counters into the engine result. Production requires all hot-loop transfer/allocation counters and rebuild count to be zero. | resolved_in_docs | open | not_run | `docs/plans/active/fd_sovler_masterplan/11_runtime_telemetry_performance.md`; `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`; `backends/fem/include/frequency_domain/gpu_device_krylov.hpp` |
| F-22 | MEDIUM | GPU callback/readiness levels | GPU operator callbacks, shifted apply probes, the current dense macrospin eigensolve and the target dense-contract eigensolver are different readiness levels and must not be collapsed. | Keep labels separate: current emitted GPU modal validation lane `gpu_dense_k0_macrospin_modal_eigen`; target/source-visible `gpu_dense_contract_eigensolver` until migration; `gpu_operator_host_krylov`; `gpu_device_krylov`; `gpu_modal_device_krylov`. Do not call the target dense-contract label emitted until artifacts publish it. | resolved_in_docs | source_visible | not_run | `docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md`; `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`; `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`; `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/diagnostics/solver.v1.json` |

## Remediation ownership

The active implementation owner is
`docs/superpowers/plans/2026-07-10-fem-dynamic-solver-remediation.md`. The
following mapping prevents source-visible work from being mistaken for closure:

| Findings | Required remediation tasks | Promotion condition |
|---|---|---|
| F-01, F-05, F-06, F-07, F-09, F-11, F-18 | 10, 17, 18, 22 | Real shared-domain P1 assembly, Kittel-independent solve input, three-level mesh and airbox evidence, and postsolve-only Kittel verification. |
| F-02, F-04, F-10 | 16, 17 | Correct selected-spectrum transform, finite Schur pencil, BC/gauge-correct reconstruction and original residual certification. |
| F-03 | 3, 16 | Typed `sigma=i omega` transform reaches every SLEPc adapter and is emitted in artifacts. |
| F-08, F-15 | 10, 11, 12 | Accepted equilibrium plus common static/dynamic operator provenance and invalidation digest. |
| F-13, F-14, F-17 | 4, 11, 13, 14, 22 | One canonical pencil, physical-power provenance, original residuals, and parity evidence; `source_visible` is not sufficient. |
| F-16, F-19 | 9, 11 | One Floquet phase-plus-frame constraint, full FE topology certificate, and physical nonzero-k dynamic demag before promotion. |
| F-20, F-21, F-22 | 15, 19, 20, 22 | Truthful bounded GPU labels followed by persistent device-resident FGMRES and fresh transfer/residual evidence. |
| F-12 | 1, 22, 23 | Readiness/capability/API claims are generated only from fresh bounded evidence. |

## Current production boundary

The current production boundary is intentionally narrow:

- `modal_eigen/gpu/k0/none` is physics-validated only for the K0-1 no-demag
  macrospin/Larmor field sweep.
- `modal_eigen/cpu/k0/periodic_airbox_k0` has algebra and source evidence but
  not real shared-domain Poisson-airbox production qualification.
- `modal_eigen/gpu/k0/periodic_airbox_k0` retains the target
  `gpu_dense_contract_eigensolver` as source-visible/unvalidated until
  migration; the current emitted GPU modal validation lane is only
  `gpu_dense_k0_macrospin_modal_eigen` for the no-demag macrospin cell.
- `modal_eigen/*/nonzero_k/floquet_airbox_nonzero_k` remains blocked by
  missing dynamic demag-k.
- `driven_response` CPU/GPU periodic-airbox slices are executable in bounded
  Schur/provider lanes, but not production qualified and not modal proof.
- `gpu_device_krylov` and `gpu_modal_device_krylov` remain unvalidated until a
  full device loop and transfer audit exist.

Any future status change must update the JSON readiness matrix first, then
project the new truth into this register and the capability matrix under the
parallel owner.

## Revalidation boundary after master update (2026-08-01)

The branch update was completed before the audit: merge commit
`d5f63b35a4f4a57798089915b312c4695caea917` contains
`origin/master=eee245ac200bf138d880b793791848106b7386ba`, with
`HEAD...origin/master = 25 0`. Focused Python, IR/planner, runner, and UI
tests passed before the managed native run; these tests cover authoring and
contracts, not physical K0 demag qualification.

The managed FEM runtime was rebuilt and its exact commit/source identity was
validated. The container had no NVIDIA driver, so this update has no executed
GPU-device evidence. The aggregate native-contract recipe failed before
compilation because `native/build` was absent in the fresh worktree. The
explicit K0 CPU SLEPc recipe configured PETSc/SLEPc and built the target
binary, but its small SLEPc fixture produced no result after approximately 19
minutes and was terminated with exit code 130.

Accordingly all finding rows whose `verification_state` is `not_run` remain
`not_run`, and the readiness matrix remains the authority. Build identity is
not runtime solver proof; source-visible artifacts are not production
qualification; and GPU compilation without an executed device is not GPU
validation.
<!-- END 19_eigensolve_frequency_driven_physics_numerics_audit.md -->

<!-- BEGIN 20_dynamic_solver_audit_revalidation_and_remediation.md -->
---
title: Rewalidacja audytu i instrukcja napraw solvera dynamicznego FEM
date: 2026-07-10
status: revalidated_blockers_found
scope:
  - FEM frequency-domain modal eigen
  - FEM frequency-driven CPU and GPU
  - modal basis and modal-reduced response
  - Poisson-airbox, Floquet and tangent-space contracts
  - native C ABI and buffer safety
excluded:
  - FDM
  - nonlinear time-domain LLG
source_revision: ec9e68893a9932de4bbea940ff608356402d9cc5
implementation_changes: none
---

# Rewalidacja audytu solvera dynamicznego FEM i kompletna instrukcja napraw

## 1. Odpowiedź krótka

Zgadzam się z głównym wnioskiem audytu: obecny zestaw lane'ów modalnych,
modal-reduced, Poisson-airbox i przyszłego device-resident FGMRES nie daje
jeszcze podstaw do bezwarunkowego certyfikowania wszystkich wyników
dynamicznych jako produkcyjnych.

Nie zgadzam się jednak z audytem bez zastrzeżeń. Audyt był wykonany na
ograniczonym pakiecie 19 nagłówków. Bieżące repozytorium zawiera realne
implementacje `.cpp` i `.cu`, a część podanych ocen miesza trzy różne rzeczy:

1. potwierdzony błąd wykonywanej ścieżki produkcyjnej,
2. potwierdzony błąd niepodłączonego kontraktu, który jest blockerem przed
   przyszłą promocją,
3. ograniczenie starego zestawu wejściowego albo tezę już nieaktualną w
   bieżącym kodzie.

Wszystkie sześć konkretnych reprodukcji z audytu nadal występuje na podanej
rewizji:

```text
negative_certificate_allowed=1
cache_collision=1
overflowed_basis_extent_allowed=1
one_iteration_config_certified_by_256_iteration_claim=1
callback_received_infinite_omega=1
infinite_omega_probe_accepted=1
```

Ich ekspozycja jest jednak różna:

- defekty `modal_basis.hpp` są obecnie niepodłączonymi blockerami promocji
  `modal_reduced`, a nie udowodnioną korupcją aktualnego artefaktu produkcyjnego;
- defekty `gpu_device_krylov.hpp` dotyczą przyszłego device-resident FGMRES;
  bieżący `production_gpu` wykonuje hostowy GMRES z callbackami operatora CUDA;
- publiczny C ABI, błędne targetowanie SLEPc, zerowy RHS w hostowym GMRES,
  ukryte zależności stanu linearyzacji i brak pełnego kontraktu Floquet dla
  tekstur są problemami aktualnego kodu, a nie wyłącznie szkieletem;
- GPU-G5a jest tiny dense validation kernel, ale publikuje zbyt szeroki
  `gpu_device_resident_modal_eigensolver=true`; wymaga natychmiastowej korekty
  statusu niezależnie od późniejszego skalowalnego eigensolvera.

## 2. Zakres i znaczenie statusów

Ten dokument obejmuje wyłącznie FEM. FDM jest poza zakresem. Nie zmienia on
implementacji solvera; jest wykonywalnym planem napraw z przypisaniem plików,
testów i warunków odbioru.

Statusy użyte w ledgerze:

| Status | Znaczenie |
|---|---|
| **potwierdzone — aktywne** | błąd może dotknąć obecnie wykonywanej ścieżki lub publicznego ABI |
| **potwierdzone — dormant** | błąd istnieje, ale dotyczy niepodłączonego helpera/lane'u; jest blockerem promocji |
| **częściowo potwierdzone** | rdzeń tezy jest trafny, lecz bieżący kod ma już część wymaganych zabezpieczeń |
| **nieaktualne / obalone** | teza nie opisuje bieżącego repozytorium |
| **niewykonane runtime** | analiza źródła jest rozstrzygająca, lecz bieżący managed gate zablokował inny dirty workstream |

Priorytety:

- **P0** — blokuje publiczne bezpieczeństwo ABI albo promocję naukową lane'u;
- **P1** — konieczne utwardzenie przed pełną kwalifikacją;
- **P2** — porządek kontraktu, diagnostyki lub utrzymania bez bieżącego ryzyka
  błędnego wyniku.

## 3. Dowody użyte w rewalidacji

Sprawdzono bieżące nagłówki, implementacje CPU/CUDA, testy i routing, w tym:

- `backends/fem/include/frequency_domain/modal_basis.hpp`;
- `backends/fem/include/frequency_domain/gpu_device_krylov.hpp`;
- `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`;
- `backends/fem/src/frequency_domain/driven_response_solver.cpp`;
- `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp`;
- `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`;
- `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`;
- `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`;
- `backends/fem/src/frequency_domain/linearization_state.cpp`;
- `backends/fem/src/frequency_domain/mesh_symmetry_certificate.cpp`;
- `native/include/fullmag_fem.h` i `backends/fem/src/api.cpp`;
- kanoniczne noty fizyczne i poprzedni audyt
  `19_eigensolve_frequency_driven_physics_numerics_audit.md`.

Reproducer skompilowano jako C++20 z ostrzeżeniami i uruchomiono na aktualnych
nagłówkach. Repozytoryjna bramka
`just verify-fem-frequency-domain-native-contract` została uruchomiona zgodnie
z regułą managed/container-first, lecz nie dotarła do testów frequency-domain.
Odbudowę zatrzymały niezależne, istniejące zmiany w GPU relaxation:
`nonlinear_cg.cpp` przekazuje `uint8_t *magnetic_node_mask` do nowego argumentu
`const double *lumped_mass`. Tego obcego workstreamu nie naprawiano w ramach
niniejszego audytu.

## 4. Ledger wszystkich tez z dostarczonego audytu

| ID | Teza | Werdykt na bieżącym kodzie | Priorytet i ekspozycja |
|---|---|---|---|
| A-01 | ujemny lub niespójny certyfikat bazy modalnej jest akceptowany | **potwierdzone — dormant** | P0 przed promocją `modal_reduced` |
| A-02 | klucz cache bazy modalnej ma kolizje delimiter-injection | **potwierdzone — dormant** | P0 przed użyciem cache |
| A-03 | `expected_vector_size * vector_count` może się zawinąć | **potwierdzone — dormant** | P0 przed device FGMRES; należy też przeaudytować aktywne extenty |
| A-04 | konfiguracja GPU wymaga i przyjmuje wyniki przyszłego/starego solve | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-05 | `max_iterations=1` może użyć deklaracji testu 256 iteracji | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-06 | `omega=+inf` przechodzi probe; brak powiązania z omega diagnostyki | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-07 | reguła residualu 64/256 odrzuca early convergence i zero | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-08 | nie ma jednego kanonicznego równania dynamicznego | **częściowo potwierdzone** | P0 architektury; noty i wspólne `apply` już istnieją, brak jednego typu |
| A-09 | definicja `gamma`, `gamma0`, `mu0`, Hz/rad/s jest niejednoznaczna | **częściowo potwierdzone** | P0 API; dokumentacja rozstrzyga, nagłówki nadal dublują semantykę |
| A-10 | brak centralnego mapowania lambda na częstotliwość i zanik | **potwierdzone — aktywne** | P0 testów znaku i obu fazorów |
| A-11 | count modów w oknie nie certyfikuje odpowiedzi wymuszonej | **potwierdzone — dormant** | P0 przed `modal_reduced` |
| A-12 | tłumiona/nonnormalna diagonalna ekspansja eigenmodalna wymaga lewych i prawych modów | **potwierdzone — dormant** | P0 przed tym wariantem ROM; nie dotyczy każdego rational/reduced-basis engine |
| A-13 | certyfikat countu nie przechowuje dowodu metody ani provenance | **potwierdzone — dormant** | P0 przed użyciem certyfikatu |
| A-14 | descriptor pencil Poisson-airbox wymaga eliminacji/deflacji algebraicznej | **potwierdzone — validation-only** | P0 przed produkcyjnym Poisson modal; realne assembly jest fail-closed |
| A-15 | device FGMRES nie ma pełnej pętli | **potwierdzone — dormant** | P0 promocji; `production_loop_available=false` |
| A-16 | baza Arnoldiego zawsze musi mieć osobne `m+1` slotów | **częściowo potwierdzone** | P1; `V(m)+work` może być poprawne, lecz kontrakt tego nie opisuje |
| A-17 | probe nadpisuje bufor `solution` | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-18 | probe nie sprawdza wyniku, aliasingu ani async errors | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-19 | zdublowana konwencja fazowa może się różnić | **częściowo naprawione** | P1; pola są zdublowane, ale driven validator odrzuca mismatch |
| A-20 | zdublowane rodzaje wzbudzenia nie mają jednej kanonizacji | **potwierdzone — aktywne** | P1/P0 przy rozszerzaniu drive'ów |
| A-21 | dwa wektory Floqueta mogą się różnić | **potwierdzone — aktywne** | P0 dla modal/Floquet; driven ma tylko część kontroli |
| A-22 | kilka wariantów problemu może być aktywnych jednocześnie | **potwierdzone — aktywne** | P0 routingu; obecnie działa precedencja zamiast exact-one |
| A-23 | orientacja ramki stycznej nie jest określona | **częściowo potwierdzone** | P1; implementacja buduje prawoskrętną ramkę, API tego nie gwarantuje |
| A-24 | scalar edge block nie przenosi ogólnej ramki | **częściowo potwierdzone** | P1; overload z ramkami robi `E_i^T E_j`, overload bez ramek jest ryzykowny |
| A-25 | DMI jest błędnie reprezentowane przez scalar edge block | **nieaktualne dla bieżącej ścieżki** | DMI ma osobny operator elementowy; nie należy go kierować przez edge scalar |
| A-26 | Floquet potrzebuje transportu `E_b^T E_a`, nie tylko fazy | **potwierdzone — aktywne** | P0 dla niejednorodnego `m0` |
| A-27 | faza powinna wynikać z `k dot T` | **częściowo naprawione** | driven sprawdza `phase=-k dot T`; modal nadal wymaga wspólnej kanonizacji |
| A-28 | `MeshSymmetryCertificate` nie certyfikuje topologii FEM | **potwierdzone — aktywne** | P0 przed produkcyjnym periodic FEM |
| A-29 | `max_airbox_phi_pair_mismatch` nie ma danych phi | **potwierdzone — aktywne** | P1; pole zawiera dziś residual geometrii pod błędną nazwą |
| A-30 | dense oracle deklaruje alpha=0 i k=0 bez danych do kontroli | **potwierdzone — validation-only** | P1 |
| A-31 | dense matrix views nie mają długości/stride | **potwierdzone — aktywne** | P0 dla granicy niezaufanych buforów |
| A-32 | `struct_size==0` i exact `sizeof` nie dają bezpiecznej ewolucji ABI | **potwierdzone — aktywne** | P0 publicznego C ABI |
| A-33 | `struct_size` ma niespójne typy | **potwierdzone** | P1; symptom braku wspólnej polityki ABI |
| A-34 | STL typy przechodzą obecnie bezpośrednio przez C ABI | **obalone** | `std::string/vector` są wewnętrzne; C wynik używa owned `char *` |
| A-35 | `noexcept` z alokacjami może zakończyć proces | **potwierdzone — aktywne** | P0 niezawodności biblioteki |
| A-36 | CSR nie ma długości buforów | **nieaktualne** | długości już istnieją; nadal brakuje pełnej polityki canonical CSR |
| A-37 | stan linearyzacji ma ukryte/ignorowane zależności | **potwierdzone — aktywne** | P0 reprodukowalności |
| A-38 | nie dostarczono implementacji `.cpp/.cu` solverów | **prawda tylko dla audytowanego pakietu, fałsz dla repo** | bieżące repo ma CPU GMRES, SLEPc, CUDA operator i testy |
| A-39 | cały obecny GPU driven solver jest jedynie probe | **obalone** | realny host GMRES + CUDA operator; nie jest device-resident |
| A-40 | realny shift SLEPc poprawnie targetuje `lambda=i omega` | **obalone** | P0: co najmniej trzy adaptery używają realnego `EPSSetTarget(...)` |
| A-41 | `require_nonzero_rhs=false` działa we wszystkich lane'ach | **obalone** | P0/P1: wspólny host GMRES odrzuca zerowy RHS |
| A-42 | bieżący Poisson-airbox modal składa produkcyjną słabą formę FEM | **obalone** | validation-only P0 przed promocją: adapter akceptuje tylko synthetic algebraic oracle i realne warianty odrzuca |
| A-43 | GPU-G5a jest skalowalnym, persistent device-resident modal eigensolverem | **obalone — mylący aktywny artifact** | P0 status/provenance: one-shot dense, kernel `<<<1,1>>>`, a artifact ustawia `gpu_device_resident_modal_eigensolver=true` |

## 5. Kanoniczny stan docelowy

Jedno źródło prawdy powinno definiować:

```text
B_alpha dq/dt = L q + b(t)
L v_j = lambda_j B_alpha v_j
A_plus(omega)  = +i omega B_alpha - L   dla exp(+i omega t)
A_minus(omega) = -i omega B_alpha - L   dla exp(-i omega t)
gamma0 = mu0 * abs(gamma)                [m / (A s)]
omega = 2*pi*f                            [rad / s]
```

Kanoniczny obiekt musi być tym samym obiektem używanym przez eigensolver,
direct/FGMRES driven response, obliczanie true residualu, preconditioner
qualification i modal-reduced validation. Nie wolno odtwarzać znaków, `mu0`,
fazora albo macierzy masy osobno w każdym lane'ie.

Minimalny interfejs wewnętrzny:

```cpp
struct LinearizedDynamicPencil {
    DynamicPencilMetadata metadata;
    ApplyRealOperator apply_L;
    ApplyRealOperator apply_B_alpha;
    ApplyComplexOperator apply_Aomega;
    ApplyAdjointOperator apply_L_adjoint;
    ApplyAdjointOperator apply_B_adjoint;
    OperatorDigest digest;
};
```

`apply_Aomega` powinno być budowane centralnie z `apply_L`, `apply_B_alpha` i
jednego enumu fazora. Dedykowana zoptymalizowana/fused implementacja może je
zastąpić dopiero po teście równoważności z konstrukcją referencyjną.

## 6. Kolejność wdrażania

Napraw nie należy wykonywać w kolejności przypadkowej. Zależności są
następujące:

1. Zamrozić uczciwe statusy lane'ów i nie promować `modal_reduced`,
   `gpu_device_krylov` ani realnego Poisson-airbox.
2. Wprowadzić kanoniczny pencil, jednostki, fazor i kanonizację requestu.
3. Naprawić publiczny ABI, checked arithmetic i granice wyjątków.
4. Naprawić stan linearyzacji, podpisy operatora i certyfikaty provenance.
5. Naprawić eigensolver: shift, descriptor/gauge, lewy/prawy modal contract.
6. Naprawić modal response: true residual, backward error, enrichment/fallback.
7. Domknąć Floquet transport ramek i topologiczny certyfikat siatki.
8. Dopiero potem implementować pełny device-resident FGMRES.
9. Wykonać managed runtime, physics i convergence gates przed zmianą statusu
   capability na produkcyjny.

## 7. Szczegółowe instrukcje napraw

### DS-01. Jeden typ kanonicznego pencilu dynamicznego

**Status:** częściowo potwierdzone, P0 architektury.

#### Dowód i precyzyjna korekta audytu

Kanoniczne noty już definiują relację eigen/driven, a implementacja nie jest
całkowicie rozłączna. `assemble_mfem_modal_dense_operator_payload()` buduje
kolumny przez `apply_mfem_linearized_cpu_operator()`. Driven response wywołuje
tę samą funkcję dla części operatora MFEM. To ogranicza ryzyko dwóch zupełnie
niezależnych równań.

Brakuje jednak jednego typu, który wiąże `L`, `B_alpha`, fazor, jednostki,
podpis operatora i adjoint. Top-level requesty nadal mówią równolegle o
`stiffness`, `gyrotropic`, `mass`, `frequency mass`, `Aomega` i damping policy.

#### Instrukcja implementacji

1. W backend-neutral warstwie frequency-domain utworzyć
   `linearized_dynamic_pencil.hpp/.cpp`; nie dodawać nowej fizyki do
   `Context` ani `mfem_bridge.cpp`.
2. Zdefiniować jeden enum fazora oraz jedną strukturę metadanych z:
   `gamma0_si`, `field_unit=A_per_m`, `frequency_unit=Hz`,
   `angular_frequency_unit=rad_per_s`, `eigenvalue_unit=per_s`, damping model,
   tangent-frame convention i operator digest.
3. Wymagać osobnych, read-only akcji `apply_L(q)` i `apply_B_alpha(q)`.
4. Zbudować referencyjne `apply_Aomega` wyłącznie jako:

   ```text
   y = sign(phase) * i * omega * B_alpha(x) - L(x).
   ```

5. Zachować fused CPU/GPU `Aomega` jako optymalizację, ale przed rejestracją
   wymagać parity testu z referencyjną kompozycją na losowych wektorach.
6. Eigensolver ma przyjmować ten sam pencil, nie trzy niezależne macierze bez
   słownika. Adapter dense/CSR może materializować `L` i `B_alpha` kolumnami.
7. True residual eigensolvera i driven solvera musi wywoływać canonical pencil,
   a nie operator odtworzony z wyniku.
8. Dodać akcje adjoint/transpose do tego samego kontraktu; bez nich lane
   damped modal-reduced pozostaje niedostępny.
9. Usunąć ręcznie powielane konstrukcje `Aomega` dopiero po migracji wszystkich
   callerów i testach równoważności.

#### Pliki docelowe

- nowe `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`;
- nowe `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp`;
- `mfem_linearized_operator.*`, `mfem_modal_operator_payload.*`;
- `modal_eigen_solver.cpp`, `driven_response_solver.cpp`;
- CPU/GPU operator adapters, bez łączenia ownership lane'ów CPU i GPU.

#### Testy i warunek odbioru

- losowe `x`: `fused_Aomega(x)` zgodne z referencyjnym `i*omega*B-L` dla obu
  fazorów;
- ta sama sygnatura operatora w eigen, driven i true-residual artifact;
- macrospin: `A(lambda)v=0` w częstotliwości zwróconej przez eigensolver;
- zmiana dowolnego parametru fizycznego zmienia digest;
- brak alternatywnego top-level równania w aktywnych lane'ach.

### DS-02. Jednostki `gamma`, `gamma0`, `mu0`, częstotliwości i shiftu

**Status:** częściowo potwierdzone, P0 API i naukowej reprodukowalności.

#### Stan bieżący

Noty fizyczne rozstrzygają, że dla pól w `A/m` obowiązuje
`gamma0=mu0*abs(gamma)` w `m/(A s)`. Nagłówki nadal mają dwa modele:
`gamma_rad_s_T + mu0_T_m_A` w modal request oraz `gamma0` w operator/driven.
Pola shiftu Poisson-airbox nie mają sufiksu jednostki.

#### Instrukcja implementacji

1. Na publicznej granicy zachować wielkości fizyczne, ale nazwać je
   jednoznacznie: `gamma_abs_rad_per_s_t`, `mu0_t_m_per_a`,
   `gamma0_m_per_a_s`.
2. Kanonizator requestu ma policzyć dokładnie jedną wewnętrzną wartość
   `gamma0_m_per_a_s`.
3. Jeśli caller poda równocześnie `gamma`, `mu0` i `gamma0`, sprawdzić zgodność
   względną w tolerancji określonej w kontrakcie; konflikt odrzucić.
4. Nie używać `rad` jako wymiaru numerycznego w przeliczeniach, ale zachować go
   w nazwach/provenance, aby odróżnić `Hz` i `rad/s`.
5. Zmienić pola shiftu na `shift_sigma_real_per_s` i
   `shift_sigma_imag_rad_per_s`, albo zastąpić je typed complex eigenvalue.
6. Każdy artifact ma przechowywać jednocześnie `frequency_hz`, `omega_rad_s`,
   `lambda_real_per_s`, `lambda_imag_rad_per_s`, phase convention i gamma
   provenance.
7. Usunąć surowe, bezjednostkowe pola dopiero w nowej wersji ABI; stary adapter
   ma je jawnie przeliczyć i oznaczyć jako legacy.

#### Testy i warunek odbioru

- macrospin z danym `gamma` i `mu0` daje ten sam wynik co równoważne `gamma0`;
- celowe pominięcie `mu0` daje failing test z błędem skali, nie akceptację;
- round-trip `f -> omega -> f` zachowuje wartość w ustalonej tolerancji;
- artifact nie zawiera bezjednostkowego pola `sigma` ani `gamma0` bez
  definicji.

### DS-03. Centralne mapowanie wartości własnych, fazora i znaku tłumienia

**Status:** potwierdzone, P0 walidacji fizycznej.

#### Instrukcja implementacji

1. Dodać czystą funkcję:

   ```cpp
   ModeKinematics map_eigenvalue(
       ComplexEigenvalue lambda,
       FrequencyDomainPhaseConvention phase);
   ```

2. Funkcja zwraca `frequency_hz`, `omega_rad_s`, `decay_rate_per_s`, branch
   sign i flagę stabilności.
3. Dla `exp(+i omega t)` dodatnia gałąź ma `Im(lambda)>0`, a stabilny zanik
   `Re(lambda)<=0`. Dla `exp(-i omega t)` znak części urojonej gałęzi dodatniej
   jest przeciwny; definicja zaniku pozostaje jawna i testowana.
4. Filtry modów, artifact writer, contour count i modal response mają używać
   tej funkcji zamiast lokalnych porównań `lambda_imag > 0`.
5. Przy tolerancji zero/soft mode nie przypisywać arbitralnie gałęzi; zwrócić
   `zero_frequency_mode`.
6. Zapisać w artifactach zarówno surowe `lambda`, jak i wynik mapowania.

#### Testy

- macrospin `alpha=0`: para sprzężona i właściwe `+/- omega`;
- macrospin `alpha>0`: obie gałęzie stabilne w wybranej konwencji;
- przełączenie fazora daje właściwą transformację przez sprzężenie;
- zero mode nie jest usuwany przez filtr dodatniej częstotliwości bez jawnej
  polityki.

### DS-04. Jedna kanonizacja requestu i tagged source zamiast precedencji flag

**Status:** potwierdzone, P0 routingu.

#### Dowód

`ModalEigenRequest` i `DrivenFrequencyResponseSolveRequest` zawierają wiele
niezależnych flag `enabled`. Modal routing wybiera najpierw tiny, potem
Poisson, potem production; driven routing również ma precedencję. Validator nie
wymaga dokładnie jednego źródła całego problemu. Phase mismatch w driven jest
już odrzucany, lecz samo dublowanie pozostaje. Dwa wektory `k` nie są
kanonicznie porównywane we wszystkich lane'ach.

#### Instrukcja implementacji

1. Zdefiniować wewnętrzny sum type:

   ```text
   CanonicalOperatorSource =
       TinyValidation
     | MfemMatrixFree
     | ExplicitDense
     | ExplicitCsr
     | PoissonAirboxDescriptor
     | ExternalProvider
   ```

2. Dodać jedną funkcję `canonicalize_dynamic_solve_request()` wywoływaną przed
   plannerem lub alokacją.
3. Policz aktywne źródła. `0` oraz `>1` zwracają `validation_error` z listą
   konfliktujących pól; żadnej cichej precedencji.
4. Wybrać phase convention, `k`, boundary, demag, drive kind i operator source
   dokładnie raz. Zduplikowane legacy pola wolno zaakceptować tylko, gdy są
   bitowo/numerycznie zgodne.
5. Faza per pair ma być wynikiem kanonizacji `k` i translacji; dostarczona faza
   jest tylko wartością do cross-checku.
6. Zmapować `FrequencyDomainExcitationKind` oraz `FrequencyDriveKind` w jedną
   semantykę fizyczną. `field A/m`, `tangent RHS`, torque i external provider
   muszą pozostać rozróżnione.
7. Wynik kanonizacji ma być immutable i zawierać digest. Backend nie powinien
   ponownie interpretować flag wejściowych.
8. Wprowadzić nową wersję C ABI; stary request tłumaczyć przez adapter, a nie
   rozszerzać kolejnymi flagami ogona.

#### Testy

- każda para jednocześnie aktywnych wariantów jest odrzucana;
- sprzeczne phase/k/drive są odrzucane przed callbackiem;
- zgodne legacy duplikaty dają jeden canonical request;
- wszystkie legalne warianty przechodzą round-trip Python/ProblemIR/native;
- artifact zapisuje requested source i resolved source bez utraty intentu.

### DS-05. Walidacja inwariantów certyfikatu bazy modalnej

**Status:** potwierdzone — dormant, P0 przed promocją `modal_reduced`.

#### Dowód

`modal_basis_completeness_allows_response()` sprawdza relacje tylko w jedną
stronę i nie wymaga nieujemnego residualu. Reproducer potwierdza akceptację
ujemnych countów i residualu. Helper ma obecnie tylko callerów testowych.

#### Instrukcja implementacji

1. Oddzielić `validate_modal_basis_certificate()` od decyzji o użyciu w
   odpowiedzi.
2. Odrzucić nieznane wartości enumów, nie tylko `method==none`.
3. Wymagać nieujemności wszystkich countów i zmierzonych residuali.
4. Zdefiniować semantykę countu: dodatnie gałęzie, pary sprzężone,
   degeneracje/klastry i zero modes.
5. Dla nietruncatedowanego wyniku wymagać co najmniej:

   ```text
   returned_modes == accepted_modes_before_cap
   accepted_modes_before_cap == certified_modes_in_window
   actual_mode_array_length == returned_modes
   result_truncated == false
   0 <= every measured residual <= allowed residual
   ```

6. `estimated_modes_in_window` traktować jako estymatę, nie granicę dowodu. Jeśli
   ma być countem certyfikowanym, zmienić nazwę i zapisać metodę dowodu.
7. Certyfikat ma być generowany przez eigensolver, nie przyjmowany jako zaufane
   pola callera.
8. Rozróżnić przyczyny: invalid, truncated, provenance mismatch, left/right
   residual failed, response residual failed.

#### Testy

- wszystkie ujemne count/residual, NaN i infinity są odrzucane;
- `returned > accepted`, `returned < accepted` bez truncation i zły array
  length są odrzucane;
- unknown enum jest odrzucany;
- fuzzing struktury nie może zwrócić `allowed=true` bez wszystkich inwariantów.

### DS-06. Kanoniczny, odporny na kolizje klucz cache

**Status:** potwierdzone — dormant, P0 przed cache modalnym.

#### Instrukcja implementacji

1. Zdefiniować schemat `modal_basis_cache_key.v2` jako kanoniczny payload
   binarny `tag + length + bytes`.
2. Nie sklejać nieescapowanych stringów. Stały separator nie rozwiązuje
   problemu bez length-prefix.
3. `double` kodować jako znormalizowane bity IEEE-754 w ustalonej kolejności
   bajtów; `-0.0` normalizować do `+0.0`; NaN/inf odrzucać.
4. Payload musi obejmować wszystko, co zmienia pencil lub interpretację bazy:
   mesh topology/DOF ordering, equilibrium, materiały, interakcje, boundary,
   Floquet transport, demag, phase, gamma0, damping, tangent gauge,
   częstotliwości, normalizację i wersję assemblera.
5. Policzyć SHA-256 istniejącą wspólną implementacją repozytorium. Nie dodawać
   trzeciej niezależnej biblioteki haszującej.
6. Obok digestu przechowywać canonical metadata i przy cache hit ponownie
   sprawdzać schema/operator digest/certificate tolerance.
7. Tą samą poprawką zastąpić pozorny
   `LinearizationStateNative::linearization_signature_hash`, który jest dziś
   delimiter-concatenated stringiem, nie hashem.

#### Testy

- dostarczone dwa zestawy kolizyjne dają różne digesty;
- długie arbitralne stringi działają bez stałego bufora 512;
- locale nie zmienia digestu;
- `+0.0` i `-0.0` dają ten sam digest;
- zmiana pojedynczego bitu parametru pencil zmienia digest;
- golden payload daje identyczny digest na wspieranych kompilatorach.

### DS-07. Oddzielić kompletność spektrum od poprawności modalnej odpowiedzi

**Status:** potwierdzone — dormant, P0 przed `modal_reduced`.

#### Instrukcja implementacji

1. Utworzyć dwa niezależne artefakty:
   `SpectrumCountCertificate` i `ModalResponseEligibilityCertificate`.
2. Nigdy nie pozwalać, aby sam count w oknie aktywował response lane.
3. Dla każdego punktu sweepu policzyć z oryginalnym canonical pencil:

   ```text
   r(omega) = b - A(omega) x_modal(omega)
   relative_residual = norm(r) / max(norm(b), rhs_floor)
   backward_error = norm(r) /
       (operator_norm_estimate * norm(x) + norm(b) + scale_floor)
   ```

4. Nie obliczać decydującego residualu z macierzy odtworzonej z tych samych
   modów. Obecny validation helper robi właśnie taki self-referential check.
5. Gdy residual przekracza tolerancję, wykonać adaptive enrichment/guard modes
   albo rational Krylov correction.
6. Jeśli enrichment nie pomaga, jawnie przełączyć punkt na full direct/FGMRES;
   provenance ma zapisać fallback per point.
7. Szczególnie kontrolować brzegi okna, bliskie bieguny, silnie nienormalne
   przypadki i punkty o dużej kondycji.
8. `sparse_direct_sample` traktować jako response validation evidence, nie jako
   dowód count completeness.

#### Testy

- certyfikowany count w oknie, ale silnie wzbudzony mod poza oknem powoduje
  enrichment albo fallback;
- modal result zgadza się z niezależnym direct solve w amplitudzie i fazie;
- każdy zaakceptowany punkt spełnia true residual i backward error;
- sztucznie usunięty near-window pole jest wykrywany.

### DS-08. Diagonalna ekspansja eigenmodalna: lewe/prawe mody i kondycja

**Status:** potwierdzone — dormant, P0 przed tłumioną/nonnormalną diagonalną
ekspansją eigenmodalną.

Ten wymóg nie obejmuje automatycznie całej rodziny `modal_reduced`. Rational
Krylov, projection-based reduced basis albo Petrov-Galerkin mogą działać bez
jawnych lewych wektorów własnych, ale muszą mieć własną trial/test basis,
zredukowany operator i kontrolę original-operator residual z DS-07.

#### Instrukcja implementacji

1. Dla Poisson descriptor najpierw wykonać finite Schur reduction z DS-10.
   Poniższej normalizacji nie stosować bezpośrednio do pełnego singularnego
   `B` z zerowym blokiem algebraicznym.
2. Rozszerzyć artifact modów o zespolone prawe `V` i lewe `W` wektory.
3. Dla finite pencilu:

   ```text
   L v_j = lambda_j B v_j
   w_j^H L = lambda_j w_j^H B
   W^H B V = I
   ```

4. Odpowiedź liczyć jako biortogonalną ekspansję, nie projekcję prawymi modami
   w iloczynie euklidesowym.
5. Dla matrix-free operatora zaimplementować `MATOP_MULT_TRANSPOSE` lub adjoint
   odpowiadający rzeczywistej reprezentacji pencilu.
6. W SLEPc wybrać solver wspierający two-sided, włączyć
   `EPSSetTwoSided()` i pobrać `EPSGetLeftEigenvector()`.
7. Zapisywać prawy residual, lewy residual, normę `W^H B V-I`, najmniejsze
   singular values overlap matrix i condition estimate.
8. Degeneracje/klastry traktować jako niezmiennicze podprzestrzenie, nie
   arbitralnie parowane pojedyncze wektory.
9. Dla defective lub źle uwarunkowanej bazy zablokować ten engine i użyć
   rational Krylov/full solve.
10. Ewentualny skrót dla `alpha=0` musi wynikać z jawnie udowodnionej struktury
   gyrotropic/Hamiltonian; nie wolno zakładać `W=V`.

#### Alternatywny reduced-basis/rational Krylov engine

Jeżeli planner wybiera nie diagonalną ekspansję eigenmodalną, lecz ogólny ROM,
artifact musi przechowywać trial basis `V`, test basis `W` albo jawny Galerkin
contract, zredukowane `L_r`, `B_r`, residual estimator i warunki enrichment.
Akceptację nadal wyznacza residual/backward error oryginalnego pencilu, nie
sama jakość rozwiązania zredukowanego.

#### Testy

- nienormalny pencil 2x2/4x4, gdzie projekcja prawymi modami jest błędna, a
  biortogonalna zgadza się z direct solve;
- damped macrospin odtwarza peak, linewidth i phase;
- obrót bazy wewnątrz klastra nie zmienia odpowiedzi;
- near-defective problem deterministycznie wyłącza modal lane.

Źródła implementacyjne: oficjalne
[SLEPc EPSSetTwoSided](https://slepc.upv.es/release/manualpages/EPS/EPSSetTwoSided.html)
i
[EPSGetLeftEigenvector](https://slepc.upv.es/release/manualpages/EPS/EPSGetLeftEigenvector.html).

### DS-09. Certyfikat kompletności musi zawierać dowód i provenance

**Status:** potwierdzone — dormant, P0.

#### Instrukcja implementacji

1. Jedna typed struktura ma być źródłem walidacji i JSON, bez ręcznie
   rozbieżnych pól.
2. Związać certyfikat z: schema, operator/equilibrium digest, wymiarem, oknem,
   backendem, precision, run ID, build ID i tolerancją.
3. Dla contour count zapisać kontur w płaszczyźnie zespolonej, rzędy
   kwadratury, historię refinement, residuale shifted solves, rank/singular
   values projektora i margines modów od granicy konturu.
4. Dla sparse-direct evidence zapisać dokładny problem i sampling, lecz nie
   nazywać tego automatycznie certyfikatem countu.
5. Odrzucić reuse certyfikatu dla innego pencilu, okna, urządzenia lub
   łagodniejszej tolerancji.
6. Podpis kryptograficzny nie jest potrzebny do lokalnej integralności, ale
   cryptographic digest payloadu jest potrzebny do jednoznacznego wiązania.

#### Testy

- podmiana operator digest, window lub tolerance unieważnia certyfikat;
- niestabilny contour count między refinementami nie daje `certified`;
- mod leżący w marginesie granicy wymusza rozszerzenie konturu/ambiguous;
- JSON round-trip nie traci żadnego pola dowodowego.

### DS-10. Descriptor pencil Poisson-airbox: eliminacja części algebraicznej i gauge

**Status:** potwierdzone — validation-only, P0 przed promocją produkcyjnego
modal Poisson. Realne warianty są obecnie fail-closed, więc nie jest to dowód
korupcji działającego produkcyjnego lane'u.

#### Stan bieżący

Pencil ma blok dynamiczny `q` i algebraiczny `phi`, a prawa strona ma zerowy
blok dla `phi`. Bieżący solver filtruje skończone liczby i dodatnią część
urojoną, ale nie implementuje pełnej klasyfikacji finite/infinite/gauge modes.
Walidacja boundary/gauge została ostatnio utwardzona: synthetic pure-Neumann
mean-zero jest akceptowany, a niezaimplementowane Robin/Dirichlet są odrzucane.
To naprawia fail-closed, nie tworzy jeszcze produkcyjnego solvera descriptor.

#### Zalecane rozwiązanie podstawowe: Schur elimination

1. Złożyć kanoniczne bloki słabej formy na wspólnej domenie magnet + airbox.
2. Zdefiniować Poisson block `P=A_phiphi` z polityką zależną od BC:
   - Robin `beta>0`: bez gauge;
   - Dirichlet: eliminacja essential DOF, bez gauge;
   - pure Neumann/k=0 periodic: mean-zero lub prawdziwy nullspace po kontroli
     kompatybilności RHS.
3. Udostępnić stabilną akcję `P^{-1}` albo rozwiązanie układu augmented dla
   mean-zero.
4. Zredukować algebraiczne `phi`:

   ```text
   phi(q) = -P^{-1} A_phiq q
   L_eff q = A_qq q + A_qphi phi(q)
   L_eff q = lambda B_qq q.
   ```

5. Eigensolver rozwiązuje wyłącznie finite dynamic pencil na `q`; infinite
   algebraic modes nie pojawiają się w przestrzeni Krylova.
6. Po znalezieniu `q` rekonstruować `phi` i liczyć oddzielnie residuale:

   ```text
   r_q   = A_qq q + A_qphi phi - lambda B_qq q
   r_phi = A_phiq q + A_phiphi phi
   r_g   = mean_weights^T phi          tylko gdy gauge jest wymagany.
   ```

7. Certyfikat ma wymagać przejścia każdego bloku; żadnego `min(residual_slepc,
   residual_reconstructed)`.
8. Zapisać conditioning/failure Poisson solve, liczbę iteracji, nullspace i BC
   provenance.

#### Alternatywa

Pełny descriptor eigensolver jest dopuszczalny tylko, jeśli jawnie obsługuje
singularne `B`, deflację części algebraicznej, finite eigenvalue extraction i
gauge. To jest bardziej złożone niż Schur i nie powinno być wybierane bez
udokumentowanej korzyści.

#### Testy

- full dense descriptor kontra Schur dla małej macierzy;
- mean-zero kontra pinned gauge dają te same `q`, częstotliwość i pole
  fizyczne;
- Robin/Dirichlet nie dostają sztucznego gauge;
- wstrzyknięty algebraic/infinite mode nie jest raportowany jako fizyczny;
- oba residuale blokowe i gauge residual spełniają tolerancję.

### DS-11. Naprawić targetowanie `lambda=i*omega` w SLEPc

**Status:** potwierdzone — aktywne, P0.

#### Dowód

`slepc_modal_eigen.cpp`, `poisson_airbox_modal_eigen.cpp` oraz
`poisson_airbox_schur_matshell.cpp` ustawiają dodatni `target_omega` jako realny
`PetscScalar`, a następnie wybierają mody na podstawie części urojonej. W obrazie
używany jest real-scalar SLEPc. Realny shift szuka sąsiedztwa osi rzeczywistej,
nie punktu `i*omega`.

Oficjalna dokumentacja SLEPc stwierdza, że kompleksowego targetu nie można
podać w real-scalar build:
[EPSSetTarget](https://slepc.upv.es/release/manualpages/EPS/EPSSetTarget.html).
Shift-invert działa jako `(A-sigma B)^-1 B`:
[STSINVERT](https://slepc.upv.es/release/manualpages/ST/STSINVERT.html).

#### Instrukcja implementacji

Wybrać i udokumentować jedną z dwóch poprawnych dróg:

1. **Preferowana dla modalnego lane'u:** osobny complex-scalar PETSc/SLEPc
   runtime i target `sigma = i*omega_target` dla `exp(+i omega t)`.
2. **Alternatywa real-scalar:** jawna real-block reprezentacja kompleksowego
   shiftu oraz `STShell`, której akcja jest matematycznie równoważna
   `(L-i*omega_target B)^-1 B`. Nie wystarczy zmiana sorting enumu.

Następnie:

3. Centralny mapper fazora ma wyznaczać znak urojonego shiftu.
4. Artifact ma zapisać `sigma_real`, `sigma_imag`, scalar build kind i
   spectral transform kind.
5. Usunąć nazwę `target_angular_frequency` z argumentu, jeśli typ pozostaje
   realny i może być błędnie interpretowany; użyć typed complex shift.
6. Dodać runtime assertion, że target reprezentuje właściwą oś dla wybranego
   pencilu.

#### Testy

- macierz z modami przy `+/- i*omega1`, `+/- i*omega2`: target przy `omega2`
  wybiera drugi mod, nie mod najbliższy realnemu `omega2`;
- oba fazory wybierają właściwą gałąź;
- wynik complex build i real-block STShell jest zgodny dla małego oracle;
- test musi failować z obecną realną wartością `EPSSetTarget(target_omega)`.

### DS-12. Zastąpić synthetic Poisson-airbox realnym assemblerem FEM

**Status:** potwierdzone — validation-only, P0 przed promocją. Rozszerza
ustalenia dokumentu 19; synthetic oracle działa, realne assembly jest
fail-closed.

#### Stan bieżący

Bieżący adapter `poisson_airbox_modal_eigen.cpp` akceptuje wyłącznie
`synthetic_algebraic_oracle`. Realne Robin/Dirichlet assembly nie jest
zaimplementowane. Obecność `.cpp` i SLEPc nie oznacza jeszcze weak-form FEM.

#### Instrukcja implementacji

1. Wejściem assemblera musi być wspólna siatka FEM `D=Omega_m union Omega_air`,
   nie tylko chmury węzłów ani deklarowany `M_eff`.
2. Złożyć `A_phiphi` z:

   ```text
   integral_D grad(psi) dot grad(phi) dV
   + beta integral_Gamma_open psi phi dS     dla Robin.
   ```

3. Złożyć sprzężenie magnetostatyczne z
   `integral_Omega_m Ms*delta_m dot grad(psi) dV`, zachowując znak
   `H_demag=-grad(phi)`.
4. Restrykcje PBC/Floquet stosować na pełnej przestrzeni FE oraz DOF, nie tylko
   na współrzędnych par węzłów.
5. Dla k=0 wdrożyć politykę gauge z DS-10. Dla non-k0 użyć zespolonego
   `grad_k/div_k`; nie zastępować go statycznym Poissonem k=0.
6. Nie wstrzykiwać oczekiwanej częstotliwości Kittela do macierzy. Kittel ma
   być niezależnym oracle po rozwiązaniu.
7. Zapisać mesh/material/boundary/assembly digests i rzeczywiste parametry
   airboxa w artifactach.
8. Dopiero po przejściu convergence studies zmienić lane z
   `validation_synthetic_payload` na produkcyjny.

#### Testy

- manufactured Poisson solution i niezależna kontrola znaku;
- zbieżność po zagęszczeniu magnet/airbox oraz zwiększaniu airbox extent;
- Kittel ideal-film bez wstrzykiwania `M_eff` do operatora;
- zgodność full i Schur solve;
- reciprocity/symmetry właściwa dla wybranej reprezentacji;
- PBC k=0 i Floquet `k<->-k` na kompatybilnej siatce.

### DS-13. Checked arithmetic dla wszystkich extentów i bajtów

**Status:** potwierdzone, P0 bezpieczeństwa pamięci.

#### Instrukcja implementacji

1. Utworzyć jedną bibliotekę pomocniczą:

   ```cpp
   bool checked_add_u64(uint64_t a, uint64_t b, uint64_t &out);
   bool checked_mul_u64(uint64_t a, uint64_t b, uint64_t &out);
   bool checked_to_size_t(uint64_t value, size_t &out);
   bool checked_bytes(uint64_t count, size_t element_size, size_t &out);
   ```

2. Zabronić bezpośrednich obliczeń extentów w validatorach i allocatorach.
3. Objąć co najmniej:
   - `n*vector_count`, `n*(restart+1)`, `n*restart`;
   - `(restart+1)*restart`, `restart+1`;
   - `node_count*2`, `node_count*3`, `n*n`;
   - `frequency_count*tangent_dof_count`;
   - `row_count+1`, liczby bloków i `sizeof(T)*count`;
   - CUDA grid/block count przed konwersją do `int`.
4. Zanim nastąpi pointer arithmetic, sprawdzić również offset + extent.
5. Ustalić rozsądne limity runtime dla restartu, countu modów i wymiaru dense;
   samo uniknięcie overflow nie chroni przed alokacją petabajtów.
6. Naprawić także `tangent_workspace_shape(node_count*2/*3)` i aktywne
   alokacje hostowego GMRES `V/Z/H`, nie tylko reproducer w nagłówku GPU.

#### Testy

- boundary table: `0`, `1`, `UINT64_MAX/3`, `UINT64_MAX/2`, `UINT64_MAX`;
- każdy zawinięty iloczyn/suma zwraca validation error przed dereference;
- property/fuzz tests dla wszystkich publicznych wymiarów;
- ASan/UBSan dla CPU oraz Compute Sanitizer dla CUDA.

### DS-14. Rozdzielić static config, solve result i qualification certificate GPU

**Status:** potwierdzone — dormant, P0 przed device FGMRES.

#### Instrukcja implementacji

1. Zastąpić bieżący `FGMRESDeviceEngineConfig` trzema typami:

   ```text
   FGMRESDeviceStaticConfig
     device, stream, callbacks, tolerances, restart, allocation policy

   FGMRESDeviceSolveRequest
     frequency point, rhs, initial guess, operator/preconditioner digests

   FGMRESDeviceRunResult
     status, stop reason, iterations, residual history, transfers, timings
   ```

2. Static validator nie może wymagać `iteration_count`, `r64`, `r256`,
   `apply_count` ani końcowych residuali.
3. Run result może utworzyć tylko engine; caller nie może dostarczać pól
   świadczących o własnej poprawności.
4. Qualification certificate tworzy osobny kwalifikator po zakończonym runie.
5. Certyfikat wiąże schema/build, operator/preconditioner digest, `n`, precision,
   GPU UUID/compute capability, phase, omega/sweep digest, restart/tolerances,
   run ID i CPU-reference fixture.
6. API dzielić na:

   ```text
   validate_static_config()
   run_device_fgmres()
   certify_completed_run()
   ```

7. Capability może ustawić tylko zaufana fabryka runtime; nigdy caller-supplied
   diagnostics.

#### Testy

- świeża, poprawna konfiguracja przechodzi bez historii runu;
- sfabrykowane `iterations_256` nie może wpłynąć na static validation;
- certyfikat innego operatora/device/omega jest odrzucany;
- run result jest immutable dla callera.

### DS-15. Kryterium residualu, early convergence, happy breakdown i zero RHS

**Status:** potwierdzone; dormant dla reguły 64/256, aktywne dla zero RHS.

#### Instrukcja implementacji

1. Próbki residualu zapisywać jako sekwencję
   `(iteration, tracked, recomputed_true, converged, stop_reason)`.
2. Early convergence przed 64/256 jest sukcesem, jeśli recomputed true residual
   spełnia tolerancję.
3. `r64=r256=0` jest sukcesem, a brak ścisłej monotoniczności nie może
   unieważnić poprawnego końcowego rozwiązania.
4. Trend 64/256 pozostawić jako test kwalifikacyjny dla wybranych fixture'ów,
   nie warunek każdego solve.
5. Oddzielić wartości obserwowane od progów:

   ```text
   observed_tracked_recomputed_mismatch
   allowed_tracked_recomputed_mismatch
   observed_device_to_cpu_residual_ratio
   allowed_device_to_cpu_residual_ratio
   ```

6. Dodać jawny `happy_breakdown_tolerance` oraz rozróżnić happy i unhappy
   breakdown. Hostowy GMRES nie powinien zamieniać dokładnego breakdownu w
   ogólny `singular Krylov basis` bez testu true residual.
7. Zero RHS obsłużyć wspólnie przed wyborem lane'u:

   ```text
   require_nonzero_rhs=false && norm(b)==0
   => x=0, residual=0, iterations=0, stop_reason=zero_rhs, status=ok.
   ```

8. `require_nonzero_rhs=true` zachowuje validation error.
9. Kryterium końcowe opierać na recomputed true residual/backward error, nie
   wyłącznie residualu z Hessenberga.

#### Testy

- identity system: jedna iteracja;
- dokładny happy breakdown;
- zero RHS dla validation, production CPU, production GPU, periodic-airbox i
  Floquet projection;
- stagnation na precision floor nie jest fałszywą porażką po osiągnięciu
  tolerancji;
- tracked/recomputed mismatch przekraczający politykę jest wykrywany.

### DS-16. Bezpieczny probe callbacków GPU

**Status:** potwierdzone — dormant, P0.

#### Instrukcja implementacji

1. Wprowadzić osobne typy `DeviceComplexConstVectorView` i
   `DeviceComplexMutableVectorView`.
2. Probe używa wyłącznie engine-owned `rhs_probe`, `operator_output_probe` i
   `preconditioner_output_probe`; nigdy produkcyjnego `solution`.
3. Odrzucić `NaN`, `+/-inf`, zero i ujemne omega zgodnie z publicznym
   kontraktem dodatnich częstotliwości.
4. Usunąć zdublowane omega. Jeden `FrequencyPointContext` ma zawierać ID,
   omega i phase convention; callback oraz diagnostyka dostają ten sam obiekt.
5. Jawna alias policy musi zabronić:
   - `real==imag`;
   - overlap input/output bez capability in-place;
   - overlap RHS/solution/scratch/V/Z/H;
   - wskaźników z innego device ordinal.
6. Sprawdzić CUDA pointer attributes zamiast ufać enumowi `location=device`.
7. Przed callbackiem wypełnić output sentinel/NaN. Po callbacku:
   - zsynchronizować właściwy stream/event;
   - odebrać async error;
   - potwierdzić zapis całego outputu i finite values;
   - sprawdzić checksum wejścia przed/po;
   - w małym kwalifikatorze porównać operator z CPU oracle.
8. Sprawdzić liniowość `Aomega`; nie wymagać liniowości od elastycznego,
   potencjalnie nieliniowego preconditionera FGMRES.

#### Testy

- `+inf`, NaN, zero, ujemne i niezgodne finite omega są odrzucane;
- probe nie zmienia RHS ani initial guess;
- callback no-op i częściowy zapis nie przechodzą;
- host pointer oznaczony jako device jest odrzucany;
- błąd asynchroniczny kernela jest zwracany po synchronizacji.

### DS-17. Pełny device-resident FGMRES i uczciwy status GPU

**Status:** potwierdzone — dormant, P0 promocji.

#### Korekta audytu

Aktualny `production_gpu` nie jest samym probem. Wywołuje rzeczywisty hostowy
GMRES, który ma `V(m+1)`, `Z(m)`, `H`, podwójny MGS, Givens, restart i
recomputed true residual. Operator CUDA wykonuje jednak H2D, synchronizację i
D2H przy każdym apply. Poprawna nazwa to `gpu_operator_host_krylov`, nie
device-resident FGMRES.

#### Wymagany layout

```text
V: n x (m+1)
Z: n x m
H: (m+1) x m complex
rotations: m
g: m+1
y: m
r, w, Ax: po n
```

Wariant `V=n*m + work_vector` jest dopuszczalny tylko po formalnym opisaniu,
gdzie mieszka `v_(j+1)`, kiedy jest kopiowany i jak capacity chroni zapis.

#### Instrukcja implementacji

1. Zaimplementować device `copy/scal/axpy/dotc/nrm2`.
2. Zaimplementować MGS z reorthogonalizacją albo inną jawnie zwalidowaną
   stabilną ortogonalizację.
3. Dodać zespolone Givens/QR, least-squares update i przechowywanie `Z_j` dla
   zmiennego prawego preconditionera.
4. Dodać restart, early convergence, happy/unhappy breakdown, true residual
   recomputation i residual replacement po restarcie.
5. Dodać cancellation/progress bez wymuszania transferu pełnych wektorów.
6. Hessenberg, rotations i residual state mają pozostać na urządzeniu. Jeśli
   host odczytuje skalary w checkpointach, telemetry ma uczciwie raportować
   bounded D2H; nie deklarować literalnego zera transferów.
7. Workspace wyliczać jedną checked funkcją layoutu; `workspace_vector_count>=4`
   nie jest wystarczające.
8. Ustawić `production_loop_available=true` wyłącznie po rzeczywistym
   podłączeniu engine'u i runtime qualification.
9. Do czasu promocji planner ma odrzucać forced device-FGMRES jako unavailable,
   a aktualne artifacty zachować jako `gpu_operator_host_krylov` i
   `gpu_device_resident_solver=false`.

#### Testy i promocja

- nonsymmetric complex system zgodny z CPU/PETSc FGMRES;
- zmienny/nieliniowy right preconditioner;
- restart `m=1`, mały `m`, wiele restartów;
- divergence/stagnation/NaN z jawnym stop reason;
- Compute Sanitizer bez OOB/race;
- transfer trace zgodny z deklaracją;
- real GPU managed gate, CPU parity i artifact z build/device/operator digests.

Referencja algorytmiczna:
[PETSc KSPFGMRES](https://petsc.org/main/manualpages/KSP/KSPFGMRES/).

### DS-18. Jawny kontrakt ramki stycznej i bezpieczny edge operator

**Status:** częściowo potwierdzone, P1; P0 dla gauge-invariant Floquet.

#### Korekta audytu

Bieżąca implementacja buduje `e1=reference x m`, `e2=m x e1`, więc zachodzi
`e1 x e2=m`. Overload edge operatora przyjmujący ramki oblicza pełne
`E_i^T E_j`, dlatego scalar `stiffness` jest współczynnikiem kartezjańskiego
exchange, a nie błędnym zamiennikiem transportu. Problemem jest drugi overload
bez ramek, który nie dokumentuje wymogu identycznych lokalnych baz.

DMI nie powinno być wciskane w ten typ. Bieżący kod ma dedykowany elementowy
operator DMI; tę separację należy zachować.

#### Instrukcja implementacji

1. W `TangentFrameNode` zapisać inwarianty:
   `|m|=|e1|=|e2|=1`, wzajemną ortogonalność i `e1 x e2=m`.
2. `TangentFrameDiagnostics` rozszerzyć o maksymalny błąd handedness/determinant.
3. W testach generować losowe `m`, a nie tylko osiowe przypadki.
4. Usunąć publiczny overload edge bez ramek albo nazwać go
   `apply_tangent_edge_operator_identical_gauge()` i wymagać jawnego
   certyfikatu `identical_frame_gauge=true`.
5. Produkcyjny exchange ma zawsze używać overloadu z ramkami lub pełnych
   bloków 2x2.
6. DMI i surface/PMA Hessian pozostają osobnymi typed operatorami; enum edge
   ma odrzucać DMI zamiast przyjmować scalar.
7. Dodać checked arithmetic do `tangent_workspace_shape()`.

#### Testy

- `det([e1,e2,m])=+1` dla losowych kierunków;
- niezależne obroty gauge `E_i -> E_i R_i` nie zmieniają lifted Cartesian
  wyniku exchange;
- overload identical-gauge odrzuca różne ramki;
- DMI edge scalar jest compile-time lub runtime rejected.

### DS-19. Floquet: faza i transport ramki jako jeden constraint

**Status:** potwierdzone — aktywne, P0 dla tekstur i non-k0.

#### Stan bieżący

Driven validator sprawdza już `phase_rad=-k dot translation` modulo `2*pi`.
`FrequencyDomainFloquetPeriodicPair` nadal przenosi tylko fazę. Osobny
`MeshSymmetryCertificate` oblicza bloki transportu, ale solve request nie
wiąże ich z constraintem. Zastosowanie scalar phase do surowych `[u,v]` jest
poprawne tylko przy identycznym gauge ramek.

#### Instrukcja implementacji

1. Utworzyć canonical `FloquetTangentConstraint`:

   ```text
   source_dofs, destination_dofs
   translation_m[3]
   k_rad_per_m[3]
   phase = exp(-i k dot T)
   frame_transport_2x2 = E_dst^T E_src
   pair/topology digest
   ```

2. Nie przyjmować `phase_rad` jako niezależnego źródła prawdy. Jeśli legacy
   caller ją podaje, porównać modulo `2*pi` i odrzucić mismatch.
3. Nakładać constraint:

   ```text
   q_dst = phase * (E_dst^T E_src) * q_src.
   ```

4. Scalar `phi` używa tylko phase; magnetization używa phase i transportu.
5. Ten sam constraint ma służyć assembly, matrix-free apply, RHS projection,
   lift outputu i residualowi.
6. Dla wielu translacji sprawdzić cycle consistency oraz kompozycję faz i
   transportów.
7. Modal i driven muszą używać tego samego canonicalizera; usunąć osobne
   walidacje po migracji.
8. Non-k0 demag wymaga `grad_k/div_k` i zespolonej przestrzeni FE; sama
   projekcja po operatorze nie jest równoważna.

#### Testy

- losowe niezależne obroty gauge ramek po obu stronach szwu nie zmieniają
  eigenvalues ani lifted response;
- `k=0` zgadza się ze statycznym PBC;
- `k<->-k` daje właściwe parowanie dla realnych parametrów;
- cycle inconsistency fazy lub transportu jest odrzucana;
- modal i driven mają identyczny constraint digest.

### DS-20. Certyfikat periodycznej siatki musi obejmować topologię FEM

**Status:** potwierdzone — aktywne, P0.

#### Instrukcja implementacji

1. Jeśli obiekt ma nadal nazywać się `MeshSymmetryCertificate`, rozszerzyć
   request o:
   - mapę elementów source/destination;
   - lokalną permutację węzłów i orientację;
   - mapę boundary faces;
   - FE space/order i mapę true DOF;
   - Jacobian/reference-map consistency;
   - region/material attributes;
   - airbox i magnetic constraint maps.
2. Jeśli zakres ma pozostać węzłowy, zmienić nazwę na
   `PeriodicNodePairCertificate` i zabronić używania go jako dowodu pełnego
   FEM PBC.
3. `frame_transport_tolerance` musi dostać jednoznaczną semantykę albo zostać
   usunięta. Dziś mierzy odległość `E_dst^T E_src` od identyczności, ale jest
   tylko walidowana jako liczba. Jeżeli kontrakt wymaga identical gauge, wynik
   ponad tolerancją ma być rejectem. Jeżeli dopuszcza arbitralny gauge, duży
   obrót 2x2 jest legalny i tolerancja powinna mierzyć błąd ortogonalności
   transportu, nie odległość od `I`.
4. Zmienić `max_airbox_phi_pair_mismatch` na
   `max_airbox_translation_residual_m`, bo bieżąca implementacja liczy
   geometrię, nie wartości `phi`.
5. Jeśli potrzebna jest kontrola `phi`, dodać jawne complex phi source/dest i
   porównać je dopiero po solve; nie mieszać z certyfikatem siatki.
6. Haszować topology/DOF/pair maps kanonicznym SHA-256 i wiązać z operatorem.
7. Certyfikat ma mieć jawne `certificate_scope=node_pairs|full_fe_topology`.

#### Testy

- zgodne chmury węzłów z inną triangulacją są odrzucane jako full topology;
- odwrócona orientacja elementu/face jest wykrywana;
- permutacja numeracji zachowująca mapę DOF jest akceptowana;
- identical-gauge policy odrzuca transport daleki od `I`, a arbitrary-gauge
  policy akceptuje poprawny obrót i odrzuca nieortogonalny blok;
- nazwa i jednostka każdego residualu odpowiadają faktycznie liczonym danym.

### DS-21. Utwardzić dense Poisson oracle bez rozszerzania jego claimu

**Status:** potwierdzone — validation-only, P1/P0 dla buffer safety.

#### Instrukcja implementacji

1. `DenseRealMatrixView` rozszerzyć o `value_count` i `leading_dimension`.
2. Sprawdzić checked `rows*leading_dimension`, minimalny capacity i finite
   values przed każdym odczytem.
3. Zastąpić string `gauge_policy` enumem; nieznane wartości odrzucać.
4. Jeśli oracle ma sprawdzać `alpha=0` i `k=0`, dodać rzeczywiste dane
   `alpha`, `has_k`, `k[3]`. Alternatywnie usunąć deklaratywne flagi
   `require_*`, których nie da się zweryfikować.
5. Wynik domyślny ustawić na `unavailable`, a `ok` dopiero po pełnej
   walidacji/certyfikacji.
6. Sprawdzać wynik `snprintf`; przy truncation zwrócić artifact/diagnostic
   error albo użyć owned string wewnętrznie.
7. Zachować jawne `synthetic_no_mesh=true`; oracle nie może ustawiać
   production assembly claim.
8. Dodać osobne pola residuali Schur, q-block, phi-block i gauge.

#### Testy

- za krótki bufor i zły leading dimension są odrzucane;
- false declaration alpha/k nie może przejść bez danych;
- diagnostics truncation jest wykrywana;
- default-constructed result nie sugeruje sukcesu;
- oracle nadal przechodzi swoje małe golden cases.

### DS-22. Bezpieczna ewolucja publicznego C ABI

**Status:** potwierdzone — aktywne, P0.

#### Dlaczego nie da się naprawić samego warunku

W driven request pola `abi_version` i `struct_size` leżą w ogonie. Biblioteka
musi je odczytać, zanim wie, czy starszy caller w ogóle zaalokował ten ogon.
`struct_size=0` nie zapobiega out-of-bounds. Exact `sizeof` odrzuca z kolei
większe przyszłe struktury. Modal C request nie ma `struct_size`.
Obecny `fullmag_fem_frequency_domain_solve_result` również nie ma
`abi_version/struct_size`, więc samo naprawienie requestu powtórzyłoby problem
przy przyszłym rozszerzeniu wyniku.

#### Instrukcja implementacji

1. Nie rozszerzać dalej bieżących struktur w miejscu.
2. Wprowadzić nowy symbol ABI i prefix-first header:

   ```c
   typedef struct {
       uint32_t abi_version;
       uint32_t reserved;
       uint64_t struct_size;
   } fullmag_fem_abi_header;
   ```

3. Wprowadzić również nowy, prefix-first
   `fullmag_fem_frequency_domain_solve_result_v13`; nie rozszerzać starego
   resultu w miejscu.
4. Nowy symbol ma przyjmować oba rozmiary osobno, aby nie musiał odczytać
   nieistniejącego ogona przed sprawdzeniem capacity:

   ```c
   int fullmag_fem_fd_solve_v13(
       const void *request,
       uint64_t request_size,
       fullmag_fem_frequency_domain_solve_result_v13 *out_result,
       uint64_t out_result_size);

   void fullmag_fem_fd_result_release_v13(
       fullmag_fem_frequency_domain_solve_result_v13 *result,
       uint64_t result_size);
   ```

5. Najpierw odczytać wyłącznie prefix requestu mieszczący się w
   `request_size`; przed zapisem sprawdzić minimalny prefix wyniku w
   `out_result_size`.
6. Dla każdego pola requestu użyć warunku
   `offsetof(field)+sizeof(field) <= struct_size`; brakujące pola dostać
   wersjonowany default.
7. Każde pole wyniku zapisywać tylko, gdy
   `offsetof(field)+sizeof(field) <= out_result_size`. Release musi stosować tę
   samą zasadę, żeby nie odczytać wskaźników spoza layoutu callera.
8. Akceptować większe requesty i result capacities oraz ignorować nieznany
   ogon, jeśli version policy to dopuszcza.
9. Ujednolicić `struct_size` do `uint64_t`; w C ABI używać `uint32_t/int32_t`
   zamiast C++ `bool` i enumów o nieokreślonym rozmiarze.
10. Stare symbole zamrozić. Jeśli nie istnieje wiarygodna definicja wszystkich
   historycznych layoutów, jawnie wymagać rekompilacji zamiast udawać bezpieczną
   kompatybilność.
11. Dodać ABI layout manifest/golden tests dla 32/64-bit offsetów i alignment.
12. Result release pozostawić idempotentne; allocator i deallocator muszą
    pozostać po stronie tej samej biblioteki.

#### Testy

- minimalna starsza struktura bez ogona nie powoduje OOB w ASan;
- większa przyszła struktura jest akceptowana;
- każde pole graniczne jest testowane z size kończącym się przed i za polem;
- mniejszy i większy `out_result_size` nie powoduje zapisu/odczytu poza
  capacity, również w `release_v13`;
- modal i driven mają tę samą politykę version/size;
- C compiler, C++ compiler i Rust bindgen zgadzają się co do layoutu.

### DS-23. Granica wyjątków, `noexcept` i ownership

**Status:** potwierdzone — aktywne, P0 niezawodności; część tezy ABI obalona.

#### Korekta audytu

`FrequencyDomainContractResult`, `LinearizationStateNative` i
`MeshSymmetryCertificate` są wewnętrznymi typami C++. Same `std::string` i
`std::vector` nie przechodzą przez publiczny C ABI. C result używa owned
`char *` i idempotentnego release, co jest prawidłowym kierunkiem.

Problem pozostaje: funkcje oznaczone `noexcept` alokują wektory/stringi,
operują na filesystemie i wywołują callbacki bez nadrzędnego `try/catch`.
`std::bad_alloc` może wywołać `std::terminate`.

#### Instrukcja implementacji

1. Wewnętrzne funkcje intensywnie alokujące nie powinny być `noexcept`, chyba
   że łapią wszystkie wyjątki lokalnie.
2. Każdy eksport C/FFI ma mieć jeden outer boundary:

   ```cpp
   try { ... }
   catch (const std::bad_alloc &) { return allocation_error; }
   catch (const std::exception &e) { return internal_error_with_message; }
   catch (...) { return internal_error; }
   ```

3. Żaden wyjątek nie może przekroczyć C ABI.
4. Callbacki C traktować jako non-throwing. Dla callbacków C++ dodać adapter,
   który łapie wyjątek i mapuje go na status.
5. Alokować result strings dopiero po zbudowaniu wewnętrznego wyniku; przy
   częściowej porażce zwolnić już zaalokowane pola.
6. Dodać status `allocation_error` albo stabilne mapowanie na `internal_error`;
   nie mylić z błędem fizyki/solve.
7. Utrzymać jeden model ownership publicznych wyników: library-owned + library
   release. `const char *` w requestach jest borrowed tylko na czas calla.

#### Testy

- fault-injection allocator na każdym etapie zwraca status, nie terminate;
- throwing C++ callback jest bezpiecznie mapowany przez adapter;
- release po partial allocation i wielokrotny release są bezpieczne;
- sanitizer nie wykrywa leak/double-free.

### DS-24. Pełne kontrakty dense i CSR

**Status:** częściowo potwierdzone, P0/P1.

#### Stan bieżący

`CsrMatrixView` ma już długości `row_offsets`, `column_indices` i `values`, a
walidacja sprawdza podstawowe extenty i bounds. Dense modal matrices nadal nie
mają capacity. CSR używa 64-bitowych wymiarów i 32-bitowych indeksów bez jednej
centralnej, publicznej polityki.

#### Instrukcja implementacji

1. Każdy dense view: `rows`, `columns`, `leading_dimension`, `value_count`,
   layout enum i element type.
2. Checked capacity ma poprzedzać finite scan i assembly.
3. CSR schema ma jawnie ustalić:
   - index base 0;
   - `row_offsets_len==rows+1`;
   - monotonic row offsets i `last==nnz`;
   - column bounds;
   - sortedness policy;
   - duplicate policy.
4. Rekomendowana canonicalizacja na granicy: posortować kolumny, zsumować
   duplikaty, opcjonalnie usunąć dokładne zera i zapisać canonical digest.
5. Jeśli indeksy zostają `uint32_t`, jawnie odrzucić dimensions/nnz większe niż
   `UINT32_MAX`; alternatywnie wprowadzić osobny CSR64.
6. PETSc/SLEPc conversion ma sprawdzać zakres `PetscInt` niezależnie od C view.
7. Matrix ownership/lifetime udokumentować: borrowed immutable przez czas calla
   albo copied into solver-owned storage.

#### Testy

- empty rows, unsorted entries, duplicates i oba index bases;
- `row_offsets.back()!=nnz`, za krótki buffer i column out of range;
- granica `UINT32_MAX` i `PetscInt`;
- dense padding/leading dimension;
- canonical equivalent CSR daje ten sam digest i operator action.

### DS-25. Stan linearyzacji bez ukrytych zależności i fałszywych opcji

**Status:** potwierdzone — aktywne, P0 reprodukowalności.

#### Dowód

`build_linearization_state_from_equilibrium()` nie dostaje siatki, materiałów,
assemblera `H_eff` ani wag masowych, ale opcje deklarują recompute i periodic
symmetry. Bieżąca implementacja ignoruje te opcje i ustawia wszystkie
`tangent_lumped_mass=1.0`. Nie zachowuje magnetic/airbox mesh IDs, airbox node
count ani `phi0`. Pole nazwane hash jest zwykłą konkatenacją.

#### Instrukcja implementacji

1. Rozdzielić dwie operacje:
   - `import_and_validate_equilibrium_snapshot()` — sprawdza pola i IDs;
   - `assemble_linearization_state(context, snapshot)` — używa jawnej siatki,
     materiałów, operatorów, mas i periodic certificate.
2. Druga funkcja przyjmuje immutable `LinearizationAssemblyContext`, a nie
   globalny registry ukryty za stringami.
3. `recompute_h_eff0_and_compare=true` ma rzeczywiście ponownie złożyć pełne
   `H_eff0` z tych samych interakcji i porównać per term oraz total.
4. Obliczyć prawdziwy FEM lumped mass z przestrzeni/dyskretyzacji; nie wpisywać
   jedynek poza synthetic fixture.
5. `require_symmetric_periodic_mesh` ma wymagać full topology certificate z
   DS-20; `periodic_seam_tolerance` musi być użyta.
6. Zachować w stanie: magnetic/airbox mesh IDs, node/DOF counts, `phi0` wraz z
   gauge, material/physics/boundary digests, tangent frame convention.
7. Wszystkie extenty sprawdzać przed `resize(node_count*3)`.
8. Zbudować canonical binary payload i SHA-256 zamiast delimiter stringa.
9. Jeśli opcji nie da się jeszcze wykonać, usunąć ją albo fail-closed; nie
   raportować sukcesu z ignorowaną opcją `true`.

#### Testy

- zmiana mesh/material/boundary unieważnia snapshot;
- recomputed `H_eff0` wykrywa celowo zmienioną interakcję;
- real lumped masses są dodatnie i zgodne z całką objętości;
- periodic option bez certyfikatu jest odrzucana;
- Poisson state zachowuje `phi0`, gauge i airbox identity;
- delimiter-injection nie powoduje kolizji signature.

### DS-26. Term-by-term zgodność exchange, PMA/anizotropii, DMI i demag

**Status:** wymagany P0 gate wspólnego pencilu; nie jest osobną reprodukcją
crash, lecz zamyka ryzyko różnych operatorów eigen/driven.

#### Instrukcja implementacji

1. Każda interakcja ma wystawić jeden backend-neutral kontrakt
   linearyzacji/Jacobian-vector product, z którego korzystają eigen i driven.
2. Dla exchange zachować pełny transport ramek `E_i^T E_j` oraz prawidłowe
   natural/periodic boundary terms.
3. Dla uniaxial anisotropy/PMA zapisać jawnie axis, `K_u`, `M_s`, jednostki i
   znak Hessianu wokół `m0`; rozróżnić volume PMA i surface anisotropy.
4. Dla DMI zachować osobny elementowy operator:
   - interfacial i bulk jako różne typed variants;
   - właściwe słabe boundary terms;
   - region-dependent `D` i `M_s`;
   - zgodność orientacji normalnej i PBC/Floquet.
5. Dla demag oddzielić static `H_demag0`, dynamic tangent action i Poisson
   potential provenance. Static field nie może udawać dynamic response.
6. Zbudować term-isolation harness. Dla każdego termu porównać directional
   derivative pełnego FEM effective-field/RHS z linearyzowanym apply. Jest to
   test różniczki operatora FEM, nie osobny backend FDM.
7. Następnie sprawdzić sumę termów i tę samą akcję przez:
   - modal materialization;
   - driven matrix-free CPU;
   - GPU operator callback;
   - true residual.
8. Artifact ma raportować per-term enabled flag, digest, normę akcji i
   parity error; nie tylko ogólne `operator_ok`.

#### Testy

- jednorodny exchange zero mode i niezerowy spin-wave mode;
- PMA easy-axis/easy-plane ze znanym znakiem krzywizny;
- interfacial i bulk DMI z odwróceniem `D -> -D` oraz normalnej;
- DMI/PMA na niejednorodnych materiałach i ramkach;
- static/dynamic demag rozdzielone w fixture;
- eigen/driven/GPU parity per term i dla ich sumy;
- losowy obrót tangent gauge nie zmienia lifted Cartesian action.

### DS-27. GPU-G5a: usunąć mylący claim device-resident modal eigensolvera

**Status:** potwierdzone — aktywny błąd readiness/provenance, P0 przed
jakąkolwiek promocją GPU Poisson modal.

#### Dowód i właściwy zakres

`driven_response_gpu.cu:2169-2183` wykonuje one-shot `cudaMalloc` i H2D trzech
dense macierzy. `:2186-2200` uruchamia dense inverse iteration jako
`<<<1,1>>>`, a `:2217-2225` natychmiast zwalnia stan. Mimo to artifact w
`:2249-2273` publikuje `gpu_device_resident_modal_eigensolver=true`.

To może być legalny tiny validation kernel: obliczenia iteracji faktycznie
zachodzą na urządzeniu i nie ma transferu per iteration. Nie jest to jednak
persistent, skalowalny ani produkcyjny eigensolver Poisson-airbox. Wąski
`gpu_dense_k0_macrospin_modal_eigen` oparty o cuSolverDN jest osobnym
zwalidowanym wyjątkiem i nie promuje G5a ani szerszego GPU modal.

#### Natychmiastowa naprawa statusu

1. Zastąpić jeden boolean rozdzielonymi faktami:

   ```text
   operator_storage=device
   eigensolver_iteration_location=device
   persistent_solver_context=false
   scalable_sparse_or_matrix_free=false
   validation_only=true
   production_modal_claim=false
   ```

2. Zmienić lane/adapter na nazwę zawierającą `dense_validation_contract`.
3. Wprowadzić jawny mały limit `augmented_dof_count` i checked dense extents;
   większy problem ma zwrócić `unavailable`, nie próbować alokacji `n^2`.
4. Artifact ma raportować setup H2D/D2H, one-shot allocations, grid size
   `1x1`, supported mode count i brak persistent context.
5. Verifier ma odrzucać `production_modal_claim=true` dla tego adaptera.

#### Droga do rzeczywistego GPU modal eigensolvera

1. Wybrać jawny algorytm i zakres:
   - cuSolverDN tylko dla ściśle ograniczonych dense oracle;
   - GPU sparse/matrix-free Arnoldi/Krylov-Schur/contour dla dużego FEM.
2. Użyć persistent solver context/workspaces, bez alokacji i kopiowania pełnych
   macierzy na każde wywołanie.
3. Podłączyć canonical `L/B`, poprawny complex shift, descriptor Schur i full
   residual z DS-01/10/11.
4. Obsłużyć wiele modów, restart/locking, degeneracje, convergence reasons i
   cancellation.
5. Dla diagonalnej odpowiedzi eigenmodalnej dodać dual/left basis z DS-08;
   nie jest to wymagane dla samego eigenvalue oracle ani innego ROM.
6. Capability promować osobno dla: dense tiny validation, narrow K0
   macrospin, Poisson-airbox k=0 i non-k0 Floquet. Jeden wyjątek nie promuje
   pozostałych.

#### Testy

- schema test odrzuca dawną kombinację `validation_only=true` i
  `production/device-resident claim=true`;
- oversized dense problem failuje przed alokacją;
- setup/per-iteration transfer counters zgadzają się z trace;
- persistent context test nie obserwuje `cudaMalloc/cudaFree` w iteracyjnym
  wywołaniu;
- multi-mode GPU result ma CPU parity i full residual;
- capability matrix zachowuje wąski cuSolverDN K0 wyjątek bez rozszerzania go
  na Poisson/Floquet.

## 8. Tezy już naprawione albo wymagające korekty w stosunku do audytu

Poniższych punktów nie należy ponownie implementować tak, jakby kod ich w
ogóle nie miał. Trzeba zachować istniejące zabezpieczenia podczas dalszych
zmian.

### 8.1. Implementacje solverów istnieją

Repozytorium zawiera m.in. hostowy restarted GMRES, SLEPc modal eigen, Poisson
Schur/full residual helpers i operator CUDA. Ograniczenie „brak `.cpp/.cu`”
było poprawne dla dostarczonego audytorowi pakietu, nie dla tego checkoutu.

### 8.2. Rekonstrukcja residualu Poisson została poprawiona

Obecny kod liczy residuale blokowe i nie wybiera już korzystniejszego minimum
między residualem SLEPc a rekonstrukcją. DS-10 wymaga zachowania tej własności.

### 8.3. Boundary/gauge działa fail-closed

Niezaimplementowane kombinacje Robin/Dirichlet są obecnie odrzucane, a
synthetic pure-Neumann wymaga mean-zero. Nadal brakuje realnego assemblera i
produkcyjnych wariantów BC, ale nie wolno cofnąć fail-closed.

### 8.4. CSR ma już jawne długości

`row_offsets_len`, `column_indices_len` i `values_len` istnieją. DS-24 rozszerza
politykę o canonical CSR i dense capacities; nie zaleca ponownego dodawania
tych samych pól.

### 8.5. Driven phase mismatch jest sprawdzany

Validator wymaga zgodności outer i inner phase convention. Nadal należy
usunąć dublowanie przez kanonizację DS-04.

### 8.6. Driven Floquet sprawdza `phase=-k dot translation`

Ta kontrola istnieje modulo `2*pi`. Brakuje transportu ramek i wspólnej
kanonizacji z modal path, co rozwiązuje DS-19.

### 8.7. Exchange overload z ramkami transportuje współrzędne

Nie należy zastępować go stałym blokiem 2x2. Należy usunąć/ograniczyć overload
bez ramek i utrzymać dedykowany operator DMI.

### 8.8. Publiczny wynik ma sensowny model ownership

Owned `char *` i idempotentny release są poprawnym modelem C ABI. Problemem są
version/size i exception boundaries, nie sama obecność wewnętrznych typów STL.

### 8.9. Produkcyjny GPU driven wykonuje realny solver

Hostowy GMRES ma pełne `V/Z/H`, Givens, restart i recomputed residual. CUDA jest
obecnie operatorem z transferem na każde apply. Nie wolno nazywać tego
device-resident, ale nie wolno też opisywać jako samego probu.

## 9. Plan wdrożenia z checkpointami review

### Workstream 1 — kanoniczna semantyka

Zakres: DS-01 do DS-04.

Checkpoint:

- physics note i typed pencil zatwierdzone;
- brak zmiany wyniku istniejących legalnych CPU fixture'ów;
- eigen, driven i residual używają jednego digestu;
- request conflicts fail przed wyborem backendu.

### Workstream 2 — bezpieczeństwo granic

Zakres: DS-13, DS-21 do DS-24.

Checkpoint:

- ASan/UBSan i ABI size matrix przechodzą;
- żaden unchecked extent na publicznej granicy;
- nowy versioned symbol ABI, stary layout zamrożony;
- exception injection nie kończy procesu.

### Workstream 3 — linearyzacja i interakcje

Zakres: DS-18, DS-25, DS-26.

Checkpoint:

- real mass weights i canonical snapshot digest;
- recomputed `H_eff0` oraz term-by-term derivative parity;
- exchange, PMA, DMI i demag mają wspólne semantics eigen/driven.

### Workstream 4 — eigensolver i modal response

Zakres: DS-05 do DS-12 oraz DS-27 dla osobnego GPU modal readiness.

Checkpoint:

- poprawny complex shift;
- dla diagonalnej ekspansji: left/right/biorthogonality artifact; dla innego
  ROM: jawna trial/test basis i reduced-operator contract;
- count certificate nie odblokowuje response;
- każdy modal point ma original-operator residual i fallback;
- production Poisson claim nadal false, dopóki real FEM convergence nie
  przejdzie.
- G5a raportuje validation-only zamiast ogólnego device-resident claimu.

### Workstream 5 — Floquet i periodyczny Poisson

Zakres: DS-19, DS-20 oraz część DS-10/DS-12.

Checkpoint:

- full FE topology certificate;
- phase + frame transport używane przez wszystkie operacje;
- k=0 parity i `k<->-k` reciprocity;
- pełne residuale q/phi/gauge.

### Workstream 6 — device FGMRES

Zakres: DS-14 do DS-17.

Checkpoint:

- static/run/certificate split;
- bezpieczny probe;
- pełna pętla i workspace device;
- CPU parity, Compute Sanitizer i transfer trace;
- niezależny review przed zmianą capability.

Każdy workstream powinien być osobnym, reviewowalnym zestawem zmian. Nie należy
łączyć przebudowy C ABI, nowego eigensolvera, Floqueta i device FGMRES w jeden
diff.

## 10. Minimalny zestaw testów akceptacyjnych po naprawach

| Test | Lane'y | Warunek akceptacji |
|---|---|---|
| canonical pencil composition | CPU/GPU operator | fused `Aomega` zgodne z `sign*i*omega*B-L` |
| macrospin `alpha=0` | eigen + driven | para `+/-i*omega0`, właściwe `mu0` i `2*pi` |
| macrospin `alpha>0` | eigen + driven | stabilny znak zaniku, peak/linewidth/phase zgodne |
| phase convention duality | wszystkie | wyniki obu fazorów powiązane przez właściwe sprzężenie |
| exchange-only | CPU/GPU | poprawny zero mode i znana dyspersja małego fixture FEM |
| PMA/anizotropia | CPU/GPU | właściwy znak easy-axis/easy-plane i częstotliwość macrospin |
| DMI interfacial/bulk | CPU/GPU | poprawna zmiana znaku i term-by-term derivative parity |
| tangent gauge invariance | eigen + driven | losowe obroty lokalnych ramek nie zmieniają lifted wyniku |
| direct kontra diagonal eigenmodal | CPU | biortogonalny modal odtwarza direct solve i true residual |
| direct kontra rational/Petrov ROM | CPU | reduced operator z dual basis odtwarza direct solve i true residual |
| out-of-window contribution | modal-reduced | enrichment/fallback zamiast fałszywego certificate pass |
| Poisson full kontra Schur | CPU | identyczne `q`, oba residuale blokowe poniżej tolerancji |
| gauge mean-zero kontra pin | CPU | te same wielkości fizyczne i finite eigenfrequencies |
| real FEM airbox convergence | CPU | zbieżność po mesh/airbox refinement bez wstrzyknięcia oracle |
| FGMRES one-step | CPU/device GPU | identity zbiega w jednej iteracji |
| happy breakdown | CPU/device GPU | sukces z true residual, nie singular-basis error |
| zero RHS | wszystkie driven | zero response, zero iteracji albo jawny reject tylko gdy wymagany |
| overflow/fuzz | ABI/CPU/GPU | każdy zawinięty extent odrzucony przed odczytem/alokacją |
| ABI prefix sizes | C/Rust | mniejsze i większe legalne struktury bez OOB |
| Floquet `k=0` | modal + driven | zgodność ze statycznym PBC |
| Floquet `k<->-k` | modal + driven | właściwe parowanie dla realnego problemu |
| GPU transfer trace | device FGMRES | telemetry zgodna z rzeczywistymi checkpoint transfers |
| GPU modal readiness | GPU eigen | tiny/dense, narrow K0 i produkcyjne sparse/matrix-free claims są rozdzielone |

## 11. Wymagane bramki repozytoryjne

Najpierw musi wrócić do zieleni istniejąca managed bramka:

```text
just verify-fem-frequency-domain-native-contract
```

Następnie należy dodać osobne recipes zamiast rozszerzać jeden test
kontraktowy do roli dowodu wszystkiego:

```text
just verify-fem-frequency-domain-modal-reduced-runtime
just verify-fem-frequency-domain-poisson-airbox-production
just verify-fem-frequency-domain-floquet-runtime
just verify-fem-frequency-domain-device-fgmres
just verify-fem-frequency-domain-gpu-modal-production
just verify-fem-frequency-domain-abi-sanitizers
```

Są to nazwy proponowane, nie istniejące obecnie dowody. Każdy recipe musi:

1. używać managed/container runtime;
2. zapisać bounded artifact z revision/build/backend/device/operator digests;
3. wykonać niezależne porównanie, nie tylko sprawdzić `status=ok`;
4. odrzucić stale artifact;
5. nie promować capability na podstawie host-only smoke testu.

## 12. Kryteria promocji poszczególnych lane'ów

### `modal_reduced`

Może stać się dostępny dopiero, gdy istnieją: provenance-bound basis/ROM
certificate, jawna trial/test projection, per-frequency original-operator
residual, adaptive enrichment i full-solver fallback. Jeśli engine używa
diagonalnej ekspansji eigenmodalnej dla nonnormalnego pencilu, dodatkowo wymaga
lewych/prawych modów i biortogonalności. Rational Krylov/Petrov-Galerkin może
spełnić kontrakt przez własną dual basis i zredukowany operator.

### `poisson_airbox_modal_cpu`

Może stać się produkcyjny dopiero po real weak-form FEM assembly, poprawnym
complex shift, finite descriptor handling, full residual reconstruction i
mesh/airbox convergence.

### `gpu_operator_host_krylov`

Może pozostać legalnym osobnym lane'em, jeśli artifact uczciwie raportuje host
Krylov i transfery. Nie wolno aliasować go do device-resident solvera.

### `gpu_device_krylov`

Pozostaje unavailable, dopóki pełna pętla, algebra device, bezpieczny probe,
qualification certificate, Compute Sanitizer i GPU runtime parity nie przejdą.

### `gpu_modal_eigen`

G5a pozostaje dense validation-only i nie może publikować ogólnego
`gpu_device_resident_modal_eigensolver=true`. Wąski cuSolverDN K0 macrospin
pozostaje osobną capability. Poisson-airbox i non-k0 GPU modal wymagają własnych
scalable/persistent runtime gates.

### `floquet_dynamic_demag`

Pozostaje unavailable poza jawnie wąskimi slice'ami, dopóki constraint nie
przenosi frame transport, a demag nie implementuje zgodnego `grad_k/div_k` na
pełnej przestrzeni FE.

## 13. Definicja ukończenia całego programu napraw

Audyt można zamknąć dopiero wtedy, gdy jednocześnie:

- wszystkie A-01 do A-43 mają test regresyjny albo udokumentowane obalenie;
- nie ma aktywnego publicznego P0;
- canonical pencil jest jedynym źródłem `L/B/Aomega`;
- requesty są kanonizowane przed backendem;
- ABI jest size-safe i exception-safe;
- każdy reduced response ma jawny dual/projection contract i true
  residual/backward error; diagonalna ekspansja eigenmodalna dodatkowo ma
  lewe/prawe mody i biortogonalność;
- Poisson-airbox używa realnej słabej formy FEM i poprawnej polityki gauge;
- Floquet przenosi phase oraz tangent-frame transport;
- device FGMRES jest rzeczywiście wykonywany albo nadal uczciwie unavailable;
- wszystkie odpowiadające im managed gates i physics/convergence gates są
  zielone na świeżych artefaktach;
- capability matrix, planner, runtime provenance i dokumentacja opisują ten
  sam stan bez rozszerzania claimu ponad dowód.

## 14. Werdykt końcowy rewalidacji

Dostarczony audyt jest wartościowy i wszystkie jego sześć konkretnych
reproducerów jest poprawnych. Jego końcowy zakaz bezwarunkowego zaufania do
pełnego solvera dynamicznego jest zasadny.

Korekta brzmi: nie wszystkie znalezione problemy są obecnie wykonywanymi P0.
Część jest dormant blockerem niepodłączonego `modal_reduced` albo
`gpu_device_krylov`; część została już częściowo naprawiona; część tez była
skutkiem braku `.cpp/.cu` w przekazanym pakiecie. Jednocześnie bieżący kod ma
dodatkowe aktywne blokery oraz braki promocji, których sam header-only audyt nie
mógł rozstrzygnąć. Aktywne defekty obejmują realny target SLEPc na urojonym
spektrum, publiczny tail-sized C ABI, zerowy RHS w hostowym GMRES, ignorowane
zależności stanu linearyzacji i mylący GPU-G5a readiness claim. Synthetic-only
Poisson assembly jest natomiast fail-closed brakiem promocji, nie dowodem
korupcji aktywnego produkcyjnego lane'u.

Naprawy należy realizować w kolejności z sekcji 6 i 9. Zmiana pojedynczych
warunków walidatora nie wystarczy do naukowej promocji żadnego z lane'ów.

## 15. Mapa dowodów źródłowych na rewizji audytu

Numery linii poniżej odnoszą się do `source_revision` z frontmatter. Mają
ułatwić implementację problem po problemie; przy późniejszych zmianach należy
ponownie wyszukać symbole, a nie ufać starym numerom.

| Remediation | Główne dowody w kodzie |
|---|---|
| DS-01 | `mfem_modal_operator_payload.cpp:190-215`; `driven_response_solver.cpp:4357-4457`; `operator_contract.hpp:68-79` |
| DS-02 | `modal_eigen_request.hpp:16-17,99-100`; `operator_contract.hpp:36`; `excitation.hpp:45` |
| DS-03 | `slepc_modal_eigen.cpp:303-345`; `poisson_airbox_modal_eigen.cpp:1322-1350` |
| DS-04 | `driven_response_solver.cpp:1021-1031,1032-1330`; `modal_eigen_solver.cpp:1215-1516`; `modal_eigen_request.hpp:61-109` |
| DS-05 | `modal_basis.hpp:54-66,136-190`; `frequency_domain_contract.cpp:5915-5956` |
| DS-06 | `modal_basis.hpp:193-252`; `linearization_state.cpp:61-67,295-300` |
| DS-07 | `modal_basis.hpp:136-190`; `modal_response.cpp:141-305`; `frequency_solve_planner.hpp:80-85` |
| DS-08 | `modal_response.hpp:9-27`; `modal_response.cpp:131-188`; `slepc_modal_eigen.cpp:245,313-340` |
| DS-09 | `modal_basis.hpp:54-66`; `modal_eigen_solver.cpp:394-407`; `contour_interval_solver.cpp:1152-1183` |
| DS-10 | `poisson_airbox_modal_eigen.cpp:284-503,711-769,960-1074,1322-1350` |
| DS-11 | `slepc_modal_eigen.cpp:245-252`; `poisson_airbox_modal_eigen.cpp:1263-1269`; `poisson_airbox_schur_matshell.cpp:982-986` |
| DS-12 | `poisson_airbox_modal_eigen.cpp:354-377`; `modal_eigen_solver.cpp:1236-1516`; dokument 19, F-01 i F-02 |
| DS-13 | `gpu_device_krylov.hpp:299-310,375`; `tangent_frame.cpp:53-59`; `production_cpu_driven_response.cpp:725-731`; `driven_response_gpu.cu:1356-1395` |
| DS-14 | `gpu_device_krylov.hpp:62-63,107-118,187-287,313-348` |
| DS-15 | `gpu_device_krylov.hpp:187-258`; `production_cpu_driven_response.cpp:670-733,843-993`; `driven_response_solver.hpp:144` |
| DS-16 | `gpu_device_krylov.hpp:10-14,260-310,443-470`; `frequency_domain_contract.cpp:1768-1780` |
| DS-17 | `gpu_device_krylov.hpp:120-169,423`; `driven_response_solver.cpp:12019-12058`; `driven_response_gpu.cu:1356-1460` |
| DS-18 | `tangent_frame.cpp:53-125`; `operator_terms.cpp:59-99`; `operator_terms.hpp:29-36` |
| DS-19 | `frequency_domain_contract.hpp:35-43`; `driven_response_solver.cpp:15575-15658,15900-15920`; `mesh_symmetry_certificate.hpp:80-85` |
| DS-20 | `mesh_symmetry_certificate.hpp:16-85`; `mesh_symmetry_certificate.cpp:393-399,581-603` |
| DS-21 | `dense_poisson_airbox_eigen_oracle.hpp:17-89`; `dense_poisson_airbox_eigen_oracle.cpp:205-260` |
| DS-22 | `fullmag_fem.h:539-641,686-761`; `api.cpp:1464-1504,2025-2329`; `driven_response_solver.hpp:124-126` |
| DS-23 | `modal_eigen_solver.cpp:1215-1516`; `linearization_state.cpp:83-303`; `api.cpp:765-895` |
| DS-24 | `modal_eigen_request.hpp:30-40,64-80`; `dense_poisson_airbox_eigen_oracle.hpp:23-27`; CSR validators w `poisson_airbox_modal_eigen.cpp:284-503` |
| DS-25 | `linearization_state.hpp:19-65`; `linearization_state.cpp:83-303` |
| DS-26 | `mfem_linearized_operator.cpp:49-340`; `mfem_modal_operator_payload.cpp:105-245`; `driven_response_gpu.cu:1381-1445` |
| DS-27 | `driven_response_gpu.cu:2169-2225,2249-2273`; `capability-matrix-v0.md:110-113`; dokument 19, F-19/F-20 |

Dowody oficjalnych bibliotek użyte do oceny numeryki:

- [SLEPc EPS manual](https://slepc.upv.es/release/documentation/manual/eps.html);
- [SLEPc EPSSetTarget](https://slepc.upv.es/release/manualpages/EPS/EPSSetTarget.html);
- [SLEPc shift-and-invert](https://slepc.upv.es/release/manualpages/ST/STSINVERT.html);
- [SLEPc two-sided eigensolver](https://slepc.upv.es/release/manualpages/EPS/EPSSetTwoSided.html);
- [PETSc FGMRES](https://petsc.org/main/manualpages/KSP/KSPFGMRES/).
<!-- END 20_dynamic_solver_audit_revalidation_and_remediation.md -->

<!-- BEGIN 23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md -->
---
title: Nonzero-k Floquet-airbox CPU/GPU implementation contract
version: target v7 decision-complete
status: normative target with explicit current implementation boundaries
role: scoped_normative_implementation_contract
---

# Nonzero-k Floquet-airbox CPU/GPU implementation contract

## 1. Scope, authority and production boundary

This chapter is the scoped implementation contract for FEM frequency-domain
nonzero-k dynamic demagnetization on an x/y-periodic, open-z shared
magnetic-plus-airbox domain. It covers both `modal_eigen` and
`driven_response`, on CPU and GPU, in double precision.

The authority order is:

1. the phase, field, sign and physical validation semantics in
   [physics note 0828](../../../physics/0828-fem-frequency-domain-floquet-demag.md);
2. the matched-mesh equivalence-class and frame-transport contract in
   [chapter 04](04_mesh_periodic_floquet_airbox.md);
3. the K0 block, unit, BC/gauge, residual and device-residency contract in
   [chapter 18](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md); and
4. this chapter for the ordered nonzero-k CPU/GPU implementation.

This chapter does not redefine the physics notes and does not promote any
capability. It defines the target algorithm and the evidence required to move
an exact scope along independent implementation and validation axes.

### 1.1 Target product signature

```text
discretization = fem
product = modal_eigen | driven_response
k classification = resolved non-Gamma under Section 3's dimensionless tolerance
k unit = rad/m
spin_wave_bc = floquet
magnetostatic_bc = floquet_airbox
dynamic_demag = true
magnetic FE = tangent P1 on Omega_m
potential FE = complex scalar P1 on D = Omega_m union Omega_air
periodic directions = x and y
open direction = z
outer BC = poisson_robin | poisson_dirichlet | pure_neumann
precision = double
```

The first production scope is laterally periodic and open in z. A nonzero
`k_z`, fully periodic three-dimensional demag, nonmatching periodic faces,
higher-order FE spaces and a finite isolated airbox substitution are different
capabilities and are rejected by this contract.

### 1.2 Non-negotiable representation choice

The production operator is backend-owned complex Bloch differential assembly:

```text
grad_k u = grad(u) - i k u
div_k v  = div(v) - i k dot v
```

These signs follow from the canonical boundary phase
`u(r+R)=exp(-i*k dot R)u(r)` and the decomposition of the physical Bloch field
as `u_phys(r)=exp(-i*k dot r)u_cell(r)`. An implementation with opposite signs
uses a different phase convention and is not accepted by relabelling its
artifacts.

The production FE spaces contain cell-periodic amplitudes. Their geometric
periodic reduction uses the accepted equivalence classes: the magnetic
amplitude applies `G_pair`, and the scalar amplitude is periodic. Bloch phase
enters the production operator through `grad_k`/`div_k`, not through a solved
K0 field.

Matched-mesh `C_m(k)` and `C_phi(k)` constraints are an independently
assembled pre-solve oracle. They are required to certify the production
operator over a bounded accepted k domain, but they are not the production
operator, solver, preconditioner or fallback. Raw matrix/action parity is
required only when the oracle and production spaces are connected by the
matching Bloch-enriched basis/interpolation map specified in Section 6. An
ordinary P1 seam-constraint reduction and a periodic-P1 shifted-gradient
discretization generally span different finite-dimensional fields between
nodes; without that matching map, the gate is refinement convergence and
physical-observable parity over the bounded accepted k domain. K0-only
agreement is insufficient in either comparison mode.

## 2. Current status and canonical status axes

No runtime, build, test, example or solver workload was executed for this
documentation change. Current status is therefore bounded by the consumed
canonical documents and must not be promoted from this contract.

Status is always reported on these independent axes:

```text
implementation_state: absent | contract_only | source_visible | executable
validation_state: unvalidated | algebra_validated | physics_validated | production_qualified
validated_scope: bounded workload, signatures, k domain and evidence, or no validated scope
```

`product_status` is a separate compatibility label. In particular,
`partial_production_executable` does not imply `physics_validated` or
`production_qualified`.

| Nonzero-k dynamic-demag slice | implementation_state | validation_state | product_status | validated_scope |
|---|---|---|---|---|
| Complex Bloch `grad_k`/`div_k` production assembly | `contract_only` | `unvalidated` | Not separately classified. | No validated scope: the consumed current-status documents identify numerical FEM dynamic demag-k as a contract gap. |
| Matched-mesh `C_m(k)`/`C_phi(k)` oracle and accepted-domain equivalence certificate | `contract_only` | `unvalidated` | Not separately classified. | No validated scope: pair metadata or phase-projection behavior is not the independent block/action oracle required here. |
| CPU dense `dynamic_demag_k` operator-input bridge | `source_visible` | `unvalidated` | Unavailable. | The native ABI can add a caller-supplied finite block-real matrix to a dense Bloch/Floquet stiffness for a narrow regression oracle. It does not assemble `grad_k`/`div_k`, Poisson, or a physical demag-k operator, and does not promote any public capability. |
| CPU scalar MFEM `P(k)`/`C_phi(k)` form probe | `source_visible` | `unvalidated` | Unavailable. | The native CPU module assembles a bounded `SesquilinearForm` with diffusion, `|k|^2` mass, antisymmetric imaginary Bloch terms, optional Robin mass, an independently assembled real-split scalar `C_phi(k)` from caller-supplied complete DOF classes, a bounded dense `C_phi(k)^H P(k) C_phi(k)` action oracle, and a P1 tangent-frame `C_phi_q(k)` source form with uniform `Ms`. It has no mesh-derived accepted equivalence certificate, manufactured-solution gate, magnetic-region/airbox binding, field recovery, `A_qphi(k)`, or public execution path. |
| CPU `modal_eigen` with `floquet_airbox` dynamic demag | `absent` | `unvalidated` | Unavailable. | No validated scope. Existing no-demag Floquet or K0 Poisson-airbox slices do not satisfy this signature. |
| CPU `driven_response` with `floquet_airbox` dynamic demag | `absent` | `unvalidated` | Unavailable. | No validated scope. Existing K0 provider/Schur response slices do not satisfy this signature. |
| GPU `modal_eigen` with `floquet_airbox` dynamic demag | `absent` | `unvalidated` | Unavailable. | No validated scope. Dense probes and K0 macrospin evidence are not a general device modal engine. |
| GPU `driven_response` with `floquet_airbox` dynamic demag | `absent` | `unvalidated` | Unavailable. | No validated scope. A GPU operator with host Krylov and K0 demag is not nonzero-k device Krylov. |

No row becomes `executable` until its numeric operator and selected engine run
for the exact signature. No row becomes `production_qualified` until every
applicable stage in Sections 9 and 10 passes and `validated_scope` names the
bounded k, mesh, material, BC, product, device and precision envelope.

## 3. K domain, phase and periodic input contract

### 3.1 Canonical k representation

`k_requested` is a finite Cartesian vector in `rad/m`. Let `a_1,a_2` be the
declared oriented lateral primitive vectors and let `b_1,b_2` be the reciprocal
basis satisfying `a_i dot b_j = 2*pi delta_ij`. Decompose the lateral request as

```text
k_requested,lateral = xi_requested,1 b_1 + xi_requested,2 b_2
```

The decomposition is solved from the declared basis, not component-wise in the
Cartesian axes. Canonicalization uses the half-open reciprocal cell
`[-1/2,1/2)` in each fractional coordinate:

```text
n_i = floor(xi_requested,i + 1/2)
xi_resolved,i = xi_requested,i - n_i
G_wrap = n_1 b_1 + n_2 b_2
k_resolved,lateral = k_requested,lateral - G_wrap
```

Thus a positive half-cell tie `xi=+1/2` is represented as `-1/2` with the
reciprocal shift incremented, while `xi=-1/2` remains included. The equivalent
phase convention is half-open `[-pi,pi)`: `+pi` is canonicalized to `-pi`, and
`-pi` remains `-pi`. This tie policy is part of the operator signature.

The planner stores `k_requested`, `xi_requested`, `G_wrap`, `xi_resolved` and
`k_resolved`; canonicalization never overwrites requested intent. For this
x/y-periodic, open-z contract define

```text
L_ref = max(norm(a_1),norm(a_2))
kz_measure = abs(k_requested dot e_z) L_ref
kz_tolerance_dimensionless = 1.0e-12
gamma_measure = max(abs(xi_resolved,1),abs(xi_resolved,2))
gamma_tolerance_fractional = 1.0e-12
```

If `kz_measure` exceeds its tolerance, the separate validation family in
Section 11 rejects the request; otherwise resolved `k_z` is canonicalized to
zero. If `gamma_measure <= gamma_tolerance_fractional`, the resolved vector is
canonicalized to exact Gamma and belongs to chapter 18's K0 contract before a
nonzero-k engine is selected. Otherwise it is nonzero-k. No planner or runtime
branch uses an exact magnitude or component comparison to classify Gamma.
This is deterministic request classification, not runtime fallback. Once a
nonzero-k plan is accepted, it must not snap, clamp or replan to K0.

The accepted k domain is part of the operator-parity and production
qualification certificate. It records:

```text
primitive lattice vectors and reciprocal basis
requested/resolved Cartesian and fractional k bounds or explicit sample set
half-open reciprocal-cell and pi/-pi tie policy
Gamma and k_z dimensionless tolerances
reciprocal shift G_wrap
mesh and FE-order signature
material, equilibrium and tangent-frame signatures
outer-boundary and scalar-space signature
phase convention and phase tolerance
```

Claims outside that exact domain remain unvalidated even if the same engine is
executable there.

### 3.2 Phase wrapping and cycle tolerance

For every lattice translation `R`, compute in double precision:

```text
theta_raw = k_resolved dot R
theta = theta_raw - 2*pi*floor((theta_raw+pi)/(2*pi)) in [-pi,pi)
phase = exp(-i*theta)
phase_wrap_tolerance_rad = 1.0e-10
```

The `+pi -> -pi` tie rule is the same rule used for reciprocal fractional
coordinates. Implementations must correct only final-roundoff excursions at an
endpoint back into `[-pi,pi)`; they may not choose the opposite representative.

Path and corner phases agree only when
`abs(wrap_to_half_open_pi(theta_a-theta_b)) <= phase_wrap_tolerance_rad`. The mesh
certificate is admissible at a resolved k only when its translation
uncertainty satisfies
`norm(k_resolved)*translation_residual_max_m <= phase_wrap_tolerance_rad/4`; numerical
phase evaluation and cycle closure consume the remaining tolerance. The
corresponding complex-phase check uses
`abs(phase_a-phase_b) <= 2*sin(phase_wrap_tolerance_rad/2)` plus double-roundoff
slack of `64*machine_epsilon`.

This tolerance certifies phase equivalence only. It never changes the requested
k, never converts a nonzero-k operator into K0 and never relaxes matrix/action
or physical validation tolerances.

### 3.3 Required matched topology

The input contains complete, independently hashed equivalence classes for:

- tangent magnetic DOFs on `Omega_m`, including representative-to-member
  lattice translations and `G_pair=T_dst^T R_orient T_src`; and
- scalar-potential DOFs on the full shared domain `D`, including every lateral
  magnetic and airbox side-face class.

Corners and edges have one path-independent representative. Magnetic and
scalar classes use the same lattice basis and phase convention but remain
different FE-space objects. Missing scalar airbox coverage cannot be inferred
from magnetic classes. Missing magnetic frame transport cannot be replaced by
scalar phase-only constraints.

## 4. Production complex Bloch operator

### 4.1 Domains, unknowns and physical field

Let `Omega_m` be the magnetic region and
`D=Omega_m union Omega_air` the conformal shared magnetostatic domain. The
production unknowns are periodic cell amplitudes, while physical Bloch fields
carry the phase explicitly:

```text
q_cell in C^(2 N_m), phi_cell in C^(N_phi)
delta_m_cell = T q_cell                 on Omega_m
delta_M_cell = Ms delta_m_cell          on Omega_m

q_phys(r) = exp(-i*k_resolved dot r) q_cell(r)
delta_m_phys(r) = exp(-i*k_resolved dot r) delta_m_cell(r)
phi_phys(r) = exp(-i*k_resolved dot r) phi_cell(r)
delta_M_phys(r) = exp(-i*k_resolved dot r) delta_M_cell(r)

grad(phi_phys) = exp(-i*k_resolved dot r) grad_k(phi_cell)
delta_H_demag,phys = -exp(-i*k_resolved dot r) grad_k(phi_cell)
j_n,phys = n dot grad(phi_phys)
         = exp(-i*k_resolved dot r) n dot grad_k(phi_cell)

div_k(grad_k(phi_cell)) = div_k(delta_M_cell) on Omega_m
div_k(grad_k(phi_cell)) = 0                   on Omega_air
```

Here `grad_k=grad-i*k_resolved` and `div_k=div-i*k_resolved dot`. This is the
phase/sign convention of physics note 0828. In particular, the flux used for a
physical seam check is `n dot grad_k(phi_cell)` with the reconstructed Bloch
factor; raw `n dot grad(phi_cell)` is not the physical flux.

`q_cell` and magnetic test functions do not exist in `Omega_air`. The air region
contributes to the scalar Poisson block, its open-z boundary term and field
reconstruction, but has no `Ms delta_m` source. `Ms`, equilibrium, materials,
region maps and tangent frames come from one accepted linearization signature;
no expected dispersion or analytical frequency may enter assembly.

### 4.2 Complex scalar weak form

With the sesquilinear convention conjugate-linear in the test argument, define
`g_k=grad_k`. For scalar basis functions `Psi_i` on D:

```text
P_ij(k) = int_D conjugate(g_k Psi_i) dot (g_k Psi_j) dV
        + beta int_Gamma_open_z conjugate(Psi_i) Psi_j dS

(C_phi_q(k) q)_i
  = int_Omega_m Ms (T q) dot conjugate(g_k Psi_i) dV

A_phiq(k) = -C_phi_q(k)
P(k) phi = C_phi_q(k) q
```

This is the weak form of the canonical magnetostatic relation with
`delta_H_demag,phys=-exp(-i*k dot r)grad_k(phi_cell)`. The signs are identical
to chapter 18 at K0. Multiplying a complete scalar row by a documented nonzero
scale is legal only when residual reconstruction maps back to these original
signs and units.

The potential-to-magnetic coupling is assembled from the same element
geometry, quadrature, `Ms`, tangent frames and phase convention:

```text
p^H A_qphi(k) phi_cell
  = int_Omega_m v_h dot
    [-gamma0 m0 x (-grad_k(phi_cell,h))] dV
```

The pre-LLG field/source pair must pass the complex adjoint-energy identity
before the LLG cross-product projection. `A_qphi(k)` is not declared equal to
`A_phiq(k)^H`, because their row units and the dynamic projection differ.

### 4.3 Full modal and driven blocks

The production assembler emits:

```text
A(k) = [A_qq(k)    A_qphi(k)]
       [A_phiq(k)  P(k)     ]

B(k) = [B_qq(k)  0]
       [0        0]

modal:  A(k) x = lambda B(k) x, lambda = i omega
driven: (i omega B(k)-A(k)) x = [b_q,b_phi]
x_cell = [q_cell,phi_cell]
```

`A_qq(k)` contains every admitted non-demag tangent derivative assembled with
the same Bloch convention, including k-dependent exchange and any explicitly
qualified nonreciprocal term. Dynamic demag is represented only by
`A_qphi(k)`, `A_phiq(k)` and `P(k)` and is not duplicated in `A_qq(k)`.
`B_qq(k)` uses the accepted tangent mass/gyrotropic contract and matching
periodic reduction. Later block formulas may abbreviate `q_cell,phi_cell` as
`q,phi`; no such abbreviation changes them into physical fields.

For pure Neumann open-z faces at resolved nonzero lateral k, the `|k|^2` part
of `P(k)` removes the constant-potential nullspace; no gauge row is added. The
exact K0 limit changes to chapter 18's `mean_zero_augmented` tuple. Solver code
must derive nullspace and gauge from the assembled BC/k tuple, not from the
word `periodic`.

### 4.4 SI units

| Quantity | Unit | Required consequence |
|---|---|---|
| `k` | `rad/m` | `k dot R` is a dimensionless phase in radians. |
| `q`, magnetic test coefficient | `1` | normalized tangent perturbation |
| `phi` | `A` | `-grad_k(phi)` is `A/m`. |
| `P(k)` | `m` | `P(k) phi` is `A m`. |
| `C_phi_q(k)`, `A_phiq(k)` | `A m` per unit `q` | same scalar-row unit as `P(k) phi` |
| `A_qphi(k)` | `m^3/(A s)` | `A_qphi(k) phi` is `m^3/s`. |
| `A_qq(k)` | `m^3/s` | magnetic dynamic row |
| `B_qq(k)` | `m^3` | `lambda B_qq(k) q` is `m^3/s`. |
| `b_q` | `m^3/s` | projected physical magnetic drive |
| `b_phi` | `A m` | explicitly typed scalar RHS |
| `beta` | `1/m` | Robin surface term has scalar-block unit `m`. |

The solver may scale rows and unknowns using chapter 18's common block scaling,
but matrix/action parity and final residual certification are computed in the
original unscaled physical blocks.

## 5. Open-z outer boundary and K0 limit

### 5.1 Boundary ownership

The only open boundary facets in this contract are the top and bottom z faces,
denoted `Gamma_open_z`. Lateral x/y cuts are Floquet interfaces and receive no
Robin mass, Dirichlet elimination or isolated-airbox boundary treatment.

| `outer_boundary_kind` | Nonzero-k scalar contract |
|---|---|
| `poisson_robin` | finite `beta>0` in `1/m`; apply the Robin integral once on `Gamma_open_z` only; `gauge_policy=none` |
| `poisson_dirichlet` | `beta=0`; eliminate only reduced classes touching declared `Gamma_open_z`; `gauge_policy=none` |
| `pure_neumann` | `beta=0`; no open-z boundary term; for resolved nonzero lateral k, `gauge_policy=none` because `P(k)` is coercive |

Applying Robin to periodic cuts changes the physical problem and rejects the
operator. Applying a mean-zero projection to a coercive nonzero-k scalar block
also changes the operator and rejects it. A fully periodic 3D request is
outside this contract.

### 5.2 Exact and limiting K0 parity

The Bloch assembler must be callable by validation at exactly `k=(0,0,0)`.
For Robin and Dirichlet it must satisfy, under canonical ordering and scaling:

```text
A_qq(k=0)   = A_qq_K0
A_qphi(k=0) = A_qphi_K0
A_phiq(k=0) = A_phiq_K0
P(k=0)      = P_K0
B_qq(k=0)   = B_qq_K0
```

Equality means matrix parity for assembled fixtures and action parity for
matrix-free fixtures, including signs, eliminated DOFs, reconstructed fields
and original block residuals. Pure Neumann parity includes the explicit K0
nullspace transition: the nonzero-k block converges to the singular K0 block,
and the K0 solve is compared only after chapter 18's mean-zero augmentation is
applied.

Selected spectra and driven responses must converge to the qualified Task 6
K0 results as `norm(k)` approaches zero from accepted directions. A
discontinuous engine switch, K0 substitution at finite k or post-filtered
agreement does not satisfy this gate.

## 6. Independent matched-mesh constraint oracle

### 6.1 Oracle maps

The oracle is built independently from the complete equivalence classes on an
unreduced matched mesh. Its ordinary P1 coefficients are samples of the
physical Bloch fields, not the periodic production amplitudes. For each
representative-to-member translation `R`:

```text
C_m(k): exp(-i*k dot R) plus tangent G_pair
C_phi(k): exp(-i*k dot R)

q_full = C_m(k) q_reduced
phi_full = C_phi(k) phi_reduced
C(k) = block_diag(C_m(k),C_phi(k))
```

Every magnetic and scalar entry uses the same wrapped `k dot R`, phase sign and
tolerance. `C_m(k)` additionally applies the certified `G_pair`; `C_phi(k)` is
phase-only. Real-split implementations use the exact 2x2 phase block and do
not discard the imaginary coupling.

The oracle reduces every block before solving:

```text
A_qq(k) = C_m(k)^H A_qq C_m(k)
A_qphi(k) = C_m(k)^H A_qphi C_phi(k)
A_phiq(k) = C_phi(k)^H A_phiq C_m(k)
P(k) = C_phi(k)^H P C_phi(k)
B_qq(k) = C_m(k)^H B_qq C_m(k)

b_q(k) = C_m(k)^H b_q
b_phi(k) = C_phi(k)^H b_phi

A_oracle(k) = C(k)^H A_full C(k)
B_oracle(k) = C(k)^H B_full C(k)
```

These names describe oracle-reduced blocks in this section. Production blocks
with the same mathematical names come from direct `grad_k`/`div_k` assembly.
Their construction paths, signatures and hashes remain separate so a shared
bug cannot pass as independent parity.

Raw algebra comparison is legal only when the certificate declares matching
Bloch-enriched maps `J_m(k),J_phi(k)` from production cell-amplitude
coefficients to oracle physical-field coefficients and proves basis-function
and quadrature-point identity, not merely nodal interpolation:

```text
x_oracle = J(k) x_cell
J(k) = block_diag(J_m(k),J_phi(k))
A_production(k) = J(k)^H A_oracle(k) J(k)
B_production(k) = J(k)^H B_oracle(k) J(k)
```

The transformed equalities include canonical ordering, eliminated DOFs, row
scaling and adjoint convention. A map that multiplies only nodal values by
`exp(-i*k dot r)` does not establish this identity for ordinary P1 functions
inside an element. When no matching Bloch-enriched map exists, raw matrix and
action entries between the two discretizations are not an acceptance gate.

### 6.2 Pre-solve equivalence certificate

Before a production scope is promoted, the oracle and production assembler
must generate a `FloquetOperatorParityCertificate` keyed by:

```text
equilibrium, mesh, magnetic/scalar equivalence classes, material, physics,
outer boundary, FE order, quadrature, tangent frames, block ordering,
block scaling, precision, phase convention, phase tolerance,
accepted k domain, production assembler identity and oracle identity
```

The certificate declares exactly one cross-form comparison mode:

- `matching_bloch_basis_raw_parity`: record `J_m(k),J_phi(k)` identities and
  errors for every transformed block and seeded full action; or
- `ordinary_p1_refinement_observable_parity`: record a minimum of three nested
  mesh levels, each discretization's independent convergence rate and their
  converged physical-observable differences over the bounded k samples.

Both modes contain, at each required k sample:

- block dimensions, basis/interpolation signatures and comparison-mode
  eligibility;
- magnetic source, scalar potential, physical normal flux and reconstructed
  Cartesian demag-field comparisons;
- modal eigenvalue-cluster/invariant-subspace or driven transformed-observable
  comparisons, as applicable;
- Robin/Dirichlet/pure-Neumann policy and K0-limit parity;
- original unscaled `eps_q`, `eps_phi` and `eps_full` parity; and
- independent negative controls for phase sign, coupling sign, missing
  `G_pair`, scalar phase omission and Robin-on-periodic-cut contamination.

The accepted k samples include exact K0, both signs of every qualified axial
and oblique direction, interior points, reciprocal-cell boundaries admitted
by policy and the DE/BV points used for physics qualification. Adaptive or
continuous-domain claims additionally require a declared interpolation/error
bound; finite sample success alone qualifies only the sampled set.

The production and constrained forms may be called raw-algebra equivalent only
in `matching_bloch_basis_raw_parity` mode after the transformed matrix/action
checks pass over the accepted k domain. In
`ordinary_p1_refinement_observable_parity` mode they may be called convergent
physical oracles only after both refinement sequences and bounded observable
comparisons pass; raw equality must not be claimed. The certificate may be
cached only under its exact key. A changed k domain, mesh, material, boundary,
phase policy, comparison mode, assembler or oracle invalidates it before the
next solve.

### 6.3 Oracle boundary

The oracle is a bounded correctness reference. It may use explicit matrices
or a bounded direct solve, but it never becomes:

- the production `grad_k`/`div_k` operator;
- a replacement when production assembly is absent;
- a scalable CPU/GPU solver claim;
- a postsolve repair of a K0 result; or
- capability evidence outside its certified signature and k domain.

## 7. Residual, continuity and solver acceptance

For every modal candidate, reconstruct the original unscaled production state
and compute:

```text
r_q = A_qq(k) q + A_qphi(k) phi - lambda B_qq(k) q
r_phi = A_phiq(k) q + P(k) phi

eps_q = norm(r_q) /
  (norm(A_qq(k)q) + norm(A_qphi(k)phi)
   + abs(lambda) norm(B_qq(k)q) + eps)

eps_phi = norm(r_phi) /
  (norm(A_phiq(k)q) + norm(P(k)phi) + eps)

eps_full = max(eps_q,eps_phi)
```

For driven response, form the residual directly from
`(i omega B(k)-A(k))x-b` and include the applicable RHS norm in each block
denominator. Backend, transformed, preconditioned, Schur and tracked Krylov
residuals are diagnostics only and cannot cap or replace `eps_full`.

Accepted production cell amplitudes first satisfy periodic cell checks on the
matched mesh:

```text
max_pair norm(q_cell,dst - G_pair q_cell,src) <= eps_q_cell_pair
max_pair abs(phi_cell,dst - phi_cell,src) <= eps_phi_cell_pair
max_pair abs(n_dst dot grad_k(phi_cell)_dst
             + n_src dot grad_k(phi_cell)_src) <= eps_flux_cell
```

The reconstructed physical fields, and the ordinary-P1 seam oracle directly,
satisfy the Bloch checks:

```text
phase = exp(-i*k_resolved dot R)
max_pair norm(delta_m_phys,dst
              - phase R_orient delta_m_phys,src) <= eps_dm_phys
max_pair norm(q_phys,dst - phase G_pair q_phys,src) <= eps_q_phys_pair
max_pair abs(phi_phys,dst - phase phi_phys,src) <= eps_phi_phys_pair
max_pair abs(n_dst dot grad(phi_phys)_dst
             + phase n_src dot grad(phi_phys)_src) <= eps_flux_phys
```

For production reconstruction the final line is evaluated from
`exp(-i*k_resolved dot r) n dot grad_k(phi_cell)`. The phase must not be applied
a second time to `grad_k(phi_cell)`, and `grad(phi_cell)` cannot replace it.

### 7.1 Qualified k <-> -k gates

No reciprocal equality follows merely from the absence of DMI. A `k <-> -k`
gate exists only when the fixture declares a map `S` that sends the complete
`+k` physical problem to the `-k` problem and the validator proves equality,
under that map, of the geometry, material tensors, equilibrium, tangent-frame,
interaction and open-z/Floquet boundary signatures. The declaration states
whether `S` is linear or anti-linear and includes every required vector,
pseudovector, orientation and complex-conjugation transformation.

Modal comparisons match frequency clusters and invariant subspaces first, then
track branches continuously; index-by-index eigenvalue sorting is not a
reciprocity test. Driven comparisons use transformed pairs
`b_- = S_drive b_+` and `ell_- = S_observe ell_+` and compare
`ell_-^H x_-` with the symmetry-predicted transform of `ell_+^H x_+`. Reusing
an untransformed drive or observation is not a valid gate.

The simple reciprocal fixture is exchange-only with a declared symmetry map.
Any fixture with local anisotropy, dipolar coupling, interfaces, texture,
external bias, DMI or another term must either provide and certify its complete
problem-specific symmetry map or make no `+k/-k` equality claim. Without a
qualified map, signed-k branches and driven observables are validated
independently; expected nonreciprocity may be checked, but reciprocity is not
assumed.

Modal acceptance additionally uses chapter 18's finite-mode, branch, window,
normalization and completeness rules. Driven acceptance uses the same physical
field-to-tangent RHS conversion as K0 and certifies every accepted frequency
point. A solver convergence reason without original-operator and seam
certification is not acceptance.

## 8. No projection and no fallback policy

Applying phase to a solved K0 vector, scalar potential, viewport field, mode
profile or exported artifact is a postsolve phase projection. A postsolve phase
projection is not an operator and cannot satisfy exchange, DMI, scalar Poisson,
dynamic demag, modal or driven operator gates.

The following substitutions are forbidden for every accepted nonzero-k
dynamic-demag request:

- K0 periodic-airbox blocks or providers;
- finite isolated/open lateral boundaries;
- synthetic algebraic operators or labels without numeric block actions;
- magnetic-only phase handling without the scalar-potential phase;
- the matched-mesh oracle as the selected production operator; and
- CPU execution for a strict GPU request.

Strict CPU or GPU requests have no fallback. A non-strict auto request may
select another already legal engine only before execution, for the identical
nonzero-k physical operator and product, and must publish requested/resolved
engine plus `fallback_reason`. It may not change k, dynamic-demag intent,
boundary policy, product, precision or discretization. In particular, no
fallback to K0, open boundaries, synthetic operators or CPU for strict GPU is
legal.

## 9. Ordered CPU implementation stages

Stages are cumulative. A later implementation may exist behind a probe, but no
scope promotes until every predecessor gate for that scope passes.

### NK-P1: no-demag exchange/local phase parity

**Input:** accepted linearization, P1 magnetic mesh/classes, tangent frames,
canonical nonzero k and no dynamic demag.

**Implementation:** assemble production complex Bloch local, exchange and each
explicitly admitted nonreciprocal magnetic term in `A_qq(k)`, with matching
`B_qq(k)`. Build the independent `C_m(k)` oracle action from the same physical
problem but a separate assembly path.

**Gate:** raw matrix/action parity at K0 and at `+k`, `-k`, axial and oblique
samples only when the Section 6 matching Bloch-enriched map exists; otherwise
both discretizations pass bounded refinement and physical-observable parity.
Independent local SO(2) tangent-frame rotations preserve spectra and
reconstructed Cartesian fields. The simple `f(k)=f(-k)` and response gate is
exchange-only and consumes the declared Section 7.1 symmetry map, cluster or
branch matching and transformed drive/observation pair. Additional terms may
use a reciprocal gate only with their own complete qualified symmetry map;
absence of DMI alone is insufficient.

### NK-P2: scalar Poisson manufactured Bloch solution

**Input:** accepted scalar equivalence classes on the full shared domain, each
open-z BC tuple and manufactured complex Bloch potential/source pairs.

**Implementation:** assemble `P(k)` and `C_phi_q(k)` using `grad_k`/`div_k`;
assemble an independent `C_phi(k)^H P C_phi(k)` oracle; recover
`-grad_k(phi)` and paired lateral flux.

**Gate:** P1 convergence order, field/source sign, complex phase continuity,
opposite-normal flux relation, open-z Robin placement, Dirichlet elimination,
nonzero-k pure-Neumann coercivity and exact K0 gauge transition all pass.
Phase-sign and Robin-on-periodic-cut negative controls fail.

### NK-P3: full dynamic demag-k assembly

**Input:** NK-P1/P2 outputs, `Ms`, static accepted equilibrium and common block
scaling.

**Implementation:** assemble numeric `A_qphi(k)`, `A_phiq(k)` and `P(k)` with
the production complex Bloch differential forms; combine them with
`A_qq(k)`/`B_qq(k)` into the full descriptor and driven operator. Build all
five oracle-reduced blocks independently.

**Gate:** complex adjoint-energy and demag sign checks pass. With a matching
Bloch-enriched map, every transformed block and the full modal/driven action
pass accepted-domain raw parity. Without it, ordinary-P1 oracle and production
sequences pass refinement and bounded physical-observable parity instead.
Reconstructed Cartesian `delta_H_demag` and physical normal flux agree; a
sign-flip negative control fails. A payload kind, diagnostics label or phase
metadata without executable numeric blocks fails with
`missing_numeric_fem_demag_k`.

### NK-P4: CPU selected spectrum and driven response

**Input:** NK-P3 operator, user-requested frequency window/count or frequency
sweep and physical drive.

**Implementation:** use chapter 18's complex selected-spectrum and full or
certified-Schur CPU algorithms with k in the exact problem signature.
Frequency-independent Bloch assembly and Poisson setup may be reused only for
unchanged k; every changed k creates or selects the matching keyed operator and
preconditioner state.

**Gate:** finite selected modes, window completeness, modal reconstruction,
driven full residuals, modal/driven resonance cross-checks and full-versus-
certified-Schur samples pass. Oracle solves remain independent verifier inputs
and do not select modes, targets or solver success.

### NK-P5: DE/BV dispersion and K0 limit

**Input:** qualified Damon-Eshbach (DE) and backward-volume (BV) film fixtures,
multiple mesh levels, independent z-padding levels and a signed k path that
includes the K0 limit.

**Implementation:** produce modal dispersion and driven-response observables
from the NK-P4 production operator only. Analytical or semi-analytical DE/BV
references are postsolve verifier inputs.

**Gate:** mesh and airbox-padding convergence, demag field/energy sign,
selected modal/driven agreement, DE and BV branch behavior, exact `A(k=0)`
parity and the `k -> 0` spectrum/response limit pass. Any `k <-> -k` equality
uses Section 7.1's declared complete symmetry map, signature equality,
cluster/branch matching and transformed drive/observation pairs. Absence of DMI
or another named nonreciprocal term is not sufficient. Without the map,
validate signed branches independently and, where specified, the expected
nonreciprocity rather than forcing symmetry.

CPU promotion is bounded to the products, k domain, materials, BCs and solver
engines evidenced by NK-P1 through NK-P5. Passing one product does not promote
the other.

## 10. Ordered GPU implementation stages

GPU stages consume the exact CPU-qualified blocks and signatures. GPU support
is a separate realization of the same physics contract; it does not redefine
signs, units, k, phase, BC, residual or validation semantics.

### NK-G1: complex constraint and production-operator apply parity

Create a persistent GPU operator context containing the production
`grad_k`/`div_k` actions, complex scalar representation, magnetic/scalar maps,
`G_pair`, materials, tangent frames, blocks/scaling and reusable work vectors.
Implement device `C_m(k)`, `C_m(k)^H`, `C_phi(k)` and `C_phi(k)^H` oracle probes
with the same phase as CPU.

The gate requires double-precision CPU/GPU parity for each production block,
the full modal/driven action, every complex constraint/adjoint action and
reconstructed Cartesian fields at the accepted k samples. Missing either
magnetic or scalar complex constraints rejects; one phase implementation may
not stand in for both maps without their independent dimensions and actions.

### NK-G2: device Poisson and shifted-solve parity

Create persistent PETSc/hypre/libCEED/CUDA scalar and shifted-solve state for
the exact problem/k signature. Repeated `P(k)` solves and modal/driven shifted
actions reuse allocations and preconditioner setup according to the declared
policy.

The gate requires CPU/GPU solution, contraction, original scalar residual,
open-z BC, recovered field and shifted-action parity. Setup H2D and final D2H
are counted; per-iteration matrix/vector migration, hidden host factorization
or host preconditioner state fail the device-solve claim.

### NK-G3: persistent modal and driven device Krylov

`gpu_modal_device_krylov` owns PETSc CUDA vectors, SLEPc Krylov-Schur/Arnoldi
state, device shifted solves, Ritz vectors, orthogonalization and restart state.
`gpu_device_krylov` owns PETSc KSP GMRES/FGMRES vectors, preconditioner,
restart and convergence state. Both consume the NK-G2 context and certify the
original full blocks before final export.

The gate requires correct stop reasons, restart behavior, finite-mode/window
completeness or driven convergence, original residuals and zero per-iteration
H2D/D2H transfer counts. A GPU operator callback driven by host Krylov remains
`gpu_operator_host_krylov` and cannot pass NK-G3.

### NK-G4: DE/BV CPU/GPU parity and transfer audit

Run the NK-P5 qualified DE/BV and K0-limit scopes with identical CPU/GPU
problem bundles. Compare frequency clusters, invariant subspaces for
degeneracies, driven complex observables, reconstructed fields, residuals,
iteration/contraction behavior and accepted/rejected outcomes.

The transfer audit records:

```text
krylov_vector_location=device
operator_buffer_location=device
preconditioner_buffer_location=device
setup_h2d_transfer_count
final_d2h_transfer_count
per_iteration_h2d_transfer_count=0
per_iteration_d2h_transfer_count=0
operator_apply_count
preconditioner_apply_count
krylov_iteration_count
restart_count
```

Any hidden CPU solve, host Krylov state, per-iteration migration, changed
physical signature or product-specific mismatch fails NK-G4. Modal and driven
GPU scopes promote independently.

## 11. Exact rejection reasons and precedence

The six tokens below are the target absent-operator/capability vocabulary after
a request has passed the separate input-validation family. They do not cover
malformed units, unsupported `k_z`, invalid BCs, incompatible meshes or
unsupported FE order. The planner emits one target canonical primary token;
supporting diagnostics and compatibility aliases may not replace it.

| Order | Exact token | Trigger | Native status | Fallback |
|---|---|---|---|---|
| 1 | `missing_floquet_pair_equivalence_classes` | a valid matched-mesh request reaches capability resolution but complete accepted magnetic or scalar representative classes, lateral airbox coverage or cycle certificate support is absent | `unavailable` | none |
| 2 | `missing_floquet_magnetic_constraint_operator` | `C_m(k)` or its adjoint cannot be built with the required phase and `G_pair`, or dimensions/signature disagree | `unavailable` | none |
| 3 | `missing_floquet_scalar_constraint_operator` | `C_phi(k)` or its adjoint cannot be built over the full scalar airbox space with the same phase convention | `unavailable` | none |
| 4 | `missing_numeric_fem_demag_k` | a legal nonzero-k demag request lacks executable numeric production `grad_k`/`div_k` blocks/actions; labels, K0 providers and postsolve projection do not count | `unavailable` | none |
| 5a | `nonzero_k_gpu_modal_operator_unavailable` | strict GPU `modal_eigen` lacks any required device production block, scalar/shifted solve, persistent modal Krylov state or applicable Section 6 certificate | `unavailable` | none; never CPU |
| 5b | `nonzero_k_gpu_driven_operator_unavailable` | strict GPU `driven_response` lacks any required device production block, scalar/shifted solve, persistent driven Krylov state or applicable Section 6 certificate | `unavailable` | none; never CPU |

Before this table, request validation uses a separate exact family:

| Validation token | Trigger |
|---|---|
| `invalid_floquet_k_units` | k is not finite or cannot be converted unambiguously to `rad/m` |
| `unsupported_floquet_kz` | Section 3's dimensionless `kz_measure` exceeds its tolerance |
| `invalid_floquet_open_z_boundary_condition` | open direction, Robin/Dirichlet/Neumann tuple, beta unit/sign or facet ownership is invalid |
| `invalid_floquet_periodic_mesh` | declared lattice, matched-face topology, orientation, cycle closure or magnetic/airbox coverage is internally invalid |
| `unsupported_floquet_fe_order` | magnetic or scalar FE order is outside this P1 contract |

These return `validation_error` and reject before capability/operator
selection. They are not aliases of the six absent-operator reasons. Numeric
assembly/action failure after a legal capability plan returns `operator_error`;
if no executable numeric demag-k operator remains, its canonical capability
reason is `missing_numeric_fem_demag_k`. Krylov convergence or
original-residual failure is `solve_error`; it is never converted into a
capability fallback.

For strict GPU, the two product-specific GPU tokens take precedence only after
the shared topology, constraint-oracle and numeric production-demag-k
prerequisites exist. This prevents a GPU token from hiding a missing common
physics operator.

### 11.1 Current-to-target compatibility migration

The current native vocabulary remains visible during consumer migration, but
it is not the target primary-reason contract:

| Current product path | Current emitted fields | Target canonical primary | Compatibility behavior |
|---|---|---|---|
| CPU modal nonzero-k with demag | `unsupported_reason=production_cpu_modal_dynamic_demag_k_operator_missing`; `dynamic_demag_operator_source=missing_numeric_fem_demag_k` | `missing_numeric_fem_demag_k` while the common numeric operator is absent | retain the current primary as a compatibility alias and retain the source-detail field |
| CPU driven Floquet-airbox demag-k | `unsupported_reason=floquet_airbox_dynamic_demag_k_unimplemented` | `missing_numeric_fem_demag_k` while the common numeric operator is absent | retain the current unsupported reason as a compatibility alias |
| strict GPU driven Floquet-airbox demag-k | `unsupported_reason=floquet_airbox_dynamic_demag_gpu_unsupported` | `missing_numeric_fem_demag_k` until the common operator exists; then `nonzero_k_gpu_driven_operator_unavailable` while only the device realization is absent | retain the current unsupported reason as a compatibility alias in both phases |

The target envelope emits `primary_rejection_token=<canonical token>` and
`compatibility_aliases=[...]`. Existing legacy fields may continue to carry
their current values until their consumers migrate, but new consumers key on
`primary_rejection_token`. The same precedence applies to strict GPU modal:
`missing_numeric_fem_demag_k` while the common operator is absent, then
`nonzero_k_gpu_modal_operator_unavailable` when only the device modal
realization is absent. The other three shared target tokens are emitted at
their corresponding capability-resolution stage with any superseded spelling
listed only as an alias. Removing aliases requires an explicit schema/version
cutover; this documentation change does not change native code.

## 12. Required artifacts and provenance

Every attempt preserves available requested/resolved provenance and the exact
primary rejection token. A successful scope publishes at least:

| Area | Required fields or evidence |
|---|---|
| Intent | product, immutable requested k and canonical resolved k in `rad/m`, requested/resolved fractional coordinates, reciprocal shift, requested/resolved device, precision, method and strictness |
| Phase | `exp(-i*k dot R)`, half-open reciprocal-cell mapping, pi/-pi tie convention, primitive/reciprocal basis, Gamma/kz/phase tolerances and accepted k domain |
| Inputs | equilibrium, mesh, material, physics, tangent-frame, magnetic-class and scalar-class hashes |
| Production assembly | `assembly_kind=mfem_complex_bloch_grad_div_shared_domain`, FE order, quadrature, canonical maps/orderings, all block/scaling hashes |
| Oracle | `C_m(k)`/`C_phi(k)` identities, independent oracle identity, comparison mode, optional matching `J_m(k)`/`J_phi(k)` identities, parity-certificate key, sampled k/refinement set and raw-parity or convergence/observable errors |
| BC | open direction, open-z facets, boundary kind, `beta` in `1/m`, gauge policy/reason and eliminated DOFs |
| Modal | pencil/scalar kind, target/window/count, transform, KSP/PC, finite/converged/rejected/accepted counts and completeness |
| Driven | physical drive and projected-RHS provenance, frequency, KSP/PC/restart and stop reason |
| Certification | `eps_q`, `eps_phi`, `eps_full`, seam/flux errors, K0 limit and DE/BV evidence; backend residuals remain separate |
| Residency | context identity, buffer locations, allocation bytes and setup/final/per-iteration transfer counts |
| Status | `implementation_state`, `validation_state`, bounded `validated_scope`, separate `product_status`, native status and `complete` |

Modal and driven artifacts remain separate even when they reuse one production
operator. CPU evidence cannot fill GPU residency fields. GPU driven evidence
cannot promote modal GPU. Analytical DE/BV values are independent verifier
inputs and never assembly, target-selection, preconditioner or solver-success
inputs.

## 13. Backend ownership

Backend-neutral phase, block-signature, parity-certificate and artifact
contracts live under `backends/fem/include/frequency_domain/` and
`backends/fem/src/frequency_domain/`.

Production CPU ownership is under:

```text
backends/fem/cpu/frequency_domain/
  operators/
  engines/
  preconditioners/
  modal/
  validation/
```

Production GPU ownership is under:

```text
backends/fem/gpu/cuda/frequency_domain/
  operators/
  engines/
  preconditioners/
  residency/
  modal/
  validation/
```

The CPU and GPU realizations share the backend-neutral physics contract but
own separate MFEM/PETSc/SLEPc/hypre/libCEED/CUDA implementations and evidence.
The runner owns orchestration, ABI transport, cancellation/progress, artifacts
and provenance only. Production assembly, Poisson numerics, preconditioners and
Krylov state do not move into the runner, `Context` or `mfem_bridge.cpp`.

## 14. Definition of done

An exact nonzero-k Floquet-airbox scope is complete only when all applicable
conditions hold:

1. The request has accepted complete magnetic and scalar equivalence classes,
   immutable requested k plus deterministically wrapped resolved k in `rad/m`,
   dimensionless Gamma/kz classification, one phase convention and a valid
   open-z BC tuple.
2. Backend-owned production assembly emits numeric complex Bloch
   `grad_k`/`div_k` blocks with the signs, domains and SI units in Section 4.
3. The independent matched-mesh oracle builds both `C_m(k)` and `C_phi(k)` and
   either passes transformed raw matrix/action parity through a certified
   matching Bloch-enriched map or passes ordinary-P1 refinement and bounded
   physical-observable parity over the accepted k domain.
4. Robin is applied only on open-z faces, pure-Neumann nonzero-k coercivity and
   the K0 gauge transition are certified, and exact `A(k=0)` parity holds.
5. Every modal mode or driven point passes original unscaled block residuals,
   physical seam/flux checks and product-specific acceptance. A postsolve phase
   projection contributes no operator evidence.
6. NK-P1 through NK-P5 pass for each promoted CPU product, including DE/BV,
   K0-limit and only symmetry-qualified `k <-> -k` validation with matched
   clusters/branches and transformed drive/observation pairs.
7. NK-G1 through NK-G4 pass for each promoted GPU product, including persistent
   device Krylov and zero per-iteration transfers. Strict GPU never falls back
   to CPU.
8. Every rejection uses the exact precedence and token vocabulary in Section
   11 and preserves requested/resolved provenance and partial diagnostics.
9. Artifacts report the canonical implementation/validation/scope axes and do
   not conflate executable, physics-validated and production-qualified states.
10. Production qualification is bounded to the exact product, k domain, mesh,
    material, BC, precision, device and engine evidence; no neighboring scope
    is promoted by implication.

Until all applicable conditions pass, nonzero-k dynamic demag remains
`contract_only` or unavailable for the corresponding production scope. K0,
no-demag, phase-projection, synthetic-oracle and other-product evidence must
remain separately labelled.
<!-- END 23_floquet_airbox_nonzero_k_cpu_gpu_implementation.md -->

<!-- BEGIN 24_production_definition_of_done.md -->
---
title: FEM frequency-domain production definition of done
version: COMSOL-aligned v5.2 decision-complete
status: normative product promotion contract; no current qualification implied
role: normative
---

# Production definition of done

## 1. Product rule

FEM frequency-domain capability is production-qualified per exact product
scope, never by solver family name alone. `production_executable` means a lane
can execute. It is not equivalent to `production_qualified`.

The only legal production promotion is:

```text
implementation_state = executable
validation_state = production_qualified
validated_scope = canonical complete non-empty scope
scope_id = canonical validated_scope hash
all applicable DoD items = pass
open production blockers = []
```

Every item in this chapter is independently evidenced. Documentation,
source-visible code, a passing synthetic oracle, one successful runtime, a
nearby CPU/GPU lane or a narrow K0 macrospin exception cannot stand in for an
applicable item. This chapter defines gates; it does not claim any current cell
has passed them.

## 2. `frequency_domain_validation_scope.v1`

Chapter 24 owns the only canonical validation-scope schema. Chapters 09 and 15
and every validation artifact must use this schema rather than defining a
shorter local tuple. `frequency_domain_validation_scope.v1` is the closed JSON
object defined below: every listed field is required, no additional field is
allowed, and `null`, an empty identifier, `any`, `all`, an infinity, a NaN and
an unbounded wildcard are invalid.

### 2.1 Primitive types

| Type | Normative JSON representation |
|---|---|
| `Identifier` | Non-empty string matching `^[a-z0-9][a-z0-9._:/+-]*$` |
| `Sha256Id` | Lowercase string matching `^sha256:[0-9a-f]{64}$` |
| `PositiveNumber` | Finite JSON number greater than zero |
| `NonNegativeInteger` | JSON integer greater than or equal to zero |
| `PositiveInteger` | JSON integer greater than or equal to one |
| `ClosedInterval` | Closed object `{minimum: finite number, maximum: finite number, unit: Identifier}` with `minimum<=maximum` |
| `IntegerInterval` | Closed object `{minimum: NonNegativeInteger, maximum: NonNegativeInteger}` with `minimum<=maximum` |
| `IdentifierSet` | Non-empty JSON array of unique `Identifier` values, sorted by UTF-8 byte order |
| `IdentityRef` | Closed object `{id: Identifier, version: Identifier, sha256: Sha256Id}` |

All physical intervals use the canonical SI unit named by the schema path.
`IdentifierSet` is a mathematical set; path samples, sweep samples,
`fixture_ids` and `oracle_ids` are ordered sequences and retain their declared
order.

### 2.2 Required top-level object

| Field | Type and constraint |
|---|---|
| `schema` | Literal string `frequency_domain_validation_scope.v1` |
| `study_product` | Enum `modal_eigen | driven_response` |
| `discretization` | Literal string `fem` |
| `physics_scope` | Closed `PhysicsScope` object from section 2.3 |
| `problem_scope` | Closed `ProblemScope` object from section 2.4 |
| `solver_scope` | Closed `SolverScope` object from section 2.5 |
| `runtime_scope` | Closed `RuntimeScope` object from section 2.6 |
| `device_scope` | Closed `DeviceScope` object from section 2.6 |
| `material_scope` | Closed `MaterialScope` object from section 2.7 |
| `geometry_scope` | Closed `GeometryScope` object from section 2.7 |
| `fixture_ids` | Non-empty ordered array of unique `IdentityRef` values |
| `oracle_ids` | Non-empty ordered array of unique `IdentityRef` values |

### 2.3 `PhysicsScope`

| Field | Type and constraint |
|---|---|
| `equation_set` | `Identifier` naming the canonical linearized equation contract |
| `phasor_convention` | `Identifier` naming the time/complex-sign convention |
| `dynamic_field_convention` | `Identifier` naming the dynamic-field and observable convention |
| `equilibrium_class` | Enum `uniform | relaxed | nonuniform` |
| `included_interactions` | `IdentifierSet` containing every admitted interaction |
| `excluded_interactions` | Sorted unique array of `Identifier`; empty is allowed |
| `damping_policy` | `Identifier` |
| `nonconservative_policy` | `Identifier`; use literal `none` when excluded |

An interaction cannot occur in both interaction arrays. Omission is not an
exclusion declaration.

### 2.4 `ProblemScope`

`ProblemScope` is a closed object containing every field below.

| Field | Type and constraint |
|---|---|
| `mode_scope` | Closed object `{kind, branch_policy, class_ids, requested_count, spectral_window_rad_per_s, multiplicity_policy, tracking_policy, response_observable_ids, drive_scope}`. `kind` is `modal | driven`; `class_ids` is `IdentifierSet`; `requested_count` is `IntegerInterval`; `spectral_window_rad_per_s` is `ClosedInterval` with unit `rad_per_s` or literal `not_applicable`; `response_observable_ids` is a sorted unique identifier array; all other members are `Identifier`. Modal uses `response_observable_ids=[]` and `drive_scope=not_applicable`; driven uses `requested_count={minimum:0,maximum:0}`, `branch_policy=not_applicable`, `multiplicity_policy=not_applicable` and `tracking_policy=not_applicable`. |
| `k_scope` | Closed tagged union. K0 is `{kind:"k0", gamma_tolerance_rad_per_m:PositiveNumber}`. Nonzero-k is `{kind:"nonzero_k", path_id:Identifier, samples_rad_per_m:ordered non-empty array of finite three-number arrays, domain_rad_per_m:ClosedInterval(unit="rad_per_m"), gamma_tolerance_rad_per_m:PositiveNumber}`. |
| `dynamic_demag_scope` | Enum `none | periodic_airbox_k0 | floquet_airbox_nonzero_k` |
| `equilibrium_scope` | Closed object `{acceptance_policy:Identifier, torque_tolerance:PositiveNumber, norm_tolerance:PositiveNumber, artifact_policy:Identifier, signature_policy:Identifier}` |
| `boundary_scope` | Closed object `{magnetic_bc:Identifier, periodic_directions:sorted unique array drawn from [x,y,z], pairing_policy:Identifier, open_directions:sorted unique array drawn from [x,y,z], scalar_outer_bc:Identifier, robin_beta_per_m:ClosedInterval(unit="per_m") or "not_applicable"}`; periodic and open direction sets are disjoint |
| `gauge_scope` | Closed object `{policy:Identifier, augmentation:Identifier, nullspace_tolerance:PositiveNumber, constraint_tolerance:PositiveNumber}` |
| `fe_scope` | Closed object `{magnetic_space:Identifier, magnetic_order:PositiveInteger, scalar_space:Identifier, scalar_order:PositiveInteger, quadrature_rule:Identifier, mesh_quality:ClosedInterval(unit="dimensionless"), refinement_policy:Identifier}` |
| `problem_size_scope` | Closed object `{magnetic_dofs:IntegerInterval, scalar_dofs:IntegerInterval, total_dofs:IntegerInterval, largest_memory_bytes:NonNegativeInteger, largest_runtime_seconds:PositiveNumber}` |
| `operator_scope` | Closed object `{included_terms:IdentifierSet, excluded_terms:sorted unique identifier array, assembly_kind:Identifier, scalar_representation:Identifier}`; a term cannot occur in both arrays |
| `damping_scope` | Closed object `{alpha:ClosedInterval(unit="dimensionless"), nonnormal_policy:Identifier}` |

### 2.5 Mandatory `SolverScope`

`solver_scope` is not an engine nickname. It is the closed object below, and
every field is mandatory for modal and driven artifacts alike.

| Field | Type and constraint |
|---|---|
| `engine` | `Identifier` naming the exact production solver engine |
| `rtol` | `PositiveNumber` less than one |
| `max_iterations` | `PositiveInteger` |
| `restart` | `PositiveInteger` not greater than `max_iterations`; direct solvers use `1` |
| `linear_solver_family` | `Identifier`; use literal `none` only when no linear solve exists |
| `preconditioner` | Closed object `{family:Identifier, variant:Identifier, setup_policy:Identifier, reuse_policy:Identifier}`. Use `family=none` only when no preconditioner exists, and then every other member must also be `none`. |
| `spectral_transform` | Closed object `{family:Identifier, shift_rad_per_s:finite number or "not_applicable"}`; `none` is explicit |
| `target_representation` | Closed object `{family:Identifier, target_rad_per_s:finite number or "not_applicable", window_rad_per_s:ClosedInterval(unit="rad_per_s") or "not_applicable", sweep_hz:ordered array of finite positive numbers}`; modal uses an empty `sweep_hz`, driven uses `target_rad_per_s=not_applicable` |
| `device_residency` | Closed object `{operator, krylov_vectors, basis, preconditioner}` with each value in `host | device | mixed | not_applicable`, plus `{per_iteration_h2d_max:NonNegativeInteger, per_iteration_d2h_max:NonNegativeInteger, hidden_host_solves_allowed:boolean}` |
| `precision` | Enum `double | single` |
| `block_residual_contract` | Closed object `{operator_form:"original_unscaled", norm:"l2", required_blocks:IdentifierSet, aggregation:"max", denominator_policy:Identifier, absolute_scale_floor:PositiveNumber, acceptance_tolerance:PositiveNumber}`. `required_blocks` names every physical and constraint block, including scalar and gauge blocks when present. |
| `certificate_references` | Non-empty ordered array of unique closed `CertificateReference` objects naming every certificate required for solver acceptance |
| `fallback_policy` | `Identifier`; strict no-fallback is explicit |
| `accepted_stop_reasons` | `IdentifierSet` |

Consequently, changing only `rtol`, iteration cap, restart, linear-solver
family, preconditioner object, transform/target representation, residency, precision,
residual contract or certificate references creates a different readiness cell.

`CertificateReference` is the closed object
`{type, certificate_id, artifact_uri, sha256}`. `type` is the literal
certificate schema/type consumed by the validator, `certificate_id` is the
stable ID inside that artifact, `artifact_uri` is an immutable artifact URI and
`sha256` is the artifact digest. References are unique by
`{type, certificate_id, artifact_uri, sha256}`. A prose certificate name,
identifier-only set member or unchecked path is not a certificate reference.

For `type=periodic_mesh_certificate.v6`, the validator loads the referenced
artifact before hashing the scope and consumes its typed payload. A K0
periodic-airbox certificate must declare the K0/Gamma policy, periodic
directions, scalar open-boundary/gauge policy and topology/frame transport
semantics that match `boundary_scope`, `gauge_scope` and
`dynamic_demag_scope=periodic_airbox_k0`; it must not carry nonzero-k Floquet
sample coverage. A nonzero-k Floquet certificate must declare Floquet metadata
including phase convention, periodic cell/lattice identity, frame/gauge
transport policy and covered k samples; its covered sample set must contain
every `problem_scope.k_scope.samples_rad_per_m` entry within
`gamma_tolerance_rad_per_m`. These typed certificate payloads, not prose names,
drive section 2.8 reject-before-hash validation.

### 2.6 Runtime and device scope

`RuntimeScope` is the closed object
`{fullmag_commit, build_id, native_abi, dependency_versions, managed_route}`.
`fullmag_commit` is exactly 40 lowercase hexadecimal characters; `build_id` and
`managed_route` are `Identifier`; `native_abi` is a `PositiveInteger`; and
`dependency_versions` is a sorted, non-empty array of closed
`{name:Identifier, version:Identifier}` objects covering every applicable
PETSc, SLEPc, hypre, libCEED, CUDA and compiler/runtime dependency.

`DeviceScope` is the closed object
`{requested, resolved, family, architecture, driver, runtime}`. `requested` is
`cpu | gpu | auto`, `resolved` is `cpu | gpu`, and the remaining fields are
`Identifier`; CPU scopes use explicit CPU values rather than `not_applicable`.

### 2.7 Material and geometry scope

`MaterialScope` is the closed object
`{class_ids:IdentifierSet, region_policy:Identifier, parameter_bounds}`.
`parameter_bounds` is a non-empty array of closed
`{name:Identifier, bounds:ClosedInterval}` objects, unique by `name`, and must
include bounded SI entries for `Ms`, gamma, exchange, anisotropy, damping and
every parameter used by an included interaction. After uniqueness validation,
canonicalization sorts `parameter_bounds` by `name` before serialization.

`GeometryScope` is the closed object
`{family:Identifier, dimension_bounds, periodic_cell_policy,
airbox_policy}`. `dimension_bounds` is a non-empty array of closed
`{name:Identifier, bounds:ClosedInterval}` objects, unique by `name`, covering
every fixture dimension and periodic-cell dimension. After uniqueness
validation, canonicalization sorts `dimension_bounds` by `name` before
serialization. `periodic_cell_policy` is a closed
`{directions:sorted unique array drawn from [x,y,z], cell_id:Identifier}`
object. `airbox_policy` is a closed
`{kind:Identifier, top_padding_m:ClosedInterval(unit="m") or "not_applicable",
bottom_padding_m:ClosedInterval(unit="m") or "not_applicable",
symmetry:Identifier}` object.

### 2.8 Reject-before-hash cross-field rules

The validator rejects contradictory objects before canonical serialization and
before any `scope_id` is computed. These rules are part of
`frequency_domain_validation_scope.v1` validation, not post-hash promotion
policy.

- `study_product=modal_eigen` requires
  `problem_scope.mode_scope.kind=modal`.
- `study_product=driven_response` requires
  `problem_scope.mode_scope.kind=driven`.
- `problem_scope.dynamic_demag_scope=periodic_airbox_k0` requires
  `problem_scope.k_scope.kind=k0`, accepted Gamma-resolved k under the stored
  `gamma_tolerance_rad_per_m`, a `solver_scope.certificate_references` entry
  with `type=periodic_mesh_certificate.v6` whose referenced typed certificate
  declares the K0 periodic-airbox policy matching the stored periodic
  directions, open-z scalar boundary and gauge policy, and no
  Floquet/nonzero-k demag certificate reference.
- `problem_scope.dynamic_demag_scope=floquet_airbox_nonzero_k` requires
  `problem_scope.k_scope.kind=nonzero_k`, a non-Gamma resolved k domain, and a
  `solver_scope.certificate_references` entry with
  `type=periodic_mesh_certificate.v6` whose referenced typed certificate
  declares Floquet metadata and k-sample coverage for every listed k sample.
- `problem_scope.k_scope.kind=nonzero_k` rejects an all-Gamma sample set and
  requires a `periodic_mesh_certificate.v6` typed certificate reference with
  nonzero-k Floquet metadata and k-sample coverage.
  Its compatible dynamic demag values are `none` for no-demag Floquet products
  and `floquet_airbox_nonzero_k` for dynamic-demag products; it cannot use
  `periodic_airbox_k0`.
- `problem_scope.k_scope.kind=k0` cannot use
  `floquet_airbox_nonzero_k`, cannot carry nonzero-k Floquet samples, and
  cannot use a Floquet-only certificate reference as a substitute for the
  required K0 periodic-airbox certificate reference.

Any contrary product/k/demag/certificate combination is invalid and receives no
canonical hash. The validator must report the first conflicting field paths so
the artifact is rejected rather than silently reclassified.

### 2.9 Canonical serialization and `scope_id`

The hash input is exactly the complete closed top-level object in section 2.2:

```text
schema, study_product, discretization
physics_scope, problem_scope, solver_scope
runtime_scope, device_scope, material_scope, geometry_scope
fixture_ids, oracle_ids
```

Each named object contributes every one of its required nested values. In
particular, the hash always includes the complete `solver_scope`: engine,
`rtol`, `max_iterations`, `restart`, `linear_solver_family`,
`preconditioner`, spectral transform, transform target/window/sweep,
device-residency layout and transfer limits, precision, full original-block
residual contract, certificate references, fallback policy and accepted stop
reasons.
`scope_id`, artifact paths, timestamps, gate outcomes, metric results,
promotion state, evidence bindings and coverage rules are not hash inputs.

Canonicalization is deterministic:

1. validate the closed object against
   `frequency_domain_validation_scope.v1`, including every cross-field rule;
2. reject non-finite numbers and negative zero; encode all quantities in the
   schema-prescribed SI unit, sort every schema-declared set, reject duplicate
   set members, sort `material_scope.parameter_bounds` and
   `geometry_scope.dimension_bounds` by `name` after proving `name`
   uniqueness, and preserve only schema-declared ordered sequences;
3. serialize the validated object as UTF-8 with RFC 8785 JSON Canonicalization
   Scheme; and
4. compute `scope_id = "sha256:" + lowercase_hex(SHA-256(serialized_bytes))`.

The validator resolves and revalidates the complete object before recomputing
the hash. A caller-supplied ID is never trusted. Two objects that differ in any
hash input are different readiness cells.

### 2.10 `scope_catalog.v1`

Coverage cannot rely on an opaque hash alone. Every direct or coverage binding
resolves through a content-addressed `scope_catalog.v1` artifact that maps each
`scope_id` used by the binding to the complete canonical scope object.

`scope_catalog.v1` is the closed JSON object:

| Field | Type and constraint |
|---|---|
| `schema` | Literal string `scope_catalog.v1` |
| `scope_schema` | Literal string `frequency_domain_validation_scope.v1` |
| `scopes` | Non-empty closed map whose property names are `Sha256Id` values and whose values are complete `frequency_domain_validation_scope.v1` objects |

The catalog digest is computed as
`scope_catalog_sha256 = "sha256:" + lowercase_hex(SHA-256(RFC8785(scope_catalog.v1)))`.
For each `scopes` entry, the validator validates the complete scope object,
applies section 2.8, canonicalizes it under section 2.9, recomputes its
`scope_id`, and requires the recomputed ID to equal the map key. Duplicate
semantic scopes under different keys, a map key whose value hashes elsewhere,
or a catalog digest mismatch invalidates every binding that cites the catalog.

`scope_catalog_uri` is a mandatory non-empty artifact URI in the same immutable
bundle or an absolute content-addressed URI. Every direct binding, coverage
binding and promotion record must also carry `scope_catalog_sha256`. The
catalog is resolved only through this content-addressed external artifact; an
embedded `scope_catalog` field is invalid in bindings and promotion records.

## 3. DoD state and evidence rules

Each item has one state:

```text
pass
fail
not_applicable
```

`not_applicable` requires a machine-readable reason and a `validated_scope`
that excludes the feature. It cannot waive a requirement that is inherent to
the claimed cell. For example, GPU residency is inherent to a GPU device-Krylov
claim, while CPU/GPU numerical parity is not required to call a CPU-only cell
device-resident. A GPU promotion always requires a qualified CPU oracle and
CPU/GPU parity.

Each `pass` links immutable artifacts and records:

```text
gate_id
verified_coverage_of = validation_scope_binding.v1
evidence paths and sha256 hashes
fixture and oracle identities
metric values
required initial and production tolerances
verifier identity and result
implementation_state
validation_state before promotion
open blockers
```

Every JSON-object evidence artifact has a required top-level
`verified_coverage_of` field. Non-object artifacts carry the same binding
through the sidecar defined in section 3.3. The binding value is exactly one
closed `validation_scope_binding.v1` object:

```text
verified_coverage_of = {
  schema: "validation_scope_binding.v1",
  scope_schema: "frequency_domain_validation_scope.v1",
  kind: "direct",
  scope_id: Sha256Id,
  scope_catalog_uri: string,
  scope_catalog_sha256: Sha256Id
}

verified_coverage_of = {
  schema: "validation_scope_binding.v1",
  scope_schema: "frequency_domain_validation_scope.v1",
  kind: "coverage",
  scope_catalog_uri: string,
  scope_catalog_sha256: Sha256Id,
  coverage_rule: coverage_rule.v1
}
```

Both objects are closed. `scope_catalog_uri` and `scope_catalog_sha256` are
mandatory in both variants. A direct binding has no `coverage_rule`; a coverage
binding has no `scope_id`; no additional field, embedded `scope_catalog` or
third kind is legal. The direct form means the artifact evaluated the one
catalog-resolved `frequency_domain_validation_scope.v1` object whose recomputed
hash is `scope_id`. The coverage form is legal only for a bounded oracle or
aggregate whose evaluated subject scope covers every listed target under
section 3.2.

### 3.1 `verified_coverage_of` and `validation_scope_binding.v1` validation

The artifact validator first reads the required `verified_coverage_of` field,
then validates the closed binding variant and the literal `scope_schema`. It
loads `scope_catalog_uri`, verifies `scope_catalog_sha256`, validates the
catalog under section 2.10, and
recomputes every catalogued `scope_id` from the complete canonical scope
object. It then accepts either one direct scope present in that catalog or one
`coverage_rule.v1` whose `subject_scope_id` and every `covered_scope_id` are
present in the same verified catalog. A caller cannot substitute a fixture
name, abbreviated tuple, parent scope ID, prose `validated_scope` claim,
standalone hash or independently supplied coverage list. A coverage binding is
invalid unless its rule is valid under section 3.2.

### 3.2 `coverage_rule.v1`

`coverage_rule.v1` is the following closed JSON object. It is mandatory for
`verified_coverage_of` when its `validation_scope_binding.v1.kind` is
`coverage`.

| Field | Type and constraint |
|---|---|
| `schema` | Literal string `coverage_rule.v1` |
| `relation` | Enum `exact | subset` |
| `subject_scope_id` | `Sha256Id` of the canonical scope actually evaluated by the artifact |
| `covered_scope_ids` | Non-empty ordered array of unique `Sha256Id` |
| `field_predicates` | Non-empty ordered array of closed `FieldPredicate` objects |

`FieldPredicate` is the closed object
`{covered_scope_id:Sha256Id, field_path:string, comparator:Comparator}`.
`field_path` is an RFC 6901 JSON Pointer to one canonical comparison address in
`frequency_domain_validation_scope.v1`; `covered_scope_id` must occur in
`covered_scope_ids`; and `Comparator` is exactly one of `equal`, `set_subset`
or `interval_subset`. A comparison address is one scalar, one complete
schema-declared `IdentifierSet`, one complete `ClosedInterval` or
`IntegerInterval`, or one complete schema-declared ordered sequence. Pointers
to partial containers, array slices, ancestors and wildcards are invalid.

Comparator direction is fixed and cannot be inverted:

- `equal`: the covered target value equals the subject value after canonical
  type validation;
- `set_subset`: the covered target set is a subset of the subject set; it is
  legal only on a complete schema-declared `IdentifierSet`; and
- `interval_subset`: the covered target closed or integer interval is contained
  in the subject interval with the same canonical SI unit where applicable,
  meaning
  `subject.minimum <= covered.minimum <= covered.maximum <= subject.maximum`.

For every `covered_scope_id`, `field_predicates` contains exactly one predicate
for every canonical comparison address, with no duplicate or omitted path.
Identity-bearing fields, ordered arrays, samples, fixture/oracle
references, product, discretization, runtime, resolved device, precision and
every non-set/non-interval solver field require `equal`. `relation=exact`
requires `covered_scope_ids=[subject_scope_id]` and `equal` at every path.
`relation=subset` requires at least one valid
`set_subset` or `interval_subset` predicate and equality everywhere else.

The validator resolves the complete subject and covered scope objects from the
verified `scope_catalog.v1`, recomputes every ID, evaluates all predicates and
rejects the rule if any covered target is broader than the subject's evaluated
domain. Therefore a three-field fast-CI subject cannot cover or promote a
15-field target, a K0 subject cannot cover nonzero-k, and CPU/double evidence
cannot cover GPU or single precision. Coverage permits reuse only from a scope
whose evaluated domain contains the target; it never promotes the broader
target scope.

An abbreviated tuple, fixture nickname, parent directory or matching runtime
signature is not a scope binding. Missing scope objects, an untyped prose
relation, a coverage binding without `coverage_rule.v1`, a binding without a
verified scope catalog, a catalog that does not contain every referenced
`scope_id`, or an unevaluated predicate makes the artifact stale for every
listed target.

### 3.3 `validation_artifact_manifest.v1` for non-object artifacts

Artifacts that cannot carry a JSON top-level object with `verified_coverage_of`
must be paired with an immutable sidecar manifest. CSV files, Zarr stores,
binary arrays and plain-text tables are invalid evidence without this sidecar.
JSON object artifacts normally carry `verified_coverage_of` at top level; they
may not use a sidecar to omit or contradict that top-level binding.

`validation_artifact_manifest.v1` is the closed JSON object:

| Field | Type and constraint |
|---|---|
| `schema` | Literal string `validation_artifact_manifest.v1` |
| `artifact_kind` | Enum `csv | zarr | binary | text | other_non_json` |
| `artifact_schema` | `Identifier` naming the artifact's content schema or table layout |
| `artifact_uri` | Immutable URI of the CSV file, Zarr store root or other non-object artifact |
| `artifact_sha256` | `Sha256Id` for single-file artifacts; must be absent for `artifact_kind=zarr` |
| `zarr_tree_sha256` | `Sha256Id` of the canonical Zarr tree digest; mandatory for `artifact_kind=zarr` and absent otherwise |
| `verified_coverage_of` | One complete `validation_scope_binding.v1` object with mandatory `scope_catalog_uri` and `scope_catalog_sha256` |

The sidecar is stored next to the artifact as
`<artifact-name>.validation_manifest.v1.json`. For a file this appends the
suffix to the full filename, for example
`points.v2.csv.validation_manifest.v1.json`; for a Zarr store this appends the
suffix to the store name, for example `fields.zarr.validation_manifest.v1.json`.
The promotion record hashes and links the sidecar as evidence in addition to
the artifact bytes or Zarr tree digest.

Validation order is fixed:

1. locate the sidecar by the deterministic naming rule and verify its own
   evidence hash from the promotion record;
2. validate the closed sidecar schema and its artifact kind;
3. validate `verified_coverage_of`, resolve `scope_catalog_uri`, verify
   `scope_catalog_sha256` and recompute every referenced scope ID;
4. hash the target artifact bytes, or the canonical Zarr tree, and compare the
   digest with the sidecar;
5. validate the artifact content schema named by `artifact_schema`; and
6. only then consume rows, arrays or metadata for metrics, coverage or
   promotion.

Evidence from another physical signature, precision, device, product, k scope,
demag realization or solver engine is stale for this record even if its files
are newer.

## 4. Product checklist

| DoD item | Required exact-scope evidence | Pass condition | Does not satisfy the item |
|---|---|---|---|
| DOD-01 Physics note | Applicable publication-style notes in `docs/physics`, including equations, SI units, assumptions, FDM/FEM interpretation, CPU/GPU policy, validation and limits | Notes are canonical, internally consistent with 0700/0830/0831, and cover every operator/BC/damping feature in scope | Masterplan equations alone, a status report or undocumented runtime behavior |
| DOD-02 Python/UI round-trip | Canonical Python DSL script, UI-authored equivalent, exported script and normalized semantic comparison | Python -> IR -> UI/export -> Python preserves all physics-first fields and requested intent for the exact scope | UI-only state, backend metadata injected as public physics, or one-way authoring |
| DOD-03 ProblemIR validation | Canonical lowered `ProblemIR`, normalization output and positive/negative validation cases | Units, k, gamma, equilibrium, BC/gauge, demag, target/sweep, precision and duplicate/conflict rules accept legal input and reject illegal input with stable reasons | Runtime defaults repairing malformed IR or planner-only rejection |
| DOD-04 Planner legality | Requested and resolved plans for strict CPU, strict GPU, auto and allowed fallback cases | Exactly one legal lane resolves; unsupported strict requests fail; any fallback is explicit and provenance-preserved | Hidden CPU fallback, heuristic selection before intent, or capability inferred from source presence |
| DOD-05 Equilibrium/mesh certificates | Accepted equilibrium/linearization artifact and complete magnetic/scalar periodic certificate with matching signatures | Acceptance, torque/norm, topology/equivalence classes, frame transport, seams, BC/gauge and invalidation checks pass for the exact solve | Preflight candidate not consumed by native assembly, pair-only corner handling, or mismatched signatures |
| DOD-06 Native assembly | Backend-owned real FEM blocks/actions and chapter 09 manufactured/reciprocity/isolation evidence | `assembly_kind` is the production kind; block signs/units/order/scaling pass; analytical expected values cannot affect blocks, target or signatures | `synthetic_algebraic_oracle`, Kittel `demag_delta`, macrocell payload or postsolve phase projection |
| DOD-07 Solver engine | Exact modal or driven production engine, preconditioner and lifecycle artifacts | Engine converges over the bounded size/window/sweep scope, has correct target representation/restart/stop reasons, and has no undeclared fallback | Dense/apply probe, one successful tiny case, host-Krylov path claimed as device Krylov, or another product's engine |
| DOD-08 Full residual | Reconstructed original unscaled block residuals for every accepted mode/frequency point | Chapter 09 production tolerance passes for every required block; transformed/backend/tracked residuals remain separate | Solver-library residual alone, capped residual, magnetic-only residual when scalar/gauge blocks apply |
| DOD-09 Artifacts/OpenAPI/UI | Complete artifacts-v2 bundle, typed OpenAPI/resource exposure and UI state for complete/partial/failed/unavailable outcomes | Cross-artifact hashes, sidecar manifests for CSV/Zarr/non-object evidence, scope catalog digest, units, revisions, requested/resolved state, accepted `verified_coverage_of` binding, and resource links agree; UI cannot overstate capability | Abbreviated scope tuple, untyped coverage claim, opaque scope hash without a verified catalog, CSV/Zarr/raw files without `validation_artifact_manifest.v1`, UI claim inferred from route presence, or JSON carrying heavy payloads outside the data plane |
| DOD-10 Analytical validation | Applicable chapter 09 independent physics gate: Larmor/Kittel, ellipsoid, DE/BV, modal/driven resonance or another physics-note oracle | Production tolerance passes after solve and after independent selection; for K0-3, fixture-owned independently provenanced `M_eff_reference`, fitted-`M_eff` agreement, uncertainty and conditioning all pass; oracle inputs never enter assembly/request target/selection/certificate/solver status | Best-fit-only agreement, solver-derived `M_eff_reference`, nearest-expected mode selection, synthetic operator built from the answer, or fast CI subset |
| DOD-11 Convergence | Raw distinct mesh and truncation sequences plus solver tolerance evidence | At least three levels per applicable dimension; monotonicity/asymptotic fit, observed order where applicable, Richardson/finest-two delta and separate frequency and fitted-`M_eff` budgets pass | Best row only, duplicated synthetic rows, simultaneous mesh/padding changes without independent sequences, or analytical values copied as solved rows |
| DOD-12 CPU/GPU parity | For GPU: exact qualified CPU oracle and chapter 09 operator/solver/physics parity; for CPU-only: explicit `not_applicable` reason excluding GPU | GPU blocks, modes/responses, residuals and accepted/rejected outcomes pass production tolerances on identical signatures | No-demag macrospin parity used for demag, CPU result copied into GPU artifacts, or precision mismatch |
| DOD-13 Performance/residency | Raw performance envelope, memory scaling and, for GPU, independent transfer/residency audit | Bounded release performance passes; GPU hot loop, vectors, basis, operator and preconditioner are device-resident with zero per-iteration H2D/D2H and hidden host solves | One-shot GPU kernel, device matrix with host Krylov, unbounded workload, or timing without environment identity |
| DOD-14 Release regression | Managed/container-backed release gate and immutable regression bundle for the exact scope | All applicable DoD validators run from a clean release candidate, expected negative controls fail, and accepted baselines are versioned | Host-only check, docs-only assertion, stale artifact, skipped negative control or unrelated lane's managed gate |

## 5. Product-specific applicability

### 5.1 Modal eigen

Modal qualification additionally requires finite-mode classification, correct
`lambda=i*omega` mapping, positive-branch policy, physical mode count, window
completeness, multiplicity/cluster handling, full mode reconstruction and
shape/overlap branch tracking when a sweep or k path is claimed.

K0 Poisson-airbox modal scope requires chapter 18 stages K0-P1 through K0-P6.
GPU scope additionally requires K0-G1 through K0-G4. Chapter 15 K0-3 is
mandatory for a real-film periodic-airbox production claim.

Nonzero-k modal scope requires chapter 23 NK-P1 through NK-P5. GPU scope
additionally requires NK-G1 through NK-G4. Passing Gamma only does not promote
a nonzero-k domain.

### 5.2 Driven response

Driven qualification additionally requires a physical projected RHS, complete
frequency sweep semantics, true original residual at every accepted point,
complex field/observable artifacts, cancellation/interruption behavior and
full-versus-Schur/reduced cross-checks for every claimed alternate engine.

K0 Poisson-airbox driven scope requires chapter 18 K0-P1 through K0-P3 and
K0-P7 plus the applicable residual/physics gates. A modal basis is required
only for a modal-reduced cell, where left/right or Petrov-Galerkin contracts are
also mandatory.

Nonzero-k driven scope requires chapter 23 NK-P1 through NK-P5 for the driven
product. Modal nonzero-k evidence does not promote driven response without its
own RHS, sweep, residual and observable evidence.

### 5.3 CPU

A CPU cell may qualify independently of GPU implementation. It still needs a
bounded performance envelope and exact CPU engine evidence. DOD-12 is
`not_applicable` only with reason `validated_scope.device=cpu excludes GPU`;
the record must not imply GPU parity or availability.

### 5.4 GPU

A GPU cell requires every applicable CPU physics/assembly oracle, CPU/GPU
parity and GPU performance/residency gate. GPU operator residency does not
qualify GPU solver residency. Strict GPU execution must resolve to the exact
GPU engine or reject without CPU fallback.

## 6. Required promotion record

The release candidate publishes one record per readiness cell. The schema is
`frequency_domain_production_dod.v1` and requires:

| Record field | Required value |
|---|---|
| `scope_schema` | `frequency_domain_validation_scope.v1` |
| `scope_id` | RFC 8785/SHA-256 identifier computed exactly as section 2 specifies |
| `validated_scope` | Every canonical field in section 2, with no wildcard or omitted field |
| `scope_catalog_uri` | Content-addressed external `scope_catalog.v1` containing the complete `validated_scope` object and every evidence-referenced scope object |
| `scope_catalog_sha256` | Digest of the exact external catalog bytes |
| `implementation_state` | `executable` |
| `validation_state_before_promotion` | The actual pre-promotion state |
| `items.DOD-01` through `items.DOD-14` | `pass`, `fail` or justified `not_applicable` |
| `item_evidence.DOD-01` through `item_evidence.DOD-14` | Gate IDs, one accepted `verified_coverage_of` binding, immutable artifact paths/hashes, fixture/oracle IDs, metrics, production tolerances and verifier result for every `pass` |
| `not_applicable_reasons` | One exact scope-derived reason for every `not_applicable` item |
| `open_blockers` | Empty for promotion |
| `promotion_decision` | `production_qualified` only after section 7 succeeds; otherwise `blocked` |

The record validator recomputes `scope_id`, verifies the scope catalog digest,
and validates every direct or coverage binding against catalog-resolved scope
objects. A record that omits a canonical scope field, evidence hash, catalog
entry or coverage proof is invalid rather than partially complete.

## 7. Promotion algorithm

The promotion validator performs these checks in order:

1. validate, RFC 8785-canonicalize and hash the complete `validated_scope`,
   after applying all reject-before-hash rules;
2. require `implementation_state=executable` for that scope;
3. resolve item applicability from the exact product/device/k/demag/engine
   tuple;
4. validate every evidence artifact's complete `verified_coverage_of` binding,
   including its `scope_catalog.v1` digest, every catalogued scope hash, and a
   directional `coverage_rule.v1` when its kind is `coverage`, fixture/oracle
   identity, metric and production tolerance;
5. reject stale or mismatched signatures and evidence from neighboring cells;
6. require every expected negative control to fail for the intended reason;
7. require `open_blockers=[]` and no contradiction with current status docs;
8. set `validation_state=production_qualified` only for the hashed scope; and
9. leave every other readiness cell unchanged.

Any failed or missing applicable item yields `promotion_decision=blocked`.
There is no partial `production_qualified` state. Narrow qualification is
represented by a narrow `validated_scope`, not by weakening this checklist.

## 8. Current blockers relevant to this DoD

Current source and canonical physics/status documents identify blockers that
prevent broad FEM frequency-domain production qualification, including:

- real shared-domain Poisson-airbox modal assembly is not yet qualified;
- the current Kittel path allows expected frequency and validation `M_eff` to
  influence assembly, targeting, selection or solver certification as detailed
  in chapter 15;
- real-PETSc imaginary-axis target representation is not yet broadly
  qualified;
- general GPU modal device Krylov and device-resident driven Krylov are not
  established by dense/apply probes or host-Krylov GPU paths;
- nonzero-k numeric dynamic demag and its full CPU/GPU validation remain
  unqualified; and
- current partial executable and narrow validated cells cannot be promoted
  beyond their existing exact evidence.

These blockers are statements of current non-qualification, not dated evidence
logs. Their removal requires implementation and fresh managed evidence owned by
the corresponding tasks; this documentation change does not satisfy them.
<!-- END 24_production_definition_of_done.md -->
