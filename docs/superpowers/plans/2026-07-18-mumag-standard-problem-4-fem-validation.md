# µMAG Standard Problem 4 FEM Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and execute a fail-closed NIST µMAG Standard Problem 4 qualification suite proving that strict production Fullmag FEM CPU and strict production Fullmag FEM GPU solve both SP4 reversal cases correctly, converge in mesh/airbox, and agree with each other.

**Architecture:** One backend-neutral SP4 contract and one immutable NIST reference corpus feed parsers, trajectory/zero-crossing/spatial metrics, and a shared validator. A public Fullmag FEM study script materializes one requested phase/case/device/mesh at a time; a managed `just` recipe orchestrates relaxation, both dynamic cases, replay snapshots, CPU/GPU parity, mesh convergence, airbox convergence, and report generation without runtime downloads or silent fallback.

**Tech Stack:** Python 3.10+, NumPy, pytest 9, Fullmag Python DSL and ProblemIR, native MFEM/hypre/libCEED/CUDA FEM runtime, Bash, repository `just` recipes.

## Global Constraints

- NIST is authoritative; MuMax3 endpoint values are supplementary regression metrics only.
- Validate both fields `(-24.6, 4.3, 0) mT` and `(-35.5, -6.3, 0) mT` from one content-identical relaxed S-state per mesh.
- Validate strict FEM CPU and strict FEM GPU in `double`; GPU demag must resolve to `device_hypre_poisson`, never `hybrid_cpu_poisson`.
- Use native `Ms x lumped-volume` averages from `scalars.csv`; never use an unweighted node average as the NIST observable.
- Main trajectories are uninterrupted runs sampled every `1 ps`; replay runs start from the same S-state and stop independently at the bracketing zero-crossing times.
- Magnetic P1 mesh levels are `3.0 nm`, `2.0 nm`, and `1.5 nm`.
- Airboxes are `700 x 250 x 250 nm` and `1000 x 500 x 500 nm`, each with `airbox_hmax = 20 nm`.
- Runtime reference data is local and SHA-256 checked; no qualification command downloads data.
- Authoritative FEM build/runtime proof uses repository-managed `just` recipes.
- Do not mark either lane physics-validated unless its NIST, convergence, provenance, and no-fallback gates all pass.

---

### Task 1: Extend the approved design to strict CPU and GPU qualification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-mumag-standard-problem-4-fem-validation-design.md`
- Create: `tests/standard_problems/README.md`
- Create: `tests/standard_problems/mumag/sp4/README.md`

**Interfaces:**
- Consumes: the approved CPU design and the user objective requiring CPU and GPU proof.
- Produces: explicit acceptance semantics used by every later task.

- [ ] **Step 1: Update scope statements and completion criteria**

Record strict CPU and strict GPU as separate required lanes, require `device_hypre_poisson` for GPU, add CPU/GPU trajectory and final-state parity gates (`RMSE <= 0.02`, zero-crossing delta `<= 10 ps`, component endpoint delta `<= 0.02`), and require the three-mesh plus airbox matrix on both lanes.

- [ ] **Step 2: Document suite ownership and invocation**

Document `tests/standard_problems/mumag/sp4` as the canonical shared problem and `just verify-fem-standard-problem-4` as the full managed CPU/GPU gate. State that `tests/stdprob4_dynamics.py` is the old FDM prototype and cannot prove FEM qualification.

- [ ] **Step 3: Verify the documentation diff**

Run:

```bash
rg -n "device_hypre_poisson|CPU/GPU|verify-fem-standard-problem-4|three.*mesh|three-mesh" docs/superpowers/specs/2026-07-18-mumag-standard-problem-4-fem-validation-design.md tests/standard_problems/README.md tests/standard_problems/mumag/sp4/README.md
git diff --check
```

Expected: all required scope markers are present and `git diff --check` exits zero.

---

### Task 2: Vendor immutable NIST reference inputs with checksums

