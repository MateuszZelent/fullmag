# Task 5 independent re-review after remediation

Reviewed range: `7599f78968ca21014685d1617eb14f3dc8a69bca..156322e8f1c5cfaeb88386734a90ff326c457538`

Task 5 implementation commit: `ad67da90cfa678c750a4bc1f1dabb4ca73483ae8`

Remediation commits: `09f00cce7c21f7943079525f96f72198d3038374`, `156322e8f1c5cfaeb88386734a90ff326c457538`

Review date: 2026-07-23

## Verdicts

`SPEC_VERDICT: CHANGES_REQUIRED`

`QUALITY_VERDICT: CHANGES_REQUIRED`

The remediation closes all three findings from the preceding review at the
planner/API/preview-evidence level. Public freshness is again the canonical
four-state contract with retained-payload provenance; the bounded CPU DG0 lane
is production-executable through the planner; DG0 field-dot energy densities
use a conservative P1 tetrahedral weak-form projection and match native scalar
energies; the stale callback contract is explicitly included in the managed
recipe; the heterogeneous matrix serializer is rectangular; and the removed
exchange assertion checked stale documentation presence rather than executable
physics.

Approval is still blocked by two newly identified implementation defects. The
native ABI does not enforce the same `ordinary time evolution only` restriction
as the planner and can enter a native relaxation algorithm through an already
accepted DG0 handle. Separately, the DG0 step-statistics path allocates and
zeroes three `3*N` vectors on every accepted CPU step. The first is a semantic
fail-closed gap; the second is a solver-hot-path performance regression.

## Required findings

### [P1] Native relaxation entry bypasses the planner's DG0 workflow restriction

Files:

- `crates/fullmag-plan/src/fem.rs:79-93`
- `crates/fullmag-plan/src/tests.rs:10697-10724`
- `backends/fem/core/fem_material_fields.cpp:117-155`
- `backends/fem/core/fem_material_fields.cpp:268-279`
- `backends/fem/src/api.cpp:2705-2727`

The planner correctly rejects `Ms_element_field` whenever
`FemPlanIR.relaxation` is present (`fem.rs:91-93`). Its regression explicitly
expects a reusable non-relaxation CPU handle to be accepted and an authored
PG-BB relaxation plan to be rejected (`tests.rs:10697-10724`).

The native validator has no equivalent workflow predicate. It accepts every CPU
handle with exchange enabled, consistent mass enabled, and no unsupported local
owner (`fem_material_fields.cpp:117-155,268-279`). Once accepted,
`fullmag_fem_backend_relax_step` calls `run_backend_relaxation_step` without
checking `Ms_element_field` or any qualified workflow mode
(`api.cpp:2705-2727`). A direct native/Rust backend caller can therefore execute
the unqualified DG0 relaxation path that the planner deliberately rejects.
There is no native regression proving rejection at this boundary.

Required change: carry an explicit qualified workflow/operation mode into the
native context, or guard every native relaxation entry point against
element-DG0 `M_s`. Add managed native tests showing that ordinary CPU RK
time evolution with consistent-mass exchange still executes, while PG-BB,
nonlinear-CG, and the LLG-overdamped relaxation route fail closed unless and
until separately qualified. Planner rejection alone is insufficient for a
native contract.

### [P2] DG0 average magnetization allocates three full vectors on every CPU step

Files:

- `backends/fem/cpu/mfem/runtime/step_metrics.cpp:20-45`
- `backends/fem/cpu/mfem/runtime/step_metrics.cpp:105-136`
- `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp:446`

For elementwise `M_s`, `average_magnetization_components` constructs and
zero-initializes `unit_x`, `unit_y`, and `unit_z`, each with
`ctx.state.m_xyz.size()` doubles, then fills them and performs four material
mass-bilinear traversals. `fill_common_step_metrics` calls this helper for every
accepted step, including the production DG0 RK path. Thus the new lane adds
three heap allocations and `9*N` double initialization writes per step before
the reductions themselves.

