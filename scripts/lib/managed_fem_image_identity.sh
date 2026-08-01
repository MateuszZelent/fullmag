#!/usr/bin/env bash

MANAGED_FEM_BUILT_IMAGE_ID=""

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

build_managed_fem_image() {
  local build_image_ref="$1"
  local compatibility_image_ref="$2"

  COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-fullmag-fem-runtime}" \
    FULLMAG_FEM_GPU_IMAGE="${build_image_ref}" \
    docker compose --profile fem-gpu build fem-gpu
  MANAGED_FEM_BUILT_IMAGE_ID="$(capture_managed_fem_image_id "${build_image_ref}")"
  docker image tag "${MANAGED_FEM_BUILT_IMAGE_ID}" "${compatibility_image_ref}"
}

remove_managed_fem_build_ref() {
  local build_image_ref="$1"
  if ! docker image inspect "${build_image_ref}" >/dev/null 2>&1; then
    return 0
  fi
  if ! docker image rm "${build_image_ref}" >/dev/null 2>&1; then
    echo "[export_fem_gpu_runtime] failed to remove temporary FEM image ref: ${build_image_ref}" >&2
    return 1
  fi
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
