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
Windows PowerShell launcher for local builds and runs, and keep the managed gate
explicitly fail-closed rather than silently substituting a host build.

### Why the current managed receipt mentions ext4

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

A Windows profile can use a folder such as
`C:\fullmag-managed\<repo>\<worktree>\<generation>` (or the equivalent
`FULLMAG_WINDOWS_MANAGED_ROOT` override). It must be outside the checkout and
must enforce the equivalent invariants:

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

The script validates Git Bash, MSVC Build Tools, Rust, CMake, Node/pnpm and
Docker, installs missing `just`/`uv`, and creates build/cache directories outside
the repository. By default, it uses the root of the drive containing the repo:

- `<drive>:\fullmag-cache`
- `<drive>:\fullmag-build`
- `<drive>:\fullmag-tmp`

Override them with `FULLMAG_WINDOWS_CACHE_ROOT`,
`FULLMAG_WINDOWS_BUILD_ROOT`, and `FULLMAG_WINDOWS_TEMP_ROOT`. All three must be
absolute and outside the repository.

If setup installed `just` into the managed tool root, add it to the current
PowerShell session before using the recipes:

```powershell
$env:Path = "C:\fullmag-cache\tools\bin;$env:Path"
```

The native lane reuses the working Windows rustup toolchain by default. Set
`FULLMAG_WINDOWS_RUSTUP_HOME` only when a separate toolchain store is required;
Cargo outputs still remain under `FULLMAG_WINDOWS_BUILD_ROOT`.

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

Existing FEM images are reused. Set `FULLMAG_WINDOWS_REBUILD_FEM_IMAGE=1` for a
deliberate image rebuild after changing a FEM Dockerfile or its dependencies.

On Windows, `just fullmag` selects the Windows route automatically; the legacy
`windows=True` option remains accepted for compatibility. `build=False` reuses
the lane-specific cache and runtime.