This violates the native FEM hot-path rule and scales memory traffic with mesh
size. The small qualification mesh does not expose the production cost.

Required change: make the DG0 reduction allocation-free. For example, add a
material-adapter reduction that integrates the three components and denominator
directly in one element traversal, or precompute immutable basis/denominator
workspace during context initialization and reuse it. Add a contract or
allocation/performance regression proving no per-step heap allocation in the
DG0 step-statistics path.

## Closure of the three previous findings

### 1. Canonical freshness and retained payload provenance: closed

- `FieldMaterializationState` contains exactly `complete`, `stale_complete`,
  `pending`, and `error` (`crates/fullmag-api/src/schemas/fields.rs:15-22`).
- Internal `Superseded` maps to public `pending` only when there is no completed
  payload (`fields.rs:762-786`). Pending or superseded work over a retained
  payload changes only its public state to `stale_complete`; error keeps the
  retained payload identity while exposing the failure (`fields.rs:789-805`).
- Catalog mutation no longer overwrites retained source identity
  (`fields.rs:939-978`), and meta construction applies the request state only
  after payload provenance has been selected (`fields.rs:1166-1230`).
- The API regression proves: retained step 4/revision 7 remains available and
  `stale_complete` while step 9 is pending; no-payload pending reports step
  9/revision 13 and `available=false`; internal supersession retains step 4;
  error retains step/time/duration and readable statistics
  (`crates/fullmag-api/src/router_v2/tests.rs:24246-24431`).
- Generated TypeScript exposes the same four-state union. No public
  `superseded` state remains.

### 2. Planner/native CPU DG0 reachability and energy semantics: closed for ordinary time evolution

- Planner legality requires CPU, exchange, `use_consistent_mass=true`, no
  relaxation, and no anisotropy/DMI/thermal/STT/Oersted/magnetoelastic owner.
  Poisson demag and Zeeman remain valid additional consumers
  (`crates/fullmag-plan/src/fem.rs:79-149`).
- Native handle validation mirrors the exchange/consistent-mass and unsupported
  owner checks; GPU remains rejected
  (`backends/fem/core/fem_material_fields.cpp:117-155,268-279`).
- Both targeted planner regressions passed during this re-review:
  `fem_cpu_exchange_and_zeeman_plan_preserves_conformal_dg0_ms` and
  `fem_planner_elementwise_material_legality_distinguishes_a_from_ms`.
- The managed DG0 artifact is genuine native CPU execution: metadata records
  `execution_engine=fem_cpu_native`, `mfem_device=cpu`,
  `use_consistent_mass=true`, no nodal `ms_field`, element-DG0 values spanning
  `400000..800000 A/m`, Poisson-Robin demag, and ordinary `study.run`.

The remaining native relaxation bypass is the separate P1 finding above; it
does not invalidate the exercised ordinary-time DG0 artifact.

### 3. Conservative weak-form energy projection and independent scalar oracles: closed

- The implementation uses the exact P1 tetrahedron identity
  `V/20 * (sum_i u_i.v_i + (sum_i u_i).(sum_i v_i))`, distributes each
  element integral conservatively to the four nodes, and labels the result
  `fem_nodal_conservative_tetra_projection`
  (`crates/fullmag-runner/src/native_fem.rs:3521-3637`).
- The same conservative path is used for exchange, demag, external, and total
  field-dot densities in asynchronous snapshot materialization
  (`native_fem.rs:3737-3785`).
- The focused test constructs a case where the old projected-`M_s` formula is
  wrong by a factor of three and proves conservative integrals independently
  for exchange, demag, external, and total terms
  (`native_fem.rs:3876-3975`).
