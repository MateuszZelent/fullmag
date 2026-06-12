set shell := ["bash", "-euo", "pipefail", "-c"]

repo_root := justfile_directory()
local_bin := repo_root + "/.fullmag/local/bin"
repo_python := repo_root + "/.fullmag/local/python/bin/python"
local_web_root := repo_root + "/.fullmag/local/web"
control_room_static_out := repo_root + "/apps/control-room/out"

default:
    @just --list

help:
    @just --list

ensure-python:
    mkdir -p "{{repo_root}}/.fullmag/local"
    if [ ! -x "{{repo_python}}" ]; then python3 -m venv "{{repo_root}}/.fullmag/local/python"; fi
    "{{repo_python}}" -m pip install 'numpy>=1.24' 'scipy>=1.10' 'gmsh>=4.12' 'meshio>=5.3' 'trimesh>=4.2' 'h5py>=3.8' 'zarr>=2.18,<3' 'rich>=13.7'

build target="fullmag" cpu_only="0":
    bash -euo pipefail -c 'target="{{target}}"; cpu_only="{{cpu_only}}"; case "$target" in target=*) target="${target#target=}" ;; --target=*) target="${target#--target=}" ;; esac; case "$cpu_only" in 1|true|TRUE|on|ON|yes|YES|y|Y) cpu_only="1" ;; 0|false|FALSE|off|OFF|no|NO|n|N|"") cpu_only="0" ;; *) cpu_only="0" ;; esac; if [ "$target" = "fullmag" ]; then FULLMAG_BUILD_CPU_ONLY="$cpu_only" make install-cli; elif [ "$target" = "fullmag-static" ]; then FULLMAG_BUILD_CPU_ONLY="$cpu_only" make install-cli-static; elif [ "$target" = "fullmag-dev" ]; then FULLMAG_BUILD_CPU_ONLY="$cpu_only" make install-cli-dev; elif [ "$target" = "fullmag-host" ]; then make install-cli; elif [ "$target" = "dev-image" ]; then docker compose build dev; elif [ "$target" = "fem-gpu-runtime" ]; then docker compose --profile fem-gpu build fem-gpu; elif [ "$target" = "fem-gpu-runtime-host" ]; then ./scripts/export_fem_gpu_runtime.sh; else echo "unknown build target: $target" >&2; echo "supported targets: fullmag, fullmag-static, fullmag-dev, fullmag-host, dev-image, fem-gpu-runtime, fem-gpu-runtime-host" >&2; exit 1; fi'

build-static-control-room:
    make web-build-static-if-needed

build-desktop:
    cargo build --release -p fullmag-desktop
    mkdir -p "{{local_bin}}"
    cp target/release/fullmag-ui "{{local_bin}}/"

build-desktop-linux-docker:
    ./scripts/build_desktop_linux_container.sh

package-installer-linux-docker:
    ./scripts/build_installer_linux_container.sh

check-desktop-linux-deps:
    ./scripts/check_linux_desktop_deps.sh

build-desktop-container:
    ./scripts/build_desktop_linux_container.sh

package-installer-linux:
    just package fullmag-portable
    ./scripts/build_installer_linux.sh

package-installer-windows-container:
    ./scripts/windows/build_installer_windows_container.sh

package-installer-windows-docker:
    ./scripts/windows/build_installer_windows_container.sh

package target="fullmag":
    if [ "{{target}}" = "fullmag" ] || [ "{{target}}" = "fullmag-host" ]; then ./scripts/package_fullmag_host.sh; \
    elif [ "{{target}}" = "fullmag-portable" ]; then \
      just ensure-python; \
      if [ ! -x ".fullmag/local/bin/fullmag-bin" ] || [ ! -x ".fullmag/local/bin/fullmag-api" ] || [ ! -e ".fullmag/local/lib/libfullmag_fdm.so.0" ]; then \
        FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 just build fullmag; \
      fi; \
      just build-static-control-room; \
      ./scripts/package_fullmag_portable.sh; \
    \
    else echo "unknown package target: {{target}}" >&2; echo "supported targets: fullmag, fullmag-host, fullmag-portable" >&2; exit 1; fi

check:
    cargo +nightly check --workspace --exclude fullmag-desktop

test:
    cargo +nightly test --workspace --exclude fullmag-desktop

test-desktop:
    just check-desktop-linux-deps
    cargo +nightly test -p fullmag-desktop

repo-check:
    python3 scripts/check_repo_consistency.py

verify-fem-meshing-production:
    bash scripts/verify_fem_meshing_production.sh

verify-fem-relaxation-source-contract:
    cmake --build native/build --target fem_relaxation_source_contract
    native/build/backends/fem/fem_relaxation_source_contract

verify-fem-frequency-domain-native-contract:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake --build native/build --target fem_frequency_domain_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_frequency_domain_contract'

verify-fem-frequency-domain-runtime:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-runtime
    mkdir -p .fullmag/reports/frequency-domain-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      fem-gpu bash -lc 'cd /workspace && \
        rm -rf .fullmag/reports/frequency-domain-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/diagnostics.v1.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/field_payloads/frequency_0000/vector.bin && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py .fullmag/reports/frequency-domain-runtime/artifacts'

verify-fem-relaxation-runtime:
    bash scripts/verify_fem_relaxation_runtime.sh

verify-fem-relaxation-convergence:
    FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-16}" \
    FULLMAG_FEM_RELAXATION_MIN_STEPS="${FULLMAG_FEM_RELAXATION_MIN_STEPS:-16}" \
    FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE="${FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE:-1e-2}" \
    FULLMAG_FEM_RELAXATION_MAX_FINAL_TORQUE_GROWTH_FACTOR="${FULLMAG_FEM_RELAXATION_MAX_FINAL_TORQUE_GROWTH_FACTOR:-1.25}" \
    bash scripts/verify_fem_relaxation_runtime.sh

