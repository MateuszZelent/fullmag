#!/usr/bin/env bash

resolve_managed_fem_native_storage() {
  local repo_root="${FULLMAG_REPO_ROOT:-${PWD}}"
  local helper_dir
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  # The Python resolver is the policy authority.  A real checkout containing
  # it must fail closed when resolution fails; copied legacy fixtures without
  # the resolver retain only the old read-only profile lookup below.
  if ! declare -F resolve_managed_fem_project_storage >/dev/null 2>&1 &&
     [ -f "${helper_dir}/managed_fem_build_policy.sh" ]; then
    # shellcheck disable=SC1091
    source "${helper_dir}/managed_fem_build_policy.sh"
  fi
  if [ -f "${repo_root}/scripts/fullmag_storage.py" ]; then
    if ! declare -F resolve_managed_fem_project_storage >/dev/null 2>&1 ||
       ! resolve_managed_fem_project_storage "${repo_root}"; then
      echo "[managed_fem_native_storage] common storage resolver failed for: ${repo_root}" >&2
      return 2
    fi
    FULLMAG_NATIVE_BUILD_STORAGE_ROOT="${FULLMAG_BUILD_STORAGE_ROOT}"
    export FULLMAG_NATIVE_BUILD_STORAGE_ROOT
    return 0
  fi

  local profile="${FULLMAG_NATIVE_STORAGE_PROFILE:-canonical}"

  case "${profile}" in
    canonical)
      FULLMAG_NATIVE_BUILD_STORAGE_ROOT="/zfn2/mateuszz/git/fullmag"
      FULLMAG_NATIVE_BUILD_IMAGE="${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}/build-volumes/fullmag-native.ext4"
      ;;
    native-2)
      FULLMAG_NATIVE_BUILD_STORAGE_ROOT="/zfn2/mateuszz/git/fullmag"
      FULLMAG_NATIVE_BUILD_IMAGE="${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}/build-volumes/fullmag-native-2.ext4"
      ;;
    local-d)
      FULLMAG_NATIVE_BUILD_STORAGE_ROOT="/mnt/d/git/fullmag"
      FULLMAG_NATIVE_BUILD_IMAGE="${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}/fullmag-native.ext4"
      ;;
    *)
      echo "[managed_fem_native_storage] unsupported FULLMAG_NATIVE_STORAGE_PROFILE: ${profile} (expected canonical, native-2, or local-d)" >&2
      return 2
      ;;
  esac

  FULLMAG_NATIVE_MOUNT_VIEW="/mnt/fullmag-zfn2-native"
}
