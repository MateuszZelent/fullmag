# 08 - Periodic, Floquet, Bloch Boundary Conditions

This file makes periodic and Bloch/Floquet support an explicit part of the
frequency-domain FEM plan. These boundary conditions are required for
professional FMR unit-cell studies, spin-wave dispersion, magnonic crystals,
and response maps. They are not optional UI settings.

## Current State

Canonical existing docs:

- `docs/physics/0710-periodic-and-floquet-boundary-conditions.md` defines the
  phase convention and mesh pair artifact.
- `docs/physics/0700-frequency-domain-linearized-llg.md` requires explicit
  periodic/Floquet rejection when the selected backend does not enforce pair
  constraints.
- `docs/physics/0600-fem-eigenmodes-linearized-llg.md` states that the current
  executable modal path exports dispersion artifacts and rejects nonzero-k
  Floquet demag.
- `docs/physics/0800-fem-static-pbc-demag.md` defines static/time-domain FEM
  demag PBC semantics for one or two periodic axes with open nonperiodic axes.
- `docs/physics/0810-fem-static-pbc-dmi.md` defines static/time-domain DMI PBC
  seam semantics.
- `docs/reports/05.05.2026/PBC/update/13_TEST_SNIPPETS.md` provides concrete
  PBC and Floquet test snippets.
- `docs/reports/05.05.2026/PBC/update/14_PR_CHECKLISTS.md` provides historical
  closure checklists for the PBC/Floquet scope.

Current implemented or documented behavior:

- Fullmag stores Bloch wavevectors in `rad_per_m`.
- Static or zero-phase periodic fields satisfy:

```text
m_dst = m_src
```

- Frequency-domain Floquet perturbations satisfy:

```text
delta_m_dst = delta_m_src * exp(-i k dot delta_r)
delta_r = r_dst - r_src
phase_convention = exp_minus_i_k_dot_delta_r
```

For tangent-coordinate unknowns this vector condition is not equivalent to a
plain scalar phase unless the paired tangent frames are identical. With
`delta_m = T q`:

```text
T_dst q_dst =
  exp(-i k dot delta_r) * T_src q_src

q_dst =
  exp(-i k dot delta_r) * (T_dst^T T_src) q_src
```

If a backend supports only identity tangent-frame pairing and
`||T_dst^T T_src - I|| > tolerance` for any periodic pair, the planner or native
adapter must reject the Floquet/PBC request instead of applying only the scalar
phase.

- `mesh/periodic_pairs.v1.json` is the diagnostic artifact for periodic pair
  validation.
- `/v2/sessions/current/meshing/mesh/periodic_pairs.v1` is the v2 resource path
  for periodic pair diagnostics.
- The current frequency-domain plan already carries `spin_wave_bc`,
  `periodic_node_pairs`, `floquet_k_vector`, `k_path_sample`, k-path artifacts,
  and dispersion plots.
- Dynamic demagnetization for nonzero-k Floquet FEM is not implemented and must
  remain a hard capability rejection.

Current missing pieces:

- Periodic/Floquet support is not represented as a dedicated implementation
  stage in the masterplan.
- FMR k=0 periodic unit-cell validation is not separated from nonzero-k
  dispersion validation.
- Driven response with nonzero-k Floquet phase is not separated from modal
  eigen/dispersion Floquet phase.
- Control Room does not yet expose periodic pair diagnostics, Floquet phase
  preview, k-path setup, or Bloch/Floquet capability errors as first-class
  frequency-domain UI surfaces.
- The production native FEM frequency-domain backend does not yet have a
  dedicated Bloch/Floquet operator enforcement contract.

## Target State

Fullmag must support three related but distinct boundary-condition lanes.

### Lane P1 - Static Or Zero-Phase Periodic Unit Cell

Purpose:

- FMR on periodic unit cells.
- Equilibrium preparation for periodic samples.
- k = 0 modal eigenmodes or k = 0 driven response.

Required semantics:

- Enforce periodic equivalence classes for static equilibrium and zero-phase
  perturbations.
- Validate periodic node pairs and periodic boundary pairs before solve.
- Reject duplicate source or destination mappings.
- Validate material, anisotropy, damping, DMI, and source parameters across
  periodic equivalence classes.
