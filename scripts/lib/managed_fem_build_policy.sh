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
      local git_config_count
      local git_config_key_var
      local git_config_value_var
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

      # The Windows checkout is populated with core.autocrlf=true and without
      # executable-bit tracking. WSL Git does not read Git for Windows' system
      # configuration, while DrvFS reports regular files as executable. Bind
      # both checkout semantics explicitly for every child Git invocation so
      # source identity does not turn a clean Windows worktree into an all-file
      # CRLF/filemode dirty snapshot.
      git_config_count="${GIT_CONFIG_COUNT:-0}"
      if ! [[ "${git_config_count}" =~ ^[0-9]+$ ]]; then
        echo "[managed_fem_build_policy] GIT_CONFIG_COUNT must be a non-negative integer" >&2
        return 2
      fi
      git_config_key_var="GIT_CONFIG_KEY_${git_config_count}"
      git_config_value_var="GIT_CONFIG_VALUE_${git_config_count}"
      printf -v "${git_config_key_var}" '%s' core.autocrlf
      printf -v "${git_config_value_var}" '%s' true
      export "${git_config_key_var}" "${git_config_value_var}"
      git_config_count=$((git_config_count + 1))
      git_config_key_var="GIT_CONFIG_KEY_${git_config_count}"
      git_config_value_var="GIT_CONFIG_VALUE_${git_config_count}"
      printf -v "${git_config_key_var}" '%s' core.filemode
      printf -v "${git_config_value_var}" '%s' false
      export "${git_config_key_var}" "${git_config_value_var}"
      export GIT_CONFIG_COUNT=$((git_config_count + 1))
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
