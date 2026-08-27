#!/usr/bin/env bash

resolve_managed_fem_build_policy() {
  local profile="${FULLMAG_NATIVE_STORAGE_PROFILE:-canonical}"
  case "${profile}" in
    canonical|local-d) ;;
    *)
      echo "[managed_fem_build_policy] unsupported FULLMAG_NATIVE_STORAGE_PROFILE: ${profile}" >&2
      return 2
      ;;
  esac

  if [ "${FULLMAG_FEM_RUNTIME_REUSE_BUILD+x}" != "x" ]; then
    case "${profile}" in
      canonical) FULLMAG_FEM_RUNTIME_REUSE_BUILD=0 ;;
      local-d) FULLMAG_FEM_RUNTIME_REUSE_BUILD=1 ;;
    esac
  fi

  case "${FULLMAG_FEM_RUNTIME_REUSE_BUILD}" in
    0|1) ;;
    *)
      echo "[managed_fem_build_policy] FULLMAG_FEM_RUNTIME_REUSE_BUILD must be 0 or 1" >&2
      return 2
      ;;
  esac
  export FULLMAG_FEM_RUNTIME_REUSE_BUILD
}
