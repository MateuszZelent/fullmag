#!/usr/bin/env bash

_reject_managed_fem_report_symlink_ancestors() {
  local candidate="$1"
  local current="$candidate"
  while [ "$current" != "/" ]; do
    if [ -L "$current" ]; then
      echo "[managed_fem_report_storage] report path ancestor must not be a symlink: $current" >&2
      return 2
    fi
    current="$(dirname -- "$current")"
  done
}

validate_managed_fem_report_path() {
  local durable_root="$1"
  local report_base="$2"
  if [[ "$durable_root" != /* ]] || [[ "$report_base" != /* ]]; then
    echo "[managed_fem_report_storage] durable root and report base must be absolute" >&2
    return 2
  fi
  _reject_managed_fem_report_symlink_ancestors "$durable_root" || return
  _reject_managed_fem_report_symlink_ancestors "$report_base" || return
  local canonical_durable canonical_report
  canonical_durable="$(realpath -m -- "$durable_root")" || return 2
  canonical_report="$(realpath -m -- "$report_base")" || return 2
  case "$canonical_report/" in
    "$canonical_durable/"*) ;;
    *)
      echo "[managed_fem_report_storage] report base must be contained by durable root: $canonical_report" >&2
      return 2
      ;;
  esac
  if [ "$canonical_report" = "$canonical_durable" ]; then
    echo "[managed_fem_report_storage] report base must not equal durable root" >&2
    return 2
  fi
  printf '%s\n%s\n' "$canonical_durable" "$canonical_report"
}

create_managed_fem_report_run_root() {
  local durable_root="$1"
  local report_base="$2"
  local expected_backing_image="$3"
  local loop_sysfs_root="$4"
  local validated canonical_durable canonical_report
  validated="$(validate_managed_fem_report_path "$durable_root" "$report_base")" || return
  canonical_durable="$(printf '%s\n' "$validated" | sed -n '1p')"
  canonical_report="$(printf '%s\n' "$validated" | sed -n '2p')"
  validate_managed_fem_runtime_storage_target \
    "$canonical_durable" "$expected_backing_image" "$loop_sysfs_root" || return
  mkdir -p -- "$canonical_report/runs" || return 2
  _reject_managed_fem_report_symlink_ancestors "$canonical_report/runs" || return
  mktemp -d "$canonical_report/runs/run.XXXXXXXX"
}