verify-fem-relaxation-cpu-gpu-consistency-smoke:
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_BENCH_INTEGRATORS="${FULLMAG_BENCH_INTEGRATORS:-heun}" \
      -e FULLMAG_BENCH_RELAX_ALGORITHMS="${FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg}" \
      -e FULLMAG_BENCH_STEPS="${FULLMAG_BENCH_STEPS:-16}" \
      -e FULLMAG_BENCH_CASE_TIMEOUT_S="${FULLMAG_BENCH_CASE_TIMEOUT_S:-300}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-30}" \
      -e FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_OUTPUT="${FULLMAG_BENCH_OUTPUT:-.fullmag/reports/fullmag_relaxation_cpu_gpu_consistency_smoke.csv}" \
      -e FULLMAG_BENCH_SUMMARY="${FULLMAG_BENCH_SUMMARY:-.fullmag/reports/fullmag_relaxation_cpu_gpu_consistency_smoke_summary.json}" \
      -e FULLMAG_BENCH_DOMAIN_HMAX="${FULLMAG_BENCH_DOMAIN_HMAX:-250e-9}" \
      -e FULLMAG_BENCH_AIRBOX_HMAX="${FULLMAG_BENCH_AIRBOX_HMAX:-500e-9}" \
      fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/fem_gpu_benchmark.py \
        --box500-airbox-exchange-only-preset \
        --integrators "$FULLMAG_BENCH_INTEGRATORS" \
        --relax-algorithms "$FULLMAG_BENCH_RELAX_ALGORITHMS" \
        --steps "$FULLMAG_BENCH_STEPS" \
        --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
        --cpu-gpu-energy-rtol "$FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL" \
        --cpu-gpu-energy-atol "$FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J" \
        --cpu-gpu-torque-rtol "$FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL" \
        --output "$FULLMAG_BENCH_OUTPUT" \
        --cpu-gpu-summary-output "$FULLMAG_BENCH_SUMMARY" \
        --quiet-json-summary \
        --require-cpu-gpu-consistency'

verify-fem-relaxation-production-benchmark:
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_BENCH_DOMAIN_HMAX="${FULLMAG_BENCH_DOMAIN_HMAX:-250e-9}" \
      -e FULLMAG_BENCH_AIRBOX_HMAX="${FULLMAG_BENCH_AIRBOX_HMAX:-500e-9}" \
      -e FULLMAG_BENCH_INTEGRATORS="${FULLMAG_BENCH_INTEGRATORS:-heun}" \
      -e FULLMAG_BENCH_RELAX_ALGORITHMS="${FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg}" \
      -e FULLMAG_BENCH_DEMAG_SOLVERS="${FULLMAG_BENCH_DEMAG_SOLVERS:-CG}" \
      -e FULLMAG_BENCH_DEMAG_PRECONDITIONERS="${FULLMAG_BENCH_DEMAG_PRECONDITIONERS:-AMG,JACOBI}" \
      -e FULLMAG_BENCH_STEPS="${FULLMAG_BENCH_STEPS:-32}" \
      -e FULLMAG_BENCH_CASE_TIMEOUT_S="${FULLMAG_BENCH_CASE_TIMEOUT_S:-600}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-30}" \
      -e FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP:-4}" \
      -e FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP:-0}" \
      -e FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP:-3}" \
      -e FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP:-2}" \
      -e FULLMAG_BENCH_MIN_SOLVER_NODES="${FULLMAG_BENCH_MIN_SOLVER_NODES:-50}" \
      -e FULLMAG_BENCH_OUTPUT="${FULLMAG_BENCH_OUTPUT:-.fullmag/reports/fullmag_relaxation_production_benchmark.csv}" \
      -e FULLMAG_BENCH_SUMMARY="${FULLMAG_BENCH_SUMMARY:-.fullmag/reports/fullmag_relaxation_production_benchmark_summary.json}" \
      -e FULLMAG_FEM_STEP_PROFILE="${FULLMAG_FEM_STEP_PROFILE:-}" \
      -e FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC="${FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC:-1}" \
      fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/fem_gpu_benchmark.py \
        --box500-airbox-interaction-consistency-preset \
        --integrators "$FULLMAG_BENCH_INTEGRATORS" \
        --relax-algorithms "$FULLMAG_BENCH_RELAX_ALGORITHMS" \
        --demag-solvers "$FULLMAG_BENCH_DEMAG_SOLVERS" \
        --demag-preconditioners "$FULLMAG_BENCH_DEMAG_PRECONDITIONERS" \
        --steps "$FULLMAG_BENCH_STEPS" \
        --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
        --cpu-gpu-energy-rtol "$FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL" \
        --cpu-gpu-energy-atol "$FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J" \
        --cpu-gpu-torque-rtol "$FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL" \
        --output "$FULLMAG_BENCH_OUTPUT" \
        --cpu-gpu-summary-output "$FULLMAG_BENCH_SUMMARY" \
        --quiet-json-summary \
        --require-adaptive-gpu-rk-acceptance \
        --emit-best-demag-policy \
        --require-best-demag-policy \
        --require-gpu-control-readback-budget \
        --require-gpu-phase-timings \
        --gpu-control-readback-per-step "$FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP" \
        --gpu-llg-control-readback-per-step "$FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP" \
        --gpu-pgbb-control-readback-per-step "$FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP" \
        --gpu-ncg-control-readback-per-step "$FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP" \
        --require-min-solver-nodes "$FULLMAG_BENCH_MIN_SOLVER_NODES" \
        --require-demag-converged \
        --require-cpu-gpu-consistency \
        --require-gpu-strict-residency'

