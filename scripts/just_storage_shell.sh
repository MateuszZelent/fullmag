#!/usr/bin/env bash
# Run every just recipe through the project storage boundary.
#
# `just` starts one shell per recipe line by default.  A dependency-only
# preflight therefore cannot export CARGO_TARGET_DIR, TMPDIR, or the managed
# compatibility paths to the command that follows it.  This adapter is the
# shell boundary instead: resolve and prepare first, then run the complete
# recipe body in the same process environment.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "[fullmag just] expected the recipe body as the only shell argument" >&2
  exit 2
fi

is_windows_shell() {
  case "${OS:-}" in
    Windows_NT) return 0 ;;
  esac
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
  esac
  return 1
}

recipe="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
resolver="${repo_root}/scripts/fullmag_storage.py"
python_cmd="${FULLMAG_STORAGE_PYTHON:-}"
if [ -n "${python_cmd}" ] && is_windows_shell && command -v cygpath >/dev/null 2>&1 && [[ "${python_cmd}" == *\\* || "${python_cmd}" =~ ^[A-Za-z]:[\\/] ]]; then
  python_cmd="$(cygpath -u "${python_cmd}")"
fi
if [ -n "${python_cmd}" ] && ! "${python_cmd}" -c 'import sys; assert sys.version_info.major == 3' >/dev/null 2>&1; then
  python_cmd=""
fi
if [ -z "${python_cmd}" ]; then
  python_candidates=(python3 python)
  if is_windows_shell; then
    python_candidates=()
    # A WindowsApps alias can precede a working interpreter in PATH.
    while IFS= read -r candidate; do
      [ -n "${candidate}" ] && python_candidates+=("${candidate}")
    done < <(type -aP python python3 2>/dev/null || true)
  fi
  for python_candidate in "${python_candidates[@]}"; do
    candidate_path=""
    if command -v "${python_candidate}" >/dev/null 2>&1; then
      candidate_path="$(command -v "${python_candidate}")"
    elif [ -f "${python_candidate}" ]; then
      candidate_path="${python_candidate}"
    fi
    if [ -n "${candidate_path}" ] && "${candidate_path}" -c 'import sys; assert sys.version_info.major == 3' >/dev/null 2>&1; then
      python_cmd="${candidate_path}"
      break
    fi
  done
fi
if [ -z "${python_cmd}" ]; then
  echo "[fullmag just] Python is required for the storage resolver" >&2
  exit 2
fi

# Recipe bodies also invoke Python by name. Keep them on the interpreter
# that passed the probe, without changing the host's persistent PATH.
export PATH="$(dirname "${python_cmd}"):${PATH}"
# Nested launchers may run under a fresh Windows Bash process where the
# POSIX-form PATH entry is not preserved. Pass the tested absolute interpreter
# explicitly so they cannot fall back to the WindowsApps alias.
export FULLMAG_STORAGE_PYTHON="${python_cmd}"

if [ ! -f "${resolver}" ]; then
  echo "[fullmag just] common storage resolver is missing: ${resolver}" >&2
  exit 2
fi

