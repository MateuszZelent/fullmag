#!/usr/bin/env bash

resolve_managed_fem_native_storage_profile() {
  FULLMAG_NATIVE_STORAGE_PROFILE="${FULLMAG_NATIVE_STORAGE_PROFILE-canonical}"
  FULLMAG_NATIVE_BUILD_STORAGE_ROOT="/zfn2/mateuszz/git/fullmag"
  case "${FULLMAG_NATIVE_STORAGE_PROFILE}" in
    canonical)
      FULLMAG_NATIVE_BUILD_IMAGE="/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4"
      FULLMAG_NATIVE_MOUNT_VIEW="/mnt/fullmag-zfn2-native"
      ;;
    native-2)
      FULLMAG_NATIVE_BUILD_IMAGE="/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native-2.ext4"
      FULLMAG_NATIVE_MOUNT_VIEW="/mnt/fullmag-zfn2-native-2"
      ;;
    *)
      echo "[managed_fem_runtime_storage] unknown managed FEM native storage profile: ${FULLMAG_NATIVE_STORAGE_PROFILE:-<empty>} (expected canonical or native-2)" >&2
      return 2
      ;;
  esac
}

validate_managed_fem_runtime_storage_target() {
  local target_dir="$1"
  local expected_backing_image="$2"
  local loop_sysfs_root="$3"
  local guidance_function="${4:-}"
  local probe_path="${target_dir}"

  while [ ! -e "${probe_path}" ]; do
    local parent_path
    parent_path="$(dirname "${probe_path}")"
    if [ "${parent_path}" = "${probe_path}" ]; then
      echo "[managed_fem_runtime_storage] cannot locate an existing parent for durable target: ${target_dir}" >&2
      [ -z "${guidance_function}" ] || "${guidance_function}"
      return 2
    fi
    probe_path="${parent_path}"
  done
  if [ ! -d "${probe_path}" ] || [ -L "${probe_path}" ]; then
    echo "[managed_fem_runtime_storage] durable target parent is not a regular directory: ${probe_path}" >&2
    [ -z "${guidance_function}" ] || "${guidance_function}"
    return 2
  fi

  local filesystem_type source_device loop_device_name backing_file_path
  local observed_backing_image=""
  filesystem_type="$(findmnt -n -o FSTYPE --target "${probe_path}" 2>/dev/null || true)"
  if [ "${filesystem_type}" != "ext4" ]; then
    echo "[managed_fem_runtime_storage] durable runtime target must be an ext4 filesystem: ${target_dir} (observed ${filesystem_type:-unknown})" >&2
    [ -z "${guidance_function}" ] || "${guidance_function}"
    return 2
  fi
  source_device="$(findmnt -n -o SOURCE --target "${probe_path}" 2>/dev/null || true)"
  if ! [[ "${source_device}" =~ ^/dev/loop[0-9]+$ ]]; then
    echo "[managed_fem_runtime_storage] durable runtime target must use a loop device backed by ${expected_backing_image}: ${target_dir} (observed source ${source_device:-unknown})" >&2
    [ -z "${guidance_function}" ] || "${guidance_function}"
    return 2
  fi
  loop_device_name="${source_device#/dev/}"
  backing_file_path="${loop_sysfs_root}/${loop_device_name}/loop/backing_file"
  if ! IFS= read -r observed_backing_image < "${backing_file_path}"; then
    echo "[managed_fem_runtime_storage] cannot read loop backing image for ${source_device}: ${backing_file_path}" >&2
    [ -z "${guidance_function}" ] || "${guidance_function}"
    return 2
  fi
  if [ "${observed_backing_image}" != "${expected_backing_image}" ]; then
    echo "[managed_fem_runtime_storage] durable runtime target has the wrong physical backing image: expected ${expected_backing_image}, observed ${observed_backing_image:-unknown}" >&2
    [ -z "${guidance_function}" ] || "${guidance_function}"
    return 2
  fi

  if ! mkdir -p "${target_dir}"; then
    echo "[managed_fem_runtime_storage] cannot create durable runtime target: ${target_dir}" >&2
    [ -z "${guidance_function}" ] || "${guidance_function}"
    return 2
  fi
  if [ ! -d "${target_dir}" ] || [ -L "${target_dir}" ]; then
    echo "[managed_fem_runtime_storage] durable runtime target is not a regular directory: ${target_dir}" >&2
    return 2
  fi
  local target_source_device
  target_source_device="$(findmnt -n -o SOURCE --target "${target_dir}" 2>/dev/null || true)"
  if [ "${target_source_device}" != "${source_device}" ]; then
    echo "[managed_fem_runtime_storage] durable runtime target changed filesystem during creation: ${target_dir}" >&2
    return 2
  fi
  local write_probe="${target_dir}/.fullmag-write-probe.$$"
  if ! (umask 077 && : > "${write_probe}") 2>/dev/null; then
    echo "[managed_fem_runtime_storage] managed ext4 runtime target is not writable: ${target_dir}" >&2
    [ -z "${guidance_function}" ] || "${guidance_function}"
    return 2
  fi
  rm -f -- "${write_probe}"
}

