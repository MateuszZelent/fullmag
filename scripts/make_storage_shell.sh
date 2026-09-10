#!/usr/bin/env bash
# Make's recipe shell boundary for Fullmag project storage.
#
# GNU Make starts a fresh shell for each recipe unless .ONESHELL is used.  A
# target-only prerequisite cannot export the resolver environment, so each
# recipe body is resolved and executed through the same core runner instead.
set -euo pipefail

if [ "$#" -ne 2 ] || [ "$1" != "-c" ]; then
  echo "[fullmag make] expected '-c <recipe body>'" >&2
  exit 2
fi

recipe="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
resolver="${repo_root}/scripts/fullmag_storage.py"
python_cmd=""
if command -v python3 >/dev/null 2>&1; then
  python_cmd="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  python_cmd="$(command -v python)"
else
  echo "[fullmag make] Python is required for the storage resolver" >&2
  exit 2
fi

if [ ! -f "${resolver}" ]; then
  echo "[fullmag make] common storage resolver is missing: ${resolver}" >&2
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

# Read-only resolver targets remain usable before initialization.
if [[ "${recipe}" == *"fullmag_storage.py"* &&
      "${recipe}" != *"--create"* &&
      "${recipe}" != *"prepare-links"* &&
      "${recipe}" != *" run "* &&
      "${recipe}" != *" register "* &&
      "${recipe}" != *" finish "* ]]; then
  FULLMAG_STORAGE_PYTHON="${python_cmd}" exec bash -euo pipefail -c "${recipe}"
fi

# The PowerShell launchers already resolve their lane-specific Windows
# profile and lock the complete process through the managed entrypoint.
if is_windows_shell; then
  case "${recipe}" in
    *"scripts/windows/run_fullmag.ps1"*|*"scripts/windows/run_fullmag_fem.ps1"*|*"scripts/windows/run_fullmag_wsl.ps1"*|*"scripts/windows/setup_fullmag.ps1"*|*"scripts/windows/verify_fem_frequency_domain_native_contract.ps1"*|*"scripts/windows/build_windows_msi.ps1"*)
      exec bash -euo pipefail -c "${recipe}"
      ;;
  esac
fi

# Do not allow a legacy Make recipe to write to an unowned temporary tree.
case "${recipe}" in
  *"/tmp/fullmag-"*|*"/tmp/fullmag/"*|*"native/build"*)
    echo "[fullmag make] unsupported legacy storage path in recipe; use resolver-provided build/cache paths" >&2
    exit 2
    ;;
esac

# The Windows FEM launcher resolves and locks the host storage before it
# starts Docker, then bind-mounts the resolved build/cache/runtime roots into
# this Linux container.  Re-running the shared resolver here would read the
# Windows host .env from /workspace and feed C:/... to the Linux resolver.
# That is both the wrong namespace and a second, impossible-to-share lock.
# Keep this escape hatch narrow: only the Windows launcher sets the sentinel,
# and the target directory must be inside its managed build bind mount.
if ! is_windows_shell && [[ "${FULLMAG_WINDOWS_CONTAINER_MANAGED:-0}" == "1" ]]; then
  container_target="${FULLMAG_CARGO_TARGET_DIR:-}"
  case "${container_target}" in
    /workspace/.fullmag-build/cargo-targets/*) ;;
    *)
      echo "[fullmag make] Windows FEM container target is missing or outside /workspace/.fullmag-build/cargo-targets: ${container_target}" >&2
      exit 2
      ;;
  esac
  if [[ "${CARGO_TARGET_DIR:-}" != "${container_target}" ]]; then
    echo "[fullmag make] CARGO_TARGET_DIR must match FULLMAG_CARGO_TARGET_DIR in the managed Windows FEM container" >&2
    exit 2
  fi
  exec bash -euo pipefail -c "${recipe}"
fi

prepare_args=(--compat)
case "${recipe}" in
  *"apps/control-room"*|*"WEB_APP_DIR"*|*"pnpm"*) prepare_args+=(--frontend) ;;
esac
"${python_cmd}" "${resolver}" prepare-links --repo-root "${repo_root}" "${prepare_args[@]}" >/dev/null

exec "${python_cmd}" "${resolver}" run --repo-root "${repo_root}" -- \
  bash -euo pipefail -c "${recipe}"
