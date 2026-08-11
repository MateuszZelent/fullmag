#!/usr/bin/env bash

readonly MANAGED_FEM_CANONICAL_STORAGE_ROOT="/zfn2/mateuszz/git/fullmag"
readonly MANAGED_FEM_CANONICAL_MOUNT_VIEW="/mnt/fullmag-zfn2-native"

resolve_managed_fem_runtime_storage_layout() {
  local requested_root="${FULLMAG_MANAGED_FEM_STORAGE_ROOT:-${MANAGED_FEM_CANONICAL_STORAGE_ROOT}}"
  local allow_unqualified_test_root="${1:-0}"
  local resolved_root

  case "${allow_unqualified_test_root}" in
    0|1) ;;
    *)
      echo "[managed_fem_runtime_storage] invalid internal storage qualification mode" >&2
      return 2
      ;;
  esac

  FULLMAG_MANAGED_FEM_STORAGE_ROOT_EXPLICIT=0
  if [ "${FULLMAG_MANAGED_FEM_STORAGE_ROOT+x}" = "x" ] &&
     [ -n "${FULLMAG_MANAGED_FEM_STORAGE_ROOT}" ]; then
    FULLMAG_MANAGED_FEM_STORAGE_ROOT_EXPLICIT=1
  fi

  case "${requested_root}" in
    /*) ;;
    *)
      echo "[managed_fem_runtime_storage] FULLMAG_MANAGED_FEM_STORAGE_ROOT must be an absolute path: ${requested_root}" >&2
      return 2
      ;;
  esac
  if [ "${requested_root}" = "/" ]; then
    echo "[managed_fem_runtime_storage] FULLMAG_MANAGED_FEM_STORAGE_ROOT must not be the filesystem root" >&2
    return 2
  fi
  if [ -L "${requested_root}" ]; then
    echo "[managed_fem_runtime_storage] FULLMAG_MANAGED_FEM_STORAGE_ROOT must not be a symbolic link: ${requested_root}" >&2
    return 2
  fi
  if [ ! -d "${requested_root}" ]; then
    echo "[managed_fem_runtime_storage] FULLMAG_MANAGED_FEM_STORAGE_ROOT must be an existing directory: ${requested_root}" >&2
    return 2
  fi
  if ! resolved_root="$(realpath -e -- "${requested_root}")" || [ ! -d "${resolved_root}" ]; then
    echo "[managed_fem_runtime_storage] cannot resolve FULLMAG_MANAGED_FEM_STORAGE_ROOT: ${requested_root}" >&2
    return 2
  fi

  if [ "${resolved_root}" != "${MANAGED_FEM_CANONICAL_STORAGE_ROOT}" ] &&
     [ "${allow_unqualified_test_root}" != "1" ]; then
    case "${resolved_root}" in
      /mnt/?*/*) ;;
      *)
        echo "[managed_fem_runtime_storage] alternate storage must be a qualified host mount under /mnt/<mount>/...: ${resolved_root}" >&2
        return 2
        ;;
    esac
    local host_mount_target host_filesystem_type host_mount_options
    host_mount_target="$(findmnt -n -o TARGET --target "${resolved_root}" 2>/dev/null || true)"
    host_filesystem_type="$(findmnt -n -o FSTYPE --target "${resolved_root}" 2>/dev/null || true)"
    host_mount_options="$(findmnt -n -o OPTIONS --target "${resolved_root}" 2>/dev/null || true)"
    case "${host_mount_target}" in
      /mnt/?*) ;;
      *) host_mount_target="" ;;
    esac
    if [ -z "${host_mount_target}" ] ||
       [[ "${host_mount_target#/mnt/}" == */* ]] ||
       [ "${resolved_root}" = "${host_mount_target}" ] ||
       [[ "${resolved_root}" != "${host_mount_target}/"* ]]; then
      echo "[managed_fem_runtime_storage] unsupported durable host mount for alternate storage: ${resolved_root} (observed target ${host_mount_target:-unknown})" >&2
      return 2
    fi
    case "${host_filesystem_type}" in
      9p|drvfs) ;;
      *)
        echo "[managed_fem_runtime_storage] unsupported durable host mount for alternate storage: ${resolved_root} (observed filesystem ${host_filesystem_type:-unknown})" >&2
        return 2
        ;;
    esac
    case ",${host_mount_options}," in
      *,rw,*) ;;
      *)
        echo "[managed_fem_runtime_storage] unsupported durable host mount for alternate storage: ${resolved_root} (mount must be read-write; observed ${host_mount_options:-unknown})" >&2
        return 2
        ;;
    esac
  fi

  FULLMAG_NATIVE_BUILD_STORAGE_ROOT="${resolved_root}"
  FULLMAG_NATIVE_BUILD_IMAGE="${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}/build-volumes/fullmag-native.ext4"
  if [ "${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}" = "${MANAGED_FEM_CANONICAL_STORAGE_ROOT}" ]; then
    FULLMAG_NATIVE_MOUNT_VIEW="${MANAGED_FEM_CANONICAL_MOUNT_VIEW}"
  else
    FULLMAG_NATIVE_MOUNT_VIEW="${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}/build-volumes/fullmag-native.mount"
  fi
  FULLMAG_PERSISTENT_RUNTIME_PARENT="${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}/runtimes"
}

validate_managed_fem_runtime_storage_layout() {
  local guidance_function="${1:-}"

  if [ ! -f "${FULLMAG_NATIVE_BUILD_IMAGE}" ] || [ -L "${FULLMAG_NATIVE_BUILD_IMAGE}" ]; then
    echo "[managed_fem_runtime_storage] expected a regular ext4 backing image: ${FULLMAG_NATIVE_BUILD_IMAGE}" >&2
    [ -z "${guidance_function}" ] || "${guidance_function}"
    return 2
  fi
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

select_managed_fem_runtime_variants_alias() {
  local variants_alias="$1"
  local durable_variants_root="$2"
  local allowed_retarget_from="${3:-}"
  local next_alias="${variants_alias}.next.$$"

  if [ ! -d "${durable_variants_root}" ] || [ -L "${durable_variants_root}" ]; then
    echo "durable managed FEM variants root is not a regular directory: ${durable_variants_root}" >&2
    return 2
  fi
  mkdir -p "$(dirname "${variants_alias}")"
  if [ -L "${variants_alias}" ]; then
    if [ "$(readlink -f "${variants_alias}")" = "$(readlink -f "${durable_variants_root}")" ]; then
      return 0
    fi
    if [ -z "${allowed_retarget_from}" ] ||
       [ "$(readlink "${variants_alias}")" != "${allowed_retarget_from}" ]; then
      echo "managed FEM variants alias points to unexpected storage: ${variants_alias}" >&2
      return 2
    fi
  elif [ -e "${variants_alias}" ]; then
    echo "managed FEM variants alias selection requires a symlink or missing path: ${variants_alias}" >&2
    return 2
  fi
  ln -sfn "${durable_variants_root}" "${next_alias}"
  mv -Tf "${next_alias}" "${variants_alias}"
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
    select_managed_fem_runtime_variants_alias \
      "${variants_alias}" "${durable_variants_root}" "${allowed_retarget_from}"
    return 0
  fi
  if [ ! -e "${variants_alias}" ]; then
    select_managed_fem_runtime_variants_alias \
      "${variants_alias}" "${durable_variants_root}" "${allowed_retarget_from}"
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
