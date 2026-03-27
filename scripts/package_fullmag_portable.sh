#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_ROOT="${REPO_ROOT}/.fullmag/dist"
BUNDLE_NAME="fullmag-linux-x86_64-portable"
BUNDLE_ROOT="${DIST_ROOT}/${BUNDLE_NAME}"
TARBALL_PATH="${DIST_ROOT}/${BUNDLE_NAME}.tar.zst"
PATCHELF_BIN="${PATCHELF:-$(command -v patchelf)}"

require_file() {
  local path="$1"
  [[ -e "$path" ]] || {
    echo "Missing required path: $path" >&2
    exit 1
  }
}

copy_cuda_runtime_libs() {
  local dst_lib="$1"
  shift
  local search_dirs=(
    /usr/local/cuda/lib64
    /usr/local/cuda/targets/x86_64-linux/lib
  )

  for pattern in "$@"; do
    local copied_pattern=0
    for search_dir in "${search_dirs[@]}"; do
      if compgen -G "${search_dir}/${pattern}" >/dev/null; then
        cp -a "${search_dir}"/${pattern} "$dst_lib"/
        copied_pattern=1
        break
      fi
    done
    if [[ "$copied_pattern" -eq 0 ]]; then
      echo "Missing required CUDA runtime library pattern: ${pattern}" >&2
      exit 1
    fi
  done
}

copy_library_chain() {
  local src="$1"
  local dst_dir="$2"
  local src_dir
  local src_base
  local stem

  src_dir="$(dirname "$src")"
  src_base="$(basename "$src")"
  if [[ "$src_base" == *.so* ]]; then
    stem="${src_base%%.so*}.so"
    cp -a "${src_dir}"/${stem}* "$dst_dir"/ 2>/dev/null || cp -a "$src" "$dst_dir"/
  else
    cp -a "$src" "$dst_dir"/
  fi
}

copy_python_host_link_deps() {
  local dst_lib="$1"
  shift
  local dep
  while IFS= read -r dep; do
    [[ -n "$dep" ]] || continue
    copy_library_chain "$dep" "$dst_lib"
  done < <(
    for path in "$@"; do
      [[ -e "$path" ]] || continue
      ldd "$path" 2>/dev/null | awk '/=>/ {print $3}'
    done | rg "^${PY_BASE_PREFIX}/" | sort -u
  )
}

