#!/usr/bin/env bash

resolve_managed_fem_build_policy() {
  local repo_root="${FULLMAG_REPO_ROOT:-${PWD}}"
  local gitdir_record=""
  if [ -f "${repo_root}/.git" ]; then
    gitdir_record="$(sed -n 's/^gitdir: //p' "${repo_root}/.git")"
  fi
  case "${gitdir_record}" in
    [A-Za-z]:/*)
      local drive
      local relative_gitdir
      local wsl_gitdir
      drive="$(printf '%s' "${gitdir_record%%:*}" | tr '[:upper:]' '[:lower:]')"
      relative_gitdir="${gitdir_record#?:/}"
      wsl_gitdir="/mnt/${drive}/${relative_gitdir}"
      if [ ! -d "${wsl_gitdir}" ]; then
        echo "[managed_fem_build_policy] Windows worktree gitdir is unavailable in WSL: ${wsl_gitdir}" >&2
        return 2
      fi
      export GIT_DIR="${wsl_gitdir}"
      export GIT_WORK_TREE="${repo_root}"
      ;;
  esac

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