- Five separate managed artifacts compare API-integrated projected density at
  source step 52 against native scalar rows:

  | Variant | Independent terms | Maximum relative error |
  |---|---|---:|
  | CPU element-DG0 `M_s` | `eden_ex`, `eden_demag`, `eden_ext`, `eden_total` | `1.9450934198233654e-9` |
  | GPU uniaxial | `eden_ani`, `eden_total` | `3.2853607098039007e-11` |
  | GPU cubic | `eden_ani`, `eden_total` | `3.8805584161779044e-11` |
  | GPU interfacial DMI | `eden_dmi`, `eden_total` | `2.7557566216410217e-11` |
  | GPU bulk DMI | `eden_dmi`, `eden_total` | `4.16346561728891e-11` |

  Evidence is under
  `.fullmag/reports/fem-preview-energy-qualification/*/{raw_rows.json,outputs}`.
  The DMI/anisotropy terms are nonzero and the terminal cache contains the
  correct distinct native field owner for each fixture.

## Additional remediation audit

### Stale callback test inclusion: closed

`fem_preview_materialization_stays_outside_callback_deadline` now asserts the
single bounded handoff/retention owner and no longer requires the removed
duplicate `last_good` clone. `justfile:2051-2055` defines an exact managed gate
for this test and also invokes it explicitly before the `task5_` filter in the
review-unit recipe. The old hidden-red-test defect is removed.

### Matrix serializer schema: closed

`matrix_csv_columns` builds the ordered union of public keys and
`matrix_csv_record` fills absent heterogeneous cells with `None`
(`scripts/verify_fem_preview_surface_matrix.py:95-115`). The writer uses that
explicit schema (`:2005-2013`). During re-review:

- `python3 -m unittest scripts.test_verify_fem_preview_surface_matrix`: 13/13
  passed.
- The final `matrix.csv` parsed as 180 data rows, 59 columns, every row
  rectangular, with the header exactly equal to the ordered union of public
  `raw_rows.json` keys.

### Removed documentation-presence assertion: accepted

The deleted function in `backends/fem/tests/exchange_contract.cpp` only searched
an old prose progress report for fixed phrases. It did not execute exchange
physics or validate an operator result. `fem_exchange_contract` and its native
directional-derivative/runtime coverage remain in the managed material gate.
Removing this stale presence assertion does not reduce executable coverage.

## Final matrix assessment

Authoritative artifact:
`.fullmag/reports/fem-preview-surface-matrix/20260723-090252/summary.json`

- Shape: four modes x three cadences x three surfaces x one warm-up plus five
  measured executions = 36 warm-ups + 180 measured executions.
- Surfaces: `headless`, `interactive_no_browser`, `control_room`; modes:
  `disabled`, `m`, `H_demag`, `full_cache`; cadences: 10, 25, 50.
- Callback deadline: 2,000,000 ns. Observed production callback maximum:
  1,105,207 ns; callback-thread CPU maximum: 1,077,007 ns;
  callback-plus-fence maximum: 1,414,746 ns; wall outliers: zero.
- 60 rows prove live asynchronous publication; 30 rows contain managed energy
  comparisons; terminal payload/mask hashes are stable across surfaces.
- Browser retention proof reports `stale_complete`, with a retained canvas hash
  and callback maximum 193,395 ns.
- The artifact is internally consistent with `raw_rows.json`, `matrix.csv`,
  `retention_proof.json`, `api.log`, and per-run outputs. It is accepted as
  production-executable evidence for the bounded fixtures, not as evidence that
  the native ABI fail-closed gap or large-mesh allocation issue is absent.

## Verification performed during this re-review

- `git diff --check 7599f78968ca21014685d1617eb14f3dc8a69bca..156322e8f1c5cfaeb88386734a90ff326c457538`: passed.
- `python3 -m unittest scripts.test_verify_fem_preview_surface_matrix`: 13/13
  passed.
- Targeted `fullmag-plan` tests listed above: 2/2 passed.
- Mechanical JSON/CSV inspection of the final 09:02:52 matrix and all five
  energy-qualification artifact sets: passed.