assemble_python_runtime() {
  local dst_root="$1"
  local dst_site_packages="${dst_root}/lib/python${PY_VERSION}/site-packages"
  local python_files=()
  local file

  mkdir -p "${dst_root}/bin" "${dst_root}/lib/python${PY_VERSION}"
  cp -a "${PY_REAL_EXE}" "${dst_root}/bin/python${PY_VERSION}"
  ln -s "python${PY_VERSION}" "${dst_root}/bin/python3"
  ln -s python3 "${dst_root}/bin/python"

  tar --exclude='site-packages' --exclude='__pycache__' -C "${PY_BASE_PREFIX}/lib" -cf - "python${PY_VERSION}" \
    | tar -C "${dst_root}/lib" -xf -
  mkdir -p "${dst_site_packages}"
  tar --exclude='__pycache__' -C "${REPO_ROOT}/.fullmag/local/python/lib/python${PY_VERSION}" -cf - site-packages \
    | tar -C "${dst_root}/lib/python${PY_VERSION}" -xf -

  if compgen -G "${PY_BASE_PREFIX}/lib/libpython${PY_VERSION}.so*" >/dev/null; then
    cp -a "${PY_BASE_PREFIX}"/lib/libpython${PY_VERSION}.so* "${dst_root}/lib/"
  fi
  if compgen -G "${PY_BASE_PREFIX}/lib/libgmsh.so*" >/dev/null; then
    cp -a "${PY_BASE_PREFIX}"/lib/libgmsh.so* "${dst_root}/lib/python${PY_VERSION}/"
  fi

  while IFS= read -r file; do
    python_files+=("$file")
  done < <(
    find \
      "${dst_root}/bin" \
      "${dst_root}/lib/python${PY_VERSION}" \
      -type f \
      \( -name '*.so' -o -name "python${PY_VERSION}" \) \
      2>/dev/null
  )

  if [[ ${#python_files[@]} -gt 0 ]]; then
    copy_python_host_link_deps "${dst_root}/lib" "${python_files[@]}"
  fi
}

write_wrapper() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="$(cd "${SELF_DIR}/.." && pwd)"
export FULLMAG_REPO_ROOT="${INSTALL_ROOT}"
export FULLMAG_PYTHON="${INSTALL_ROOT}/python/bin/python"
export PYTHONHOME="${INSTALL_ROOT}/python"
export PYTHONNOUSERSITE=1
export LD_LIBRARY_PATH="${INSTALL_ROOT}/python/lib:${INSTALL_ROOT}/python/lib/python__PY_VERSION__:${INSTALL_ROOT}/python/lib/python__PY_VERSION__/site-packages/numpy.libs${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
export PYTHONPATH="${INSTALL_ROOT}/packages/fullmag-py/src${PYTHONPATH:+:${PYTHONPATH}}"
export FULLMAG_FEM_MESH_CACHE_DIR="${INSTALL_ROOT}/.fullmag/local/cache/fem_mesh_assets"
exec "${SELF_DIR}/fullmag-bin" "$@"
EOF
  sed -i "s/__PY_VERSION__/${PY_VERSION}/g" "$path"
  chmod +x "$path"
}

write_version_metadata() {
  local version_json="$1"
  local git_sha
  local git_short
  local build_time
  git_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  git_short="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat >"$version_json" <<EOF
{
  "product": "fullmag",
  "artifact": "${BUNDLE_NAME}",
  "preproduction": true,
  "git_sha": "${git_sha}",
  "git_short": "${git_short}",
  "built_at_utc": "${build_time}"
}
EOF
}

write_runtime_manifests() {
  mkdir -p "${BUNDLE_ROOT}/runtimes/cpu-reference" "${BUNDLE_ROOT}/runtimes/fdm-cuda"

  cat > "${BUNDLE_ROOT}/runtimes/cpu-reference/manifest.json" <<'EOF'
{
  "family": "cpu-reference",
  "version": "0.1.0-preprod",
  "worker": "../../bin/fullmag-bin",
  "engines": [
    {
      "backend": "fdm",
      "device": "cpu",
      "mode": "strict",
      "precision": "double",
      "public": true
    },
    {
      "backend": "fem",
      "device": "cpu",
      "mode": "strict",
      "precision": "double",
      "public": true
    }
  ]
}
EOF

  mkdir -p "${BUNDLE_ROOT}/runtimes/fdm-cuda/bin"
  ln -s ../../lib "${BUNDLE_ROOT}/runtimes/fdm-cuda/lib"
  cp -a "${BUNDLE_ROOT}/bin/fullmag-bin" "${BUNDLE_ROOT}/runtimes/fdm-cuda/bin/fullmag-fdm-cuda-bin"
  "$PATCHELF_BIN" --set-rpath '$ORIGIN/../lib:$ORIGIN/../../../lib' \
    "${BUNDLE_ROOT}/runtimes/fdm-cuda/bin/fullmag-fdm-cuda-bin"

  cat > "${BUNDLE_ROOT}/runtimes/fdm-cuda/manifest.json" <<'EOF'
{
  "family": "fdm-cuda",
  "version": "0.1.0-preprod",
  "worker": "bin/fullmag-fdm-cuda-bin",
  "engines": [
    {
      "backend": "fdm",
      "device": "gpu",
      "mode": "strict",
      "precision": "double",
      "public": true
    },
    {
      "backend": "fdm",
      "device": "gpu",
      "mode": "strict",
      "precision": "single",
      "public": false
    }
  ]
}
EOF

  if [[ -x "${REPO_ROOT}/.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu-bin" ]]; then
    mkdir -p "${BUNDLE_ROOT}/runtimes/fem-gpu"
    cp -a "${REPO_ROOT}/.fullmag/runtimes/fem-gpu-host/." "${BUNDLE_ROOT}/runtimes/fem-gpu/"
    copy_cuda_runtime_libs "${BUNDLE_ROOT}/runtimes/fem-gpu/lib" \
      libcudart.so* libcufft.so* libcusparse.so* libnvJitLink.so*
    find "${BUNDLE_ROOT}/runtimes/fem-gpu/lib" -maxdepth 1 \( -name '*.so' -o -name '*.so.*' \) -type f \
      -exec "$PATCHELF_BIN" --set-rpath '$ORIGIN' {} \;
    "$PATCHELF_BIN" --set-rpath '$ORIGIN/../lib' \
      "${BUNDLE_ROOT}/runtimes/fem-gpu/bin/fullmag-fem-gpu-bin"
    cat > "${BUNDLE_ROOT}/runtimes/fem-gpu/manifest.json" <<'EOF'
{
  "family": "fem-gpu",
  "version": "0.1.0-preprod",
  "worker": "bin/fullmag-fem-gpu-bin",
  "engines": [
    {
      "backend": "fem",
      "device": "gpu",
      "mode": "strict",
      "precision": "double",
      "public": false
    }
  ]
}
EOF
  fi
}

require_file "${REPO_ROOT}/.fullmag/local/bin/fullmag-bin"
require_file "${REPO_ROOT}/.fullmag/local/bin/fullmag-api"
require_file "${REPO_ROOT}/.fullmag/local/lib/libfullmag_fdm.so.0"
require_file "${REPO_ROOT}/.fullmag/local/web/index.html"
require_file "${REPO_ROOT}/.fullmag/local/python/bin/python"
require_file "${REPO_ROOT}/packages/fullmag-py/src/fullmag/__init__.py"
require_file "${REPO_ROOT}/examples/exchange_relax.py"

mapfile -t PY_RUNTIME_META < <(
  "${REPO_ROOT}/.fullmag/local/python/bin/python" - <<'PY'
import sys
from pathlib import Path
print(sys.base_prefix)
print(f"{sys.version_info.major}.{sys.version_info.minor}")
print(Path(sys.executable).resolve())
PY
)

PY_BASE_PREFIX="${PY_RUNTIME_META[0]}"
PY_VERSION="${PY_RUNTIME_META[1]}"
PY_REAL_EXE="${PY_RUNTIME_META[2]}"

mkdir -p "$DIST_ROOT"
rm -rf "$BUNDLE_ROOT"
mkdir -p \
  "${BUNDLE_ROOT}/bin" \
  "${BUNDLE_ROOT}/lib" \
  "${BUNDLE_ROOT}/packages/fullmag-py" \
  "${BUNDLE_ROOT}/runtimes" \
  "${BUNDLE_ROOT}/share/licenses" \
  "${BUNDLE_ROOT}/.fullmag/local" \
  "${BUNDLE_ROOT}/.fullmag/local/cache/fem_mesh_assets"

cp -a "${REPO_ROOT}/.fullmag/local/bin/fullmag-bin" "${BUNDLE_ROOT}/bin/"
cp -a "${REPO_ROOT}/.fullmag/local/bin/fullmag-api" "${BUNDLE_ROOT}/bin/"
cp -a "${REPO_ROOT}/.fullmag/local/lib/." "${BUNDLE_ROOT}/lib/"
copy_cuda_runtime_libs "${BUNDLE_ROOT}/lib" libcudart.so* libcufft.so*
cp -a "${REPO_ROOT}/.fullmag/local/web" "${BUNDLE_ROOT}/web"
assemble_python_runtime "${BUNDLE_ROOT}/python"
mkdir -p "${BUNDLE_ROOT}/packages/fullmag-py/src"
tar --exclude='__pycache__' -C "${REPO_ROOT}/packages/fullmag-py" -cf - src \
  | tar -C "${BUNDLE_ROOT}/packages/fullmag-py" -xf -
cp -a "${REPO_ROOT}/examples" "${BUNDLE_ROOT}/examples"

ln -s ../../web "${BUNDLE_ROOT}/.fullmag/local/web"
ln -s ../../python "${BUNDLE_ROOT}/.fullmag/local/python"

write_wrapper "${BUNDLE_ROOT}/bin/fullmag"
write_version_metadata "${BUNDLE_ROOT}/share/version.json"
write_runtime_manifests

cat > "${BUNDLE_ROOT}/share/licenses/README.md" <<'EOF'
Third-party license aggregation is not bundled yet in this preproduction artifact.
This bundle is for internal validation of the portable Fullmag layout.
EOF

cat > "${BUNDLE_ROOT}/README.md" <<'EOF'
# Fullmag Portable Preproduction Bundle

This is a preproduction portable bundle intended to validate the install layout and runtime
resolution path.

Run from the unpacked bundle root with:

```bash
export PATH="$PWD/bin:$PATH"
fullmag share/smoke_quick.py --headless --json
```

Current known limitation:

- the bundled Python runtime is assembled from the local build host's CPython base and has not yet
  been qualified on a clean machine outside this environment.
EOF

cat > "${BUNDLE_ROOT}/share/smoke_quick.py" <<'EOF'
import fullmag as fm

DEFAULT_UNTIL = 2e-13


def build() -> fm.Problem:
    box = fm.Box(size=(16e-9, 8e-9, 4e-9), name="smoke_box")
    mat = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.5)
    magnet = fm.Ferromagnet(
        name="smoke_box",
        geometry=box,
        material=mat,
        m0=fm.init.random(seed=1),
    )

    return fm.Problem(
        name="smoke_quick",
        magnets=[magnet],
        energy=[fm.Exchange()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(integrator="heun", fixed_timestep=1e-13),
            outputs=[fm.SaveScalar("E_ex", every=1e-13)],
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(4e-9, 4e-9, 4e-9)),
        ),
    )


