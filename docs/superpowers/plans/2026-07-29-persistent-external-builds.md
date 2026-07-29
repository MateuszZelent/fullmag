# Persistent External Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `just fullmag build=False fem gpu SCRIPT` automatically reuse or rebuild a managed FEM runtime, durably publish validated builds under `/zfn2/mateuszz/git/fullmag`, and print the immutable build identity at every Fullmag process start.

**Architecture:** Host Cargo uses configured ext4-backed storage. Managed FEM uses the external native mount when writable and a dedicated Docker volume otherwise. The exporter validates a local hash-addressed variant, round-trip validates a symlink-preserving tar archive under the exact persistent root, and atomically updates the latest archive and local alias. A shared `fullmag-build-info` Rust crate embeds one UTC timestamp, Git commit, and clean/dirty state for both CLI and API.

**Tech Stack:** Bash, GNU Make, just, Docker Compose, Cargo nightly, CMake/MFEM/CUDA, pytest source-contract tests.

## Global Constraints

- Persistent root defaults exactly to `/zfn2/mateuszz/git/fullmag`.
- Native FEM builds remain container-backed through repository `just` recipes.
- Build intermediates must not use direct CIFS build trees.
- A failed build, copy, or validation must preserve the previously active runtime.
- `build=False` reuses a fresh runtime but automatically builds missing, invalid, or stale runtime state.
- `force=True` always rebuilds.
- Every CLI and API process prints `[fullmag] build: <UTC> | commit: <short-sha> | <clean|dirty>` before command handling.
- Build identity is compiled into the executable; `SOURCE_DATE_EPOCH` overrides wall-clock build time.
- Existing unrelated worktree changes must remain untouched.
- Do not stage or commit the shared dirty worktree unless the user separately requests it.

---

### Task 1: Lock the desired contracts with failing tests

**Files:**
- Modify: `scripts/test_export_fem_gpu_runtime_copy_helpers.py`

**Interfaces:**
- Consumes: current exporter, Makefile, and justfile source text.
- Produces: regression tests for external roots, ext4 preflight, durable publication, and automatic ensure behavior.

- [x] **Step 1: Add tests for the external storage contract**

```python
def test_export_defaults_to_exact_persistent_build_root() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    assert 'FULLMAG_BUILD_ROOT:=/zfn2/mateuszz/git/fullmag' in script
    assert 'FULLMAG_CONTAINER_TARGET_DIR:=/mnt/fullmag-zfn2-native/cargo-targets/managed-fem-runtime' in script


def test_export_publishes_durable_copy_before_switching_aliases() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    archive_index = script.index('tar -C "${variant_root}"')
    latest_index = script.index('mv -f "${persistent_staging_archive}"')
    repo_alias_index = script.index('mv -Tf "${repo_next_alias}"')
    assert archive_index < latest_index < repo_alias_index
```

- [x] **Step 2: Add tests for automatic `just fullmag` ensure behavior and external Cargo target**

```python
def test_fullmag_fem_launch_always_ensures_managed_runtime_unless_forced() -> None:
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    fullmag_recipe = justfile.split('fullmag opt_1=""', 1)[1].split(
        "\nrun-fdm-cpu-smoke:", 1
    )[0]
    assert 'else just ensure-managed-fem-runtime; fi;' in fullmag_recipe
    assert 'if [ "$build" = "false" ]' not in fullmag_recipe


def test_make_install_cli_uses_external_cargo_target_variable() -> None:
    makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    assert 'FULLMAG_CARGO_TARGET_DIR' in makefile
    assert 'CARGO_TARGET_DIR=.fullmag/target' not in makefile
```

- [x] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
python3 -m pytest -q scripts/test_export_fem_gpu_runtime_copy_helpers.py -k 'persistent_build_root or durable_copy or always_ensures or external_cargo_target'
```

Expected: failures because the exporter, Makefile, and justfile still use repository-local paths and `build=False` rejects stale runtime state.

### Task 2: Route host and container build intermediates to ext4-backed storage

**Files:**
- Modify: `Makefile`
- Modify: `scripts/export_fem_gpu_runtime.sh`

**Interfaces:**
- Consumes: `FULLMAG_CARGO_TARGET_DIR`, `FULLMAG_CONTAINER_TARGET_DIR`.
- Produces: validated writable build directories and Cargo artifacts outside the worktree.

- [x] **Step 1: Resolve one host Cargo target directory in Makefile**

Add a shell-local value before any Cargo invocation:

```bash
cargo_target_dir="$${FULLMAG_CARGO_TARGET_DIR:-/tmp/fullmag-zfn2-build/cargo-targets/fullmag-cli}"
mkdir -p "$$cargo_target_dir"
if [ ! -w "$$cargo_target_dir" ]; then
    echo "Fullmag Cargo target directory is not writable: $$cargo_target_dir" >&2
    exit 2
