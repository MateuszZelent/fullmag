#!/usr/bin/env bash
# Run every just recipe through the project storage boundary.
#
# `just` starts one shell per recipe line by default.  A dependency-only
# preflight therefore cannot export CARGO_TARGET_DIR, TMPDIR, or the managed
# compatibility paths to the command that follows it.  This adapter is the
# shell boundary instead: resolve and prepare first, then run the complete
# recipe body in the same process environment.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "[fullmag just] expected the recipe body as the only shell argument" >&2
  exit 2
fi

is_windows_shell() {
  case "${OS:-}" in
    Windows_NT) return 0 ;;
  esac
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
  esac
  return 1
}

recipe="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
resolver="${repo_root}/scripts/fullmag_storage.py"
python_cmd=""
python_candidates=(python3 python)
if is_windows_shell; then
  python_candidates=(python python3)
fi
for python_candidate in "${python_candidates[@]}"; do
  if command -v "${python_candidate}" >/dev/null 2>&1; then
    python_cmd="$(command -v "${python_candidate}")"
    break
  fi
done
if [ -z "${python_cmd}" ]; then
  echo "[fullmag just] Python is required for the storage resolver" >&2
  exit 2
fi

if [ ! -f "${resolver}" ]; then
  echo "[fullmag just] common storage resolver is missing: ${resolver}" >&2
  exit 2
fi

# Python on Windows cannot resolve the POSIX `/usr/bin/bash` entry that Git
# Bash exposes in PATH. Pass an absolute Windows executable to the managed
# runner so nested recipe shells inherit the resolved storage environment.
bash_executable="bash"
if is_windows_shell && command -v cygpath >/dev/null 2>&1; then
  bash_path="$(command -v bash)"
  if [[ "${bash_path}" == /* ]]; then
    bash_executable="$(cygpath -w "${bash_path}")"
  fi
fi

# Read-only listing/help recipes must not create a storage marker or any
# compatibility path.  The resolver's own read-only actions can therefore be
# used for inspection even when the checkout has not been initialized yet.
if [[ "${recipe}" == *"fullmag_storage.py"* &&
      "${recipe}" != *"--create"* &&
      "${recipe}" != *"prepare-links"* &&
      "${recipe}" != *" run "* &&
      "${recipe}" != *" register "* &&
      "${recipe}" != *" finish "* ]]; then
  FULLMAG_STORAGE_PYTHON="${python_cmd}" exec "${bash_executable}" -euo pipefail -c "${recipe}"
fi
case "${recipe}" in
  *"just --list"*|*"just --list --"*) exec "${bash_executable}" -euo pipefail -c "${recipe}" ;;
esac

# The Windows PowerShell launchers select their own storage profile and hold
# the core lock through the managed entrypoint.  Letting the generic Linux /
# Windows-native preflight create links first would select the wrong profile.
if is_windows_shell; then
  case "${recipe}" in
    *"scripts/windows/run_fullmag.ps1"*|*"scripts/windows/run_fullmag_fem.ps1"*|*"scripts/windows/run_fullmag_wsl.ps1"*|*"scripts/windows/setup_fullmag.ps1"*|*"scripts/windows/verify_fem_frequency_domain_native_contract.ps1"*|*"scripts/windows/build_windows_msi.ps1"*)
      exec "${bash_executable}" -euo pipefail -c "${recipe}"
      ;;
  esac
fi

# These legacy bodies would write outside the resolver's approved roots.  Stop
# before prepare-links or any child process can mutate the checkout.  Recipes
# can be migrated by replacing the literal with the exported resolver value.
case "${recipe}" in
  *"/tmp/fullmag-"*|*"/tmp/fullmag/"*|*"native/build"*)
    echo "[fullmag just] unsupported legacy storage path in recipe; use resolver-provided build/cache paths" >&2
    exit 2
    ;;
esac

# Compatibility links are only created after all destinations and existing
# source paths have been validated by the resolver.  Existing real paths are
# intentionally rejected so a legacy build cannot be overwritten implicitly.
# Frontend recipes also need the managed node_modules/Next/output links; keep
# this detection in step with the Make shell boundary because `just` recipes
# do not share an exported environment with a separate prerequisite.
prepare_args=(--compat)
case "${recipe}" in
  *"apps/control-room"*|*"WEB_APP_DIR"*|*"pnpm"*) prepare_args+=(--frontend) ;;
esac
"${python_cmd}" "${resolver}" prepare-links --repo-root "${repo_root}" "${prepare_args[@]}" >/dev/null

# Run the complete recipe body through the core runner.  This is the lock
# boundary: the runner resolves the same environment and holds the per-
# worktree OS lock until every nested bash/docker/cargo command has finished.
# Its owner token is inherited by nested `just` calls, which are reentrant.
# Git Bash otherwise rewrites POSIX-looking bind targets before Docker Desktop
# sees them.  Install a shell-local wrapper so only Docker invocations disable
# that conversion; resolver/Python commands still receive normal Windows paths.
run_recipe="${recipe}"
if is_windows_shell && [[ "${recipe}" == *"docker compose"* ]]; then
  run_recipe='docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }; '"${recipe}"
fi
exec "${python_cmd}" "${resolver}" run --repo-root "${repo_root}" -- \
  "${bash_executable}" -euo pipefail -c "${run_recipe}"
