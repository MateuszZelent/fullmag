# Task 5 final independent re-review

Reviewed range: `7599f78968ca21014685d1617eb14f3dc8a69bca..c2c65ad6d91cbdfbed2caa0a10c10ebbca911c24`

Final remediation commit: `c2c65ad6d91cbdfbed2caa0a10c10ebbca911c24`

Review date: 2026-07-23

## Verdicts

`SPEC_VERDICT: APPROVED`

`QUALITY_VERDICT: APPROVED`

No actionable findings remain in the reviewed Task 5 scope. Commit `c2c65ad6`
closes the two blockers from the preceding independent review with native
fail-closed enforcement, executable managed regressions, an allocation-free
material reduction, and a fresh ordinary-time DG0 runtime artifact. The
previously approved four-state freshness/provenance, conservative energy
projection, five energy variants, callback test inclusion, matrix serializer,
and removal of the stale documentation-presence assertion remain unchanged.

## Scope and matrix-rerun decision

The final remediation changes native FEM material/runtime code, two native
contracts, CMake/`just` gates, and the canonical physics/capability documents.
It does not change `crates/fullmag-runner/src/native_fem.rs`, GPU preview
snapshot/materialization code, API freshness, Control Room code, or the matrix
verifier. Therefore the 216-run cross-surface matrix was not repeated. The
fresh focused DG0 run is the proportional runtime check for the changed CPU
lane; the prior 216-run artifact remains the accepted preview/GPU evidence.

## Blocker P1 closure: native ABI rejects every DG0 relaxation route

### Source enforcement

- `validate_elementwise_ms_relaxation_support` returns false with an explicit
  `Ms_element_field`/ordinary-RK diagnostic whenever element-DG0 `M_s` reaches
  a native relaxation boundary
  (`backends/fem/core/fem_material_fields.cpp:298-305`).
- Context construction rejects a no-precession plan with relaxation stop
  criteria before MFEM runtime initialization
  (`backends/fem/core/fem_context_builder.cpp:126-132`). This is the native
  LLG-overdamped plan boundary.
- `run_backend_step` repeats the same LLG-overdamped guard before the first RK
  attempt (`backends/fem/cpu/mfem/runtime/backend_step.cpp:201-211`). The
  duplicate boundary is intentional fail-closed protection for a reusable
  context.
- `run_backend_relaxation_step` rejects before algorithm dispatch
  (`backend_step.cpp:284-294`), so PG-BB, nonlinear-CG, and tangent-plane cannot
  enter their native implementation from a reusable ordinary-time handle.
- Ordinary precessional explicit RK is not rejected by either guard.

This mirrors the existing planner restriction without moving workflow policy
into Rust or weakening the allowed CPU exchange/consistent-mass lane.

### Native ABI regression

`backends/fem/tests/element_dg0_workflow_contract.cpp:84-140` uses the public C
ABI and proves all required branches:

1. a CPU/double DG0 plan with exchange and consistent mass creates a handle and
   completes `fullmag_fem_backend_step` with `FULLMAG_FEM_OK`;
2. the same reusable handle returns `FULLMAG_FEM_ERR_UNAVAILABLE` with a named
   material/workflow error for PG-BB, nonlinear-CG, and tangent-plane;
3. an LLG-overdamped plan (`precession_enabled=false` plus relaxation stop
   criteria) fails at `fullmag_fem_backend_create`.

The target is linked to `fullmag_fem`, registered with CTest, and explicitly
executed by `verify-fem-material-element-ms-contract`.

`P1 STATUS: CLOSED`

## Blocker P2 closure: allocation-free one-pass DG0 average

### Numerical realization

`P1TetrahedralMaterialRealization::ms_weighted_aos3_average_reduction`
(`backends/fem/core/fem_element_quadrature_material.cpp:349-386`) performs one
traversal over the precomputed active element ordinals. For each active P1
tetrahedron it accumulates

```text
numerator += M_s,T * V_T * (sum_i m_i) / 4
denominator += M_s,T * V_T
```

for all three components. The return type contains only three doubles and one
denominator. There are no nodal unit fields, DG0-to-node projection, scratch
vectors, `new`, or `malloc` on the valid path. Size/location/nonfinite checks
fail explicitly.

