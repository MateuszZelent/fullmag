#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_PARENT="${FULLMAG_RUNTIME_PARENT:-${REPO_ROOT}/.fullmag/runtimes}"
PROC_ROOT="${FULLMAG_RUNTIME_PROC_ROOT:-/proc}"
KEEP_PER_FAMILY="${FULLMAG_RUNTIME_KEEP_PER_FAMILY:-2}"
KEEP_LEGACY="${FULLMAG_RUNTIME_KEEP_LEGACY:-0}"
# Destructive cleanup must always be opt-in.  The just recipe performs a
# review-only pass first and sets FULLMAG_RUNTIME_DRY_RUN=0 only for an
# explicit apply=1 invocation.  Keeping the script itself dry-run by default
# protects callers that invoke it directly (including CI maintenance jobs).
DRY_RUN="${FULLMAG_RUNTIME_DRY_RUN:-1}"

case "${KEEP_PER_FAMILY}" in
  ''|*[!0-9]*) echo "FULLMAG_RUNTIME_KEEP_PER_FAMILY must be a non-negative integer" >&2; exit 2 ;;
esac
case "${DRY_RUN}" in
  0|1) ;;
  *) echo "FULLMAG_RUNTIME_DRY_RUN must be 0 or 1" >&2; exit 2 ;;
esac
case "${KEEP_LEGACY}" in
  0|1) ;;
  *) echo "FULLMAG_RUNTIME_KEEP_LEGACY must be 0 or 1" >&2; exit 2 ;;
esac

if [ ! -d "${RUNTIME_PARENT}" ] || [ -L "${RUNTIME_PARENT}" ]; then
  echo "managed FEM runtime parent is missing or symlinked: ${RUNTIME_PARENT}" >&2
  exit 2
fi

ACTIVE_ALIAS="${RUNTIME_PARENT}/fem-gpu-host"
VARIANTS_ALIAS="${RUNTIME_PARENT}/fem-gpu-variants"
if [ ! -e "${ACTIVE_ALIAS}" ] || [ ! -L "${ACTIVE_ALIAS}" ]; then
  echo "managed FEM active runtime must be a symlink: ${ACTIVE_ALIAS}" >&2
  exit 2
fi
if [ ! -e "${VARIANTS_ALIAS}" ] || [ ! -d "${VARIANTS_ALIAS}" ]; then
  echo "managed FEM variants directory is missing: ${VARIANTS_ALIAS}" >&2
  exit 2
fi