verify-fem-gpu-demag-performance-benchmark:
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_BENCH_DOMAIN_HMAX="${FULLMAG_BENCH_DOMAIN_HMAX:-50e-9}" \
      -e FULLMAG_BENCH_AIRBOX_HMAX="${FULLMAG_BENCH_AIRBOX_HMAX:-100e-9}" \
      -e FULLMAG_BENCH_SCENARIOS="${FULLMAG_BENCH_SCENARIOS:-box500_airbox_exchange_demag,box500_airbox_exchange_demag_anis_uniaxial,box500_airbox_exchange_demag_anis_cubic}" \
      -e FULLMAG_BENCH_INTEGRATORS="${FULLMAG_BENCH_INTEGRATORS:-heun}" \
      -e FULLMAG_BENCH_RELAX_ALGORITHMS="${FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,nonlinear_cg}" \
      -e FULLMAG_BENCH_DEMAG_SOLVERS="${FULLMAG_BENCH_DEMAG_SOLVERS:-CG}" \
      -e FULLMAG_BENCH_DEMAG_PRECONDITIONERS="${FULLMAG_BENCH_DEMAG_PRECONDITIONERS:-OMIT,AMG,JACOBI}" \
      -e FULLMAG_BENCH_STEPS="${FULLMAG_BENCH_STEPS:-4}" \
      -e FULLMAG_BENCH_CASE_TIMEOUT_S="${FULLMAG_BENCH_CASE_TIMEOUT_S:-900}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-30}" \
      -e FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP:-4}" \
      -e FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP:-0}" \
      -e FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP:-2}" \
      -e FULLMAG_BENCH_MIN_SOLVER_NODES="${FULLMAG_BENCH_MIN_SOLVER_NODES:-800}" \
      -e FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP="${FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP:-2}" \
      -e FULLMAG_BENCH_ACCEPTED_BASELINE="${FULLMAG_BENCH_ACCEPTED_BASELINE:-}" \
      -e FULLMAG_BENCH_REQUIRE_ACCEPTED_BASELINE="${FULLMAG_BENCH_REQUIRE_ACCEPTED_BASELINE:-0}" \
      -e FULLMAG_BENCH_MAX_PERFORMANCE_REGRESSION_PERCENT="${FULLMAG_BENCH_MAX_PERFORMANCE_REGRESSION_PERCENT:-10}" \
      -e FULLMAG_BENCH_OUTPUT="${FULLMAG_BENCH_OUTPUT:-.fullmag/reports/fullmag_fem_gpu_demag_performance_benchmark.csv}" \
      -e FULLMAG_BENCH_SUMMARY="${FULLMAG_BENCH_SUMMARY:-.fullmag/reports/fullmag_fem_gpu_demag_performance_benchmark_summary.json}" \
      -e FULLMAG_FEM_STEP_PROFILE="${FULLMAG_FEM_STEP_PROFILE:-1}" \
      -e FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC="${FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC:-1}" \
      fem-gpu bash -lc 'cd /workspace && \
        baseline_args=(); \
        if [ -n "$FULLMAG_BENCH_ACCEPTED_BASELINE" ]; then baseline_args+=(--accepted-baseline "$FULLMAG_BENCH_ACCEPTED_BASELINE"); fi; \
        if [ "$FULLMAG_BENCH_REQUIRE_ACCEPTED_BASELINE" = "1" ]; then baseline_args+=(--require-accepted-baseline); fi; \
        python3 scripts/analysis/fem_gpu_benchmark.py \
        --meshes coarse \
        --scenarios "$FULLMAG_BENCH_SCENARIOS" \
        --integrators "$FULLMAG_BENCH_INTEGRATORS" \
        --relax-algorithms "$FULLMAG_BENCH_RELAX_ALGORITHMS" \
        --demag-solvers "$FULLMAG_BENCH_DEMAG_SOLVERS" \
        --demag-preconditioners "$FULLMAG_BENCH_DEMAG_PRECONDITIONERS" \
        --steps "$FULLMAG_BENCH_STEPS" \
        --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
        --cpu-gpu-energy-rtol "$FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL" \
        --cpu-gpu-energy-atol "$FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J" \
        --cpu-gpu-torque-rtol "$FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL" \
        --output "$FULLMAG_BENCH_OUTPUT" \
        --cpu-gpu-summary-output "$FULLMAG_BENCH_SUMMARY" \
        --quiet-json-summary \
        --gpu-warmup \
        --require-adaptive-gpu-rk-acceptance \
        --emit-best-demag-policy \
        --require-best-demag-policy \
        --require-gpu-control-readback-budget \
        --require-gpu-phase-timings \
        --gpu-control-readback-per-step "$FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP" \
        --gpu-llg-control-readback-per-step "$FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP" \
        --gpu-ncg-control-readback-per-step "$FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP" \
        --require-min-solver-nodes "$FULLMAG_BENCH_MIN_SOLVER_NODES" \
        --min-gpu-demag-total-speedup "$FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP" \
        --require-demag-converged \
        --require-cpu-gpu-consistency \
        --require-gpu-strict-residency \
        --max-performance-regression-percent "$FULLMAG_BENCH_MAX_PERFORMANCE_REGRESSION_PERCENT" \
        "${baseline_args[@]}"'

resource-first-gates mode="strict":
    if [ "{{mode}}" = "report" ]; then ./scripts/ci-resource-first-gates.sh --report; \
    else ./scripts/ci-resource-first-gates.sh --strict; fi

control-room session="":
    if [ -n "{{session}}" ]; then ./scripts/dev-control-room.sh "{{session}}"; else ./scripts/dev-control-room.sh; fi

control-room-v2:
    ./scripts/dev-control-room-v2.sh

control-room-stop:
    ./scripts/stop-control-room.sh

run script:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag {{script}}

run-interactive script:
    just ensure-python
    just build fullmag
    just build-static-control-room
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag -i {{script}}

run-headless script:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag {{script}} --headless --json

# Run headless without 3D preview or chart data (no rendering overhead — good for benchmarks)
run-headless-bench script:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    fullmag {{script}} --headless --json

