#!/usr/bin/env bash

MANAGED_FEM_BUILT_IMAGE_ID=""
MANAGED_FEM_BUILD_CACHE_KEY=""

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

capture_managed_fem_build_cache_key() {
  local image_ref="$1"
  local image_json
  local cache_key
  if ! image_json="$(docker image inspect "${image_ref}" 2>/dev/null)"; then
    echo "[export_fem_gpu_runtime] failed to inspect FEM build image content for ${image_ref}" >&2
    return 2
  fi
  if ! cache_key="$({ printf '%s' "${image_json}"; } | python3 -c '
import hashlib
import json
import sys

images = json.load(sys.stdin)
if not isinstance(images, list) or len(images) != 1:
    raise SystemExit("expected exactly one inspected image")
image = images[0]
rootfs = image.get("RootFS") or {}
layers = rootfs.get("Layers")
if not isinstance(layers, list) or not all(
    isinstance(layer, str) and layer.startswith("sha256:") for layer in layers
):
    raise SystemExit("invalid image RootFS layer identity")
config = image.get("Config") or {}
if not isinstance(config, dict):
    raise SystemExit("invalid image Config")
identity = {
    "schema": "fullmag.managed-fem-build-cache.v1",
    "architecture": image.get("Architecture"),
    "os": image.get("Os"),
    "variant": image.get("Variant"),
    "rootfs": {"type": rootfs.get("Type"), "layers": layers},
    "config": {key: value for key, value in config.items() if key != "Labels"},
}
encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
print(hashlib.sha256(encoded).hexdigest())
')"; then
    echo "[export_fem_gpu_runtime] failed to derive FEM build cache key for ${image_ref}" >&2
    return 2
  fi
  if ! [[ "${cache_key}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "[export_fem_gpu_runtime] invalid FEM build cache key for ${image_ref}: ${cache_key:-<missing>}" >&2
    return 2
  fi
  printf '%s\n' "${cache_key}"
}

build_managed_fem_image() {
  local build_image_ref="$1"
  local compatibility_image_ref="$2"

  COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-fullmag-fem-runtime}" \
  FULLMAG_FEM_GPU_IMAGE="${build_image_ref}" \
    docker compose --profile fem-gpu build fem-gpu
  MANAGED_FEM_BUILT_IMAGE_ID="$(capture_managed_fem_image_id "${build_image_ref}")"
  MANAGED_FEM_BUILD_CACHE_KEY="$(capture_managed_fem_build_cache_key "${MANAGED_FEM_BUILT_IMAGE_ID}")"
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