**Files:**
- Create: `tests/standard_problems/mumag/sp4/references/manifest.json`
- Create: `tests/standard_problems/mumag/sp4/references/nist/oommf/stdprob4a.odt`
- Create: `tests/standard_problems/mumag/sp4/references/nist/oommf/stdprob4b.odt`
- Create: `tests/standard_problems/mumag/sp4/references/nist/oommf/stdprob4a-138ps.omf`
- Create: `tests/standard_problems/mumag/sp4/references/nist/oommf/stdprob4b-137ps.omf`
- Create: `tests/standard_problems/mumag/sp4/references/nist/oommf/stdprob4-start.omf`
- Create: `tests/standard_problems/mumag/sp4/references/nist/albuquerque/FIELD_1_SM_DT25.TXT`
- Create: `tests/standard_problems/mumag/sp4/references/nist/albuquerque/FIELD_1_LM_DT25.TXT`
- Create: `tests/standard_problems/mumag/sp4/references/nist/albuquerque/FIELD_1_SM_MxEQ0.OVF`
- Create: `tests/standard_problems/mumag/sp4/references/nist/albuquerque/FIELD_2_SM_DT25.TXT`
- Create: `tests/standard_problems/mumag/sp4/references/nist/albuquerque/FIELD_2_LM_DT25.TXT`
- Create: `tests/standard_problems/mumag/sp4/references/nist/albuquerque/FIELD_2_SM_MxEQ0.OVF`
- Test: `tests/standard_problems/mumag/sp4/fem/test_contract.py`

**Interfaces:**
- Consumes: official HTTPS URLs and observed SHA-256 digests.
- Produces: `load_reference_manifest(path: Path) -> ReferenceManifest` and immutable files used offline.

- [ ] **Step 1: Write the failing checksum test**

Add a test that loads `manifest.json`, asserts the exact eleven relative paths, URLs, authors, units, mesh descriptions, and SHA-256 values, then recomputes each digest. The expected OOMMF trajectory digests are `d80253f04485cc189d91c900a121b516926b0082928ff288e20f912ea066070b` and `deb6211a09eb084282e43063e79391f656e52ffd5c25cd4951ce62eeb1ed1453`; include the remaining nine observed digests in the manifest and assertion.

- [ ] **Step 2: Run RED**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest tests/standard_problems/mumag/sp4/fem/test_contract.py::test_reference_manifest_covers_and_verifies_official_nist_files -q
```

Expected: FAIL because the manifest/parser/reference tree does not exist.

- [ ] **Step 3: Copy the already inspected official files and write the manifest**

Copy the exact `/tmp` downloads into the paths above as bulk immutable data. `manifest.json` must use schema `fullmag.mumag.sp4.references.v1`, record download date `2026-07-18`, source URLs, raw formats, coordinate/unit conventions, SHA-256, and the deterministic axis transform (if any). No test command may contain a network URL fetch.

- [ ] **Step 4: Implement checksum loading**

In `common/references.py`, implement dataclasses `ReferenceFile` and `ReferenceManifest`, `sha256_file(path: Path) -> str`, and `load_reference_manifest(path: Path, verify: bool = True) -> ReferenceManifest`. Reject missing files, duplicate IDs/paths, malformed 64-hex digests, checksum mismatch, unknown formats, and paths escaping the reference root.

- [ ] **Step 5: Run GREEN**

Run the RED command again.

Expected: PASS and all eleven files verify offline.

---

### Task 3: Implement the canonical SP4 contract and reference parsers test-first

**Files:**
- Create: `tests/standard_problems/__init__.py`
- Create: `tests/standard_problems/mumag/__init__.py`
- Create: `tests/standard_problems/mumag/sp4/__init__.py`
- Create: `tests/standard_problems/mumag/sp4/common/__init__.py`
- Create: `tests/standard_problems/mumag/sp4/common/contract.py`
- Create: `tests/standard_problems/mumag/sp4/common/references.py`
- Modify: `tests/standard_problems/mumag/sp4/fem/test_contract.py`

**Interfaces:**
- Produces: `SP4Contract`, `SP4Case`, `MeshLevel`, `AirboxVariant`, `CONTRACT`, `parse_oommf_odt`, `parse_albuquerque_trace`, `parse_ovf2_rectangular`, and `parse_albuquerque_vector_map`.

- [ ] **Step 1: Write failing physical-contract tests**

Assert exact SI values, normalized initial vector, gamma, sampling, equilibrium window, both fields, mesh levels, airboxes, and that case/device/mesh IDs are stable strings. Assert construction rejects non-positive dimensions, invalid device, and duplicate case IDs.

- [ ] **Step 2: Write failing parser tests**

Use small in-test text/binary fixtures to require:

```python
trace = parse_oommf_odt(path)
assert trace.time_s.tolist() == [0.0, 1e-12]
assert trace.m.shape == (2, 3)

