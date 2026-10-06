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

recipe="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
resolver="${repo_root}/scripts/fullmag_storage.py"
python_cmd=""
if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; assert sys.version_info.major == 3' >/dev/null 2>&1; then
  python_cmd="$(command -v python3)"
elif command -v python >/dev/null 2>&1 && python -c 'import sys; assert sys.version_info.major == 3' >/dev/null 2>&1; then
  python_cmd="$(command -v python)"
else
  echo "[fullmag just] Python is required for the storage resolver" >&2
  exit 2
fi

if [ ! -f "${resolver}" ]; then
  echo "[fullmag just] common storage resolver is missing: ${resolver}" >&2
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

# Admit this fixed helper before generic diagnostic substring handling, so a
# composite command cannot use a diagnostic marker to bypass its argument check.
case "${recipe}" in
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
  *"scripts/windows/watch_backend.py"*)
    backend_watch_pattern='^python "[^"]+/scripts/windows/watch_backend.py" --repo-root "[^"]+" --web-port "([1-9][0-9]{0,4})"$'
    if [[ ! "${recipe}" =~ ${backend_watch_pattern} ]]; then
      echo "[fullmag just] invalid native backend watcher recipe" >&2
      exit 2
    fi
    web_port="${BASH_REMATCH[1]}"
    if ! is_windows_shell || (( web_port > 65535 )); then
      echo "[fullmag just] native backend watcher requires Windows and a port from 1 to 65535" >&2
      exit 2
    fi
    # The watcher acquires its own closed watch lease and delegates each build
    # to run-windows-workspace-build; do not wrap its lifetime in the generic
    # worktree build lock.
    exec "${python_cmd}" "${script_dir}/windows/watch_backend.py" --repo-root "${repo_root}" --web-port "${web_port}"
    ;;
  *"scripts/export_runner_openapi.py"*)
    export_openapi_pattern='^[^[:space:]]+ "[^"]+/scripts/export_runner_openapi.py" --repo-root "[^"]+" --job-id "([0-9a-f]{32})" --expected-commit "([0-9a-f]{40})"$'
    if [[ ! "${recipe}" =~ ${export_openapi_pattern} ]]; then
      echo "[fullmag just] invalid managed OpenAPI export recipe" >&2
      exit 2
    fi
    # The helper owns read-only admission, path checks and its terminal proof.
    # Invoke only this checkout's helper, never the supplied recipe text.
    exec "${python_cmd}" "${script_dir}/export_runner_openapi.py" --repo-root "${repo_root}" --job-id "${BASH_REMATCH[1]}" --expected-commit "${BASH_REMATCH[2]}"
    ;;
    *"scripts/verify_development_backend_api.py"*)
    frozen_native_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --frozen-native-build-id "([0-9a-f]{64})"$'
    if [[ "${recipe}" =~ ${frozen_native_pattern} ]]; then
      if ! is_windows_shell; then
        echo "[fullmag just] frozen native package verification requires Windows" >&2
        exit 2
      fi
      exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --frozen-native-build-id "${BASH_REMATCH[1]}"
    fi
      workspace_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --workspace-browser-owner-bundle "([0-9a-f]{32})"$'
      if [[ "${recipe}" =~ ${workspace_browser_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --workspace-browser-owner-bundle "${BASH_REMATCH[1]}"
      fi
      candidate_preparation_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --candidate-preparation-only$'
      if [[ "${recipe}" =~ ${candidate_preparation_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --candidate-preparation-only
      fi
      consumer_pump_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --consumer-pump-owner-bundle "([0-9a-f]{32})"$'
      active_run_refusal_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --active-run-refusal-owner-bundle "([0-9a-f]{32})"$'
      if [[ "${recipe}" =~ ${active_run_refusal_pattern} ]]; then
        if ! is_windows_shell; then
          echo "[fullmag just] active-run restart verification requires Windows" >&2
          exit 2
        fi
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --active-run-refusal-owner-bundle "${BASH_REMATCH[1]}"
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
      restart_transport_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --restart-transport-only$'
      if [[ "${recipe}" =~ ${restart_transport_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --restart-transport-only
      fi
      project_document_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --project-document-only$'
      if [[ "${recipe}" =~ ${project_document_pattern} ]]; then
        exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --project-document-only
      fi
      development_api_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_development_backend_api.py" --repo-root "[^"]+" --cross-build-bundle "([0-9a-f]{32})?"$'
      if [[ ! "${recipe}" =~ ${development_api_pattern} ]]; then
        echo "[fullmag just] invalid development API check recipe" >&2
        exit 2
      fi
      exec "${python_cmd}" "${script_dir}/verify_development_backend_api.py" --repo-root "${repo_root}" --cross-build-bundle "${BASH_REMATCH[1]:-}"
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
  FULLMAG_STORAGE_PYTHON="${python_cmd}" exec bash -euo pipefail -c "${recipe}"
fi
case "${recipe}" in
  *"just --list"*|*"just --list --"*) exec bash -euo pipefail -c "${recipe}" ;;
esac

# Read-only capability matrix validation has no mutable project path. Keep it
# outside compatibility-link preparation, just like the fixed Rust routes.
case "${recipe}" in
  *"scripts/validate_mixed_p1_capability_contract.py"*|*"scripts.test_validate_mixed_p1_capability_contract"*)
    exec bash -euo pipefail -c "${recipe}"
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
esac

# These plain-Rust package routes have fixed commands and own their resolver
# paths/lock inside the dedicated helper. Do not run the generic compatibility-
# link or heavy-build wrapper for them.
case "${recipe}" in
  *"scripts/run_managed_browser.py"*)
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
    restart_action_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3254 --scenario development-restart-action$'
    if [[ "${recipe}" =~ ${restart_action_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3254 --scenario development-restart-action
    fi
    outcome_handoff_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3253 --scenario development-run-outcome-handoff$'
    if [[ "${recipe}" =~ ${outcome_handoff_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3253 --scenario development-run-outcome-handoff
    fi
    kernel_host_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3252 --scenario development-kernel-host$'
    if [[ "${recipe}" =~ ${kernel_host_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3252 --scenario development-kernel-host
    fi
    project_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3251 --scenario project-document-handoff$'
    if [[ "${recipe}" =~ ${project_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3251 --scenario project-document-handoff
    fi
    study_profile_browser_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+" --port 3256 --scenario study-execution-profile$'
    if [[ "${recipe}" =~ ${study_profile_browser_pattern} ]]; then
      exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}" --port 3256 --scenario study-execution-profile
    fi
    browser_recipe_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_pinned_dataset_browser.py" --repo-root "[^"]+"$'
    if [[ ! "${recipe}" =~ ${browser_recipe_pattern} ]]; then
      echo "[fullmag just] invalid pinned dataset browser recipe" >&2
      exit 2
    fi
    exec "${python_cmd}" "${script_dir}/verify_pinned_dataset_browser.py" --repo-root "${repo_root}"
    ;;
  *"scripts/verify_control_room_sources.py"*)
    # Never execute the recipe text: accept only the fixed argument shape and
    # invoke the trusted helper from this checkout with the selected route.
    source_recipe_pattern='^[^[:space:]]+ "[^"]+/scripts/verify_control_room_sources.py" --route (generate-client|production-source|api-hygiene|lint|openapi-import-check|react-doctor|development-restart-check|resource-client-cache-check|development-kernel-host-check|development-transport-pause-check|development-run-outcome-handoff-check|development-run-outcome-handoff-lint|development-restart-action-check|development-restart-action-lint|development-backend-build-action-check) --repo-root "[^"]+"$'
    if [[ ! "${recipe}" =~ ${source_recipe_pattern} ]]; then
      echo "[fullmag just] invalid lightweight frontend recipe" >&2
      exit 2
    fi
    exec "${python_cmd}" "${script_dir}/verify_control_room_sources.py" --route "${BASH_REMATCH[1]}" --repo-root "${repo_root}"
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
      exec bash -euo pipefail -c "${recipe}"
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
shell_cmd="$(command -v bash)"
if is_windows_shell; then
  # Native Python resolves an unqualified `bash` independently of Git Bash
  # and can select the Windows WSL launcher. Preserve this exact shell.
  shell_cmd="$(cygpath -w "${shell_cmd}")"
fi
exec "${python_cmd}" "${resolver}" run --repo-root "${repo_root}" -- \
  "${shell_cmd}" -euo pipefail -c "${recipe}"