fullmag opt_1="" opt_2="" opt_3="" opt_4="" opt_5="" opt_6="" opt_7="" opt_8="":
    bash -euo pipefail -c '\
      build="false"; force="false"; frontend="dev"; backend="auto"; device="auto"; run_mode="interactive"; script=""; web_port="3100"; \
      for raw in "{{opt_1}}" "{{opt_2}}" "{{opt_3}}" "{{opt_4}}" "{{opt_5}}" "{{opt_6}}" "{{opt_7}}" "{{opt_8}}"; do \
        [ -n "$raw" ] || continue; \
        key="${raw%%=*}"; value="$raw"; if [ "$key" != "$raw" ]; then value="${raw#*=}"; fi; \
        key_lc="$(printf "%s" "$key" | tr "[:upper:]" "[:lower:]")"; value_lc="$(printf "%s" "$value" | tr "[:upper:]" "[:lower:]")"; \
        case "$key_lc" in \
          build) build="$value_lc" ;; \
          force) force="$value_lc" ;; \
          frontend|ui) frontend="$value_lc" ;; \
          backend|discretization|engine) backend="$value_lc" ;; \
          device|execution) device="$value_lc" ;; \
          mode|run_mode) run_mode="$value_lc" ;; \
          script) script="$value" ;; \
          web_port|web-port|port) web_port="$value" ;; \
          static|dev) frontend="$key_lc" ;; \
          fem|fdm|auto) backend="$key_lc" ;; \
          gpu|cpu) device="$key_lc" ;; \
          interactive|headless) run_mode="$key_lc" ;; \
          true|false) build="$key_lc" ;; \
          *) script="$raw" ;; \
        esac; \
      done; \
      case "$build" in 1|true|yes|on) build="true" ;; 0|false|no|off) build="false" ;; *) echo "unsupported build value: $build (expected true or false)" >&2; exit 2 ;; esac; \
      case "$force" in 1|true|yes|on) force="true"; build="true" ;; 0|false|no|off) force="false" ;; *) echo "unsupported force value: $force (expected true or false)" >&2; exit 2 ;; esac; \
      case "$frontend" in static|dev) ;; *) echo "unsupported frontend mode: $frontend (expected static or dev)" >&2; exit 2 ;; esac; \
      case "$backend" in fem|fdm|auto) ;; *) echo "unsupported backend: $backend (expected fem, fdm, or auto)" >&2; exit 2 ;; esac; \
      case "$device" in gpu|cpu|auto) ;; *) echo "unsupported device: $device (expected gpu, cpu, or auto)" >&2; exit 2 ;; esac; \
      case "$run_mode" in interactive|headless) ;; *) echo "unsupported run mode: $run_mode (expected interactive or headless)" >&2; exit 2 ;; esac; \
      if [ -z "$script" ]; then echo "missing script path; example: just fullmag build=False static fem gpu examples/permalloy_skyrmion_relax_300x1000x10nm.py" >&2; exit 2; fi; \
      if [ ! -f "$script" ]; then echo "script not found: $script" >&2; exit 2; fi; \
      if [ "$build" = "true" ]; then just ensure-python; elif [ ! -x "{{repo_python}}" ]; then echo "Python env is missing; run with build=True or force=True once." >&2; exit 2; fi; \
      if [ "$frontend" = "static" ]; then \
        if [ "$force" = "true" ]; then make web-build-static; \
        elif [ "$build" = "true" ]; then just build-static-control-room; \
        elif [ ! -f "{{local_web_root}}/index.html" ] && [ ! -f "{{control_room_static_out}}/index.html" ]; then echo "Static control room is missing; run with build=True or force=True once." >&2; exit 2; fi; \
      fi; \
      if [ "$backend" = "fem" ]; then \
        if [ "$force" = "true" ]; then just rebuild-fem-runtime; \
        elif [ "$build" = "true" ]; then just ensure-managed-fem-runtime; \
        elif [ ! -x "{{gpu_runtime_bin}}" ]; then echo "Managed FEM runtime is missing; run with build=True or force=True once." >&2; exit 2; fi; \
        bin="{{gpu_runtime_bin}}"; path_prefix=""; \
      else \
        if [ "$force" = "true" ]; then just build fullmag; \
        elif [ "$build" = "true" ]; then just build fullmag; \
        elif [ ! -x "{{local_bin}}/fullmag" ]; then echo "Fullmag binary is missing; run with build=True or force=True once." >&2; exit 2; fi; \
        bin="{{local_bin}}/fullmag"; path_prefix="{{local_bin}}:$PATH"; \
      fi; \
      env_args=(FULLMAG_PYTHON="{{repo_python}}"); \
      if [ -n "$path_prefix" ]; then env_args+=(PATH="$path_prefix"); fi; \
      if [ "$backend" = "fem" ]; then env_args+=(FULLMAG_FDM_EXECUTION=cpu); fi; \
      if [ "$backend" = "fem" ] && [ "$device" != "auto" ]; then env_args+=(FULLMAG_FEM_EXECUTION="$device" FULLMAG_RELAX_DEVICE="$device"); fi; \
      if [ "$backend" = "fdm" ] && [ "$device" != "auto" ]; then env_args+=(FULLMAG_FDM_EXECUTION="$device"); fi; \
      cli_args=("$script"); \
      if [ "$backend" != "auto" ]; then cli_args+=(--backend "$backend"); fi; \
      if [ "$run_mode" = "headless" ]; then cli_args+=(--headless --json); else if [ "$frontend" = "dev" ]; then cli_args=(--dev -i "${cli_args[@]}"); else cli_args=(-i "${cli_args[@]}"); fi; cli_args+=(--web-port "$web_port"); fi; \
      env "${env_args[@]}" "$bin" "${cli_args[@]}"'

run-fdm-cpu-smoke:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    fullmag examples/fdm_cpu_relax_smoke.py --backend fdm --headless --json

run-fdm-hysteresis-smoke:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    fullmag examples/fdm_hysteresis_smoke.py --backend fdm --headless --json

run-fdm-hysteresis-snapshot-smoke:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    fullmag examples/fdm_hysteresis_snapshot_smoke.py --backend fdm --headless --json

run-hysteresis-waveguide-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50 FULLMAG_HYSTERESIS_MAX_STEPS=25 \
    just fullmag build=False static fem "{{device}}" headless examples/hysteresis_waveguide_300x50x10nm.py

run-hysteresis-waveguide-gpu-smoke:
    just run-hysteresis-waveguide-smoke gpu

run-hysteresis-waveguide-playback-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50 FULLMAG_HYSTERESIS_MAX_STEPS=25 \
    FULLMAG_HYSTERESIS_MAGNETIZATION_STORAGE=every_step \
    just fullmag build=False static fem "{{device}}" headless examples/hysteresis_waveguide_300x50x10nm.py

run-hysteresis-waveguide-gpu-playback-smoke:
    just run-hysteresis-waveguide-playback-smoke gpu

verify-hysteresis-playback-artifacts artifacts_dir:
    python3 scripts/verify_hysteresis_playback_artifacts.py "{{artifacts_dir}}"

run-hysteresis-waveguide-angular-family-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50 FULLMAG_HYSTERESIS_MAX_STEPS=25 \
    FULLMAG_HYSTERESIS_ANGULAR_FAMILY=1 \
    just fullmag build=False static fem "{{device}}" headless examples/hysteresis_waveguide_300x50x10nm.py

run-hysteresis-waveguide-gpu-angular-family-smoke:
    just run-hysteresis-waveguide-angular-family-smoke gpu

verify-hysteresis-angular-family-artifacts artifacts_dir:
    python3 scripts/verify_hysteresis_angular_family_artifacts.py "{{artifacts_dir}}"

run-hysteresis-waveguide-projection-benchmark-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50 FULLMAG_HYSTERESIS_MAX_STEPS=1 \
    FULLMAG_HYSTERESIS_ANGULAR_FAMILY=1 \
    just fullmag build=False static fem "{{device}}" headless examples/hysteresis_waveguide_300x50x10nm.py

verify-hysteresis-projection-benchmark artifacts_dir:
    python3 scripts/verify_hysteresis_projection_benchmark.py "{{artifacts_dir}}"

run-hysteresis-waveguide-saturation-limit-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=0 FULLMAG_HYSTERESIS_MAX_STEPS=1 \
    FULLMAG_HYSTERESIS_SATURATION_PROBE=1 \
    FULLMAG_HYSTERESIS_SATURATION_MAX_FIELD_MT=10 \
    FULLMAG_HYSTERESIS_SATURATION_SUSCEPTIBILITY_THRESHOLD=1e-12 \
    FULLMAG_HYSTERESIS_SATURATION_TRANSVERSE_THRESHOLD=1e-12 \
    just fullmag build=False static fem "{{device}}" headless examples/hysteresis_waveguide_300x50x10nm.py