- Treat periodic seams as internal seams, not free physical boundaries.
- Exclude open-boundary Robin/Dirichlet airbox contributions from periodic
  seams.

Demag policy:

- Support only documented demag PBC variants.
- For v1, accept one or two periodic axes with at least one open nonperiodic
  axis and valid shared-domain airbox periodic boundary pairs.
- Reject fully periodic 3D FEM demag until a gauge/neutralization convention is
  documented and implemented.

### Lane P2 - Modal Bloch/Floquet Eigenmodes And Dispersion

Purpose:

- Spin-wave dispersion.
- Magnonic crystal band structure.
- Branch tracking along k-paths.
- COMSOL/TetraX-style mode profiles at selected k samples.

Required semantics:

- Enforce `delta_m_dst = delta_m_src * exp(-i k dot delta_r)` in the active
  linearized operator.
- Use `path_s_rad_per_m` as the primary dispersion x-axis for k-path plots.
- Preserve endpoint labels and segment metadata.
- Track branches by modal overlap or a stronger metric, not by sorted frequency
  alone.
- Write `eigen/spectrum.v2.json`, `eigen/branches.v2.json`,
  `eigen/dispersion.csv`, and selected mode payloads with `k_vector`,
  `path_s`, `phase_convention`, residuals, and tangent leakage.

Supported first slice:

- Exchange, external field, local anisotropy, and DMI only where the backend
  enforces Floquet constraints in the operator.
- Demag disabled for nonzero-k Floquet until dynamic demag-k exists.

First-release operator scope for Floquet modal:

- Exchange: supported, reciprocal dispersion test required.
- Zeeman/local field: supported.
- Uniaxial anisotropy: supported when periodic class material validation passes.
- Interfacial DMI: supported only when Floquet seam handling follows `docs/physics/0810-fem-static-pbc-dmi.md`; nonreciprocal dispersion test required.
- Bulk DMI: supported only when the operator enforces Floquet derivatives consistently; nonreciprocal dispersion test required.
- Demag: not supported for nonzero-k Floquet; hard rejection until dynamic demag-k exists.
- Surface anisotropy: deferred until Floquet seam surface-term handling is documented.

Hard rejection:

- `include_demag=true` and `spin_wave_bc.kind="floquet"` with nonzero k must
  fail with a capability error unless a phase-aware dynamic demag-k operator is
  implemented and validated.

### Lane P3 - Driven Bloch/Floquet Frequency Response

Purpose:

- Frequency response maps over `(k, f)`.
- Driven spin-wave response under antenna/current/field excitation.
- Future BLS/STFMR-like analysis surfaces.

Required semantics:

- Solve the driven response equation with the same Floquet phase as the modal
  operator:

```text
(i omega B(k) - L(k)) q = f(omega, k)
```

- Drive projection must be phase-consistent with the selected k sample.
- Response artifacts must distinguish:
  - frequency index,
  - k sample index,
  - drive provenance,
  - response field payload,
  - absorbed power or susceptibility diagnostic.
- Capability must distinguish `frequency_response.k0_periodic` from
  `frequency_response.nonzero_k_floquet`.

Initial release rule:

- Implement and validate k = 0 or static-periodic driven response first.
- Keep nonzero-k driven response gated until the native backend enforces
  Floquet phase in both operator and drive assembly.

## Backend Implementation Instructions

### BCF-1 - Mesh Pair Validation

Current state:

- Periodic node and boundary pair artifacts exist in the documentation.

Target state:

- Every frequency-domain FEM plan carries validated periodic pair metadata when
  periodic or Floquet BCs are requested.

Instructions:

1. Resolve `periodic_node_pairs` and `periodic_boundary_pairs` from the active
   FEM mesh snapshot.
2. Validate every pair translation:

```text
norm((r_dst - r_src) - translation) <= pair_tolerance_m
```

3. Reject duplicate source nodes within the same pair set.
4. Reject duplicate destination nodes within the same pair set.
5. Reject missing `translation` for Floquet studies.
6. Validate periodic classes for material parameters required by the active
   operator.
7. Write or update `mesh/periodic_pairs.v1.json`.
8. Surface the same diagnostics through the v2 meshing resource.

Verification:

- Unit test valid x-periodic bar mesh.
- Unit test duplicate source rejection.
- Unit test duplicate destination rejection.
- Unit test translation residual rejection.
- API test for `/v2/sessions/current/meshing/mesh/periodic_pairs.v1`.

