# Windows-first development

Windows is the host build and orchestration environment. The supported lanes are:

| Lane | Build/runtime |
|---|---|
| Rust, Python, Control Room, FDM CPU | native Windows/MSVC |
| FDM GPU | native Windows/MSVC + CUDA Toolkit |
| FEM CPU | Docker Desktop Linux container |
| FEM GPU | Docker Desktop Linux/CUDA container |

The FEM route does not invoke `wsl.exe`. Docker Desktop may use WSL2 internally,
but Fullmag does not depend on an interactive WSL distribution or a WSL checkout.

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