require_regular_contained_durable_variant() {
  local durable_variants_root="$1"
  local durable_variant="$2"
  local durable_root_real durable_variant_real

  if [ ! -d "${durable_variants_root}" ] || [ -L "${durable_variants_root}" ]; then
    echo "durable managed FEM variants root is not a regular directory: ${durable_variants_root}" >&2
    return 2
  fi
  if [ ! -d "${durable_variant}" ] || [ -L "${durable_variant}" ]; then
    echo "durable managed FEM variant is not a regular directory: ${durable_variant}" >&2
    return 2
  fi
  durable_root_real="$(readlink -f "${durable_variants_root}")"
  durable_variant_real="$(readlink -f "${durable_variant}")"
  case "${durable_variant_real}" in
    "${durable_root_real}"/*) ;;
    *)
      echo "durable managed FEM variant escapes durable storage: ${durable_variant}" >&2
      return 2
      ;;
  esac
}

migrate_managed_fem_runtime_variants() {
  local variants_alias="$1"
  local durable_variants_root="$2"
  local validator="$3"
  local next_alias="${variants_alias}.next.$$"

  mkdir -p "$(dirname "${variants_alias}")" "${durable_variants_root}"
  if [ ! -d "${durable_variants_root}" ] || [ -L "${durable_variants_root}" ]; then
    echo "durable managed FEM variants root is not a regular directory: ${durable_variants_root}" >&2
    return 2
  fi
  if [ -L "${variants_alias}" ]; then
    if [ "$(readlink -f "${variants_alias}")" != "$(readlink -f "${durable_variants_root}")" ]; then
      echo "managed FEM variants alias points to unexpected storage: ${variants_alias}" >&2
      return 2
    fi
    return 0
  fi
  if [ ! -e "${variants_alias}" ]; then
    ln -sfn "${durable_variants_root}" "${next_alias}"
    mv -Tf "${next_alias}" "${variants_alias}"
    return 0
  fi
  if [ ! -d "${variants_alias}" ]; then
    echo "managed FEM variants path is neither a directory nor a symlink: ${variants_alias}" >&2
    return 2
  fi

  local legacy_variant variant_name durable_variant migration_staging
  while IFS= read -r -d '' legacy_variant; do
    if [ ! -d "${legacy_variant}" ] || [ -L "${legacy_variant}" ]; then
      echo "legacy managed FEM variant is not a regular directory: ${legacy_variant}" >&2
      return 2
    fi
    python3 "${validator}" --runtime-root "${legacy_variant}" >/dev/null
    variant_name="$(basename "${legacy_variant}")"
    durable_variant="${durable_variants_root}/${variant_name}"
    if [ -e "${durable_variant}" ] || [ -L "${durable_variant}" ]; then
      require_regular_contained_durable_variant \
        "${durable_variants_root}" "${durable_variant}"
      python3 "${validator}" --runtime-root "${durable_variant}" >/dev/null
      python3 "${validator}" --runtime-root "${durable_variant}" \
        --compare-exact "${legacy_variant}" >/dev/null
    fi
  done < <(find "${variants_alias}" -mindepth 1 -maxdepth 1 -print0 | sort -z)

  while IFS= read -r -d '' legacy_variant; do
    variant_name="$(basename "${legacy_variant}")"
    durable_variant="${durable_variants_root}/${variant_name}"
    if [ ! -e "${durable_variant}" ] && [ ! -L "${durable_variant}" ]; then
      migration_staging="${durable_variants_root}/.${variant_name}.migration.$$"
      rm -rf -- "${migration_staging}"
      mkdir -p "${migration_staging}"
      cp -a "${legacy_variant}/." "${migration_staging}/"
      if ! python3 "${validator}" --runtime-root "${migration_staging}" \
          --allow-unaddressed-staging >/dev/null || \
         ! python3 "${validator}" --runtime-root "${legacy_variant}" \
          --compare-exact "${migration_staging}" >/dev/null; then
        rm -rf -- "${migration_staging}"
        return 2
      fi
      mv "${migration_staging}" "${durable_variant}"
      python3 "${validator}" --runtime-root "${durable_variant}" >/dev/null
    fi
  done < <(find "${variants_alias}" -mindepth 1 -maxdepth 1 -print0 | sort -z)

  while IFS= read -r -d '' legacy_variant; do
    variant_name="$(basename "${legacy_variant}")"
    durable_variant="${durable_variants_root}/${variant_name}"
    require_regular_contained_durable_variant \
      "${durable_variants_root}" "${durable_variant}"
    python3 "${validator}" --runtime-root "${durable_variant}" \
      --compare-exact "${legacy_variant}" >/dev/null
    rm -rf -- "${legacy_variant}"
  done < <(find "${variants_alias}" -mindepth 1 -maxdepth 1 -print0 | sort -z)

  rmdir -- "${variants_alias}"
  ln -sfn "${durable_variants_root}" "${next_alias}"
  mv -Tf "${next_alias}" "${variants_alias}"
}

prepare_managed_fem_runtime_variants_for_rebind() {
  local variants_alias="$1"
  local durable_variants_root="$2"
  local validator="$3"

  if [ -L "${variants_alias}" ] && \
     [ "$(readlink -f "${variants_alias}" 2>/dev/null || true)" != \
       "$(readlink -f "${durable_variants_root}")" ]; then
    return 0
  fi
  migrate_managed_fem_runtime_variants \
    "${variants_alias}" "${durable_variants_root}" "${validator}"
}

rebind_managed_fem_runtime_aliases() {
  local active_alias="$1"
  local variants_alias="$2"
  local durable_variants_root="$3"
  local durable_variant="$4"
  local validator="$5"
  local variant_name direct_next variants_next relative_next direct_target

  require_regular_contained_durable_variant \
    "${durable_variants_root}" "${durable_variant}"
  python3 "${validator}" --runtime-root "${durable_variant}" >/dev/null
  if { [ -e "${active_alias}" ] || [ -L "${active_alias}" ]; } && \
     [ ! -L "${active_alias}" ]; then
    echo "managed FEM active runtime is not a symlink: ${active_alias}" >&2
    return 2
  fi

  variant_name="$(basename "${durable_variant}")"
  direct_target="$(readlink -f "${durable_variant}")"
  direct_next="${active_alias}.direct-next.$$"
  variants_next="${variants_alias}.next.$$"
  relative_next="${active_alias}.relative-next.$$"

  ln -sfn "${direct_target}" "${direct_next}"
  if ! mv -Tf "${direct_next}" "${active_alias}"; then
    rm -f -- "${direct_next}"
    return 2
  fi

  ln -sfn "${durable_variants_root}" "${variants_next}"
  if ! mv -Tf "${variants_next}" "${variants_alias}"; then
    rm -f -- "${variants_next}"
    return 2
  fi

  ln -sfn "fem-gpu-variants/${variant_name}" "${relative_next}"
  if ! mv -Tf "${relative_next}" "${active_alias}"; then
    rm -f -- "${relative_next}"
    return 2
  fi
}