run-hysteresis-waveguide-gpu-saturation-limit-smoke:
    just run-hysteresis-waveguide-saturation-limit-smoke gpu

verify-hysteresis-saturation-limit artifacts_dir:
    python3 scripts/verify_hysteresis_saturation_limit_artifacts.py "{{artifacts_dir}}"

run-hysteresis-waveguide-minor-loop-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50 FULLMAG_HYSTERESIS_MAX_STEPS=1 \
    FULLMAG_HYSTERESIS_MINOR_LOOP=1 \
    FULLMAG_HYSTERESIS_MINOR_REVERSAL_MT=50 \
    FULLMAG_HYSTERESIS_MINOR_RETURN_MT=-25 \
    just fullmag build=False static fem "{{device}}" headless examples/hysteresis_waveguide_300x50x10nm.py

run-hysteresis-waveguide-gpu-minor-loop-smoke:
    just run-hysteresis-waveguide-minor-loop-smoke gpu

verify-hysteresis-minor-loop artifacts_dir:
    python3 scripts/verify_hysteresis_minor_loop_artifacts.py "{{artifacts_dir}}"

run-hysteresis-fdm-macrospin-sw-smoke:
    just ensure-python
    just build fullmag
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_HYSTERESIS_MAX_STEPS=160 \
    fullmag examples/hysteresis_fdm_macrospin_stoner_wohlfarth.py --backend fdm --headless --json

verify-hysteresis-fdm-macrospin-sw artifacts_dir:
    python3 scripts/verify_hysteresis_fdm_macrospin_sw_artifacts.py "{{artifacts_dir}}"

run-permalloy-box-relax-fdm web_port="3100":
    just run-permalloy-box-relax-fdm-interactive "{{web_port}}"

run-permalloy-box-relax-fdm-interactive web_port="3100" cpu_threads="auto":
    just ensure-python
    just build fullmag
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    PATH="{{local_bin}}:$PATH" \
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_CPU_THREADS="$cpu_threads_env" \
    fullmag --dev -i examples/permalloy_box_relax_300x1000x10nm_fdm.py --backend fdm --web-port "{{web_port}}"

run-permalloy-box-relax-fdm-ui web_port="3100" cpu_threads="auto":
    just run-permalloy-box-relax-fdm-interactive "{{web_port}}" "{{cpu_threads}}"

run-permalloy-box-relax-fdm-headless cpu_threads="auto":
    just ensure-python
    just build fullmag
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    PATH="{{local_bin}}:$PATH" \
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_CPU_THREADS="$cpu_threads_env" \
    FULLMAG_DISABLE_CHARTS=1 \
    FULLMAG_DISABLE_PREVIEW_3D=1 \
    fullmag examples/permalloy_box_relax_300x1000x10nm_fdm.py --backend fdm --headless --json

run-py-layer-hole:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag examples/py_layer_hole_relax_150nm.py

run-py-layer-hole-headless:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag examples/py_layer_hole_relax_150nm.py --headless --json

run-nanoflower:
    just ensure-python
    just build fullmag-dev
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag --dev examples/nanoflower_fem.py

run-nanoflower-static:
    just ensure-python
    just build fullmag
    just build-static-control-room
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag examples/nanoflower_fem.py

run-nanoflower-interactive:
    just ensure-python
    just build fullmag-dev
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag --dev -i examples/nanoflower_fem.py

run-stno-interactive fem_execution="cpu":
    bash -euo pipefail -c 'mode="{{fem_execution}}"; case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; 1|true|TRUE|on|ON|yes|YES|y|Y) echo "run-stno-interactive argument selects FEM execution mode, not build cpu_only; use cpu or gpu." >&2; exit 2 ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; just run-stno-interactive-managed "$mode"'

run-arch-waveguide-interactive fem_execution="script":
    bash -euo pipefail -c 'mode="{{fem_execution}}"; case "$mode" in script|SCRIPT|auto|AUTO) mode="script" ;; 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; 1|true|TRUE|on|ON|yes|YES|y|Y) echo "run-arch-waveguide-interactive argument selects FEM execution mode, not build cpu_only; use script, cpu, or gpu." >&2; exit 2 ;; *) echo "unsupported FEM execution mode: $mode (expected script, cpu, or gpu)" >&2; exit 2 ;; esac; just run-arch-waveguide-interactive-managed "$mode"'

# Run arch waveguide interactive with the new v2 control room (apps/control-room).
# Starts the v2 Next.js dev server on :3100, then launches the simulation against it.
run-arch-waveguide-interactive-v2 fem_execution="script":
    bash -euo pipefail -c '\
      mode="{{fem_execution}}"; \
      api_url="http://localhost:8081"; \
      web_url="http://localhost:3100"; \
      case "$mode" in \
        script|SCRIPT|auto|AUTO) mode="script" ;; \
        0|cpu|CPU) mode="cpu" ;; \
        gpu|GPU) mode="gpu" ;; \
        1|true|TRUE|on|ON|yes|YES|y|Y) echo "run-arch-waveguide-interactive-v2 selects FEM execution mode; use script, cpu, or gpu." >&2; exit 2 ;; \
        *) echo "unsupported FEM execution mode: $mode (expected script, cpu, or gpu)" >&2; exit 2 ;; \
      esac; \
      if command -v pnpm >/dev/null 2>&1; then PNPM_CMD=pnpm; \
      elif command -v corepack >/dev/null 2>&1; then PNPM_CMD="corepack pnpm"; \
      else echo "pnpm or corepack not found on PATH" >&2; exit 127; fi; \
      echo "Freeing ports 3100 and 8081 ..." >&2; \
      fuser -k 3100/tcp 2>/dev/null || true; \
      fuser -k 8081/tcp 2>/dev/null || true; \
      pkill -9 -f "fullmag-fem-gpu-bi[n]" >/dev/null 2>&1 || true; \
      pkill -9 -f "fullmag-ap[i]" >/dev/null 2>&1 || true; \
      pkill -9 -f "helper.p[y]" >/dev/null 2>&1 || true; \
      rm -rf apps/control-room/.next/dev; \
      mkdir -p .fullmag/logs; \
      echo "Starting v2 control room on :3100 ..." >&2; \
      NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL="$api_url" \
      NEXT_PUBLIC_RUNTIME_HTTP_BASE="$api_url" \
      NEXT_PUBLIC_API_URL="$api_url" \
      NEXT_PUBLIC_FULLMAG_API_URL="$api_url" \
      FULLMAG_API_URL="$api_url" \
      FULLMAG_API_PROXY_TARGET="$api_url" \
      $PNPM_CMD --dir apps/control-room dev --hostname 0.0.0.0 --port 3100 \
        >.fullmag/logs/control-room-v2.log 2>&1 & \
      printf "%s\n" "$web_url" > .fullmag/control-room-url.txt; \
      printf "%s\n" "$web_url" > .fullmag/control-room-v2-url.txt; \
      printf "dev\n" > .fullmag/control-room-mode.txt; \
      echo "Waiting for v2 frontend (/workspace) on :3100 (up to 120s) ..." >&2; \
      for i in $(seq 1 600); do \
        curl -fsS http://localhost:3100/workspace >/dev/null 2>&1 && break; \
        sleep 0.2; \
      done; \
      if ! curl -fsS http://localhost:3100/workspace >/dev/null 2>&1; then \
        echo "v2 frontend did not become ready on :3100" >&2; \
        echo "Log: $(pwd)/.fullmag/logs/control-room-v2.log" >&2; \
        exit 1; \
      fi; \
      echo "v2 frontend ready on ${web_url}/workspace - launching simulation ..." >&2; \
      physical_cores=$(lscpu -p=CORE 2>/dev/null | grep "^[0-9]" | sort -u | wc -l || echo ""); \
      cpu_threads="${physical_cores:-auto}"; \
      if [ -z "$cpu_threads" ] || [ "$cpu_threads" = "0" ]; then cpu_threads="auto"; fi; \
      if [ "$cpu_threads" != "auto" ] && [ "$cpu_threads" -gt 8 ]; then cpu_threads=8; fi; \
      echo "cpu_threads=$cpu_threads (capped at 8 for WSL memory stability)" >&2; \
      FULLMAG_DISABLE_STATIC_CONTROL_ROOM=1 just run-arch-waveguide-interactive-managed "$mode" "$cpu_threads" 3100'