fi
```

Replace every `.fullmag/target` Cargo target and artifact lookup in `install-cli` with `$$cargo_target_dir`.

- [x] **Step 2: Add exporter preflight and a dedicated-volume fallback**

```bash
: "${FULLMAG_CONTAINER_TARGET_DIR:=/mnt/fullmag-zfn2-native/cargo-targets/managed-fem-runtime}"
container_target_args=()
container_target_fstype="$(findmnt -no FSTYPE -T "${FULLMAG_CONTAINER_TARGET_DIR}" 2>/dev/null || true)"
if [ -w "${FULLMAG_CONTAINER_TARGET_DIR}" ] && [ "${container_target_fstype}" != "cifs" ]; then
  container_target_args=(-v "${FULLMAG_CONTAINER_TARGET_DIR}:/workspace/target")
else
  container_target_args=(-v "fullmag-managed-fem-runtime-build:/workspace/target")
fi
```

- [x] **Step 3: Bind the resolved target as `/workspace/target`**

Add this argument to the managed `docker compose run` call:

```bash
"${container_target_args[@]}"
```

- [x] **Step 4: Run focused tests**

Run the Task 1 pytest command. Expected: build-storage tests pass while durable-publication and justfile tests remain failing.

### Task 3: Publish immutable runtime archives under the exact persistent root

**Files:**
- Modify: `scripts/export_fem_gpu_runtime.sh`
- Modify: `scripts/test_export_fem_gpu_runtime_copy_helpers.py`

**Interfaces:**
- Consumes: validated repository-local `STAGING_ROOT`.
- Produces: durable hash-addressed tar archive, durable latest archive, repository-local active alias.

- [x] **Step 1: Resolve persistent and repository runtime roots**

```bash
: "${FULLMAG_BUILD_ROOT:=/zfn2/mateuszz/git/fullmag}"
PERSISTENT_RUNTIME_PARENT="${FULLMAG_BUILD_ROOT}/runtimes"
PERSISTENT_LATEST_ARCHIVE="${PERSISTENT_RUNTIME_PARENT}/fem-gpu-host-latest.tar"
REPO_RUNTIME_PARENT="${REPO_ROOT}/.fullmag/runtimes"
REPO_RUNTIME_ROOT="${REPO_RUNTIME_PARENT}/fem-gpu-host"
```

Require `FULLMAG_BUILD_ROOT` to exist and be writable before the managed build begins.

- [x] **Step 2: Archive before alias selection**

Validate staging, select a local hash-addressed variant, then create `<variant>-<manifest_sha256>.tar` and atomically replace `fem-gpu-host-latest.tar`. Tar is required because the target CIFS share rejects Unix symlink creation.

- [x] **Step 3: Atomically select the repository alias**

Only replace the repository alias after durable archive publication completes. Restore missing local variants from the latest archive and validate them before selection.

- [x] **Step 4: Write a failing archive round-trip ordering test**

Add a source-contract test that requires `validate_persistent_runtime_archive` to run after `tar` creation and before `mv -Tf "${repo_next_alias}"`:

```python
def test_export_validates_persistent_archive_before_switching_repo_alias() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    archive_index = exporter.index('tar -C "${variant_root}"')
    validate_index = exporter.index(
        'validate_persistent_runtime_archive "${persistent_archive}" "${variant_root}"'
    )
    alias_index = exporter.index('mv -Tf "${repo_next_alias}"')
    assert archive_index < validate_index < alias_index
