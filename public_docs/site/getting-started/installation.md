---
title: Installation
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-installation)=
# Installation

FullMag separates the **Python authoring layer** from the **solver runtime**. The Python package
defines the `fm.study(...)` and `fm.connect()` workflows and lowers models to the canonical
`ProblemIR`; a container-backed or compiled backend executes the solve. This page installs the
published Python package from PyPI (or from source) and sets up the daily Docker Compose DEV
workspace.

## Requirements

- Python 3.10 or newer.
- `pip` or `uv` to install `fullmag` and its Python dependencies.
- Git and Docker (Docker Desktop Linux engine on Windows PowerShell, or Linux/WSL2 Docker
  integration) for running the solver runtime and Control Room. `just` is recommended for the
  repository recipes (`just docker-dev`, `just docker-dev-toolchain`).
- Host Cargo/Rust and CMake are **not** required: the backend container builds Rust and native
  FEM/FDM solvers inside Docker using isolated named volumes.
- Finite-element geometry and meshing require the optional `meshing` extra (`gmsh`, `manifold3d`,
  `meshio`, `scipy`, `trimesh`).

## Install the Python DSL

### From PyPI

The public Python authoring package and live HTTP/WebSocket client are published on
[PyPI (`fullmag`)](https://pypi.org/project/fullmag/):

```console
pip install fullmag
```

With [uv](https://docs.astral.sh/uv/):

```console
uv add fullmag            # in a uv project
uv pip install fullmag    # in an existing environment
```

Optional extras install additional authoring and interactive capabilities:

| Extra | Included dependencies | Intended workflow |
|---|---|---|
| `meshing` | `gmsh`, `manifold3d`, `meshio`, `scipy`, `trimesh` | FEM geometry and conformal domain meshing |
| `figures` | `Pillow` | Image-based material and texture authoring |
| `jupyter` | `ipython`, `matplotlib` | Interactive notebooks and `fullmag.live.jupyter.monitor()` |

Combine extras as needed, for example:

```console
pip install "fullmag[meshing,figures,jupyter]"
```

The PyPI distribution is pure Python. It provides model authoring, `ProblemIR` serialization, and
the live API client ({ref}`fm.connect() <public-docs-getting-started-interactive-python>`), which
drives a running FullMag Docker DEV group over HTTP and WebSocket. It does not bundle the native
FDM/FEM solver libraries: without a connected server session or repository runtime, `fm.relax()`
and `fm.run()` return a `Result` with `status="not-executable"`.

### From a source checkout

To install the editable or development Python package straight from a repository checkout:

```console
git clone https://github.com/MateuszZelent/fullmag
cd fullmag
python -m pip install ./packages/fullmag-py
```

Install optional extras in the same way when authoring FEM meshes or Jupyter notebooks:

```console
python -m pip install "./packages/fullmag-py[meshing,jupyter]"
```

Verify that the module imports:

```console
python -c "import fullmag; print(fullmag.__file__)"
```

## Prepare the Docker Compose DEV runtime

Daily FullMag development runs inside a per-checkout Docker Compose group (`fullmag-master` for the
main checkout, or `fullmag-worktree-<worktree_id>` for a registered Git worktree). Each group
contains two permanent services: `backend` (which compiles changed Rust/C++ targets incrementally and
serves the API + native FDM/FEM runtime) and `frontend` (Next.js Control Room dev server with HMR).

### 1. Recommended checkout location (WSL2 ext4 vs Windows)

Because containers run in the Linux VM, checkout filesystem speed governs source capture and HMR
responsiveness:

- **WSL2 ext4 (recommended)**: Keep your main checkout and worktrees on ext4 inside WSL (for
  example `~/git/fullmag/fullmag`), with Docker Desktop WSL integration enabled. Containers read
  sources over a direct bind mount with native `inotify` watching. If the container user (UID
  `65532`) needs read-only access to the main `.git` metadata directory for worktrees, run:

  ```bash
  cd ~/git/fullmag/fullmag
  setfacl -R -m u:65532:rX .git
  find .git -path .git/modules -prune -o -type d -print0 | xargs -0 setfacl -d -m u:65532:rX
  ```

- **Windows NTFS**: Checkouts under a Windows path work with Docker Desktop (`desktop-linux`
  context), though frontend hot-reload uses 9p polling across the VM boundary.

### 2. Configure host storage once

Before starting any build, configure `FULLMAG_PROJECT_STORAGE_ROOT` in the main checkout's local
`.env` (worktrees inherit it automatically from the main checkout via Git):

```console
python -B scripts/setup_docker.py
python -B scripts/setup_docker.py --check
```

Use `python3` in Linux/WSL shells. This wizard writes only the storage root, checkout selection, and
default frontend port into `.env` and never starts or deletes containers. User sessions, Zarr
results, projects, and settings stay in the configured host storage; build caches, Cargo/pnpm
packages, and compilation artifacts live in Docker named volumes and BuildKit (with a
group-private named volume splitting `private/backend`, `private/frontend`, and `private/ledger`
alongside shared `fullmag-shared-*` caches).

### 3. Build the toolchain and start services

Run from the root of the main checkout or registered worktree you want to work in:

```console
just docker-dev-toolchain
just docker-dev "$PWD"
```

- `just docker-dev-toolchain` builds the pinned container dependency image (`docker/fem-gpu/Dockerfile`,
  pinning CUDA `12.4.1`, CMake `3.30.5`, MFEM `4.10`, hypre `3.1.0`, and libCEED `0.12.0`). This
  step is only slow on the first host setup.
- `just docker-dev "$PWD"` validates mounts and storage, builds the backend inside the permanent
  `backend` container, and starts both the API runtime and Control Room on `http://127.0.0.1:3197`
  (or the next free port printed by the launcher).
- To run a single checkout script non-interactively once the group is running with an empty
  workspace, call `just docker-dev-script examples/fdm_cpu_relax_smoke.py`; to ensure services are
  up and execute a script in one step, run `just fullmag-dev-container examples/fdm_cpu_relax_smoke.py`.

Do **not** invoke plain `docker compose up`, host `cargo`/`cmake`, or retired host-runner commands:
the managed launcher records source, package, storage, and startup provenance before starting any
service.

Both FDM CUDA and FEM GPU lanes run inside the container runtime when NVIDIA GPU access is enabled
(`--gpu-access auto` or explicit GPU selection; optional `FULLMAG_DEV_CUDA_ARCHITECTURES` pins the
target CUDA compute capability in `compose.dev.yaml`). Before launching CUDA workloads, the runtime
runs device memory preflight checks (such as exact cuFFT workspace sizing on FDM CUDA and device
factor budget checks for opt-in cuDSS solvers) and records the resolved device identity in the
simulation provenance; host build completion alone does not qualify GPU parity.

## Checking the installation

Bare imports verify the Python layer only. Confirm end-to-end execution by running one of the
tracked stage-first smoke scripts through your DEV group, or by connecting a live session with
`fm.connect()` and running the {ref}`first FDM simulation <public-docs-getting-started-first-fdm-simulation>`
or {ref}`first FEM simulation <public-docs-getting-started-first-fem-simulation>` tutorials.

## Source-code index

- `packages/fullmag-py/pyproject.toml` — `[project]`, `[project.optional-dependencies]`: Python
  requirement and `[meshing]`, `[figures]`, `[jupyter]` extras.
- `justfile` — `docker-dev-toolchain`, `docker-dev`, `docker-dev-script`, `fullmag-dev-container`:
  managed Docker Compose DEV launcher recipes.
- `scripts/setup_docker.py` — interactive/check setup wizard for `.env` storage and port bindings.
- `scripts/docker_dev.py` and `scripts/bootstrap_docker_toolchain.py` — Docker Compose group
  bootstrap, mount/storage preflight, backend build/start, and script execution.
- `scripts/fullmag_storage.py` — `resolve_layout`: project/worktree/storage identity and path
  validation.
