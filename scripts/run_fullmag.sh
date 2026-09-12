#!/usr/bin/env bash
# Public fullmag command parser; keep the Windows process command line short.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
build="false"; force="false"; windows="false"; frontend="dev"; backend="auto"; device="auto"; run_mode="interactive"; script=""; web_port="3100"; skip_local_changes="false"; seen_options="";
for raw in "$@"; do
  [ -n "$raw" ] || continue;
  key="${raw%%=*}"; value="$raw"; if [ "$key" != "$raw" ]; then value="${raw#*=}"; fi;
  key_lc="$(printf "%s" "$key" | tr "[:upper:]" "[:lower:]")"; value_lc="$(printf "%s" "$value" | tr "[:upper:]" "[:lower:]")";
  option_id="";
  case "$key_lc" in
    --build|build|true|false) option_id="build" ;;
    --windows|windows) option_id="windows" ;;
    --force|force) option_id="force" ;;
    --skip_local_changes|skip_local_changes|--skip-local-changes|skip-local-changes) option_id="skip_local_changes" ;;
    --frontend|frontend|ui|--static|static|--dev|dev) option_id="frontend" ;;
    --backend|--discretization|--engine|backend|discretization|engine|--fem|fem|--fdm|fdm|--auto|auto) option_id="backend" ;;
    --device|--execution|device|execution|--gpu|gpu|--cpu|cpu) option_id="device" ;;
    --mode|--run_mode|mode|run_mode|--interactive|-i|interactive|--headless|headless) option_id="run_mode" ;;
    --script|script) option_id="script" ;;
    --web_port|--web-port|--port|web_port|web-port|port) option_id="web_port" ;;
  esac;
  if [ -n "$option_id" ]; then
    case ",$seen_options," in *",$option_id,"*) echo "duplicate fullmag option: $raw" >&2; exit 2 ;; esac;
    seen_options="${seen_options},${option_id}";
  fi;
  case "$key_lc" in
    --build|build) build="$value_lc" ;;
    --windows|windows) windows="$value_lc" ;;
    --force|force) if [ "$key" = "$raw" ]; then force="true"; else force="$value_lc"; fi ;;
    --skip_local_changes|skip_local_changes|--skip-local-changes|skip-local-changes) if [ "$key" = "$raw" ]; then skip_local_changes="true"; else skip_local_changes="$value_lc"; fi ;;
    --frontend|frontend|ui) frontend="$value_lc" ;;
    --backend|--discretization|--engine|backend|discretization|engine) backend="$value_lc" ;;
    --device|--execution|device|execution) device="$value_lc" ;;
    --mode|--run_mode|mode|run_mode) run_mode="$value_lc" ;;
    --script|script) script="$value" ;;
    --web_port|--web-port|--port|web_port|web-port|port) web_port="$value" ;;
    --static|static) frontend="static" ;;
    --dev|dev) frontend="dev" ;;
    --fem|fem) backend="fem" ;;
    --fdm|fdm) backend="fdm" ;;
    --auto|auto) backend="auto" ;;
    --gpu|gpu) device="gpu" ;;
    --cpu|cpu) device="cpu" ;;
    --interactive|-i|interactive) run_mode="interactive" ;;
    --headless|headless) run_mode="headless" ;;
    true|false) build="$key_lc" ;;
    *)
      case "$raw" in -*|*=*) echo "unknown fullmag option: $raw" >&2; exit 2 ;; esac;
      if [ -n "$script" ]; then echo "multiple script paths supplied: $script and $raw" >&2; exit 2; fi;
      case "$raw" in *.py|*/*|*\\*) script="$raw" ;; *) echo "unknown fullmag argument: $raw (expected a .py script path or a named option)" >&2; exit 2 ;; esac;
      ;;
  esac;
done;
case "$build" in 1|true|yes|on) build="true" ;; 0|false|no|off) build="false" ;; *) echo "unsupported build value: $build (expected true or false)" >&2; exit 2 ;; esac;
case "$windows" in 1|true|yes|on) windows="true" ;; 0|false|no|off) windows="false" ;; *) echo "unsupported windows value: $windows (expected true or false)" >&2; exit 2 ;; esac;
case "$force" in 1|true|yes|on) force="true"; build="true" ;; 0|false|no|off) force="false" ;; *) echo "unsupported force value: $force (expected true or false)" >&2; exit 2 ;; esac;
case "$skip_local_changes" in 1|true|yes|on) skip_local_changes="true" ;; 0|false|no|off) skip_local_changes="false" ;; *) echo "unsupported skip_local_changes value: $skip_local_changes (expected true or false)" >&2; exit 2 ;; esac;
case "$frontend" in static|dev) ;; *) echo "unsupported frontend mode: $frontend (expected static or dev)" >&2; exit 2 ;; esac;
case "$backend" in fem|fdm|auto) ;; *) echo "unsupported backend: $backend (expected fem, fdm, or auto)" >&2; exit 2 ;; esac;
case "$device" in gpu|cpu|auto) ;; *) echo "unsupported device: $device (expected gpu, cpu, or auto)" >&2; exit 2 ;; esac;
case "$run_mode" in interactive|headless) ;; *) echo "unsupported run mode: $run_mode (expected interactive or headless)" >&2; exit 2 ;; esac;
if [ -z "$script" ]; then echo "missing script path; example: just fullmag windows=True build=True dev fdm gpu ./examples/permalloy_layer_bimeron_prism_single_layer_relax_300nm.py" >&2; exit 2; fi;
if [ ! -f "$script" ]; then echo "script not found: $script" >&2; exit 2; fi;
skip_local_changes_args=(); if [ "$skip_local_changes" = "true" ]; then skip_local_changes_args=(-SkipLocalChanges); fi;
host_windows="false";
case "$(uname -s 2>/dev/null || true)" in MINGW*|MSYS*|CYGWIN*) host_windows="true" ;; esac;
if [ "$backend" = "fem" ] && { [ "$windows" = "true" ] || [ "$host_windows" = "true" ]; }; then
  exec powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${repo_root}/scripts/windows/run_fullmag_fem.ps1" -BuildMode "$build" -Frontend "$frontend" -Backend "$backend" -Device "$device" -RunMode "$run_mode" -ScriptPath "$script" -WebPort "$web_port" "${skip_local_changes_args[@]}";
fi;
if [ "$windows" = "true" ] || [ "$host_windows" = "true" ]; then
  exec powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${repo_root}/scripts/windows/run_fullmag.ps1" -BuildMode "$build" -Frontend "$frontend" -Backend "$backend" -Device "$device" -RunMode "$run_mode" -ScriptPath "$script" -WebPort "$web_port" "${skip_local_changes_args[@]}";
fi;
if [ "$build" = "true" ]; then just ensure-python; elif [ ! -x "${repo_root}/.fullmag/local/python/bin/python" ]; then echo "Python env is missing; run with build=True or force=True once." >&2; exit 2; fi;
if [ "$frontend" = "static" ]; then
  if [ "$force" = "true" ]; then make web-build-static;
  elif [ "$build" = "true" ]; then just build-static-control-room;
  elif [ ! -f "${repo_root}/.fullmag/local/web/index.html" ] && [ ! -f "${repo_root}/apps/control-room/out/index.html" ]; then echo "Static control room is missing; run with build=True or force=True once." >&2; exit 2; fi;
fi;
if [ "$backend" = "fem" ]; then
  runtime_copy_helper="${repo_root}/scripts/lib/runtime_bundle_copy.sh";
  test -f "$runtime_copy_helper" || { echo "managed FEM runtime copy helper is missing: $runtime_copy_helper" >&2; exit 2; };
  if [ "$force" = "true" ]; then just rebuild-fem-runtime; else just ensure-managed-fem-runtime; fi;
  bin="${repo_root}/.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu"; path_prefix="";
else
  if [ "$force" = "true" ]; then
    if [ "$backend" = "fdm" ]; then FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 just build fullmag; else just build fullmag; fi;
  elif [ "$build" = "true" ]; then
    if [ "$backend" = "fdm" ]; then FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 just build fullmag; else just build fullmag; fi;
  elif [ ! -x "${repo_root}/.fullmag/local/bin/fullmag" ]; then echo "Fullmag binary is missing; run with build=True or force=True once." >&2; exit 2; fi;
  bin="${repo_root}/.fullmag/local/bin/fullmag"; path_prefix="${repo_root}/.fullmag/local/bin:$PATH";
fi;
env_args=(FULLMAG_PYTHON="${repo_root}/.fullmag/local/python/bin/python");
if [ -n "$path_prefix" ]; then env_args+=(PATH="$path_prefix"); fi;
if [ "$run_mode" = "headless" ]; then env_args+=(FULLMAG_API_PORT=0); fi;
if [ "$backend" = "fem" ]; then env_args+=(FULLMAG_FDM_EXECUTION=cpu); fi;
if [ "$backend" = "fem" ] && [ "$device" != "auto" ]; then env_args+=(FULLMAG_FEM_EXECUTION="$device" FULLMAG_RELAX_DEVICE="$device"); fi;
if [ "$backend" = "fdm" ] && [ "$device" != "auto" ]; then env_args+=(FULLMAG_FDM_EXECUTION="$device"); fi;
cli_args=("$script");
if [ "$backend" != "auto" ]; then cli_args+=(--backend "$backend"); fi;
if [ "$run_mode" = "headless" ]; then cli_args+=(--headless --json); else if [ "$frontend" = "dev" ]; then cli_args=(--dev -i "${cli_args[@]}"); else cli_args=(-i "${cli_args[@]}"); fi; cli_args+=(--web-port "$web_port"); fi;
env "${env_args[@]}" "$bin" "${cli_args[@]}"

