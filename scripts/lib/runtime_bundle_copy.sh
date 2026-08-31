#!/usr/bin/env bash

copy_runtime_entry_replace() {
  local src="$1"
  local dest_dir="$2"
  local dest

  mkdir -p "$dest_dir"
  dest="$dest_dir/$(basename "$src")"
  rm -rf -- "$dest"
  if [ -L "$src" ]; then
    ln -sfn "$(readlink "$src")" "$dest"
  else
    cp -aT --remove-destination "$src" "$dest"
  fi
}

ensure_runtime_soname_link() {
  local dest_dir="$1"
  local stem="$2"
  local resolved_name="$3"
  local soname="$dest_dir/${stem}.so"

  if [ "$resolved_name" = "${stem}.so" ]; then
    return 0
  fi
  rm -rf -- "$soname"
  ln -sfn "$resolved_name" "$soname"
}

copy_runtime_resolved_dependency_pair() {
  local requested="$1"
  local resolved="$2"
  local dest_dir="$3"
  local requested_name
  local resolved_name

  requested_name="$(basename "$requested")"
  resolved_name="$(basename "$resolved")"

  if [ "$requested_name" = "$resolved_name" ]; then
    copy_runtime_entry_replace "$resolved" "$dest_dir"
    return 0
  fi

  copy_runtime_entry_replace "$resolved" "$dest_dir"
  if [ -L "$requested" ]; then
    rm -rf -- "$dest_dir/$requested_name"
    ln -sfn "$resolved_name" "$dest_dir/$requested_name"
  elif [ -e "$requested" ]; then
    copy_runtime_entry_replace "$requested" "$dest_dir"
  fi
}

runtime_dependency_is_host_owned() {
  local name
  name="$(basename "$1")"
  case "$name" in
    ld-linux*.so*|ld64*.so*|libc.so*|libc-*.so*|libdl.so*|libdl-*.so*|libm.so*|libm-*.so*|libpthread.so*|libpthread-*.so*|libresolv.so*|libresolv-*.so*|librt.so*|librt-*.so*|libutil.so*|libutil-*.so*|libgcc_s.so*|libstdc++.so*|libcuda.so*|libnvidia-*.so*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}
