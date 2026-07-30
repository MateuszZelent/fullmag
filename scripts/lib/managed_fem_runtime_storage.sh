#!/usr/bin/env bash

migrate_managed_fem_runtime_variants() {
  local variants_alias="$1"
  local durable_variants_root="$2"
  local validator="$3"
  local next_alias="${variants_alias}.next.$$"

  mkdir -p "$(dirname "${variants_alias}")" "${durable_variants_root}"
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
    if [ -e "${durable_variant}" ]; then
      python3 "${validator}" --runtime-root "${durable_variant}" >/dev/null
      python3 "${validator}" --runtime-root "${durable_variant}" \
        --compare-exact "${legacy_variant}" >/dev/null
    fi
  done < <(find "${variants_alias}" -mindepth 1 -maxdepth 1 -print0 | sort -z)

  while IFS= read -r -d '' legacy_variant; do
    variant_name="$(basename "${legacy_variant}")"
    durable_variant="${durable_variants_root}/${variant_name}"
    if [ ! -e "${durable_variant}" ]; then
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
    python3 "${validator}" --runtime-root "${durable_variant}" \
      --compare-exact "${legacy_variant}" >/dev/null
    rm -rf -- "${legacy_variant}"
  done < <(find "${variants_alias}" -mindepth 1 -maxdepth 1 -print0 | sort -z)

  rmdir -- "${variants_alias}"
  ln -sfn "${durable_variants_root}" "${next_alias}"
  mv -Tf "${next_alias}" "${variants_alias}"
}