if __name__ == "__main__":
    fm.Simulation(build(), backend="fdm").run(until=DEFAULT_UNTIL)
else:
    problem = build()
EOF

"$PATCHELF_BIN" --set-rpath '$ORIGIN/../lib' "${BUNDLE_ROOT}/bin/fullmag-bin"
"$PATCHELF_BIN" --set-rpath '$ORIGIN/../lib' "${BUNDLE_ROOT}/bin/fullmag-api"
find "${BUNDLE_ROOT}/lib" -maxdepth 1 \( -name '*.so' -o -name '*.so.*' \) -type f \
  -exec "$PATCHELF_BIN" --set-rpath '$ORIGIN' {} \;

"${REPO_ROOT}/scripts/validate_portable_bundle.sh" "${BUNDLE_ROOT}" \
  | tee "${BUNDLE_ROOT}/share/validation.txt"

rm -f "$TARBALL_PATH"
if tar --help 2>/dev/null | grep -q -- '--zstd' && command -v zstd >/dev/null 2>&1; then
  tar --zstd -cf "$TARBALL_PATH" -C "$DIST_ROOT" "$BUNDLE_NAME"
  echo "Created portable tarball:"
  echo "  ${TARBALL_PATH}"
else
  echo "Skipped tar.zst creation because tar --zstd or zstd is unavailable." >&2
fi

echo "Created portable bundle:"
echo "  ${BUNDLE_ROOT}"
