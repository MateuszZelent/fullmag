#!/usr/bin/env bash

resolve_managed_fem_native_storage() {
  local profile="${FULLMAG_NATIVE_STORAGE_PROFILE:-canonical}"

  case "${profile}" in
    canonical)
      FULLMAG_NATIVE_BUILD_STORAGE_ROOT="/zfn2/mateuszz/git/fullmag"
      FULLMAG_NATIVE_BUILD_IMAGE="${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}/build-volumes/fullmag-native.ext4"
      ;;
    local-d)
      FULLMAG_NATIVE_BUILD_STORAGE_ROOT="/mnt/d/git/fullmag"
      FULLMAG_NATIVE_BUILD_IMAGE="${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}/fullmag-native.ext4"
      ;;
    *)
      echo "[managed_fem_native_storage] unsupported FULLMAG_NATIVE_STORAGE_PROFILE: ${profile} (expected canonical or local-d)" >&2
      return 2
      ;;
  esac

  FULLMAG_NATIVE_MOUNT_VIEW="/mnt/fullmag-zfn2-native"
}