```

Run:

```bash
python3 -m pytest -q scripts/test_export_fem_gpu_runtime_copy_helpers.py -k persistent_archive_before
```

Expected: FAIL because the archive is not round-trip validated yet.

- [x] **Step 5: Implement archive round-trip validation**

Add a helper in `scripts/export_fem_gpu_runtime.sh` that extracts to a unique local temporary directory, validates schema v2, and compares exactly with the selected local variant:

```bash
validate_persistent_runtime_archive() {
  local archive="$1"
  local expected_root="$2"
  local extracted
  extracted="$(mktemp -d "${TMPDIR:-/tmp}/fullmag-fem-runtime-archive.XXXXXXXX")"
  if ! tar -C "${extracted}" -xf "${archive}" || \
     ! python3 scripts/validate_managed_fem_runtime_bundle.py \
       --runtime-root "${extracted}" --allow-unaddressed-staging || \
     ! python3 scripts/validate_managed_fem_runtime_bundle.py \
       --runtime-root "${extracted}" --allow-unaddressed-staging \
       --compare-exact "${expected_root}"; then
    rm -rf -- "${extracted}"
    return 1
  fi
  rm -rf -- "${extracted}"
}
```

Validate the immutable archive before copying it to `fem-gpu-host-latest.tar`; verify the latest staging archive with `cmp -s` before atomic rename.

- [x] **Step 6: Make restore repair a corrupt same-name local variant**

In `scripts/restore_persistent_fem_runtime.sh`, validate the extracted archive first. If `variant_root` exists and differs or fails validation, move it to a process-specific backup, install staging, validate the replacement, then delete only that backup. If it matches exactly, discard staging and reuse it.

- [x] **Step 7: Run focused and full exporter tests**

```bash
python3 -m pytest -q scripts/test_export_fem_gpu_runtime_copy_helpers.py
```

Expected: all exporter helper tests pass.

### Task 4: Correct `just fullmag` automatic build behavior

**Files:**
- Modify: `justfile`
- Modify: `scripts/test_export_fem_gpu_runtime_copy_helpers.py`

**Interfaces:**
- Consumes: `ensure-managed-fem-runtime` and `rebuild-fem-runtime`.
- Produces: automatic reuse-or-build behavior for FEM launches.

- [x] **Step 1: Replace the `build=False` stale rejection branch**

Use:

```bash
if [ "$backend" = "fem" ]; then
  if [ "$force" = "true" ]; then
    just rebuild-fem-runtime
  else
    just ensure-managed-fem-runtime
  fi
  bin="{{gpu_runtime_bin}}"
fi
```

Keep `build=True` responsible for `ensure-python`; retain the existing explicit missing-Python error for `build=False`.

- [x] **Step 2: Verify recipe rendering and focused tests**

```bash
just --show fullmag
python3 -m pytest -q scripts/test_export_fem_gpu_runtime_copy_helpers.py -k 'always_ensures'
```

Expected: rendered FEM branch calls `ensure-managed-fem-runtime`; focused test passes.

### Task 5: Embed and print one build identity in CLI and API

**Files:**
- Create: `crates/fullmag-build-info/Cargo.toml`
- Create: `crates/fullmag-build-info/build.rs`
- Create: `crates/fullmag-build-info/src/lib.rs`
- Modify: `Cargo.toml`
- Modify: `crates/fullmag-cli/Cargo.toml`
- Modify: `crates/fullmag-cli/src/main.rs`
- Modify: `crates/fullmag-api/Cargo.toml`
- Modify: `crates/fullmag-api/src/main.rs`
- Modify: `crates/fullmag-api/src/build_info.rs`
- Test: `scripts/test_build_identity_contract.py`

**Interfaces:**
- Produces: `fullmag_build_info::identity() -> BuildIdentity`, `fullmag_build_info::stamp() -> String`, and `fullmag_build_info::print_startup_stamp()`.
- Consumes: `SOURCE_DATE_EPOCH`, Git `HEAD`, and worktree status during compilation only.

- [x] **Step 1: Write failing source-contract tests**

Create `scripts/test_build_identity_contract.py`:

```python
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_cli_and_api_print_shared_build_identity_before_argument_handling() -> None:
    cli = (ROOT / "crates/fullmag-cli/src/main.rs").read_text()
    api = (ROOT / "crates/fullmag-api/src/main.rs").read_text()
    assert "fullmag_build_info::print_startup_stamp();" in cli.split("fn main()", 1)[1][:180]
    assert "fullmag_build_info::print_startup_stamp();" in api.split("async fn main()", 1)[1][:180]


def test_shared_build_identity_captures_time_commit_and_worktree_state() -> None:
    build_rs = (ROOT / "crates/fullmag-build-info/build.rs").read_text()
    assert "SOURCE_DATE_EPOCH" in build_rs
    assert "rev-parse" in build_rs
    assert "status" in build_rs
    assert "FULLMAG_BUILD_TIMESTAMP_UTC" in build_rs
    assert "FULLMAG_BUILD_GIT_COMMIT" in build_rs
    assert "FULLMAG_BUILD_WORKTREE_STATE" in build_rs