run-nanoflower-interactive-quadro:
    just ensure-python
    just build fullmag-dev
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag --dev -i examples/nanoflower_fem_quadro.py

# Run nanoflower quadro on the managed GPU runtime (MFEM + CUDA, built via Docker).
# Run `just rebuild-gpu-runtime` if the binary is stale or after source changes.
gpu_runtime_bin := repo_root + "/.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu"
gpu_runtime_manifest := repo_root + "/.fullmag/runtimes/fem-gpu-host/manifest.json"

run-nanoflower-interactive-quadro-gpu:
    just ensure-python
    just build fullmag-dev
    FULLMAG_PYTHON="{{repo_python}}" '{{gpu_runtime_bin}}' --dev -i examples/nanoflower_fem_quadro.py

ensure-managed-fem-runtime:
    if [ ! -x '{{gpu_runtime_bin}}' ] || [ ! -f '{{gpu_runtime_manifest}}' ]; then \
        echo "Managed FEM runtime bundle is missing or incomplete; rebuilding it now." >&2; \
        just rebuild-fem-runtime; \
    fi
    stale_source="$(find crates/fullmag-api crates/fullmag-authoring crates/fullmag-cli crates/fullmag-runner crates/fullmag-quantities crates/fullmag-plan crates/fullmag-ir crates/fullmag-engine crates/fullmag-session crates/fullmag-fdm-demag crates/fullmag-fdm-sys crates/fullmag-fem-sys native/CMakeLists.txt native/include backends/fem backends/fdm docker/fem-gpu/Dockerfile compose.yaml scripts/export_fem_gpu_runtime.sh Cargo.toml Cargo.lock rust-toolchain.toml -type f ! -path '*/.fullmag/*' ! -path '*/__pycache__/*' ! -name '*.pyc' -newer '{{gpu_runtime_manifest}}' -print -quit 2>/dev/null)"; \
    if [ -n "$stale_source" ]; then \
        echo "Managed FEM runtime bundle is stale; newer runtime source detected: $stale_source" >&2; \
        echo "Rebuilding managed FEM runtime bundle now." >&2; \
        just rebuild-fem-runtime; \
    fi
    if [ ! -x '{{gpu_runtime_bin}}' ] || [ ! -f '{{gpu_runtime_manifest}}' ]; then \
        echo "Managed FEM runtime rebuild did not produce {{gpu_runtime_bin}} and {{gpu_runtime_manifest}}" >&2; \
        exit 2; \
    fi

run-stno-interactive-managed fem_execution="gpu" cpu_threads="auto":
    just ensure-python
    just ensure-managed-fem-runtime
    if [ "{{cpu_threads}}" = "auto" ]; then \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION="{{fem_execution}}" FULLMAG_CPU_THREADS=auto '{{gpu_runtime_bin}}' --dev -i examples/stno_vortex_mtj_workflow.py; \
    else \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION="{{fem_execution}}" FULLMAG_CPU_THREADS="{{cpu_threads}}" '{{gpu_runtime_bin}}' --dev -i examples/stno_vortex_mtj_workflow.py; \
    fi

run-arch-waveguide-interactive-managed fem_execution="script" cpu_threads="auto" web_port="":
    just ensure-python
    just ensure-managed-fem-runtime
    web_port_arg=""; \
    if [ -n "{{web_port}}" ]; then web_port_arg="--web-port {{web_port}}"; fi; \
    mode="{{fem_execution}}"; \
    case "$mode" in script|SCRIPT|auto|AUTO) mode="script" ;; 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected script, cpu, or gpu)" >&2; exit 2 ;; esac; \
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    if [ "$mode" = "script" ]; then \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_CPU_THREADS="$cpu_threads_env" '{{gpu_runtime_bin}}' --dev $web_port_arg -i examples/arch_waveguide_relax_50nm.py; \
    else \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION="$mode" FULLMAG_CPU_THREADS="$cpu_threads_env" '{{gpu_runtime_bin}}' --dev $web_port_arg -i examples/arch_waveguide_relax_50nm.py; \
    fi

run-nanoflower-quadro-gpu-headless:
    just ensure-python
    just build fullmag-dev
    FULLMAG_PYTHON="{{repo_python}}" '{{gpu_runtime_bin}}' --dev examples/nanoflower_fem_quadro.py --headless

run-arch-waveguide-headless:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag examples/arch_waveguide_relax_50nm.py --headless --json

run-arch-waveguide-managed-headless fem_execution="script" cpu_threads="auto":
    just ensure-python
    if [ ! -x '{{gpu_runtime_bin}}' ]; then \
        echo "Managed FEM runtime bundle is missing (used for both FEM CPU and FEM GPU)." >&2; \
        echo "Run: just rebuild-fem-runtime" >&2; \
        exit 2; \
    fi
    mode="{{fem_execution}}"; \
    case "$mode" in script|SCRIPT|auto|AUTO) mode="script" ;; 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected script, cpu, or gpu)" >&2; exit 2 ;; esac; \
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    if [ "$mode" = "script" ]; then \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_CPU_THREADS="$cpu_threads_env" '{{gpu_runtime_bin}}' --dev examples/arch_waveguide_relax_50nm.py --headless --json; \
    else \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION="$mode" FULLMAG_CPU_THREADS="$cpu_threads_env" '{{gpu_runtime_bin}}' --dev examples/arch_waveguide_relax_50nm.py --headless --json; \
    fi