field = parse_ovf2_rectangular(path)
assert field.shape == (2, 1, 1, 3)
assert field.values_are_reduced_magnetization
```

Also require malformed headers, truncated binary payloads, non-monotonic time, non-finite values, and wrong units to raise `ReferenceDataError`.

- [ ] **Step 3: Run RED**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest tests/standard_problems/mumag/sp4/fem/test_contract.py -k "contract or parser" -q
```

Expected: FAIL on missing contract/parser interfaces.

- [ ] **Step 4: Implement the minimum contract and parsers**

Parse OOMMF column names instead of hard-coded numeric indices; convert OOMMF magnetization from `A/m` to reduced `m` using `Ms=800e3 A/m`; parse binary-8 OVF byte-order check value; parse Albuquerque time from ns to seconds. Preserve source metadata on returned `Trajectory` and `VectorField` dataclasses.

- [ ] **Step 5: Run GREEN and real-data sanity checks**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest tests/standard_problems/mumag/sp4/fem/test_contract.py -k "contract or parser" -q
PYTHONPATH=packages/fullmag-py/src python3 -m tests.standard_problems.mumag.sp4.common.references --manifest tests/standard_problems/mumag/sp4/references/manifest.json --summary
```

Expected: tests pass; summary reports 1001 OOMMF samples for each case, first crossings near 138 ps/137 ps, a `500 x 125 x 3` OOMMF field, and finite Albuquerque traces.

---

### Task 4: Implement trajectory, zero-crossing, spatial, convergence, and parity metrics

**Files:**
- Create: `tests/standard_problems/mumag/sp4/common/metrics.py`
- Modify: `tests/standard_problems/mumag/sp4/fem/test_contract.py`

**Interfaces:**
- Consumes: `Trajectory`, `VectorField`, reference ensembles, Fullmag artifacts.
- Produces: `find_first_zero_crossing`, `interpolate_trajectory`, `reference_envelope_metrics`, `interpolate_crossing_field`, `project_fem_midplane`, `vector_field_metrics`, `convergence_metrics`, and `parity_metrics`.

- [ ] **Step 1: Write failing scalar metric tests**

Cover a crossing inside a sample interval, a crossing exactly on a sample, no crossing, repeated times, reference-envelope inside/outside distance, RMS, percentile-99, endpoint errors, and non-finite input rejection. Assert the scale is exactly `max(max_ref-min_ref, 0.02)`.

- [ ] **Step 2: Write failing spatial and parity metric tests**

On a small tetra/node fixture, require deterministic midplane sampling at fixed NIST coordinates, normalized interpolation, vector correlation, component RMSE, no axis auto-flipping, trajectory RMSE, endpoint delta, and crossing-time delta.

- [ ] **Step 3: Run RED**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest tests/standard_problems/mumag/sp4/fem/test_contract.py -k "metric or crossing or projection or parity or convergence" -q
```

Expected: FAIL because metric functions are missing.

- [ ] **Step 4: Implement metrics with NumPy**

Use linear time interpolation, barycentric tetra interpolation for FEM fields, deterministic tie-breaking on shared faces, and explicit reduced-magnetization normalization. Return JSON-serializable dataclasses/dicts with every raw component metric; do not collapse failures into a single boolean.

- [ ] **Step 5: Run GREEN**

Run the RED command again.

Expected: PASS.

---

### Task 5: Implement the fail-closed validator and reports

**Files:**
- Create: `tests/standard_problems/mumag/sp4/common/validation.py`
- Create: `tests/standard_problems/mumag/sp4/common/reporting.py`
- Create: `tests/standard_problems/mumag/sp4/fem/verify.py`
- Modify: `tests/standard_problems/mumag/sp4/fem/test_contract.py`

**Interfaces:**
- Produces: `validate_run_bundle(root: Path, manifest: ReferenceManifest, contract: SP4Contract) -> ValidationReport`, CLI `python3 -m tests.standard_problems.mumag.sp4.fem.verify ROOT`, and files `metrics.json`, `validation.json`, `report.md`, and PNG plots/maps.

- [ ] **Step 1: Write failing synthetic-bundle acceptance and rejection tests**

Build minimal temporary artifact trees and prove the validator rejects each independently: missing checksum, missing scalar column, short time coverage, NaN, missing crossing, different initial-state hashes, unweighted-average provenance, CPU fallback, GPU fallback, GPU hybrid demag, missing demag residual/iterations, norm defect, trajectory threshold, map threshold, mesh thickness, mesh convergence, airbox convergence, and CPU/GPU parity. Include one fully passing synthetic bundle.

