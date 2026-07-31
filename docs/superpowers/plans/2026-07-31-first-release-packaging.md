# First Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the manual Linux and Windows release workflow produce self-contained, validated Fullmag bundles that start the CLI/UI with the packaged API and static Control Room.

**Architecture:** Both release jobs build the CLI, API sidecar, desktop executable, and Control Room static export. They stage the same runtime contract (`bin`, `.fullmag/local/web`, and release metadata), while the CLI and desktop launcher derive the install root from the executable when no repository checkout exists. The workflow rejects unsafe tag inputs and fails before packaging when a required binary or `index.html` is missing.

**Tech Stack:** GitHub Actions, Rust/Cargo, Next.js static export, pnpm, Python packaging, Tauri sidecar discovery, PowerShell/WiX MSI staging, Python contract tests.

## Global Constraints

- Keep `actions/checkout`, `actions/setup-node`, `actions/setup-python`, and artifact actions on the repository's Node 24-compatible major versions.
- Preserve `tolA` and `tolT` as current public relaxation parameters; do not reintroduce legacy `tol`.
- Do not modify unrelated dirty-worktree files or the `external_solvers/3` submodule.
- Release bundles must not fall back to `cargo run` or a source checkout at runtime.
- The Control Room package must contain `index.html`; an absent static export is a hard failure.

---

### Task 1: Add failing release and packaged-root contract tests

**Files:**
- Modify: `scripts/test_release_workflow_contract.py`
- Test: `scripts/test_release_workflow_contract.py`

**Interfaces:**
- Consumes: `.github/workflows/release.yml` and the two runtime resolver source files.
- Produces: executable checks for tag validation, static export, API packaging, artifact assertions, and install-root lookup.

- [ ] **Step 1: Write the failing assertions** for `FULLMAG_CONTROL_ROOM_STATIC_EXPORT=1`, `-p fullmag-api`, required `index.html` checks, `.fullmag/local/web`, and packaged-root resolver markers.
- [ ] **Step 2: Run** `python3 scripts/test_release_workflow_contract.py` and confirm the new assertions fail against the current workflow.

### Task 2: Make packaged runtime discovery independent of a checkout

**Files:**
- Modify: `crates/fullmag-cli/src/control_room.rs`
- Modify: `apps/desktop/src-tauri/src/api_sidecar.rs`

**Interfaces:**
- Consumes: an executable at `<install>/bin/fullmag[-ui]` and API/static assets at `<install>/bin/fullmag-api` and `<install>/.fullmag/local/web/index.html`.
- Produces: install-root-aware API/static discovery while preserving repository development discovery.

- [ ] **Step 1:** Add unit coverage for an executable whose parent is `bin`, asserting the derived install root is its parent directory.
- [ ] **Step 2:** Run the focused Rust tests and confirm the new test initially fails.
- [ ] **Step 3:** Implement one small helper per runtime resolver that derives the packaged root only when the expected `.fullmag` layout exists; prefer it over source-tree fallback for packaged binaries.
- [ ] **Step 4:** Include sibling/API candidates, packaged `.fullmag/local/bin/fullmag-api`, packaged web path, and `FULLMAG_REPO_ROOT`/`FULLMAG_WEB_STATIC_DIR` environment propagation; leave Cargo fallback only for source development.
- [ ] **Step 5:** Run focused Rust tests and `cargo check -p fullmag-cli -p fullmag-desktop` (diagnostic only if native dependencies prevent it).

### Task 3: Fix the manual Linux/Windows release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: validated workflow inputs and built artifacts.
- Produces: `fullmag-<tag>-linux-x86_64.tar.gz` and `fullmag-<tag>-windows-x86_64.zip` with the same runtime layout.

- [ ] **Step 1:** Move workflow inputs into environment variables and validate semantic-version prefixes and custom tags before writing `GITHUB_OUTPUT`.
- [ ] **Step 2:** Install Linux Tauri build dependencies, build `fullmag-cli`, `fullmag-api`, and `fullmag-desktop`, and build the Control Room with `FULLMAG_CONTROL_ROOM_STATIC_EXPORT=1`.
- [ ] **Step 3:** Stage Linux binaries, `.fullmag/local/web`, Python wheels, README, and a release manifest; assert every required file and archive the bundle.
- [ ] **Step 4:** Mirror the binary/static-export/staging/assertion contract on Windows and include `fullmag-api.exe`.
- [ ] **Step 5:** Add archive-content validation before upload so a green job cannot publish an empty or source-dependent bundle.

### Task 4: Align the Windows MSI staging script

**Files:**
- Modify: `scripts/windows/build_windows_msi.ps1`

**Interfaces:**
- Consumes: the same `apps/control-room/out` static export as the release workflow.
- Produces: an MSI stage containing `bin/fullmag-api.exe` and `web/index.html`.

- [ ] **Step 1:** Build the Control Room with `FULLMAG_CONTROL_ROOM_STATIC_EXPORT=1`.
- [ ] **Step 2:** Copy `apps\control-room\out` instead of the removed `apps\web\out` path.
- [ ] **Step 3:** Require `web\index.html` in `Test-StagedLayout` and fail if the static export is absent.
- [ ] **Step 4:** Run PowerShell syntax/static checks available on the host and the existing workflow contract tests.

### Task 5: Verify release readiness

**Files:**
- Verify only; no additional source files.

- [ ] **Step 1:** Parse every YAML workflow and run the release/bootstrap/Node 24 contract tests.
- [ ] **Step 2:** Run focused Python relaxation tests to ensure `tolA`/`tolT` behavior remains untouched.
- [ ] **Step 3:** Run `git diff --check` and inspect the final diff for unrelated changes.
- [ ] **Step 4:** Run the frontend typecheck and focused Rust checks; report any disk/native-environment blocker without claiming a full production build.

### Task 6: Keep managed runtime and source-build caches bounded

**Files:**
- Create: `scripts/prune_managed_fem_runtimes.sh`
- Test: `scripts/test_prune_managed_fem_runtimes.py`
- Modify: `scripts/export_fem_gpu_runtime.sh`
- Test: `scripts/test_export_fem_gpu_runtime_copy_helpers.py`

**Interfaces:**
- Consumes: the active `fem-gpu-host` symlink, managed variant directories, and `/proc` process paths.
- Produces: stable hash-addressed source snapshots for Cargo freshness and automatic runtime pruning that keeps active/in-use variants plus two newest variants per family.

- [x] **Step 1:** Add a regression fixture proving active, in-use, latest, and legacy variants are classified safely.
- [x] **Step 2:** Replace random source snapshot paths with `source-cache.<source_snapshot_sha256>` and preserve valid caches across exports.
- [x] **Step 3:** Add post-publication pruning with protected process/active paths, legacy-schema removal, dry-run support, and permission-failure reporting.
- [x] **Step 4:** Run the focused export/prune tests and the release contract test.
