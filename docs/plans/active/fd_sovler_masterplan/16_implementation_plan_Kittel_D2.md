# Kittel k0 PBC Self-Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real runtime self-verification gate for modal/eigen `k=0` Kittel field sweeps, starting with the no-demag Zeeman-only K0-1 slice.

**Architecture:** Keep the already implemented DSL/IR/planner/verifier contract. Add the missing runtime validation layer in small pieces: summary/CSV artifact schema, branch-to-Kittel summarizer, tiny runtime fixture, and managed `just` gate. Do not implement the demag K0-3 gate until the no-demag K0-1 gate is deterministic.

**Tech Stack:** Python artifact verifier and tests, Rust `fullmag-runner` modal eigen artifact writer, Python DSL example/stage export, repo-managed container `just` runtime validation.

---

## File Structure

- Modify `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
  - Add validation for `validation/kittel_k0_pbc/summary.v1.json` and `points.v1.csv` once emitted.
  - Keep `--require-k0-kittel-field-sweep` backward-compatible with the current branch-only verifier until summary/CSV artifacts exist.
- Modify `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`
  - Add RED/GREEN tests for summary/CSV artifact requirements and failure classes.
- Modify `crates/fullmag-runner/src/eigen/artifacts.rs`
  - Add Kittel validation summary/CSV writing from `PathSolveResult.k0_kittel_validation`.
  - Keep the current `frequency_domain/manifest.v1.json` validation block.
- Modify `crates/fullmag-runner/src/eigen/orchestrator.rs`
  - Ensure the Kittel validation artifacts are written when modal eigen results include `k0_kittel_validation`.
- Add or modify a small Python example under `examples/`
  - Prefer `examples/fem_eigen_k0_kittel_zeeman_no_demag.py`.
  - It should author at least five `K0KittelFieldSample` entries and request modal eigen `k=[0,0,0]`.
- Modify `justfile`
  - Add `verify-fem-frequency-domain-eigen-k0-kittel-runtime`.
  - Add this target to the runtime suite only after it is deterministic.
- Update docs:
  - `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`
  - `docs/plans/active/fd_sovler_masterplan/10_patch_queue_current_status.md`

## Task 1: Artifact Verifier Summary/CSV Contract

**Files:**
- Modify: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- Modify: `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`

- [x] **Step 1: Write the failing summary/CSV acceptance test**

Add a test near `test_validator_accepts_k0_kittel_field_sweep`:

```python
def test_validator_accepts_k0_kittel_summary_and_points(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=tuple(k0_kittel_expected_frequency_hz(field) for field in fields),
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)
    validation_dir = tmp_path / "validation" / "kittel_k0_pbc"
    validation_dir.mkdir(parents=True)
    (validation_dir / "summary.v1.json").write_text(json.dumps({
        "schema_version": "frequency_domain_kittel_k0_validation.v1",
        "status": "passed",
        "test_id": "kittel_k0_pbc_zeeman_no_demag",
        "phasor_convention": "exp_plus_i_omega_t",
        "boundary_condition": "periodic_k0",
        "k_vector_rad_per_m": [0.0, 0.0, 0.0],
        "demag_kind": "none",
        "sweep_point_count": 3,
        "max_relative_frequency_error": 0.0,
        "median_relative_frequency_error": 0.0,
        "mode_selection": {
            "minimum_uniformity_score": 1.0,
            "minimum_branch_overlap": 1.0,
            "maximum_tangent_leakage": 0.0
        },
        "solver": {
            "backend": "modal_eigen",
            "execution_lane": "production_cpu",
            "requested_mode_count": 2,
            "max_eigen_residual_relative": 0.0
        }
    }))
    (validation_dir / "points.v1.csv").write_text(
        "field_index,H0_A_per_m,mu0_H0_T,expected_frequency_hz,eigen_frequency_hz,"
        "relative_frequency_error,selected_mode_index,eigenvalue_real,eigenvalue_imag,"
        "mode_residual_relative,uniformity_score,branch_overlap_previous,"
        "max_m0_dot_delta_m_abs,max_periodic_seam_mismatch\n"
        "0,15915.494309189535,0.02,0.0,0.0,0.0,0,0.0,1.0,0.0,1.0,1.0,0.0,0.0\n"
        "1,39788.735772973836,0.05,0.0,0.0,0.0,0,0.0,1.0,0.0,1.0,1.0,0.0,0.0\n"
        "2,79577.47154594767,0.10,0.0,0.0,0.0,0,0.0,1.0,0.0,1.0,1.0,0.0,0.0\n"
    )

    result = run_validator(tmp_path, "--require-k0-kittel-field-sweep")

    assert result.returncode == 0, result.stderr + result.stdout