ACTIVE_VARIANT="$(readlink -f "${ACTIVE_ALIAS}")"
VARIANTS_ROOT="$(readlink -f "${VARIANTS_ALIAS}")"
case "${ACTIVE_VARIANT}" in
  "${VARIANTS_ROOT}"/*) ;;
  *) echo "active managed FEM runtime escapes the variants directory: ${ACTIVE_VARIANT}" >&2; exit 2 ;;
esac

declare -A PROTECTED_ROOTS=()
declare -A FAMILY_COUNTS=()

mark_process_reference() {
  local raw_path="${1:-}"
  [ -n "${raw_path}" ] || return 0
  # Process command lines contain arbitrary paths from unrelated mounts. Do
  # not canonicalize those paths: a stale sshfs/FUSE mount can block
  # indefinitely and hold the managed-runtime export lock. Only runtime
  # paths can protect a managed variant, so reject everything else before
  # touching the filesystem.
  case "${raw_path}" in
    "${VARIANTS_ROOT}"/*|"${RUNTIME_PARENT}"/*) ;;
    *) return 0 ;;
  esac
  local resolved_path="${raw_path}"
  local relative variant_root
  case "${resolved_path}" in
    "${VARIANTS_ROOT}"/*)
      relative="${resolved_path#"${VARIANTS_ROOT}/"}"
      variant_root="${VARIANTS_ROOT}/${relative%%/*}"
      [ -d "${variant_root}" ] && [ ! -L "${variant_root}" ] && PROTECTED_ROOTS["${variant_root}"]=1
      ;;
    "${RUNTIME_PARENT}"/*)
      relative="${resolved_path#"${RUNTIME_PARENT}/"}"
      variant_root="${RUNTIME_PARENT}/${relative%%/*}"
      [ -d "${variant_root}" ] && [ ! -L "${variant_root}" ] && PROTECTED_ROOTS["${variant_root}"]=1
      ;;
  esac
  return 0
}

for process_dir in "${PROC_ROOT}"/[0-9]*; do
  [ -d "${process_dir}" ] || continue
  for process_link in exe cwd; do
    # Read only the symlink target here.  Resolving a process cwd/exe before
    # the runtime-path filter can block on an unrelated stale FUSE/SSHFS mount
    # and keep the export lock held indefinitely.
    mark_process_reference "$(readlink -- "${process_dir}/${process_link}" 2>/dev/null || true)"
  done
  if [ -r "${process_dir}/cmdline" ]; then
    while IFS= read -r -d '' argument; do
      mark_process_reference "${argument}"
    done < "${process_dir}/cmdline" 2>/dev/null || true
  fi
done
PROTECTED_ROOTS["${ACTIVE_VARIANT}"]=1

family_for_variant() {
  local name="$(basename "$1")"
  if [[ "${name}" =~ ^(.+)-[0-9a-f]{64}$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf '%s\n' "${name}"
  fi
}

is_unqualified_legacy_variant() {
  local variant_path="$1"
  local manifest_path="${variant_path}/manifest.json"
  [ -f "${manifest_path}" ] || return 1
  python3 - "${manifest_path}" <<'PY'
import json
import sys

try:
    manifest = json.loads(open(sys.argv[1], encoding="utf-8").read())
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)

schema = manifest.get("schema")
native_abi = manifest.get("native_abi")
raise SystemExit(0 if schema != 3 or not isinstance(native_abi, dict) else 1)
PY
}

remove_path() {
  local path="$1"
  local size
  size="$(du -sb -- "${path}" | awk '{print $1}')"
  if [ "${DRY_RUN}" = "1" ]; then
    echo "Would remove ${path} (${size} bytes)"
  else
    echo "Removing ${path} (${size} bytes)"
    if ! rm -rf -- "${path}"; then
      echo "Could not remove ${path}; permission denied or runtime is still busy" >&2
      return 1
    fi
  fi
}

removed_count=0
removed_bytes=0
failed_count=0
while IFS=$'\t' read -r _mtime variant_path; do
  [ -n "${variant_path}" ] || continue
  [ -d "${variant_path}" ] || continue
  [ -L "${variant_path}" ] && continue
  family="$(family_for_variant "${variant_path}")"
  if [ -n "${PROTECTED_ROOTS[${variant_path}]+x}" ]; then
    continue
  fi
  if [ "${KEEP_LEGACY}" = "0" ] && {
    [[ "${family}" == legacy-schema* ]] || is_unqualified_legacy_variant "${variant_path}";
  }; then
    size="$(du -sb -- "${variant_path}" | awk '{print $1}')"
    if remove_path "${variant_path}"; then
      removed_count=$((removed_count + 1))
      removed_bytes=$((removed_bytes + size))
    else
      failed_count=$((failed_count + 1))
    fi
    continue
  fi
  if [ "${FAMILY_COUNTS[${family}]:-0}" -lt "${KEEP_PER_FAMILY}" ]; then
    FAMILY_COUNTS["${family}"]=$(( ${FAMILY_COUNTS[${family}]:-0} + 1 ))
    continue
  fi
  size="$(du -sb -- "${variant_path}" | awk '{print $1}')"
  if remove_path "${variant_path}"; then
    removed_count=$((removed_count + 1))
    removed_bytes=$((removed_bytes + size))
  else
    failed_count=$((failed_count + 1))
  fi
done < <(
  for variant_path in "${VARIANTS_ROOT}"/*; do
    [ -d "${variant_path}" ] || continue
    [ -L "${variant_path}" ] && continue
    printf '%s\t%s\n' "$(stat -c '%Y' -- "${variant_path}")" "${variant_path}"
  done | sort -rn
)

for stale_path in \
  "${RUNTIME_PARENT}"/fem-gpu-host.staging.* \
  "${RUNTIME_PARENT}"/fem-gpu-host.partial-* \
  "${RUNTIME_PARENT}"/fem-gpu-host.directory-backup.*; do
  [ -e "${stale_path}" ] || [ -L "${stale_path}" ] || continue
  [ -n "${PROTECTED_ROOTS[${stale_path}]+x}" ] && continue
  size="$(du -sb -- "${stale_path}" | awk '{print $1}')"
  if remove_path "${stale_path}"; then
    removed_count=$((removed_count + 1))
    removed_bytes=$((removed_bytes + size))
  else
    failed_count=$((failed_count + 1))
  fi
done

if [ "${KEEP_LEGACY}" = "1" ]; then
  legacy_policy="retained"
else
  legacy_policy="removed"
fi
echo "Managed FEM runtime prune: removed ${removed_count} entries (${removed_bytes} bytes), ${failed_count} could not be removed; kept active/in-use runtimes, legacy/unqualified schema policy=${legacy_policy}, and ${KEEP_PER_FAMILY} newest variant(s) per family."
