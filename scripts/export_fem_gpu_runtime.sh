#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${REPO_ROOT}/.fullmag/runtimes/fem-gpu-host"

mkdir -p "${RUNTIME_ROOT}/bin" "${RUNTIME_ROOT}/lib"

cd "${REPO_ROOT}"

docker compose --profile fem-gpu run --rm -T fem-gpu bash -lc '
set -euo pipefail
echo "[export_fem_gpu_runtime] preparing runtime bundle directories"
mkdir -p .fullmag/runtimes/fem-gpu-host/bin .fullmag/runtimes/fem-gpu-host/lib
rm -rf .fullmag/runtimes/fem-gpu-host/openmpi
mkdir -p .fullmag/runtimes/fem-gpu-host/openmpi/bin
echo "[export_fem_gpu_runtime] cleaning stale FDM demag build cache"
cargo +nightly clean -p fullmag-fdm-demag >/dev/null 2>&1 || true
echo "[export_fem_gpu_runtime] building fullmag-cli with cuda fem-gpu release features"
FULLMAG_USE_MFEM_STACK=ON cargo +nightly build -p fullmag-cli --features "cuda fem-gpu" --release >/tmp/fullmag-build.log
echo "[export_fem_gpu_runtime] copying launcher binary"
cp -f target/release/fullmag .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu-bin
FEM_LIB=$(dirname "$(find target/release/build -path "*fullmag-fem-sys*/out/native-build/backends/fem/libfullmag_fem.so.0" | head -n1)")
FDM_LIB=$(dirname "$(find target/release/build -path "*fullmag-fdm-sys*/out/native-build/backends/fdm/libfullmag_fdm.so.0" | head -n1)")
echo "[export_fem_gpu_runtime] bundling FEM and FDM native libraries"
cp -a "$FEM_LIB"/libfullmag_fem.so* .fullmag/runtimes/fem-gpu-host/lib/
cp -a "$FDM_LIB"/libfullmag_fdm.so* .fullmag/runtimes/fem-gpu-host/lib/
cp -a /opt/fullmag-deps/lib/* .fullmag/runtimes/fem-gpu-host/lib/
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
if [ -d "${OPENMPI_ROOT}/share/openmpi" ]; then
  export OPAL_PREFIX="${OPENMPI_ROOT}"
  export PATH="${OPENMPI_ROOT}/bin${PATH:+:${PATH}}"
  export OMPI_MCA_mca_base_component_path="${OPENMPI_ROOT}/lib/openmpi3"
  export OMPI_MCA_orte_launch_agent="${OPENMPI_ROOT}/bin/orted"
  export OMPI_MCA_reachable="${OMPI_MCA_reachable:-weighted}"
fi
if [ -d "${RUNTIME_ROOT}/lib/pmix2/share/pmix" ]; then
  export PMIX_PREFIX="${RUNTIME_ROOT}/lib/pmix2"
  export PMIX_EXEC_PREFIX="${RUNTIME_ROOT}/lib/pmix2"
fi
export FULLMAG_FEM_EXECUTION="${FULLMAG_FEM_EXECUTION:-gpu}"
export FULLMAG_FEM_GPU_INDEX="${FULLMAG_FEM_GPU_INDEX:-0}"
export FULLMAG_FDM_GPU_INDEX="${FULLMAG_FDM_GPU_INDEX:-${FULLMAG_FEM_GPU_INDEX}}"
exec "${SELF_DIR}/fullmag-fem-gpu-bin" "$@"
EOF

chmod +x "${RUNTIME_ROOT}/bin/fullmag-fem-gpu"

cat > "${RUNTIME_ROOT}/README.md" <<EOF
# FEM GPU host runtime bundle

This directory contains a host-usable runtime bundle exported from the managed \`fem-gpu\` build
container.

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