```

- [x] **Step 2: Run the test to verify RED**

Run:

```bash
python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel_summary_and_points' -q
```

Expected: fail because the verifier does not yet parse or validate the summary/CSV artifacts.

- [x] **Step 3: Implement minimal summary/CSV validation**

Add a helper that, when `validation/kittel_k0_pbc/summary.v1.json` exists, validates:

```text
schema_version == frequency_domain_kittel_k0_validation.v1
status == passed
sweep_point_count >= 3
max_relative_frequency_error <= relative_tolerance from k0_kittel_validation
median_relative_frequency_error <= max_relative_frequency_error
boundary_condition in {periodic_k0, floquet_k0, gamma_k0}
k_vector_rad_per_m == [0, 0, 0] within 1e-9
```

Add CSV validation that checks:

```text
required columns exist
row count == summary.sweep_point_count
all relative_frequency_error values are finite and <= tolerance
H0_A_per_m is strictly increasing
eigen_frequency_hz is strictly increasing
```

- [x] **Step 4: Run the summary/CSV tests to verify GREEN**

Run:

```bash
python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel' -q
```

Expected: all Kittel verifier tests pass.

## Task 2: Runner Kittel Summary/CSV Writer

**Files:**
- Modify: `crates/fullmag-runner/src/eigen/artifacts.rs`

- [x] **Step 1: Write the failing Rust artifact test**

Add a test next to `eigen_manifest_carries_k0_kittel_validation_contract`:

```rust
#[test]
fn eigen_artifacts_write_k0_kittel_summary_and_points() {
    let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-summary");
    let result = sample_result_with_k0_kittel_sweep();

    write_path_bundle(&temp.path, &result).expect("path bundle should write");
    write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
    write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
    write_frequency_domain_eigen_manifest(&temp.path, &result)
        .expect("frequency-domain eigen manifest should write");

    let summary_path = temp.path.join("validation/kittel_k0_pbc/summary.v1.json");
    let points_path = temp.path.join("validation/kittel_k0_pbc/points.v1.csv");
    assert!(summary_path.exists());
    assert!(points_path.exists());
}
```

Implementation note: the fixture must include three zero-k samples and one tracked branch covering all declared validation samples. A one-sample manifest-only fixture is no longer valid once the writer is active.

- [x] **Step 2: Run the test to verify RED**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner eigen_artifacts_write_k0_kittel_summary_and_points --lib
```

Expected: fail because no `validation/kittel_k0_pbc` artifacts are written.

- [x] **Step 3: Implement minimal writer**

In `write_frequency_domain_eigen_manifest`, after the manifest is assembled, call a new private helper:

```rust
write_k0_kittel_validation_artifacts(base_dir, result)?;
```

The helper should:

```text
return Ok(()) when result.k0_kittel_validation is None
create validation/kittel_k0_pbc
compute expected frequencies from gamma0 and model
choose the best existing branch covering all declared samples
write summary.v1.json
write points.v1.csv
```

For this first slice, use branch coverage exactly like the Python verifier. Do not add a new uniformity selector in this task.

- [x] **Step 4: Run the Rust artifact tests to verify GREEN**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner eigen_artifacts_write_k0_kittel_summary_and_points --lib
CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner eigen --lib
```

Expected: both pass.

Observed:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner eigen_artifacts_write_k0_kittel_summary_and_points --lib
# 1 passed

CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner eigen --lib
# 59 passed

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -q
# 120 passed
```

## Task 3: Python Example for K0-1 Zeeman No-Demag Sweep