- [ ] **Step 2: Run RED**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest tests/standard_problems/mumag/sp4/fem/test_contract.py -k "validator or report" -q
```

Expected: FAIL because validator/reporting interfaces are missing.

- [ ] **Step 3: Implement validator and deterministic reports**

Require the exact design thresholds. Separate statuses `execution_failure`, `artifact_failure`, `physics_failure`, `convergence_failure`, and `passed`. Render tables for NIST metrics, MuMax endpoints, convergence, airbox, CPU/GPU parity, runtime provenance, and mesh statistics. Use Matplotlib's non-interactive `Agg` backend and stable filenames.

- [ ] **Step 4: Run GREEN**

Run the RED command again, then all SP4 unit tests.

Expected: PASS with no warnings.

---

### Task 6: Implement the public Fullmag FEM SP4 study and IR contract tests

**Files:**
- Create: `tests/standard_problems/mumag/sp4/fem/__init__.py`
- Create: `tests/standard_problems/mumag/sp4/fem/problem.py`
- Create: `tests/standard_problems/mumag/sp4/fem/run.py`
- Modify: `tests/standard_problems/mumag/sp4/fem/test_contract.py`
- Test: `packages/fullmag-py/tests/test_standard_problem_4_fem.py`

**Interfaces:**
- Produces: `SP4RunRequest.from_environment()`, `build_study(request) -> tuple[StudyBuilder, MagnetHandle]`, and a CLI-loadable flat study for phases `relax`, `dynamic`, `replay-before`, and `replay-after`.

- [ ] **Step 1: Write failing environment and lowering tests**

Assert unknown phase/case/device/mesh/airbox values fail closed. For valid requests, capture ProblemIR and assert FEM, requested device, `double`, P1, exact geometry/material/gamma/field, `poisson_robin`, `CG+AMG`, `1e-12` demag relative tolerance, no PBC, exact output cadence, and one run stage with no segmented main trajectory.

- [ ] **Step 2: Run RED**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_standard_problem_4_fem.py -q
```

Expected: FAIL because `problem.py` and request types are missing.

- [ ] **Step 3: Implement the study**

Use `study.device(request.device, precision="double")`, explicit manual universe sizes, P1 object mesh controls, `gamma=2.211e5`, `integrator="rk45"`, exact demag refresh, `study.tableautosave(1e-12, quantities=[...])`, and content-addressed JSON magnetic initial states extracted from relaxation artifacts. The relax phase uses zero field and a native supported minimizer/overdamped workflow with explicit stop controls; dynamics uses `alpha=0.02` and one `study.run` stage.

- [ ] **Step 4: Run GREEN**

Run the RED command again and the existing relaxation contract test.

Expected: both suites pass.

---

### Task 7: Add managed orchestration and target contract tests

**Files:**
- Create: `scripts/verify_fem_standard_problem_4.sh`
- Create: `scripts/run_fem_standard_problem_4_case.py`
- Create: `scripts/test_fem_standard_problem_4_runtime_targets.py`
- Modify: `justfile`

**Interfaces:**
- Produces: `just verify-fem-standard-problem-4`, `just verify-fem-standard-problem-4-smoke`, and environment filters `FULLMAG_SP4_DEVICES`, `FULLMAG_SP4_MESH_LEVELS`, `FULLMAG_SP4_CASES`, `FULLMAG_SP4_AIRBOXES` that narrow execution but never change full-target defaults.

- [ ] **Step 1: Write failing target tests**

Assert the full target calls `just verify-fem-time-domain-native-contract`, `just ensure-managed-fem-runtime`, defaults to `cpu gpu`, forces `FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson`, forbids `hybrid_cpu_poisson`, produces distinct artifact roots, runs both cases/three meshes/two airboxes, invokes the validator, and propagates nonzero exit status.

- [ ] **Step 2: Run RED**

Run:

```bash
python3 -m pytest scripts/test_fem_standard_problem_4_runtime_targets.py -q
```

Expected: FAIL because targets/scripts are missing.

- [ ] **Step 3: Implement managed orchestration**

Reuse `gpu_runtime_bin`, repository Python, existing magnetic-slice extraction, and managed runtime patterns. Preserve source-state SHA-256 in each case manifest. Capture stdout/stderr per run and write a top-level run manifest even when a child fails. The smoke uses a coarse bounded time/step override and is explicitly non-qualifying.

- [ ] **Step 4: Run GREEN and shell checks**

Run:

```bash
python3 -m pytest scripts/test_fem_standard_problem_4_runtime_targets.py -q
bash -n scripts/verify_fem_standard_problem_4.sh
just --summary | tr ' ' '\n' | rg '^verify-fem-standard-problem-4(-smoke)?$'
```

