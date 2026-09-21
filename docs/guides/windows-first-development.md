# Windows-first development

Windows is the host build and orchestration environment. The supported lanes are:

| Lane | Build/runtime |
|---|---|
| Rust, Python, Control Room, FDM CPU | native Windows/MSVC |
| FDM GPU | native Windows/MSVC + CUDA Toolkit |
| FEM CPU | Docker Desktop Linux container |
| FEM GPU | Docker Desktop Linux/CUDA container |

The canonical FEM entry point is `scripts/windows/run_fullmag_fem.ps1`. It does
not invoke `wsl.exe`: Docker Desktop may use WSL2 internally, but Fullmag does
not depend on an interactive WSL distribution or a WSL checkout. The historical
`run_fullmag_wsl.ps1` filename remains only as a compatibility implementation
for older callers.

The storage and worktree contract for both platform modes is defined in
[Fullmag build-storage governance](fullmag-build-storage-governance.md). This
guide describes the Windows execution lanes; it does not create a second path
policy.

`just` may use `C:\Program Files\Git\bin\bash.exe` as its recipe shell on
Windows. That is Git Bash, not WSL; it only dispatches the Windows PowerShell
launcher and does not own the checkout or the FEM runtime.

## CI boundary

There is no interactive WSL step in the Windows build route. The GitHub Actions
job `frontend-3d-managed-fem` currently targets
`[self-hosted, linux, x64, fem-managed]`; `linux` here means a dedicated Linux
runner, not WSL. That runner exists only for the managed-runtime qualification
gate, whose current receipt contract requires Linux `ext4` durable storage,
`findmnt`/loop-device provenance and (for the GPU lane) CUDA visibility.

Changing that job's label to `windows` alone would not make it a valid Windows
gate: the managed storage and receipt adapter would first have to be ported to
Windows paths backed by Docker Desktop. Until that adapter is verified, use the
Windows PowerShell launcher for local diagnostic builds and runs, mark storage
compliance **NOT VERIFIED**, and keep the managed gate explicitly fail-closed
rather than silently substituting a host build.

### Why the current managed receipt mentions ext4

Aktualizacja 2026-09-11: zatwierdzono osobną
[bramkę właściwości storage](storage-capability-gate.md) dla nowej trasy
Docker Desktop. Dostępna sonda sprawdza rzeczywiste operacje zamiast nazwy
filesystemu; jej PASS nie jest jeszcze kwalifikacją managed FEM.

`ext4` is not a meshing, FEM, or numerical-accuracy requirement. It is the
storage policy of the current Linux managed-receipt exporter. The helper
`scripts/lib/managed_fem_runtime_storage.sh` checks all of the following before
it allows publication:

- the durable target is on `ext4`;
- `findmnt` reports a loop device as the source;
- the loop device points at the expected backing image; and
- the target is writable and remains on the same device after creation.

Those checks prevent a Linux container from silently building on a CIFS/WSL
view, a stale mount, or an unexpected host path. They establish storage
provenance for the receipt; they do not make the mesh better or faster.

The intended Windows replacement is a separate, explicit storage profile, not
an unconditional removal of the Linux checks:

```text
linux-ext4-loop-v1       dedicated Linux runner; ext4 + loop provenance
windows-folder-v1        Windows host folder; NTFS/ReFS + path/volume provenance
```

A Windows profile uses a folder such as
`<project-root>\storage\managed\<worktree>\<generation>` (or a separately
validated compatibility override). It must be outside the checkout and must
enforce the equivalent invariants:

1. absolute local path, no UNC/network path, and no junction/symlink escape;
2. per-repository/worktree/backend/device namespace;
3. writable local volume with a free-space and write probe;
4. staging followed by same-volume atomic promotion of the bundle and manifest;
5. owner metadata for the mutex/container and interrupted-writer recovery; and
6. a manifest `storage_profile` plus volume/path identity bound to the source,
   binary, image, and artifact digests.

The safest implementation keeps compiler scratch space inside the Docker
Desktop Linux container/volume and publishes only the immutable, hash-addressed
receipt and evidence into the Windows folder. A bind-mounted Windows folder may
also be used after an explicit atomic-rename and restart test; it must not be
accepted merely because `docker info` reports a Linux engine. Once this adapter
and its tests are in place, the managed CI job can move to a Windows runner
without weakening the receipt or pretending that a label change is proof.

## First setup

Run once from PowerShell before `just` is available:

```powershell
.\scripts\windows\setup_fullmag.ps1 -InstallMissing
```

Setup must resolve the project root from the common Git directory and create
only the project's `storage` tree for new Fullmag data: `cache`, `builds`,
`runtimes`, `runs`, `tmp`, `index` and `locks`. It must not create
`C:\fullmag-build`, `C:\fullmag-cache` or `C:\fullmag-tmp`. Until the setup
launcher consumes the shared resolver and preflight, its path behavior is
**NOT VERIFIED** against this policy.

`FULLMAG_WINDOWS_CACHE_ROOT`, `FULLMAG_WINDOWS_BUILD_ROOT` and
`FULLMAG_WINDOWS_TEMP_ROOT` are compatibility names. They are accepted only
when the resolver validates them as paths inside the registered project
storage; they are not permission to choose arbitrary roots. Tool paths such as
`just` must come from the resolved profile rather than a hard-coded legacy
directory.

The native lane reuses the working Windows rustup toolchain by default. If a
separate toolchain store is required, register it as a profile cache under the
project storage and keep Cargo outputs in that profile's build directory.

## Commands

```powershell
just windows-doctor
just windows-build fdm cpu dev
just windows-build fdm gpu dev
just windows-build fem cpu dev
just windows-build fem gpu dev
just fullmag build=True dev fdm cpu .\examples\example.py
just fullmag build=True dev fem gpu .\examples\example.py
```

When multiple agents are editing the same checkout during a build, pass
`skip_local_changes=true` (or use `-SkipLocalChanges` on the PowerShell
launcher):

```text
just fullmag build=True headless fdm gpu skip_local_changes=true .\path\case.py
```

This only disables the before/after source-snapshot equality gate. The launcher
still records both snapshots in the manifest and marks the receipt
`local_changes_check=skipped` / `source_identity_check=skipped`; such a runtime
is explicitly unqualified for reproducibility. Reusing that manifest with
`build=False` requires passing the same flag again. Binary hashes, backend,
device, image, and storage checks remain enforced.

Existing FEM images are reused. Set `FULLMAG_WINDOWS_REBUILD_FEM_IMAGE=1` for a
deliberate image rebuild after changing a FEM Dockerfile or its dependencies.

On Windows, `just fullmag` selects the Windows route automatically; the legacy
`windows=True` option remains accepted for compatibility. `build=False` reuses
the lane-specific cache and runtime.

Before and after a manual `just` invocation, use the storage information and
inventory recipes when available (`just storage-info` and
`just storage-inventory`). A worktree operation must be registered and finished
with its owner, purpose, status and next step (`just worktree-register` /
`just worktree-finish`). Verify that each alias is present in the current
`justfile` and delegates to the shared resolver; until then, the corresponding
lane is **NOT VERIFIED**, not an approval of the old path.
