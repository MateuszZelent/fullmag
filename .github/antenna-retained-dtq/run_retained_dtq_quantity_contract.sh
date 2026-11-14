#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
build_dir="${FULLMAG_FEM_CPU_BUILD_ROOT:?missing managed FEM CPU build root}/oersted-oef1"
[[ -f "$build_dir/CMakeCache.txt" && -f "$build_dir/backends/fem/libfullmag_fem.so" ]]
grep -Fxq 'FULLMAG_ENABLE_CUDA:BOOL=OFF' "$build_dir/CMakeCache.txt"
grep -Fxq 'FULLMAG_ENABLE_FEM_GPU:BOOL=OFF' "$build_dir/CMakeCache.txt"
export FULLMAG_FEM_LIB_DIR="$build_dir/backends/fem"
export LD_LIBRARY_PATH="$FULLMAG_FEM_LIB_DIR:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export RUST_MIN_STACK="${RUST_MIN_STACK:-8388608}"
cargo test --locked -p fullmag-api --features fem-native --bin fullmag-api retained_dtq_ -- --nocapture
pnpm install --frozen-lockfile
pnpm --dir apps/control-room exec vitest run     src/kernel/resources/savedAntennaSourceContextResources.test.ts     src/modules/inspector/panels/SavedFieldVisualizationPanel.test.tsx
pnpm --dir apps/control-room run typecheck
pnpm --dir apps/control-room exec eslint     src/kernel/resources/savedAntennaSourceContextResources.ts     src/kernel/resources/savedAntennaSourceContextResources.test.ts     src/modules/inspector/panels/SavedFieldVisualizationPanel.tsx     src/modules/inspector/panels/SavedFieldVisualizationPanel.test.tsx --max-warnings=0
printf '%s\n' 'TASK5_BROWSER_AND_AUTHENTICATED_RUNTIME=NOT_RUN'
