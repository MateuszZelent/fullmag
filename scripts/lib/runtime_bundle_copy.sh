#!/usr/bin/env bash

copy_runtime_entry_replace() {
  local src="$1"
  local dest_dir="$2"
  local dest

  mkdir -p "$dest_dir"
  dest="$dest_dir/$(basename "$src")"
  rm -rf -- "$dest"
  cp -aT --remove-destination "$src" "$dest"
}
