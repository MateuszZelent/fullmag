# Persistent External Build Storage Design

## Goal

Make `just fullmag build=False fem gpu SCRIPT` reuse the last valid managed FEM runtime and make the build path automatically create, validate, and durably publish a replacement when no current runtime exists or the current runtime is stale.

All durable build outputs must be stored below exactly:

```text
/zfn2/mateuszz/git/fullmag
```

## User-visible behavior

The supported interactive flow remains:

```bash
just fullmag build=False fem gpu SCRIPT
```

When the active runtime is complete, valid, and newer than every governed source, this command runs it without rebuilding. When the runtime is missing, incomplete, invalid, or stale, the same command automatically builds once, validates the complete candidate, publishes it durably, selects it atomically, and starts the requested script.

The explicit build-enabled path:

```bash
just fullmag build=True fem gpu SCRIPT
```

also ensures the runtime and Python dependencies before launch. A failed build or validation must leave the previously selected valid runtime unchanged.

`build=False` means "do not force an unconditional rebuild". It must never silently execute an old binary against newer source: missing, invalid, or stale runtime state triggers the managed rebuild automatically.

Every Fullmag process prints its immutable build identity before handling the requested command:

```text
[fullmag] build: 2026-07-29T11:32:18Z | commit: 17a7e341 | dirty
```

The timestamp is UTC and records when the executable was compiled, not when it was launched. The commit is the short Git commit resolved during compilation. The final field is `clean` or `dirty` and records whether the source worktree contained tracked or untracked changes at build time. These values are compiled into both the `fullmag` CLI and `fullmag-api`; they must not be recalculated from the current checkout at runtime. `SOURCE_DATE_EPOCH` replaces wall-clock time when set so reproducible builds keep deterministic identity.

## Storage layout

The exact persistent root is configurable through one canonical environment value whose default is:

```text
FULLMAG_BUILD_ROOT=/zfn2/mateuszz/git/fullmag
```

The directories beneath it are:

```text
/zfn2/mateuszz/git/fullmag/build-volumes/
/zfn2/mateuszz/git/fullmag/runtimes/<variant>-<manifest-sha256>.tar
/zfn2/mateuszz/git/fullmag/runtimes/fem-gpu-host-latest.tar
```

Cargo and native CMake compilation use ext4-backed working directories or the dedicated managed FEM Docker volume. Direct CIFS compilation is not accepted because linked build scripts and native build operations are not reliable there. Because the target CIFS server rejects Unix symlinks required by the runtime library closure, the validated completed bundle is stored there as a tar archive that preserves symlinks.

The repository-local `.fullmag/runtimes/fem-gpu-host` remains a lightweight alias to a validated local extraction. When that extraction is absent or invalid, `ensure-managed-fem-runtime` restores `fem-gpu-host-latest.tar` before falling back to a rebuild.

## Build and publication transaction

1. Resolve `FULLMAG_BUILD_ROOT`, defaulting to `/zfn2/mateuszz/git/fullmag`.
2. Verify that the root exists and is writable before starting a long build.
3. Resolve the ext4-backed Cargo and native working directories and reject a direct CIFS working directory.
4. Acquire the existing managed-runtime export lock.
5. Build through the repository container-backed `just rebuild-fem-runtime` route.
6. Assemble the runtime in a unique staging directory.
7. Generate the schema-v2 manifest and validate binaries, hashes, loader closure, native cubins, and compute capability.
8. Move staging to a validated local hash-addressed variant.
9. Create a hash-addressed tar archive under the durable `runtimes/` root and atomically replace `fem-gpu-host-latest.tar`.
10. Atomically replace the repository-local active alias.
11. Remove only the build-owned staging directory. Preserve the previous hash-addressed variants for rollback.

Publication must never expose a partially copied bundle as the active runtime.

## Freshness and reuse

The existing governed-source freshness check remains authoritative. The active runtime is reusable only when:

- its launcher and manifest exist;
- schema-v2 bundle validation passes;
- the active alias resolves to a hash-addressed variant;
- no governed runtime source is newer than the active manifest.

`ensure-managed-fem-runtime` handles missing, invalid, or stale runtime state by rebuilding. A valid and fresh runtime is reused. `force=True` remains the explicit unconditional rebuild operation.

## Failure handling

- Missing or unwritable `/zfn2/mateuszz/git/fullmag` fails before compilation.
- An unavailable external native mount falls back to the dedicated managed FEM Docker volume.
- Candidate build failure leaves the current runtime alias unchanged.
- Candidate validation failure leaves the current runtime alias unchanged.
- Archive failure leaves the current runtime alias unchanged.
- Alias replacement is atomic and occurs only after durable archive publication.
- Concurrent exporters serialize through the existing `flock` contract.

## Code boundaries

- `scripts/export_fem_gpu_runtime.sh` owns build-root resolution, staging, durable archive publication, and alias replacement.
- `scripts/restore_persistent_fem_runtime.sh` restores and validates the latest archive before selecting it locally.
- `Makefile` consumes one resolved Cargo target directory rather than hard-coding `.fullmag/target`.
- `compose.yaml` exposes only the task-specific ext4-backed native build directory required by the managed build.
- `justfile` keeps user-facing build and launch policy; it does not duplicate publication logic.
- one shared Rust build-identity module owns formatting and prevents the CLI and API from reporting different stamps.
- `scripts/test_export_fem_gpu_runtime_copy_helpers.py` holds source-contract and publication regression tests.

No solver, physics, ProblemIR, capability, or runtime execution semantics change.

## Verification

The implementation is complete only when all of the following pass:

1. Focused tests pass for build-root defaults, durable archive publication, automatic restore/build behavior, and atomic alias replacement.
2. The export helper test suite passes.
3. `just rebuild-fem-runtime` completes through the managed container route using ext4-backed storage or the dedicated Docker build volume.
4. `just ensure-managed-fem-runtime` validates and reuses the published runtime without rebuilding.
5. The exact SP4 command starts with the selected durable runtime:

   ```bash
   just fullmag build=False fem gpu /home/kkingstoun/git/fullmag/fullmag/tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py
   ```

6. The active runtime manifest, resolved variant path, and build-root location are recorded in verification output.
7. A freshly built CLI and API print the same UTC timestamp, commit, and `clean`/`dirty` state.
8. Launching a previously built runtime after later source changes continues to print the identity embedded in that runtime, proving the stamp is build-time rather than launch-time state.

## Non-goals

- Deleting old variants automatically.
- Moving scientific run artifacts or reports to the build root.
- Treating a successful build as physical validation of SP4.
- Bypassing managed/container FEM builds with a host-only Cargo or CMake build.
