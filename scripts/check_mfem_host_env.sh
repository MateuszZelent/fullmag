#!/usr/bin/env bash
set -euo pipefail

require_gpu=0
mfem_prefix="${MFEM_PREFIX:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/check_mfem_host_env.sh [--prefix /path/to/mfem/install] [--require-gpu]

Checks whether the current host can run native Fullmag FEM parity tests against
an installed MFEM stack.

Inputs:
  --prefix PATH   Explicit MFEM install prefix to search first.
  --require-gpu   Also require nvcc / CUDA-visible GPU build prerequisites.

Environment considered:
  CMAKE_PREFIX_PATH
  MFEM_DIR
  FULLMAG_CMAKE
  FULLMAG_USE_MFEM_STACK
  FULLMAG_FEM_REQUIRE_GPU
  FULLMAG_FEM_MFEM_DEVICE
  FULLMAG_FEM_REQUIRE_CEED
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      shift
      if [ "$#" -eq 0 ]; then
        echo "missing value for --prefix" >&2
        exit 2
      fi
      mfem_prefix="$1"
      ;;
    --require-gpu)
      require_gpu=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

cmake_bin="${FULLMAG_CMAKE:-cmake}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

need_cmd "$cmake_bin"
need_cmd c++

if [ "$require_gpu" -eq 1 ]; then
  need_cmd nvcc
fi

find_mfem_config() {
  local prefix="$1"
  [ -n "$prefix" ] || return 1
  local candidate
  for candidate in \
    "$prefix/MFEMConfig.cmake" \
    "$prefix/mfem-config.cmake" \
    "$prefix/lib/cmake/mfem/MFEMConfig.cmake" \
    "$prefix/lib64/cmake/mfem/MFEMConfig.cmake" \
    "$prefix/share/mfem/cmake/MFEMConfig.cmake"
  do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

config_path=""

if [ -n "$mfem_prefix" ]; then
  config_path="$(find_mfem_config "$mfem_prefix" || true)"
fi

if [ -z "$config_path" ] && [ -n "${MFEM_DIR:-}" ]; then
  config_path="$(find_mfem_config "${MFEM_DIR}" || true)"
fi

if [ -z "$config_path" ] && [ -n "${CMAKE_PREFIX_PATH:-}" ]; then
  old_ifs="$IFS"
  IFS=':'
  for prefix in ${CMAKE_PREFIX_PATH}; do
    config_path="$(find_mfem_config "$prefix" || true)"
    if [ -n "$config_path" ]; then
      break
    fi
  done
  IFS="$old_ifs"
fi

if [ -z "$config_path" ]; then
  cat >&2 <<'EOF'
MFEM package config not found.

Expected one of:
  MFEMConfig.cmake
  mfem-config.cmake

Set one of:
  --prefix /path/to/mfem/install
  MFEM_DIR=/path/to/mfem/install
  CMAKE_PREFIX_PATH=/path/to/mfem/install${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}
EOF
  exit 1
fi

mfem_root="$(cd "$(dirname "$config_path")/../.." 2>/dev/null && pwd || true)"
if [ -z "$mfem_root" ]; then
  mfem_root="$(dirname "$config_path")"
fi

echo "MFEM config: $config_path"
echo "CMake binary: $(command -v "$cmake_bin")"
echo "C++ compiler: $(command -v c++)"
if [ "$require_gpu" -eq 1 ]; then
  echo "CUDA compiler: $(command -v nvcc)"
fi

cat <<EOF

Suggested exports:
  export FULLMAG_USE_MFEM_STACK=ON
  export CMAKE_PREFIX_PATH="${mfem_root}\${CMAKE_PREFIX_PATH:+:\$CMAKE_PREFIX_PATH}"
EOF

if [ "$require_gpu" -eq 1 ]; then
  cat <<'EOF'
  export FULLMAG_FEM_REQUIRE_GPU=1
  export FULLMAG_FEM_MFEM_DEVICE="${FULLMAG_FEM_MFEM_DEVICE:-cuda}"
# If your MFEM install was built with libCEED and you want to require it:
# export FULLMAG_FEM_REQUIRE_CEED=1
# export FULLMAG_FEM_MFEM_DEVICE=ceed-cuda:/gpu/cuda/shared
EOF
else
  cat <<'EOF'
  export FULLMAG_FEM_EXECUTION=cpu
EOF
fi

cat <<'EOF'

Suggested parity commands:
  cargo test -p fullmag-runner native_fem_zhang_li_step_matches_cpu_reference_when_mfem_stack_is_available --features fem-gpu -- --nocapture
  cargo test -p fullmag-runner native_fem_slonczewski_step_matches_independent_si_reference_when_mfem_stack_is_available --features fem-gpu -- --nocapture
EOF