### BCF-2 - Static Periodic Projection

Current state:

- Static/time-domain PBC semantics and PBC demag docs exist separately from
  this frequency-domain plan.

Target state:

- Equilibrium and k = 0 frequency-domain solvers consume one canonical static
  periodic projection.

Instructions:

1. Build periodic equivalence classes from `periodic_node_pairs`.
2. Project static magnetization into periodic classes before equilibrium
   diagnostics.
3. Project local fields or residuals back onto the periodic classes after local
   operator assembly where required.
4. Exclude periodic seam faces from free-boundary surface terms.
5. Preserve per-class material consistency diagnostics.
6. Reject incompatible material values within one periodic class unless a
   documented interface law exists.

Verification:

- Static periodic projection idempotence test.
- Periodic class material mismatch rejection test.
- DMI seam exclusion test.
- k = 0 periodic FMR test against a nonperiodic repeated-supercell reference
  where the comparison is physically meaningful.

### BCF-3 - Floquet Phase Enforcement

Current state:

- The canonical phase convention is documented.

Target state:

- The native FEM frequency-domain operator enforces Floquet phases inside the
  operator, not as postprocessing.

Instructions:

1. Add a Bloch/Floquet constraint object to the native frequency-domain
   operator request.
2. Store:
   - `phase_convention`,
   - `k_vector_rad_per_m`,
   - `periodic_pair_ids`,
   - pair translations,
   - generated complex phase per pair.
3. Apply the complex phase during tangent-space operator assembly or during
   algebraic reduction, depending on the selected backend implementation.
4. Apply the tangent-frame transport
   `phase * (T_dst^T T_src)` for tangent unknowns. A scalar phase-only path is
   legal only when the tangent-frame mismatch is below the documented tolerance.
5. Keep static periodic `k = 0` as a special case of the same validated pair
   metadata, but do not lose provenance.
6. Reject any path that receives pair metadata but does not enforce it.

Verification:

- Phase sign test:

```text
k = [pi / L, 0, 0]
delta_r = [L, 0, 0]
exp(-i k dot delta_r) = -1
```

- `Floquet(k=0) == periodic` operator test.
- Pair-order invariance test.
- Tangent-frame transport test with non-identical but known `T_src`, `T_dst`.
- Identity-frame rejection test when the backend advertises scalar phase-only
  enforcement and `||T_dst^T T_src - I||` exceeds tolerance.
- Complex conjugate symmetry test for reciprocal exchange-only cases.
- Explicit runtime error if backend claims Floquet but returns an unconstrained
  operator.

### BCF-4 - Demag Policy For Periodic And Floquet Studies

Current state:

- Static/time-domain demag PBC is documented separately.
- Nonzero-k dynamic demag for Floquet FEM is explicitly unsupported.

Target state:

- Every PBC/Floquet request has an explicit demag realization or explicit
  rejection.

Instructions:

1. For k = 0 static periodic FMR, allow only documented static demag PBC
   realizations.
2. For nonzero-k Floquet modal or response studies, reject demag unless a
   dynamic demag-k implementation is selected.
3. Record the demag decision in:
   - planner diagnostics,
   - manifest `resolved_execution.demag_realization`,
   - operator diagnostics,
   - UI capability messages.
4. Do not silently fall back from Floquet demag to open-boundary demag.

Verification:

- Planner rejects nonzero-k Floquet demag with a stable diagnostic.
- Response and modal paths share the same rejection reason.
- Manifest records `demag_realization="unsupported_floquet_dynamic_demag"` for
  rejected dry-run diagnostics if a dry-run surface exists.
- Static periodic demag PBC parity follows the relevant demag PBC note.

### BCF-5 - K-Path And Dispersion Execution

Current state:

- v2 dispersion artifacts and k-path concepts exist.

Target state:

- k-path dispersion is a first-class modal workflow and a future response-map
  workflow.

Instructions:

1. Treat k-path sampling as ordered samples with endpoint labels, segment
   indices, and `path_s_rad_per_m`.
2. For each k sample, build an operator using the same validated pair metadata
   and the sample-specific Floquet phase.