**Files:**
- Create: `examples/fem_eigen_k0_kittel_zeeman_no_demag.py`
- Modify: `packages/fullmag-py/tests/test_api.py`

- [x] **Step 1: Write a Python DSL export test**

Add a test that imports/exports the example and asserts runtime metadata contains:

```text
k0_kittel_validation.kind == k0_kittel_field_sweep
k0_kittel_validation.model == macrospin_larmor
len(k0_kittel_validation.samples) >= 5
all sample bias fields are nonzero A/m vectors
```

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k 'k0_kittel' -q
```

Expected: fail until the example exists or is wired.

- [x] **Step 2: Add the example**

Create a minimal FEM eigen script with:

```text
uniform material
Zeeman-only or exchange+Zeeman with demag disabled
k_sampling single [0,0,0]
at least five H0 samples in A/m from [0.02, 0.05, 0.10, 0.20, 0.40] T / mu0
K0KittelFieldSweepValidation(model="macrospin_larmor")
```

Do not include dynamic demag, DMI, STT, anisotropy, or GPU hints.

- [x] **Step 3: Run the Python DSL tests to verify GREEN**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k 'k0_kittel' -q
```

Expected: pass.

Observed:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k 'k0_kittel' -q
# 3 passed
```

## Task 4: Managed Runtime Gate

**Files:**
- Modify: `justfile`
- Modify: `scripts/test_frequency_domain_runtime_targets.py`

- [x] **Step 1: Add a failing runtime target discovery test**

In `scripts/test_frequency_domain_runtime_targets.py`, assert that the `justfile` contains:

```text
verify-fem-frequency-domain-eigen-k0-kittel-runtime
--require-k0-kittel-field-sweep
validation/kittel_k0_pbc/summary.v1.json
validation/kittel_k0_pbc/points.v1.csv
```

Run:

```bash
python3 -m pytest scripts/test_frequency_domain_runtime_targets.py -k 'kittel' -q
```

Expected: fail until the target is added.

- [x] **Step 2: Add the managed `just` target**

Follow the pattern of `verify-fem-frequency-domain-eigen-production-gamma-k-path-runtime`:

```text
verify-fem-frequency-domain-eigen-k0-kittel-runtime:
    just ensure-managed-fem-runtime
    remove .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime
    run fullmag with examples/fem_eigen_k0_kittel_zeeman_no_demag.py
    assert eigen/spectrum.v2.json exists
    assert eigen/branches.v2.json exists
    assert frequency_domain/manifest.v1.json exists
    assert validation/kittel_k0_pbc/summary.v1.json exists
    assert validation/kittel_k0_pbc/points.v1.csv exists
    run scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-field-sweep
```

Use the container-backed `just` route. Do not replace it with host `cargo`, host `cmake`, raw Docker, or direct native binaries.

- [x] **Step 3: Run target discovery test to verify GREEN**

Run:

```bash
python3 -m pytest scripts/test_frequency_domain_runtime_targets.py -k 'kittel' -q
```

Expected: pass.

Observed:

```bash
python3 -m pytest scripts/test_frequency_domain_runtime_targets.py -k 'kittel' -q
# 1 passed
```

- [ ] **Step 4: Run the managed runtime gate**

Run:

```bash
just verify-fem-frequency-domain-eigen-k0-kittel-runtime
```

Expected: pass. If it fails because the modal runtime does not yet sweep bias-field samples, stop and record the exact blocker in `10_patch_queue_current_status.md`; do not weaken the Kittel validation.

Observed on 2026-07-07:

```bash
just verify-fem-frequency-domain-eigen-k0-kittel-runtime
```

The managed runtime rebuilt and executed
`examples/fem_eigen_k0_kittel_zeeman_no_demag.py`, producing five k=0 samples.
The verifier rejected the bundle because every sample had the same frequency:

```text
560052842.5830296 Hz
k0 Kittel field sweep branch frequency must increase with bias field
```

Root blocker from that run: modal k-path execution sampled k-vectors but did
not apply per-sample static bias-field overrides from `K0KittelFieldSample`.
`plan.external_field` remained one global value for all samples. Do not weaken
the validator.

Follow-up in this implementation pass:

```text
The production multi-k dispatch artifact path now carries
validation.k0_kittel_validation and emits validation/kittel_k0_pbc/summary.v1.json
plus validation/kittel_k0_pbc/points.v1.csv when PathSolveResult branch data
covers the declared K0 samples.

