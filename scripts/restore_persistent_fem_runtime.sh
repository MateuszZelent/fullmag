#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${REPO_ROOT}/scripts/lib/managed_fem_runtime_storage.sh"
resolve_managed_fem_native_storage_profile
readonly FULLMAG_NATIVE_STORAGE_PROFILE FULLMAG_NATIVE_BUILD_STORAGE_ROOT
readonly FULLMAG_NATIVE_BUILD_IMAGE FULLMAG_NATIVE_MOUNT_VIEW
: "${FULLMAG_BUILD_ROOT:=/zfn2/mateuszz/git/fullmag}"
archive="${FULLMAG_BUILD_ROOT}/runtimes/fem-gpu-host-latest.tar"
runtime_parent="${REPO_ROOT}/.fullmag/runtimes"
RUNTIME_LOCK="$(managed_fem_runtime_lock_path "${REPO_ROOT}")"
worktree_slug="$(basename "${REPO_ROOT}" | sed 's/[^A-Za-z0-9._-]/-/g')"
worktree_digest="$(printf '%s' "${REPO_ROOT}" | sha256sum | cut -c1-64)"
: "${FULLMAG_RUNTIME_VARIANTS_ROOT:=${FULLMAG_NATIVE_MOUNT_VIEW}/managed-fem-runtime/${worktree_slug}-${worktree_digest}/runtime-variants}"
: "${FULLMAG_LOOP_SYSFS_ROOT:=/sys/class/block}"
staging="${FULLMAG_RUNTIME_VARIANTS_ROOT}/fem-gpu-host.restore.$$"

mkdir -p "${runtime_parent}"
if [ "${FULLMAG_RUNTIME_EXPORT_LOCK_HELD:-0}" != "1" ]; then
  if ! flock -n --close "${RUNTIME_LOCK}" true; then
    echo "[restore_persistent_fem_runtime] waiting for existing runtime export or restore to finish"
  fi
  export FULLMAG_RUNTIME_EXPORT_LOCK_HELD=1
  exec flock --close "${RUNTIME_LOCK}" bash "$0" "$@"
fi

[ -f "${archive}" ] || exit 1
validate_managed_fem_runtime_storage_target \
  "${FULLMAG_RUNTIME_VARIANTS_ROOT}" \
  "${FULLMAG_NATIVE_BUILD_IMAGE}" \
  "${FULLMAG_LOOP_SYSFS_ROOT}"
trap 'rm -rf -- "${staging}"' EXIT
mkdir -p "${staging}" "${runtime_parent}"
tar -C "${staging}" -xf "${archive}"
python3 "${REPO_ROOT}/scripts/validate_managed_fem_runtime_bundle.py" \
  --runtime-root "${staging}" --allow-unaddressed-staging >/dev/null
variant="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["variant"])' "${staging}/manifest.json")"
manifest_sha256="$(sha256sum "${staging}/manifest.json" | awk '{print $1}')"
variant_name="${variant}-${manifest_sha256}"
variant_root="${FULLMAG_RUNTIME_VARIANTS_ROOT}/${variant_name}"
if [ -e "${variant_root}" ] || [ -L "${variant_root}" ]; then
  require_regular_contained_durable_variant \
    "${FULLMAG_RUNTIME_VARIANTS_ROOT}" "${variant_root}"
fi
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
variants_alias="${runtime_parent}/fem-gpu-variants"
prepare_managed_fem_runtime_variants_for_rebind "${variants_alias}" \
  "${FULLMAG_RUNTIME_VARIANTS_ROOT}" \
  "${REPO_ROOT}/scripts/validate_managed_fem_runtime_bundle.py"
rebind_managed_fem_runtime_aliases "${runtime_parent}/fem-gpu-host" \
  "${variants_alias}" "${FULLMAG_RUNTIME_VARIANTS_ROOT}" "${variant_root}" \
  "${REPO_ROOT}/scripts/validate_managed_fem_runtime_bundle.py"
echo "Restored managed FEM runtime from ${archive}"
