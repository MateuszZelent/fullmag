#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${REPO_ROOT}/.fullmag/runtimes/fem-gpu-host"

mkdir -p "${RUNTIME_ROOT}/bin" "${RUNTIME_ROOT}/lib" "${RUNTIME_ROOT}/include"

cd "${REPO_ROOT}"
#rm -rf target/* target/.* 2>/dev/null || true


docker compose --profile fem-gpu run --rm -T fem-gpu bash -lc '
set -euo pipefail
echo "[export_fem_gpu_runtime] preparing runtime bundle directories"
mkdir -p .fullmag/runtimes/fem-gpu-host/bin .fullmag/runtimes/fem-gpu-host/lib .fullmag/runtimes/fem-gpu-host/include
rm -rf .fullmag/runtimes/fem-gpu-host/openmpi
mkdir -p .fullmag/runtimes/fem-gpu-host/openmpi/bin
echo "[export_fem_gpu_runtime] using cached cargo target when available; no cargo clean is performed"

echo "[export_fem_gpu_runtime] building fullmag-cli and fullmag-api with cuda fem-gpu release features"
FULLMAG_USE_MFEM_STACK=ON cargo +nightly build -j 2 -p fullmag-cli -p fullmag-api --features "fullmag-cli/cuda fullmag-cli/fem-gpu fullmag-api/cuda fullmag-api/fem-gpu" --release 2>&1 | tee /tmp/fullmag-build.log
echo "[export_fem_gpu_runtime] copying launcher and API binaries"
cp -f target/release/fullmag .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu-bin
cp -f target/release/fullmag-api .fullmag/runtimes/fem-gpu-host/bin/fullmag-api
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
FEM_LIB="$(latest_native_lib_dir "*fullmag-fem-sys*/out/native-build/backends/fem/libfullmag_fem.so.0")"
FDM_LIB="$(latest_native_lib_dir "*fullmag-fdm-sys*/out/native-build/backends/fdm/libfullmag_fdm.so.0")"
echo "[export_fem_gpu_runtime] bundling FEM and FDM native libraries"
cp -a "$FEM_LIB"/libfullmag_fem.so* .fullmag/runtimes/fem-gpu-host/lib/
cp -a "$FDM_LIB"/libfullmag_fdm.so* .fullmag/runtimes/fem-gpu-host/lib/
cp -a /opt/fullmag-deps/lib/* .fullmag/runtimes/fem-gpu-host/lib/
echo "[export_fem_gpu_runtime] bundling MFEM/libCEED/Hypre host headers"
cp -a /opt/fullmag-deps/include/. .fullmag/runtimes/fem-gpu-host/include/
echo "[export_fem_gpu_runtime] bundling OpenMPI headers referenced by MFEM"
mkdir -p .fullmag/runtimes/fem-gpu-host/include/openmpi
cp -a /usr/lib/x86_64-linux-gnu/openmpi/include/. .fullmag/runtimes/fem-gpu-host/include/openmpi/
echo "[export_fem_gpu_runtime] bundling CUDA headers included by MFEM"
cp -a /usr/local/cuda-12.4/targets/x86_64-linux/include/. .fullmag/runtimes/fem-gpu-host/include/
echo "[export_fem_gpu_runtime] bundling CUDA shared libraries referenced by MFEMTargets"
for cuda_lib in \
  /usr/local/cuda-12.4/targets/x86_64-linux/lib/libcurand.so* \
  /usr/local/cuda-12.4/targets/x86_64-linux/lib/libcublas.so* \
  /usr/local/cuda-12.4/targets/x86_64-linux/lib/libcusparse.so*; do
  if [ -e "$cuda_lib" ]; then
    cp -a "$cuda_lib" .fullmag/runtimes/fem-gpu-host/lib/
  fi
done
echo "[export_fem_gpu_runtime] relocating MFEM CMake package metadata"
perl -0pi -e "s#/usr/lib/x86_64-linux-gnu/openmpi/include/openmpi#\\\${PACKAGE_PREFIX_DIR}/include/openmpi/openmpi#g; s#/usr/lib/x86_64-linux-gnu/openmpi/include#\\\${PACKAGE_PREFIX_DIR}/include/openmpi#g; s#/opt/fullmag-deps/include#\\\${PACKAGE_PREFIX_DIR}/include#g" \
  .fullmag/runtimes/fem-gpu-host/lib/cmake/mfem/MFEMConfig.cmake
perl -0pi -e "s#/usr/lib/x86_64-linux-gnu/openmpi/include/openmpi#\\\${_IMPORT_PREFIX}/include/openmpi/openmpi#g; s#/usr/lib/x86_64-linux-gnu/openmpi/include#\\\${_IMPORT_PREFIX}/include/openmpi#g; s#/opt/fullmag-deps/include#\\\${_IMPORT_PREFIX}/include#g; s#/opt/fullmag-deps/lib/libHYPRE.so#\\\${_IMPORT_PREFIX}/lib/libHYPRE.so#g; s#/opt/fullmag-deps/lib/libceed.so#\\\${_IMPORT_PREFIX}/lib/libceed.so#g; s#/usr/lib/x86_64-linux-gnu/openmpi/lib/libmpi_cxx.so#\\\${_IMPORT_PREFIX}/lib/libmpi_cxx.so.40#g; s#/usr/lib/x86_64-linux-gnu/openmpi/lib/libmpi.so#\\\${_IMPORT_PREFIX}/lib/libmpi.so.40#g; s#/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcurand.so#\\\${_IMPORT_PREFIX}/lib/libcurand.so#g; s#/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcublas.so#\\\${_IMPORT_PREFIX}/lib/libcublas.so#g; s#/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcusparse.so#\\\${_IMPORT_PREFIX}/lib/libcusparse.so#g" \
  .fullmag/runtimes/fem-gpu-host/lib/cmake/mfem/MFEMTargets.cmake
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
    cp -a "$lib" .fullmag/runtimes/fem-gpu-host/lib/
  done
done
shopt -u nullglob
echo "[export_fem_gpu_runtime] bundling OpenMPI/PMIx runtime components"
if [ -x /usr/bin/orted ]; then
  cp -a /usr/bin/orted .fullmag/runtimes/fem-gpu-host/openmpi/bin/
fi
if [ -d /usr/lib/x86_64-linux-gnu/pmix2/lib ]; then
  mkdir -p .fullmag/runtimes/fem-gpu-host/lib/pmix2
  cp -a /usr/lib/x86_64-linux-gnu/pmix2/lib \
    .fullmag/runtimes/fem-gpu-host/lib/pmix2/
fi
if [ -d /usr/lib/x86_64-linux-gnu/pmix2/share ]; then
  mkdir -p .fullmag/runtimes/fem-gpu-host/lib/pmix2
  cp -a /usr/lib/x86_64-linux-gnu/pmix2/share \
    .fullmag/runtimes/fem-gpu-host/lib/pmix2/
fi
if [ -d /usr/lib/x86_64-linux-gnu/openmpi/lib/openmpi3 ]; then
  mkdir -p .fullmag/runtimes/fem-gpu-host/openmpi/lib
  cp -a /usr/lib/x86_64-linux-gnu/openmpi/lib/openmpi3 \
    .fullmag/runtimes/fem-gpu-host/openmpi/lib/
fi
if [ -d /usr/share/openmpi ]; then
  mkdir -p .fullmag/runtimes/fem-gpu-host/openmpi/share
  cp -a /usr/share/openmpi \
    .fullmag/runtimes/fem-gpu-host/openmpi/share/
fi
require_exported_path() {
  local path="$1"
  local label="$2"
  if [ ! -e "$path" ]; then
    echo "[export_fem_gpu_runtime] missing exported $label: $path" >&2
    exit 1
  fi
}
require_exported_path .fullmag/runtimes/fem-gpu-host/openmpi/share/openmpi/help-mpi-runtime.txt "OpenMPI help data"
require_exported_path .fullmag/runtimes/fem-gpu-host/openmpi/share/openmpi/help-opal-runtime.txt "OpenMPI OPAL help data"
require_exported_path .fullmag/runtimes/fem-gpu-host/openmpi/lib/openmpi3/mca_ess_singleton.so "OpenMPI singleton ESS component"
require_exported_path .fullmag/runtimes/fem-gpu-host/openmpi/lib/openmpi3/mca_btl_self.so "OpenMPI self BTL component"
require_exported_path .fullmag/runtimes/fem-gpu-host/lib/pmix2/lib/pmix/mca_pcompress_zlib.so "PMIx compression component"
require_exported_path .fullmag/runtimes/fem-gpu-host/lib/pmix2/share/pmix/help-pmix-runtime.txt "PMIx help data"
echo "[export_fem_gpu_runtime] container-side export complete"
'

cat > "${RUNTIME_ROOT}/bin/fullmag-fem-gpu" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_ROOT="$(cd "${SELF_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RUNTIME_ROOT}/../../.." && pwd)"
export FULLMAG_REPO_ROOT="${REPO_ROOT}"
export LD_LIBRARY_PATH="${RUNTIME_ROOT}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
OPENMPI_ROOT="${RUNTIME_ROOT}/openmpi"
if [ -e "${RUNTIME_ROOT}/lib/libmpi.so.40" ]; then
  missing_openmpi=0
  for required in \
    "${OPENMPI_ROOT}/share/openmpi/help-mpi-runtime.txt" \
    "${OPENMPI_ROOT}/share/openmpi/help-opal-runtime.txt" \
    "${OPENMPI_ROOT}/lib/openmpi3/mca_ess_singleton.so" \
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
  export OMPI_MCA_reachable="${OMPI_MCA_reachable:-weighted}"
  export OMPI_MCA_mca_base_component_show_load_errors="${OMPI_MCA_mca_base_component_show_load_errors:-0}"
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
  export PMIX_MCA_pcompress_base_silence_warning="${PMIX_MCA_pcompress_base_silence_warning:-1}"
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

chmod +x "${RUNTIME_ROOT}/bin/fullmag-fem-gpu"

docker_image_id="$(docker image inspect fullmag/fem-gpu:local --format '{{.Id}}' 2>/dev/null || true)"
created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
cat > "${RUNTIME_ROOT}/manifest.json" <<EOF
{
  "schema": 1,
  "runtime": "fem-gpu-host",
  "docker_image": "fullmag/fem-gpu:local",
  "docker_image_id": "${docker_image_id}",
  "created_at": "${created_at}",
  "binaries": {
    "launcher": "bin/fullmag-fem-gpu",
    "worker": "bin/fullmag-fem-gpu-bin",
    "api": "bin/fullmag-api"
  }
}
EOF

cat > "${RUNTIME_ROOT}/README.md" <<EOF
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

This bundle is not yet automatically resolved by the host launcher. It is a staging artifact for
the future launcher-owned managed-runtime flow.
EOF

echo "Exported FEM GPU host runtime bundle:"
echo "  ${RUNTIME_ROOT}"
echo "Main executable:"
echo "  ${RUNTIME_ROOT}/bin/fullmag-fem-gpu"
