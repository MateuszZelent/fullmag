#!/usr/bin/env bash

copy_runtime_entry_replace() {
  local src="$1"
  local dest_dir="$2"
  local dest

  mkdir -p "$dest_dir"
  dest="$dest_dir/$(basename "$src")"
  rm -rf -- "$dest"
  if [ -L "$src" ]; then
    local resolved
    resolved="$(readlink -f "$src" 2>/dev/null || true)"
    if [ -z "$resolved" ] || [ ! -e "$resolved" ]; then
      echo "managed runtime source symlink is dangling: $src" >&2
      return 2
    fi
    # System package links may be relative to their original package
    # directory. The managed destination co-locates the copied target, so
    # publish only its basename and keep the link inside the bundle. A target
    # with the same basename would otherwise become a self-referential link;
    # materialize that entry as a regular file instead.
    if [ "$(basename "$resolved")" = "$(basename "$src")" ]; then
      cp -L --remove-destination "$src" "$dest"
    else
      # A package link may resolve outside the directory being globbed by the
      # caller (OpenMPI's unversioned links are a common example). Copy the
      # resolved regular file first; otherwise the published link is dangling
      # even though the source link itself was valid.
      copy_runtime_entry_replace "$resolved" "$dest_dir"
      ln -sfn "$(basename "$resolved")" "$dest"
    fi
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
