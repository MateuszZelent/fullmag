#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${REPO_ROOT}/.fullmag/runtimes/fem-gpu-host"

mkdir -p "${RUNTIME_ROOT}/bin" "${RUNTIME_ROOT}/lib"

cd "${REPO_ROOT}"

docker compose --profile fem-gpu run --rm -T fem-gpu bash -lc '
set -euo pipefail
mkdir -p .fullmag/runtimes/fem-gpu-host/bin .fullmag/runtimes/fem-gpu-host/lib
cargo +nightly clean -p fullmag-fdm-demag >/dev/null 2>&1 || true
FULLMAG_USE_MFEM_STACK=ON cargo +nightly build -p fullmag-cli --features "cuda fem-gpu" --release >/tmp/fullmag-build.log
tmp_bin=.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu-bin.tmp
cp target/release/fullmag "$tmp_bin"
mv -f "$tmp_bin" .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu-bin
FEM_LIB=$(dirname "$(find target/release/build -path "*fullmag-fem-sys*/out/native-build/backends/fem/libfullmag_fem.so.0" | head -n1)")
FDM_LIB=$(dirname "$(find target/release/build -path "*fullmag-fdm-sys*/out/native-build/backends/fdm/libfullmag_fdm.so.0" | head -n1)")
cp -a "$FEM_LIB"/libfullmag_fem.so* .fullmag/runtimes/fem-gpu-host/lib/
cp -a "$FDM_LIB"/libfullmag_fdm.so* .fullmag/runtimes/fem-gpu-host/lib/
cp -a /opt/fullmag-deps/lib/* .fullmag/runtimes/fem-gpu-host/lib/
'

cat > "${RUNTIME_ROOT}/bin/fullmag-fem-gpu" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_ROOT="$(cd "${SELF_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RUNTIME_ROOT}/../.." && pwd)"
export FULLMAG_REPO_ROOT="${REPO_ROOT}"
export LD_LIBRARY_PATH="${RUNTIME_ROOT}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
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