`average_magnetization_components` calls this adapter once and divides the
three accumulated components by the common denominator
(`backends/fem/cpu/mfem/runtime/step_metrics.cpp:20-38`). The former three
mesh-sized vectors and four mass-bilinear traversals are gone.

### Allocation-counter validity

`backends/fem/tests/step_metrics_contract.cpp:19-52,253-292`:

- overrides global throwing `operator new` and `operator new[]` in the test
  executable;
- constructs all context/material state before enabling the probe;
- enables the counter only around the actual production
  `average_magnetization_components` call;
- asserts zero allocations and independently checks the expected weighted
  average `(0.25, 0.75, 0.0)`.

The counter observes allocations made inside the linked production shared
library, not a copied test helper. `readelf -Ws` confirms that
`fem_step_metrics_contract` defines global `_Znwm`/`_Znam`, while
`libfullmag_fem.so` imports those symbols and contains the production
`ms_weighted_aos3_average_reduction` implementation. It would therefore count
the `std::vector` allocations used by the previous implementation. The helper's
current valid path performs none.

The focused target is also included in the broader material gate and has its
own `verify-fem-dg0-step-metrics-contract` recipe.

`P2 STATUS: CLOSED`

## Fresh managed DG0 runtime artifact

Artifact:
`.fullmag/reports/fem-preview-energy-qualification/dg0-ms-native-relax-remediation`

Independent inspection of `summary.json`, `raw_rows.json`, and measured-run
metadata confirms:

- one warm-up plus one measured `interactive_no_browser/full_cache` run;
- `execution_engine=fem_cpu_native`, `mfem_device=cpu`, double precision;
- ordinary precessional RK45, `relaxation=null`;
- exchange enabled with `use_consistent_mass=true`;
- Poisson-Robin demag and Zeeman enabled;
- no nodal `ms_field`; 420 element-DG0 values spanning
  `400000..800000 A/m`;
- source step 52 and complete terminal fields;
- conservative location `fem_nodal_conservative_tetra_projection`;
- native-scalar comparison errors:
  - `eden_ex`: `3.1071020392641258e-12` relative;
  - `eden_demag`: `1.9450934198233654e-9` relative;
  - `eden_ext`: `5.127337643115762e-15` relative;
  - `eden_total`: `9.898426546466125e-11` relative;
- production callback maximum 244,802 ns and callback-plus-fence maximum
  315,875 ns against the 2,000,000 ns deadline, with zero wall outliers.

This artifact proves that the new relaxation guards do not reject or perturb
the qualified ordinary CPU RK path. It is not used as proof of the fail-closed
branches or allocation count; those are covered by the managed native gates.

## Verification performed during final re-review

- `git diff --check 156322e8f1c5cfaeb88386734a90ff326c457538..c2c65ad6d91cbdfbed2caa0a10c10ebbca911c24`:
  passed.
- `verify-fem-dg0-step-metrics-contract`: passed in the managed
  `fullmag/fem-gpu:local` container; `fullmag_fem` and
  `fem_step_metrics_contract` built and the allocation-counter executable
  exited 0.
- `verify-fem-material-element-ms-contract`: passed in the same managed
  container. All 15 requested native targets built; the recipe executed the new
  ABI workflow contract, step-metrics contract, and the existing material,
  exchange, Zeeman, anisotropy, and Poisson-demag contracts; exit 0.
- Fresh DG0 runtime artifact: mechanically verified as listed above.
- Symbol-level allocation-probe inspection with `readelf`: passed.

The repository's normal Compose invocation still cannot allocate a new project
network because the Docker daemon reports `all predefined address pools have
been fully subnetted`. No network was pruned. For independent execution, both
unchanged `just` recipe bodies were run with a temporary Compose override that
attached only the test container to the already-existing user-defined
`fullmag_default` network. This changed networking plumbing only; image, source
mount, CMake flags, targets, linked libraries, and executable commands remained
the authoritative managed recipe. The override file and the three temporary
unused cache volumes created during the workaround were removed afterward.

The pre-existing unrelated modification to `.superpowers/sdd/progress.md` was
preserved. This review changed only this reviewer-owned report, modified no
production code, and created no commit.