3. Emit sample-level diagnostics.
4. Track branches by modal overlap or a stronger method.
5. Write branch diagnostics with confidence scores.
6. Preserve raw mode indices so users can audit branch tracking.

Verification:

- `f(k) = f(-k)` for exchange-only reciprocal dispersion.
- `f(+k) != f(-k)` for a validated nonreciprocal DMI fixture where the
  difference is expected.
- Herring-Kittel or equivalent exchange-dominated analytic dispersion benchmark
  where applicable.
- Branch continuity test across a simple avoided crossing or synthetic crossing
  fixture.
- CSV and JSON artifacts agree on `sample_index`, `raw_mode_index`, `branch_id`,
  `path_s_rad_per_m`, and frequency.

### BCF-6 - FMR Validation

Current state:

- The backend plan mentions an analytic FMR order-of-magnitude test, but the
  PBC/FMR relation is not explicit enough.

Target state:

- FMR validation is a named gate for k = 0 frequency-domain studies.

Instructions:

1. Add a uniform thin-film or ellipsoid-like fixture with known equilibrium.
2. Run k = 0 periodic or zero-phase periodic modal eigen solve.
3. Run k = 0 driven response sweep after the driven solver lands.
4. Compare eigenfrequency to Kittel/Smit-Beljers expected frequency within the
   documented tolerance for the chosen geometry.
5. Verify that the driven response peak aligns with the modal frequency within
   damping and sweep resolution tolerance.
6. Verify amplitude and phase behavior around resonance.
7. Record whether demag is:
   - disabled,
   - open-boundary,
   - static periodic PBC,
   - analytically approximated.

Verification:

- Modal FMR frequency benchmark.
- Driven FMR peak benchmark.
- Periodic unit-cell versus repeated-supercell comparison where valid.
- Response phase crosses through the expected resonance phase trend.

## IR, Planner, Capability Instructions

Current state:

- `spin_wave_bc`, k sampling, and phase convention exist in the semantic layer.

Target state:

- Capabilities are specific enough to drive safe UI enablement.

Required capability vocabulary additions or refinements:

The master capability list lives in `02-ir-planner-python-capabilities-api.md` Stage C4. The fields below are the PBC/Floquet subset and must stay synchronized with that list.

```text
frequency_domain.boundary.static_periodic
frequency_domain.boundary.floquet_modal
frequency_domain.boundary.floquet_response
frequency_domain.boundary.periodic_pair_diagnostics
frequency_domain.demag.static_periodic_pbc
frequency_domain.demag.floquet_dynamic_k
frequency_domain.dispersion.k_path
frequency_domain.dispersion.branch_tracking
frequency_domain.validation.fmr_k0
```

Planner rules:

1. If `spin_wave_bc.kind="periodic"` or `"floquet"`, require validated periodic
   pair metadata.
2. If nonzero-k Floquet is requested and backend cannot enforce Floquet phase,
   reject before runtime.
3. If nonzero-k Floquet and `include_demag=true`, reject until dynamic demag-k
   is implemented.
4. If k = 0 periodic FMR and static demag PBC is requested, require the
   documented static demag PBC realization.
5. Preserve requested versus resolved boundary condition and demag policy in
   plan provenance.

Tests:

- IR round-trip for periodic and Floquet `spin_wave_bc`.
- IR round-trip for `phase_convention`.
- Planner rejection for missing periodic pairs.
- Planner rejection for unsupported Floquet backend.
- Planner rejection for nonzero-k Floquet demag.
- Planner acceptance for supported exchange-only Floquet dispersion.
- Planner acceptance for supported k = 0 periodic FMR fixture.

## Artifacts, Runtime, API

Current state:

- `mesh/periodic_pairs.v1.json` is documented.
- Dispersion and response artifacts carry some boundary metadata, but the
  manifest schema must make it explicit.

Target state:

- Every frequency-domain result exposes boundary-condition provenance.

Manifest fields:

```json
{
  "physics": {
    "spin_wave_bc": {},
    "phase_convention": "exp_minus_i_k_dot_delta_r",
    "k_sampling": {},
    "periodic_pair_ids": [],
    "periodic_pair_resource": "mesh/periodic_pairs.v1",
    "demag_policy": {},
    "floquet_dynamic_demag": "unsupported | supported"
  }
}
```

API resources:

```text
GET /v2/sessions/current/meshing/mesh/periodic_pairs.v1
GET /v2/sessions/current/analysis/eigen/dispersion.csv
GET /v2/sessions/current/analysis/eigen/branches.v2
GET /v2/sessions/current/analysis/frequency-domain/manifest.v1
GET /v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1
```

Runtime events:

```text
mesh.periodic_pairs.updated
analysis.eigen.dispersion.updated
analysis.eigen.branches.updated
analysis.frequency_response.response_map.updated
analysis.frequency_domain.manifest.updated
```

Tests:

- API returns pair diagnostics from active mesh snapshot.
- API falls back to artifact when active mesh snapshot is absent and the run
  produced `mesh/periodic_pairs.v1.json`.
- Manifest includes phase convention and periodic pair IDs.
- Response artifact records k = 0 or nonzero-k metadata explicitly.

## Control Room UI Instructions

Current state:

- The plan already includes eigen k-path nodes and inspectors.
- Periodic/Floquet setup is not yet a first-class cross-module UI contract.

Target state:

- A user can configure, validate, run, and inspect periodic/Floquet frequency
  studies without guessing what the backend enforced.

Explorer nodes:

```text
study.stage.eigenmodes.boundary
study.stage.eigenmodes.periodic_pairs
study.stage.eigenmodes.k_path
study.stage.frequency_response.boundary
study.stage.frequency_response.periodic_pairs
study.stage.frequency_response.k_grid
resources.mesh.periodic_pairs
diagnostics.frequency_domain.periodic_floquet
```

Inspectors:

- `PeriodicFloquetBoundaryInspector`
- `PeriodicPairDiagnosticsInspector`
- `FloquetPhasePreviewInspector`
- `KPathInspector`
- `FmrValidationInspector`
- `FloquetCapabilityDiagnosticInspector`

Authoring UI requirements:

1. Boundary selector:
   - `free`,
   - `periodic_zero_phase`,
   - `floquet_bloch`.
2. Periodic pair selector loads `periodic_pairs.v1`.
3. Floquet phase preview shows:
   - selected pair translation,
   - k vector,
   - `Re(exp(-i k dot delta_r))`,
   - `Im(exp(-i k dot delta_r))`,
   - phase angle.
4. k-path editor uses `rad_per_m` internally and supports display unit
   conversion only at the UI boundary.
5. Capability panel shows why nonzero-k Floquet demag is rejected.
6. FMR setup clearly labels k = 0 periodic as FMR/unit-cell mode, not dispersion.
7. Dispersion setup clearly labels nonzero-k Floquet/Bloch path.

UI tests:

- Periodic pair diagnostics render residual and invalid status.
- Invalid periodic pair disables run.
- Floquet phase preview computes `exp(-i pi) = -1`.
- k-path editor emits `path_s` samples and endpoint labels.
- Nonzero-k Floquet demag displays the exact planner rejection.
- Dispersion chart uses `path_s_rad_per_m`.
- Selecting a dispersion point updates mode overlay selection.

Browser smoke:

- Start Control Room with a fixture containing periodic pair diagnostics.
- Select an eigenmode stage.
- Select Floquet/Bloch boundary.
- Preview phase for a k sample.
- Open dispersion chart.
- Click one branch point.
- Confirm the 3D mode overlay renders with a live WebGL buffer.

## Acceptance Criteria

PBC/Floquet/Bloch support is complete for this masterplan only when:

- k = 0 periodic FMR has a backend validation fixture and UI path.
- Floquet modal dispersion enforces phase constraints in the active operator.
- Nonzero-k Floquet demag is either implemented with a documented dynamic
  demag-k model or rejected with a stable diagnostic.
- Periodic pair diagnostics are available as artifact and v2 resource.
- Dispersion artifacts carry `phase_convention`, `k_vector`, `path_s`, branch
  identity, residuals, and tangent leakage.
- Driven response clearly separates k = 0 periodic response from future
  nonzero-k Bloch/Floquet response maps.
- UI exposes boundary setup, periodic pair diagnostics, phase preview, k-path,
  capability errors, dispersion, FMR validation, and 3D mode/response overlays.
- Verification includes analytic FMR, reciprocal exchange dispersion,
  nonreciprocal DMI dispersion where supported, phase sign, k=0 equivalence,
  demag rejection, API/resource, and browser smoke tests.