# Python on Windows cannot resolve the POSIX `/usr/bin/bash` entry that Git
# Bash exposes in PATH. Pass an absolute Windows executable to the managed
# runner so nested recipe shells inherit the resolved storage environment.
bash_executable="bash"
if is_windows_shell && command -v cygpath >/dev/null 2>&1; then
  bash_path="$(command -v bash)"
  if [[ "${bash_path}" == /* ]]; then
    bash_executable="$(cygpath -w "${bash_path}")"
  fi
fi
# Frozen coordinator provisioning must be admitted before diagnostic markers.
case "${recipe}" in
  *"scripts/launch_accepted_closed_loop_runtime.py"*)
    closed_loop_pattern="^[^[:space:]]+ \"[^\"]+/scripts/launch_accepted_closed_loop_runtime.py\" --request '([^']+)' --request-sha256 '([0-9a-f]{64})'$"
    if [[ ! "${recipe}" =~ ${closed_loop_pattern} ]]; then
      echo "[fullmag just] invalid closed-loop runtime recipe" >&2
      exit 2
    fi
    exec "${python_cmd}" "${script_dir}/launch_accepted_closed_loop_runtime.py" --request "${BASH_REMATCH[1]}" --request-sha256 "${BASH_REMATCH[2]}"
    ;;
  *"scripts/local_runner/coordinator_image.py"*)
    coordinator_base_pattern="^[^[:space:]]+ \"[^\"]+/scripts/local_runner/coordinator_image.py\" provision-base --repo-root '([^']+)'$"
    if [[ "${recipe}" =~ ${coordinator_base_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/local_runner/coordinator_image.py" provision-base --repo-root "${repo_root}"
    fi
    coordinator_context_pattern="^[^[:space:]]+ \"[^\"]+/scripts/local_runner/coordinator_image.py\" prepare-image-context --repo-root '([^']+)' --source commit --ref '([a-f0-9]{40})'$"
    if [[ "${recipe}" =~ ${coordinator_context_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/local_runner/coordinator_image.py" prepare-image-context --repo-root "${repo_root}" --source commit --ref "${BASH_REMATCH[2]}"
    fi
    coordinator_image_pattern="^[^[:space:]]+ \"[^\"]+/scripts/local_runner/coordinator_image.py\" build-image --repo-root '([^']+)' --context '([^']+)' --context-sha256 '([a-f0-9]{64})' --tag '(fullmag/build-runner:[a-z0-9][a-z0-9_.-]{0,100})'$"
    if [[ "${recipe}" =~ ${coordinator_image_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/local_runner/coordinator_image.py" build-image --repo-root "${repo_root}" --context "${BASH_REMATCH[2]}" --context-sha256 "${BASH_REMATCH[3]}" --tag "${BASH_REMATCH[4]}"
    fi
    echo "[fullmag just] invalid frozen coordinator image recipe" >&2
    exit 2
    ;;
esac

# Admit this fixed helper before generic diagnostic substring handling, so a
# composite command cannot use a diagnostic marker to bypass its argument check.
case "${recipe}" in
  *"scripts/bootstrap_docker_toolchain.py"*)
    toolchain_bootstrap_pattern='^[^[:space:]]+ "[^"]+/scripts/bootstrap_docker_toolchain.py" --repo-root "[^"]+"( --direct-development)?$'
    if [[ ! "${recipe}" =~ ${toolchain_bootstrap_pattern} ]]; then
      echo "[fullmag just] invalid Docker toolchain bootstrap recipe" >&2
      exit 2
    fi
    # This fresh-host operation owns its own storage initialization, global
    # heavy lock, and enrolled-runner admission. Do not run prepare-links or
    # the generic runner around it.
    toolchain_mode=()
    if [[ "${recipe}" == *" --direct-development" ]]; then toolchain_mode+=(--direct-development); fi
    exec "${python_cmd}" "${script_dir}/bootstrap_docker_toolchain.py" --repo-root "${repo_root}" "${toolchain_mode[@]}"
    ;;
  *"scripts/recover_docker_orphan.py"*)
    orphan_recovery_pattern="^[^[:space:]]+ \"[^\"]+/scripts/recover_docker_orphan.py\" --pins '([^']+)' --target-container '([0-9a-f]{64})' --project '(fullmag-(master|worktree-[a-z0-9._-]+))' --diagnostics-root '([^']+)'( --resume-before-stop)?[[:space:]]*$"
    if [[ ! "${recipe}" =~ ${orphan_recovery_pattern} ]]; then
      echo "[fullmag just] invalid controlled worker orphan recovery recipe" >&2
      exit 2
    fi
    # Execute fixed argv, not the supplied shell text. Keep the normal storage
    # preflight and terminal execution receipt around this operator operation.
    orphan_pins="${BASH_REMATCH[1]}"
    orphan_container="${BASH_REMATCH[2]}"
    orphan_project="${BASH_REMATCH[3]}"
    orphan_diagnostics="${BASH_REMATCH[5]}"
    orphan_resume=()
    if [[ -n "${BASH_REMATCH[6]:-}" ]]; then
      orphan_resume=(--resume-before-stop)
    fi
    exec "${python_cmd}" "${resolver}" run --repo-root "${repo_root}" --profile docker-all-gpu -- \
      "${python_cmd}" "${script_dir}/recover_docker_orphan.py" --pins "${orphan_pins}" \
      --target-container "${orphan_container}" --project "${orphan_project}" \
      --diagnostics-root "${orphan_diagnostics}" "${orphan_resume[@]}"
    ;;
  *"scripts/docker_dev.py"*)
    docker_dev_pattern="^[^[:space:]]+ \"[^\"]+/scripts/docker_dev.py\" --repo-root \"[^\"]+\" (build|up --port '[0-9]{4,5}')( --source-root '[^']+')?( --script '[^']+')?[[:space:]]*$"
    docker_dev_recreate_pattern="^[^[:space:]]+ \"[^\"]+/scripts/docker_dev.py\" --repo-root \"[^\"]+\" recreate --direct-development --run-receipt '[^']+' --previous-config-sha256 '[0-9a-f]{64}'[ ]+(--source-root '[^']+'[ ]+)?--port '[0-9]{4,5}'[[:space:]]*$"
    if [[ ! "${recipe}" =~ ${docker_dev_pattern} && ! "${recipe}" =~ ${docker_dev_recreate_pattern} ]]; then
      echo "[fullmag just] invalid direct Docker development recipe" >&2
      exit 2
    fi
    exec "${python_cmd}" "${resolver}" run --repo-root "${repo_root}" --profile docker-all-gpu -- "${bash_executable}" -euo pipefail -c "${recipe}"
    ;;
  *"scripts/run_managed_boris_nf_v2.py"*)
    # Match just's quoted arguments, including escaped checkout apostrophes.
    boris_runtime_start_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_boris_nf_v2.py\" --repo-root '([^']|'\\\\'')+' run --job-id '([0-9a-f]{32})' --resolution '(coarse|medium|fine)'$"
    if [[ "${recipe}" =~ ${boris_runtime_start_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/run_managed_boris_nf_v2.py" --repo-root "${repo_root}" run --job-id "${BASH_REMATCH[2]}" --resolution "${BASH_REMATCH[3]}"
    fi
    boris_runtime_observe_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_boris_nf_v2.py\" --repo-root '([^']|'\\\\'')+' observe --runtime-id '([0-9a-f]{32})'$"
    if [[ "${recipe}" =~ ${boris_runtime_observe_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/run_managed_boris_nf_v2.py" --repo-root "${repo_root}" observe --runtime-id "${BASH_REMATCH[2]}"
    fi
    echo "[fullmag just] invalid managed BORIS V2 runtime recipe" >&2
    exit 2
    ;;
  *"scripts/run_managed_boris_nf.py"*)
    # Match just's quoted arguments, including escaped checkout apostrophes.
    boris_runtime_start_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_boris_nf.py\" --repo-root '([^']|'\\\\'')+' start --job-id '([0-9a-f]{32})' --resolution '(coarse|medium|fine)'$"
    if [[ "${recipe}" =~ ${boris_runtime_start_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/run_managed_boris_nf.py" --repo-root "${repo_root}" start --job-id "${BASH_REMATCH[2]}" --resolution "${BASH_REMATCH[3]}"
    fi
    boris_runtime_observe_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_boris_nf.py\" --repo-root '([^']|'\\\\'')+' observe --runtime-id '([0-9a-f]{32})'$"
    if [[ "${recipe}" =~ ${boris_runtime_observe_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/run_managed_boris_nf.py" --repo-root "${repo_root}" observe --runtime-id "${BASH_REMATCH[2]}"
    fi
    echo "[fullmag just] invalid managed BORIS runtime recipe" >&2
    exit 2
    ;;
  *"scripts/verify_docker_all_runtime.py"*)
    docker_verify_pattern="^[^[:space:]]+ \"[^\"]+/scripts/verify_docker_all_runtime.py\" --repo-root \"[^\"]+\" '[^']+'$"
    if [[ ! "${recipe}" =~ ${docker_verify_pattern} ]]; then
      echo "[fullmag just] invalid all-in-Docker verification recipe" >&2
      exit 2
    fi
    exec "${python_cmd}" "${resolver}" run --repo-root "${repo_root}" --profile docker-all-gpu -- "${bash_executable}" -euo pipefail -c "${recipe}"
    ;;
  *"scripts/fullmag_docker_runtime.py"*)
    docker_runtime_pattern="^[^[:space:]]+ \"[^\"]+/scripts/fullmag_docker_runtime.py\" --repo-root \"[^\"]+\" (submit-development( --source-root '[^']+')?|submit --commit '[a-f0-9]{40}'|build-image --job-id '[a-f0-9]{32}' --commit '[a-f0-9]{40}'( --development)?( --source-digest '[a-f0-9]{64}' --native-snapshot-sha256 '[a-f0-9]{64}')?( --source-root '[^']+')?|start --assembly-receipt '[^']+' --port '[0-9]{4,5}'( --frontend 'dev')?( --source-root '[^']+')?( --startup-script '[^']+')?)[[:space:]]*$"
    if [[ ! "${recipe}" =~ ${docker_runtime_pattern} ]]; then
      echo "[fullmag just] invalid all-in-Docker recipe" >&2
      exit 2
    fi
    exec "${python_cmd}" "${resolver}" run --repo-root "${repo_root}" --profile docker-all-gpu -- "${bash_executable}" -euo pipefail -c "${recipe}"
    ;;
  *"scripts/verify_antenna_field_reader.py"*)
    antenna_reader_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_antenna_field_reader.py" --repo-root "[^"]+"$'
    if [[ ! "${recipe}" =~ ${antenna_reader_pattern} ]]; then
      echo "[fullmag just] invalid antenna field-reader recipe" >&2
      exit 2
    fi
    # This fixed Python-only helper owns resolver preflight, its profile lock
    # and terminal source-bound receipt. No arbitrary command is forwarded.
    exec "${python_cmd}" "${script_dir}/verify_antenna_field_reader.py" --repo-root "${repo_root}"
    ;;
  *"scripts/windows/recover_runtime.py"*)
    runtime_recovery_pattern='^[^[:space:]]+ "[^"]+/scripts/windows/recover_runtime.py" --repo-root "[^"]+" --web-port "([1-9][0-9]{0,4})"$'
    if [[ ! "${recipe}" =~ ${runtime_recovery_pattern} ]]; then
      echo "[fullmag just] invalid native runtime recovery recipe" >&2
      exit 2
    fi
    web_port="${BASH_REMATCH[1]}"
    if ! is_windows_shell || (( web_port > 65535 )); then
      echo "[fullmag just] native runtime recovery requires Windows and a port from 1 to 65535" >&2
      exit 2
    fi
    # This fixed helper owns resolver validation, both managed locks, process
    # inspection and the exact-status archive/receipt transition.
    exec "${python_cmd}" "${script_dir}/windows/recover_runtime.py" --repo-root "${repo_root}" --web-port "${web_port}"
    ;;
  *"scripts/windows/run_fullmag.ps1"*" -RunMode workspace "*)
    windows_ui_pattern='^powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "[^"]+/scripts/windows/run_fullmag.ps1" -BuildMode "(auto|true|false)" -Frontend "(static|dev)" -BackendProfile "(auto|dev|release)" -RunMode workspace -WebPort "([1-9][0-9]{0,4})"( -BuildOnly)?$'
    if [[ ! "${recipe}" =~ ${windows_ui_pattern} ]]; then
      echo "[fullmag just] invalid native Windows workspace recipe" >&2
      exit 2
    fi
    build_mode="${BASH_REMATCH[1]}"; frontend="${BASH_REMATCH[2]}"; backend_profile="${BASH_REMATCH[3]}"; web_port="${BASH_REMATCH[4]}"; build_only="${BASH_REMATCH[5]}"
    if ! is_windows_shell || (( web_port > 65535 )); then
      echo "[fullmag just] native Windows workspace requires Windows and a port from 1 to 65535" >&2
      exit 2
    fi
    if [[ -n "${build_only}" && ( "${build_mode}" == "false" || "${backend_profile}" == "auto" ) ]]; then
      echo "[fullmag just] build-only requires build=auto|true and backend_profile=dev|release" >&2
      exit 2
    fi
    # The native launcher owns storage preflight, locking and terminal receipts.
    # Dispatch only this checkout's launcher; never evaluate the recipe text.
    launcher_arguments=(-NoLogo -NoProfile -ExecutionPolicy Bypass -File "${repo_root}/scripts/windows/run_fullmag.ps1" -BuildMode "${build_mode}" -Frontend "${frontend}" -BackendProfile "${backend_profile}" -RunMode workspace -WebPort "${web_port}")
    if [[ -n "${build_only}" ]]; then launcher_arguments+=(-BuildOnly); fi
    exec powershell.exe "${launcher_arguments[@]}"
    ;;
  *"scripts/verify_control_room_sources.py"*)
    # Never execute the recipe text: accept only the fixed argument shape and
    # invoke the trusted helper from this checkout with the selected route.
    source_recipe_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_control_room_sources.py" --route (generate-client|production-source|api-hygiene|lint|openapi-import-check|typecheck-cli-check|explorer-physics-reporting-check|react-doctor|resource-client-cache-check) --repo-root "[^"]+"( --dependency-workspace "([^"]+)")?[[:space:]]*$'
    if [[ ! "${recipe}" =~ ${source_recipe_pattern} ]]; then
      echo "[fullmag just] invalid lightweight frontend recipe" >&2
      exit 2
    fi
    source_route="${BASH_REMATCH[1]}"
    dependency_workspace="${BASH_REMATCH[3]:-}"
    if [[ -n "${dependency_workspace}" ]]; then
      case "${source_route}" in
        generate-client|production-source|api-hygiene) ;;
        *) echo "[fullmag just] dependency workspace is unsupported for this source route" >&2; exit 2 ;;
      esac
      exec "${python_cmd}" -B "${script_dir}/verify_control_room_sources.py" --route "${source_route}" --repo-root "${repo_root}" --dependency-workspace "${dependency_workspace}"
    fi
    exec "${python_cmd}" -B "${script_dir}/verify_control_room_sources.py" --route "${source_route}" --repo-root "${repo_root}"
    ;;
  *"scripts/export_runner_openapi.py"*)
    export_openapi_pattern='^[^[:space:]]+ "[^"]+/scripts/export_runner_openapi.py" --repo-root "[^"]+" --job-id "([0-9a-f]{32})" --expected-commit "([0-9a-f]{40})"$'
    export_openapi_snapshot_pattern='^[^[:space:]]+ "[^"]+/scripts/export_runner_openapi.py" --repo-root "[^"]+" --job-id "([0-9a-f]{32})" --expected-commit "([0-9a-f]{40})" --source-digest "([0-9a-f]{64})" --native-snapshot-sha256 "([0-9a-f]{64})"$'
    if [[ "${recipe}" =~ ${export_openapi_snapshot_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/export_runner_openapi.py" --repo-root "${repo_root}" --job-id "${BASH_REMATCH[1]}" --expected-commit "${BASH_REMATCH[2]}" --source-digest "${BASH_REMATCH[3]}" --native-snapshot-sha256 "${BASH_REMATCH[4]}"
    fi
    if [[ ! "${recipe}" =~ ${export_openapi_pattern} ]]; then
      echo "[fullmag just] invalid managed OpenAPI export recipe" >&2
      exit 2
    fi
    # The helper owns read-only admission, path checks and its terminal proof.
    # Invoke only this checkout's helper, never the supplied recipe text.
    exec "${python_cmd}" "${script_dir}/export_runner_openapi.py" --repo-root "${repo_root}" --job-id "${BASH_REMATCH[1]}" --expected-commit "${BASH_REMATCH[2]}"
    ;;
    *"scripts/verify_development_backend_api.py"*)
    frozen_project_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --project-document-only --frozen-native-build-id "([0-9a-f]{64})" --project-document-browser$'
    if [[ "${recipe}" =~ ${frozen_project_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --project-document-only --frozen-native-build-id "${BASH_REMATCH[1]}" --project-document-browser
    fi
    frozen_project_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --project-document-only --frozen-native-build-id "([0-9a-f]{64})"( --archive-frozen-bundle)?$'
    if [[ "${recipe}" =~ ${frozen_project_pattern} ]]; then
      if ! is_windows_shell; then
        echo "[fullmag just] frozen project document verification requires Windows" >&2
        exit 2
      fi
      archive_args=()
      if [[ -n "${BASH_REMATCH[2]}" ]]; then
        archive_args=(--archive-frozen-bundle)
      fi
      exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --project-document-only --frozen-native-build-id "${BASH_REMATCH[1]}" "${archive_args[@]}"
    fi
    compute_cancellation_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --compute-cancellation-only --frozen-native-build-id "([0-9a-f]{64})"$'
    if [[ "${recipe}" =~ ${compute_cancellation_pattern} ]]; then
      if ! is_windows_shell; then
        echo "[fullmag just] compute cancellation API verification requires Windows" >&2
        exit 2
      fi
      exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --compute-cancellation-only --frozen-native-build-id "${BASH_REMATCH[1]}"
    fi
    compute_host_initialization_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --compute-host-initialization-only --frozen-native-build-id "([0-9a-f]{64})"$'
    compute_scheduler_cancellation_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --compute-scheduler-cancellation-only --frozen-native-build-id "([0-9a-f]{64})"$'
    if [[ "${recipe}" =~ ${compute_scheduler_cancellation_pattern} ]]; then
      if ! is_windows_shell; then
        echo "[fullmag just] compute scheduler cancellation verification requires Windows" >&2
        exit 2
      fi
      exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --compute-scheduler-cancellation-only --frozen-native-build-id "${BASH_REMATCH[1]}"
    fi
    if [[ "${recipe}" =~ ${compute_host_initialization_pattern} ]]; then
      if ! is_windows_shell; then
        echo "[fullmag just] compute host initialization verification requires Windows" >&2
        exit 2
      fi
      exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --compute-host-initialization-only --frozen-native-build-id "${BASH_REMATCH[1]}"
    fi
      candidate_preparation_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --candidate-preparation-only$'
      if [[ "${recipe}" =~ ${candidate_preparation_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --candidate-preparation-only
      fi
      consumer_pump_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --consumer-pump-owner-bundle "([0-9a-f]{32})"$'
      active_run_paused_refusal_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --active-run-refusal-owner-bundle "([0-9a-f]{32})" --active-run-scenario "paused"$'
      if [[ "${recipe}" =~ ${active_run_paused_refusal_pattern} ]]; then
        if ! is_windows_shell; then
          echo "[fullmag just] active-run restart verification requires Windows" >&2
          exit 2
        fi
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --active-run-refusal-owner-bundle "${BASH_REMATCH[1]}" --active-run-scenario paused
      fi
      active_run_refusal_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --active-run-refusal-owner-bundle "([0-9a-f]{32})"$'
      if [[ "${recipe}" =~ ${active_run_refusal_pattern} ]]; then
        if ! is_windows_shell; then
          echo "[fullmag just] active-run restart verification requires Windows" >&2
          exit 2
        fi
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --active-run-refusal-owner-bundle "${BASH_REMATCH[1]}"
      fi
      start_freeze_race_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --start-freeze-race-only$'
      if [[ "${recipe}" =~ ${start_freeze_race_pattern} ]]; then
        if ! is_windows_shell; then
          echo "[fullmag just] Start/freeze race verification requires Windows" >&2
          exit 2
        fi
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --start-freeze-race-only
      fi
      if [[ "${recipe}" =~ ${consumer_pump_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --consumer-pump-owner-bundle "${BASH_REMATCH[1]}"
      fi
      consumer_readiness_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --consumer-readiness-only$'
      if [[ "${recipe}" =~ ${consumer_readiness_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --consumer-readiness-only
      fi
      restart_consumer_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --restart-consumer-only$'
      if [[ "${recipe}" =~ ${restart_consumer_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --restart-consumer-only
      fi
      observer_pause_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --observer-pause-only$'
      if [[ "${recipe}" =~ ${observer_pause_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --observer-pause-only
      fi
      project_document_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --project-document-only$'
      if [[ "${recipe}" =~ ${project_document_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --project-document-only
      fi
      echo "[fullmag just] unsupported development API check recipe" >&2
      exit 2
      ;;
    *"scripts/verify_development_handoff.py"*)
    handoff_check_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_handoff.py" --repo-root "[^"]+"$'
    if [[ ! "${recipe}" =~ ${handoff_check_pattern} ]]; then
      echo "[fullmag just] invalid development handoff check recipe" >&2
      exit 2
    fi
    # This fixed interpreted route owns preflight, its worktree lease and
    # terminal evidence; it does not prepare or migrate compatibility links.
    exec "${python_cmd}" "${script_dir}/verify_development_handoff.py" --repo-root "${repo_root}"
    ;;
esac

# Read-only listing/help recipes must not create a storage marker or any
# compatibility path.  The resolver's own read-only actions can therefore be
# used for inspection even when the checkout has not been initialized yet.
if [[ "${recipe}" == *"fullmag_storage.py"* &&
      "${recipe}" != *"--create"* &&
      "${recipe}" != *"prepare-links"* &&
      "${recipe}" != *" run "* &&
      "${recipe}" != *" register "* &&
      "${recipe}" != *" finish "* ]]; then
  FULLMAG_STORAGE_PYTHON="${python_cmd}" exec "${bash_executable}" -euo pipefail -c "${recipe}"
fi
case "${recipe}" in
  *"just --list"*|*"just --list --"*) exec "${bash_executable}" -euo pipefail -c "${recipe}" ;;
esac

# Read-only capability matrix validation has no mutable project path. Keep it
# outside compatibility-link preparation, just like the fixed Rust routes.
case "${recipe}" in
  *"scripts/validate_mixed_p1_capability_contract.py"*|*"scripts.test_validate_mixed_p1_capability_contract"*)
    exec bash -euo pipefail -c "${recipe}"
    ;;
esac

# Fixed offline BORIS provisioning owns resolver admission and its context lock.
case "${recipe}" in
  *"scripts/local_runner/boris_toolchain.py"*)
    boris_context_pattern="^[^[:space:]]+ \"[^\"]+/scripts/local_runner/boris_toolchain.py\" prepare-image-context --repo-root '([^']+)' --bundle '([^']+)' --wheel-bundle '([^']+)' --base-image '(sha256:[a-f0-9]{64})'$"
    if [[ "${recipe}" =~ ${boris_context_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/local_runner/boris_toolchain.py" prepare-image-context --repo-root "${repo_root}" --bundle "${BASH_REMATCH[2]}" --wheel-bundle "${BASH_REMATCH[3]}" --base-image "${BASH_REMATCH[4]}"
    fi
    boris_image_pattern="^[^[:space:]]+ \"[^\"]+/scripts/local_runner/boris_toolchain.py\" build-image --repo-root '([^']+)' --context '([^']+)' --tag '(fullmag/boris-toolchain:[a-z0-9][a-z0-9_.-]{0,100})'$"
    if [[ "${recipe}" =~ ${boris_image_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/local_runner/boris_toolchain.py" build-image --repo-root "${repo_root}" --context "${BASH_REMATCH[2]}" --tag "${BASH_REMATCH[3]}"
    fi
    echo "[fullmag just] invalid BORIS provisioning recipe" >&2
    exit 2
    ;;
esac

# Fixed BORIS source capture/provisioning admits immutable toolchain proof.
case "${recipe}" in
  *"scripts/local_runner/boris_cpu.py"*)
    boris_source_pattern="^[^[:space:]]+ \"[^\"]+/scripts/local_runner/boris_cpu.py\" prepare-image-context --repo-root '([^']+)' --boris-source '([^']+)' --toolchain-image '(sha256:[a-f0-9]{64})' --toolchain-proof '([^']+)' --toolchain-context '([^']+)' --toolchain-container '([a-f0-9]{64})'$"
    if [[ "${recipe}" =~ ${boris_source_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/local_runner/boris_cpu.py" prepare-image-context --repo-root "${repo_root}" --boris-source "${BASH_REMATCH[2]}" --toolchain-image "${BASH_REMATCH[3]}" --toolchain-proof "${BASH_REMATCH[4]}" --toolchain-context "${BASH_REMATCH[5]}" --toolchain-container "${BASH_REMATCH[6]}"
    fi
    boris_source_image_pattern="^[^[:space:]]+ \"[^\"]+/scripts/local_runner/boris_cpu.py\" build-image --repo-root '([^']+)' --context '([^']+)' --tag '(fullmag/boris-cpu:[a-z0-9][a-z0-9_.-]{0,100})'$"
    if [[ "${recipe}" =~ ${boris_source_image_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/local_runner/boris_cpu.py" build-image --repo-root "${repo_root}" --context "${BASH_REMATCH[2]}" --tag "${BASH_REMATCH[3]}"
    fi
    echo "[fullmag just] invalid BORIS source provisioning recipe" >&2
    exit 2
    ;;
esac

# Runner actions own their storage preflight and per-job/per-worktree locks.
# Holding the generic worktree lock while `wait` polls would prevent the
# coordinator from executing that same worktree's queued job.
case "${recipe}" in
  *"test_local_runner_"*|*"scripts/tests/local_runner"*|*"test_storage_capabilities.py"*)
    "${python_cmd}" "${resolver}" resolve --repo-root "${repo_root}" >/dev/null
    export PYTHONDONTWRITEBYTECODE=1
    exec bash -euo pipefail -c "${recipe}"
    ;;
  *"scripts/local_runner/Dockerfile.coordinator"*|*"scripts/local_runner/Dockerfile.build"*)
    "${python_cmd}" "${resolver}" resolve --repo-root "${repo_root}" >/dev/null
    exec bash -euo pipefail -c "${recipe}"
    ;;
  *"scripts/local_runner_cli.py"*)
    FULLMAG_STORAGE_PYTHON="${python_cmd}" exec bash -euo pipefail -c "${recipe}"
    ;;
  *"scripts/diagnose_managed_fem_startup.py"*)
    "${python_cmd}" "${resolver}" resolve --repo-root "${repo_root}" >/dev/null
    export PYTHONDONTWRITEBYTECODE=1
    exec bash -euo pipefail -c "${recipe}"
    ;;
  *"scripts/run_comsol_dispersion_benchmark.py"*|*"scripts/run_de_100nm_pilot.py"*)
    # The benchmark consumes an already completed runner build.  Its Python
    # entry point acquires the per-worktree build lock around the immutable
    # receipt check and Compose run, so it must not enter the generic heavy
    # lock that rejects all commands while the container coordinator is
    # enrolled on Windows.
    "${python_cmd}" "${resolver}" resolve --repo-root "${repo_root}" >/dev/null
    export PYTHONDONTWRITEBYTECODE=1
    exec bash -euo pipefail -c "${recipe}"
    ;;
esac

# These plain-Rust package routes have fixed commands and own their resolver
# paths/lock inside the dedicated helper. Do not run the generic compatibility-
# link or heavy-build wrapper for them.
case "${recipe}" in
  *"scripts/run_managed_transport_oracles.py"*)
    transport_start_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_transport_oracles.py\" --repo-root \"[^\"]+\" start --job-id '([0-9a-f]{32})' --commit '([0-9a-f]{40})' --source-digest '([0-9a-f]{64})' --native-snapshot-sha256 '([0-9a-f]{64})'$"
    if [[ "${recipe}" =~ ${transport_start_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/run_managed_transport_oracles.py" --repo-root "${repo_root}" start --job-id "${BASH_REMATCH[1]}" --commit "${BASH_REMATCH[2]}" --source-digest "${BASH_REMATCH[3]}" --native-snapshot-sha256 "${BASH_REMATCH[4]}"
    fi
    transport_observe_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_transport_oracles.py\" --repo-root \"[^\"]+\" observe --run-root '([^']+)'$"
    if [[ "${recipe}" =~ ${transport_observe_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/run_managed_transport_oracles.py" --repo-root "${repo_root}" observe --run-root "${BASH_REMATCH[1]}"
    fi
    echo "[fullmag just] invalid managed transport oracle recipe" >&2
    exit 2
    ;;
  *"scripts/run_managed_antenna_http_ram.py"*)
    antenna_http_start_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_antenna_http_ram.py\" --repo-root \"[^\"]+\" start --job-id '([0-9a-f]{32})' --commit '([0-9a-f]{40})' --source-digest '([0-9a-f]{64})' --native-snapshot-sha256 '([0-9a-f]{64})'( --fixture '(magnetic|nonmagnetic|closedloop)')?( --verify-cold-import)?( --standalone)?$"
    if [[ "${recipe}" =~ ${antenna_http_start_pattern} ]]; then
      antenna_http_args=()
      if [[ -n "${BASH_REMATCH[6]}" ]]; then antenna_http_args+=(--fixture "${BASH_REMATCH[6]}"); fi
      if [[ -n "${BASH_REMATCH[7]}" ]]; then antenna_http_args+=(--verify-cold-import); fi
      if [[ -n "${BASH_REMATCH[8]}" ]]; then antenna_http_args+=(--standalone); fi
      exec "${python_cmd}" "${script_dir}/run_managed_antenna_http_ram.py" --repo-root "${repo_root}" start --job-id "${BASH_REMATCH[1]}" --commit "${BASH_REMATCH[2]}" --source-digest "${BASH_REMATCH[3]}" --native-snapshot-sha256 "${BASH_REMATCH[4]}" "${antenna_http_args[@]}"
    fi
    antenna_http_observe_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_antenna_http_ram.py\" --repo-root \"[^\"]+\" observe --run-root '([^']+)'$"
    if [[ "${recipe}" =~ ${antenna_http_observe_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/run_managed_antenna_http_ram.py" --repo-root "${repo_root}" observe --run-root "${BASH_REMATCH[1]}"
    fi
    echo "[fullmag just] invalid managed antenna HTTP RAM recipe" >&2
    exit 2
    ;;
  *"scripts/run_managed_antenna_ram.py"*)
    antenna_ram_start_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_antenna_ram.py\" --repo-root \"[^\"]+\" start --job-id '([0-9a-f]{32})' --commit '([0-9a-f]{40})' --source-digest '([0-9a-f]{64})' --native-snapshot-sha256 '([0-9a-f]{64})'( --standalone)?$"
    if [[ "${recipe}" =~ ${antenna_ram_start_pattern} ]]; then
      standalone_args=()
      if [[ -n "${BASH_REMATCH[5]}" ]]; then standalone_args=(--standalone); fi
      exec "${python_cmd}" "${script_dir}/run_managed_antenna_ram.py" --repo-root "${repo_root}" start --job-id "${BASH_REMATCH[1]}" --commit "${BASH_REMATCH[2]}" --source-digest "${BASH_REMATCH[3]}" --native-snapshot-sha256 "${BASH_REMATCH[4]}" "${standalone_args[@]}"
    fi
    antenna_ram_observe_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_antenna_ram.py\" --repo-root \"[^\"]+\" observe --run-root '([^']+)'$"
    if [[ "${recipe}" =~ ${antenna_ram_observe_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/run_managed_antenna_ram.py" --repo-root "${repo_root}" observe --run-root "${BASH_REMATCH[1]}"
    fi
    echo "[fullmag just] invalid managed antenna RAM recipe" >&2
    exit 2
    ;;
  *"scripts/run_managed_browser.py"*)
    managed_browser_snapshot_pattern="^[^[:space:]]+ \"[^\"]+/scripts/run_managed_browser.py\" --repo-root \"[^\"]+\" --job-id '([0-9a-f]{32})' --commit '([0-9a-f]{40})' --source-digest '([0-9a-f]{64})' --native-snapshot-sha256 '([0-9a-f]{64})' --port '([0-9]{4,5})'( --ephemeral)?$"
    if [[ "${recipe}" =~ ${managed_browser_snapshot_pattern} ]]; then
      managed_browser_args=(--repo-root "${repo_root}" --job-id "${BASH_REMATCH[1]}" --commit "${BASH_REMATCH[2]}" --source-digest "${BASH_REMATCH[3]}" --native-snapshot-sha256 "${BASH_REMATCH[4]}" --port "${BASH_REMATCH[5]}")
      if [[ -n "${BASH_REMATCH[6]}" ]]; then
        managed_browser_args+=(--ephemeral)
      fi
      exec "${python_cmd}" "${script_dir}/run_managed_browser.py" "${managed_browser_args[@]}"
    fi
    managed_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/run_managed_browser.py" --repo-root "[^"]+" --job-id ([0-9a-f]{32}) --commit ([0-9a-f]{40}) --port ([0-9]{4,5})$'
    if [[ ! "${recipe}" =~ ${managed_browser_pattern} ]]; then
      echo "[fullmag just] invalid managed browser recipe" >&2
      exit 2
    fi
    exec "${python_cmd}" "${script_dir}/run_managed_browser.py" --repo-root "${repo_root}" --job-id "${BASH_REMATCH[1]}" --commit "${BASH_REMATCH[2]}" --port "${BASH_REMATCH[3]}"
    ;;
  *"scripts/verify_saved_fem_archive_roundtrip.py"*)
    roundtrip_recipe_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_saved_fem_archive_roundtrip.py" --repo-root "[^"]+"$'
    if [[ ! "${recipe}" =~ ${roundtrip_recipe_pattern} ]]; then
      echo "[fullmag just] invalid saved FEM archive recipe" >&2
      exit 2
    fi
    exec "${python_cmd}" "${script_dir}/verify_saved_fem_archive_roundtrip.py" --repo-root "${repo_root}"
    ;;
  *"scripts/verify_pinned_dataset_browser.py"*)
    preparation_workspace_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3268 --scenario preparation-workspace$'
    if [[ "${recipe}" =~ ${preparation_workspace_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3268 --scenario preparation-workspace
    fi
    antenna_workspace_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3274 --scenario antenna-workspace-authoring( --dependency-workspace "([^"]+)")?[[:space:]]*$'
    if [[ "${recipe}" =~ ${antenna_workspace_browser_pattern} ]]; then
      dependency_workspace="${BASH_REMATCH[2]}"
      if [[ -n "${dependency_workspace}" ]]; then
        exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3274 --scenario antenna-workspace-authoring --dependency-workspace "${dependency_workspace}"
      fi
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3274 --scenario antenna-workspace-authoring
    fi
    antenna_spectrum_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3265 --scenario antenna-source-spectrum( --dependency-workspace "([^"]+)")?[[:space:]]*$'
    if [[ "${recipe}" =~ ${antenna_spectrum_browser_pattern} ]]; then
      dependency_workspace="${BASH_REMATCH[2]:-}"
      if [[ -n "${dependency_workspace}" ]]; then
        exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3265 --scenario antenna-source-spectrum --dependency-workspace "${dependency_workspace}"
      fi
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3265 --scenario antenna-source-spectrum
    fi
    artifact_field_overlay_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3276 --scenario artifact-field-overlay$'
    if [[ "${recipe}" =~ ${artifact_field_overlay_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3276 --scenario artifact-field-overlay
    fi
    antenna_visualization_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3262 --scenario antenna-visualization$'
    if [[ "${recipe}" =~ ${antenna_visualization_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3262 --scenario antenna-visualization
    fi
    inspector_routing_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3261 --scenario inspector-routing$'
    if [[ "${recipe}" =~ ${inspector_routing_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3261 --scenario inspector-routing
    fi
    cpw_viewport_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3260 --scenario antenna-cpw-viewport$'
    if [[ "${recipe}" =~ ${cpw_viewport_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3260 --scenario antenna-cpw-viewport
    fi
    transport_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3254 --scenario antenna-transport-drafts$'
    if [[ "${recipe}" =~ ${transport_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3254 --scenario antenna-transport-drafts
    fi
    port_diagnostics_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3263 --scenario antenna-port-diagnostics$'
    if [[ "${recipe}" =~ ${port_diagnostics_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3263 --scenario antenna-port-diagnostics
    fi
    solve_targets_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3256 --scenario antenna-solve-targets$'
    if [[ "${recipe}" =~ ${solve_targets_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3256 --scenario antenna-solve-targets
    fi
    port_editor_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3264 --scenario antenna-port-editor( --dependency-workspace "([^"]+)")?[[:space:]]*$'
    if [[ "${recipe}" =~ ${port_editor_browser_pattern} ]]; then
      dependency_workspace="${BASH_REMATCH[2]:-}"
      if [[ -n "${dependency_workspace}" ]]; then
        exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3264 --scenario antenna-port-editor --dependency-workspace "${dependency_workspace}"
      fi
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3264 --scenario antenna-port-editor
    fi
    inspector_actions_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3257 --scenario inspector-actions$'
    if [[ "${recipe}" =~ ${inspector_actions_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3257 --scenario inspector-actions
    fi
    primitive_color_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3257 --scenario primitive-color-inspector$'
    if [[ "${recipe}" =~ ${primitive_color_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3257 --scenario primitive-color-inspector
    fi
    stations_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3253 --scenario antenna-microstrip-stations( --dependency-workspace "([^"]+)")?[[:space:]]*$'
    object_material_editor_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3266 --scenario object-material-editor$'
    if [[ "${recipe}" =~ ${object_material_editor_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3266 --scenario object-material-editor
    fi
    regional_drive_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3272 --scenario antenna-regional-drive$'
    if [[ "${recipe}" =~ ${regional_drive_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3272 --scenario antenna-regional-drive
    fi
    drive_editor_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3265 --scenario antenna-drive-editor$'
    if [[ "${recipe}" =~ ${drive_editor_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3265 --scenario antenna-drive-editor
    fi
    if [[ "${recipe}" =~ ${stations_browser_pattern} ]]; then
      dependency_workspace="${BASH_REMATCH[2]:-}"
      if [[ -n "${dependency_workspace}" ]]; then
        exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3253 --scenario antenna-microstrip-stations --dependency-workspace "${dependency_workspace}"
      fi
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3253 --scenario antenna-microstrip-stations
    fi
    antenna_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3252 --scenario antenna-external-lead-inspection$'
    if [[ "${recipe}" =~ ${antenna_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3252 --scenario antenna-external-lead-inspection
    fi
    study_profile_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3256 --scenario study-execution-profile$'
    if [[ "${recipe}" =~ ${study_profile_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3256 --scenario study-execution-profile
    fi
    explorer_physics_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3259 --scenario explorer-physics-reporting$'
    if [[ "${recipe}" =~ ${explorer_physics_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3259 --scenario explorer-physics-reporting
    fi
    browser_recipe_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+"$'
    if [[ ! "${recipe}" =~ ${browser_recipe_pattern} ]]; then
      echo "[fullmag just] invalid pinned dataset browser recipe" >&2
      exit 2
    fi
    exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}"
    ;;
  *"scripts/verify_project_entrypoint_runtime.py"*)
    exec "${python_cmd}" "${script_dir}/verify_project_entrypoint_runtime.py" --repo-root "${repo_root}"
    ;;
  *"scripts/verify_project_python_runtime.py"*)
    exec "${python_cmd}" "${script_dir}/verify_project_python_runtime.py" --repo-root "${repo_root}"
    ;;
  *"scripts/verify_project_api_runtime.py"*)
    if [[ "${recipe}" == *"--include-project-run"* ]]; then
      exec "${python_cmd}" "${script_dir}/verify_project_api_runtime.py" --include-project-run --repo-root "${repo_root}"
    fi
    if [[ "${recipe}" == *"--include-websocket"* ]]; then
      exec "${python_cmd}" "${script_dir}/verify_project_api_runtime.py" --include-websocket --repo-root "${repo_root}"
    fi
    exec "${python_cmd}" "${script_dir}/verify_project_api_runtime.py" --repo-root "${repo_root}"
    ;;
  *"scripts/verify_resource_discovery_runtime.py"*)
    exec "${python_cmd}" "${script_dir}/verify_resource_discovery_runtime.py" --repo-root "${repo_root}"
    ;;
  *"scripts/verify_accepted_fdm_gpu_runtime.py"*)
    exec "${python_cmd}" "${script_dir}/verify_accepted_fdm_gpu_runtime.py" --repo-root "${repo_root}"
    ;;
  *"scripts/verify_project_active_run_runtime.py"*)
    frozen_active_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_project_active_run_runtime.py" --repo-root "[^"]+" --frozen-native-build-id "([0-9a-f]{64})"$'
    if [[ "${recipe}" =~ ${frozen_active_pattern} ]]; then
      if ! is_windows_shell; then
        echo "[fullmag just] frozen active-run verification requires Windows" >&2
        exit 2
      fi
      exec "${python_cmd}" "${script_dir}/verify_project_active_run_runtime.py" --repo-root "${repo_root}" --frozen-native-build-id "${BASH_REMATCH[1]}"
    fi
    if [[ "${recipe}" == *"--frozen-native-build-id"* ]]; then
      echo "[fullmag just] frozen active-run verification requires a lowercase SHA-256 build ID" >&2
      exit 2
    fi
    exec "${python_cmd}" "${script_dir}/verify_project_active_run_runtime.py" --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route project-application-check"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route project-application-check --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route project-application-test"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route project-application-test --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route project-entrypoint-check"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route project-entrypoint-check --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route cli-source-check"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route cli-source-check --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-source-check"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-source-check --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-service-source-check"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-service-source-check --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-resource-pool-check"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-resource-pool-check --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-resource-pool-discovery-smoke"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-resource-pool-discovery-smoke --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route runtime-control-tests"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route runtime-control-tests --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-worker-check"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-worker-check --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-supervisor-tests"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-tests --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-supervisor-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-supervisor-cancel-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-cancel-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-supervisor-prestart-cancel-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-prestart-cancel-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-supervisor-automatic-retry-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-automatic-retry-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-supervisor-retry-recovery-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-retry-recovery-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-supervisor-process-exit-recovery-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-supervisor-process-exit-recovery-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-pool-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-pool-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-discovery-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-discovery-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-persistent-cursor-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-persistent-cursor-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-parallel-resources-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-parallel-resources-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-resource-pool-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-resource-pool-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-dynamic-resource-pool-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-dynamic-resource-pool-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-resident-discovery-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-resident-discovery-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-resident-drain-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-resident-drain-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-accepted-scheduler-retry-e2e"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-accepted-scheduler-retry-e2e --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-preparation-tests"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-preparation-tests --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-project-run-tests"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-project-run-tests --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-recovery-tests"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-recovery-tests --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-scene-resource-tests"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-scene-resource-tests --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route authoring-contract-tests"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route authoring-contract-tests --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route authoring-scene-adapter-tests"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route authoring-scene-adapter-tests --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route api-openapi-codegen"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route api-openapi-codegen --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route fem-capability-contract"*)
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --route fem-capability-contract --repo-root "${repo_root}"
    ;;
  *"scripts/verify_session_persistence.py"*"--route"*)
    echo "Unsupported explicit verification route; refusing default session tests" >&2
    exit 2
    ;;
  *"scripts/verify_session_persistence.py"*"--repo-root"*)
    if [[ "${recipe}" == *"prepare-links"* || "${recipe}" == *"fullmag_storage.py"* || "${recipe}" == *"cargo test"* ]]; then
      echo "[fullmag just] invalid session persistence recipe body" >&2
      exit 2
    fi
    # Do not evaluate the recipe text here: a composite recipe must never be
    # able to smuggle a second command around the generic storage guard.
    exec "${python_cmd}" "${script_dir}/verify_session_persistence.py" --repo-root "${repo_root}"
    ;;
esac

# The Windows PowerShell launchers select their own storage profile and hold
# the core lock through the managed entrypoint.  Letting the generic Linux /
# Windows-native preflight create links first would select the wrong profile.
if is_windows_shell; then
  case "${recipe}" in
    *"scripts/windows/run_fullmag.ps1"*|*"scripts/windows/run_fullmag_fem.ps1"*|*"scripts/windows/run_fullmag_wsl.ps1"*|*"scripts/windows/setup_fullmag.ps1"*|*"scripts/windows/verify_fem_frequency_domain_native_contract.ps1"*|*"scripts/windows/build_windows_msi.ps1"*)
      exec "${bash_executable}" -euo pipefail -c "${recipe}"
      ;;
  esac
fi

# These legacy bodies would write outside the resolver's approved roots.  Stop
# before prepare-links or any child process can mutate the checkout.  Recipes
# can be migrated by replacing the literal with the exported resolver value.
case "${recipe}" in
  *"/tmp/fullmag-"*|*"/tmp/fullmag/"*|*"native/build"*)
    echo "[fullmag just] unsupported legacy storage path in recipe; use resolver-provided build/cache paths" >&2
    exit 2
    ;;
esac

# Compatibility links are only created after all destinations and existing
# source paths have been validated by the resolver.  Existing real paths are
# intentionally rejected so a legacy build cannot be overwritten implicitly.
# Frontend recipes also need the managed node_modules/Next/output links; keep
# this detection in step with the Make shell boundary because `just` recipes
# do not share an exported environment with a separate prerequisite.
prepare_args=(--compat)
case "${recipe}" in
  *"apps/control-room"*|*"WEB_APP_DIR"*|*"pnpm"*) prepare_args+=(--frontend) ;;
esac
"${python_cmd}" "${resolver}" prepare-links --repo-root "${repo_root}" "${prepare_args[@]}" >/dev/null

# Run the complete recipe body through the core runner.  This is the lock
# boundary: the runner resolves the same environment and holds the per-
# worktree OS lock until every nested bash/docker/cargo command has finished.
# Its owner token is inherited by nested `just` calls, which are reentrant.
# Git Bash otherwise rewrites POSIX-looking bind targets before Docker Desktop
# sees them.  Install a shell-local wrapper so only Docker invocations disable
# that conversion; resolver/Python commands still receive normal Windows paths.
run_recipe="${recipe}"
if is_windows_shell && [[ "${recipe}" == *"docker compose"* ]]; then
  run_recipe='docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }; '"${recipe}"
fi
exec "${python_cmd}" "${resolver}" run --repo-root "${repo_root}" -- \
  "${bash_executable}" -euo pipefail -c "${run_recipe}"
