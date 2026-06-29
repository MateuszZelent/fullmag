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