- Exact managed callback gate attempted with
  `just verify-fem-preview-callback-source-contract`: did not reach test
  execution because Docker failed to create the Compose network with
  `all predefined address pools have been fully subnetted`.
- Host diagnostic of the same Rust test also did not reach test execution:
  `fullmag-fem-sys` stopped because host `cmake` is absent. This host path is
  diagnostic only and is not counted as native proof.

The Docker failure is an environment limitation, not a product-test failure.
Official Docker guidance lists removing confirmed-unused networks, tearing down
stale Compose projects, reusing an external network, or configuring address
pools as remedies. No shared Docker network was pruned or reconfigured during
this review because that would mutate unrelated agent state.

The pre-existing modification to `.superpowers/sdd/progress.md` was preserved.
No production code was modified and no commit was created by this review.

## Implementer response to required findings (2026-07-23)

Submission status: `READY_FOR_REREVIEW`

This section records the implementation response and fresh evidence. It does not
alter the independent `SPEC_VERDICT: CHANGES_REQUIRED` or
`QUALITY_VERDICT: CHANGES_REQUIRED` above; only a new independent review may do
that.

### P1 response: native relaxation now fails closed

- A single material-owned guard rejects element-DG0 `M_s` at the native
  relaxation boundary without adding workflow state to `Context`.
- LLG-overdamped plans reject during Context construction and are guarded again
  at the pure-damping RK entry. The common direct-relaxation dispatcher rejects
  before PG-BB, nonlinear-CG, or tangent-plane implicit execution.
- The new public-ABI fixture first proves that ordinary CPU RK with exchange and
  consistent mass executes, then exercises all three direct algorithms on the
  same reusable handle and exercises LLG-overdamped backend creation.

RED command and result:

```text
env COMPOSE_PROJECT_NAME=fullmag just verify-fem-material-element-ms-contract
FAIL: DG0 direct relaxation must fail unavailable
exit 1
```

GREEN command and result: the same command returned exit 0 after all existing
material/context/interaction contracts and the new ABI fixture ran.

### P2 response: DG0 step-statistics reduction is allocation-free

- `average_magnetization_components` no longer creates three `3*N` unit vectors
  or invokes four mass-bilinear traversals.
- The material realization and adapter expose one direct active-element reduction
  returning three weighted component integrals plus the denominator.
- The allocation regression constructs Context/material state before enabling its
  counter, then measures only the actual average helper call and asserts zero heap
  allocations plus the expected `(0.25, 0.75, 0.0)` value.

RED command and result:

```text
env COMPOSE_PROJECT_NAME=fullmag just verify-fem-dg0-step-metrics-contract
FAIL: DG0 average magnetization must not heap-allocate
exit 1
```

GREEN result: the same command returned exit 0.

### Fresh integration evidence

- Managed runtime rebuild/export: exit 0 and final `bundle: valid`.
- Managed review-unit recipe: exit 0; callback 1/1, Task 5 runner 16/16,
  backend source-layout 2/2, and all focused API/CLI/planner tests passed.
- Focused real CPU ordinary-time DG0 energy artifact:
  `.fullmag/reports/fem-preview-energy-qualification/dg0-ms-native-relax-remediation`.
  It reached source step 52 with element-DG0 `M_s=400000..800000 A/m`; exchange,
  demag, external, and total projected integrals matched native scalars with a
  maximum relative error of `1.9450934198233654e-9`.
- Capability JSON parsed successfully and its Markdown/JSON DG0 notes both state
  native ABI enforcement plus allocation-free material-weighted statistics.

The canonical 216-row preview matrix was not rerun because this response does not
modify `native_fem.rs`, preview scheduling/materialization, API, frontend, or GPU
preview operators. The bounded native ABI test, allocation counter, rebuilt
managed bundle, review-unit recipe, and focused real CPU DG0 energy fixture are
the relevant new evidence.