run-pylayer-interactive:
    just ensure-python
    just build fullmag-dev
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag --dev -i examples/py_layer_hole_relax_150nm.py

run-permalloy-box-relax fem_execution="gpu":
    just run-permalloy-box-relax-interactive "{{fem_execution}}"

run-permalloy-box-relax-interactive fem_execution="gpu" cpu_threads="auto":
    just ensure-python
    just ensure-managed-fem-runtime
    mode="{{fem_execution}}"; \
    case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_FEM_EXECUTION="$mode" \
    FULLMAG_CPU_THREADS="$cpu_threads_env" \
    '{{gpu_runtime_bin}}' --dev -i examples/permalloy_box_relax_300x1000x10nm.py

run-permalloy-box-relax-headless fem_execution="gpu" cpu_threads="auto":
    just ensure-python
    just ensure-managed-fem-runtime
    mode="{{fem_execution}}"; \
    case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_FEM_EXECUTION="$mode" \
    FULLMAG_CPU_THREADS="$cpu_threads_env" \
    '{{gpu_runtime_bin}}' examples/permalloy_box_relax_300x1000x10nm.py --backend fem --headless --json

run-cofeb-rings-relax fem_execution="gpu":
    just run-cofeb-rings-relax-interactive "{{fem_execution}}"

run-cofeb-rings-relax-interactive fem_execution="gpu" cpu_threads="auto":
    just ensure-python
    just ensure-managed-fem-runtime
    mode="{{fem_execution}}"; \
    case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_FEM_EXECUTION="$mode" \
    FULLMAG_CPU_THREADS="$cpu_threads_env" \
    '{{gpu_runtime_bin}}' --dev -i examples/permalloy_layer_cofeb_rings_relax_300nm.py

run-cofeb-rings-relax-headless fem_execution="gpu" cpu_threads="auto":
    just ensure-python
    just ensure-managed-fem-runtime
    mode="{{fem_execution}}"; \
    case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_FEM_EXECUTION="$mode" \
    FULLMAG_CPU_THREADS="$cpu_threads_env" \
    '{{gpu_runtime_bin}}' examples/permalloy_layer_cofeb_rings_relax_300nm.py --backend fem --headless --json

run-permalloy-skyrmion-relax fem_execution="gpu":
    just run-permalloy-skyrmion-relax-interactive "{{fem_execution}}"

run-permalloy-skyrmion-relax-interactive fem_execution="gpu" cpu_threads="auto" web_port="3100":
    just ensure-python
    just ensure-managed-fem-runtime
    mode="{{fem_execution}}"; \
    case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_FEM_EXECUTION="$mode" \
    FULLMAG_CPU_THREADS="$cpu_threads_env" \
    '{{gpu_runtime_bin}}' --dev -i examples/permalloy_skyrmion_relax_300x1000x10nm.py --web-port "{{web_port}}"

run-permalloy-skyrmion-relax-headless fem_execution="gpu" cpu_threads="auto":
    just ensure-python
    just ensure-managed-fem-runtime
    mode="{{fem_execution}}"; \
    case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_FEM_EXECUTION="$mode" \
    FULLMAG_CPU_THREADS="$cpu_threads_env" \
    '{{gpu_runtime_bin}}' examples/permalloy_skyrmion_relax_300x1000x10nm.py --backend fem --headless --json

run-nanoflower-headless:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag examples/nanoflower_fem.py --headless --json

run-stdprob1-fem:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag tests/stdprob1_hysteresis_fem.py

run-stdprob1-fem-headless:
    just ensure-python
    just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag tests/stdprob1_hysteresis_fem.py --headless --json

fem-gpu-headless script:
    docker compose --profile fem-gpu run --rm -e FULLMAG_RELAX_ALGORITHM="${FULLMAG_RELAX_ALGORITHM:-}" -e FULLMAG_RELAX_DEVICE="${FULLMAG_RELAX_DEVICE:-gpu}" -e FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-4}" fem-gpu bash -lc '\
      set -euo pipefail; \
      cargo +nightly clean -p fullmag-fdm-demag >/dev/null 2>&1 || true; \
      FULLMAG_USE_MFEM_STACK=ON cargo +nightly build -p fullmag-cli --features "cuda fem-gpu" >/tmp/fullmag-build.log; \
      FEM_LIB=$(dirname "$(find target/debug/build -path "*fullmag-fem-sys*/out/native-build/backends/fem/libfullmag_fem.so.0" -printf "%T@ %p\n" | sort -nr | head -n1 | cut -d" " -f2-)"); \
      FDM_LIB=$(dirname "$(find target/debug/build -path "*fullmag-fdm-sys*/out/native-build/backends/fdm/libfullmag_fdm.so.0" -printf "%T@ %p\n" | sort -nr | head -n1 | cut -d" " -f2-)"); \
      export LD_LIBRARY_PATH="$FEM_LIB:$FDM_LIB:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}"; \
      export FULLMAG_PYTHON=/usr/bin/python3; \
      FULLMAG_FEM_EXECUTION=gpu FULLMAG_FEM_GPU_INDEX=0 FULLMAG_FDM_GPU_INDEX=0 \
      ./target/debug/fullmag {{script}} --backend fem --headless --json \
    '

fem-managed-headless fem_execution script:
    just ensure-python
    just ensure-managed-fem-runtime
    mode="{{fem_execution}}"; \
    case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_FEM_EXECUTION="$mode" \
    FULLMAG_RELAX_DEVICE="$mode" \
    FULLMAG_CPU_THREADS=auto \
    '{{gpu_runtime_bin}}' {{script}} --backend fem --headless --json

fem-managed-container-headless fem_execution script:
    just ensure-managed-fem-runtime
    mode="{{fem_execution}}"; \
    case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION="$mode" \
      -e FULLMAG_RELAX_DEVICE="$mode" \
      -e FULLMAG_RELAX_ALGORITHM="${FULLMAG_RELAX_ALGORITHM:-}" \
      -e FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-4}" \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      fem-gpu bash -lc 'cd /workspace && .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu {{script}} --backend fem --headless --json'