The production multi-k dispatch adapter now also applies
K0KittelFieldSample.bias_field as the per-sample point_plan.external_field for
matching sample_index values.
```

Managed-runtime update on 2026-07-08:

```text
just verify-fem-frequency-domain-eigen-k0-kittel-runtime passed with the
managed FEM runtime. The run produced the required spectrum, branch,
dispersion, frequency-domain manifest, validation summary, and validation CSV
artifacts, then passed scripts/verify_fem_frequency_domain_eigen_artifacts.py
--require-k0-kittel-field-sweep.

One additional fixture correction was required: the original 5 GHz frequency
window excluded the declared 0.2 T and 0.4 T Kittel samples after the
per-sample field override became active. Operator diagnostics showed
generalized_positive_frequency_min_hz=5600528425.83022 for the 0.2 T sample.
The fixture now uses frequency_max=13 GHz for the 0.02-0.4 T sweep.
```

## Task 5: Docs Status Update

**Files:**
- Modify: `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`
- Modify: `docs/plans/active/fd_sovler_masterplan/10_patch_queue_current_status.md`

- [x] **Step 1: Update D2 status only after runtime evidence exists**

If `just verify-fem-frequency-domain-eigen-k0-kittel-runtime` passes, update:

```text
D2b runtime fixture: implemented
D2d dedicated artifacts: implemented
D2e managed CI gate: implemented for K0-1
D2c uniform-mode selector: implemented for native full_2x2 K0 after managed proof
D2f demag extended gate: still deferred
```

The target now passes for the K0-1 no-demag gate, so the status is:

```text
D2b runtime fixture: green for K0-1 no-demag
D2c uniform-mode selector: green for K0-1 no-demag
D2d dedicated artifacts: green for K0-1 no-demag
D2e managed CI gate: green for K0-1 no-demag as of 2026-07-08
D2f demag extended gate: still deferred
```

- [x] **Step 2: Re-run documentation sanity checks**

Run:

```bash
python3 -m json.tool docs/plans/active/fd_sovler_masterplan/documentation_manifest.json >/tmp/fullmag-fd-v5-manifest.json
rg -n "D2|k0_kittel|Kittel|runtime self-verification|Artifact-level" docs/plans/active/fd_sovler_masterplan
```

Expected: manifest parses and D2 status is internally consistent.

Observed:

```bash
python3 -m json.tool docs/plans/active/fd_sovler_masterplan/documentation_manifest.json
# parsed successfully

rg -n "D2|k0_kittel|Kittel|runtime self-verification|Artifact-level" docs/plans/active/fd_sovler_masterplan
# shows D2 K0-1 as green and D2f demag as deferred
```

## Final Verification

Run these before reporting the D2 K0-1 slice as implemented:

```bash
python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel' -q
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k 'k0_kittel' -q
CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner eigen --lib
python3 -m pytest scripts/test_frequency_domain_runtime_targets.py -k 'kittel' -q
just verify-fem-frequency-domain-eigen-k0-kittel-runtime
```

Only the last command is runtime proof for the managed FEM stack. The host-side Python and Rust tests are necessary but not sufficient for FEM runtime completion.

## Self-Review

Spec coverage:

```text
15_self_weryfication_Kittel.md requires a no-demag K0-1 gate, summary JSON,
points CSV, branch/mode selection, verifier coverage, and managed CI. Tasks 1-4
cover those requirements for the first no-demag slice. K0-3 demag remains
explicitly deferred.
```

Known planned gap:

```text
The native full_2x2 K0 path now derives and carries per-node mass weights for
the mass-weighted uniform-mode selector. Do not mark D2 complete until the
container-backed K0-1 gate passes after this plumbing and K0-3 remains
explicitly deferred.
```
