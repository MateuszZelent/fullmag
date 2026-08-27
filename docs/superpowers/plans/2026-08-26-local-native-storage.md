# Local Native FEM Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać jawny profil `local-d`, który kieruje managed FEM do lokalnego obrazu ext4 na `/mnt/d`, zachowując ext4/loop validation i domyślny profil sieciowy.

**Architecture:** Wspólny helper Bash rozwiązuje zamknięty wybór `canonical`/`local-d`. Exporter, restorer, receptury raportów i macierz SP4 korzystają z tego samego rozwiązania; punkt montowania pozostaje `/mnt/fullmag-zfn2-native`, więc kontener nadal dostaje bind mount ext4.

**Tech Stack:** Bash, Python 3/pytest, `just`, Docker Compose, WSL2 loop/ext4.

## Global Constraints

- Natywny FEM/MFEM/CUDA/hypre/libCEED jest budowany przez container-backed recepty `just`.
- Walidacja wymaga ext4, `/dev/loopN` i dokładnie zgodnego `loop/backing_file`.
- Profil `canonical` pozostaje domyślny.
- Nie wolno wprowadzić dowolnego przekierowania ścieżki ani fallbacku do DrvFS.
- Istniejące niepowiązane zmiany w `external_solvers/3` pozostają nietknięte.

---

### Task 1: Test-first contract for storage profiles

**Files:**
- Create: `scripts/lib/managed_fem_native_storage.sh`
- Create: `scripts/test_managed_fem_native_storage.py`
- Modify: `scripts/test_managed_fem_runtime_target_mount.py`
- Modify: `scripts/test_restore_persistent_fem_runtime.py`

**Interfaces:**
- Produces Bash function `resolve_managed_fem_native_storage`.
- Produces shell variables `FULLMAG_NATIVE_BUILD_STORAGE_ROOT`,
  `FULLMAG_NATIVE_BUILD_IMAGE`, and `FULLMAG_NATIVE_MOUNT_VIEW`.
- Accepts only `FULLMAG_NATIVE_STORAGE_PROFILE=canonical|local-d`.

- [ ] **Step 1: Write failing profile tests**

  Test the helper through a real Bash subprocess. Assert that the default and
  `canonical` profile resolve to `/zfn2/...`, `local-d` resolves to
  `/mnt/d/git/fullmag/fullmag-native.ext4`, and `unsupported` exits non-zero.
  Add a restore/export contract assertion that both scripts source and invoke
  the helper.

- [ ] **Step 2: Run the focused tests and verify the expected failure**

  Run:

  ```bash
  PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q scripts/test_managed_fem_native_storage.py scripts/test_managed_fem_runtime_target_mount.py scripts/test_restore_persistent_fem_runtime.py
  ```

  Expected: failure because the helper file and profile resolution do not yet
  exist.

### Task 2: Implement and wire the closed profile resolver

**Files:**
- Modify: `scripts/lib/managed_fem_native_storage.sh`
- Modify: `scripts/export_fem_gpu_runtime.sh`
- Modify: `scripts/restore_persistent_fem_runtime.sh`
- Modify: `scripts/test_export_fem_gpu_runtime_copy_helpers.py`

**Interfaces:**
- `resolve_managed_fem_native_storage` sets the three readonly inputs consumed
  by existing storage validation.

- [ ] **Step 1: Implement only the two approved profiles**

  Use a `case` over `${FULLMAG_NATIVE_STORAGE_PROFILE:-canonical}`. For
  `canonical`, select the existing `/zfn2` root and image; for `local-d`, select
  `/mnt/d/git/fullmag` and its image; otherwise print an error and return 2.
  Keep the mount view fixed at `/mnt/fullmag-zfn2-native`.

- [ ] **Step 2: Source the resolver before path-dependent variables**

  In exporter and restorer, source the helper, call the resolver, then derive
  `FULLMAG_BUILD_ROOT`, `PERSISTENT_RUNTIME_PARENT`, `archive`, and target paths
  from the resolved values. Remove duplicated hard-coded assignments while
  retaining canonical defaults in the helper.

- [ ] **Step 3: Run the focused tests and repair only implementation defects**

  Run the Task 1 command. Expected: all profile and existing storage safety
  tests pass.

### Task 3: Propagate the selected backing image to SP4 verification paths

**Files:**
- Modify: `justfile:161-175,5793-5811`
- Modify: `scripts/run_fem_sp4_mixed_matrix.py`
- Modify: `scripts/test_run_fem_sp4_mixed_matrix.py`
- Modify: `scripts/test_verify_fem_mixed_prism_airbox_runtime.py`

**Interfaces:**
- SP4 shell recipes source the same helper and pass
  `$FULLMAG_NATIVE_BUILD_IMAGE` to report-root validation.
- Python mixed-matrix validation resolves the same closed profile from the
  environment and keeps `/mnt/fullmag-zfn2-native` as the required mount view.

- [ ] **Step 1: Add failing local-profile assertions**

  Assert that `local-d` changes the expected backing image in the Python
  validator and that the affected just recipes resolve the helper variable
  instead of passing the literal `/zfn2` image.

- [ ] **Step 2: Implement the propagation**

  Replace only the affected literal arguments with the helper-resolved image;
  do not change report-root containment or loop validation.

- [ ] **Step 3: Run focused recipe and Python tests**

  Run:

  ```bash
  PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q scripts/test_run_fem_sp4_mixed_matrix.py scripts/test_verify_fem_mixed_prism_airbox_runtime.py
  ```

### Task 4: Verify local image, managed runtime, and exact bimeron example

**Files:**
- No source changes expected.
- Evidence: `.fullmag/reports/` and managed runtime manifest outside the source diff.

- [ ] **Step 1: Verify the local mounted image**

  Confirm with host-level WSL checks that `/mnt/d/git/fullmag/fullmag-native.ext4`
  is mounted at `/mnt/fullmag-zfn2-native` as ext4 on `/dev/loopN`, has a
  writable probe, and is visible to a Docker bind-mount smoke.

- [ ] **Step 2: Run the canonical managed runtime recipe with local profile**

  Run:

  ```bash
  FULLMAG_NATIVE_STORAGE_PROFILE=local-d FULLMAG_RUNTIME_PRUNE=0 just ensure-managed-fem-runtime
  ```

  Expected: the bundle validates and its persistent build/runtime data is below
  `/mnt/d/git/fullmag`.

- [ ] **Step 3: Run the exact requested example**

  Run with the local profile and capture the complete log:

  ```bash
  FULLMAG_NATIVE_STORAGE_PROFILE=local-d just fullmag build=False dev fem gpu headless examples/permalloy_layer_bimeron_prism_single_layer_relax_300nm.py
  ```

  Expected: preparation completes, solver initialization succeeds, and the log
  contains a first relaxation progress record. If it fails, preserve the exact
  stage and native error as the next diagnostic target.
