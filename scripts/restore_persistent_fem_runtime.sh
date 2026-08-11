#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${REPO_ROOT}/scripts/lib/managed_fem_runtime_storage.sh"
resolve_managed_fem_runtime_storage_layout
readonly FULLMAG_NATIVE_BUILD_STORAGE_ROOT FULLMAG_NATIVE_BUILD_IMAGE
readonly FULLMAG_NATIVE_MOUNT_VIEW FULLMAG_PERSISTENT_RUNTIME_PARENT
archive="${FULLMAG_PERSISTENT_RUNTIME_PARENT}/fem-gpu-host-latest.tar"
runtime_parent="${REPO_ROOT}/.fullmag/runtimes"
worktree_slug="$(basename "${REPO_ROOT}" | sed 's/[^A-Za-z0-9._-]/-/g')"
worktree_digest="$(printf '%s' "${REPO_ROOT}" | sha256sum | cut -c1-64)"
FULLMAG_RUNTIME_VARIANTS_ROOT="${FULLMAG_NATIVE_MOUNT_VIEW}/managed-fem-runtime/${worktree_slug}-${worktree_digest}/runtime-variants"
readonly FULLMAG_RUNTIME_VARIANTS_ROOT
variants_alias_retarget_from=""
if [ "${FULLMAG_MANAGED_FEM_STORAGE_ROOT_EXPLICIT}" = "1" ] &&
   [ "${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}" != "${MANAGED_FEM_CANONICAL_STORAGE_ROOT}" ]; then
  variants_alias_retarget_from="${MANAGED_FEM_CANONICAL_MOUNT_VIEW}/managed-fem-runtime/${worktree_slug}-${worktree_digest}/runtime-variants"
fi
readonly variants_alias_retarget_from
: "${FULLMAG_LOOP_SYSFS_ROOT:=/sys/class/block}"
staging="${FULLMAG_RUNTIME_VARIANTS_ROOT}/fem-gpu-host.restore.$$"

print_storage_mount_guidance() {
  echo "Selected durable build-storage root: ${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}" >&2
  echo "Expected native ext4 backing image: ${FULLMAG_NATIVE_BUILD_IMAGE}" >&2
  echo "Docker-bindable mount view: ${FULLMAG_NATIVE_MOUNT_VIEW}" >&2
  if [ "${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}" != "${MANAGED_FEM_CANONICAL_STORAGE_ROOT}" ]; then
    echo "Direct 9p cannot be used as the managed FEM build target; it stores the durable image and runtime archives only." >&2
    echo "Provision an ext4 image at the expected path; the restore script will not create or format it automatically." >&2
    echo "Create the Linux mount point from Windows with:" >&2
    echo "  wsl.exe -d Ubuntu2 -u root -- mkdir -p ${FULLMAG_NATIVE_MOUNT_VIEW}" >&2
  fi
  echo "Mount the selected image from Windows with:" >&2
  echo "  wsl.exe -d Ubuntu2 -u root -- mount -o loop,rw,noatime ${FULLMAG_NATIVE_BUILD_IMAGE} ${FULLMAG_NATIVE_MOUNT_VIEW}" >&2
}

validate_managed_fem_runtime_storage_layout print_storage_mount_guidance
[ -f "${archive}" ] || {
  echo "persistent managed FEM runtime archive is missing: ${archive}" >&2
  exit 1
}
validate_managed_fem_runtime_storage_target \
  "${FULLMAG_RUNTIME_VARIANTS_ROOT}" \
  "${FULLMAG_NATIVE_BUILD_IMAGE}" \
  "${FULLMAG_LOOP_SYSFS_ROOT}" \
  print_storage_mount_guidance
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
publish_managed_fem_runtime_aliases "${variants_alias}" \
  "${FULLMAG_RUNTIME_VARIANTS_ROOT}" \
  "${REPO_ROOT}/scripts/validate_managed_fem_runtime_bundle.py" \
  "${variants_alias_retarget_from}" \
  "${runtime_parent}/fem-gpu-host" "${variant_name}"
echo "Restored managed FEM runtime from ${archive}"
