#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_PARENT="${REPO_ROOT}/.fullmag/runtimes"
RUNTIME_ROOT="${RUNTIME_PARENT}/fem-gpu-host"
VARIANTS_ROOT="${RUNTIME_PARENT}/fem-gpu-variants"
STAGING_ROOT="${RUNTIME_ROOT}.staging.$$"
STAGING_RELATIVE=".fullmag/runtimes/$(basename "${STAGING_ROOT}")"
RUNTIME_LOCK="${RUNTIME_PARENT}/.fem-gpu-host.export.lock"
mkdir -p "${RUNTIME_PARENT}"
exec 9>"${RUNTIME_LOCK}"
if ! flock -n 9; then
  echo "[export_fem_gpu_runtime] waiting for existing runtime export to finish"
  flock 9
fi

cleanup_failed_export() {
  local status="$?"
  rm -rf -- "${STAGING_ROOT}"
  exit "${status}"
}
trap cleanup_failed_export EXIT

cd "${REPO_ROOT}"
#rm -rf target/* target/.* 2>/dev/null || true

: "${FULLMAG_FEM_RUNTIME_CARGO_JOBS:=1}"
: "${FULLMAG_CUDA_ARCHITECTURES:=80-real;89-real;90-real;90-virtual}"
: "${FULLMAG_HYPRE_GPU_ARCHITECTURES:=60 70 80 89 90}"
: "${FULLMAG_HYPRE_MEMORY_VARIANT:=baseline}"
: "${FULLMAG_FEM_RUNTIME_VARIANT:=hypre-${FULLMAG_HYPRE_MEMORY_VARIANT}}"
: "${FULLMAG_FEM_EXPECTED_COMPUTE_CAPABILITY:=8.9}"
: "${FULLMAG_ENABLE_NVTX:=0}"
case "${FULLMAG_ENABLE_NVTX}" in
  0|1) ;;
  *) echo "[export_fem_gpu_runtime] FULLMAG_ENABLE_NVTX must be 0 or 1" >&2; exit 2 ;;
esac
export FULLMAG_CUDA_ARCHITECTURES
export FULLMAG_HYPRE_GPU_ARCHITECTURES
export FULLMAG_HYPRE_MEMORY_VARIANT
export FULLMAG_ENABLE_NVTX
FULLMAG_HOST_UID="$(id -u)"
FULLMAG_HOST_GID="$(id -g)"

docker compose --profile fem-gpu build fem-gpu

docker compose --profile fem-gpu run --rm -T \
  -e FULLMAG_FEM_RUNTIME_CARGO_JOBS="${FULLMAG_FEM_RUNTIME_CARGO_JOBS}" \
  -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES}" \
  -e FULLMAG_ENABLE_NVTX="${FULLMAG_ENABLE_NVTX}" \
  -e FULLMAG_HOST_UID="${FULLMAG_HOST_UID}" \
  -e FULLMAG_HOST_GID="${FULLMAG_HOST_GID}" \
  -e FULLMAG_RUNTIME_EXPORT_STAGING="${STAGING_RELATIVE}" \
  fem-gpu bash -lc '
set -euo pipefail
runtime_root="${FULLMAG_RUNTIME_EXPORT_STAGING:?missing managed FEM runtime staging directory}"
restore_staging_owner() {
  local status="$?"
  trap - EXIT
  if [ -e "${runtime_root}" ]; then
    chown -R "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}" "${runtime_root}" 2>/dev/null || true
    chmod -R u+rwX,go+rX,go-w "${runtime_root}" 2>/dev/null || true
  fi
  exit "${status}"
}
trap restore_staging_owner EXIT
echo "[export_fem_gpu_runtime] preparing runtime bundle directories"
mkdir -p ${runtime_root}/bin ${runtime_root}/lib ${runtime_root}/include
source scripts/lib/runtime_bundle_copy.sh
clear_runtime_bundle_contents() {
  local runtime_root="${runtime_root}"
  mkdir -p "$runtime_root/bin" "$runtime_root/lib" "$runtime_root/include"
  find "$runtime_root/bin" "$runtime_root/lib" \
    -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  rm -f "$runtime_root"/_fullmag_core*.so
  rm -rf "$runtime_root/include"
  rm -rf "$runtime_root/openmpi"
  mkdir -p "$runtime_root/bin" "$runtime_root/lib"
  mkdir -p "$runtime_root/include"
  mkdir -p "$runtime_root/openmpi/bin"
}
echo "[export_fem_gpu_runtime] forcing fullmag-fem-sys native rebuild before copying runtime libraries"
if [ "${FULLMAG_ENABLE_NVTX}" = "0" ] &&
   [[ "${RUSTFLAGS:-}" == *fullmag_enable_nvtx* ]]; then
  echo "[export_fem_gpu_runtime] inherited RUSTFLAGS contains fullmag_enable_nvtx while FULLMAG_ENABLE_NVTX=0" >&2
  exit 2
fi
cargo +nightly clean -p fullmag-fem-sys --release
mapfile -t stale_fem_native_artifacts < <(
  find target/release/build \
    -path "*fullmag-fem-sys*/out/native-build/backends/fem/libfullmag_fem.so.0" \
    -print 2>/dev/null
)
if [ "${#stale_fem_native_artifacts[@]}" -ne 0 ]; then
  echo "[export_fem_gpu_runtime] stale fullmag-fem-sys native artifacts remain after targeted clean" >&2
  printf "  %s\n" "${stale_fem_native_artifacts[@]}" >&2
  exit 2
