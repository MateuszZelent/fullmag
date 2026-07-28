#!/usr/bin/env bash

capture_managed_fem_image_id() {
  local image_ref="$1"
  local image_id
  image_id="$(docker image inspect "${image_ref}" --format '{{.Id}}' 2>/dev/null || true)"
  if ! [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "[export_fem_gpu_runtime] failed to capture built FEM image ID for ${image_ref}: ${image_id:-<missing>}" >&2
    return 2
  fi
  printf '%s\n' "${image_id}"
}

observe_managed_fem_image_tag() {
  local image_ref="$1"
  local built_image_id="$2"
  local current_image_id
  current_image_id="$(docker image inspect "${image_ref}" --format '{{.Id}}' 2>/dev/null || true)"
  if [ "${current_image_id}" != "${built_image_id}" ]; then
    echo "[export_fem_gpu_runtime] managed FEM image tag drift detected: ref=${image_ref} built=${built_image_id} current=${current_image_id:-<missing>}" >&2
  fi
  printf '%s\n' "${current_image_id}"
}
