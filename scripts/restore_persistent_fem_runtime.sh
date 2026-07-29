#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${FULLMAG_BUILD_ROOT:=/zfn2/mateuszz/git/fullmag}"
archive="${FULLMAG_BUILD_ROOT}/runtimes/fem-gpu-host-latest.tar"
runtime_parent="${REPO_ROOT}/.fullmag/runtimes"
staging="${runtime_parent}/fem-gpu-host.restore.$$"

[ -f "${archive}" ] || exit 1
trap 'rm -rf -- "${staging}"' EXIT
mkdir -p "${staging}" "${runtime_parent}/fem-gpu-variants"
tar -C "${staging}" -xf "${archive}"
python3 "${REPO_ROOT}/scripts/validate_managed_fem_runtime_bundle.py" \
  --runtime-root "${staging}" --allow-unaddressed-staging >/dev/null
variant="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["variant"])' "${staging}/manifest.json")"
manifest_sha256="$(sha256sum "${staging}/manifest.json" | awk '{print $1}')"
variant_name="${variant}-${manifest_sha256}"
variant_root="${runtime_parent}/fem-gpu-variants/${variant_name}"
if [ -e "${variant_root}" ] && \
   python3 "${REPO_ROOT}/scripts/validate_managed_fem_runtime_bundle.py" \
     --runtime-root "${variant_root}" >/dev/null 2>&1 && \
   python3 "${REPO_ROOT}/scripts/validate_managed_fem_runtime_bundle.py" \
     --runtime-root "${staging}" --compare-exact "${variant_root}" >/dev/null 2>&1; then
  rm -rf -- "${staging}"
elif [ -e "${variant_root}" ]; then
  backup="${variant_root}.restore-backup.$$"
  mv "${variant_root}" "${backup}"
  mv "${staging}" "${variant_root}"
  if ! python3 "${REPO_ROOT}/scripts/validate_managed_fem_runtime_bundle.py" \
    --runtime-root "${variant_root}" >/dev/null; then
    rm -rf -- "${variant_root}"
    mv "${backup}" "${variant_root}"
    exit 2
  fi
  rm -rf -- "${backup}"
else
  mv "${staging}" "${variant_root}"
fi
python3 "${REPO_ROOT}/scripts/validate_managed_fem_runtime_bundle.py" --runtime-root "${variant_root}" >/dev/null
next="${runtime_parent}/.fem-gpu-host.next.$$"
ln -sfn "fem-gpu-variants/${variant_name}" "${next}"
mv -Tf "${next}" "${runtime_parent}/fem-gpu-host"
echo "Restored managed FEM runtime from ${archive}"
