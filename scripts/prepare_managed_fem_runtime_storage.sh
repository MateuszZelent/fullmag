#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${REPO_ROOT}/scripts/lib/managed_fem_runtime_storage.sh"
resolve_managed_fem_runtime_storage_layout
readonly FULLMAG_MANAGED_FEM_STORAGE_ROOT_EXPLICIT
readonly FULLMAG_NATIVE_BUILD_STORAGE_ROOT FULLMAG_NATIVE_BUILD_IMAGE
readonly FULLMAG_NATIVE_MOUNT_VIEW FULLMAG_PERSISTENT_RUNTIME_PARENT

if [ "${FULLMAG_MANAGED_FEM_STORAGE_ROOT_EXPLICIT}" != "1" ]; then
  exit 0
fi

worktree_slug="$(basename "${REPO_ROOT}" | sed 's/[^A-Za-z0-9._-]/-/g')"
worktree_digest="$(printf '%s' "${REPO_ROOT}" | sha256sum | cut -c1-64)"
worktree_id="${worktree_slug}-${worktree_digest}"
runtime_variants_root="${FULLMAG_NATIVE_MOUNT_VIEW}/managed-fem-runtime/${worktree_id}/runtime-variants"
canonical_variants_root="${MANAGED_FEM_CANONICAL_MOUNT_VIEW}/managed-fem-runtime/${worktree_id}/runtime-variants"
variants_alias="${REPO_ROOT}/.fullmag/runtimes/fem-gpu-variants"
: "${FULLMAG_LOOP_SYSFS_ROOT:=/sys/class/block}"

print_storage_mount_guidance() {
  echo "Selected durable build-storage root: ${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}" >&2
  echo "Expected native ext4 backing image: ${FULLMAG_NATIVE_BUILD_IMAGE}" >&2
  echo "Docker-bindable mount view: ${FULLMAG_NATIVE_MOUNT_VIEW}" >&2
  if [ "${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}" != "${MANAGED_FEM_CANONICAL_STORAGE_ROOT}" ]; then
    echo "Direct 9p cannot be used as the managed FEM build target; it stores the durable image and runtime archives only." >&2
    echo "Provision an ext4 image at the expected path; the ensure preflight will not create or format it automatically." >&2
  fi
  echo "Mount the selected image from Windows with:" >&2
  echo "  wsl.exe -d Ubuntu2 -u root -- mount -o loop,rw,noatime ${FULLMAG_NATIVE_BUILD_IMAGE} ${FULLMAG_NATIVE_MOUNT_VIEW}" >&2
}

validate_managed_fem_runtime_storage_layout print_storage_mount_guidance
validate_managed_fem_runtime_storage_target \
  "${runtime_variants_root}" \
  "${FULLMAG_NATIVE_BUILD_IMAGE}" \
  "${FULLMAG_LOOP_SYSFS_ROOT}" \
  print_storage_mount_guidance

allowed_retarget_from=""
if [ "${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}" != "${MANAGED_FEM_CANONICAL_STORAGE_ROOT}" ]; then
  allowed_retarget_from="${canonical_variants_root}"
fi
select_managed_fem_runtime_variants_alias \
  "${variants_alias}" "${runtime_variants_root}" "${allowed_retarget_from}"