```

- [x] **Step 2: Run tests and confirm RED**

```bash
python3 -m pytest -q scripts/test_build_identity_contract.py
```

Expected: FAIL because the shared crate and startup calls do not exist.

- [x] **Step 3: Implement the shared crate**

`crates/fullmag-build-info/src/lib.rs` exposes immutable compile-time values and exactly one formatter:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BuildIdentity {
    pub built_at_utc: &'static str,
    pub git_commit: &'static str,
    pub worktree_state: &'static str,
}

pub fn identity() -> BuildIdentity {
    BuildIdentity {
        built_at_utc: env!("FULLMAG_BUILD_TIMESTAMP_UTC"),
        git_commit: env!("FULLMAG_BUILD_GIT_COMMIT"),
        worktree_state: env!("FULLMAG_BUILD_WORKTREE_STATE"),
    }
}

pub fn stamp() -> String {
    let value = identity();
    format!(
        "[fullmag] build: {} | commit: {} | {}",
        value.built_at_utc, value.git_commit, value.worktree_state
    )
}

pub fn print_startup_stamp() {
    eprintln!("{}", stamp());
}
```

The crate `build.rs` resolves a deterministic RFC3339 UTC timestamp from `SOURCE_DATE_EPOCH` or `SystemTime`, runs `git rev-parse --short=8 HEAD`, and maps empty/non-empty `git status --porcelain --untracked-files=normal` output to `clean`/`dirty`. Git command failure embeds `unknown` rather than blocking release builds from source archives. Emit `cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH` plus rerun paths for the resolved Git `HEAD` and index so a new commit or dirty-state transition cannot silently reuse an old identity.

- [x] **Step 4: Wire the crate into the workspace, CLI, and API**

Add `fullmag-build-info` to workspace members and workspace dependencies. Add the workspace dependency to CLI and API. Call `fullmag_build_info::print_startup_stamp()` as the first statement in both entrypoints. Replace API-local build date access with `fullmag_build_info::identity().built_at_utc[..10]` through its existing `backend_build_date()` facade, and remove the redundant API `build.rs`.

- [x] **Step 5: Add Rust formatter tests and verify GREEN**

Test that `stamp()` has the exact prefix and all three embedded fields, and that the timestamp has RFC3339 UTC shape. Then run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-build-info-tests cargo +nightly test -p fullmag-build-info
python3 -m pytest -q scripts/test_build_identity_contract.py
```

Expected: both commands PASS.

- [x] **Step 6: Prove `SOURCE_DATE_EPOCH` determinism**

Add this focused test in `crates/fullmag-build-info/src/lib.rs`:

```rust
#[test]
fn source_date_epoch_is_embedded_when_expected() {
    let expected = std::env::var("FULLMAG_EXPECT_BUILD_TIMESTAMP")
        .expect("test requires FULLMAG_EXPECT_BUILD_TIMESTAMP");
    assert_eq!(identity().built_at_utc, expected);
}
```

Run it in a fresh target so the build script cannot reuse an earlier stamp:

```bash
SOURCE_DATE_EPOCH=0 \
FULLMAG_EXPECT_BUILD_TIMESTAMP=1970-01-01T00:00:00Z \
CARGO_TARGET_DIR=/tmp/fullmag-build-info-epoch-zero \
cargo +nightly test -p fullmag-build-info tests::source_date_epoch_is_embedded_when_expected -- --exact
```

Expected: PASS with the embedded timestamp equal to `1970-01-01T00:00:00Z`.

### Task 6: Managed build and exact launch verification

**Files:**
- No production file changes expected.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: fresh durable runtime and evidence for the requested command.

- [x] **Step 1: Run source-contract tests**

```bash
python3 -m pytest -q scripts/test_export_fem_gpu_runtime_copy_helpers.py
```

- [x] **Step 2: Build through the authoritative managed route**

```bash
just rebuild-fem-runtime
```

Expected: build uses external ext4-backed target, validates the candidate and durable copy, and selects the durable runtime.

- [x] **Step 3: Verify reuse without a rebuild**

```bash
just ensure-managed-fem-runtime
```

Expected: bundle validation passes without running the exporter.

- [x] **Step 4: Run the exact requested SP4 command**

```bash
just fullmag build=False fem gpu /home/kkingstoun/git/fullmag/fullmag/tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py
```

Expected: the command passes runtime freshness and starts the interactive Fullmag process using the selected durable variant.

- [x] **Step 5: Audit final paths and aliases**

Verify with `readlink`, `findmnt`, manifest validation, and `git diff --check` that intermediates and runtime publication match the approved design and that unrelated dirty files are unchanged.
