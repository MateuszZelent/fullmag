# MFEM Host Parity Setup (Ubuntu 22.04)

This guide describes the exact host prerequisites needed to run the native FEM
parity tests locally instead of falling back to the current "MFEM stack
unavailable" skip path.

Canonical sources for this guide:

- [build.rs](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-fem-sys/build.rs)
- [native FEM CMakeLists](/home/kkingstoun/git/fullmag/fullmag/native/backends/fem/CMakeLists.txt)
- [native root CMakeLists](/home/kkingstoun/git/fullmag/fullmag/native/CMakeLists.txt)
- [docker/fem-gpu/Dockerfile](/home/kkingstoun/git/fullmag/fullmag/docker/fem-gpu/Dockerfile)

## Required environment

Always set:

```bash
export FULLMAG_USE_MFEM_STACK=ON
export CMAKE_PREFIX_PATH=/path/to/mfem/install${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}
```

Optional:

```bash
export FULLMAG_CMAKE=/path/to/cmake
export FULLMAG_FEM_LIB_DIR=/path/to/prebuilt/fullmag_fem/lib
```

If you want to require native GPU FEM rather than CPU-only MFEM:

```bash
export FULLMAG_FEM_REQUIRE_GPU=1
export FULLMAG_FEM_EXECUTION=gpu
export FULLMAG_FEM_GPU_INDEX=0
```

If your MFEM build includes libCEED and you want to force that path:

```bash
export FULLMAG_FEM_REQUIRE_CEED=1
export FULLMAG_FEM_MFEM_DEVICE=ceed-cuda:/gpu/cuda/shared
```

If you want plain MFEM CUDA without CEED:

```bash
export FULLMAG_FEM_MFEM_DEVICE=cuda
```

## Required host packages

Minimum CPU-capable parity host:

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  cmake \
  gfortran \
  git \
  libopenmpi-dev \
  ninja-build \
  pkg-config
```

Additional GPU-capable parity host requirements:

- CUDA toolkit with a visible `nvcc`
- at least one visible CUDA device

## Required third-party stack

The repo expects an install prefix that exports `MFEMConfig.cmake` or
`mfem-config.cmake`. The canonical build stack used by Fullmag is:

- `MFEM v4.9`
- `libCEED v0.12.0`
- `hypre v3.1.0`

The corresponding reference build is encoded in
[docker/fem-gpu/Dockerfile](/home/kkingstoun/git/fullmag/fullmag/docker/fem-gpu/Dockerfile).

For GPU parity, the Docker reference enables:

- `MFEM_USE_MPI=YES`
- `MFEM_USE_OPENMP=YES`
- `MFEM_USE_CUDA=YES`
- `MFEM_USE_CEED=YES`
- `MFEM_USE_HYPRE=YES`

For CPU-only parity, CUDA is not required, but the MFEM CMake package still is.

## Fast local verification

Use the host verifier:

```bash
./scripts/check_mfem_host_env.sh --prefix /path/to/mfem/install
./scripts/check_mfem_host_env.sh --prefix /path/to/mfem/install --require-gpu
```

## Parity commands

CPU/MFEM parity:

```bash
FULLMAG_USE_MFEM_STACK=ON \
cargo test -p fullmag-runner \
  native_fem_zhang_li_step_matches_cpu_reference_when_mfem_stack_is_available \
  --features fem-gpu -- --nocapture
```

```bash
FULLMAG_USE_MFEM_STACK=ON \
cargo test -p fullmag-runner \
  native_fem_slonczewski_step_matches_independent_si_reference_when_mfem_stack_is_available \
  --features fem-gpu -- --nocapture
```

GPU/MFEM parity:

```bash
FULLMAG_USE_MFEM_STACK=ON \
FULLMAG_FEM_REQUIRE_GPU=1 \
FULLMAG_FEM_EXECUTION=gpu \
cargo test -p fullmag-runner \
  native_fem_zhang_li_step_matches_cpu_reference_when_mfem_stack_is_available \
  --features fem-gpu -- --nocapture
```

## Known failure signatures

If the host is not ready, the current failures are expected to look like one of
these:

- `cmake not found; install cmake, set FULLMAG_CMAKE, or set FULLMAG_FEM_LIB_DIR`
- `FULLMAG_USE_MFEM_STACK=ON; verify MFEM is installed and visible via CMAKE_PREFIX_PATH`
- missing `MFEMConfig.cmake` / `mfem-config.cmake`
- `CUDA requested but no compiler found — disabling`

Those are environment failures, not parity-test regressions.