Expected: tests and syntax pass; both recipes are listed.

---

### Task 8: Run managed prerequisite and smoke gates on CPU and GPU

**Files:**
- Modify only if a reproduced backend/runtime defect requires a test-first fix in its existing owner.

**Interfaces:**
- Consumes: managed recipes from Task 7.
- Produces: authoritative strict CPU/GPU smoke evidence and actionable defects.

- [ ] **Step 1: Run the native time-domain contract**

Run:

```bash
just verify-fem-time-domain-native-contract
```

Expected: all native FEM LLG, adaptive RK, snapshot, demag, and CUDA guard contract binaries pass.

- [ ] **Step 2: Ensure the managed runtime is fresh**

Run:

```bash
just ensure-managed-fem-runtime
```

Expected: current managed runtime is accepted or rebuilt through the repository recipe.

- [ ] **Step 3: Run both smoke lanes**

Run:

```bash
FULLMAG_SP4_DEVICES="cpu gpu" just verify-fem-standard-problem-4-smoke
```

Expected: CPU resolves `fem_cpu_native`, GPU resolves `fem_native_gpu`, both are `double`, GPU uses `device_hypre_poisson`, neither falls back, and validator labels smoke as non-qualifying.

- [ ] **Step 4: Fix reproduced defects test-first**

For every runtime defect, first add the smallest failing test at the owning layer, reproduce RED, patch only the owner, rebuild with `just rebuild-fem-runtime`, and repeat Steps 1-3. Do not weaken SP4 acceptance thresholds to accommodate a solver defect.

---

### Task 9: Execute full NIST CPU/GPU qualification and repair until green

**Files:**
- Runtime outputs: `.fullmag/reports/standard-problems/mumag/sp4/fem/`
- Modify source/tests only for reproduced defects.

**Interfaces:**
- Produces: complete runtime evidence for both devices and all design gates.

- [ ] **Step 1: Execute full qualification**

Run:

```bash
just verify-fem-standard-problem-4
```

Expected: both fields, both devices, three meshes, both airboxes, replay snapshots, NIST comparisons, convergence, parity, and reports complete with exit zero.

- [ ] **Step 2: Diagnose every failed gate at its owner**

Classify failures as data/parser, authoring/IR, planner/capability, native CPU, native GPU, demag, integrator, artifact/provenance, or acceptance/reporting. Apply systematic debugging; never substitute endpoint-only or smoke evidence.

- [ ] **Step 3: Rebuild and repeat until the complete target is green**

Use `just rebuild-fem-runtime` after native/planner/runner changes and rerun the smallest failing managed slice before rerunning the full target.

- [ ] **Step 4: Inspect generated evidence**

Require `validation.json` status `passed`, complete `metrics.json`, `report.md`, both case plots/maps, source-state hashes, three mesh records, two airbox records, strict CPU/GPU provenance, and no fallback markers.

---

### Task 10: Completion audit and capability documentation

**Files:**
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `tests/standard_problems/mumag/sp4/README.md`
- Modify: `docs/superpowers/specs/2026-07-18-mumag-standard-problem-4-fem-validation-design.md`

**Interfaces:**
- Consumes: fresh full qualification artifacts.
- Produces: evidence-backed current capability statements.

- [ ] **Step 1: Audit all eleven design sections**

Create a requirement/evidence table in `report.md` mapping every required file, metric, threshold, provenance field, and command to the exact artifact or test output. Mark missing or indirect evidence as incomplete and continue implementation.

- [ ] **Step 2: Update capability status truthfully**

Only if the full target passed, record the exact validated scope: SP4, P1, double, open-boundary Poisson-Robin, tested mesh/airbox ranges, strict CPU and strict GPU device Poisson, date, and recipe. Do not generalize to all FEM dynamics or all geometries.

- [ ] **Step 3: Run final automated verification**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest tests/standard_problems/mumag/sp4/fem/test_contract.py packages/fullmag-py/tests/test_standard_problem_4_fem.py scripts/test_fem_standard_problem_4_runtime_targets.py -q
just verify-fem-time-domain-native-contract
just verify-fem-standard-problem-4
git diff --check
git status --short
```

Expected: every command exits zero; status contains only intentional SP4 files before staging.

- [ ] **Step 4: Review staged scope before commit**

Run `git diff --cached --name-only` as its own command immediately before every commit. Stage only files traceable to this plan.