fem-gpu-py-layer-hole-headless:
    just fem-gpu-headless examples/py_layer_hole_relax_150nm.py

# Rebuild the managed FEM host runtime bundle (MFEM + HYPRE + CUDA-enabled build stack).
# This bundle is used for both FEM CPU and FEM GPU execution paths.
# Required after source changes to fullmag-plan, fullmag-runner, fullmag-fem-sys, or backends/fem.
rebuild-fem-runtime:
    ./scripts/export_fem_gpu_runtime.sh

# Backward-compatible alias.
rebuild-gpu-runtime:
    just rebuild-fem-runtime

# ── Benchmarks ──────────────────────────────────────────────────────────

# Run the Box500 FEM CPU/GPU consistency matrix.
# Writes CSV rows and a CPU/GPU summary JSON. Override defaults with
# FULLMAG_BENCH_STEPS, FULLMAG_BENCH_DOMAIN_HMAX, FULLMAG_BENCH_AIRBOX_HMAX,
# FULLMAG_BENCH_INTEGRATORS (or FULLMAG_BENCH_SOLVERS),
# FULLMAG_BENCH_OUTPUT, FULLMAG_BENCH_SUMMARY, FULLMAG_BENCH_REPORT,
# FULLMAG_BENCH_PDF, FULLMAG_BENCH_CASE_TIMEOUT_S,
# FULLMAG_BENCH_STEP_CAP, FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE_T,
# FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL, FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J,
# and FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL. Pass `full` to run until the relax
# torque stop criterion or the step/time guard.
# The recipe intentionally returns non-zero when the
# consistency gate finds a solver mismatch.
bench-fem-box500-consistency mode="quick":
    just ensure-python
    just ensure-managed-fem-runtime
    bench_relax_args=(); \
    bench_integrators="${FULLMAG_BENCH_INTEGRATORS:-${FULLMAG_BENCH_SOLVERS:-heun,rk4,rk23,rk45}}"; \
    bench_case_timeout_s="${FULLMAG_BENCH_CASE_TIMEOUT_S:-300}"; \
    bench_step_cap="${FULLMAG_BENCH_STEP_CAP:-1000}"; \
    if [ "{{mode}}" = "full" ]; then \
      bench_steps="${FULLMAG_BENCH_STEPS:-1000}"; \
      bench_relax_tolerance_t="${FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE_T:-1e-4}"; \
      bench_energy_rtol="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-5e-5}"; \
      bench_energy_atol_j="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-24}"; \
      bench_torque_rtol="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-5e-5}"; \
      bench_relax_args=(--relax-torque-tolerance-t "$bench_relax_tolerance_t"); \
    elif [ "{{mode}}" = "quick" ]; then \
      bench_steps="${FULLMAG_BENCH_STEPS:-10}"; \
      bench_energy_rtol="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-1e-6}"; \
      bench_energy_atol_j="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-30}"; \
      bench_torque_rtol="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-1e-6}"; \
    else \
      echo "bench-fem-box500-consistency mode must be quick or full" >&2; \
      exit 2; \
    fi; \
    if [ "$bench_steps" -gt "$bench_step_cap" ]; then \
      bench_steps="$bench_step_cap"; \
    fi; \
    bench_output="${FULLMAG_BENCH_OUTPUT:-/tmp/fullmag_box500_airbox_interaction_matrix.csv}"; \
    bench_summary="${FULLMAG_BENCH_SUMMARY:-/tmp/fullmag_box500_airbox_interaction_matrix_summary.json}"; \
    bench_report="${FULLMAG_BENCH_REPORT:-/tmp/fullmag_box500_airbox_interaction_matrix_report.md}"; \
    bench_pdf="${FULLMAG_BENCH_PDF:-/tmp/fullmag_box500_airbox_interaction_matrix_report.pdf}"; \
    PYTHONPATH=packages/fullmag-py/src \
    FULLMAG_BENCH_DOMAIN_HMAX="${FULLMAG_BENCH_DOMAIN_HMAX:-250e-9}" \
    FULLMAG_BENCH_AIRBOX_HMAX="${FULLMAG_BENCH_AIRBOX_HMAX:-500e-9}" \
    python3 scripts/analysis/fem_gpu_benchmark.py \
      --box500-airbox-interaction-consistency-preset \
      --integrators "$bench_integrators" \
      --steps "$bench_steps" \
      --case-timeout-s "$bench_case_timeout_s" \
      --cpu-gpu-energy-rtol "$bench_energy_rtol" \
      --cpu-gpu-energy-atol "$bench_energy_atol_j" \
      --cpu-gpu-torque-rtol "$bench_torque_rtol" \
      --output "$bench_output" \
      --cpu-gpu-summary-output "$bench_summary" \
      --human-report-output "$bench_report" \
      --pdf-report-output "$bench_pdf" \
      "${bench_relax_args[@]}" \
      --quiet-json-summary

# Run FEM CPU scaling benchmark: tests thread counts 4, 8, 20, 40 across mesh sizes.
# Outputs timing comparison and speedup table.
bench-cpu-scaling:
    just ensure-python
    if [ ! -x '{{gpu_runtime_bin}}' ]; then \
        echo "Managed FEM runtime bundle is missing (used for both FEM CPU and FEM GPU)." >&2; \
        echo "Run: just rebuild-fem-runtime" >&2; \
        exit 2; \
    fi
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" FULLMAG_BIN="{{gpu_runtime_bin}}" ./scripts/bench_fem_cpu_scaling.sh

# Quick version of CPU scaling benchmark (fewer steps, fewer mesh sizes).
bench-cpu-scaling-quick:
    just ensure-python
    if [ ! -x '{{gpu_runtime_bin}}' ]; then \
        echo "Managed FEM runtime bundle is missing (used for both FEM CPU and FEM GPU)." >&2; \
        echo "Run: just rebuild-fem-runtime" >&2; \
        exit 2; \
    fi
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" FULLMAG_BIN="{{gpu_runtime_bin}}" ./scripts/bench_fem_cpu_scaling.sh --quick

# Single-run profiling benchmark. Use with htop/perf to observe CPU utilization.
# Example: just bench-profile auto
bench-profile threads="auto":
    just ensure-python
    if [ ! -x '{{gpu_runtime_bin}}' ]; then \
        echo "Managed FEM runtime bundle is missing (used for both FEM CPU and FEM GPU)." >&2; \
        echo "Run: just rebuild-fem-runtime" >&2; \
        exit 2; \
    fi
    FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_FEM_EXECUTION=cpu \
    FULLMAG_CPU_THREADS="{{threads}}" \
    '{{gpu_runtime_bin}}' --headless examples/bench_fem_simple.py