fi

echo "[export_fem_gpu_runtime] building fullmag-cli, fullmag-api, and PyO3 core with cuda fem-gpu release features"
cargo_jobs="${FULLMAG_FEM_RUNTIME_CARGO_JOBS:-1}"
if ! [[ "$cargo_jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "[export_fem_gpu_runtime] FULLMAG_FEM_RUNTIME_CARGO_JOBS must be a positive integer, got: ${cargo_jobs}" >&2
  exit 2
fi
echo "[export_fem_gpu_runtime] cargo build jobs: ${cargo_jobs}"
if [ "${FULLMAG_ENABLE_NVTX}" = "1" ]; then
  export RUSTFLAGS="${RUSTFLAGS:+${RUSTFLAGS} }--cfg fullmag_enable_nvtx --check-cfg=cfg(fullmag_enable_nvtx)"
fi
FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES}" FULLMAG_USE_MFEM_STACK=ON cargo +nightly build -j "$cargo_jobs" -p fullmag-cli -p fullmag-api -p fullmag-py-core --features "fullmag-cli/cuda fullmag-cli/fem-gpu fullmag-api/cuda fullmag-api/fem-gpu" --release 2>&1 | tee /tmp/fullmag-build.log
echo "[export_fem_gpu_runtime] clearing previous runtime bundle contents"
clear_runtime_bundle_contents
echo "[export_fem_gpu_runtime] copying launcher and API binaries"
copy_runtime_binary() {
  local src="$1"
  local dest="$2"
  rm -rf -- "$dest"
  cp --remove-destination "$src" "$dest"
  chmod 755 "$dest"
}
copy_runtime_binary target/release/fullmag ${runtime_root}/bin/fullmag-fem-gpu-bin
copy_runtime_binary target/release/fullmag-api ${runtime_root}/bin/fullmag-api
if [ ! -f target/release/lib_fullmag_core.so ]; then
  echo "[export_fem_gpu_runtime] failed to locate PyO3 module: target/release/lib_fullmag_core.so" >&2
  exit 1
fi
install -m 755 target/release/lib_fullmag_core.so ${runtime_root}/_fullmag_core.so
latest_native_lib_dir() {
  local pattern="$1"
  local selected
  selected="$(find target/release/build -path "$pattern" -printf "%T@ %p\n" | sort -nr | head -n1 | cut -d" " -f2-)"
  if [ -z "$selected" ]; then
    echo "[export_fem_gpu_runtime] failed to locate native library matching pattern: $pattern" >&2
    exit 1
  fi
  dirname "$selected"
}
only_native_lib_dir() {
  local pattern="$1"
  local matches=()
  mapfile -t matches < <(find target/release/build -path "$pattern" -print)
  if [ "${#matches[@]}" -ne 1 ]; then
    echo "[export_fem_gpu_runtime] expected exactly one native library matching pattern: $pattern" >&2
    printf "  %s\n" "${matches[@]}" >&2
    exit 1
  fi
  dirname "${matches[0]}"
}
copy_library_group_entry_replace() {
  local src="$1"
  local dest_dir="$2"
  local dest="$dest_dir/$(basename "$src")"

  rm -rf -- "$dest"
  if [ -L "$src" ]; then
    ln -sfn "$(readlink "$src")" "$dest"
  else
    install -m 755 "$src" "$dest"
  fi
}
copy_native_library_group() {
  local source_dir="$1"
  local stem="$2"
  local dest_dir="${runtime_root}/lib"
  local resolved_name=""
  find "$dest_dir" -maxdepth 1 -name "${stem}.so*" -exec rm -f -- {} +
  for src in "$source_dir"/"${stem}".so*; do
    if [ -e "$src" ] && [ ! -L "$src" ]; then
      copy_library_group_entry_replace "$src" "$dest_dir"
    fi
  done
  for src in "$source_dir"/"${stem}".so*; do
    if [ -L "$src" ]; then
      if [ "$(basename "$src")" = "${stem}.so" ]; then
        continue
      fi
      copy_library_group_entry_replace "$src" "$dest_dir"
    fi
  done
  if [ -e "$dest_dir/${stem}.so.0" ] || [ -L "$dest_dir/${stem}.so.0" ]; then
    resolved_name="${stem}.so.0"
  else
    resolved_name="$(find "$dest_dir" -maxdepth 1 -name "${stem}.so.*" -printf '%f\n' | sort | head -n1)"
  fi
  if [ -n "$resolved_name" ]; then
    ensure_runtime_soname_link "$dest_dir" "$stem" "$resolved_name"
  fi
}
resolve_pkg_library_path() {
  local pkg="$1"
  local stem="$2"
  local libdir
  libdir="$(pkg-config --variable=libdir "$pkg")"
  if [ -e "$libdir/${stem}.so" ]; then
    readlink -f "$libdir/${stem}.so"
    return 0
  fi
  find /lib /usr/lib -name "${stem}.so*" -print | sort | head -n1
}
copy_pkg_library_group() {
  local pkg="$1"
  local stem="$2"
  local resolved
  local source_dir
  local resolved_name
  local dest_dir="${runtime_root}/lib"
  resolved="$(resolve_pkg_library_path "$pkg" "$stem")"
  if [ -z "$resolved" ]; then
    echo "[export_fem_gpu_runtime] failed to resolve $pkg library group for $stem" >&2
    exit 1
  fi
  source_dir="$(dirname "$resolved")"
  resolved_name="$(basename "$resolved")"
  copy_native_library_group "$source_dir" "$stem"
  if [ -f "$dest_dir/$resolved_name" ]; then
    ensure_runtime_soname_link "$dest_dir" "$stem" "$resolved_name"
  fi
}
copy_shared_library_dependency_closure() {
  local initial_lib="$1"
  local dest_dir="${runtime_root}/lib"
  local pending=("$initial_lib")
  local visited=" "
  local skip_system_runtime_regex="/(ld-linux|ld64|libc|libdl|libm|libpthread|libresolv|librt|libutil|libgcc_s|libstdc\+\+)\.so"
  while [ "${#pending[@]}" -gt 0 ]; do
    local lib="${pending[0]}"
    pending=("${pending[@]:1}")
    local resolved
    resolved="$(readlink -f "$lib" 2>/dev/null || true)"
    if [ -z "$resolved" ] || [ ! -f "$resolved" ]; then
      continue
    fi
    case "$visited" in
      *" $resolved "*) continue ;;
    esac
    visited="${visited}${resolved} "
    if [[ "$resolved" =~ $skip_system_runtime_regex ]]; then
      continue
    fi
    local requested_name
    requested_name="$(basename "$lib")"
    local lib_name
    lib_name="$(basename "$resolved")"
    case "$resolved" in
      /lib/*|/lib64/*|/usr/lib/*|/usr/lib64/*)
        copy_runtime_resolved_dependency_pair "$lib" "$resolved" "$dest_dir"
        ;;
    esac
    while IFS= read -r dep; do
      pending+=("$dep")
    done < <(
      ldd "$resolved" \
        | awk "
            \$2 == \"=>\" && \$3 ~ /^\// { print \$3 }
            \$1 ~ /^\// { print \$1 }
          "
    )
  done
}
copy_pkg_include_dirs() {
  local pkg="$1"
  local dest="$2"
  local copied=0
  mkdir -p "$dest"
  for flag in $(pkg-config --cflags-only-I "$pkg"); do
    case "$flag" in
      -I*)
        local include_dir="${flag#-I}"
        if [ -d "$include_dir" ]; then
          cp -a "$include_dir"/. "$dest"/
          copied=1
        fi
        ;;
    esac
  done
  if [ "$copied" -eq 0 ]; then
    echo "[export_fem_gpu_runtime] failed to copy any include dirs for $pkg" >&2
    exit 1
  fi
}
FEM_LIB="$(only_native_lib_dir "*fullmag-fem-sys*/out/native-build/backends/fem/libfullmag_fem.so.0")"
FDM_LIB="$(latest_native_lib_dir "*fullmag-fdm-sys*/out/native-build/backends/fdm/libfullmag_fdm.so.0")"
echo "[export_fem_gpu_runtime] bundling FEM and FDM native libraries"
copy_native_library_group "$FEM_LIB" libfullmag_fem
copy_native_library_group "$FDM_LIB" libfullmag_fdm
validate_nvtx_artifact() {
  local artifact="$1"
  shift
  local range_name
  for range_name in "$@"; do
    if grep -aFq -- "$range_name" "$artifact"; then
      if [ "${FULLMAG_ENABLE_NVTX}" = "0" ]; then
        echo "[export_fem_gpu_runtime] NVTX-off artifact contains phase range $range_name: $artifact" >&2
        exit 2
      fi
    elif [ "${FULLMAG_ENABLE_NVTX}" = "1" ]; then
      echo "[export_fem_gpu_runtime] NVTX-on artifact is missing phase range $range_name: $artifact" >&2
      exit 2
    fi
  done
}
validate_nvtx_artifact "${runtime_root}/lib/libfullmag_fem.so.0" \
  fem.relax.ncg.step \
  fem.relax.armijo \
  fem.demag.rhs \
  fem.demag.hypre.apply \
  fem.demag.recovery
validate_nvtx_artifact "${runtime_root}/bin/fullmag-fem-gpu-bin" \
  fem.preview.snapshot \
  fem.host.callback \
  fem.host.publish
validate_nvtx_symbol_contract() {
  local native_artifact="$1"
  local worker_artifact="$2"
  local native_defined
  local worker_undefined
  local native_dynamic
  local worker_dynamic
  local combined_symbols
  native_defined="$(nm -D --defined-only "$native_artifact")"
  worker_undefined="$(nm -D --undefined-only "$worker_artifact")"
  native_dynamic="$(readelf -d "$native_artifact")"
  worker_dynamic="$(readelf -d "$worker_artifact")"
  combined_symbols="$(nm -D "$native_artifact" "$worker_artifact")"
  local symbol
  for symbol in fullmag_fem_nvtx_range_start fullmag_fem_nvtx_range_end; do
    if [ "${FULLMAG_ENABLE_NVTX}" = "1" ]; then
      if ! grep -Eq "[[:space:]]${symbol}$" <<<"$native_defined"; then
        echo "[export_fem_gpu_runtime] NVTX-on FEM library is missing defined wrapper symbol ${symbol}" >&2
        exit 2
      fi
      if ! grep -Eq "[[:space:]]${symbol}$" <<<"$worker_undefined"; then
        echo "[export_fem_gpu_runtime] NVTX-on worker is missing wrapper reference ${symbol}" >&2
        exit 2
      fi
    elif grep -Fq -- "$symbol" <<<"$combined_symbols"; then
      echo "[export_fem_gpu_runtime] NVTX-off artifact contains wrapper symbol ${symbol}" >&2
      exit 2
    fi
  done
  if ! grep -Eq "NEEDED.*libfullmag_fem\\.so\\.0" <<<"$worker_dynamic"; then
    echo "[export_fem_gpu_runtime] worker is missing its managed libfullmag_fem.so.0 dependency" >&2
    exit 2
  fi
  if grep -Eqi "NEEDED.*(libnvToolsExt|libnvtx)" <<<"${native_dynamic}${worker_dynamic}"; then
    echo "[export_fem_gpu_runtime] NVTX instrumentation must use header injection without an unbundled NVTX shared-library dependency" >&2
    exit 2
  fi
}
validate_nvtx_symbol_contract \
  "${runtime_root}/lib/libfullmag_fem.so.0" \
  "${runtime_root}/bin/fullmag-fem-gpu-bin"
petsc_version="$(pkg-config --modversion PETSc)"
slepc_version="$(pkg-config --modversion SLEPc)"
petsc_pkgconfig_dir="$(pkg-config --variable=pcfiledir PETSc)"
slepc_pkgconfig_dir="$(pkg-config --variable=pcfiledir SLEPc)"
echo "[export_fem_gpu_runtime] bundling PETSc/SLEPc shared libraries"
copy_pkg_library_group PETSc libpetsc_real
copy_pkg_library_group SLEPc libslepc_real
copy_shared_library_dependency_closure ${runtime_root}/lib/libpetsc_real.so
copy_shared_library_dependency_closure ${runtime_root}/lib/libslepc_real.so
for dep_entry in /opt/fullmag-deps/lib/*; do
  dep_name="$(basename "$dep_entry")"
  dep_dest="${runtime_root}/lib/$dep_name"
  rm -rf "$dep_dest"
  if [ -d "$dep_entry" ] && [ ! -L "$dep_entry" ]; then
    mkdir -p "$dep_dest"
    cp -a "$dep_entry"/. "$dep_dest"/
  else
    copy_runtime_entry_replace "$dep_entry" ${runtime_root}/lib
  fi
done
echo "[export_fem_gpu_runtime] bundling MFEM/libCEED/Hypre host headers"
cp -R /opt/fullmag-deps/include/. ${runtime_root}/include/
echo "[export_fem_gpu_runtime] bundling PETSc/SLEPc headers"
rm -rf ${runtime_root}/include/petsc ${runtime_root}/include/slepc
mkdir -p ${runtime_root}/include/petsc ${runtime_root}/include/slepc
copy_pkg_include_dirs PETSc ${runtime_root}/include/petsc
copy_pkg_include_dirs SLEPc ${runtime_root}/include/slepc
echo "[export_fem_gpu_runtime] bundling OpenMPI headers referenced by MFEM"
rm -rf ${runtime_root}/include/openmpi
mkdir -p ${runtime_root}/include/openmpi
cp -a /usr/lib/x86_64-linux-gnu/openmpi/include/. ${runtime_root}/include/openmpi/
echo "[export_fem_gpu_runtime] bundling CUDA headers included by MFEM"
cp -a /usr/local/cuda-12.4/targets/x86_64-linux/include/. ${runtime_root}/include/
echo "[export_fem_gpu_runtime] bundling CUDA shared libraries referenced by MFEMTargets"
for cuda_lib in \
  /usr/local/cuda-12.4/targets/x86_64-linux/lib/libcurand.so* \
  /usr/local/cuda-12.4/targets/x86_64-linux/lib/libcublas.so* \
  /usr/local/cuda-12.4/targets/x86_64-linux/lib/libcusparse.so*; do
  if [ -e "$cuda_lib" ]; then
    copy_runtime_entry_replace "$cuda_lib" ${runtime_root}/lib
  fi
done
echo "[export_fem_gpu_runtime] relocating MFEM CMake package metadata"
perl -0pi -e "s#/usr/lib/x86_64-linux-gnu/openmpi/include/openmpi#\\\${PACKAGE_PREFIX_DIR}/include/openmpi/openmpi#g; s#/usr/lib/x86_64-linux-gnu/openmpi/include#\\\${PACKAGE_PREFIX_DIR}/include/openmpi#g; s#/opt/fullmag-deps/include#\\\${PACKAGE_PREFIX_DIR}/include#g" \
  ${runtime_root}/lib/cmake/mfem/MFEMConfig.cmake
perl -0pi -e "s#/usr/lib/x86_64-linux-gnu/openmpi/include/openmpi#\\\${_IMPORT_PREFIX}/include/openmpi/openmpi#g; s#/usr/lib/x86_64-linux-gnu/openmpi/include#\\\${_IMPORT_PREFIX}/include/openmpi#g; s#/opt/fullmag-deps/include#\\\${_IMPORT_PREFIX}/include#g; s#/opt/fullmag-deps/lib/libHYPRE.so#\\\${_IMPORT_PREFIX}/lib/libHYPRE.so#g; s#/opt/fullmag-deps/lib/libceed.so#\\\${_IMPORT_PREFIX}/lib/libceed.so#g; s#/usr/lib/x86_64-linux-gnu/openmpi/lib/libmpi_cxx.so#\\\${_IMPORT_PREFIX}/lib/libmpi_cxx.so.40#g; s#/usr/lib/x86_64-linux-gnu/openmpi/lib/libmpi.so#\\\${_IMPORT_PREFIX}/lib/libmpi.so.40#g; s#/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcurand.so#\\\${_IMPORT_PREFIX}/lib/libcurand.so#g; s#/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcublas.so#\\\${_IMPORT_PREFIX}/lib/libcublas.so#g; s#/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcusparse.so#\\\${_IMPORT_PREFIX}/lib/libcusparse.so#g" \
  ${runtime_root}/lib/cmake/mfem/MFEMTargets.cmake
echo "[export_fem_gpu_runtime] bundling PETSc/SLEPc CMake find modules"
mkdir -p ${runtime_root}/lib/cmake/fullmag-frequency-domain
cp -a backends/fem/cmake/FindPETSc.cmake \
  ${runtime_root}/lib/cmake/fullmag-frequency-domain/FindPETSc.cmake
cp -a backends/fem/cmake/FindSLEPc.cmake \
  ${runtime_root}/lib/cmake/fullmag-frequency-domain/FindSLEPc.cmake
# Bundle OpenMPI runtime libs so the exported host runtime does not depend
# on host-installed libmpi/libopen-rte variants.
shopt -s nullglob
for lib_glob in \
  /usr/lib/x86_64-linux-gnu/libmpi*.so* \
  /usr/lib/x86_64-linux-gnu/libmca_common_*.so* \
  /usr/lib/x86_64-linux-gnu/libpmix*.so* \
  /usr/lib/x86_64-linux-gnu/libnl-3.so* \
  /usr/lib/x86_64-linux-gnu/libnl-route-3.so* \
  /usr/lib/x86_64-linux-gnu/libopen-rte*.so* \
  /usr/lib/x86_64-linux-gnu/libopen-pal*.so* \
  /usr/lib/x86_64-linux-gnu/libhwloc.so* \
  /usr/lib/x86_64-linux-gnu/libevent*.so* \
  /usr/lib/x86_64-linux-gnu/openmpi/lib/*.so*; do
  for lib in $lib_glob; do
    copy_runtime_entry_replace "$lib" ${runtime_root}/lib
  done
done
shopt -u nullglob
echo "[export_fem_gpu_runtime] bundling OpenMPI/PMIx runtime components"
if [ -x /usr/bin/orted ]; then
  copy_runtime_entry_replace /usr/bin/orted ${runtime_root}/openmpi/bin
fi
if [ -d /usr/lib/x86_64-linux-gnu/pmix2/lib ]; then
  mkdir -p ${runtime_root}/lib/pmix2
  cp -a /usr/lib/x86_64-linux-gnu/pmix2/lib \
    ${runtime_root}/lib/pmix2/
fi
if [ -d /usr/lib/x86_64-linux-gnu/pmix2/share ]; then
  mkdir -p ${runtime_root}/lib/pmix2
  cp -a /usr/lib/x86_64-linux-gnu/pmix2/share \
    ${runtime_root}/lib/pmix2/
fi
if [ -d /usr/lib/x86_64-linux-gnu/openmpi/lib/openmpi3 ]; then
  mkdir -p ${runtime_root}/openmpi/lib
  cp -a /usr/lib/x86_64-linux-gnu/openmpi/lib/openmpi3 \
    ${runtime_root}/openmpi/lib/
fi
if [ -d /usr/share/openmpi ]; then
  mkdir -p ${runtime_root}/openmpi/share
  cp -a /usr/share/openmpi \
    ${runtime_root}/openmpi/share/
fi
require_exported_path() {
  local path="$1"
  local label="$2"
  if [ ! -e "$path" ]; then
    echo "[export_fem_gpu_runtime] missing exported $label: $path" >&2
    exit 1
  fi
}
require_exported_path ${runtime_root}/openmpi/share/openmpi/help-mpi-runtime.txt "OpenMPI help data"
require_exported_path ${runtime_root}/openmpi/share/openmpi/help-opal-runtime.txt "OpenMPI OPAL help data"
require_exported_path ${runtime_root}/openmpi/lib/openmpi3/mca_ess_singleton.so "OpenMPI singleton ESS component"
require_exported_path ${runtime_root}/openmpi/lib/openmpi3/mca_plm_isolated.so "OpenMPI isolated PLM component"
require_exported_path ${runtime_root}/openmpi/lib/openmpi3/mca_pmix_isolated.so "OpenMPI isolated PMIx component"
require_exported_path ${runtime_root}/openmpi/lib/openmpi3/mca_btl_self.so "OpenMPI self BTL component"
require_exported_path ${runtime_root}/lib/pmix2/lib/pmix/mca_pcompress_zlib.so "PMIx compression component"
require_exported_path ${runtime_root}/lib/pmix2/share/pmix/help-pmix-runtime.txt "PMIx help data"
require_exported_path ${runtime_root}/lib/libpetsc_real.so "PETSc shared library"
require_exported_path ${runtime_root}/lib/libslepc_real.so "SLEPc shared library"
require_exported_path ${runtime_root}/_fullmag_core.so "PyO3 _fullmag_core module"
require_exported_path ${runtime_root}/lib/cmake/fullmag-frequency-domain/FindPETSc.cmake "PETSc CMake find module"
require_exported_path ${runtime_root}/lib/cmake/fullmag-frequency-domain/FindSLEPc.cmake "SLEPc CMake find module"
export PETSC_VERSION="$petsc_version"
export SLEPC_VERSION="$slepc_version"
export PETSC_PKGCONFIG_DIR="$petsc_pkgconfig_dir"
export SLEPC_PKGCONFIG_DIR="$slepc_pkgconfig_dir"
python3 - <<PY
import json
import os
from pathlib import Path

runtime = Path("${runtime_root}")
payload = {
    "petsc_available": True,
    "slepc_available": True,
    "modal_eigen_native_cpu_slepc_available": True,
    "petsc_version": os.environ["PETSC_VERSION"],
    "slepc_version": os.environ["SLEPC_VERSION"],
    "petsc_pkgconfig_dir": os.environ["PETSC_PKGCONFIG_DIR"],
    "slepc_pkgconfig_dir": os.environ["SLEPC_PKGCONFIG_DIR"],
    "exported_runtime_library_paths": sorted(
        [f"lib/{path.name}" for path in runtime.joinpath("lib").glob("libpetsc_real.so*")]
        + [f"lib/{path.name}" for path in runtime.joinpath("lib").glob("libslepc_real.so*")]
    ),
    "exported_cmake_module_paths": [
        "lib/cmake/fullmag-frequency-domain/FindPETSc.cmake",
        "lib/cmake/fullmag-frequency-domain/FindSLEPc.cmake",
    ],
    "exported_header_paths": [
        "include/petsc",
        "include/slepc",
    ],
}
(runtime / "frequency-domain-dependency-info.json").write_text(
    json.dumps(payload, indent=2) + "\n",
    encoding="utf-8",
)
PY
python3 - <<PY
import json
import subprocess
from pathlib import Path

result = subprocess.run(
    [
        "nvidia-smi",
        "--query-gpu=name,compute_cap,driver_version",
        "--format=csv,noheader,nounits",
    ],
    check=False,
    capture_output=True,
    text=True,
)
if result.returncode != 0:
    raise SystemExit(
        "[export_fem_gpu_runtime] NVIDIA runtime diagnostics failed: "
        + (result.stderr.strip() or result.stdout.strip())
    )
line = next((line for line in result.stdout.splitlines() if line.strip()), "")
parts = [part.strip() for part in line.split(",", 2)]
if len(parts) != 3 or not all(parts):
    raise SystemExit(
        f"[export_fem_gpu_runtime] invalid NVIDIA runtime diagnostics: {line!r}"
    )
payload = {
    "device_name": parts[0],
    "compute_capability": parts[1],
    "cuda_driver_version": parts[2],
}
Path("${runtime_root}/runtime-diagnostics.json").write_text(
    json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
PY
chown "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}" .fullmag .fullmag/runtimes
chown -R "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}" ${runtime_root}
chmod u+rwx,go+rx,go-w .fullmag .fullmag/runtimes
chmod -R u+rwX,go+rX,go-w ${runtime_root}
echo "[export_fem_gpu_runtime] container-side export complete"
' < /dev/null

cat > "${STAGING_ROOT}/bin/fullmag-fem-gpu" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_ROOT="$(cd "${SELF_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RUNTIME_ROOT}/../../.." && pwd)"
export FULLMAG_REPO_ROOT="${REPO_ROOT}"
export LD_LIBRARY_PATH="${RUNTIME_ROOT}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
export PYTHONPATH="${RUNTIME_ROOT}${PYTHONPATH:+:${PYTHONPATH}}"
OPENMPI_ROOT="${RUNTIME_ROOT}/openmpi"
if [ -e "${RUNTIME_ROOT}/lib/libmpi.so.40" ]; then
  missing_openmpi=0
  for required in \
    "${OPENMPI_ROOT}/share/openmpi/help-mpi-runtime.txt" \
    "${OPENMPI_ROOT}/share/openmpi/help-opal-runtime.txt" \
    "${OPENMPI_ROOT}/lib/openmpi3/mca_ess_singleton.so" \
    "${OPENMPI_ROOT}/lib/openmpi3/mca_plm_isolated.so" \
    "${OPENMPI_ROOT}/lib/openmpi3/mca_pmix_isolated.so" \
    "${OPENMPI_ROOT}/lib/openmpi3/mca_btl_self.so"; do
    if [ ! -e "${required}" ]; then
      echo "managed FEM runtime is missing OpenMPI runtime component: ${required}" >&2
      missing_openmpi=1
    fi
  done
  if [ "${missing_openmpi}" -ne 0 ]; then
    echo "Re-export the managed FEM runtime with: ./scripts/export_fem_gpu_runtime.sh" >&2
    exit 2
  fi
fi
if [ -d "${OPENMPI_ROOT}/share/openmpi" ]; then
  export OPAL_PREFIX="${OPENMPI_ROOT}"
  export PATH="${OPENMPI_ROOT}/bin${PATH:+:${PATH}}"
  export OMPI_MCA_mca_base_component_path="${OPENMPI_ROOT}/lib/openmpi3"
  export OMPI_MCA_orte_launch_agent="${OPENMPI_ROOT}/bin/orted"
  export OMPI_MCA_ess="${OMPI_MCA_ess:-singleton}"
  export OMPI_MCA_plm="${OMPI_MCA_plm:-isolated}"
  export OMPI_MCA_pmix="${OMPI_MCA_pmix:-isolated}"
  export OMPI_MCA_ras="${OMPI_MCA_ras:-simulator}"
  export OMPI_MCA_rmaps="${OMPI_MCA_rmaps:-seq}"
  export OMPI_MCA_routed="${OMPI_MCA_routed:-direct}"
  export OMPI_MCA_reachable="${OMPI_MCA_reachable:-weighted}"
  export OMPI_MCA_mca_base_component_show_load_errors="${OMPI_MCA_mca_base_component_show_load_errors:-0}"
  export OMPI_MCA_btl="${OMPI_MCA_btl:-self}"
  export OMPI_MCA_oob="${OMPI_MCA_oob:-tcp}"
  if [ -z "${OMPI_MCA_oob_tcp_if_include:-}" ] && [ -z "${OMPI_MCA_oob_tcp_if_exclude:-}" ]; then
    export OMPI_MCA_oob_tcp_if_include=lo
  fi
fi
if [ -e "${RUNTIME_ROOT}/lib/libmpi.so.40" ]; then
  missing_pmix=0
  for required in \
    "${RUNTIME_ROOT}/lib/pmix2/lib/pmix/mca_pcompress_zlib.so" \
    "${RUNTIME_ROOT}/lib/pmix2/share/pmix/help-pmix-runtime.txt"; do
    if [ ! -e "${required}" ]; then
      echo "managed FEM runtime is missing PMIx runtime component: ${required}" >&2
      missing_pmix=1
    fi
  done
  if [ "${missing_pmix}" -ne 0 ]; then
    echo "Re-export the managed FEM runtime with: ./scripts/export_fem_gpu_runtime.sh" >&2
    exit 2
  fi
fi
if [ -d "${RUNTIME_ROOT}/lib/pmix2/share/pmix" ]; then
  export PMIX_PREFIX="${RUNTIME_ROOT}/lib/pmix2"
  export PMIX_EXEC_PREFIX="${RUNTIME_ROOT}/lib/pmix2"
  export PMIX_DATADIR="${RUNTIME_ROOT}/lib/pmix2/share"
  export PMIX_PKGDATADIR="${RUNTIME_ROOT}/lib/pmix2/share/pmix"
  export PMIX_LIBDIR="${RUNTIME_ROOT}/lib/pmix2/lib"
  export PMIX_MCA_mca_base_component_path="${RUNTIME_ROOT}/lib/pmix2/lib/pmix"
  export PMIX_MCA_pcompress_base_silence_warning="${PMIX_MCA_pcompress_base_silence_warning:-1}"
  if [ -z "${PMIX_MCA_ptl_tcp_if_include:-}" ] && [ -z "${PMIX_MCA_ptl_tcp_if_exclude:-}" ]; then
    export PMIX_MCA_ptl_tcp_if_include=lo
  fi
fi
unset FULLMAG_CPU_THREADS_AUTO_RESOLVED
if [ -n "${FULLMAG_CPU_THREADS:-}" ] && [ -z "${OMP_NUM_THREADS:-}" ]; then
  case "${FULLMAG_CPU_THREADS}" in
    auto|AUTO|Auto)
      if command -v nproc >/dev/null 2>&1; then
        FULLMAG_CPU_THREADS_AUTO_RESOLVED="$(nproc)"
      else
        FULLMAG_CPU_THREADS_AUTO_RESOLVED=1
      fi
      if [ "${FULLMAG_CPU_THREADS_AUTO_RESOLVED}" -gt 8 ]; then
        FULLMAG_CPU_THREADS_AUTO_RESOLVED=8
      fi
      export FULLMAG_CPU_THREADS_AUTO_RESOLVED
      export OMP_NUM_THREADS="${FULLMAG_CPU_THREADS_AUTO_RESOLVED}"
      ;;
    ''|*[!0-9]*)
      ;;
    *)
      export OMP_NUM_THREADS="${FULLMAG_CPU_THREADS}"
      ;;
  esac
fi
export FULLMAG_FEM_GPU_INDEX="${FULLMAG_FEM_GPU_INDEX:-0}"
export FULLMAG_FDM_GPU_INDEX="${FULLMAG_FDM_GPU_INDEX:-${FULLMAG_FEM_GPU_INDEX}}"
exec "${SELF_DIR}/fullmag-fem-gpu-bin" "$@"
EOF

chmod +x "${STAGING_ROOT}/bin/fullmag-fem-gpu"

docker_image_id="$(docker image inspect fullmag/fem-gpu:local --format '{{.Id}}' 2>/dev/null || true)"
created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
export docker_image_id
export created_at
RUNTIME_ROOT="${STAGING_ROOT}" python3 - <<'PY'
import json
import os
from pathlib import Path

runtime_root = Path(os.environ["RUNTIME_ROOT"])
dependency_info = json.loads(
    (runtime_root / "frequency-domain-dependency-info.json").read_text(encoding="utf-8")
)
manifest = {
    "schema": 1,
    "runtime": "fem-gpu-host",
    "docker_image": "fullmag/fem-gpu:local",
    "docker_image_id": os.environ["docker_image_id"],
    "created_at": os.environ["created_at"],
    "binaries": {
        "launcher": "bin/fullmag-fem-gpu",
        "worker": "bin/fullmag-fem-gpu-bin",
        "api": "bin/fullmag-api",
    },
    "integrity": {
        "launcher_sha256": __import__("hashlib").sha256(
            (runtime_root / "bin/fullmag-fem-gpu").read_bytes()
        ).hexdigest(),
        "worker_sha256": __import__("hashlib").sha256(
            (runtime_root / "bin/fullmag-fem-gpu-bin").read_bytes()
        ).hexdigest(),
        "api_sha256": __import__("hashlib").sha256(
            (runtime_root / "bin/fullmag-api").read_bytes()
        ).hexdigest(),
    },
    "python_modules": {
        "_fullmag_core": "_fullmag_core.so",
    },
    "frequency_domain_dependencies": dependency_info,
}
(runtime_root / "manifest.json").write_text(
    json.dumps(manifest, indent=2) + "\n",
    encoding="utf-8",
)
PY

docker run --rm --network none \
  --user "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}" \
  -v "${REPO_ROOT}:/workspace" \
  -w /workspace \
  fullmag/fem-gpu:local \
  python3 scripts/build_managed_fem_runtime_manifest.py \
    --runtime-root "/workspace/${STAGING_RELATIVE}" \
    --variant "${FULLMAG_FEM_RUNTIME_VARIANT}" \
    --requested-cuda-architectures "${FULLMAG_CUDA_ARCHITECTURES}" \
    --hypre-build-metadata "/opt/fullmag-deps/share/fullmag/hypre-build-metadata.json" \
    --runtime-diagnostics-json "/workspace/${STAGING_RELATIVE}/runtime-diagnostics.json" \
    --docker-image-id "${docker_image_id}" \
    --created-at "${created_at}"

RUNTIME_ROOT="${STAGING_ROOT}" python3 - <<'PY'
import json
import os
from pathlib import Path

manifest_path = Path(os.environ["RUNTIME_ROOT"]) / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["instrumentation"] = {
    "nvtx_enabled": os.environ["FULLMAG_ENABLE_NVTX"] == "1",
}
manifest_path.write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
PY

python3 scripts/validate_managed_fem_runtime_bundle.py \
  --runtime-root "${STAGING_ROOT}" \
  --allow-unaddressed-staging \
  --require-native-cubin fullmag_fem=sm_89 \
  --require-native-cubin hypre=sm_89 \
  --require-compute-capability "${FULLMAG_FEM_EXPECTED_COMPUTE_CAPABILITY}"

cat > "${STAGING_ROOT}/README.md" <<EOF
# Managed FEM host runtime bundle

This directory contains a host-usable managed FEM runtime bundle exported from the \`fem-gpu\`
build container.

The bundle supports both:
- FEM CPU execution (\`FULLMAG_FEM_EXECUTION=cpu\`)
- FEM GPU execution (\`FULLMAG_FEM_EXECUTION=gpu\`)

Run directly with:

\`\`\`bash
${RUNTIME_ROOT}/bin/fullmag-fem-gpu examples/py_layer_hole_relax_150nm.py --until 1e-13 --backend fem
\`\`\`

This export publishes an immutable hash-addressed variant and atomically selects it through the
\`${RUNTIME_ROOT}\` active-runtime alias used by the host launcher.
EOF

publish_runtime_bundle() {
  local manifest_sha256
  manifest_sha256="$(sha256sum "${STAGING_ROOT}/manifest.json" | awk '{print $1}')"
  local variant_root="${VARIANTS_ROOT}/${FULLMAG_FEM_RUNTIME_VARIANT}-${manifest_sha256}"
  local alias_target="fem-gpu-variants/$(basename "${variant_root}")"
  local next_alias="${RUNTIME_PARENT}/.fem-gpu-host.next.$$"
  python3 scripts/validate_managed_fem_runtime_bundle.py \
    --runtime-root "${STAGING_ROOT}" \
    --allow-unaddressed-staging \
    --require-native-cubin fullmag_fem=sm_89 \
    --require-native-cubin hypre=sm_89 \
    --require-compute-capability "${FULLMAG_FEM_EXPECTED_COMPUTE_CAPABILITY}"
  mkdir -p "${VARIANTS_ROOT}"
  if [ -e "${variant_root}" ]; then
    python3 scripts/validate_managed_fem_runtime_bundle.py --runtime-root "${variant_root}"
    python3 scripts/validate_managed_fem_runtime_bundle.py \
      --runtime-root "${variant_root}" --compare-exact "${STAGING_ROOT}"
    rm -rf -- "${STAGING_ROOT}"
  else
    mv "${STAGING_ROOT}" "${variant_root}"
  fi
  if [ -e "${RUNTIME_ROOT}" ] && [ ! -L "${RUNTIME_ROOT}" ]; then
    echo "[export_fem_gpu_runtime] refusing to replace non-symlink active runtime: ${RUNTIME_ROOT}" >&2
    echo "Select an already preserved schema-v2 variant first." >&2
    return 2
  fi
  ln -sfn "${alias_target}" "${next_alias}"
  mv -Tf "${next_alias}" "${RUNTIME_ROOT}"
}

publish_runtime_bundle
trap - EXIT
echo "Exported FEM GPU host runtime bundle: ${RUNTIME_ROOT}"
echo "Main executable: ${RUNTIME_ROOT}/bin/fullmag-fem-gpu"
