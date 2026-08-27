#!/usr/bin/env bash
set -euo pipefail

info_root="${FULLMAG_DPKG_INFO_ROOT:-/var/lib/dpkg/info}"
alternatives_root="${FULLMAG_DPKG_ALTERNATIVES_ROOT:-/var/lib/dpkg/alternatives}"
nvidia_root="${FULLMAG_NVIDIA_ROOT:-/opt/nvidia}"
expected_names=(
  cuda-libraries-12-4.list
  cuda-libraries-12-4.md5sums
  cuda-nvrtc-12-4.list
  cuda-nvrtc-12-4.md5sums
  cuda-nvtx-12-4.list
  cuda-nvtx-12-4.md5sums
  cuda-opencl-12-4.list
  cuda-opencl-12-4.md5sums
  libcublas-12-4.list
  libcublas-12-4.md5sums
  libcufft-12-4.list
  libcufft-12-4.md5sums
  libcufile-12-4.conffiles
  libcufile-12-4.list
  libcufile-12-4.md5sums
  libcufile-12-4.postinst
  libcufile-12-4.prerm
  libcurand-12-4.list
  libcurand-12-4.md5sums
  libcusolver-12-4.list
  libcusolver-12-4.md5sums
  libcusparse-12-4.list
  libcusparse-12-4.md5sums
  libnccl2.list
  libnccl2.md5sums
  libnccl2.shlibs
  libnccl2.triggers
  libnpp-12-4.list
  libnpp-12-4.md5sums
  libnvfatbin-12-4.list
  libnvfatbin-12-4.md5sums
  libnvjitlink-12-4.list
  libnvjitlink-12-4.md5sums
  libnvjpeg-12-4.list
  libnvjpeg-12-4.md5sums
)

invalid_info_paths=()
for path in "${info_root}"/*; do
  [[ -f "${path}" && -s "${path}" ]] || continue
  if [[ "$(tr -d '\000' <"${path}" | wc -c)" -eq 0 ]]; then
    invalid_info_paths+=("${path}")
  fi
done

invalid_alternative_paths=()
for path in "${alternatives_root}"/*; do
  [[ -f "${path}" && -s "${path}" ]] || continue
  if [[ "$(tr -d '\000' <"${path}" | wc -c)" -eq 0 ]]; then
    invalid_alternative_paths+=("${path}")
  fi
done

expected_nvidia_names=(
  entrypoint.d/10-banner.sh
  entrypoint.d/12-banner.sh
  entrypoint.d/15-container-copyright.txt
  entrypoint.d/30-container-license.txt
  entrypoint.d/50-gpu-driver-check.sh
  entrypoint.d/80-internal-image.sh
  entrypoint.d/90-deprecated-image.sh
  nvidia_entrypoint.sh
)
invalid_nvidia_paths=()
while IFS= read -r -d '' path; do
  if [[ -s "${path}" ]] && [[ "$(tr -d '\000' <"${path}" | wc -c)" -eq 0 ]]; then
    invalid_nvidia_paths+=("${path}")
  fi
done < <(find "${nvidia_root}" -type f -print0 | sort -z)

if [[ "${#invalid_info_paths[@]}" -eq 0 && \
      "${#invalid_alternative_paths[@]}" -eq 0 && \
      "${#invalid_nvidia_paths[@]}" -eq 0 ]]; then
  echo "CUDA dpkg metadata is valid; no normalization required."
  exit 0
fi

if [[ "${#invalid_info_paths[@]}" -ne 0 || "${#invalid_alternative_paths[@]}" -ne 0 ]]; then
  if [[ "${#invalid_info_paths[@]}" -ne "${#expected_names[@]}" ]]; then
    printf 'unexpected invalid dpkg metadata count: expected 0 or %s, got %s\n' \
      "${#expected_names[@]}" "${#invalid_info_paths[@]}" >&2
    printf 'invalid file: %s\n' "${invalid_info_paths[@]}" >&2
    exit 2
  fi

  if [[ "${#invalid_alternative_paths[@]}" -ne 1 ]] || \
      [[ "${invalid_alternative_paths[0]}" != "${alternatives_root}/cufile.json" ]]; then
    printf 'unexpected invalid dpkg alternatives metadata; expected only %s/cufile.json\n' \
      "${alternatives_root}" >&2
    printf 'invalid file: %s\n' "${invalid_alternative_paths[@]}" >&2
    exit 2
  fi

  for index in "${!expected_names[@]}"; do
    expected_path="${info_root}/${expected_names[$index]}"
    actual_path="${invalid_info_paths[$index]}"
    if [[ "${actual_path}" != "${expected_path}" ]]; then
      printf 'unexpected invalid dpkg metadata file: expected %s, got %s\n' \
        "${expected_path}" "${actual_path}" >&2
      exit 2
    fi
  done
fi

if [[ "${#invalid_nvidia_paths[@]}" -ne 0 ]]; then
  if [[ "${#invalid_nvidia_paths[@]}" -ne "${#expected_nvidia_names[@]}" ]]; then
    printf 'unexpected invalid NVIDIA entrypoint count: expected 0 or %s, got %s\n' \
      "${#expected_nvidia_names[@]}" "${#invalid_nvidia_paths[@]}" >&2
    printf 'invalid file: %s\n' "${invalid_nvidia_paths[@]}" >&2
    exit 2
  fi

  for index in "${!expected_nvidia_names[@]}"; do
    expected_path="${nvidia_root}/${expected_nvidia_names[$index]}"
    actual_path="${invalid_nvidia_paths[$index]}"
    if [[ "${actual_path}" != "${expected_path}" ]]; then
      printf 'unexpected invalid NVIDIA entrypoint file: expected %s, got %s\n' \
        "${expected_path}" "${actual_path}" >&2
      exit 2
    fi
  done
fi

if [[ "${#invalid_info_paths[@]}" -ne 0 ]]; then
  for path in "${invalid_info_paths[@]}" "${invalid_alternative_paths[@]}"; do
    rm -- "${path}"
  done
  touch "${info_root}/.fullmag-cuda-dpkg-reinstall-required"
  echo "Removed known NUL-only CUDA 12.4 dpkg metadata; package reinstall required."
fi

if [[ "${#invalid_nvidia_paths[@]}" -ne 0 ]]; then
  rm -- "${invalid_nvidia_paths[@]}"
  echo "Removed known NUL-only NVIDIA CUDA entrypoint files; trusted restore required."
fi
