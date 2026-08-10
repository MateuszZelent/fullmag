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
    if [ ! -x "{{repo_python}}" ]; then if ! python3 -m venv "{{repo_root}}/.fullmag/local/python"; then echo "cannot create the Fullmag Python environment; install the Python venv/ensurepip package for this interpreter" >&2; exit 1; fi; fi
    if ! "{{repo_python}}" -m pip --version >/dev/null 2>&1; then if ! "{{repo_python}}" -m ensurepip --upgrade; then python3 scripts/bootstrap_fullmag_python_pip.py "{{repo_python}}" --wheel-dir /usr/share/python-wheels || { echo "cannot bootstrap pip in the Fullmag Python environment; install the Python venv/ensurepip package for this interpreter" >&2; exit 1; }; fi; fi
    if ! "{{repo_python}}" -m pip --version >/dev/null 2>&1; then echo "cannot bootstrap pip in the Fullmag Python environment; ensurepip completed without a usable pip module" >&2; exit 1; fi
    "{{repo_python}}" -m pip install 'numpy>=1.24' 'scipy>=1.10' 'gmsh>=4.12' 'meshio>=5.3' 'trimesh>=4.2' 'h5py>=3.8' 'zarr>=2.18,<3' 'rich>=13.7' 'matplotlib>=3.7'

build target="fullmag" cpu_only="0":
    bash -euo pipefail -c 'target="{{target}}"; cpu_only="{{cpu_only}}"; case "$target" in target=*) target="${target#target=}" ;; --target=*) target="${target#--target=}" ;; esac; case "$cpu_only" in cpu_only=*) cpu_only="${cpu_only#cpu_only=}" ;; esac; case "$cpu_only" in 1|true|TRUE|on|ON|yes|YES|y|Y) cpu_only="1" ;; 0|false|FALSE|off|OFF|no|NO|n|N|"") cpu_only="0" ;; *) cpu_only="0" ;; esac; if [ "$target" = "fullmag" ]; then FULLMAG_BUILD_CPU_ONLY="$cpu_only" make install-cli; elif [ "$target" = "fullmag-static" ]; then FULLMAG_BUILD_CPU_ONLY="$cpu_only" make install-cli-static; elif [ "$target" = "fullmag-dev" ]; then FULLMAG_BUILD_CPU_ONLY="$cpu_only" make install-cli-dev; elif [ "$target" = "fullmag-host" ]; then make install-cli; elif [ "$target" = "dev-image" ]; then docker compose build dev; elif [ "$target" = "fem-gpu-runtime" ]; then docker compose --profile fem-gpu build fem-gpu; elif [ "$target" = "fem-gpu-runtime-host" ]; then ./scripts/export_fem_gpu_runtime.sh; else echo "unknown build target: $target" >&2; echo "supported targets: fullmag, fullmag-static, fullmag-dev, fullmag-host, dev-image, fem-gpu-runtime, fem-gpu-runtime-host" >&2; exit 1; fi'

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

run-topological-charge-skyrmion-smoke device="cpu":
    mode="{{device}}"; \
    case "$mode" in cpu|CPU|0) ;; *) echo "unsupported topological-charge smoke device: $mode (expected cpu)" >&2; exit 2 ;; esac; \
    cargo test -p fullmag-api analysis::topological_charge::tests::analytic_neel_skyrmion_integrates_to_unit_charge_with_known_orientation -- --exact

verify-topological-charge-fdm-runtime api_port="18187":
    just ensure-python
    just build fullmag
    bash -euo pipefail -c '\
      report_dir="{{repo_root}}/.fullmag/reports/topological-charge/fdm"; \
      api_url="http://localhost:{{api_port}}"; \
      mkdir -p "$report_dir"; \
      sim_pid=""; \
      cleanup() { if [ -n "$sim_pid" ] && kill -0 "$sim_pid" >/dev/null 2>&1; then kill "$sim_pid" >/dev/null 2>&1 || true; wait "$sim_pid" >/dev/null 2>&1 || true; fi; }; \
      trap cleanup EXIT INT TERM; \
      PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" FULLMAG_API_PORT="{{api_port}}" FULLMAG_TOPOLOGICAL_CHARGE_BACKEND=fdm fullmag --dev -i examples/topological_charge_runtime.py > "$report_dir/runtime.log" 2>&1 & \
      sim_pid=$!; \
      for _ in $(seq 1 120); do \
        curl -fsS "$api_url/v2/sessions/current/status" >/dev/null 2>&1 && break; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then tail -n 120 "$report_dir/runtime.log" >&2 || true; exit 1; fi; \
        sleep 0.5; \
      done; \
      curl -fsS "$api_url/v2/sessions/current/status" >/dev/null; \
      object_id="$(python3 -c "import json, urllib.request; value=json.load(urllib.request.urlopen(\"$api_url/v2/sessions/current/model/scene\")); print(value[\"objects\"][0][\"id\"])" )"; \
      for _ in $(seq 1 120); do \
        if python3 scripts/capture_topological_charge_runtime.py --api-base-url "$api_url" --object-id "$object_id" --scenario fdm --output "$report_dir/summary.json" >/dev/null 2>&1 && python3 scripts/validate_topological_charge_runtime.py "$report_dir/summary.json" >/dev/null 2>&1; then break; fi; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then tail -n 120 "$report_dir/runtime.log" >&2 || true; exit 1; fi; \
        sleep 0.5; \
      done; \
      python3 scripts/capture_topological_charge_runtime.py --api-base-url "$api_url" --object-id "$object_id" --scenario fdm --output "$report_dir/summary.json"; \
      python3 scripts/validate_topological_charge_runtime.py "$report_dir/summary.json"'

verify-topological-charge-fem-runtime api_port="18188":
    just ensure-python
    just ensure-managed-fem-runtime
    bash -euo pipefail -c '\
      report_dir="{{repo_root}}/.fullmag/reports/topological-charge/fem-p1"; \
      api_url="http://localhost:{{api_port}}"; \
      mkdir -p "$report_dir"; \
      sim_pid=""; \
      cleanup() { if [ -n "$sim_pid" ] && kill -0 "$sim_pid" >/dev/null 2>&1; then kill "$sim_pid" >/dev/null 2>&1 || true; wait "$sim_pid" >/dev/null 2>&1 || true; fi; }; \
      trap cleanup EXIT INT TERM; \
      FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION=cpu FULLMAG_API_PORT="{{api_port}}" FULLMAG_TOPOLOGICAL_CHARGE_BACKEND=fem "{{gpu_runtime_bin}}" --dev -i examples/topological_charge_runtime.py > "$report_dir/runtime.log" 2>&1 & \
      sim_pid=$!; \
      for _ in $(seq 1 240); do \
        curl -fsS "$api_url/v2/sessions/current/status" >/dev/null 2>&1 && break; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then tail -n 160 "$report_dir/runtime.log" >&2 || true; exit 1; fi; \
        sleep 0.5; \
      done; \
      curl -fsS "$api_url/v2/sessions/current/status" >/dev/null; \
      object_id="$(python3 -c "import json, urllib.request; value=json.load(urllib.request.urlopen(\"$api_url/v2/sessions/current/model/scene\")); print(value[\"objects\"][0][\"id\"])" )"; \
      for _ in $(seq 1 240); do \
        if python3 scripts/capture_topological_charge_runtime.py --api-base-url "$api_url" --object-id "$object_id" --scenario fem_p1 --output "$report_dir/summary.json" >/dev/null 2>&1 && python3 scripts/validate_topological_charge_runtime.py "$report_dir/summary.json" >/dev/null 2>&1; then break; fi; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then tail -n 160 "$report_dir/runtime.log" >&2 || true; exit 1; fi; \
        sleep 0.5; \
      done; \
      python3 scripts/capture_topological_charge_runtime.py --api-base-url "$api_url" --object-id "$object_id" --scenario fem_p1 --output "$report_dir/summary.json"; \
      python3 scripts/validate_topological_charge_runtime.py "$report_dir/summary.json"'

verify-topological-charge-cross-backend:
    just verify-topological-charge-fdm-runtime
    just verify-topological-charge-fem-runtime
    python3 scripts/compare_topological_charge_runtime.py --fdm .fullmag/reports/topological-charge/fdm/summary.json --fem .fullmag/reports/topological-charge/fem-p1/summary.json --output .fullmag/reports/topological-charge/cross-backend/summary.json
    python3 scripts/validate_topological_charge_runtime.py .fullmag/reports/topological-charge/cross-backend/summary.json

test-desktop:
    just check-desktop-linux-deps
    cargo +nightly test -p fullmag-desktop

repo-check:
    python3 scripts/check_repo_consistency.py

verify-fem-meshing-production:
    bash scripts/verify_fem_meshing_production.sh

verify-fem-mixed-p1-capability-contract:
    python3 scripts/validate_mixed_p1_capability_contract.py
    python3 -m unittest scripts.test_validate_mixed_p1_capability_contract
    cargo test -p fullmag-runner --no-default-features capabilities::tests::

verify-fem-mixed-prism-airbox-runtime:
    just ensure-managed-fem-runtime
    bash -euo pipefail -c '\
      canonical="tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py"; \
      runtime_manifest=".fullmag/runtimes/fem-gpu-host/manifest.json"; \
      git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"; \
      managed_python="$(dirname "$git_common_dir")/.fullmag/local/python/bin/python"; \
      if [ ! -x "$managed_python" ]; then echo "shared Fullmag Python interpreter is missing: $managed_python" >&2; exit 2; fi; \
      "$managed_python" -c "import numpy, scipy, gmsh, meshio, trimesh, h5py, zarr"; \
      durable_root="${FULLMAG_MIXED_PRISM_AIRBOX_DURABLE_ROOT:-/mnt/fullmag-zfn2-native}"; \
      report_root="${FULLMAG_MIXED_PRISM_AIRBOX_REPORT_ROOT:-${durable_root}/reports/fullmag/fem-mixed-prism-airbox-runtime}"; \
      source scripts/lib/managed_fem_runtime_storage.sh; \
      source scripts/lib/managed_fem_report_storage.sh; \
      run_dir="$(create_managed_fem_report_run_root \
        "$durable_root" "$report_root" \
        "/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4" \
        "/sys/block")"; \
      echo "mixed prism-airbox report root: $run_dir"; \
      temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/fullmag-mixed-prism-airbox-runtime.XXXXXX")"; \
      cleanup() { rm -rf "$temp_dir"; }; \
      trap cleanup EXIT INT TERM; \
      bounded="$temp_dir/relax_projected_gradient_bb.max_steps_1.py"; \
      python3 scripts/verify_fem_mixed_prism_airbox_runtime.py prepare \
        "$canonical" "$bounded" --evidence "$run_dir/source.v1.json"; \
      python3 scripts/capture_source_snapshot_identity.py \
        --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --output "$run_dir/source-snapshot.v2.json"; \
      cp "$bounded" "$run_dir/bounded_scenario.py"; \
      cp -L "$runtime_manifest" "$run_dir/runtime-manifest.v3.json"; \
      mkdir -p "$run_dir/cpu" "$run_dir/gpu"; \
      python3 scripts/capture_source_snapshot_identity.py \
        --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --compare "$run_dir/source-snapshot.v2.json"; \
      FULLMAG_PYTHON="$managed_python" just fem-managed-headless cpu "$bounded" "$run_dir/cpu/artifacts" \
        2>&1 | tee "$run_dir/cpu/runtime.log"; \
      cmp "$runtime_manifest" "$run_dir/runtime-manifest.v3.json"; \
      python3 scripts/verify_fem_mixed_prism_airbox_runtime.py validate \
        "$canonical" "$run_dir/bounded_scenario.py" "$run_dir/cpu/artifacts" \
        --device cpu --runtime-log "$run_dir/cpu/runtime.log" \
        --runtime-manifest "$runtime_manifest" \
        --source-snapshot "$run_dir/source-snapshot.v2.json" \
        --output "$run_dir/cpu/summary.v4.json"; \
      python3 scripts/capture_source_snapshot_identity.py \
        --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --compare "$run_dir/source-snapshot.v2.json"; \
      FULLMAG_PYTHON="$managed_python" just fem-managed-headless gpu "$bounded" "$run_dir/gpu/artifacts" \
        2>&1 | tee "$run_dir/gpu/runtime.log"; \
      cmp "$runtime_manifest" "$run_dir/runtime-manifest.v3.json"; \
      python3 scripts/verify_fem_mixed_prism_airbox_runtime.py validate \
        "$canonical" "$run_dir/bounded_scenario.py" "$run_dir/gpu/artifacts" \
        --device gpu --runtime-log "$run_dir/gpu/runtime.log" \
        --runtime-manifest "$runtime_manifest" \
        --source-snapshot "$run_dir/source-snapshot.v2.json" \
        --output "$run_dir/gpu/summary.v4.json"; \
      python3 scripts/capture_source_snapshot_identity.py \
        --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --compare "$run_dir/source-snapshot.v2.json"; \
      python3 scripts/verify_fem_mixed_prism_airbox_runtime.py compare \
        --cpu-summary "$run_dir/cpu/summary.v4.json" \
        --gpu-summary "$run_dir/gpu/summary.v4.json" \
        --cpu-artifacts "$run_dir/cpu/artifacts" \
        --gpu-artifacts "$run_dir/gpu/artifacts" \
        --runtime-manifest "$runtime_manifest" \
        --output "$run_dir/summary.v3.json" \
        --csv-output "$run_dir/comparison.v3.csv"; \
      cmp "$runtime_manifest" "$run_dir/runtime-manifest.v3.json"; \
      echo "validated managed CPU/GPU mixed prism-airbox runtime evidence: $run_dir/summary.v3.json"'

verify-fem-mixed-p1-native-contract:
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_mixed_p1_contract fem_mesh_contract fem_mfem_context_contract fem_material_fields_contract fem_element_quadrature_material_contract fem_step_metrics_contract fem_exchange_contract fem_gpu_state_runtime_contract fem_source_facade_gpu_state_contract fem_transfer_audit fem_demag_poisson_contract fem_cuda_demag_robin_energy_contract fem_cuda_demag_timing_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_MIXED_P1_ROLLBACK_DEVICE=cpu native/build/backends/fem/fem_mixed_p1_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_MIXED_P1_ROLLBACK_DEVICE=cuda native/build/backends/fem/fem_mixed_p1_contract && native/build/backends/fem/fem_mesh_contract && native/build/backends/fem/fem_mfem_context_contract && native/build/backends/fem/fem_material_fields_contract && native/build/backends/fem/fem_element_quadrature_material_contract && native/build/backends/fem/fem_step_metrics_contract && native/build/backends/fem/fem_exchange_contract && native/build/backends/fem/fem_gpu_state_runtime_contract && native/build/backends/fem/fem_source_facade_gpu_state_contract && native/build/backends/fem/fem_transfer_audit && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_demag_poisson_contract && native/build/backends/fem/fem_cuda_demag_robin_energy_contract && native/build/backends/fem/fem_cuda_demag_timing_contract'

# MESH-GATE-002: cross-backend PBC matrix contract. Managed runtime evidence
# is deliberately supplied by the case artifacts, not inferred by this recipe.
verify-fdm-pbc-production:
    cargo test -p fullmag-engine --lib periodic --no-fail-fast
    cargo test -p fullmag-plan --lib fdm_pbc --no-fail-fast
    cargo test -p fullmag-runner --lib stale_resolved_periodic_workspace --no-fail-fast
    python3 scripts/verify_pbc_production_matrix.py --manifest scripts/pbc_production_matrix.v1.json

# M3 CPU reference gate. The public Python -> ProblemIR -> planner -> runner
# workload proves exact 300 K continuation through the built resume-json process.
verify-fdm-transient-spin-m3-reference:
    cargo build -p fullmag-cli --bin fullmag
    mkdir -p /tmp/fullmag-zfn2-build/m3-pytest; \
    fullmag_bin="${CARGO_TARGET_DIR:-target}/debug/fullmag"; \
    TMPDIR=/tmp/fullmag-zfn2-build/m3-pytest PYTHONPATH=packages/fullmag-py/src \
      python3 scripts/verify_fdm_transient_spin_m3_public_e2e.py --fullmag "$fullmag_bin"
    cargo test -p fullmag-engine --lib transient_spin --no-fail-fast
    cargo test -p fullmag-runner --lib coupled_ars232 --no-fail-fast
    cargo test -p fullmag-runner --lib adaptive_norm_detects_each_dimensional_observable_family --no-fail-fast
    cargo test -p fullmag-runner --lib coupled_trial_failures_rollback_llg_transport_and_thermal_state --no-fail-fast
    cargo test -p fullmag-runner --lib public_reference_resume_matches_uninterrupted_runner_artifact --no-fail-fast
    cargo test -p fullmag-runner --lib coupled_checkpoint_restore_rejects_incomplete_state_without_mutating_workflow --no-fail-fast
    cargo test -p fullmag-api session_checkpoint_create_captures_live_magnetization --no-fail-fast
    cargo test -p fullmag-api legacy_checkpoint_fails_closed_for_active_coupled_m3_session --no-fail-fast
    cargo test -p fullmag-api coupled_m3_restore_rejects_every_identity_and_state_shape_mismatch_without_mutation --no-fail-fast
    cargo test -p fullmag-plan --lib resolves_transient_fdm_cpu_double_with_physical_capacitance_and_versions --no-fail-fast
    cargo test -p fullmag-plan --lib transient_reference_execution_rejects_non_strict_mode --no-fail-fast
    cargo test -p fullmag-runner --lib coupled_checkpoint_rejects_each_public_identity_mismatch --no-fail-fast
    cargo test -p fullmag-api api_rejects_missing_or_malformed_coupled_identity_classes --no-fail-fast
    cargo test -p fullmag-cli cli_parses_exact_coupled_checkpoint_resume_entrypoint --no-fail-fast
    cargo test -p fullmag-cli cli_resume_unwraps_only_the_exact_backend_state_envelope --no-fail-fast
    TMPDIR=/tmp/fullmag-zfn2-build/m3-pytest PYTHONPATH=packages/fullmag-py/src \
      python3 -m pytest packages/fullmag-py/tests/test_spin_drift_diffusion.py -q

# Managed CPU FDM graph-realization gate.  The fixture executes the public
# ProblemIR -> planner -> runner path inside the managed FEM/CPU image and
# checks that the emitted artifact contains a concrete cell-mask digest.  It
# is a provenance/runtime gate, not a CUDA performance or physics-equivalence
# qualification.
verify-fdm-physics-graph-runtime:
    docker compose build fem-cpu
    docker compose run --rm --no-deps fem-cpu bash -lc 'cd /workspace && FULLMAG_FDM_EXECUTION=cpu CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fdm-physics-graph-runtime CARGO_INCREMENTAL=0 cargo test -p fullmag-runner --test physics_graph_runtime -- --nocapture'

# E4/D1: FDM multilayer convolution contract and managed runtime gates.
verify-fdm-multilayer-demag-contract:
    just ensure-python
    PYTHONPATH="{{repo_root}}/packages/fullmag-py/src" "{{repo_python}}" -m pytest -q -p no:cacheprovider tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/test_verify.py tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/test_runtime.py
    python3 tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/verify.py >/dev/null
    docker compose --profile fem-gpu run --rm --no-deps -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" fem-gpu bash -lc 'cd /workspace && build_dir=/tmp/fullmag-fdm-multilayer-contract && cmake -S native -B "$build_dir" -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build "$build_dir" --target fullmag_fdm multilayer_abi_v2_contract multilayer_create_v2_contract batched_demag_fft_contract && ctest --test-dir "$build_dir/backends/fdm" --output-on-failure -R "fdm_multilayer_abi_v2_contract|fdm_multilayer_create_v2_contract|fdm_batched_demag_fft_contract" && CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fdm-multilayer-demag-contract CARGO_INCREMENTAL=0 cargo test -p fullmag-fdm-demag --tests -- --nocapture'

verify-fdm-multilayer-demag-runtime lane="cpu-fp64":
    bash -euo pipefail -c '\
      lane="{{lane}}"; \
      report_parent="${FULLMAG_FDM_MULTILAYER_REPORT_ROOT:-.fullmag/reports/fdm-multilayer}"; \
      mkdir -p "$report_parent"; \
      run_root="$(mktemp -d "$report_parent/demag-${lane}.run.XXXXXXXX")"; \
      status_file="$run_root/status.json"; \
      write_status() { printf "{\"status\":\"not_qualified\",\"lane\":\"%s\",\"reason_code\":\"%s\"}\n" "$lane" "$1" > "$status_file"; }; \
      finish() { status=$?; chmod -R a-w "$run_root" 2>/dev/null || true; exit "$status"; }; \
      trap finish EXIT INT TERM; \
      case "$lane" in \
        cpu-fp64) ;; \
        cuda-fp64|cuda-fp32) reason="cuda_managed_artifact_missing"; if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi -L >/dev/null 2>&1; then reason="cuda_device_unavailable"; elif [ -x "{{gpu_runtime_bin}}" ] && [ -f "{{gpu_runtime_manifest}}" ]; then reason="cuda_lane_artifact_not_qualified"; fi; write_status "$reason"; echo "not_qualified: $reason ($lane)" >&2; exit 3 ;; \
        *) write_status "unsupported_lane"; echo "unsupported multilayer runtime lane: $lane" >&2; exit 2 ;; \
      esac; \
      ab_script="${FULLMAG_FDM_MULTILAYER_AB_SCENARIO:-tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario.py}"; \
      a_only_script="${FULLMAG_FDM_MULTILAYER_A_ONLY_SCENARIO:-tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_a_only.py}"; b_only_script="${FULLMAG_FDM_MULTILAYER_B_ONLY_SCENARIO:-tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_b_only.py}"; \
      if [ -z "$a_only_script" ] || [ -z "$b_only_script" ]; then write_status "control_scenarios_missing"; echo "not_qualified: control_scenarios_missing (set FULLMAG_FDM_MULTILAYER_A_ONLY_SCENARIO and FULLMAG_FDM_MULTILAYER_B_ONLY_SCENARIO)" >&2; exit 3; fi; \
      for script in "$ab_script" "$a_only_script" "$b_only_script"; do if [ ! -f "$script" ]; then write_status "scenario_missing"; echo "not_qualified: scenario_missing:$script" >&2; exit 3; fi; done; \
      if cmp -s "$ab_script" "$a_only_script" || cmp -s "$ab_script" "$b_only_script" || cmp -s "$a_only_script" "$b_only_script"; then write_status "control_scenarios_not_distinct"; echo "not_qualified: control_scenarios_not_distinct" >&2; exit 3; fi; \
      just ensure-python; FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 just build target=fullmag cpu_only=1; test -x "{{local_bin}}/fullmag"; \
      "{{repo_python}}" scripts/capture_source_snapshot_identity.py --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --output "$run_root/source-snapshot.v1.json"; \
      sha256sum "{{local_bin}}/fullmag" tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json > "$run_root/input-sha256.txt"; \
      run_case() { case_id="$1"; script="$2"; output="$run_root/$case_id/artifacts"; mkdir -p "$output"; FULLMAG_API_PORT=0 FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION=cpu FULLMAG_DISABLE_PREVIEW_3D=1 FULLMAG_DISABLE_CHARTS=1 "{{local_bin}}/fullmag" "$script" --backend fdm --headless --json --output-dir "$output" 2>&1 | tee "$run_root/$case_id/runtime.log"; }; \
      run_case ab "$ab_script" || { write_status "cpu_runtime_failed:ab"; exit 3; }; run_case a-only "$a_only_script" || { write_status "cpu_runtime_failed:a-only"; exit 3; }; run_case b-only "$b_only_script" || { write_status "cpu_runtime_failed:b-only"; exit 3; }; \
      for case_id in ab a-only b-only; do if [ ! -f "$run_root/$case_id/artifacts/metadata.json" ]; then write_status "runtime_artifacts_missing"; echo "not_qualified: runtime_artifacts_missing:$case_id" >&2; exit 3; fi; done; \
      measurement_script="tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/measure_runtime.py"; verifier_script="tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/runtime_verify.py"; \
      PYTHONPATH="{{repo_root}}/packages/fullmag-py/src" "{{repo_python}}" -m tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.measure_runtime "$run_root/ab/artifacts" "$run_root/a-only/artifacts" "$run_root/b-only/artifacts" "$run_root/runtime.json"; \
      PYTHONPATH="{{repo_root}}/packages/fullmag-py/src" "{{repo_python}}" -m tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.runtime_verify "$run_root/runtime.json" > "$run_root/runtime-verification.json"; \
      printf "{\"status\":\"verified\",\"lane\":\"%s\",\"artifact\":\"%s\"}\n" "$lane" "$run_root/runtime.json" > "$status_file"; echo "validated real CPU FP64 FDM multilayer artifact: $run_root/runtime.json"'

# E4: Dedicated managed-container CPU FP64 L=3 Appendix-A gate.  It is kept
# separate from the L=2 A+B/A-only/B-only measurement recipe because that
# measurement contract has exactly two physical layers.
verify-fdm-multilayer-l3-runtime:
    bash -euo pipefail -c '\
      report_parent="${FULLMAG_FDM_MULTILAYER_REPORT_ROOT:-.fullmag/reports/fdm-multilayer}"; \
      mkdir -p "$report_parent"; \
      run_root="$(mktemp -d "$report_parent/l3-cpu-fp64.run.XXXXXXXX")"; \
      status_file="$run_root/status.json"; \
      write_status() { printf "{\"status\":\"not_qualified\",\"lane\":\"cpu-fp64\",\"reason_code\":\"%s\"}\n" "$1" > "$status_file"; }; \
      finish() { status=$?; chmod -R a-w "$run_root" 2>/dev/null || true; exit "$status"; }; \
      trap finish EXIT INT TERM; \
      regular_script="tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_l3_regular_small.py"; \
      heterogeneous_script="tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_l3_heterogeneous_small.py"; \
      for script in "$regular_script" "$heterogeneous_script"; do test -f "$script" || { write_status "scenario_missing"; echo "not_qualified: scenario_missing:$script" >&2; exit 3; }; done; \
      just ensure-python; \
      just ensure-managed-fem-runtime || { write_status "managed_runtime_unavailable"; exit 3; }; \
      test -x "{{gpu_runtime_bin}}" && test -f "{{gpu_runtime_manifest}}" || { write_status "managed_runtime_missing"; exit 3; }; \
      python3 scripts/capture_source_snapshot_identity.py --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --output "$run_root/source-snapshot.v1.json"; \
      cp "{{gpu_runtime_manifest}}" "$run_root/managed-runtime-manifest.json"; \
      captured_source_snapshot="$(jq -er '"'"'.source_snapshot_sha256'"'"' "$run_root/source-snapshot.v1.json")" || { write_status "source_snapshot_invalid"; exit 3; }; \
      runtime_source_snapshot="$(jq -er '"'"'.build_identity.source_snapshot_sha256'"'"' "$run_root/managed-runtime-manifest.json")" || { write_status "managed_runtime_source_snapshot_missing"; exit 3; }; \
      if [ "$runtime_source_snapshot" != "$captured_source_snapshot" ]; then write_status "managed_runtime_source_snapshot_mismatch"; exit 3; fi; \
      hash_file() { sha256sum "$1" | cut -d" " -f1; }; \
      # Hash the snapshot path passed by the caller; keep JSON shape stable so pre/post cmp is meaningful. \
      write_structural_hashes() { hashes_output="$1"; source_output="$2"; snapshot_path="$3"; runtime_sha="$(hash_file "{{gpu_runtime_bin}}")"; manifest_sha="$(hash_file "{{gpu_runtime_manifest}}")"; recipe_sha="$(hash_file justfile)"; thresholds_sha="$(hash_file tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json)"; regular_sha="$(hash_file "$regular_script")"; heterogeneous_sha="$(hash_file "$heterogeneous_script")"; oracle_sha="$(hash_file scripts/verify_fdm_multilayer_independent_oracle.py)"; transfer_sha="$(hash_file scripts/verify_fdm_multilayer_transfer_parity.py)"; snapshot_file_sha="$(hash_file "$snapshot_path")"; snapshot_sha="$(jq -er '"'"'.source_snapshot_sha256'"'"' "$snapshot_path")"; dirty_sha="$(jq -er '"'"'.dirty_content_sha256 // ""'"'"' "$snapshot_path")"; head_commit="$(jq -er '"'"'.head_commit_full'"'"' "$snapshot_path")"; printf '{"schema_version":"fdm_multilayer_l3_input_hashes.v1","inputs":{"runtime_binary":{"path":"fem-gpu-host/bin/fullmag-fem-gpu","sha256":"%s"},"runtime_manifest":{"path":"fem-gpu-host/manifest.json","sha256":"%s"},"recipe":{"path":"justfile","sha256":"%s"},"thresholds":{"path":"tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json","sha256":"%s"}}}\n' "$runtime_sha" "$manifest_sha" "$recipe_sha" "$thresholds_sha" > "$hashes_output"; printf '{"schema_version":"fdm_multilayer_l3_source_hashes.v1","source":{"regular_scenario":{"path":"tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_l3_regular_small.py","sha256":"%s"},"heterogeneous_scenario":{"path":"tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_l3_heterogeneous_small.py","sha256":"%s"},"independent_oracle":{"path":"scripts/verify_fdm_multilayer_independent_oracle.py","sha256":"%s"},"transfer_parity":{"path":"scripts/verify_fdm_multilayer_transfer_parity.py","sha256":"%s"},"snapshot_file":{"sha256":"%s"},"source_snapshot_sha256":"%s","dirty_content_sha256":"%s","head_commit_full":"%s"}}\n' "$regular_sha" "$heterogeneous_sha" "$oracle_sha" "$transfer_sha" "$snapshot_file_sha" "$snapshot_sha" "$dirty_sha" "$head_commit" > "$source_output"; }; \
      write_structural_hashes "$run_root/input-hashes.v1.json" "$run_root/source-hashes.v1.json" "$run_root/source-snapshot.v1.json"; \
      sha256sum "{{gpu_runtime_bin}}" "{{gpu_runtime_manifest}}" "$regular_script" "$heterogeneous_script" tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json scripts/verify_fdm_multilayer_independent_oracle.py scripts/verify_fdm_multilayer_transfer_parity.py > "$run_root/input-sha256.txt"; \
      printf "%s\n" "just verify-fdm-multilayer-l3-runtime" > "$run_root/command.txt"; \
      run_case() { case_id="$1"; script="$2"; output="$run_root/$case_id/artifacts"; mkdir -p "$output"; docker compose --profile fem-gpu run --rm --no-deps -e PYTHONPATH=/workspace/packages/fullmag-py/src -e FULLMAG_PYTHON=/usr/bin/python3 -e FULLMAG_FDM_EXECUTION=cpu -e FULLMAG_FEM_EXECUTION=cpu -e FULLMAG_DISABLE_PREVIEW_3D=1 -e FULLMAG_DISABLE_CHARTS=1 fem-gpu bash -lc "cd /workspace && FULLMAG_API_PORT=0 .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu $script --backend fdm --headless --json --output-dir /workspace/$output --workspace-root /workspace/$output/workspace-history" 2>&1 | tee "$run_root/$case_id/runtime.log"; }; \
      run_case regular "$regular_script" || { write_status "cpu_runtime_failed:regular_l3"; exit 3; }; \
      run_case heterogeneous "$heterogeneous_script" || { write_status "cpu_runtime_failed:heterogeneous_l3"; exit 3; }; \
      for case_id in regular heterogeneous; do test -f "$run_root/$case_id/artifacts/metadata.json" || { write_status "runtime_artifacts_missing:$case_id"; exit 3; }; done; \
      PYTHONPATH="{{repo_root}}/packages/fullmag-py/src:{{repo_root}}" "{{repo_python}}" scripts/verify_fdm_multilayer_independent_oracle.py --artifact "$run_root/regular/artifacts" --output "$run_root/l3-regular-oracle.json" || { write_status "regular_oracle_failed"; exit 3; }; \
      PYTHONPATH="{{repo_root}}/packages/fullmag-py/src:{{repo_root}}" "{{repo_python}}" scripts/verify_fdm_multilayer_transfer_parity.py "$run_root/heterogeneous/artifacts" --max-target-cells 128 --max-energy-cells 4096 --json-output "$run_root/l3-heterogeneous-transfer.json" || { write_status "heterogeneous_transfer_failed"; exit 3; }; \
      jq -e '"'"'.qualification_status == "qualified"'"'"' "$run_root/l3-regular-oracle.json" >/dev/null || { write_status "regular_oracle_not_qualified"; exit 3; }; \
      jq -e '"'"'.qualification_status == "qualified"'"'"' "$run_root/l3-heterogeneous-transfer.json" >/dev/null || { write_status "heterogeneous_transfer_not_qualified"; exit 3; }; \
      if ! python3 scripts/capture_source_snapshot_identity.py --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --compare "$run_root/source-snapshot.v1.json" --output "$run_root/source-snapshot-post.v1.json"; then write_status "source_drift_after_runtime"; exit 3; fi; \
      write_structural_hashes "$run_root/input-hashes-post.v1.json" "$run_root/source-hashes-post.v1.json" "$run_root/source-snapshot-post.v1.json"; \
      if ! cmp -s "$run_root/input-hashes.v1.json" "$run_root/input-hashes-post.v1.json"; then write_status "input_hash_drift_after_runtime"; exit 3; fi; \
      if ! cmp -s "$run_root/source-hashes.v1.json" "$run_root/source-hashes-post.v1.json"; then write_status "source_hash_drift_after_runtime"; exit 3; fi; \
      jq -n --slurpfile source "$run_root/source-snapshot.v1.json" --slurpfile manifest "$run_root/managed-runtime-manifest.json" --slurpfile regular "$run_root/l3-regular-oracle.json" --slurpfile heterogeneous "$run_root/l3-heterogeneous-transfer.json" --slurpfile input_hashes "$run_root/input-hashes.v1.json" --slurpfile source_hashes "$run_root/source-hashes.v1.json" --slurpfile input_hashes_post "$run_root/input-hashes-post.v1.json" --slurpfile source_hashes_post "$run_root/source-hashes-post.v1.json" '"'"'{schema_version:"fdm_multilayer_l3_managed_runtime.v1",qualification_scope:"SP4-derived, not canonical SP4 qualification",lane:{backend:"fdm",device:"cpu",precision:"double",execution_mode:"strict"},managed_container:true,source_snapshot:$source[0],managed_runtime_manifest:$manifest[0],input_hashes:$input_hashes[0],source_hashes:$source_hashes[0],post_run_hashes:{inputs:$input_hashes_post[0],source:$source_hashes_post[0]},drift_checks:{source_identity_unchanged:true,input_hashes_unchanged:true,source_hashes_unchanged:true},regular_oracle:$regular[0],heterogeneous_transfer:$heterogeneous[0]}'"'"' > "$run_root/summary.json" || { write_status "summary_write_failed"; exit 3; }; \
      printf "{\"status\":\"verified\",\"lane\":\"cpu-fp64\",\"artifact\":\"%s\",\"summary\":\"%s\"}\n" "$run_root" "$run_root/summary.json" > "$status_file"; \
      echo "validated managed-container CPU FP64 FDM multilayer L=3 artifacts: $run_root/summary.json"'

# D-07: managed native CUDA multilayer demag telemetry and parity gate. The
# surrounding staged RK remains host-authoritative; only the v2 demag refresh
# is qualified as device-resident by exact L/L/L^2 counters.
verify-fdm-multilayer-cuda-runtime lane="cuda-fp64":
    bash -euo pipefail -c '\
      lane="{{lane}}"; report_parent="${FULLMAG_FDM_MULTILAYER_REPORT_ROOT:-.fullmag/reports/fdm-multilayer}"; mkdir -p "$report_parent"; run_root="$(mktemp -d "$report_parent/$lane.run.XXXXXXXX")"; status_file="$run_root/status.json"; \
      write_status() { printf "{\"status\":\"not_qualified\",\"lane\":\"%s\",\"reason_code\":\"%s\"}\n" "$lane" "$1" > "$status_file"; }; finish() { status=$?; chmod -R a-w "$run_root" 2>/dev/null || true; exit "$status"; }; trap finish EXIT INT TERM; \
      case "$lane" in cuda-fp64|cuda-fp32) ;; *) write_status "unsupported_lane"; exit 2 ;; esac; \
      scenario="tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/scenario_l3_cuda_v2_small.py"; thresholds="tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json"; verifier="scripts/verify_fdm_multilayer_cuda_parity.py"; \
      for required in "$scenario" "$thresholds" "$verifier"; do test -f "$required" || { write_status "input_missing"; exit 3; }; done; \
      just ensure-managed-fem-runtime || { write_status "managed_runtime_unavailable"; exit 3; }; test -x "{{gpu_runtime_bin}}" && test -f "{{gpu_runtime_manifest}}" || { write_status "managed_runtime_missing"; exit 3; }; \
      python3 scripts/capture_source_snapshot_identity.py --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --output "$run_root/source-snapshot.v1.json"; cp "{{gpu_runtime_manifest}}" "$run_root/managed-runtime-manifest.json"; \
      captured_source_snapshot="$(jq -er '"'"'"'.source_snapshot_sha256'"'"'"' "$run_root/source-snapshot.v1.json")" || { write_status "source_snapshot_invalid"; exit 3; }; \
      runtime_source_snapshot="$(jq -er '"'"'"'.build_identity.source_snapshot_sha256'"'"'"' "$run_root/managed-runtime-manifest.json")" || { write_status "managed_runtime_source_snapshot_missing"; exit 3; }; \
      if [ "$runtime_source_snapshot" != "$captured_source_snapshot" ]; then write_status "managed_runtime_source_snapshot_mismatch"; exit 3; fi; \
      hash_runtime_inputs() { sha256sum "{{gpu_runtime_bin}}" "{{gpu_runtime_manifest}}" > "$1"; }; hash_source_inputs() { sha256sum "$scenario" "$thresholds" "$verifier" justfile > "$1"; }; \
      hash_runtime_inputs "$run_root/input-hashes.v1.txt"; hash_source_inputs "$run_root/source-hashes.v1.txt"; cp "$run_root/input-hashes.v1.txt" "$run_root/input-sha256.txt"; \
      printf "%s\n" "just verify-fdm-multilayer-cuda-runtime $lane" > "$run_root/command.txt"; printf "%s\n" "d07_telemetry_not_qualified" "cpu_cuda_parity_not_qualified" "managed_runtime_source_snapshot_mismatch" "source_drift_after_runtime" "input_hash_drift_after_runtime" "source_hash_drift_after_runtime" > "$run_root/failure-reason-codes.txt"; \
      docker compose --profile fem-gpu run --rm --no-deps fem-gpu nvidia-smi -L 2>&1 | tee "$run_root/device.log" || { write_status "cuda_device_unavailable"; exit 3; }; \
      run_case() { case_id="$1"; execution="$2"; precision="$3"; output="$run_root/$case_id/artifacts"; mkdir -p "$output"; docker compose --profile fem-gpu run --rm --no-deps -e PYTHONPATH=/workspace/packages/fullmag-py/src -e FULLMAG_PYTHON=/usr/bin/python3 -e FULLMAG_FDM_EXECUTION="$execution" -e FULLMAG_FEM_EXECUTION=cpu -e FULLMAG_FDM_MULTILAYER_SCENARIO_PRECISION="$precision" -e FULLMAG_DISABLE_PREVIEW_3D=1 -e FULLMAG_DISABLE_CHARTS=1 fem-gpu bash -lc "cd /workspace && FULLMAG_API_PORT=0 .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu $scenario --backend fdm --headless --json --output-dir /workspace/$output --workspace-root /workspace/$output/workspace-history" 2>&1 | tee "$run_root/$case_id/runtime.log"; }; \
      if [ "$lane" = "cuda-fp64" ]; then run_case reference cpu double || { write_status "cpu_reference_runtime_failed"; exit 3; }; candidate_precision=double; else run_case reference cuda double || { write_status "cuda_fp64_reference_runtime_failed"; exit 3; }; candidate_precision=single; fi; \
      run_case candidate cuda "$candidate_precision" || { write_status "cuda_runtime_failed"; exit 3; }; \
      for case_id in reference candidate; do test -f "$run_root/$case_id/artifacts/metadata.json" || { write_status "runtime_artifacts_missing"; exit 3; }; done; \
      PYTHONPATH="{{repo_root}}/packages/fullmag-py/src:{{repo_root}}" "{{repo_python}}" "$verifier" --reference "$run_root/reference/artifacts" --candidate "$run_root/candidate/artifacts" --thresholds "$thresholds" --lane "$lane" --output "$run_root/parity.json" || { write_status "d07_or_cpu_cuda_parity_not_qualified"; exit 3; }; \
      if ! python3 scripts/capture_source_snapshot_identity.py --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --compare "$run_root/source-snapshot.v1.json" --output "$run_root/source-snapshot-post.v1.json"; then write_status "source_drift_after_runtime"; exit 3; fi; \
      hash_runtime_inputs "$run_root/input-hashes-post.v1.txt"; hash_source_inputs "$run_root/source-hashes-post.v1.txt"; \
      if ! cmp -s "$run_root/input-hashes.v1.txt" "$run_root/input-hashes-post.v1.txt"; then write_status "input_hash_drift_after_runtime"; exit 3; fi; \
      if ! cmp -s "$run_root/source-hashes.v1.txt" "$run_root/source-hashes-post.v1.txt"; then write_status "source_hash_drift_after_runtime"; exit 3; fi; \
      if ! cmp -s "{{gpu_runtime_manifest}}" "$run_root/managed-runtime-manifest.json"; then write_status "managed_runtime_manifest_drift_after_runtime"; exit 3; fi; \
      printf "{\"status\":\"verified\",\"lane\":\"%s\",\"artifact\":\"%s\"}\n" "$lane" "$run_root/parity.json" > "$status_file"; echo "validated managed CUDA D-07 artifact: $run_root/parity.json"'

verify-fdm-multilayer-airbox-runtime lane="cpu-fp64":
    bash -euo pipefail -c '\
      lane="{{lane}}"; report_parent="${FULLMAG_FDM_MULTILAYER_REPORT_ROOT:-.fullmag/reports/fdm-multilayer}"; mkdir -p "$report_parent"; run_root="$(mktemp -d "$report_parent/airbox-${lane}.run.XXXXXXXX")"; status_file="$run_root/status.json"; \
      write_status() { printf "{\"status\":\"not_qualified\",\"lane\":\"%s\",\"reason_code\":\"%s\"}\n" "$lane" "$1" > "$status_file"; }; finish() { status=$?; chmod -R a-w "$run_root" 2>/dev/null || true; exit "$status"; }; trap finish EXIT INT TERM; \
      case "$lane" in cpu-fp64) ;; cuda-fp64|cuda-fp32) reason="cuda_managed_artifact_missing"; if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi -L >/dev/null 2>&1; then reason="cuda_device_unavailable"; elif [ -x "{{gpu_runtime_bin}}" ] && [ -f "{{gpu_runtime_manifest}}" ]; then reason="cuda_lane_artifact_not_qualified"; fi; write_status "$reason"; echo "not_qualified: $reason ($lane)" >&2; exit 3 ;; *) write_status "unsupported_lane"; echo "unsupported multilayer Airbox lane: $lane" >&2; exit 2 ;; esac; \
      demag_report="${FULLMAG_FDM_MULTILAYER_DEMAG_REPORT:-}"; carrier="${FULLMAG_FDM_MULTILAYER_AIRBOX_CARRIER:-}"; \
      if [ -z "$demag_report" ]; then write_status "demag_report_missing"; echo "not_qualified: demag_report_missing" >&2; exit 3; fi; if [ -z "$carrier" ]; then write_status "airbox_carrier_missing"; echo "not_qualified: airbox_carrier_missing (set FULLMAG_FDM_MULTILAYER_AIRBOX_CARRIER)" >&2; exit 3; fi; \
      runtime_json="$demag_report/runtime.json"; if [ ! -f "$runtime_json" ]; then write_status "runtime_artifacts_missing"; echo "not_qualified: runtime_artifacts_missing:$runtime_json" >&2; exit 3; fi; \
      verifier_script="tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/runtime_verify.py"; echo "required carrier scope_kind=airbox quantity=H_demag"; PYTHONPATH="{{repo_root}}/packages/fullmag-py/src" "{{repo_python}}" -m tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.runtime_verify "$runtime_json" > "$run_root/runtime-verification.json" || { write_status "runtime_verifier_failed"; exit 3; }; \
      PYTHONPATH="{{repo_root}}/packages/fullmag-py/src" python3 scripts/verify_fdm_multilayer_airbox_carrier.py "$carrier" --output "$run_root/airbox-carrier-verification.json" || { write_status "airbox_carrier_invalid"; exit 3; }; \
      printf "{\"status\":\"verified\",\"lane\":\"%s\",\"scope_kind\":\"airbox\",\"quantity\":\"H_demag\",\"carrier\":\"%s\"}\n" "$lane" "$carrier" > "$status_file"; echo "validated runtime-origin Airbox H_demag carrier: $carrier"'

verify-fdm-multilayer-demag-production:
    bash -euo pipefail -c '\
      report_parent="${FULLMAG_FDM_MULTILAYER_REPORT_ROOT:-.fullmag/reports/fdm-multilayer}"; mkdir -p "$report_parent"; run_root="$(mktemp -d "$report_parent/production.run.XXXXXXXX")"; status_file="$run_root/status.json"; \
      write_status() { printf "{\"status\":\"not_qualified\",\"reason_code\":\"%s\"}\n" "$1" > "$status_file"; }; finish() { status=$?; chmod -R a-w "$run_root" 2>/dev/null || true; exit "$status"; }; trap finish EXIT INT TERM; \
      if [ ! -x "{{gpu_runtime_bin}}" ] || [ ! -f "{{gpu_runtime_manifest}}" ]; then write_status "cuda_managed_artifact_missing"; echo "not_qualified: cuda_managed_artifact_missing" >&2; exit 3; fi; if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi -L >/dev/null 2>&1; then write_status "cuda_device_unavailable"; echo "not_qualified: cuda_device_unavailable" >&2; exit 3; fi; \
      just verify-fdm-multilayer-demag-runtime cpu-fp64; if [ -z "${FULLMAG_FDM_MULTILAYER_DEMAG_REPORT:-}" ] || [ -z "${FULLMAG_FDM_MULTILAYER_AIRBOX_CARRIER:-}" ]; then write_status "airbox_carrier_missing"; echo "not_qualified: airbox_carrier_missing" >&2; exit 3; fi; just verify-fdm-multilayer-airbox-runtime cpu-fp64; just verify-fdm-multilayer-demag-runtime cuda-fp64; just verify-fdm-multilayer-demag-runtime cuda-fp32; write_status "cuda_lane_not_qualified"; echo "not_qualified: cuda_lane_not_qualified" >&2; exit 3'

# Managed FEM CPU graph-realization gate.  The native MFEM runtime is built in
# the managed fem-gpu image, while the fixture requests the CPU FEM lane and
# verifies concrete element-marker provenance in the public artifact.
verify-fem-physics-graph-runtime:
    docker compose --profile fem-gpu run --rm fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:$${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-physics-graph-runtime CARGO_INCREMENTAL=0 cargo test -p fullmag-runner --features fem-gpu --test physics_graph_runtime -- --nocapture'

# Cross-layer authoring parity only.  This gate intentionally does not promote
# any FEM/FDM, GPU, or external-solver capability.
verify-spin-transport-authoring-parameter-parity:
    PYTHONPATH=packages/fullmag-py/src python3 scripts/verify_spin_transport_authoring_parameter_parity.py

verify-fdm-prescribed-sot-native-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && build_dir=/tmp/fullmag-fdm-prescribed-sot-build && cargo_target=/tmp/fullmag-fdm-prescribed-sot-cargo && cmake -S native -B "$build_dir" -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF && CMAKE_BUILD_PARALLEL_LEVEL=1 cmake --build "$build_dir" --target prescribed_sot_contract prescribed_sot_cuda_runtime fullmag_fdm && "$build_dir/backends/fdm/prescribed_sot_contract" && LD_LIBRARY_PATH="$build_dir/backends/fdm:${LD_LIBRARY_PATH:-}" "$build_dir/backends/fdm/prescribed_sot_cuda_runtime" && FULLMAG_FDM_LIB_DIR="$build_dir/backends/fdm" LD_LIBRARY_PATH="$build_dir/backends/fdm${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" CARGO_TARGET_DIR="$cargo_target" cargo +nightly test -p fullmag-runner --features cuda --lib native_fdm_prescribed_sot -- --nocapture'

verify-fdm-oersted-native-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && build_dir=/tmp/fullmag-fdm-oersted-build && cmake -S native -B "$build_dir" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF && CMAKE_BUILD_PARALLEL_LEVEL=1 cmake --build "$build_dir" --target oersted_cuda_runtime && LD_LIBRARY_PATH="$build_dir/backends/fdm:${LD_LIBRARY_PATH:-}" "$build_dir/backends/fdm/oersted_cuda_runtime"'

verify-boris-nf-interface:
    bash -euo pipefail -c '\
      build_root="${FULLMAG_BORIS_BUILD_ROOT:-/zfn2/mateuszz/git/fullmag/boris-build/source}"; \
      report_root="${FULLMAG_BORIS_SHE_REPORT_ROOT:-/zfn2/mateuszz/git/fullmag/boris-build/reports/boris-nf-interface}"; \
      resolutions="${FULLMAG_BORIS_SHE_RESOLUTIONS:-coarse medium fine}"; \
      image="${FULLMAG_BORIS_IMAGE:-nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f}"; \
      runtime_container="${FULLMAG_BORIS_RUNTIME_CONTAINER:-}"; \
      case "$build_root" in /zfn2/mateuszz/git/fullmag/*) ;; *) echo "BORIS build root must be below /zfn2/mateuszz/git/fullmag" >&2; exit 2 ;; esac; \
      case "$report_root" in /zfn2/mateuszz/git/fullmag/*) ;; *) echo "BORIS report root must be below /zfn2/mateuszz/git/fullmag" >&2; exit 2 ;; esac; \
      test -x "$build_root/BorisLin"; \
      test -f "$build_root/source_manifest.json" || test -f "$build_root/source-manifest.json"; \
      mkdir -p "$report_root"; \
      for resolution in $resolutions; do \
        run_dir="$report_root/$resolution"; \
        if [ -e "$run_dir" ] && [ -n "$(find "$run_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then echo "BORIS report directory is non-empty: $run_dir" >&2; exit 3; fi; \
        args=(scripts/run_boris_nf_interface.py --build-root "$build_root" --output-dir "$run_dir" --device "${FULLMAG_BORIS_DEVICE:-cpu}" --resolution "$resolution" --image-digest "$image" --timeout-s "${FULLMAG_BORIS_TIMEOUT_S:-180}"); \
        if [ -n "$runtime_container" ]; then args+=(--runtime-container "$runtime_container"); fi; \
        PYTHONPATH=scripts python3 "${args[@]}"; \
        PYTHONPATH=scripts python3 scripts/verify_boris_nf_interface.py "$run_dir" --output "$run_dir/validation-rerun.json"; \
      done'

verify-boris-fullmag-she-nf:
    bash -euo pipefail -c '\
      boris_root="${FULLMAG_BORIS_BUILD_ROOT:-/zfn2/mateuszz/git/fullmag/boris-build/source}"; \
      fullmag_bin="${FULLMAG_FULLMAG_BINARY:-{{repo_root}}/.fullmag/local/bin/fullmag}"; \
      report_root="${FULLMAG_BORIS_FULLMAG_SHE_REPORT_ROOT:-/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-boris-she-nf-v1}"; \
      case "$boris_root" in /zfn2/mateuszz/git/fullmag/*) ;; *) echo "BORIS build root must be below /zfn2/mateuszz/git/fullmag" >&2; exit 2 ;; esac; \
      case "$report_root" in /zfn2/mateuszz/git/fullmag/*) ;; *) echo "matrix report root must be below /zfn2/mateuszz/git/fullmag" >&2; exit 2 ;; esac; \
      test -x "$boris_root/BorisLin"; \
      test -f "$boris_root/source_manifest.json" || test -f "$boris_root/source-manifest.json"; \
      test -x "$fullmag_bin"; \
      if [ -e "$report_root/matrix.json" ]; then echo "matrix report already exists: $report_root/matrix.json" >&2; exit 3; fi; \
      mkdir -p "$report_root"; \
      PYTHONPATH="packages/fullmag-py/src:scripts${PYTHONPATH:+:$PYTHONPATH}" python3 scripts/run_boris_fullmag_she_nf_matrix.py --boris-build-root "$boris_root" --fullmag "$fullmag_bin" --report-root "$report_root" --device "${FULLMAG_BORIS_DEVICE:-cuda}"'

verify-fdm-zhang-li-native-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && build_dir=/tmp/fullmag-fdm-zhangli-build && cargo_target=/tmp/fullmag-fdm-zhangli-cargo && cmake -S native -B "$build_dir" -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF && CMAKE_BUILD_PARALLEL_LEVEL=1 cmake --build "$build_dir" --target fullmag_fdm stt_pbc_contract && "$build_dir/backends/fdm/stt_pbc_contract" && FULLMAG_FDM_LIB_DIR="$build_dir/backends/fdm" LD_LIBRARY_PATH="$build_dir/backends/fdm${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" CARGO_TARGET_DIR="$cargo_target" cargo +nightly test -p fullmag-runner --features cuda --lib native_fdm_mumax3_zhang_li_matches_cpu_reference_for_one_masked_step_when_cuda_is_available -- --nocapture'

# Artifact qualification is intentionally separate from the one-step operator
# contract above. It fails unless both full CPU/CUDA parity and the external
# MuMax3 mean-magnetization tolerance pass for the canonical 1 ns workload.
verify-fdm-sp5-validator:
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest \
      scripts.test_validate_fdm_sp5_runtime \
      scripts.test_compare_fdm_sp5_mumax_fields \
      scripts.test_compare_fdm_sp5_mumax_effective_fields -v

verify-fdm-sp5-artifacts cpu_run gpu_run output:
    python3 scripts/validate_fdm_sp5_runtime.py \
      --cpu "{{cpu_run}}" \
      --gpu "{{gpu_run}}" \
      --output "{{output}}"

verify-fdm-sp5-converged-demag-artifacts cpu_run gpu_run reference_ovf output:
    python3 scripts/validate_fdm_sp5_runtime.py \
      --cpu "{{cpu_run}}" \
      --gpu "{{gpu_run}}" \
      --converged-reference-ovf "{{reference_ovf}}" \
      --qualification-reference converged_demag \
      --converged-reference-tolerance 1e-4 \
      --output "{{output}}"

verify-fdm-slonczewski-native-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && build_dir=/tmp/fullmag-fdm-slonczewski-build && cargo_target=/tmp/fullmag-fdm-slonczewski-cargo && cmake -S native -B "$build_dir" -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF && CMAKE_BUILD_PARALLEL_LEVEL=1 cmake --build "$build_dir" --target fullmag_fdm && FULLMAG_FDM_LIB_DIR="$build_dir/backends/fdm" LD_LIBRARY_PATH="$build_dir/backends/fdm${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" CARGO_TARGET_DIR="$cargo_target" cargo +nightly test -p fullmag-runner --features cuda --lib native_fdm_canonical_slonczewski_ -- --nocapture'

verify-fem-relaxation-source-contract:
    bash scripts/verify_fem_mesh_hot_loop_source_contract.sh
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake --build native/build --target fem_relaxation_source_contract fem_relaxation_energy_derivative_contract fem_stage_completion_contract fem_rk_explicit_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_relaxation_source_contract && native/build/backends/fem/fem_relaxation_energy_derivative_contract && native/build/backends/fem/fem_stage_completion_contract && native/build/backends/fem/fem_rk_explicit_contract'

verify-fem-solver-optimization-ledger:
    python3 scripts/validate_fem_solver_optimization_ledger.py docs/audits/2026-07-29-fem-solver-optimization-remediation-ledger.md

# T14 source/API trace contract.  The managed browser smoke remains a separate
# measurement gate; this recipe proves the bounded server model, API mapping,
# publisher propagation and browser observer units without inventing a runtime
# or GPU performance result when browser dependencies are unavailable.
verify-fem-solver-trace-contract:
    PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q scripts/test_validate_fem_solver_trace.py --capture=sys
    CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-solver-trace-contract CARGO_INCREMENTAL=0 cargo test -q -p fullmag-runner solver_trace --lib
    CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-solver-trace-contract CARGO_INCREMENTAL=0 cargo test -q -p fullmag-cli --bin fullmag trace --
    CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-solver-trace-contract CARGO_INCREMENTAL=0 cargo test -q -p fullmag-api --bin fullmag-api trace --
    if [ -d apps/control-room/node_modules ]; then \
      if command -v pnpm >/dev/null 2>&1; then PNPM_CMD=pnpm; \
      elif command -v corepack >/dev/null 2>&1; then PNPM_CMD="corepack pnpm"; \
      else echo "pnpm or corepack not found on PATH" >&2; exit 127; fi; \
      $PNPM_CMD --dir apps/control-room exec vitest run \
        src/kernel/diagnostics/solverTrace.test.ts \
        src/kernel/resources/studyRuntimeResources.test.ts; \
    else \
      echo "browser observer tests not run: apps/control-room/node_modules is unavailable" >&2; \
    fi

verify-fem-demag-amg-policy-contract:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc 'cd /workspace && FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_demag_amg_policy_has_one_owner_and_effective_abi_provenance -- --exact --nocapture && FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-runner --features fem-gpu artifacts::tests::demag_profile_metadata_includes_timing_breakdown -- --exact --nocapture && FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-fem-sys --features build-native tests::regional_field_drive_ffi_layout_matches_native_runtime -- --exact --nocapture'

verify-fem-demag-amg-benchmark-contract:
    python3 -m pytest -q scripts/test_validate_fem_relaxation_runtime_log.py -k 'demag_amg_profile_sweep_parser_and_policy_identity or amg_relax_qualification_ or demag_amg_qualification_suite_rejects_malformed_runtime_signature or demag_amg_qualification_suite_and_recipe_cover_the_exact_matrix'

verify-fem-dependency-stack-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake --fresh -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON && cmake --build native/build --parallel 8 --target fem_dependency_stack_contract && native/build/backends/fem/fem_dependency_stack_contract'

verify-fem-time-domain-native-contract:
    python3 scripts/check_llg_time_domain_contract_docs.py
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fem_mesh_contract fem_oersted_contract fem_state_io_contract fem_snapshot_contract fem_llg_rhs_contract fem_aos_field_contract fem_adaptive_dt_contract fem_rk_explicit_contract fem_rk_transaction_fault_injection_contract fem_stt_contract fem_cuda_tetra_gradient_contract fem_cuda_slonczewski_contract fem_cuda_rk_guard_contract fem_gpu_pageable_scalar_readback_contract fem_thermal_brown_contract fem_relaxation_source_contract fem_relaxation_energy_derivative_contract fem_relaxation_operator_contract fem_source_facade_gpu_rk_contract fem_gpu_solver_docs_contract fem_cpu_threads_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_mesh_contract && native/build/backends/fem/fem_oersted_contract && native/build/backends/fem/fem_state_io_contract && native/build/backends/fem/fem_snapshot_contract && native/build/backends/fem/fem_llg_rhs_contract && native/build/backends/fem/fem_aos_field_contract && native/build/backends/fem/fem_adaptive_dt_contract && native/build/backends/fem/fem_rk_explicit_contract && native/build/backends/fem/fem_rk_transaction_fault_injection_contract && native/build/backends/fem/fem_stt_contract && native/build/backends/fem/fem_cuda_tetra_gradient_contract && native/build/backends/fem/fem_cuda_slonczewski_contract && native/build/backends/fem/fem_cuda_rk_guard_contract && FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1 native/build/backends/fem/fem_gpu_pageable_scalar_readback_contract && native/build/backends/fem/fem_thermal_brown_contract && native/build/backends/fem/fem_relaxation_source_contract && native/build/backends/fem/fem_relaxation_energy_derivative_contract && native/build/backends/fem/fem_relaxation_operator_contract && native/build/backends/fem/fem_source_facade_gpu_rk_contract && native/build/backends/fem/fem_gpu_solver_docs_contract && native/build/backends/fem/fem_cpu_threads_contract && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-fem-mesh-abi-rust-target cargo test -p fullmag-fem-sys --lib'

verify-fem-mesh-runner-abi-contract:
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-fem-mesh-runner-abi-target cargo test -p fullmag-runner --features fem-gpu runner_mesh_pack_preserves_all_typed_csr_buffers_and_lifetimes'

verify-fem-llg-time-domain-qualification:
    rm -rf .fullmag/reports/fem-llg-time-domain-qualification/cpu-fp64
    mkdir -p .fullmag/reports/fem-llg-time-domain-qualification/cpu-fp64
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_llg_time_domain_qualification && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_llg_time_domain_qualification .fullmag/reports/fem-llg-time-domain-qualification/cpu-fp64/qualification.json'
    python3 scripts/validate_fem_llg_time_domain_qualification.py .fullmag/reports/fem-llg-time-domain-qualification/cpu-fp64/qualification.json

verify-fem-llg-time-domain-qualification-gpu:
    rm -rf .fullmag/reports/fem-llg-time-domain-qualification/gpu-fp64
    mkdir -p .fullmag/reports/fem-llg-time-domain-qualification/gpu-fp64
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_llg_time_domain_qualification && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_llg_time_domain_qualification .fullmag/reports/fem-llg-time-domain-qualification/gpu-fp64/qualification.json gpu'
    python3 scripts/validate_fem_llg_time_domain_qualification.py .fullmag/reports/fem-llg-time-domain-qualification/gpu-fp64/qualification.json --device gpu

verify-fem-llg-time-domain-qualification-production:
    just verify-fem-llg-time-domain-qualification
    just verify-fem-llg-time-domain-qualification-gpu
    python3 scripts/compare_fem_llg_time_domain_qualification.py --cpu .fullmag/reports/fem-llg-time-domain-qualification/cpu-fp64/qualification.json --gpu .fullmag/reports/fem-llg-time-domain-qualification/gpu-fp64/qualification.json --output .fullmag/reports/fem-llg-time-domain-qualification/parity-fp64.json

verify-fem-llg-periodic-antidot-qualification-runtime device="cpu":
    python3 scripts/validate_fem_periodic_antidot_llg_qualification_asset.py examples/assets/fem_periodic_antidot_llg_qualification.problem.json
    just ensure-managed-fem-runtime
    mode="{{device}}"; case "$mode" in cpu|gpu) ;; *) echo "device must be cpu or gpu" >&2; exit 2 ;; esac; \
      root=".fullmag/reports/fem-llg-periodic-antidot-qualification/$mode"; \
      rm -rf "$root"; mkdir -p "$root"; \
      if [ "$mode" = cpu ]; then \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu \
        FULLMAG_FEM_EXECUTION=cpu FULLMAG_RELAX_DEVICE=cpu FULLMAG_FEM_MFEM_DEVICE=cpu \
        FULLMAG_CPU_THREADS=auto \
        '{{gpu_runtime_bin}}' examples/fem_periodic_antidot_llg_qualification.py \
          --backend fem --headless --json --output-dir "$root/artifacts" \
          2>&1 | tee "$root/runtime.log"; \
      else \
        docker compose --profile fem-gpu run --rm \
          -e PYTHONPATH=/workspace/packages/fullmag-py/src \
          -e FULLMAG_PYTHON=/usr/bin/python3 \
          -e FULLMAG_FDM_EXECUTION=cpu \
          -e FULLMAG_FEM_EXECUTION=gpu \
          -e FULLMAG_RELAX_DEVICE=gpu \
          -e FULLMAG_FEM_MFEM_DEVICE=cuda \
          -e FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson \
          -e FULLMAG_CPU_THREADS=auto \
          -e FULLMAG_HOST_UID="$(id -u)" \
          -e FULLMAG_HOST_GID="$(id -g)" \
          fem-gpu bash -lc 'cd /workspace && \
            trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-llg-periodic-antidot-qualification/gpu 2>/dev/null || true'\'' EXIT && \
            .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
              examples/fem_periodic_antidot_llg_qualification.py \
              --backend fem --headless --json \
              --output-dir .fullmag/reports/fem-llg-periodic-antidot-qualification/gpu/artifacts \
              2>&1 | tee .fullmag/reports/fem-llg-periodic-antidot-qualification/gpu/runtime.log'; \
      fi; \
      python3 scripts/validate_fem_periodic_antidot_llg_qualification_runtime.py \
        "$root" --device "$mode"

verify-fem-llg-periodic-antidot-qualification-production:
    just verify-fem-llg-periodic-antidot-qualification-runtime cpu
    just verify-fem-llg-periodic-antidot-qualification-runtime gpu
    python3 scripts/compare_fem_periodic_antidot_llg_qualification.py \
      --cpu .fullmag/reports/fem-llg-periodic-antidot-qualification/cpu \
      --gpu .fullmag/reports/fem-llg-periodic-antidot-qualification/gpu \
      --output .fullmag/reports/fem-llg-periodic-antidot-qualification/parity-fp64.json

verify-fdm-time-domain-native-contract:
    docker compose --profile fem-gpu run --rm \
      -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build-fdm-cpu -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF && cmake --build native/build-fdm-cpu --target fullmag_fdm fdm_llg_time_policy_contract oersted_energy_contract partial_cell_energy_contract && LD_LIBRARY_PATH=/workspace/native/build-fdm-cpu/backends/fdm:${LD_LIBRARY_PATH:-} native/build-fdm-cpu/backends/fdm/fdm_llg_time_policy_contract && native/build-fdm-cpu/backends/fdm/oersted_energy_contract && native/build-fdm-cpu/backends/fdm/partial_cell_energy_contract && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fullmag_fdm fdm_llg_time_policy_contract oersted_energy_contract partial_cell_energy_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fdm:${LD_LIBRARY_PATH:-} native/build/backends/fdm/fdm_llg_time_policy_contract && native/build/backends/fdm/oersted_energy_contract && native/build/backends/fdm/partial_cell_energy_contract'

verify-fdm-cpu-m1-charge-native-contract:
    docker compose run --rm --no-deps \
      -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
      -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" \
      fem-cpu bash -lc 'cd /workspace && build_dir=/mnt/fullmag-zfn2-native/fdm-cpu-m1-charge && cargo_home="$build_dir/cargo-home" && cargo_target="$build_dir/cargo-target" && rust_output="$build_dir/rust-charge-parity-v1.txt" && small_rust_output="$build_dir/rust-charge-parity-small-current-v1.txt" && mkdir -p "$cargo_home" "$cargo_target" && cmake -S native -B "$build_dir" -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build "$build_dir" --target fdm_cpu_charge_transport_contract && ctest --test-dir "$build_dir/backends/fdm" --verbose -R "^fdm_cpu_charge_" && CARGO_HOME="$cargo_home" CARGO_TARGET_DIR="$cargo_target" CARGO_INCREMENTAL=0 cargo run -p fullmag-engine --example fdm_charge_oracle_v1 -- backends/fdm/tests/fixtures/charge_parity_v1.txt "$rust_output" && "$build_dir/backends/fdm/fdm_cpu_charge_transport_contract" --compare-rust backends/fdm/tests/fixtures/charge_parity_v1.txt "$rust_output" && CARGO_HOME="$cargo_home" CARGO_TARGET_DIR="$cargo_target" CARGO_INCREMENTAL=0 cargo run -p fullmag-engine --example fdm_charge_oracle_v1 -- backends/fdm/tests/fixtures/charge_parity_small_current_v1.txt "$small_rust_output" && "$build_dir/backends/fdm/fdm_cpu_charge_transport_contract" --compare-rust backends/fdm/tests/fixtures/charge_parity_small_current_v1.txt "$small_rust_output"'

verify-fdm-cpu-m1-spin-native-contract:
    docker compose run --rm --no-deps \
      -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
      -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" \
      fem-cpu bash -lc 'cd /workspace && build_dir=/mnt/fullmag-zfn2-native/fdm-cpu-m1-spin && cargo_home="$build_dir/cargo-home" && cargo_target="$build_dir/cargo-target" && rust_output="$build_dir/rust-spin-parity-v1.txt" && mkdir -p "$cargo_home" "$cargo_target" && cmake -S native -B "$build_dir" -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build "$build_dir" --target fdm_cpu_charge_transport_contract fdm_cpu_spin_transport_contract fdm_cpu_spin_transport_parity && ctest --test-dir "$build_dir/backends/fdm" --verbose -R "^fdm_cpu_(charge|spin)_transport_contract$" && CARGO_HOME="$cargo_home" CARGO_TARGET_DIR="$cargo_target" CARGO_INCREMENTAL=0 cargo run -p fullmag-engine --example fdm_spin_oracle_v1 -- backends/fdm/tests/fixtures/spin_parity_v1.txt "$rust_output" && "$build_dir/backends/fdm/fdm_cpu_spin_transport_parity" backends/fdm/tests/fixtures/spin_parity_v1.txt "$rust_output"'

verify-fdm-cpu-m1-transport-abi-contract:
    docker compose run --rm --no-deps \
      -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
      -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" \
      fem-cpu bash -lc 'cd /workspace && build_dir=/mnt/fullmag-zfn2-native/fdm-cpu-m1-binding && cargo_home="$build_dir/cargo-home" && cargo_target="$build_dir/cargo-target" && mkdir -p "$cargo_home" "$cargo_target" && cmake -S native -B "$build_dir" -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build "$build_dir" --target fullmag_fdm fdm_cpu_transport_abi_v1_contract fdm_gpu_transport_cpu_only_symbol_graph fdm_gpu_transport_layout_abi_v1_c11_contract && ctest --test-dir "$build_dir/backends/fdm" --verbose -R "^(fdm_cpu_transport_abi_v1_contract|fdm_gpu_transport_cpu_only_symbol_graph|fdm_gpu_transport_layout_abi_v1_c11_contract)$" && nm -D "$build_dir/backends/fdm/libfullmag_fdm.so" | grep -E "fullmag_fdm_(cpu_(transport_is_available|charge_solve|steady_spin_solve|charge_result_destroy)|gpu_transport_(context_create|context_destroy|static_descriptor_upload))_v1" && FULLMAG_FDM_LIB_DIR="$build_dir/backends/fdm" LD_LIBRARY_PATH="$build_dir/backends/fdm${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" CARGO_HOME="$cargo_home" CARGO_TARGET_DIR="$cargo_target" CARGO_INCREMENTAL=0 cargo test -p fullmag-fdm-sys tests::cpu_transport_abi_layout_manifest_matches_every_rust_record_field -- --exact --nocapture && FULLMAG_FDM_LIB_DIR="$build_dir/backends/fdm" LD_LIBRARY_PATH="$build_dir/backends/fdm${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" CARGO_HOME="$cargo_home" CARGO_TARGET_DIR="$cargo_target" CARGO_INCREMENTAL=0 cargo test -p fullmag-fdm-sys --doc fullmag_fdm_cpu_charge_result_v1 -- --nocapture && CARGO_HOME="$cargo_home" CARGO_TARGET_DIR="$cargo_target" CARGO_INCREMENTAL=0 cargo test -p fullmag-plan native_m1_v1 -- --nocapture && CARGO_HOME="$cargo_home" CARGO_TARGET_DIR="$cargo_target" CARGO_INCREMENTAL=0 cargo test -p fullmag-plan specified_current_density_resolves_exact_external_faces_with_area_and_sign -- --nocapture && FULLMAG_FDM_LIB_DIR="$build_dir/backends/fdm" LD_LIBRARY_PATH="$build_dir/backends/fdm${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" CARGO_HOME="$cargo_home" CARGO_TARGET_DIR="$cargo_target" CARGO_INCREMENTAL=0 cargo test -p fullmag-runner --features fdm-native-cpu native_m1_v1 -- --nocapture'

verify-fdm-gpu-m1-layout-abi-contract:
    docker compose --profile fem-gpu run --rm --no-deps \
      -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
      -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'set -euo pipefail; cd /workspace; build_dir=/mnt/fullmag-zfn2-native/fdm-gpu-m1-layout; mkdir -p "$build_dir" "$build_dir/cargo-home" "$build_dir/cargo-target"; evidence="$build_dir/fdm-gpu-m1-layout-abi-v1.json"; rm -f "$evidence" "$evidence.tmp"; cmake -S native -B "$build_dir" -DCMAKE_CUDA_ARCHITECTURES="$FULLMAG_CUDA_ARCHITECTURES" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF; cmake --build "$build_dir" --target fullmag_fdm fdm_gpu_transport_layout_abi_v1_contract fdm_gpu_transport_registry_fail_closed_v1_contract fdm_gpu_transport_checkpoint_semantic_v1_contract fdm_gpu_transport_layout_abi_v1_c11_contract; FULLMAG_FDM_LIB_DIR="$build_dir/backends/fdm" LD_LIBRARY_PATH="$build_dir/backends/fdm${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" CARGO_HOME="$build_dir/cargo-home" CARGO_TARGET_DIR="$build_dir/cargo-target" CARGO_INCREMENTAL=0 cargo test -p fullmag-fdm-sys gpu_transport_abi_v1::tests -- --nocapture; ctest --test-dir "$build_dir/backends/fdm" --output-on-failure -R "^fdm_gpu_transport_(layout_abi_v1(_c11)?|registry_fail_closed_v1|checkpoint_semantic_v1)_contract$"; FULLMAG_FDM_GPU_M1_EVIDENCE_PATH="$evidence" "$build_dir/backends/fdm/fdm_gpu_transport_layout_abi_v1_contract"; test -s "$evidence"; python3 -m json.tool "$evidence"'

verify-fdm-gpu-m1-charge-native-contract:
    docker compose --profile fem-gpu run --rm --no-deps \
      -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
      -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'set -euo pipefail; cd /workspace; build_dir=/mnt/fullmag-zfn2-native/fdm-gpu-m1-charge; mkdir -p "$build_dir"; uniform="$build_dir/fdm-gpu-m1-charge-uniform-v1.json"; layered="$build_dir/fdm-gpu-m1-charge-layered-v1.json"; snapshot="$build_dir/fdm-gpu-m1-charge-snapshot-v1.json"; mutation="$build_dir/fdm-gpu-m1-charge-boundary-mutation-v1.json"; transfer="$build_dir/fdm-gpu-m1-charge-transfer-audit-v1.json"; rm -f "$uniform" "$uniform.tmp" "$layered" "$layered.tmp" "$snapshot" "$snapshot.tmp" "$mutation" "$mutation.tmp" "$transfer" "$transfer.tmp"; cmake -S native -B "$build_dir" -DCMAKE_CUDA_ARCHITECTURES="$FULLMAG_CUDA_ARCHITECTURES" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF; cmake --build "$build_dir" --target fullmag_fdm fdm_gpu_m1_charge_uniform_v1_contract fdm_gpu_m1_charge_layered_v1_contract fdm_gpu_m1_charge_snapshot_v1_contract fdm_gpu_m1_charge_boundary_mutation_v1_contract fdm_gpu_m1_charge_transfer_audit_v1_contract; FULLMAG_FDM_GPU_M1_CHARGE_EVIDENCE_PATH="$uniform.tmp" "$build_dir/backends/fdm/fdm_gpu_m1_charge_uniform_v1_contract"; FULLMAG_FDM_GPU_M1_CHARGE_LAYERED_EVIDENCE_PATH="$layered.tmp" "$build_dir/backends/fdm/fdm_gpu_m1_charge_layered_v1_contract"; FULLMAG_FDM_GPU_M1_CHARGE_SNAPSHOT_EVIDENCE_PATH="$snapshot.tmp" "$build_dir/backends/fdm/fdm_gpu_m1_charge_snapshot_v1_contract"; FULLMAG_FDM_GPU_M1_CHARGE_MUTATION_EVIDENCE_PATH="$mutation.tmp" "$build_dir/backends/fdm/fdm_gpu_m1_charge_boundary_mutation_v1_contract"; FULLMAG_FDM_GPU_M1_CHARGE_TRANSFER_AUDIT_EVIDENCE_PATH="$transfer.tmp" "$build_dir/backends/fdm/fdm_gpu_m1_charge_transfer_audit_v1_contract"; test -s "$uniform.tmp"; test -s "$layered.tmp"; test -s "$snapshot.tmp"; test -s "$mutation.tmp"; test -s "$transfer.tmp"; python3 -m json.tool "$uniform.tmp" >/dev/null; python3 -m json.tool "$layered.tmp" >/dev/null; python3 -m json.tool "$snapshot.tmp" >/dev/null; python3 -m json.tool "$mutation.tmp" >/dev/null; python3 -m json.tool "$transfer.tmp" >/dev/null; mv "$uniform.tmp" "$uniform"; mv "$layered.tmp" "$layered"; mv "$snapshot.tmp" "$snapshot"; mv "$mutation.tmp" "$mutation"; mv "$transfer.tmp" "$transfer"; python3 -m json.tool "$uniform"; python3 -m json.tool "$layered"; python3 -m json.tool "$snapshot"; python3 -m json.tool "$mutation"; python3 -m json.tool "$transfer"'

verify-fdm-gpu-m1-spin-native-contract:
    docker compose --profile fem-gpu run --rm --no-deps \
      -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
      -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'set -euo pipefail; cd /workspace; build_dir=/mnt/fullmag-zfn2-native/fdm-gpu-m1-spin; mkdir -p "$build_dir"; cmake -S native -B "$build_dir" -DCMAKE_CUDA_ARCHITECTURES="$FULLMAG_CUDA_ARCHITECTURES" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF; cmake --build "$build_dir" --target fullmag_fdm fdm_gpu_m1_spin_red_v1_contract; "$build_dir/backends/fdm/fdm_gpu_m1_spin_red_v1_contract"'

verify-fdm-cpu-oersted-open-fft-native-contract:
    docker compose run --rm --no-deps \
      -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
      -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" \
      fem-cpu bash -lc 'cd /workspace && build_dir=/mnt/fullmag-zfn2-native/fdm-cpu-oersted-open-fft && cmake -S native -B "$build_dir" -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build "$build_dir" --target fdm_cpu_oersted_fft_open_contract && ctest --test-dir "$build_dir/backends/fdm" --verbose -R "^fdm_cpu_oersted_fft_open_contract$"'

verify-fem-regional-field-drive-contract:
    docker compose --profile fem-gpu run --rm \
      -e CMAKE_BUILD_PARALLEL_LEVEL="${FULLMAG_NATIVE_BUILD_JOBS:-2}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake -E rm -f native/build/backends/fem/fem_zeeman_contract native/build/backends/fem/fem_state_io_contract native/build/backends/fem/fem_step_metrics_contract && cmake --build native/build --target fem_zeeman_contract fem_state_io_contract fem_step_metrics_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_zeeman_contract && native/build/backends/fem/fem_state_io_contract && native/build/backends/fem/fem_step_metrics_contract'

verify-fem-regional-field-drive-rk-time-convergence:
    just ensure-python
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/fem-regional-field-drive-rk-time-convergence
    mkdir -p .fullmag/reports/fem-regional-field-drive-rk-time-convergence
    for integrator in heun rk4 rk23 rk45; do \
      for dt in 4e-13 2e-13 1e-13 5e-14; do \
        output=".fullmag/reports/fem-regional-field-drive-rk-time-convergence/${integrator}-${dt}"; \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FEM_EXECUTION=cpu FULLMAG_RK_INTEGRATOR="$integrator" FULLMAG_RK_DT_S="$dt" FULLMAG_DRIVE_FREQUENCY_HZ=100e9 \
          '{{gpu_runtime_bin}}' examples/fem_regional_field_drive_manufactured.py --backend fem --headless --json --output-dir "$output"; \
      done; \
    done
    FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FEM_EXECUTION=cpu FULLMAG_RK_INTEGRATOR=rk23 FULLMAG_RK_DT_S=3e-13 FULLMAG_DRIVE_WAVEFORM=pulse \
      '{{gpu_runtime_bin}}' examples/fem_regional_field_drive_manufactured.py --backend fem --headless --json --output-dir .fullmag/reports/fem-regional-field-drive-rk-time-convergence/event
    python3 scripts/collect_fem_regional_field_drive_rk_order.py \
      --run heun:4e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/heun-4e-13 --run heun:2e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/heun-2e-13 --run heun:1e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/heun-1e-13 --run heun:5e-14:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/heun-5e-14 \
      --run rk4:4e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk4-4e-13 --run rk4:2e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk4-2e-13 --run rk4:1e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk4-1e-13 --run rk4:5e-14:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk4-5e-14 \
      --run rk23:4e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk23-4e-13 --run rk23:2e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk23-2e-13 --run rk23:1e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk23-1e-13 --run rk23:5e-14:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk23-5e-14 \
      --run rk45:4e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk45-4e-13 --run rk45:2e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk45-2e-13 --run rk45:1e-13:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk45-1e-13 --run rk45:5e-14:.fullmag/reports/fem-regional-field-drive-rk-time-convergence/rk45-5e-14 \
      --event-run .fullmag/reports/fem-regional-field-drive-rk-time-convergence/event --output .fullmag/reports/fem-regional-field-drive-rk-time-convergence/summary.json
    python3 scripts/validate_fem_regional_field_drive_rk_order.py .fullmag/reports/fem-regional-field-drive-rk-time-convergence/summary.json

verify-fem-regional-field-drive-cpu-gpu-parity-runtime:
    just ensure-python
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/fem-regional-field-drive-cpu-gpu-parity
    mkdir -p .fullmag/reports/fem-regional-field-drive-cpu-gpu-parity
    FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FEM_EXECUTION=cpu FULLMAG_RK_INTEGRATOR=rk4 FULLMAG_RK_DT_S=1e-14 \
      '{{gpu_runtime_bin}}' examples/fem_regional_field_drive_manufactured.py --backend fem --headless --json --output-dir .fullmag/reports/fem-regional-field-drive-cpu-gpu-parity/cpu
    FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FEM_EXECUTION=gpu FULLMAG_FEM_MFEM_DEVICE=cuda FULLMAG_RK_INTEGRATOR=rk4 FULLMAG_RK_DT_S=1e-14 \
      '{{gpu_runtime_bin}}' examples/fem_regional_field_drive_manufactured.py --backend fem --headless --json --output-dir .fullmag/reports/fem-regional-field-drive-cpu-gpu-parity/gpu
    python3 scripts/validate_fem_regional_field_drive_cpu_gpu_parity.py --cpu .fullmag/reports/fem-regional-field-drive-cpu-gpu-parity/cpu --gpu .fullmag/reports/fem-regional-field-drive-cpu-gpu-parity/gpu

verify-fem-periodic-antidot-gamma-pulse-runtime:
    just ensure-python
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/fem-periodic-antidot-gamma-pulse
    mkdir -p .fullmag/reports/fem-periodic-antidot-gamma-pulse
    for variant in baseline half-dt refined double-amplitude zero-amplitude gpu; do \
      device=cpu; dt=1e-13; mesh_scale=2; amplitude=1e-3; \
      case "$variant" in half-dt) dt=5e-14 ;; refined) mesh_scale=1.5 ;; double-amplitude) amplitude=2e-3 ;; zero-amplitude) amplitude=0 ;; gpu) device=gpu ;; esac; \
      FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FEM_EXECUTION="$device" FULLMAG_FEM_MFEM_DEVICE="$([ "$device" = gpu ] && echo cuda || echo cpu)" FULLMAG_GMSH_THREADS=1 \
        FULLMAG_GAMMA_CELL_M=8e-8 FULLMAG_GAMMA_THICKNESS_M=8e-9 FULLMAG_GAMMA_HOLE_RADIUS_M=1e-8 \
        FULLMAG_GAMMA_DT_S="$dt" FULLMAG_GAMMA_SAMPLE_DT_S=5e-13 FULLMAG_GAMMA_UNTIL_S=1e-10 FULLMAG_GAMMA_T0_S=1e-11 \
        FULLMAG_GAMMA_AMPLITUDE_B_T="$amplitude" FULLMAG_GAMMA_RELAX_STEPS=500 FULLMAG_GAMMA_MESH_SCALE="$mesh_scale" \
        '{{gpu_runtime_bin}}' examples/fem_periodic_antidot_time_domain_gamma.py --backend fem --headless --json --output-dir ".fullmag/reports/fem-periodic-antidot-gamma-pulse/$variant"; \
    done
    python3 scripts/validate_fem_periodic_antidot_gamma_spectrum.py \
      .fullmag/reports/fem-periodic-antidot-gamma-pulse/baseline/analysis/spin_wave_response.gamma.v1.json \
      --half-dt .fullmag/reports/fem-periodic-antidot-gamma-pulse/half-dt/analysis/spin_wave_response.gamma.v1.json \
      --refined-mesh .fullmag/reports/fem-periodic-antidot-gamma-pulse/refined/analysis/spin_wave_response.gamma.v1.json \
      --double-amplitude .fullmag/reports/fem-periodic-antidot-gamma-pulse/double-amplitude/analysis/spin_wave_response.gamma.v1.json \
      --zero-amplitude .fullmag/reports/fem-periodic-antidot-gamma-pulse/zero-amplitude/analysis/spin_wave_response.gamma.v1.json \
      --gpu .fullmag/reports/fem-periodic-antidot-gamma-pulse/gpu/analysis/spin_wave_response.gamma.v1.json

verify-fem-antidot-waveguide-finite-k-runtime:
    just ensure-python
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/fem-antidot-waveguide-finite-k
    mkdir -p .fullmag/reports/fem-antidot-waveguide-finite-k
    for variant in baseline half-dt half-dx double-length gpu; do \
      device=cpu; dt=2e-13; mesh_scale=2; length=4e-7; probes=16; \
      case "$variant" in half-dt) dt=1e-13 ;; half-dx) mesh_scale=1 ;; double-length) length=8e-7; probes=32 ;; gpu) device=gpu ;; esac; \
      FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FEM_EXECUTION="$device" FULLMAG_FEM_MFEM_DEVICE="$([ "$device" = gpu ] && echo cuda || echo cpu)" \
        FULLMAG_FINITE_K_LENGTH_M="$length" FULLMAG_FINITE_K_WIDTH_M=8e-8 FULLMAG_FINITE_K_THICKNESS_M=8e-9 FULLMAG_FINITE_K_ABSORBER_M=6e-8 \
        FULLMAG_FINITE_K_DT_S="$dt" FULLMAG_FINITE_K_SAMPLE_DT_S=1e-12 FULLMAG_FINITE_K_UNTIL_S=2e-11 FULLMAG_FINITE_K_T0_S=5e-12 \
        FULLMAG_FINITE_K_PROBE_COUNT="$probes" FULLMAG_FINITE_K_RELAX_STEPS=4 FULLMAG_FINITE_K_MESH_SCALE="$mesh_scale" \
        '{{gpu_runtime_bin}}' examples/fem_antidot_waveguide_time_domain_finite_k.py --backend fem --headless --json --output-dir ".fullmag/reports/fem-antidot-waveguide-finite-k/$variant"; \
    done
    python3 scripts/validate_fem_antidot_waveguide_dynamic_structure_factor.py \
      .fullmag/reports/fem-antidot-waveguide-finite-k/baseline/analysis/dynamic_structure_factor.1d.v1.json \
      --half-dt .fullmag/reports/fem-antidot-waveguide-finite-k/half-dt/analysis/dynamic_structure_factor.1d.v1.json \
      --half-dx .fullmag/reports/fem-antidot-waveguide-finite-k/half-dx/analysis/dynamic_structure_factor.1d.v1.json \
      --double-length .fullmag/reports/fem-antidot-waveguide-finite-k/double-length/analysis/dynamic_structure_factor.1d.v1.json \
      --gpu .fullmag/reports/fem-antidot-waveguide-finite-k/gpu/analysis/dynamic_structure_factor.1d.v1.json

# Oersted OE-T0/OE-F1/OE-F2 prerequisite: managed MFEM/hypre CPU-only lane.
# Each entrypoint selects the unprofiled fem-cpu service and the in-container
# runner audits source configuration, CMakeCache and dependency link closure
# before invoking any Fullmag native build target.
verify-fem-steady-transport-cpu-only-contract:
    docker compose build fem-cpu
    docker compose run --rm --no-deps fem-cpu ./scripts/run_fem_cpu_only_contract.sh steady-transport

verify-fem-steady-transport-rt0-cpu-contract:
    docker compose build fem-cpu
    docker compose run --rm --no-deps fem-cpu ./scripts/run_fem_cpu_only_contract.sh steady-transport-rt0

# Stage-consistency gate for the physically invariant one-way closed source.
# The managed runner tests exercise exact-key reuse plus checkpoint/rollback
# around a changed stage identity.  The native CPU RK callback transaction is
# covered by verify-fem-time-domain-cpu-only-contract; magnetization-dependent
# transport binding, M2, and external-lead coupling remain fail-closed.
verify-fem-steady-transport-stage-cache-contract:
    docker compose --profile fem-gpu run --rm \
        fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-steady-transport-stage-cache CARGO_INCREMENTAL=0 cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::stage_cache::tests -- --nocapture'

# Public Rust adapter -> append-only C ABI -> MFEM RT0 coupled volumetric
# external-lead solve.  This is intentionally separate from the native-only
# conservative-current-view contract so the public buffer/identity mapping is
# exercised as part of the managed proof.
verify-fem-steady-transport-external-lead-cpu-contract:
    docker compose --profile fem-gpu run --rm \
        -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
        fem-gpu bash -lc 'cd /workspace && durable=/mnt/fullmag-zfn2-native/fem-steady-transport-external-lead && mkdir -p "$durable/cargo-home" "$durable/cargo-target" && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_HOME="$durable/cargo-home" CARGO_TARGET_DIR="$durable/cargo-target" CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit -- --exact --nocapture'

# Stage callback proof for the same coupled volumetric external-lead fixture:
# RT0 solve -> OE-F1 field reconstruction -> accepted callback observation.
verify-fem-stage-oersted-external-lead-cpu-contract:
    docker compose --profile fem-gpu run --rm \
        -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
        fem-gpu bash -lc 'cd /workspace && durable=/mnt/fullmag-zfn2-native/fem-steady-transport-external-lead && mkdir -p "$durable/cargo-home" "$durable/cargo-target" && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_HOME="$durable/cargo-home" CARGO_TARGET_DIR="$durable/cargo-target" CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::stage_oersted::tests::external_lead_stage_callback_solves_oersted_and_commits_observation -- --exact --nocapture'

# Full native CPU step with the external-lead Oersted provider installed on
# the backend: callback cadence is driven by the real RK integrator.
verify-fem-llg-external-lead-oersted-cpu-contract:
    docker compose --profile fem-gpu run --rm \
        -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
        fem-gpu bash -lc 'cd /workspace && durable=/mnt/fullmag-zfn2-native/fem-steady-transport-external-lead && mkdir -p "$durable/cargo-home" "$durable/cargo-target" && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_HOME="$durable/cargo-home" CARGO_TARGET_DIR="$durable/cargo-target" CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_external_lead_oersted_callback_advances_one_cpu_llg_step -- --exact --nocapture'

# Adaptive RK23 proof that a rejected native attempt rolls the external-lead
# callback back before the accepted retry is committed.
verify-fem-adaptive-retry-external-lead-oersted-cpu-contract:
    docker compose --profile fem-gpu run --rm \
        -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
        fem-gpu bash -lc 'cd /workspace && durable=/mnt/fullmag-zfn2-native/fem-steady-transport-external-lead && mkdir -p "$durable/cargo-home" "$durable/cargo-target" && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_HOME="$durable/cargo-home" CARGO_TARGET_DIR="$durable/cargo-target" CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_external_lead_oersted_callback_rolls_back_rejected_adaptive_attempt -- --exact --nocapture'

# Callback cadence coverage for every native explicit RK integrator supported
# by the FEM plan: fixed Heun/RK4 and adaptive RK23/RK45.
verify-fem-rk-family-external-lead-oersted-cpu-contract:
    docker compose --profile fem-gpu run --rm \
        -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
        fem-gpu bash -lc 'cd /workspace && durable=/mnt/fullmag-zfn2-native/fem-steady-transport-external-lead && mkdir -p "$durable/cargo-home" "$durable/cargo-target" && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_HOME="$durable/cargo-home" CARGO_TARGET_DIR="$durable/cargo-target" CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_external_lead_oersted_callback_covers_all_explicit_rk_integrators -- --exact --nocapture'

# One reciprocal FEM M2 solve per exact native RK stage, shared by the direct
# transport torque and solved-current Oersted callbacks.
verify-fem-reciprocal-m2-oersted-shared-stage-cpu-contract:
    docker compose --profile fem-gpu run --rm \
        -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
        fem-gpu bash -lc 'cd /workspace && durable=/mnt/fullmag-zfn2-native/fem-reciprocal-m2-oersted && mkdir -p "$durable/cargo-home" "$durable/cargo-target" && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_HOME="$durable/cargo-home" CARGO_TARGET_DIR="$durable/cargo-target" CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_reciprocal_m2_shares_one_stage_solve_for_torque_and_oersted -- --exact --nocapture'

# Adaptive RK23 rejection must roll back both ABI adapters before a shared M2
# torque/Oersted retry is accepted.
verify-fem-reciprocal-m2-oersted-adaptive-retry-cpu-contract:
    docker compose --profile fem-gpu run --rm \
        -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
        fem-gpu bash -lc 'cd /workspace && durable=/mnt/fullmag-zfn2-native/fem-reciprocal-m2-oersted && mkdir -p "$durable/cargo-home" "$durable/cargo-target" && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_HOME="$durable/cargo-home" CARGO_TARGET_DIR="$durable/cargo-target" CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_reciprocal_m2_rolls_back_both_callbacks_before_shared_retry -- --exact --nocapture'

# Three-step shared torque/Oersted trajectories for every explicit native FEM
# RK integrator: fixed Heun/RK4 and adaptive RK23/RK45.
verify-fem-reciprocal-m2-oersted-rk-family-cpu-contract:
    docker compose --profile fem-gpu run --rm \
        -v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native \
        fem-gpu bash -lc 'cd /workspace && durable=/mnt/fullmag-zfn2-native/fem-reciprocal-m2-oersted && mkdir -p "$durable/cargo-home" "$durable/cargo-target" && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_HOME="$durable/cargo-home" CARGO_TARGET_DIR="$durable/cargo-target" CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_reciprocal_m2_shares_source_across_all_explicit_rk_integrators -- --exact --nocapture'

# Full public Python -> managed FEM CPU -> artifact proof for the volumetric
# external-lead Oersted fixture. Every run gets a durable unique root on /zfn2.
verify-fem-external-lead-oersted-public-cpu-runtime:
    run_parent=/zfn2/mateuszz/git/fullmag/reports/fem-external-lead-oersted-public; \
      mkdir -p "$run_parent"; \
      run_root="$(mktemp -d "$run_parent/run.XXXXXXXX")"; \
      set -o pipefail; \
      just fem-managed-headless cpu examples/fem_external_lead_oersted_public.py "$run_root/artifacts" | tee "$run_root/runtime.log"; \
      python3 scripts/validate_fem_external_lead_oersted_runtime.py "$run_root/runtime.log" --output "$run_root/qualification.json"; \
      echo "qualified external-lead runtime: $run_root"

verify-fem-time-domain-cpu-only-contract:
    docker compose build fem-cpu
    docker compose run --rm --no-deps fem-cpu ./scripts/run_fem_cpu_only_contract.sh time-domain

verify-fem-oersted-oet0-cpu-contract:
    docker compose build fem-cpu
    docker compose run --rm --no-deps fem-cpu ./scripts/run_fem_cpu_only_contract.sh oersted-oet0

verify-fem-oersted-oet0-tsan-cpu-contract:
    docker compose build fem-cpu-tsan
    docker compose run --rm --no-deps fem-cpu-tsan ./scripts/run_fem_cpu_only_contract.sh oersted-oet0-tsan

verify-fem-oersted-oef1-cpu-contract:
    docker compose build fem-cpu
    docker compose run --rm --no-deps fem-cpu ./scripts/run_fem_cpu_only_contract.sh oersted-oef1

verify-fem-oersted-oef2-cpu-contract:
    docker compose build fem-cpu
    docker compose run --rm --no-deps fem-cpu ./scripts/run_fem_cpu_only_contract.sh oersted-oef2

verify-fem-stt-native-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fem_stt_contract fem_cuda_slonczewski_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_stt_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_cuda_slonczewski_contract && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-stt-cargo cargo test -p fullmag-fem-sys versioned_stt_extension_is_append_only_after_legacy_plan_prefix && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-fem-stt-runner-cargo cargo test -p fullmag-runner --features fem-gpu dispatch::tests::auto_fem_canonical_slonczewski_v2_remains_gpu_eligible -- --exact && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-fem-stt-runner-cargo cargo test -p fullmag-runner --features fem-gpu dispatch::tests::strict_fem_canonical_slonczewski_v2_reaches_native_runtime_validation -- --exact && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-fem-stt-runner-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_slonczewski_step_matches_independent_si_reference_when_mfem_stack_is_available -- --exact --nocapture && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-fem-stt-runner-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_canonical_slonczewski_fixed_trajectory_parity_when_mfem_stack_is_available -- --exact --nocapture && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-fem-stt-runner-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_canonical_slonczewski_has_bounded_current_scaling_when_mfem_stack_is_available -- --exact --nocapture'
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-fem-stt-runner-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_slonczewski_matches_fdm_reference_in_common_limit_when_mfem_stack_is_available -- --exact --nocapture'

verify-fem-prescribed-sot-native-contract:
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem fem_stt_contract fem_cuda_sot_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_stt_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_cuda_sot_contract && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-prescribed-sot-runner CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_prescribed_sot_step_matches_independent_si_reference_when_mfem_stack_is_available -- --exact --nocapture && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-prescribed-sot-runner CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_prescribed_sot_gpu_step_matches_independent_si_reference_when_mfem_stack_is_available -- --exact --nocapture && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-prescribed-sot-runner CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_prescribed_sot_stage_time_envelope_matches_si_reference_on_cpu -- --exact --nocapture && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-prescribed-sot-runner CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_prescribed_sot_stage_time_envelope_matches_si_reference_on_gpu -- --exact --nocapture && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-prescribed-sot-runner CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_prescribed_sot_pulse_clips_steps_at_envelope_knots -- --exact --nocapture && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-prescribed-sot-runner CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_prescribed_sot_pulse_clips_steps_at_envelope_knots_on_gpu -- --exact --nocapture'

# Focused FEM CPU RK atomicity gate for a prescribed SOT pulse.  It is kept
# separate from the broad source-inventory gate so unrelated dirty-worktree
# changes cannot hide the rollback/event-knot result.
verify-fem-rk-sot-rollback-contract:
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fem_rk_explicit_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_rk_explicit_contract'

# Focused one-cell FDM versus exchange-free multi-node FEM prescribed-SOT
# common-limit gate.  It shares the exact signed descriptor and SI units.
verify-fem-prescribed-sot-common-limit-contract:
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-sot-common-limit CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_prescribed_sot_matches_fdm_reference_in_common_limit_when_mfem_stack_is_available -- --exact --nocapture'

# Focused bounded eight-step FEM CPU versus CUDA prescribed-SOT trajectory gate.
# CPU and GPU consume the same mesh, descriptor, mask, and fixed Heun dt.
verify-fem-prescribed-sot-trajectory-parity-contract:
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-sot-trajectory CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_prescribed_sot_fixed_trajectory_cpu_gpu_parity_when_mfem_stack_is_available -- --exact --nocapture'

# Focused bounded prescribed-SOT parity across every fixed-step FEM RK tableau.
verify-fem-prescribed-sot-integrator-parity-contract:
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-sot-integrators CARGO_INCREMENTAL=0 cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_prescribed_sot_cpu_gpu_integrator_parity_when_mfem_stack_is_available -- --exact --nocapture'

# M1.3 transparent-interface conforming-H1 FEM charge/spin CPU oracle.
verify-fem-steady-transport-native-contract:
    just verify-fem-steady-transport-critical-remediation
    POSTGRES_PASSWORD=contract-only MINIO_ROOT_USER=contract-only MINIO_ROOT_PASSWORD=contract-only docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu dispatch::tests::steady_transport_component_schedule_is_rejected_before_execution -- --exact && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-plan spin_transport::tests::fem_boundary_partitions_require_coverage_and_reject_conflicts -- --exact && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-api router_v2::handlers::data::field_resolution::strict_json_tests::strict_flat_field_values_reject_non_numbers_nulls_and_nested_arrays -- --exact'
    POSTGRES_PASSWORD=contract-only MINIO_ROOT_USER=contract-only MINIO_ROOT_PASSWORD=contract-only docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fem_steady_transport_contract fem_steady_transport_abi_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_steady_transport_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_steady_transport_abi_contract && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-fem-sys steady_transport_v1_request_and_result_are_self_describing_and_append_only && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-quantities catalog::tests::steady_transport_outputs_have_canonical_quantity_metadata -- --exact && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-plan spin_transport::tests::resolves_canonical_fem_descriptor_without_hidden_defaults -- --exact && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-plan spin_transport::tests::fem_v1_rejects_incompatible_charge_and_spin_linear_policies -- --exact && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-plan spin_transport::tests::fem_v1_requires_strict_execution_mode -- --exact && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-plan spin_transport::tests::fem_mapping_rejects_gpu_mixing_and_unimplemented_stage_coupling -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::canonical_descriptor_materializes_exact_solver_policy_and_provenance -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::contradictory_resolved_descriptor_fails_before_native_call -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::resolved_descriptor_mutations_fail_closed_by_contradiction_class -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::resolved_descriptor_mesh_masks_and_boundary_attributes_fail_closed -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::canonical_current_source_duplicates_and_mutations_fail_preflight -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::multiple_transport_modules_fail_before_native_execution -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu dispatch::tests::normalized_runtime_markers_reject_short_and_long_marker_vectors -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::preflight_rejects_short_and_long_element_marker_vectors_before_ffi -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::native_result_publishes_canonical_transport_quantity_fields -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu artifact_pipeline::tests::recorder_streams_transport_scalar_vector_and_tensor_fields -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu dispatch::tests::steady_transport_outputs_are_satisfied_by_the_steady_publisher -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu dispatch::tests::non_streaming_fem_dispatch_retains_scheduled_transport_fields -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu tests::public_fem_dispatch_streams_transport_quantity_artifacts -- --exact && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-api router_v2::tests::v2_field_data_plane_reads_transport_scalar_vector_and_tensor_snapshots -- --exact && FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo check -p fullmag-runner --features fem-gpu && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::direct_she_common_si_limit_matches_fdm_and_fem_reference_profiles -- --exact --nocapture'

# Bounded reference slice: solved FEM Ohmic current -> regularized tet4
# midpoint Biot--Savart field.  This gate is intentionally separate from the
# canonical OE-T0/OE-F1/OE-F2 promotion gates.
verify-fem-solved-current-oersted-reference:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && CARGO_TARGET_DIR=/tmp/fullmag-fem-solved-current-oersted-cargo cargo test -p fullmag-plan oersted -- --nocapture && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-solved-current-oersted-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::solved_current_midpoint_biot_savart_is_finite_and_reverses_with_current -- --exact --nocapture && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-solved-current-oersted-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::solved_current_oersted_identity_digests_are_stable_and_source_bound -- --exact --nocapture'

# Focused nontrivial reciprocal-M2 constitutive oracle.  The managed container
# builds the native ABI contract and checks an affine cube fixture with known
# charge and spin currents; it is intentionally separate from the broad M1
# transport gate so a zero-gradient smoke cannot mask a sign/factor regression.
verify-fem-steady-transport-m2-affine-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fem_steady_transport_abi_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_steady_transport_abi_contract'

# Focused bounded reciprocal-M2 mesh-convergence oracle.  It uses three
# conforming MFEM tetrahedral resolutions and finite spin-flip, so an affine
# single-grid smoke cannot hide a spatial discretization error.
verify-fem-steady-transport-m2-convergence-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fem_steady_transport_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_steady_transport_contract'

verify-fem-steady-transport-m2-common-limit-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::reciprocal_m2_common_si_limit_matches_fdm_and_fem_reference_profiles -- --exact --nocapture'

verify-fem-steady-transport-m2-3d-common-limit-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-m2-3d CARGO_INCREMENTAL=0 cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::reciprocal_m2_3d_she_ishe_common_limit_matches_fdm_and_fem_profiles -- --exact --nocapture'

verify-fdm-m2-heterogeneous-interface-contract:
    docker compose --profile fem-gpu run --rm --no-deps \
      fem-gpu bash -lc 'cd /workspace && CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fdm-m2-interface CARGO_INCREMENTAL=0 cargo test -p fullmag-engine --lib m2_anisotropic_nf_interface_meets_the_declared_physical_balance_tolerance -- --nocapture && CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fdm-m2-interface CARGO_INCREMENTAL=0 cargo test -p fullmag-engine --lib m2_mixing_interface_closes_nonzero_absorption_and_sml_with_torque_target -- --nocapture'

verify-fem-steady-transport-critical-remediation:
    POSTGRES_PASSWORD=contract-only MINIO_ROOT_USER=contract-only MINIO_ROOT_PASSWORD=contract-only docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fullmag_fem && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu dispatch::tests::normalized_runtime_markers_reject_short_and_long_marker_vectors -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-runner --features fem-gpu native_fem::steady_transport::tests::preflight_rejects_short_and_long_element_marker_vectors_before_ffi -- --exact && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-plan spin_transport::tests::fem_boundary_marker_lowering_requires_face_exact_assignment_ownership -- --exact && CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-api router_v2::tests::v2_field_data_plane_reads_canonical_transport_field_artifacts -- --exact && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem CARGO_TARGET_DIR=/tmp/fullmag-fem-steady-transport-cargo cargo test -p fullmag-api --features fem-gpu router_v2::tests::public_fem_m1_run_is_decoded_by_v2_with_artifact_revisions -- --exact'

# FEM-TD-OBS-003 focused Oersted observable contract.
verify-fem-oersted-observable-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_oersted_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_oersted_contract'

# FEM-TD-PHY-MAT-001: qualified CPU DG0-Ms owner boundary and GPU fail-closed contract.
verify-fem-material-element-ms-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_material_fields_contract fem_element_dg0_workflow_contract fem_mfem_context_contract fem_element_quadrature_material_contract fem_exchange_contract fem_zeeman_contract fem_zeeman_element_quadrature_contract fem_material_runtime_zeeman_contract fem_uniaxial_element_quadrature_contract fem_material_runtime_uniaxial_contract fem_cubic_element_quadrature_contract fem_material_runtime_cubic_contract fem_demag_poisson_contract fem_step_metrics_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_material_fields_contract && native/build/backends/fem/fem_element_dg0_workflow_contract && native/build/backends/fem/fem_mfem_context_contract && native/build/backends/fem/fem_element_quadrature_material_contract && native/build/backends/fem/fem_exchange_contract && native/build/backends/fem/fem_zeeman_contract && native/build/backends/fem/fem_zeeman_element_quadrature_contract && native/build/backends/fem/fem_material_runtime_zeeman_contract && native/build/backends/fem/fem_uniaxial_element_quadrature_contract && native/build/backends/fem/fem_material_runtime_uniaxial_contract && native/build/backends/fem/fem_cubic_element_quadrature_contract && native/build/backends/fem/fem_material_runtime_cubic_contract && native/build/backends/fem/fem_demag_poisson_contract && native/build/backends/fem/fem_step_metrics_contract'

# Focused hot-path regression for the allocation-free DG0 step-statistics reduction.
verify-fem-dg0-step-metrics-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_step_metrics_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_step_metrics_contract'

# FEM-TD-PHY-STT-001: source/algebra contract -> managed rebuild -> freshness -> named CPU/GPU fixture.
verify-fem-zhang-li-skew-tetra-runtime:
    just verify-fem-time-domain-native-contract
    just rebuild-fem-runtime
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/cpu.XXXXXX)"; set -o pipefail; just fem-managed-headless cpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/cpu.log
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/gpu.XXXXXX)"; set -o pipefail; just fem-managed-headless gpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/gpu.log
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/cpu_reversed.XXXXXX)"; set -o pipefail; FULLMAG_ZHANG_LI_CURRENT_SIGN=-1 just fem-managed-headless cpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/cpu_reversed.log
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/cpu_zero_current.XXXXXX)"; set -o pipefail; FULLMAG_ZHANG_LI_CURRENT_SIGN=0 just fem-managed-headless cpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/cpu_zero_current.log
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/dt_0.XXXXXX)"; set -o pipefail; FULLMAG_ZHANG_LI_STEPS=32 FULLMAG_ZHANG_LI_DT_S=8.881784197001252e-16 just fem-managed-headless cpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/dt_0.log
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/dt_1.XXXXXX)"; set -o pipefail; FULLMAG_ZHANG_LI_STEPS=64 FULLMAG_ZHANG_LI_DT_S=4.440892098500626e-16 just fem-managed-headless cpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/dt_1.log
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/dt_2.XXXXXX)"; set -o pipefail; FULLMAG_ZHANG_LI_STEPS=128 FULLMAG_ZHANG_LI_DT_S=2.220446049250313e-16 just fem-managed-headless cpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/dt_2.log
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/mesh_0.XXXXXX)"; set -o pipefail; FULLMAG_ZHANG_LI_REFINEMENT=0 just fem-managed-headless cpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/mesh_0.log
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/mesh_1.XXXXXX)"; set -o pipefail; FULLMAG_ZHANG_LI_REFINEMENT=1 just fem-managed-headless cpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/mesh_1.log
    output_dir="$(mktemp -d .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/runs/mesh_2.XXXXXX)"; set -o pipefail; FULLMAG_ZHANG_LI_REFINEMENT=2 just fem-managed-headless cpu examples/fem_zhang_li_skew_tetra_runtime.py "$output_dir" \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/mesh_2.log
    python3 scripts/validate_fem_zhang_li_skew_tetra_runtime.py \
      --cpu .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/cpu.log \
      --gpu .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/gpu.log \
      --cpu-reversed .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/cpu_reversed.log \
      --cpu-zero-current .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/cpu_zero_current.log \
      --manifest .fullmag/runtimes/fem-gpu-host/manifest.json \
      --acceptance-manifest docs/validation/fem-zhang-li-skew-tetra-runtime-v1.json \
      --study docs/validation/fem-zhang-li-skew-tetra-convergence-study-v1.json \
      --dt-log .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/dt_0.log \
      --dt-log .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/dt_1.log \
      --dt-log .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/dt_2.log \
      --mesh-run examples/assets/zhang_li_skew_tetra_r0.mesh.json=.fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/mesh_0.log \
      --mesh-run examples/assets/zhang_li_skew_tetra_r1.mesh.json=.fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/mesh_1.log \
      --mesh-run examples/assets/zhang_li_skew_tetra_r2.mesh.json=.fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/mesh_2.log \
      --output .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/summary.json

# FEM-TD-PHY-THERM-001/002: source/algebra contract -> managed CPU runtime.
verify-fem-thermal-cpu-runtime:
    just verify-fem-time-domain-native-contract
    just rebuild-fem-runtime
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_thermal_cpu_v1
    set -o pipefail; FULLMAG_FEM_THERMAL_STEPS=8 FULLMAG_FEM_THERMAL_SEED=17 just fem-managed-headless cpu examples/fem_thermal_cpu_runtime.py \
      | tee .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_thermal_cpu_v1/cpu.log
    python3 scripts/validate_fem_thermal_cpu_runtime.py \
      --log .fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_thermal_cpu_v1/cpu.log \
      --steps 9 --seed 17

# FEM-TD-NUM-RK-001: fixed-final-time, time-dependent Oersted convergence for
# every supported explicit tableau on both strict native FEM lanes.
verify-fem-oersted-rk-time-convergence:
    just verify-fem-time-domain-native-contract
    just rebuild-fem-runtime
    just ensure-managed-fem-runtime
    set -euo pipefail; \
      root=.fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_oersted_rk_time_convergence_v1; \
      rm -rf "$root"; mkdir -p "$root"; \
      for device in cpu gpu; do \
        for integrator in heun rk4 rk23 rk45; do \
          for level in 0 1 2; do \
            case "$level" in \
              0) steps=8; dt=2.842170943040401e-14 ;; \
              1) steps=16; dt=1.4210854715202004e-14 ;; \
              2) steps=32; dt=7.105427357601002e-15 ;; \
            esac; \
            run_dir="$root/${device}_${integrator}_dt${level}"; mkdir -p "$run_dir"; \
            set -o pipefail; FULLMAG_OERSTED_RK_INTEGRATOR="$integrator" FULLMAG_OERSTED_RK_STEPS="$steps" FULLMAG_OERSTED_RK_DT_S="$dt" just fem-managed-headless "$device" examples/fem_oersted_rk_time_convergence.py "$run_dir" \
              | tee "$root/${device}_${integrator}_dt${level}.log"; \
          done; \
        done; \
      done; \
      for device in cpu gpu; do \
        peer=gpu; [ "$device" = gpu ] && peer=cpu; \
        for integrator in heun rk4 rk23 rk45; do \
          python3 scripts/validate_fem_oersted_rk_time_convergence.py \
            --device "$device" --integrator "$integrator" \
            --log "$root/${device}_${integrator}_dt0.log" \
            --log "$root/${device}_${integrator}_dt1.log" \
            --log "$root/${device}_${integrator}_dt2.log" \
            --peer-log "$root/${peer}_${integrator}_dt0.log" \
            --peer-log "$root/${peer}_${integrator}_dt1.log" \
            --peer-log "$root/${peer}_${integrator}_dt2.log" \
            --steps 8 --steps 16 --steps 32; \
        done; \
      done

# FEM-TD-OBS-003: accepted-time public H_oe CPU/GPU artifact fixture.
verify-fem-oersted-observable-runtime:
    set -euo pipefail; \
      root=.fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_obs_003_oersted_observable_v1; \
      mkdir -p "$root"; \
      for device in cpu gpu; do \
        run_root="$(mktemp -d "$root/.${device}.run.XXXXXX")"; \
        trap 'rm -rf -- "$run_root"' EXIT; \
        set -o pipefail; FULLMAG_OERSTED_OBSERVABLE_PURE=1 FULLMAG_OERSTED_RK_INTEGRATOR=heun FULLMAG_OERSTED_RK_STEPS=8 FULLMAG_OERSTED_RK_DT_S=2.842170943040401e-14 FULLMAG_OERSTED_CURRENT_A=8e-3 just fem-managed-headless "$device" examples/fem_oersted_rk_time_convergence.py | tee "$run_root/driven.log"; \
        set -o pipefail; FULLMAG_OERSTED_OBSERVABLE_PURE=1 FULLMAG_OERSTED_RK_INTEGRATOR=heun FULLMAG_OERSTED_RK_STEPS=8 FULLMAG_OERSTED_RK_DT_S=2.842170943040401e-14 FULLMAG_OERSTED_CURRENT_A=0 just fem-managed-headless "$device" examples/fem_oersted_rk_time_convergence.py | tee "$run_root/zero.log"; \
        mv "$run_root/driven.log" "$root/${device}_driven.log"; \
        mv "$run_root/zero.log" "$root/${device}_zero.log"; \
        trap - EXIT; rmdir "$run_root"; \
      done; \
      python3 scripts/validate_fem_oersted_observable_artifacts.py \
        --cpu-driven "$root/cpu_driven.log" --cpu-zero "$root/cpu_zero.log" \
        --gpu-driven "$root/gpu_driven.log" --gpu-zero "$root/gpu_zero.log" \
        --output "$root/summary.json"; \
      sha256sum "$root"/*.log "$root/summary.json" | tee "$root/SHA256SUMS.txt"

verify-fem-exchange-runtime:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" tests/fem_exchange_validation/results 2>/dev/null || true'\'' EXIT && \
        scripts/verify_fem_exchange_runtime.sh'

verify-fem-frequency-domain-checked-extents:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_frequency_domain_checked_extent_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_frequency_domain_checked_extent_contract'

verify-fem-frequency-domain-mode-kinematics:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_mode_kinematics_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_mode_kinematics_contract'

verify-fem-frequency-domain-dynamic-pencil:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_linearized_dynamic_pencil_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_linearized_dynamic_pencil_contract'

verify-fem-frequency-domain-real-frequency-rotated:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_real_frequency_rotated_pencil_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_real_frequency_rotated_pencil_contract'

verify-fem-frequency-domain-floquet-bloch-scalar:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_floquet_bloch_scalar_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_floquet_bloch_scalar_contract'

verify-fem-frequency-domain-native-contract:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_frequency_domain_contract && cmake --build native/build --target fem_frequency_domain_checked_extent_contract && cmake --build native/build --target fem_poisson_airbox_shared_domain_contract && cmake --build native/build --target fem_mode_kinematics_contract && cmake --build native/build --target fem_linearized_dynamic_pencil_contract && cmake --build native/build --target fem_operator_contract && cmake --build native/build --target fem_modal_eigen_contract && cmake --build native/build --target fem_driven_response_contract && cmake --build native/build --target fem_window_partition_contract && cmake --build native/build --target fem_mode_deduplication_contract && cmake --build native/build --target fem_contour_interval_solver_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_frequency_domain_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_frequency_domain_checked_extent_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_poisson_airbox_shared_domain_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_mode_kinematics_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_linearized_dynamic_pencil_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_operator_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_modal_eigen_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_driven_response_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_window_partition_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_mode_deduplication_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_contour_interval_solver_contract'

verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_poisson_airbox_eigen_oracle_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_poisson_airbox_eigen_oracle_contract'

verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_poisson_airbox_modal_eigen_slepc_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_poisson_airbox_modal_eigen_slepc_contract'

verify-fem-frequency-domain-gpu-petsc-slepc-runtime:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm --no-deps \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_gpu_petsc_slepc_runtime_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_gpu_petsc_slepc_runtime_contract'

verify-fem-frequency-domain-eigen-k0-gpu-petsc-slepc:
    FULLMAG_FEM_RUNTIME_VARIANT=hypre-baseline just ensure-managed-fem-runtime
    FULLMAG_FEM_RUNTIME_VARIANT=hypre-baseline docker compose --profile fem-gpu run --rm --no-deps \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_gpu_k0_modal_petsc_slepc_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_gpu_k0_modal_petsc_slepc_contract'

verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
    docker compose --profile fem-gpu run --rm \
      -e FULLMAG_PA_G3F_OUTPUT_DIR=.fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action 2>/dev/null || true'\'' EXIT && \
        cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && \
        cmake --build native/build --target fem_poisson_airbox_modal_eigen_slepc_contract && \
        LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} \
        native/build/backends/fem/fem_poisson_airbox_modal_eigen_slepc_contract && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/eigen/diagnostics/poisson_airbox_modal_shift_invert_action.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/eigen/diagnostics/gpu_modal_shift_invert_action.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/eigen/diagnostics/gpu_modal_poisson_airbox_eigensolver.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/eigen/diagnostics/gpu_modal_poisson_airbox_descriptor_apply.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/gpu_modal_shift_invert_action_parity.v1.json && \
        python3 scripts/verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py \
          .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/eigen/diagnostics/gpu_modal_poisson_airbox_descriptor_apply.v1.json && \
        python3 scripts/verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py \
          .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/eigen/diagnostics/gpu_modal_poisson_airbox_eigensolver.v1.json && \
        python3 scripts/verify_fem_gpu_modal_shift_invert_action_parity_artifact.py \
          .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/gpu_modal_shift_invert_action_parity.v1.json'

verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && cmake --build native/build --target fem_poisson_airbox_schur_matshell_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_poisson_airbox_schur_matshell_contract'

verify-fem-frequency-domain-contract:
    just verify-fem-frequency-domain-native-contract

verify-fem-frequency-domain-gpu:
    just verify-fem-frequency-domain-native-contract

verify-fem-demag-poisson-contract:
    just ensure-managed-fem-runtime
    just verify-fem-demag-poisson-contract-focused

verify-fem-demag-poisson-contract-focused:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF && cmake --build native/build --target fem_demag_poisson_contract fem_demag_delta_potential_contract fem_demag_fem_bem_contract fem_cuda_demag_timing_contract fem_cuda_periodic_demag_contract fem_cuda_periodic_exchange_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_demag_poisson_contract && native/build/backends/fem/fem_demag_delta_potential_contract && native/build/backends/fem/fem_demag_fem_bem_contract && native/build/backends/fem/fem_cuda_demag_timing_contract && native/build/backends/fem/fem_cuda_periodic_demag_contract && native/build/backends/fem/fem_cuda_periodic_exchange_contract'

verify-fem-frequency-domain-runtime-suite:
    just verify-fem-frequency-domain-runtime
    just verify-fem-frequency-domain-gpu-free-runtime
    just verify-fem-frequency-domain-gpu-free-demag-runtime
    just verify-fem-frequency-domain-free-demag-parity-runtime
    just verify-fem-frequency-domain-gpu-static-periodic-parity-runtime
    just verify-fem-frequency-domain-shared-domain-static-periodic-parity-runtime
    just verify-fem-frequency-domain-cpu-floquet-runtime
    just verify-fem-frequency-domain-gpu-floquet-runtime
    just verify-fem-frequency-domain-cpu-periodic-airbox-demag-smoke-runtime
    just verify-fem-frequency-domain-periodic-airbox-gpu-runtime
    just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu
    just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu
    just verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime
    just verify-fem-frequency-domain-gpu-floquet-reciprocal-runtime
    just verify-fem-frequency-domain-eigen-runtime
    just verify-fem-frequency-domain-eigen-dispersion-runtime
    just verify-fem-frequency-domain-eigen-dispersion-window-runtime
    just verify-fem-frequency-domain-eigen-dispersion-de-bv-low-k-runtime
    just verify-fem-fmr-free-demag-airbox-runtime

verify-fem-frequency-response-runtime:
    just verify-fem-frequency-domain-runtime

verify-fem-frequency-domain-eigen-runtime:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-runtime
    mkdir -p .fullmag/reports/frequency-domain-eigen-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigenmodes.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/artifacts/eigen/modes/sample_0000/mode_0000.json && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py .fullmag/reports/frequency-domain-eigen-runtime/artifacts && \
        rm -rf .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigenmodes_frequency_window.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts/eigen/modes/sample_0000/mode_0000.json && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-production-shift-invert-window .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts'

verify-fem-frequency-domain-eigen-dispersion-runtime:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-dispersion-runtime
    mkdir -p .fullmag/reports/frequency-domain-eigen-dispersion-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-dispersion-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigenmodes_dispersion_k_path.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts/eigen/dispersion/path.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts/eigen/modes/sample_0003/mode_0000.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts/eigen/mode_fields.zarr/sample_0003/mode_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-reference-full-2x2-floquet --require-exchange-only-analytic-dispersion --require-exchange-only-reciprocal-dispersion .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts'
    python3 scripts/plot_fem_frequency_domain_eigen_artifacts.py \
      .fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts \
      --output-dir .fullmag/reports/frequency-domain-eigen-dispersion-runtime/plots \
      --modes 0 \
      --dispersion-png examples/dyspersje.png
    test -f .fullmag/reports/frequency-domain-eigen-dispersion-runtime/plots/spectrum.svg
    test -f examples/dyspersje.png

verify-fem-frequency-domain-eigen-dispersion-window-runtime:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime
    mkdir -p .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigenmodes_dispersion_window_k_path.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts/eigen/dispersion/path.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts/eigen/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts/eigen/modes/sample_0003/mode_0000.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts/eigen/mode_fields.zarr/sample_0003/mode_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-production-modal-k-path --require-exchange-only-analytic-dispersion --require-exchange-only-reciprocal-dispersion .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts'
    python3 scripts/plot_fem_frequency_domain_eigen_artifacts.py \
      .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts \
      --output-dir .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/plots \
      --modes 0 \
      --dispersion-png examples/dyspersje.png
    test -f .fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/plots/spectrum.svg
    test -f examples/dyspersje.png

verify-fem-frequency-domain-eigen-dispersion-de-bv-low-k-runtime:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime
    mkdir -p .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigenmodes_dispersion_de_bv_low_k.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts/eigen/dispersion/path.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts/eigen/modes/sample_0005/mode_0000.json && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts/eigen/mode_fields/sample_0005/mode_0000/vector.bin && \
        test -f .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-low-k-de-bv-analytic-dispersion .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts'
    python3 scripts/plot_fem_frequency_domain_eigen_artifacts.py \
      .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/artifacts \
      --output-dir .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/plots \
      --modes 0 \
      --dispersion-png examples/dyspersje.png
    test -f .fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/plots/spectrum.svg
    test -f examples/dyspersje.png

verify-fem-frequency-domain-eigen-production-gamma-k-path-runtime:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime
    mkdir -p .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigenmodes_production_gamma_k_path.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts/eigen/dispersion/path.json && \
        test -f .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts/eigen/modes/sample_0002/mode_0000.json && \
        test -f .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts/eigen/mode_fields.zarr/sample_0002/mode_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-production-gamma-k-path .fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts'

verify-fem-frequency-domain-eigen-k0-kittel-runtime:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigen_k0_kittel_zeeman_no_demag.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/validation/kittel_k0_pbc/points.v1.csv && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-field-sweep .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts'

verify-fem-frequency-domain-eigen-k0-kittel-demag-cpu:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-demag
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-kittel-demag
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-kittel-demag 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigen_k0_kittel_thinfilm_demag.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts/validation/kittel_k0_pbc/summary.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts/validation/kittel_k0_pbc/points.v1.csv && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-demag .fullmag/reports/frequency-domain-eigen-k0-kittel-demag/artifacts'

verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-cpu:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigen_k0_kittel_periodic_airbox.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts/validation/kittel_k0_pbc/summary.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts/validation/kittel_k0_pbc/points.v1.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts/validation/kittel_k0_pbc/convergence.v1.csv && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-periodic-airbox-demag .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts'

verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-convergence
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-convergence
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-convergence 2>/dev/null || true'\'' EXIT && \
        report=.fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-convergence && \
        rm -rf "$report/mesh" "$report/airbox" "$report/aggregate" && \
        run_case() { \
          label="$1"; mag_hmax="$2"; mag_hmin="$3"; airbox_hmax="$4"; airbox_factor="$5"; \
          root="$report/$label/artifacts"; \
          FULLMAG_K0_KITTEL_MAG_HMAX_NM="$mag_hmax" \
          FULLMAG_K0_KITTEL_MAG_HMIN_NM="$mag_hmin" \
          FULLMAG_K0_KITTEL_AIRBOX_HMAX_NM="$airbox_hmax" \
          FULLMAG_K0_KITTEL_AIRBOX_FACTOR="$airbox_factor" \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
            examples/fem_eigen_k0_kittel_periodic_airbox.py \
            --backend fem --headless --json --output-dir "$root" && \
          python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py \
            --require-k0-kittel-periodic-airbox-demag "$root"; \
        } && \
        run_case mesh/coarse 24 12 40 9 && \
        run_case mesh/medium 20 10 40 9 && \
        run_case mesh/fine 16 8 40 9 && \
        run_case airbox/small 16 8 40 5 && \
        run_case airbox/medium 16 8 40 7 && \
        run_case airbox/large 16 8 40 9 && \
        python3 scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py \
          --mesh-root "$report/mesh/coarse/artifacts" \
          --mesh-root "$report/mesh/medium/artifacts" \
          --mesh-root "$report/mesh/fine/artifacts" \
          --airbox-root "$report/airbox/small/artifacts" \
          --airbox-root "$report/airbox/medium/artifacts" \
          --airbox-root "$report/airbox/large/artifacts" \
          --output-dir "$report/aggregate"'

verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu 2>/dev/null || true'\'' EXIT && \
        report=.fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu && \
        rm -rf "$report/mesh" "$report/airbox" "$report/aggregate" && \
        run_case() { \
          label="$1"; mag_hmax="$2"; mag_hmin="$3"; airbox_hmax="$4"; airbox_factor="$5"; \
          root="$report/$label/artifacts"; \
          FULLMAG_K0_KITTEL_MAG_HMAX_NM="$mag_hmax" \
          FULLMAG_K0_KITTEL_MAG_HMIN_NM="$mag_hmin" \
          FULLMAG_K0_KITTEL_AIRBOX_HMAX_NM="$airbox_hmax" \
          FULLMAG_K0_KITTEL_AIRBOX_FACTOR="$airbox_factor" \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
            examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py \
            --backend fem --headless --json --output-dir "$root" && \
          python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py \
            --require-gpu-modal-k0-periodic-airbox-provenance "$root"; \
        } && \
        run_case mesh/coarse 24 12 40 9 && \
        run_case mesh/medium 20 10 40 9 && \
        run_case mesh/fine 16 8 40 9 && \
        run_case airbox/small 16 8 40 5 && \
        run_case airbox/medium 16 8 40 7 && \
        run_case airbox/large 16 8 40 9 && \
        python3 scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py \
          --mesh-root "$report/mesh/coarse/artifacts" \
          --mesh-root "$report/mesh/medium/artifacts" \
          --mesh-root "$report/mesh/fine/artifacts" \
          --airbox-root "$report/airbox/small/artifacts" \
          --airbox-root "$report/airbox/medium/artifacts" \
          --airbox-root "$report/airbox/large/artifacts" \
          --execution-lane production_gpu \
          --output-dir "$report/aggregate"'

verify-fem-frequency-domain-eigen-k0-kittel-gpu-runtime:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigen_k0_kittel_zeeman_no_demag_gpu.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json && \
        test -f .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/validation/kittel_k0_pbc/points.v1.csv && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-field-sweep --require-gpu-modal-k0-kittel-provenance .fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts'

verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-gpu
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-gpu
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-gpu 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-gpu/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-gpu/artifacts && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py \
          --require-gpu-modal-k0-periodic-airbox-provenance \
          .fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-gpu/artifacts'

verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu:
    test -n "${FULLMAG_FEM_K0_CPU_SCOPE_JSON:-}" || { echo "production CPU gate is blocked: FULLMAG_FEM_K0_CPU_SCOPE_JSON is required" >&2; exit 1; }
    test -n "${FULLMAG_FEM_K0_CPU_EVIDENCE_MANIFEST:-}" || { echo "production CPU gate is blocked: FULLMAG_FEM_K0_CPU_EVIDENCE_MANIFEST is required" >&2; exit 1; }
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    docker compose --profile fem-modal-cpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_K0_PRODUCTION_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-modal-cpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigen_k0_poisson_airbox_production.py \
          --backend fem --headless --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu/artifacts && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py \
          --require-k0-periodic-airbox-production \
          .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu/artifacts'
    just write-fem-frequency-domain-validation-bundle .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu/artifacts "$FULLMAG_FEM_K0_CPU_SCOPE_JSON" cpu "$FULLMAG_FEM_K0_CPU_EVIDENCE_MANIFEST"
    record=".fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu/artifacts/validation/frequency_domain_production_dod.v1.json"; \
    test -f "$record" || { echo "production CPU gate is blocked: missing frequency_domain_production_dod.v1 record" >&2; exit 1; }; \
    python3 scripts/verify_fem_frequency_domain_production_dod.py \
      --record "$record" \
      --bundle-root .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu/artifacts; \
    test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["promotion_decision"])' "$record")" = "production_qualified" || { echo "production CPU gate is blocked: promotion_decision is not production_qualified" >&2; exit 1; }; \
    test "$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["open_blockers"]))' "$record")" = "[]" || { echo "production CPU gate is blocked: open_blockers is not empty" >&2; exit 1; }

verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu:
    test -n "${FULLMAG_FEM_K0_GPU_SCOPE_JSON:-}" || { echo "production GPU gate is blocked: FULLMAG_FEM_K0_GPU_SCOPE_JSON is required" >&2; exit 1; }
    test -n "${FULLMAG_FEM_K0_GPU_EVIDENCE_MANIFEST:-}" || { echo "production GPU gate is blocked: FULLMAG_FEM_K0_GPU_EVIDENCE_MANIFEST is required" >&2; exit 1; }
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu
    mkdir -p .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_K0_PRODUCTION_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_eigen_k0_poisson_airbox_production.py \
          --backend fem --headless --json \
          --output-dir .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu/artifacts && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py \
          --require-gpu-modal-k0-periodic-airbox-production \
          .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu/artifacts'
    just write-fem-frequency-domain-validation-bundle .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu/artifacts "$FULLMAG_FEM_K0_GPU_SCOPE_JSON" gpu "$FULLMAG_FEM_K0_GPU_EVIDENCE_MANIFEST"
    record=".fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu/artifacts/validation/frequency_domain_production_dod.v1.json"; \
    test -f "$record" || { echo "production GPU gate is blocked: missing frequency_domain_production_dod.v1 record" >&2; exit 1; }; \
    python3 scripts/verify_fem_frequency_domain_production_dod.py \
      --record "$record" \
      --bundle-root .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu/artifacts; \
    test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["promotion_decision"])' "$record")" = "production_qualified" || { echo "production GPU gate is blocked: promotion_decision is not production_qualified" >&2; exit 1; }; \
    test "$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["open_blockers"]))' "$record")" = "[]" || { echo "production GPU gate is blocked: open_blockers is not empty" >&2; exit 1; }

write-fem-frequency-domain-validation-bundle bundle_root scope_json expected_device evidence_manifest:
    python3 scripts/write_fem_frequency_domain_validation_bundle.py --bundle-root "{{bundle_root}}" --scope "{{scope_json}}" --expected-device "{{expected_device}}" --evidence-manifest "{{evidence_manifest}}"

verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-release:
    just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu
    just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu
    just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu
    just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu
    test -n "${FULLMAG_FEM_K0_PERFORMANCE_JSON:-}" || { echo "production release is blocked: FULLMAG_FEM_K0_PERFORMANCE_JSON is required" >&2; exit 1; }
    just verify-fem-frequency-domain-eigen-k0-poisson-airbox-performance "$FULLMAG_FEM_K0_PERFORMANCE_JSON"
    python3 scripts/verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py \
      --cpu .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-cpu/artifacts \
      --gpu .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-gpu/artifacts \
      --output .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-release/cpu_gpu_parity.v1.json

run-fem-frequency-domain-eigen-k0-poisson-airbox-performance-case *args:
    phase="${FULLMAG_K0_PERFORMANCE_PHASE:-run}"; \
    run_id="${FULLMAG_K0_PERFORMANCE_RUN_ID:-}"; \
    dof_count="${FULLMAG_K0_PERFORMANCE_DOF_COUNT:-}"; \
    case "$phase" in \
      run) \
        test -n "$run_id" || { echo "K0 performance case requires FULLMAG_K0_PERFORMANCE_RUN_ID" >&2; exit 2; }; \
        case "$run_id" in *[!A-Za-z0-9._-]*) echo "unsupported K0 performance run id: $run_id" >&2; exit 2 ;; esac; \
        test -n "$dof_count" || { echo "K0 performance case requires FULLMAG_K0_PERFORMANCE_DOF_COUNT" >&2; exit 2; }; \
        test -n "${FULLMAG_K0_PERFORMANCE_NATIVE_DIAGNOSTICS:-}" || { echo "K0 performance case requires FULLMAG_K0_PERFORMANCE_NATIVE_DIAGNOSTICS" >&2; exit 2; }; \
        case "$dof_count" in \
          128) mag_hmax=20.0; mag_hmin=10.0; airbox_hmax=40.0 ;; \
          256) mag_hmax=10.0; mag_hmin=5.0; airbox_hmax=20.0 ;; \
          512) mag_hmax=5.0; mag_hmin=2.5; airbox_hmax=10.0 ;; \
          *) echo "unsupported K0 performance DOF tier: $dof_count (expected 128, 256, or 512)" >&2; exit 2 ;; \
        esac; \
        repeat=0; case "$run_id" in *reuse) repeat=1 ;; esac; \
        case_root=".fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-performance/$run_id"; \
        artifacts="$case_root/artifacts"; \
        rm -rf "$case_root"; mkdir -p "$artifacts" "$(dirname "$FULLMAG_K0_PERFORMANCE_NATIVE_DIAGNOSTICS")"; \
        runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; test -x "$runtime_root/bin/fullmag-fem-gpu"; \
        docker compose --profile fem-gpu run --rm \
          -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
          -e PYTHONPATH=/workspace/packages/fullmag-py/src \
          -e FULLMAG_PYTHON=/usr/bin/python3 \
          -e FULLMAG_FDM_EXECUTION=cpu \
          -e FULLMAG_FEM_EXECUTION=gpu \
          -e FULLMAG_RELAX_DEVICE=gpu \
          -e FULLMAG_K0_PRODUCTION_DEVICE=gpu \
          -e FULLMAG_K0_PRODUCTION_MAG_HMAX_NM="$mag_hmax" \
          -e FULLMAG_K0_PRODUCTION_MAG_HMIN_NM="$mag_hmin" \
          -e FULLMAG_K0_PRODUCTION_AIRBOX_HMAX_NM="$airbox_hmax" \
          -e FULLMAG_K0_PERFORMANCE_REPEAT="$repeat" \
          -e FULLMAG_K0_PERFORMANCE_ARTIFACTS="$artifacts" \
          -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
          -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
          -e FULLMAG_HOST_UID="$(id -u)" \
          -e FULLMAG_HOST_GID="$(id -g)" \
          fem-gpu bash -lc 'cd /workspace && \
            trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-performance 2>/dev/null || true'\'' EXIT && \
            rm -rf "$FULLMAG_K0_PERFORMANCE_ARTIFACTS" && mkdir -p "$FULLMAG_K0_PERFORMANCE_ARTIFACTS" && \
            .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
              examples/fem_eigen_k0_poisson_airbox_production.py \
              --backend fem --headless --json --output-dir "$FULLMAG_K0_PERFORMANCE_ARTIFACTS"'; \
        test -f "$artifacts/eigen/diagnostics/solver.v1.json" || { echo "K0 performance case did not produce native diagnostics" >&2; exit 1; }; \
        cp "$artifacts/eigen/diagnostics/solver.v1.json" "$FULLMAG_K0_PERFORMANCE_NATIVE_DIAGNOSTICS"; \
        ;; \
      cancellation) \
        test -n "${FULLMAG_K0_PERFORMANCE_PARTIAL_ARTIFACT:-}" || { echo "K0 cancellation case requires FULLMAG_K0_PERFORMANCE_PARTIAL_ARTIFACT" >&2; exit 2; }; \
        cancel_root=".fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-performance/cancellation"; \
        cancel_artifacts="$cancel_root/artifacts"; \
        rm -rf "$cancel_root"; mkdir -p "$cancel_artifacts" "$(dirname "$FULLMAG_K0_PERFORMANCE_PARTIAL_ARTIFACT")"; \
        runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; test -x "$runtime_root/bin/fullmag-fem-gpu"; \
        set +e; docker compose --profile fem-gpu run --rm \
          -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
          -e PYTHONPATH=/workspace/packages/fullmag-py/src \
          -e FULLMAG_PYTHON=/usr/bin/python3 \
          -e FULLMAG_FDM_EXECUTION=cpu \
          -e FULLMAG_FEM_EXECUTION=gpu \
          -e FULLMAG_RELAX_DEVICE=gpu \
          -e FULLMAG_K0_PRODUCTION_DEVICE=gpu \
          -e FULLMAG_K0_PERFORMANCE_CANCEL_ARTIFACTS="$cancel_artifacts" \
          -e FULLMAG_FEM_EIGEN_CANCEL_AFTER_MS="${FULLMAG_FEM_EIGEN_CANCEL_AFTER_MS:-25}" \
          -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
          -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
          -e FULLMAG_HOST_UID="$(id -u)" \
          -e FULLMAG_HOST_GID="$(id -g)" \
          fem-gpu bash -lc 'cd /workspace && \
            trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-performance/cancellation 2>/dev/null || true'\'' EXIT && \
            rm -rf "$FULLMAG_K0_PERFORMANCE_CANCEL_ARTIFACTS" && mkdir -p "$FULLMAG_K0_PERFORMANCE_CANCEL_ARTIFACTS" && \
            .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
              examples/fem_eigen_k0_poisson_airbox_production.py \
              --backend fem --headless --json --output-dir "$FULLMAG_K0_PERFORMANCE_CANCEL_ARTIFACTS"'; \
        status=$?; set -e; \
        test -f "$cancel_artifacts/eigen/partial.v1.json" || { echo "K0 cancellation did not preserve eigen/partial.v1.json (status=$status)" >&2; exit 1; }; \
        cp "$cancel_artifacts/eigen/partial.v1.json" "$FULLMAG_K0_PERFORMANCE_PARTIAL_ARTIFACT"; \
        ;; \
      sanitizer) \
        test -n "${FULLMAG_K0_PERFORMANCE_SANITIZER_LOG:-}" || { echo "K0 sanitizer case requires FULLMAG_K0_PERFORMANCE_SANITIZER_LOG" >&2; exit 2; }; \
        sanitizer_root=".fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-performance/sanitizer"; \
        sanitizer_artifacts="$sanitizer_root/artifacts"; \
        rm -rf "$sanitizer_root"; mkdir -p "$sanitizer_artifacts" "$(dirname "$FULLMAG_K0_PERFORMANCE_SANITIZER_LOG")"; \
        runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; test -x "$runtime_root/bin/fullmag-fem-gpu"; \
        docker compose --profile fem-gpu run --rm \
          -v "$runtime_root:/workspace/.fullmag/runtimes/fem-gpu-host:ro" \
          -e PYTHONPATH=/workspace/packages/fullmag-py/src \
          -e FULLMAG_PYTHON=/usr/bin/python3 \
          -e FULLMAG_FDM_EXECUTION=cpu \
          -e FULLMAG_FEM_EXECUTION=gpu \
          -e FULLMAG_RELAX_DEVICE=gpu \
          -e FULLMAG_K0_PRODUCTION_DEVICE=gpu \
          -e FULLMAG_K0_PERFORMANCE_SANITIZER_ARTIFACTS="$sanitizer_artifacts" \
          -e FULLMAG_K0_PERFORMANCE_SANITIZER_LOG="${FULLMAG_K0_PERFORMANCE_SANITIZER_LOG}" \
          -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
          -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
          -e FULLMAG_HOST_UID="$(id -u)" \
          -e FULLMAG_HOST_GID="$(id -g)" \
          fem-gpu bash -lc 'cd /workspace && \
            trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-performance/sanitizer 2>/dev/null || true'\'' EXIT && \
            rm -rf "$FULLMAG_K0_PERFORMANCE_SANITIZER_ARTIFACTS" && mkdir -p "$FULLMAG_K0_PERFORMANCE_SANITIZER_ARTIFACTS" && \
            command -v compute-sanitizer >/dev/null 2>&1 || { echo "compute-sanitizer is unavailable in the managed FEM GPU image" >&2; exit 127; }; \
            compute-sanitizer --tool memcheck --error-exitcode 1 --log-file "$FULLMAG_K0_PERFORMANCE_SANITIZER_LOG" \
              .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
              examples/fem_eigen_k0_poisson_airbox_production.py \
              --backend fem --headless --json --output-dir "$FULLMAG_K0_PERFORMANCE_SANITIZER_ARTIFACTS"'; \
        test -f "$FULLMAG_K0_PERFORMANCE_SANITIZER_LOG" || { echo "compute-sanitizer did not write its log" >&2; exit 1; }; \
        ;; \
      *) echo "unsupported FULLMAG_K0_PERFORMANCE_PHASE: $phase" >&2; exit 2 ;; \
    esac

capture-fem-frequency-domain-eigen-k0-poisson-airbox-performance config_json output_json:
    just ensure-python
    just ensure-managed-fem-runtime
    python3 scripts/capture_fem_eigen_k0_periodic_airbox_performance.py --config "{{config_json}}" --output "{{output_json}}"

verify-fem-frequency-domain-eigen-k0-poisson-airbox-performance input_json:
    python3 scripts/verify_fem_eigen_k0_periodic_airbox_performance.py "{{input_json}}" \
      --output .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-production-release/performance.v1.json

fem-fmr-free-demag-airbox-example:
    just verify-fem-fmr-free-demag-airbox-runtime
    printf '\nFMR free-boundary demag-airbox example outputs:\n'
    printf '  spectrum: .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts/eigen/spectrum.v2.json\n'
    printf '  mode metadata: .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts/eigen/modes/sample_0000/mode_0000.json\n'
    printf '  mode field: .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0\n'
    printf '  plots: .fullmag/reports/fmr-free-demag-airbox-runtime/plots\n'

fem-fmr-free-demag-airbox-ui:
    just fullmag fem cpu examples/fem_fmr_free_demag_airbox_smoke.py

fem-fmr-periodic-k0-example:
    just verify-fem-fmr-periodic-k0-runtime
    printf '\nFMR periodic k=0 antidot response outputs:\n'
    printf '  response sweep: .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/magnetic_response_sweep.v2.json\n'
    printf '  frequency point: .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/frequency_points/frequency_0000.json\n'
    printf '  response field: .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0\n'
    printf '  periodic pairs: .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/mesh/periodic_pairs.v1.json\n'
    printf '  manifest: .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/frequency_domain/manifest.v1.json\n'

run-fem-periodic-antidot-frequency-driven-managed-headless fem_execution="script" cpu_threads="auto":
    just ensure-python
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts
    mkdir -p .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime
    mode="{{fem_execution}}"; \
    case "$mode" in script|SCRIPT|auto|AUTO|0|gpu|GPU) mode="gpu" ;; cpu|CPU) echo "unsupported FEM execution mode for periodic-antidot frequency-driven example: this example exercises the native GPU periodic-airbox dynamic-demag response slice" >&2; exit 2 ;; *) echo "unsupported FEM execution mode: $mode (expected gpu)" >&2; exit 2 ;; esac; \
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_FMR_DEVICE=gpu \
      -e FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE=relax \
      -e FULLMAG_FEM_GPU_DEMAG_MODE="${FULLMAG_FEM_GPU_DEMAG_MODE:-device_hypre_poisson}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_GMSH_THREADS:-1}" \
      -e FULLMAG_CPU_THREADS="{{cpu_threads}}" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-1000}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/relax_artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          --dev examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py \
          --headless \
          --json \
          --output-dir .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/relax_artifacts'
    test -f .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/relax_artifacts/m_final.json
    python3 scripts/write_fem_magnetic_initial_state_from_shared_domain.py .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/relax_artifacts .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/relaxed_magnetic_initial_state.json
    test -f .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/relaxed_magnetic_initial_state.json
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_FMR_DEVICE=gpu \
      -e FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE=response \
      -e FULLMAG_PERIODIC_ANTIDOT_RELAXED_MAGNETIC_STATE=/workspace/.fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/relaxed_magnetic_initial_state.json \
      -e FULLMAG_FEM_GPU_DEMAG_MODE="${FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE:-hybrid_cpu_poisson}" \
      -e FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE="${FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE:-hybrid_cpu_poisson}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_GMSH_THREADS:-1}" \
      -e FULLMAG_CPU_THREADS="{{cpu_threads}}" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-1000}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}" \
      -e FULLMAG_FEM_FREQUENCY_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FEM_FREQUENCY_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD:-1.0}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS:-16}" \
      -e FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS="${FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS:-4}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          --dev examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py \
          --headless \
          --json \
          --output-dir .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts'
    FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE="${FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE:-hybrid_cpu_poisson}" FULLMAG_FEM_FREQUENCY_RESPONSE_DELTA_PHI_FLUX_MAX_TOLERANCE_T="${FULLMAG_FEM_FREQUENCY_RESPONSE_DELTA_PHI_FLUX_MAX_TOLERANCE_T:-2e-2}" python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-periodic-airbox-gpu-demag-solved .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts

run-permalloy-box-fmr-modes:
    just verify-permalloy-box-fmr-modes-runtime
    printf '\nPermalloy strip-hole modal FMR example outputs:\n'
    printf '  spectrum: .fullmag/reports/permalloy-box-fmr-modes/artifacts/eigen/spectrum.v2.json\n'
    printf '  mode metadata: .fullmag/reports/permalloy-box-fmr-modes/artifacts/eigen/modes/sample_0000/mode_0000.json\n'
    printf '  mode field: .fullmag/reports/permalloy-box-fmr-modes/artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0\n'
    printf '  plots: .fullmag/reports/permalloy-box-fmr-modes/plots\n'

verify-permalloy-box-fmr-modes-runtime:
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/permalloy-box-fmr-modes
    mkdir -p .fullmag/reports/permalloy-box-fmr-modes
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      fem-gpu bash -lc 'cd /workspace && \
        rm -rf .fullmag/reports/permalloy-box-fmr-modes/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/permalloy_box_relax_300x1000x10nm.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/permalloy-box-fmr-modes/artifacts && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/artifacts/eigen/modes/sample_0000/mode_0000.json && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py .fullmag/reports/permalloy-box-fmr-modes/artifacts && \
        python3 scripts/plot_fem_frequency_domain_eigen_artifacts.py \
          .fullmag/reports/permalloy-box-fmr-modes/artifacts \
          --output-dir .fullmag/reports/permalloy-box-fmr-modes/plots \
          --modes 0,1,2,3 && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/plots/spectrum.svg && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/plots/mode_sample_0000_mode_0000_real.svg && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/plots/mode_sample_0000_mode_0000_imag.svg && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/plots/mode_sample_0000_mode_0000_complex.svg && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/plots/mode_sample_0000_mode_0000_abs.svg && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/plots/mode_sample_0000_mode_0000_phase.svg && \
        test -f .fullmag/reports/permalloy-box-fmr-modes/plots/mode_sample_0000_mode_0000_animation.svg'

verify-fem-fmr-free-demag-airbox-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/fmr-free-demag-airbox-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fmr-free-demag-airbox-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/fmr-free-demag-airbox-runtime
    mkdir -p .fullmag/reports/fmr-free-demag-airbox-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fmr-free-demag-airbox-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_fmr_free_demag_airbox_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts/eigen/spectrum.v2.json && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts/eigen/branches.v2.json && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts/eigen/dispersion.csv && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts/eigen/modes/sample_0000/mode_0000.json && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts && \
        python3 scripts/plot_fem_frequency_domain_eigen_artifacts.py \
          .fullmag/reports/fmr-free-demag-airbox-runtime/artifacts \
          --output-dir .fullmag/reports/fmr-free-demag-airbox-runtime/plots \
          --modes 0,1,2 && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/plots/spectrum.svg && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/plots/mode_sample_0000_mode_0000_real.svg && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/plots/mode_sample_0000_mode_0000_imag.svg && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/plots/mode_sample_0000_mode_0000_complex.svg && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/plots/mode_sample_0000_mode_0000_abs.svg && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/plots/mode_sample_0000_mode_0000_phase.svg && \
        test -f .fullmag/reports/fmr-free-demag-airbox-runtime/plots/mode_sample_0000_mode_0000_animation.svg'

verify-fem-fmr-periodic-k0-runtime:
    just verify-fem-frequency-domain-periodic-airbox-runtime

verify-fem-frequency-domain-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-runtime
    mkdir -p .fullmag/reports/frequency-domain-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_cpu_free_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py .fullmag/reports/frequency-domain-runtime/artifacts'

verify-fem-frequency-domain-periodic-airbox-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-periodic-airbox-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-periodic-airbox-runtime
    mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_FMR_FAST_RUNTIME_MESH=1 \
      -e FULLMAG_FMR_MESH_ALGORITHM_3D="${FULLMAG_FMR_MESH_ALGORITHM_3D:-1}" \
      -e FULLMAG_FMR_RELAX_MAX_STEPS="${FULLMAG_FMR_RELAX_MAX_STEPS:-4}" \
      -e FULLMAG_FMR_RELAX_TOL="${FULLMAG_FMR_RELAX_TOL:-0.01}" \
      -e FULLMAG_FMR_FREQUENCIES_GHZ="${FULLMAG_FMR_FREQUENCIES_GHZ:-2.75}" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-500}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts && \
        FROZEN_SOURCE=.fullmag/reports/frequency-domain-periodic-airbox-runtime/mesh/periodic_antidot_frozen_magnetic_submesh.npz && \
        mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-runtime/mesh && \
        python3 scripts/prepare_fmr_frozen_magnetic_submesh.py --output "$FROZEN_SOURCE" && \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$FROZEN_SOURCE" \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/mesh/periodic_pairs.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh .fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts'

verify-fem-frequency-domain-periodic-airbox-promotion-artifacts:
    test -n "${FULLMAG_FMR_PROMOTION_ARTIFACTS}" || { echo "FULLMAG_FMR_PROMOTION_ARTIFACTS must point to a M5-gated periodic-airbox response artifact root" >&2; exit 2; }
    python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py \
      --require-periodic-airbox-cpu-demag-solved \
      --require-frozen-magnetic-submesh \
      --require-m5-equilibrium-provenance \
      --require-min-frequency-points "${FULLMAG_FMR_PROMOTION_MIN_FREQUENCY_POINTS:-5}" \
      --require-response-peak \
      --require-field-payloads-for-frequency-points \
      --require-derived-peak-mode \
      "${FULLMAG_FMR_PROMOTION_ARTIFACTS}"

verify-fem-frequency-domain-periodic-airbox-spectrum-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime
    mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_FMR_FAST_RUNTIME_MESH=1 \
      -e FULLMAG_FMR_MESH_ALGORITHM_3D="${FULLMAG_FMR_MESH_ALGORITHM_3D:-1}" \
      -e FULLMAG_FMR_RELAX_MAX_STEPS="${FULLMAG_FMR_RELAX_MAX_STEPS:-4}" \
      -e FULLMAG_FMR_RELAX_TOL="${FULLMAG_FMR_RELAX_TOL:-0.01}" \
      -e FULLMAG_FMR_FREQUENCIES_GHZ="${FULLMAG_FMR_FREQUENCIES_GHZ:-2.5,2.75,3.0}" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-500}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts && \
        FROZEN_SOURCE=.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/mesh/periodic_antidot_frozen_magnetic_submesh.npz && \
        mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/mesh && \
        python3 scripts/prepare_fmr_frozen_magnetic_submesh.py --output "$FROZEN_SOURCE" && \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$FROZEN_SOURCE" \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/response/frequency_points/frequency_0002.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/response/field_payloads.zarr/frequency_0002/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/mesh/periodic_pairs.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh --require-min-frequency-points 3 --require-response-peak --require-field-payloads-for-frequency-points .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts && \
        python3 scripts/derive_fem_frequency_response_modes.py .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh --require-min-frequency-points 3 --require-response-peak --require-field-payloads-for-frequency-points --require-derived-peak-mode .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts/response/derived_modes/fmr_peak_mode.v1.json'

verify-fem-frequency-domain-periodic-airbox-spectrum-bounded-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime
    mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_FMR_FAST_RUNTIME_MESH=1 \
      -e FULLMAG_FMR_MESH_ALGORITHM_3D="${FULLMAG_FMR_MESH_ALGORITHM_3D:-1}" \
      -e FULLMAG_FMR_RELAX_MAX_STEPS="${FULLMAG_FMR_RELAX_MAX_STEPS:-4}" \
      -e FULLMAG_FMR_RELAX_TOL="${FULLMAG_FMR_RELAX_TOL:-0.01}" \
      -e FULLMAG_FMR_FREQUENCIES_GHZ="${FULLMAG_FMR_FREQUENCIES_GHZ:-2.5,2.75,3.0}" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-500}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-512}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-512}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/artifacts && \
        FROZEN_SOURCE=.fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/mesh/periodic_antidot_frozen_magnetic_submesh.npz && \
        mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/mesh && \
        python3 scripts/prepare_fmr_frozen_magnetic_submesh.py --output "$FROZEN_SOURCE" && \
        set +e; \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$FROZEN_SOURCE" \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/artifacts; \
        RESPONSE_STATUS=$?; \
        set -e; \
        echo "response_status=$RESPONSE_STATUS" > .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/status.txt && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/artifacts/mesh/periodic_pairs.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --allow-solve-error --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh .fullmag/reports/frequency-domain-periodic-airbox-spectrum-bounded-runtime/artifacts'

fem-frequency-response-refinement-env:
    # Prints export FULLMAG_FMR_FREQUENCIES_GHZ=... for the next refined FMR sweep.
    python3 scripts/fem_frequency_response_refinement_env.py --shell-export "${FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS:-.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts}"

verify-fem-frequency-domain-periodic-airbox-refined-spectrum-runtime:
    just ensure-managed-fem-runtime
    REFINEMENT_SOURCE_ARTIFACTS="${FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS:-.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts}" && \
    python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh --require-min-frequency-points 3 --require-response-peak --require-field-payloads-for-frequency-points --require-derived-peak-mode "$REFINEMENT_SOURCE_ARTIFACTS" && \
    REFINED_FREQUENCIES_GHZ="$(python3 scripts/fem_frequency_response_refinement_env.py "$REFINEMENT_SOURCE_ARTIFACTS")" && \
    if [ -d .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime 2>/dev/null || true'; fi && \
    rm -rf .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime && \
    mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime && \
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_FMR_FAST_RUNTIME_MESH=1 \
      -e FULLMAG_FMR_MESH_ALGORITHM_3D="${FULLMAG_FMR_MESH_ALGORITHM_3D:-1}" \
      -e FULLMAG_FMR_RELAX_MAX_STEPS="${FULLMAG_FMR_RELAX_MAX_STEPS:-4}" \
      -e FULLMAG_FMR_RELAX_TOL="${FULLMAG_FMR_RELAX_TOL:-0.01}" \
      -e FULLMAG_FMR_FREQUENCIES_GHZ="$REFINED_FREQUENCIES_GHZ" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-500}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts && \
        FROZEN_SOURCE=.fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/mesh/periodic_antidot_frozen_magnetic_submesh.npz && \
        mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/mesh && \
        python3 scripts/prepare_fmr_frozen_magnetic_submesh.py --output "$FROZEN_SOURCE" && \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$FROZEN_SOURCE" \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/response/frequency_points/frequency_0004.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/response/field_payloads.zarr/frequency_0004/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/mesh/periodic_pairs.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh --require-min-frequency-points 5 --require-response-peak --require-interior-response-peak --require-field-payloads-for-frequency-points .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts && \
        python3 scripts/derive_fem_frequency_response_modes.py .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh --require-min-frequency-points 5 --require-response-peak --require-interior-response-peak --require-field-payloads-for-frequency-points --require-derived-peak-mode .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime/artifacts/response/derived_modes/fmr_peak_mode.v1.json'

verify-fem-frequency-domain-periodic-airbox-z-padding-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime
    mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_FMR_FAST_RUNTIME_MESH=1 \
      -e FULLMAG_FMR_EQUILIBRIUM_SOURCE=provided \
      -e FULLMAG_FMR_MESH_ALGORITHM_3D="${FULLMAG_FMR_MESH_ALGORITHM_3D:-1}" \
      -e FULLMAG_FMR_RELAX_MAX_STEPS="${FULLMAG_FMR_RELAX_MAX_STEPS:-4}" \
      -e FULLMAG_FMR_RELAX_TOL="${FULLMAG_FMR_RELAX_TOL:-0.01}" \
      -e FULLMAG_FMR_FREQUENCIES_GHZ="${FULLMAG_FMR_FREQUENCIES_GHZ:-2.75}" \
      -e FULLMAG_FMR_AIRBOX_REFERENCE_THICKNESS_NM="${FULLMAG_FMR_AIRBOX_REFERENCE_THICKNESS_NM:-120}" \
      -e FULLMAG_FMR_AIRBOX_CANDIDATE_THICKNESS_NM="${FULLMAG_FMR_AIRBOX_CANDIDATE_THICKNESS_NM:-150}" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-500}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/reference/artifacts && \
        rm -rf .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/candidate/artifacts && \
        FROZEN_SOURCE=.fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/mesh/periodic_antidot_frozen_magnetic_submesh.npz && \
        mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/mesh && \
        python3 scripts/prepare_fmr_frozen_magnetic_submesh.py --output "$FROZEN_SOURCE" && \
        FULLMAG_FMR_AIRBOX_THICKNESS_NM="$FULLMAG_FMR_AIRBOX_REFERENCE_THICKNESS_NM" \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$FROZEN_SOURCE" \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/reference/artifacts && \
        FULLMAG_FMR_AIRBOX_THICKNESS_NM="$FULLMAG_FMR_AIRBOX_CANDIDATE_THICKNESS_NM" \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$FROZEN_SOURCE" \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/candidate/artifacts && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/reference/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/candidate/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/reference/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/candidate/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/reference/artifacts && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/candidate/artifacts && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh --compare-airbox-reference .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/reference/artifacts .fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/candidate/artifacts'

verify-fem-frequency-domain-periodic-airbox-supercell-artifacts:
    test -n "${FULLMAG_FMR_SUPERCELL_ARTIFACTS}" || { echo "FULLMAG_FMR_SUPERCELL_ARTIFACTS must point to completed supercell artifacts" >&2; exit 2; }
    python3 scripts/verify_fem_frequency_domain_supercell_artifacts.py \
      --unit-cell "${FULLMAG_FMR_UNIT_CELL_ARTIFACTS:-.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts}" \
      --supercell "${FULLMAG_FMR_SUPERCELL_ARTIFACTS}" \
      --repeat-x "${FULLMAG_FMR_SUPERCELL_REPEAT_X:-2}" \
      --repeat-y "${FULLMAG_FMR_SUPERCELL_REPEAT_Y:-2}" \
      --write-report "${FULLMAG_FMR_SUPERCELL_REPORT:-.fullmag/reports/frequency-domain-periodic-airbox-supercell-validation/supercell_validation.v1.json}"

verify-fem-frequency-domain-periodic-airbox-supercell-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime
    mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_FMR_FAST_RUNTIME_MESH=1 \
      -e FULLMAG_FMR_EQUILIBRIUM_SOURCE=provided \
      -e FULLMAG_FMR_SUPERCELL_REPEAT_X="${FULLMAG_FMR_SUPERCELL_REPEAT_X:-2}" \
      -e FULLMAG_FMR_SUPERCELL_REPEAT_Y="${FULLMAG_FMR_SUPERCELL_REPEAT_Y:-2}" \
      -e FULLMAG_FMR_MESH_ALGORITHM_3D="${FULLMAG_FMR_MESH_ALGORITHM_3D:-1}" \
      -e FULLMAG_FMR_RELAX_MAX_STEPS="${FULLMAG_FMR_RELAX_MAX_STEPS:-4}" \
      -e FULLMAG_FMR_RELAX_TOL="${FULLMAG_FMR_RELAX_TOL:-0.01}" \
      -e FULLMAG_FMR_FREQUENCIES_GHZ="${FULLMAG_FMR_FREQUENCIES_GHZ:-2.5,2.75,3.0}" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-500}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime 2>/dev/null || true'\'' EXIT && \
        UNIT_FROZEN_SOURCE=.fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/unit/mesh/periodic_antidot_frozen_magnetic_submesh.npz && \
        SUPERCELL_FROZEN_SOURCE=.fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/supercell/mesh/periodic_antidot_frozen_magnetic_submesh.npz && \
        mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/unit/mesh && \
        mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/supercell/mesh && \
        FULLMAG_FMR_SUPERCELL_REPEAT_X=1 FULLMAG_FMR_SUPERCELL_REPEAT_Y=1 \
          python3 scripts/prepare_fmr_frozen_magnetic_submesh.py --output "$UNIT_FROZEN_SOURCE" && \
        FULLMAG_FMR_SUPERCELL_REPEAT_X=1 FULLMAG_FMR_SUPERCELL_REPEAT_Y=1 \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$UNIT_FROZEN_SOURCE" \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/unit/artifacts && \
        python3 scripts/prepare_fmr_frozen_magnetic_submesh.py --output "$SUPERCELL_FROZEN_SOURCE" && \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$SUPERCELL_FROZEN_SOURCE" \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/supercell/artifacts && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh --require-min-frequency-points 3 --require-response-peak .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/unit/artifacts && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh --require-min-frequency-points 3 --require-response-peak .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/supercell/artifacts && \
        python3 scripts/verify_fem_frequency_domain_supercell_artifacts.py \
          --unit-cell .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/unit/artifacts \
          --supercell .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/supercell/artifacts \
          --repeat-x "$FULLMAG_FMR_SUPERCELL_REPEAT_X" \
          --repeat-y "$FULLMAG_FMR_SUPERCELL_REPEAT_Y" \
          --write-report .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/supercell_validation.v1.json'

verify-fem-frequency-domain-periodic-airbox-supercell-diagnostics-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime
    mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_FMR_FAST_RUNTIME_MESH=1 \
      -e FULLMAG_FMR_EQUILIBRIUM_SOURCE=provided \
      -e FULLMAG_FMR_SUPERCELL_REPEAT_X="${FULLMAG_FMR_SUPERCELL_REPEAT_X:-2}" \
      -e FULLMAG_FMR_SUPERCELL_REPEAT_Y="${FULLMAG_FMR_SUPERCELL_REPEAT_Y:-2}" \
      -e FULLMAG_FMR_MESH_ALGORITHM_3D="${FULLMAG_FMR_MESH_ALGORITHM_3D:-1}" \
      -e FULLMAG_FMR_RELAX_MAX_STEPS="${FULLMAG_FMR_RELAX_MAX_STEPS:-4}" \
      -e FULLMAG_FMR_RELAX_TOL="${FULLMAG_FMR_RELAX_TOL:-0.01}" \
      -e FULLMAG_FMR_FREQUENCIES_GHZ="${FULLMAG_FMR_FREQUENCIES_GHZ:-2.75}" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-500}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-8}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime 2>/dev/null || true'\'' EXIT && \
        UNIT_FROZEN_SOURCE=.fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime/unit/mesh/periodic_antidot_frozen_magnetic_submesh.npz && \
        SUPERCELL_FROZEN_SOURCE=.fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime/supercell/mesh/periodic_antidot_frozen_magnetic_submesh.npz && \
        mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime/unit/mesh && \
        mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime/supercell/mesh && \
        FULLMAG_FMR_SUPERCELL_REPEAT_X=1 FULLMAG_FMR_SUPERCELL_REPEAT_Y=1 \
          python3 scripts/prepare_fmr_frozen_magnetic_submesh.py --output "$UNIT_FROZEN_SOURCE" && \
        set +e; \
        FULLMAG_FMR_SUPERCELL_REPEAT_X=1 FULLMAG_FMR_SUPERCELL_REPEAT_Y=1 \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$UNIT_FROZEN_SOURCE" \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime/unit/artifacts; \
        UNIT_STATUS=$?; \
        set -e; \
        python3 scripts/prepare_fmr_frozen_magnetic_submesh.py --output "$SUPERCELL_FROZEN_SOURCE" && \
        set +e; \
        FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE="$SUPERCELL_FROZEN_SOURCE" \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime/supercell/artifacts; \
        SUPERCELL_STATUS=$?; \
        set -e; \
        echo "unit_status=$UNIT_STATUS supercell_status=$SUPERCELL_STATUS" > .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime/status.txt && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --allow-solve-error --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime/unit/artifacts && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --allow-solve-error --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh .fullmag/reports/frequency-domain-periodic-airbox-supercell-diagnostics-runtime/supercell/artifacts'

verify-fem-frequency-domain-cpu-periodic-airbox-demag-smoke-runtime cpu_threads="auto":
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-cpu-periodic-airbox-demag-smoke-runtime
    mkdir -p .fullmag/reports/frequency-domain-cpu-periodic-airbox-demag-smoke-runtime
    cpu_threads_env="${FULLMAG_CPU_THREADS:-{{cpu_threads}}}"; \
    env -u FULLMAG_FEM_EXECUTION FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FMR_DEVICE=cpu FULLMAG_CPU_THREADS="$cpu_threads_env" FULLMAG_GMSH_THREADS="${FULLMAG_GMSH_THREADS:-1}" '{{gpu_runtime_bin}}' --dev examples/fem_frequency_response_cpu_periodic_airbox_demag_smoke.py --headless --json --output-dir .fullmag/reports/frequency-domain-cpu-periodic-airbox-demag-smoke-runtime/artifacts
    python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved .fullmag/reports/frequency-domain-cpu-periodic-airbox-demag-smoke-runtime/artifacts

verify-fem-frequency-domain-periodic-airbox-gpu-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime
    mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_FMR_DEVICE=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_FEM_GPU_DEMAG_MODE="${FULLMAG_FEM_GPU_DEMAG_MODE:-device_hypre_poisson}" \
      -e FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE="${FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE:-hybrid_cpu_poisson}" \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD:-1.0}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS:-16}" \
      -e FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS="${FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS:-4}" \
      -e FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_RELAXATION="${FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_RELAXATION:-1.0}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_periodic_airbox_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts/mesh/periodic_pairs.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-periodic-airbox-gpu-demag-solved .fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts'

verify-fem-frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime
    mkdir -p .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}" \
      -e FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}" \
      -e FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-128}" \
      -e FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-none}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD:-1.0}" \
      -e FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS:-16}" \
      -e FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS="${FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS:-4}" \
      -e FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_RELAXATION="${FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_RELAXATION:-1.0}" \
      -e FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-10}" \
      -e FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-2000}" \
      -e FULLMAG_FEM_FREQUENCY_RESPONSE_CPU_GPU_PARITY_ABS_TOL="${FULLMAG_FEM_FREQUENCY_RESPONSE_CPU_GPU_PARITY_ABS_TOL:-1e-6}" \
      -e FULLMAG_FEM_FREQUENCY_RESPONSE_CPU_GPU_PARITY_REL_TOL="${FULLMAG_FEM_FREQUENCY_RESPONSE_CPU_GPU_PARITY_REL_TOL:-1e-6}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/cpu/artifacts && \
        rm -rf .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu/artifacts && \
        FULLMAG_FEM_EXECUTION=cpu \
        FULLMAG_RELAX_DEVICE=cpu \
        FULLMAG_FMR_DEVICE=cpu \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_cpu_periodic_airbox_demag_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/cpu/artifacts && \
        FULLMAG_FEM_EXECUTION=gpu \
        FULLMAG_RELAX_DEVICE=gpu \
        FULLMAG_FMR_DEVICE=gpu \
        FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson \
        FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE=device_hypre_poisson \
        FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT=none \
        FULLMAG_FMR_PERIODIC_AIRBOX_GPU_FREQUENCIES_HZ=1.0e9 \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_periodic_airbox_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu/artifacts && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/cpu/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu/artifacts/response/diagnostics/solver.v1.json && \
        FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE=device_hypre_poisson \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py \
          --require-production-gpu \
          --require-periodic-airbox-gpu-demag-solved \
          --compare-reference \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/cpu/artifacts \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu/artifacts && \
        python3 scripts/write_fem_gpu_poisson_parity_artifact.py \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/cpu/artifacts \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu/artifacts \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_poisson_parity.v1.json && \
        python3 scripts/verify_fem_gpu_poisson_parity_artifact.py \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_poisson_parity.v1.json && \
        python3 scripts/write_fem_gpu_schur_apply_parity_artifact.py \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu/artifacts \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_schur_apply_parity.v1.json && \
        python3 scripts/verify_fem_gpu_schur_apply_parity_artifact.py \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_schur_apply_parity.v1.json && \
        python3 scripts/write_fem_gpu_shifted_solve_action_parity_artifact.py \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/cpu/artifacts \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu/artifacts \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_shifted_solve_action_parity.v1.json && \
        python3 scripts/verify_fem_gpu_shifted_solve_action_parity_artifact.py \
          .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_shifted_solve_action_parity.v1.json'

verify-fem-frequency-domain-periodic-airbox-gpu-unsupported-runtime:
    just verify-fem-frequency-domain-periodic-airbox-gpu-runtime

verify-fem-frequency-domain-static-periodic-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-static-periodic-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-static-periodic-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-static-periodic-runtime
    mkdir -p .fullmag/reports/frequency-domain-static-periodic-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-static-periodic-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_static_periodic_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-static-periodic .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts'

verify-fem-frequency-domain-gpu-free-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-gpu-free-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-free-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-gpu-free-runtime
    mkdir -p .fullmag/reports/frequency-domain-gpu-free-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-free-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_free_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu .fullmag/reports/frequency-domain-gpu-free-runtime/artifacts'

verify-fem-frequency-domain-gpu-free-demag-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-gpu-free-demag-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-free-demag-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-gpu-free-demag-runtime
    mkdir -p .fullmag/reports/frequency-domain-gpu-free-demag-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-free-demag-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_free_demag_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu .fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts && \
        python3 -c '\''import json; p=".fullmag/reports/frequency-domain-gpu-free-demag-runtime/artifacts/response/diagnostics/solver.v1.json"; d=json.load(open(p)); assert d.get("resolved_execution_lane")=="production_gpu"; assert d.get("gpu_operator_solver") is True; assert "demag" in d.get("operator_terms_included", []); assert d.get("validation_fallback_used") is False'\'''

verify-fem-frequency-domain-free-demag-parity-runtime cpu_threads="auto":
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-free-demag-parity-runtime
    mkdir -p .fullmag/reports/frequency-domain-free-demag-parity-runtime/cpu .fullmag/reports/frequency-domain-free-demag-parity-runtime/gpu
    cpu_threads_env="${FULLMAG_CPU_THREADS:-{{cpu_threads}}}"; \
    env -u FULLMAG_FEM_EXECUTION FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FMR_DEVICE=cpu FULLMAG_CPU_THREADS="$cpu_threads_env" FULLMAG_GMSH_THREADS="${FULLMAG_GMSH_THREADS:-1}" '{{gpu_runtime_bin}}' --dev examples/fem_frequency_response_cpu_free_demag_smoke.py --headless --json --output-dir .fullmag/reports/frequency-domain-free-demag-parity-runtime/cpu/artifacts
    python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py .fullmag/reports/frequency-domain-free-demag-parity-runtime/cpu/artifacts
    cpu_threads_env="${FULLMAG_CPU_THREADS:-{{cpu_threads}}}"; \
    env -u FULLMAG_FEM_EXECUTION FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FMR_DEVICE=gpu FULLMAG_CPU_THREADS="$cpu_threads_env" FULLMAG_GMSH_THREADS="${FULLMAG_GMSH_THREADS:-1}" '{{gpu_runtime_bin}}' --dev examples/fem_frequency_response_gpu_free_demag_smoke.py --headless --json --output-dir .fullmag/reports/frequency-domain-free-demag-parity-runtime/gpu/artifacts
    python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --compare-reference .fullmag/reports/frequency-domain-free-demag-parity-runtime/cpu/artifacts .fullmag/reports/frequency-domain-free-demag-parity-runtime/gpu/artifacts
    python3 -c 'import json; p=".fullmag/reports/frequency-domain-free-demag-parity-runtime/gpu/artifacts/response/diagnostics/solver.v1.json"; d=json.load(open(p)); assert d.get("gpu_operator_solver") is True; assert "demag" in d.get("operator_terms_included", [])'

verify-fem-frequency-domain-gpu-static-periodic-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-gpu-static-periodic-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-static-periodic-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-gpu-static-periodic-runtime
    mkdir -p .fullmag/reports/frequency-domain-gpu-static-periodic-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-static-periodic-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_static_periodic_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-static-periodic .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts'

verify-fem-frequency-domain-cpu-floquet-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-cpu-floquet-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-cpu-floquet-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-cpu-floquet-runtime
    mkdir -p .fullmag/reports/frequency-domain-cpu-floquet-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_FMR_DEVICE=cpu \
      -e FULLMAG_FMR_FLOQUET_KX_RAD_PER_M=1000000 \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-cpu-floquet-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-floquet-phase-projection .fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts'

verify-fem-frequency-domain-gpu-floquet-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-gpu-floquet-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-floquet-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-gpu-floquet-runtime
    mkdir -p .fullmag/reports/frequency-domain-gpu-floquet-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_FMR_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-floquet-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts/response/magnetic_response_sweep.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts/response/frequency_points/frequency_0000.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts/response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0 && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-floquet-phase-projection .fullmag/reports/frequency-domain-gpu-floquet-runtime/artifacts'

verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime
    mkdir -p .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_FMR_FLOQUET_KX_RAD_PER_M=1000000 \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime/artifacts && \
        set +e; \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_floquet_airbox_unsupported_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime/artifacts; \
        set -e; \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime/artifacts/response/progress.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime/artifacts/response/diagnostics/solver.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime/artifacts/mesh/periodic_pairs.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-floquet-airbox-gpu-unsupported --allow-unavailable .fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime/artifacts'

verify-fem-frequency-domain-gpu-floquet-reciprocal-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime
    mkdir -p .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime 2>/dev/null || true'\'' EXIT && \
        rm -rf .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/positive-k/artifacts && \
        rm -rf .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/negative-k/artifacts && \
        FULLMAG_FMR_FLOQUET_KX_RAD_PER_M=1000000 \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/positive-k/artifacts && \
        FULLMAG_FMR_FLOQUET_KX_RAD_PER_M=-1000000 \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/negative-k/artifacts && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/positive-k/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/negative-k/artifacts/response/magnetic_response_sweep.v2.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/positive-k/artifacts/frequency_domain/manifest.v1.json && \
        test -f .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/negative-k/artifacts/frequency_domain/manifest.v1.json && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-floquet-phase-projection .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/positive-k/artifacts && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-floquet-phase-projection .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/negative-k/artifacts && \
        python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-floquet-phase-projection --compare-floquet-reciprocal-reference .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/negative-k/artifacts .fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/positive-k/artifacts'

verify-fem-frequency-domain-gpu-static-periodic-parity-runtime:
    just verify-fem-frequency-domain-static-periodic-runtime
    just verify-fem-frequency-domain-gpu-static-periodic-runtime
    python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-static-periodic --compare-reference .fullmag/reports/frequency-domain-static-periodic-runtime/artifacts .fullmag/reports/frequency-domain-gpu-static-periodic-runtime/artifacts

verify-fem-frequency-domain-shared-domain-static-periodic-parity-runtime cpu_threads="auto":
    just ensure-python
    just ensure-managed-fem-runtime
    rm -rf .fullmag/reports/frequency-domain-shared-domain-static-periodic-parity-runtime
    mkdir -p .fullmag/reports/frequency-domain-shared-domain-static-periodic-parity-runtime/cpu .fullmag/reports/frequency-domain-shared-domain-static-periodic-parity-runtime/gpu
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    env -u FULLMAG_FEM_EXECUTION FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FMR_DEVICE=cpu FULLMAG_CPU_THREADS="$cpu_threads_env" FULLMAG_GMSH_THREADS="${FULLMAG_GMSH_THREADS:-1}" '{{gpu_runtime_bin}}' --dev examples/fem_frequency_response_shared_domain_static_periodic_smoke.py --headless --json --output-dir .fullmag/reports/frequency-domain-shared-domain-static-periodic-parity-runtime/cpu/artifacts
    python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-static-periodic .fullmag/reports/frequency-domain-shared-domain-static-periodic-parity-runtime/cpu/artifacts
    if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
    env -u FULLMAG_FEM_EXECUTION FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FMR_DEVICE=gpu FULLMAG_CPU_THREADS="$cpu_threads_env" FULLMAG_GMSH_THREADS="${FULLMAG_GMSH_THREADS:-1}" '{{gpu_runtime_bin}}' --dev examples/fem_frequency_response_shared_domain_static_periodic_smoke.py --headless --json --output-dir .fullmag/reports/frequency-domain-shared-domain-static-periodic-parity-runtime/gpu/artifacts
    python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-production-gpu --require-static-periodic --compare-reference .fullmag/reports/frequency-domain-shared-domain-static-periodic-parity-runtime/cpu/artifacts .fullmag/reports/frequency-domain-shared-domain-static-periodic-parity-runtime/gpu/artifacts

verify-fem-relaxation-runtime:
    bash scripts/verify_fem_relaxation_runtime.sh

verify-fem-preview-surface-matrix:
    if [ -z "${FULLMAG_MATRIX_PYTHON:-}" ]; then just ensure-python; fi
    matrix_python="${FULLMAG_MATRIX_PYTHON:-{{repo_python}}}"; FULLMAG_MATRIX_PYTHON="$matrix_python" "$matrix_python" -m unittest scripts/test_verify_fem_preview_surface_matrix.py
    just ensure-managed-fem-runtime
    just build-static-control-room
    matrix_python="${FULLMAG_MATRIX_PYTHON:-{{repo_python}}}"; FULLMAG_MATRIX_PYTHON="$matrix_python" "$matrix_python" scripts/verify_fem_preview_surface_matrix.py

verify-fem-preview-energy-qualification:
    if [ -z "${FULLMAG_MATRIX_PYTHON:-}" ]; then just ensure-python; fi
    matrix_python="${FULLMAG_MATRIX_PYTHON:-{{repo_python}}}"; FULLMAG_MATRIX_PYTHON="$matrix_python" "$matrix_python" -m unittest scripts/test_verify_fem_preview_surface_matrix.py
    just ensure-managed-fem-runtime
    just build-static-control-room
    rm -rf .fullmag/reports/fem-preview-energy-qualification
    mkdir -p .fullmag/reports/fem-preview-energy-qualification
    matrix_python="${FULLMAG_MATRIX_PYTHON:-{{repo_python}}}"; FULLMAG_TASK5_ENERGY_QUALIFICATION=dg0_ms FULLMAG_MATRIX_PYTHON="$matrix_python" "$matrix_python" scripts/verify_fem_preview_surface_matrix.py --api-port 18211 --repeats 1 --mode full_cache --cadence 10 --surface interactive_no_browser --skip-retention-proof --report-dir .fullmag/reports/fem-preview-energy-qualification/dg0-ms
    matrix_python="${FULLMAG_MATRIX_PYTHON:-{{repo_python}}}"; FULLMAG_TASK5_ENERGY_QUALIFICATION=uniaxial FULLMAG_MATRIX_PYTHON="$matrix_python" "$matrix_python" scripts/verify_fem_preview_surface_matrix.py --api-port 18212 --repeats 1 --mode full_cache --cadence 10 --surface interactive_no_browser --skip-retention-proof --report-dir .fullmag/reports/fem-preview-energy-qualification/uniaxial
    matrix_python="${FULLMAG_MATRIX_PYTHON:-{{repo_python}}}"; FULLMAG_TASK5_ENERGY_QUALIFICATION=cubic FULLMAG_MATRIX_PYTHON="$matrix_python" "$matrix_python" scripts/verify_fem_preview_surface_matrix.py --api-port 18213 --repeats 1 --mode full_cache --cadence 10 --surface interactive_no_browser --skip-retention-proof --report-dir .fullmag/reports/fem-preview-energy-qualification/cubic
    matrix_python="${FULLMAG_MATRIX_PYTHON:-{{repo_python}}}"; FULLMAG_TASK5_ENERGY_QUALIFICATION=interfacial_dmi FULLMAG_MATRIX_PYTHON="$matrix_python" "$matrix_python" scripts/verify_fem_preview_surface_matrix.py --api-port 18214 --repeats 1 --mode full_cache --cadence 10 --surface interactive_no_browser --skip-retention-proof --report-dir .fullmag/reports/fem-preview-energy-qualification/interfacial-dmi
    matrix_python="${FULLMAG_MATRIX_PYTHON:-{{repo_python}}}"; FULLMAG_TASK5_ENERGY_QUALIFICATION=bulk_dmi FULLMAG_MATRIX_PYTHON="$matrix_python" "$matrix_python" scripts/verify_fem_preview_surface_matrix.py --api-port 18215 --repeats 1 --mode full_cache --cadence 10 --surface interactive_no_browser --skip-retention-proof --report-dir .fullmag/reports/fem-preview-energy-qualification/bulk-dmi

verify-fem-preview-json-roundtrip-contract:
    docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc 'FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-api terminal_preview_json_transport_preserves_f64_bits -- --nocapture'

verify-fem-mixed-wire-cli-contract:
    docker compose --project-name fullmag --profile fem-gpu run --rm --no-deps fem-gpu bash -lc 'cd /workspace && FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-cli --features "cuda fem-gpu" python_bridge::tests::mixed_wire_ -- --nocapture'

verify-fem-preparation-clock-contract:
    docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc 'FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-cli simulation_preparation::tests::backward_wall_clock_adjustment_preserves_raw_time_and_monotonic_ordering -- --exact --nocapture'

verify-fem-preparation-api-contract:
    docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc 'FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-api router_v2::tests::simulation_preparation_preserves_backward_clock_adjustment_evidence -- --exact --nocapture'

verify-fem-preview-callback-source-contract:
    docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc 'FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-runner --features fem-gpu tests::fem_preview_materialization_stays_outside_callback_deadline -- --exact --nocapture'

verify-fem-crossover-selection-persistence-contract:
    docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc 'set -e; cd /workspace; export FULLMAG_USE_MFEM_STACK=ON; cargo +nightly test -p fullmag-runner --features fem-gpu solver_runtime::fem_selection::tests::retained_resolver_uses_the_canonical_effective_request_collision_matrix -- --exact --nocapture; cargo +nightly test -p fullmag-runner --features fem-gpu interactive_runtime::tests::persistent_fem_runtime_keeps_resolved_crossover_after_profile_mutation_and_removal -- --exact --nocapture; cargo +nightly test -p fullmag-runner --features fem-gpu --test backend_source_layout_contract task15_crossover_capability_json_and_adr_match_the_ignored_identity_input_boundary -- --exact --nocapture'

verify-fem-preview-review-unit-contract:
    docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc 'set -e; export FULLMAG_USE_MFEM_STACK=ON; cargo +nightly test -p fullmag-api session::tests::terminal_preview_json_transport_preserves_f64_bits -- --exact --nocapture; cargo +nightly test -p fullmag-cli orchestrator::tests::wait_for_solve_command_classification_handles_compute_fields_and_run -- --exact --nocapture; cargo +nightly test -p fullmag-cli simulation_preparation::tests::backward_wall_clock_adjustment_preserves_raw_time_and_monotonic_ordering -- --exact --nocapture; cargo +nightly test -p fullmag-api router_v2::tests::simulation_preparation_preserves_backward_clock_adjustment_evidence -- --exact --nocapture; cargo +nightly test -p fullmag-api router_v2::tests::v2_energy_density_meta_exposes_fem_nodal_projection_location -- --exact --nocapture; cargo +nightly test -p fullmag-api router_v2::tests::v2_optional_field_materialization_pending_and_error_preserve_solver_and_last_good_data -- --exact --nocapture; cargo +nightly test -p fullmag-plan tests::fem_cpu_exchange_and_zeeman_plan_preserves_conformal_dg0_ms -- --exact --nocapture; cargo +nightly test -p fullmag-plan tests::fem_planner_elementwise_material_legality_distinguishes_a_from_ms -- --exact --nocapture; cargo +nightly test -p fullmag-api snapshot_terminal_cache_wins_equal_provenance_conflict_with_active_preview -- --nocapture; cargo +nightly test -p fullmag-api field_frame_terminal_cache_wins_equal_provenance_conflict_with_runtime_preview -- --nocapture; cargo +nightly test -p fullmag-api effective_field_source_tracks_shared_latest_preview_precedence_without_revision_churn -- --nocapture; cargo +nightly test -p fullmag-api field_frame_terminal_cache_wins_equal_generation_in_vector_route_body -- --nocapture; cargo +nightly test -p fullmag-api cached_preview_merge_is_idempotent_and_accepts_only_newer_generation -- --nocapture; cargo +nightly test -p fullmag-cli merge_pending_publish_payload_canonicalizes_carried_active_from_terminal_cache -- --nocapture; cargo +nightly test -p fullmag-runner --features fem-gpu tests::fem_preview_materialization_stays_outside_callback_deadline -- --exact --nocapture; cargo +nightly test -p fullmag-runner --features fem-gpu task5_ -- --nocapture'

verify-fem-relaxation-convergence:
    FULLMAG_RELAX_MAX_STEPS="${FULLMAG_RELAX_MAX_STEPS:-16}" \
    FULLMAG_FEM_RELAXATION_MIN_STEPS="${FULLMAG_FEM_RELAXATION_MIN_STEPS:-16}" \
    FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE="${FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE:-1e-2}" \
    FULLMAG_FEM_RELAXATION_MAX_FINAL_TORQUE_GROWTH_FACTOR="${FULLMAG_FEM_RELAXATION_MAX_FINAL_TORQUE_GROWTH_FACTOR:-1.25}" \
    bash scripts/verify_fem_relaxation_runtime.sh

verify-fem-periodic-antidot-relaxation-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/fem-periodic-antidot-relaxation-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-periodic-antidot-relaxation-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/fem-periodic-antidot-relaxation-runtime
    mkdir -p .fullmag/reports/fem-periodic-antidot-relaxation-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_PBC_RELAX_MIN_STEPS="${FULLMAG_PBC_RELAX_MIN_STEPS:-4}" \
      -e FULLMAG_PBC_RELAX_Z_PADDING_REPORT="${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}" \
      -e FULLMAG_PBC_RELAX_SUPERCELL_REPORT="${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}" \
      -e FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT="${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'set -euo pipefail && cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-periodic-antidot-relaxation-runtime 2>/dev/null || true'\'' EXIT && \
        for scenario_script in \
          exchange_coupled:examples/fem_periodic_antidot_relax_exchange_coupled.py \
          air_gap:examples/fem_periodic_antidot_relax_air_gap.py; do \
          scenario="${scenario_script%%:*}" && \
          script="${scenario_script#*:}" && \
          rm -rf ".fullmag/reports/fem-periodic-antidot-relaxation-runtime/$scenario/artifacts" && \
          mkdir -p ".fullmag/reports/fem-periodic-antidot-relaxation-runtime/$scenario" && \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
            "$script" \
            --backend fem \
            --headless \
            --json \
            --output-dir ".fullmag/reports/fem-periodic-antidot-relaxation-runtime/$scenario/artifacts" \
            2>&1 | tee ".fullmag/reports/fem-periodic-antidot-relaxation-runtime/$scenario/runtime.log"; \
          validation_args=( \
            ".fullmag/reports/fem-periodic-antidot-relaxation-runtime/$scenario/runtime.log" \
            --scenario "$scenario" \
            --engine cpu \
            --algorithm projected_gradient_bb \
            --min-steps "${FULLMAG_PBC_RELAX_MIN_STEPS:-4}" \
          ); \
          if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}" ]; then \
            validation_args+=(--require-z-padding-report "$FULLMAG_PBC_RELAX_Z_PADDING_REPORT"); \
          fi; \
          if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}" ]; then \
            validation_args+=(--require-supercell-report "$FULLMAG_PBC_RELAX_SUPERCELL_REPORT"); \
          fi; \
          if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}" ]; then \
            validation_args+=(--require-repeated-state-supercell-report "$FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT"); \
          fi; \
          python3 scripts/validate_fem_periodic_antidot_relaxation_artifacts.py "${validation_args[@]}"; \
        done'

verify-fem-periodic-antidot-relaxation-gpu-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime
    mkdir -p .fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_FEM_MFEM_DEVICE=cuda \
      -e FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_PBC_RELAX_MIN_STEPS="${FULLMAG_PBC_RELAX_MIN_STEPS:-4}" \
      -e FULLMAG_PBC_RELAX_Z_PADDING_REPORT="${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}" \
      -e FULLMAG_PBC_RELAX_SUPERCELL_REPORT="${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}" \
      -e FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT="${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'set -euo pipefail && cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime 2>/dev/null || true'\'' EXIT && \
        for scenario_script in \
          exchange_coupled:examples/fem_periodic_antidot_relax_exchange_coupled.py \
          air_gap:examples/fem_periodic_antidot_relax_air_gap.py; do \
          scenario="${scenario_script%%:*}" && \
          script="${scenario_script#*:}" && \
          rm -rf ".fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime/$scenario/artifacts" && \
          mkdir -p ".fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime/$scenario" && \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
            "$script" \
            --backend fem \
            --headless \
            --json \
            --output-dir ".fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime/$scenario/artifacts" \
            2>&1 | tee ".fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime/$scenario/runtime.log"; \
          validation_args=( \
            ".fullmag/reports/fem-periodic-antidot-relaxation-gpu-runtime/$scenario/runtime.log" \
            --scenario "$scenario" \
            --engine gpu \
            --algorithm projected_gradient_bb \
            --min-steps "${FULLMAG_PBC_RELAX_MIN_STEPS:-4}" \
          ); \
          if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}" ]; then \
            validation_args+=(--require-z-padding-report "$FULLMAG_PBC_RELAX_Z_PADDING_REPORT"); \
          fi; \
          if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}" ]; then \
            validation_args+=(--require-supercell-report "$FULLMAG_PBC_RELAX_SUPERCELL_REPORT"); \
          fi; \
          if [ "$scenario" = exchange_coupled ] && [ -n "${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}" ]; then \
            validation_args+=(--require-repeated-state-supercell-report "$FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT"); \
          fi; \
          python3 scripts/validate_fem_periodic_antidot_relaxation_artifacts.py "${validation_args[@]}"; \
        done'

verify-fem-static-pbc-demag-uniform-slab-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime
    mkdir -p .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'set -euo pipefail && cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime 2>/dev/null || true'\'' EXIT && \
        mkdir -p .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/cpu && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_periodic_uniform_slab_relax_exchange_coupled.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/cpu/artifacts \
          2>&1 | tee .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/cpu/runtime.log'
    python3 scripts/validate_fem_periodic_antidot_relaxation_artifacts.py .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/cpu/runtime.log --scenario uniform_slab --engine cpu --algorithm projected_gradient_bb --min-steps "${FULLMAG_PBC_RELAX_MIN_STEPS:-4}"
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=gpu \
      -e FULLMAG_RELAX_DEVICE=gpu \
      -e FULLMAG_FEM_MFEM_DEVICE=cuda \
      -e FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'set -euo pipefail && cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime 2>/dev/null || true'\'' EXIT && \
        mkdir -p .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/gpu && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_periodic_uniform_slab_relax_exchange_coupled.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/gpu/artifacts \
          2>&1 | tee .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/gpu/runtime.log'
    python3 scripts/validate_fem_periodic_antidot_relaxation_artifacts.py .fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime/gpu/runtime.log --scenario uniform_slab --engine gpu --algorithm projected_gradient_bb --min-steps "${FULLMAG_PBC_RELAX_MIN_STEPS:-4}"

verify-fem-static-pbc-demag-equilibrium-runtime:
    test -n "${FULLMAG_PBC_RELAX_Z_PADDING_REPORT:-}" || (echo "FULLMAG_PBC_RELAX_Z_PADDING_REPORT must point to fem_static_pbc_z_padding_validation.v1 before strict M5 equilibrium verification" >&2; exit 2)
    if [ -z "${FULLMAG_PBC_RELAX_SUPERCELL_REPORT:-}" ] && [ -z "${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}" ]; then echo "FULLMAG_PBC_RELAX_SUPERCELL_REPORT or FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT must point to fem_static_pbc_supercell_validation.v1 before strict M5 equilibrium verification" >&2; exit 2; fi
    if [ -n "${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT:-}" ]; then test -f "${FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT}" || (echo "FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT must point to an existing repeated-state fem_static_pbc_supercell_validation.v1 report" >&2; exit 2); fi
    just verify-fem-periodic-antidot-relaxation-runtime
    just verify-fem-periodic-antidot-relaxation-gpu-runtime

verify-fem-static-pbc-demag-equilibrium-repeated-state-runtime:
    just verify-fem-static-pbc-demag-uniform-slab-runtime
    just verify-fem-static-pbc-demag-z-padding-runtime
    just prepare-fem-static-pbc-demag-supercell-runtime-artifacts
    just write-fem-static-pbc-demag-supercell-central-cell-artifact-auto .fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/artifacts 3 3
    just write-fem-static-pbc-demag-supercell-diagnostic-report .fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/artifacts .fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/artifacts 3 3 .fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json
    just verify-fem-static-pbc-demag-supercell-repeated-state-runtime-from-prepared
    FULLMAG_PBC_RELAX_Z_PADDING_REPORT=.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT=.fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_validation.v1.json just verify-fem-static-pbc-demag-equilibrium-runtime

verify-fem-static-pbc-demag-z-padding-runtime:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/fem-static-pbc-demag-z-padding-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-static-pbc-demag-z-padding-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/fem-static-pbc-demag-z-padding-runtime
    mkdir -p .fullmag/reports/fem-static-pbc-demag-z-padding-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'set -euo pipefail && cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-static-pbc-demag-z-padding-runtime 2>/dev/null || true'\'' EXIT && \
        for run_script in \
          candidate:examples/fem_periodic_antidot_relax_exchange_coupled.py \
          reference:examples/fem_periodic_antidot_relax_exchange_coupled_z_padding_reference.py; do \
          run_name="${run_script%%:*}" && \
          script="${run_script#*:}" && \
          rm -rf ".fullmag/reports/fem-static-pbc-demag-z-padding-runtime/$run_name/artifacts" && \
          mkdir -p ".fullmag/reports/fem-static-pbc-demag-z-padding-runtime/$run_name" && \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
            "$script" \
            --backend fem \
            --headless \
            --json \
            --output-dir ".fullmag/reports/fem-static-pbc-demag-z-padding-runtime/$run_name/artifacts" \
            2>&1 | tee ".fullmag/reports/fem-static-pbc-demag-z-padding-runtime/$run_name/runtime.log"; \
        done'
    just verify-fem-static-pbc-demag-z-padding-artifacts .fullmag/reports/fem-static-pbc-demag-z-padding-runtime/reference/artifacts .fullmag/reports/fem-static-pbc-demag-z-padding-runtime/candidate/artifacts .fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json

prepare-fem-static-pbc-demag-supercell-runtime-artifacts:
    just ensure-managed-fem-runtime
    if [ -d .fullmag/reports/fem-static-pbc-demag-supercell-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-static-pbc-demag-supercell-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/fem-static-pbc-demag-supercell-runtime
    mkdir -p .fullmag/reports/fem-static-pbc-demag-supercell-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'set -euo pipefail && cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-static-pbc-demag-supercell-runtime 2>/dev/null || true'\'' EXIT && \
        for run_script in \
          unit:examples/fem_periodic_antidot_relax_exchange_coupled.py \
          supercell:examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py; do \
          run_name="${run_script%%:*}" && \
          script="${run_script#*:}" && \
          rm -rf ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/$run_name/artifacts" && \
          mkdir -p ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/$run_name" && \
          .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
            "$script" \
            --backend fem \
            --headless \
            --json \
            --output-dir ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/$run_name/artifacts" \
            2>&1 | tee ".fullmag/reports/fem-static-pbc-demag-supercell-runtime/$run_name/runtime.log"; \
        done'
    test -d .fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/artifacts
    test -d .fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/artifacts
    python3 scripts/validate_fem_periodic_antidot_relaxation_artifacts.py .fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/runtime.log --scenario exchange_coupled --engine cpu --algorithm projected_gradient_bb --min-steps "${FULLMAG_PBC_RELAX_MIN_STEPS:-4}"
    python3 scripts/validate_fem_periodic_antidot_relaxation_artifacts.py .fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/runtime.log --scenario exchange_coupled --engine cpu --algorithm projected_gradient_bb --min-steps "${FULLMAG_PBC_RELAX_MIN_STEPS:-4}" --supercell-repeat 3 3

verify-fem-static-pbc-demag-supercell-runtime:
    just prepare-fem-static-pbc-demag-supercell-runtime-artifacts
    just write-fem-static-pbc-demag-supercell-central-cell-artifact-auto .fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/artifacts 3 3
    just verify-fem-static-pbc-demag-supercell-artifacts .fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/artifacts .fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/artifacts 3 3 .fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json

verify-fem-static-pbc-demag-supercell-repeated-state-runtime:
    just prepare-fem-static-pbc-demag-supercell-runtime-artifacts
    just verify-fem-static-pbc-demag-supercell-repeated-state-runtime-from-prepared

verify-fem-static-pbc-demag-supercell-repeated-state-runtime-from-prepared:
    just write-fem-static-pbc-demag-repeated-unit-initial-state .fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/artifacts .fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/artifacts 3 3 .fullmag/reports/fem-static-pbc-demag-supercell-runtime/states/m_repeated_unit.json .fullmag/reports/fem-static-pbc-demag-supercell-runtime/states/m_repeated_unit.report.json "${FULLMAG_PBC_RELAX_REPEATED_STATE_MAX_NEAREST_DISTANCE_M:-1e-12}" linear_tetrahedral_interpolation
    if [ -d .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime ]; then docker compose --profile fem-gpu run --rm -e FULLMAG_HOST_UID="$(id -u)" -e FULLMAG_HOST_GID="$(id -g)" fem-gpu bash -lc 'cd /workspace && chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime 2>/dev/null || true'; fi
    rm -rf .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime
    mkdir -p .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION=cpu \
      -e FULLMAG_RELAX_DEVICE=cpu \
      -e FULLMAG_CPU_THREADS="${FULLMAG_CPU_THREADS:-auto}" \
      -e FULLMAG_GMSH_THREADS="${FULLMAG_PBC_RELAX_GMSH_THREADS:-1}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'set -euo pipefail && cd /workspace && \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime 2>/dev/null || true'\'' EXIT && \
        mkdir -p .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/supercell && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py \
          --backend fem \
          --headless \
          --json \
          --initial-magnetization-state .fullmag/reports/fem-static-pbc-demag-supercell-runtime/states/m_repeated_unit.json \
          --output-dir .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/supercell/artifacts \
          2>&1 | tee .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/supercell/runtime.log'
    python3 scripts/validate_fem_periodic_antidot_relaxation_artifacts.py .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/supercell/runtime.log --scenario exchange_coupled --engine cpu --algorithm projected_gradient_bb --min-steps "${FULLMAG_PBC_RELAX_MIN_STEPS:-4}" --supercell-repeat 3 3 --require-initial-magnetization-state-override
    just write-fem-static-pbc-demag-supercell-central-cell-artifact-auto .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/supercell/artifacts 3 3
    just write-fem-static-pbc-demag-supercell-repeated-state-initial-operator-diagnostic-report .fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/artifacts .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/supercell/artifacts 3 3 .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_interpolated_initial_operator_validation.v1.json
    just verify-fem-static-pbc-demag-supercell-interpolated-artifacts .fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/artifacts .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/supercell/artifacts 3 3 .fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_validation.v1.json

verify-fem-static-pbc-demag-z-padding-artifacts reference candidate report=".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json":
    python3 scripts/compare_fem_static_pbc_equilibrium_artifacts.py z-padding --reference "{{reference}}" --candidate "{{candidate}}" --report "{{report}}"

verify-fem-static-pbc-demag-supercell-artifacts unit_cell supercell repeat_x repeat_y report=".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json":
    python3 scripts/compare_fem_static_pbc_equilibrium_artifacts.py supercell --unit-cell "{{unit_cell}}" --supercell "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --report "{{report}}"

verify-fem-static-pbc-demag-supercell-initial-state-artifacts unit_cell supercell repeat_x repeat_y report=".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_initial_state_validation.v1.json":
    python3 scripts/compare_fem_static_pbc_equilibrium_artifacts.py supercell --unit-cell "{{unit_cell}}" --supercell "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --state initial --report "{{report}}"

write-fem-static-pbc-demag-supercell-diagnostic-report unit_cell supercell repeat_x repeat_y report=".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json":
    python3 scripts/compare_fem_static_pbc_equilibrium_artifacts.py --allow-failed-status supercell --unit-cell "{{unit_cell}}" --supercell "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --report "{{report}}"

write-fem-static-pbc-demag-supercell-interpolated-diagnostic-report unit_cell supercell repeat_x repeat_y report=".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_interpolated_validation.v1.json":
    python3 scripts/compare_fem_static_pbc_equilibrium_artifacts.py --allow-failed-status supercell --unit-cell "{{unit_cell}}" --supercell "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --include-interpolated-comparison --report "{{report}}"

verify-fem-static-pbc-demag-supercell-interpolated-artifacts unit_cell supercell repeat_x repeat_y report=".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_interpolated_validation.v1.json":
    python3 scripts/compare_fem_static_pbc_equilibrium_artifacts.py supercell --unit-cell "{{unit_cell}}" --supercell "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --accept-interpolated-comparison --report "{{report}}"

verify-fem-static-pbc-demag-supercell-repeated-state-initial-operator-artifacts unit_cell supercell repeat_x repeat_y report=".fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_interpolated_initial_operator_validation.v1.json":
    python3 scripts/compare_fem_static_pbc_equilibrium_artifacts.py supercell --unit-cell "{{unit_cell}}" --supercell "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --unit-state final --supercell-state initial --accept-interpolated-comparison --report "{{report}}"

write-fem-static-pbc-demag-supercell-repeated-state-initial-operator-diagnostic-report unit_cell supercell repeat_x repeat_y report=".fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_interpolated_initial_operator_validation.v1.json":
    python3 scripts/compare_fem_static_pbc_equilibrium_artifacts.py --allow-failed-status supercell --unit-cell "{{unit_cell}}" --supercell "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --unit-state final --supercell-state initial --accept-interpolated-comparison --report "{{report}}"

write-fem-static-pbc-demag-repeated-unit-initial-state unit_cell supercell repeat_x repeat_y output=".fullmag/reports/fem-static-pbc-demag-supercell-runtime/states/m_repeated_unit.json" report=".fullmag/reports/fem-static-pbc-demag-supercell-runtime/states/m_repeated_unit.report.json" max_nearest_distance_m="1e-12" mapping_mode="nearest":
    python3 scripts/write_fem_static_pbc_repeated_unit_initial_state.py --unit-cell "{{unit_cell}}" --supercell "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --output "{{output}}" --report "{{report}}" --max-nearest-distance-m "{{max_nearest_distance_m}}" --mapping-mode "{{mapping_mode}}"

write-fem-static-pbc-demag-tiled-supercell-fixture unit_cell output repeat_x repeat_y:
    python3 scripts/write_fem_static_pbc_tiled_supercell_artifact.py --unit-cell "{{unit_cell}}" --output "{{output}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}"

verify-fem-static-pbc-demag-tiled-supercell-fixture unit_cell output repeat_x repeat_y report=".fullmag/reports/fem-static-pbc-demag-tiled-supercell-fixture/reports/supercell_validation.v1.json":
    just write-fem-static-pbc-demag-tiled-supercell-fixture "{{unit_cell}}" "{{output}}" "{{repeat_x}}" "{{repeat_y}}"
    just verify-fem-static-pbc-demag-supercell-artifacts "{{unit_cell}}" "{{output}}" "{{repeat_x}}" "{{repeat_y}}" "{{report}}"
    just verify-fem-static-pbc-demag-supercell-initial-state-artifacts "{{unit_cell}}" "{{output}}" "{{repeat_x}}" "{{repeat_y}}" ".fullmag/reports/fem-static-pbc-demag-tiled-supercell-fixture/reports/supercell_initial_state_validation.v1.json"

write-fem-static-pbc-demag-supercell-central-cell-artifact supercell repeat_x repeat_y magnetic_node_indices field_cell_indices central_cell_demag_energy_j central_cell_torque_apm:
    python3 scripts/write_fem_static_pbc_supercell_central_cell_artifact.py "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --magnetic-node-indices "{{magnetic_node_indices}}" --field-cell-indices "{{field_cell_indices}}" --central-cell-demag-energy-j "{{central_cell_demag_energy_j}}" --central-cell-torque-apm "{{central_cell_torque_apm}}"

write-fem-static-pbc-demag-supercell-central-cell-artifact-auto supercell repeat_x repeat_y:
    python3 scripts/write_fem_static_pbc_supercell_central_cell_artifact.py "{{supercell}}" --repeat-x "{{repeat_x}}" --repeat-y "{{repeat_y}}" --auto-central-cell-indices --auto-central-cell-scalars

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

verify-fem-relaxation-consistency-semantics:
    docker compose --profile fem-gpu run --rm --no-deps \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      fem-gpu bash -lc 'set -euo pipefail; cd /workspace; python3 scripts/verify_fem_relaxation_consistency_semantics.py'

# Same-tolerance direct-minimizer qualification.  The source semantics and
# synthetic contract run before the managed gate; missing immutable v2 mesh
# assets or an unavailable managed runtime fail closed rather than producing a
# coverage-only claim.
verify-fem-relaxation-equilibrium-parity:
    PYTHONDONTWRITEBYTECODE=1 python3 scripts/verify_fem_relaxation_equilibrium_parity_semantics.py
    TMPDIR=/tmp/fullmag-fem-t4-test-tmp PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q scripts/test_validate_fem_relaxation_equilibrium_parity.py --capture=sys
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports/fem-relaxation-equilibrium-parity
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
      test -x "$runtime_root/bin/fullmag-fem-gpu"; \
      test -f "$runtime_root/manifest.json"; \
      scope="${FULLMAG_EQUILIBRIUM_SCOPE:-coarse,medium,fine}"; \
      repeat="${FULLMAG_EQUILIBRIUM_REPEAT:-5}"; \
      timeout="${FULLMAG_EQUILIBRIUM_CASE_TIMEOUT_S:-3600}"; \
      case "$scope" in coarse|coarse,medium,fine) ;; *) echo "FULLMAG_EQUILIBRIUM_SCOPE must be coarse or coarse,medium,fine" >&2; exit 2 ;; esac; \
      case "$repeat" in ''|*[!0-9]*) echo "FULLMAG_EQUILIBRIUM_REPEAT must be a positive integer" >&2; exit 2 ;; esac; \
      test "$repeat" -ge 1; \
      docker compose --profile fem-gpu run --rm \
        -v "$runtime_root:/workspace/.fullmag/runtime:ro" \
        -e PYTHONPATH=/workspace/packages/fullmag-py/src \
        -e FULLMAG_PYTHON=/usr/bin/python3 \
        -e FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime \
        -e FULLMAG_FEM_DIRECT_MINIMIZER_DIRECTION_POLICY=raw_tangent_gradient \
        -e FULLMAG_GMSH_THREADS=1 \
        fem-gpu bash -lc 'cd /workspace && \
          python3 scripts/analysis/fem_gpu_benchmark.py \
            --equilibrium-suite examples/assets/fem_performance/equilibrium_qualification_suite_v1.json \
            --meshes '"$scope"' \
            --scenarios box500_airbox_exchange_only,box500_airbox_exchange_demag \
            --relax-algorithms projected_gradient_bb,nonlinear_cg \
            --backends cpu,gpu \
            --demag-solver CG \
            --demag-preconditioner AMG \
            --demag-rtol 1e-12 \
            --demag-amg-relax-types 6 \
            --demag-amg-coarsenings 8 \
            --demag-amg-interpolations 6 \
            --demag-amg-aggressive-coarsenings 1 \
            --relax-torque-tolerance-apm 8000 \
            --steps 50000 \
            --repeat '"$repeat"' \
            --case-timeout-s '"$timeout"' \
            --gpu-warmup \
            --capture-final-magnetization \
            --require-stable-solver-mesh \
            --require-equilibrium-parity \
            --equilibrium-parity-output .fullmag/reports/fem-relaxation-equilibrium-parity/summary.json \
            --output .fullmag/reports/fem-relaxation-equilibrium-parity/rows.csv \
            --cpu-gpu-summary-output .fullmag/reports/fem-relaxation-equilibrium-parity/benchmark-summary.json \
            --quiet-json-summary'; \
      python3 scripts/validate_fem_relaxation_equilibrium_parity.py \
        .fullmag/reports/fem-relaxation-equilibrium-parity/rows.csv \
        --output .fullmag/reports/fem-relaxation-equilibrium-parity/summary-revalidated.json \
        --require-equilibrium-parity \
        --equilibrium-suite examples/assets/fem_performance/equilibrium_qualification_suite_v1.json \
        --scope "$scope" \
        --expected-repeat-count "$repeat"

capture-fem-task8-qualification-identity:
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports/task8-qualification
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_BENCH_DOMAIN_HMAX="${FULLMAG_BENCH_DOMAIN_HMAX:-250e-9}" \
      -e FULLMAG_BENCH_AIRBOX_HMAX="${FULLMAG_BENCH_AIRBOX_HMAX:-500e-9}" \
      -e FULLMAG_BENCH_INTEGRATORS="${FULLMAG_BENCH_INTEGRATORS:-heun}" \
      -e FULLMAG_BENCH_RELAX_ALGORITHMS="${FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg}" \
      -e FULLMAG_BENCH_DEMAG_SOLVERS="${FULLMAG_BENCH_DEMAG_SOLVERS:-CG}" \
      -e FULLMAG_BENCH_DEMAG_PRECONDITIONERS="${FULLMAG_BENCH_DEMAG_PRECONDITIONERS:-AMG,JACOBI}" \
      -e FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES="${FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES:-18}" \
      -e FULLMAG_BENCH_DEMAG_AMG_COARSENINGS="${FULLMAG_BENCH_DEMAG_AMG_COARSENINGS:-8}" \
      -e FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS="${FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS:-6}" \
      -e FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS="${FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS:-1}" \
      -e FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS="${FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS:-}" \
      -e FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS="${FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS:-}" \
      -e FULLMAG_BENCH_STEPS="${FULLMAG_BENCH_STEPS:-32}" \
      -e FULLMAG_BENCH_REPEAT="${FULLMAG_BENCH_REPEAT:-5}" \
      -e FULLMAG_BENCH_THREAD_COUNTS="${FULLMAG_BENCH_THREAD_COUNTS:-1}" \
      -e FULLMAG_BENCH_CASE_TIMEOUT_S="${FULLMAG_BENCH_CASE_TIMEOUT_S:-600}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-30}" \
      -e FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_TASK8_QUALIFICATION_CANDIDATE="${FULLMAG_BENCH_TASK8_QUALIFICATION_CANDIDATE:-.fullmag/reports/task8-qualification/candidate-identity.json}" \
      -e FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR="${FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR:-.fullmag/reports/task8-qualification/mesh-cache}" \
      fem-gpu bash -lc 'cd /workspace && \
        python3 scripts/analysis/fem_gpu_benchmark.py \
        --box500-airbox-interaction-consistency-preset \
        --integrators "$FULLMAG_BENCH_INTEGRATORS" \
        --relax-algorithms "$FULLMAG_BENCH_RELAX_ALGORITHMS" \
        --demag-solvers "$FULLMAG_BENCH_DEMAG_SOLVERS" \
        --demag-preconditioners "$FULLMAG_BENCH_DEMAG_PRECONDITIONERS" \
        --demag-amg-relax-types "$FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES" \
        --demag-amg-coarsenings "$FULLMAG_BENCH_DEMAG_AMG_COARSENINGS" \
        --demag-amg-interpolations "$FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS" \
        --demag-amg-aggressive-coarsenings "$FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS" \
        --demag-amg-strength-thresholds "$FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS" \
        --demag-amg-max-levels "$FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS" \
        --steps "$FULLMAG_BENCH_STEPS" \
        --repeat "$FULLMAG_BENCH_REPEAT" \
        --thread-counts "$FULLMAG_BENCH_THREAD_COUNTS" \
        --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
        --cpu-gpu-energy-rtol "$FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL" \
        --cpu-gpu-energy-atol "$FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J" \
        --cpu-gpu-torque-rtol "$FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL" \
        --reuse-generated-domain-mesh \
        --generated-domain-mesh-cache-dir "$FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR" \
        --write-task8-qualification-identity "$FULLMAG_BENCH_TASK8_QUALIFICATION_CANDIDATE"'

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
      -e FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS="${FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS:-100}" \
      -e FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES="${FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES:-18}" \
      -e FULLMAG_BENCH_DEMAG_AMG_COARSENINGS="${FULLMAG_BENCH_DEMAG_AMG_COARSENINGS:-8}" \
      -e FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS="${FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS:-6}" \
      -e FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS="${FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS:-1}" \
      -e FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS="${FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS:-}" \
      -e FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS="${FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS:-}" \
      -e FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC="${FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC:-demag_solver_apply_wall_time_ms}" \
      -e FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS="${FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS:-}" \
      -e FULLMAG_BENCH_STEPS="${FULLMAG_BENCH_STEPS:-32}" \
      -e FULLMAG_BENCH_REPEAT="${FULLMAG_BENCH_REPEAT:-5}" \
      -e FULLMAG_BENCH_THREAD_COUNTS="${FULLMAG_BENCH_THREAD_COUNTS:-1}" \
      -e FULLMAG_BENCH_CASE_TIMEOUT_S="${FULLMAG_BENCH_CASE_TIMEOUT_S:-600}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-30}" \
      -e FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP:-3}" \
      -e FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP:-0}" \
      -e FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP:-4}" \
      -e FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP:-3}" \
      -e FULLMAG_BENCH_MIN_SOLVER_NODES="${FULLMAG_BENCH_MIN_SOLVER_NODES:-50}" \
      -e FULLMAG_BENCH_OUTPUT="${FULLMAG_BENCH_OUTPUT:-.fullmag/reports/fullmag_relaxation_production_benchmark.csv}" \
      -e FULLMAG_BENCH_SUMMARY="${FULLMAG_BENCH_SUMMARY:-.fullmag/reports/fullmag_relaxation_production_benchmark_summary.json}" \
      -e FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY="${FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY:-}" \
      -e FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR="${FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR:-.fullmag/reports/task8-qualification/mesh-cache}" \
      -e FULLMAG_FEM_STEP_PROFILE="${FULLMAG_FEM_STEP_PROFILE:-}" \
      -e FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC="${FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC:-1}" \
      fem-gpu bash -lc 'cd /workspace && \
        demag_budget_args=(); \
        cache_args=(); \
        identity_args=(); \
        if [ -n "$FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS" ]; then demag_budget_args+=(--max-demag-solver-apply-ms "$FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS"); fi; \
        if [ -n "$FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR" ]; then cache_args+=(--generated-domain-mesh-cache-dir "$FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR"); fi; \
        if [ -n "$FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY" ]; then identity_args+=(--task8-qualification-identity "$FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY"); fi; \
        python3 scripts/analysis/fem_gpu_benchmark.py \
        --box500-airbox-interaction-consistency-preset \
        --integrators "$FULLMAG_BENCH_INTEGRATORS" \
        --relax-algorithms "$FULLMAG_BENCH_RELAX_ALGORITHMS" \
        --demag-solvers "$FULLMAG_BENCH_DEMAG_SOLVERS" \
        --demag-preconditioners "$FULLMAG_BENCH_DEMAG_PRECONDITIONERS" \
        --demag-amg-relax-types "$FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES" \
        --demag-amg-coarsenings "$FULLMAG_BENCH_DEMAG_AMG_COARSENINGS" \
        --demag-amg-interpolations "$FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS" \
        --demag-amg-aggressive-coarsenings "$FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS" \
        --demag-amg-strength-thresholds "$FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS" \
        --demag-amg-max-levels "$FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS" \
        --demag-convergence-max-iterations "$FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS" \
        --require-demag-setup-reused \
        --require-ncg-accepted-endpoint-reuse \
        --require-demag-single-setup \
        --require-zero-strict-gpu-global-sync \
        --steps "$FULLMAG_BENCH_STEPS" \
        --repeat "$FULLMAG_BENCH_REPEAT" \
        --thread-counts "$FULLMAG_BENCH_THREAD_COUNTS" \
        --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
        --cpu-gpu-energy-rtol "$FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL" \
        --cpu-gpu-energy-atol "$FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J" \
        --cpu-gpu-torque-rtol "$FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL" \
        --output "$FULLMAG_BENCH_OUTPUT" \
        --cpu-gpu-summary-output "$FULLMAG_BENCH_SUMMARY" \
        "${identity_args[@]}" \
        --quiet-json-summary \
        --reuse-generated-domain-mesh \
        "${cache_args[@]}" \
        --require-adaptive-gpu-rk-acceptance \
        --emit-best-demag-policy \
        --best-demag-policy-metric "$FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC" \
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
        --require-gpu-strict-residency \
        "${demag_budget_args[@]}"'
    # FEM-TD-PHY-STT-001: keep the production benchmark extended with the
    # versioned Zhang-Li CPU/GPU skew-tetra gate.  Its validator owns the STT
    # oracle and provenance; the relaxation benchmark above remains unchanged.
    just verify-fem-zhang-li-skew-tetra-runtime

calibrate-fem-relaxation-torque-default:
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports/fem-relaxation-torque-calibration/mesh-cache
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_CALIBRATION_STEP_BUDGETS="${FULLMAG_CALIBRATION_STEP_BUDGETS:-128 256 512}" \
      -e FULLMAG_CALIBRATION_INTEGRATORS="${FULLMAG_CALIBRATION_INTEGRATORS:-rk23,rk45}" \
      -e FULLMAG_CALIBRATION_SCENARIOS="${FULLMAG_CALIBRATION_SCENARIOS:-relax_exchange_only,relax_exchange_demag}" \
      -e FULLMAG_CALIBRATION_TIMESTEP_POLICIES="${FULLMAG_CALIBRATION_TIMESTEP_POLICIES:-fixed,adaptive}" \
      -e FULLMAG_CALIBRATION_BACKENDS="${FULLMAG_CALIBRATION_BACKENDS:-cpu,gpu}" \
      -e FULLMAG_CALIBRATION_THREAD_COUNTS="${FULLMAG_CALIBRATION_THREAD_COUNTS:-4}" \
      -e FULLMAG_CALIBRATION_DT_S="${FULLMAG_CALIBRATION_DT_S:-1e-14}" \
      -e FULLMAG_CALIBRATION_RESOLUTIONS="${FULLMAG_CALIBRATION_RESOLUTIONS:-coarse:20e-9:100e-9 fine:10e-9:50e-9}" \
      -e FULLMAG_CALIBRATION_CASE_TIMEOUT_S="${FULLMAG_CALIBRATION_CASE_TIMEOUT_S:-900}" \
      fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
        report_dir=.fullmag/reports/fem-relaxation-torque-calibration; \
        calibration_inputs=""; \
        for resolution in $FULLMAG_CALIBRATION_RESOLUTIONS; do \
          IFS=: read -r label domain_hmax airbox_hmax <<< "$resolution"; \
          for steps in $FULLMAG_CALIBRATION_STEP_BUDGETS; do \
            FULLMAG_BENCH_DOMAIN_HMAX="$domain_hmax" \
            FULLMAG_BENCH_AIRBOX_HMAX="$airbox_hmax" \
            python3 scripts/analysis/fem_gpu_benchmark.py \
              --meshes examples/assets/bench_box_200x50x10nm.mesh.json,examples/assets/bench_box_fine.mesh.json \
              --scenarios "$FULLMAG_CALIBRATION_SCENARIOS" \
              --integrators "$FULLMAG_CALIBRATION_INTEGRATORS" \
              --relax-algorithms llg_overdamped \
              --timestep-policies "$FULLMAG_CALIBRATION_TIMESTEP_POLICIES" \
              --backends "$FULLMAG_CALIBRATION_BACKENDS" \
              --thread-counts "$FULLMAG_CALIBRATION_THREAD_COUNTS" \
              --steps "$steps" \
              --dt "$FULLMAG_CALIBRATION_DT_S" \
              --relax-torque-tolerance-apm 1e-12 \
              --case-timeout-s "$FULLMAG_CALIBRATION_CASE_TIMEOUT_S" \
              --output "$report_dir/raw-${label}-${steps}.csv" \
              --cpu-gpu-summary-output "$report_dir/raw-${label}-${steps}.summary.json" \
              --generated-domain-mesh-cache-dir "$report_dir/mesh-cache" \
              --reuse-generated-domain-mesh \
              --require-stable-solver-mesh \
              --require-demag-converged \
              --require-cpu-gpu-consistency \
              --quiet-json-summary; \
            calibration_inputs="$calibration_inputs $report_dir/raw-${label}-${steps}.csv"; \
          done; \
        done; \
        python3 scripts/analysis/calibrate_fem_relaxation_torque_default.py \
          $calibration_inputs \
          --summary "$report_dir/calibration_summary.json" \
          --plot "$report_dir/final_torque_vs_step_budget.png"'

# Task 6: the v2 calibration is a full algorithm/physics/mesh/backend matrix.
# The runtime is mounted explicitly so the CSV provenance cannot silently use
# a host binary or a stale container copy. A partial scope is diagnostic only
# and is never allowed to promote a default.
calibrate-fem-relaxation-torque-default-v2:
    just ensure-managed-fem-runtime
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
    test -x "$runtime_root/bin/fullmag-fem-gpu"; \
    test -f "$runtime_root/manifest.json"; \
    report_dir=.fullmag/reports/fem-relaxation-torque-calibration-v2; \
    mkdir -p "$report_dir/mesh-cache"; \
    docker compose --profile fem-gpu run --rm -T \
      -v "$runtime_root:/workspace/.fullmag/runtime:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime \
      -e FULLMAG_BENCH_GPU_BIN=/workspace/.fullmag/runtime/bin/fullmag-fem-gpu \
      -e FULLMAG_BENCH_CPU_BIN=/workspace/.fullmag/runtime/bin/fullmag-fem-gpu \
      -e FULLMAG_TORQUE_CALIBRATION_SCOPE="${FULLMAG_TORQUE_CALIBRATION_SCOPE:-}" \
      -e FULLMAG_TORQUE_CALIBRATION_REPEAT="${FULLMAG_TORQUE_CALIBRATION_REPEAT:-}" \
      -e FULLMAG_TORQUE_CALIBRATION_MESHES="${FULLMAG_TORQUE_CALIBRATION_MESHES:-}" \
      -e FULLMAG_TORQUE_CALIBRATION_SCENARIOS="${FULLMAG_TORQUE_CALIBRATION_SCENARIOS:-}" \
      -e FULLMAG_TORQUE_CALIBRATION_STEP_BUDGETS="${FULLMAG_TORQUE_CALIBRATION_STEP_BUDGETS:-}" \
      -e FULLMAG_TORQUE_CALIBRATION_THREAD_COUNTS="${FULLMAG_TORQUE_CALIBRATION_THREAD_COUNTS:-}" \
      -e FULLMAG_TORQUE_CALIBRATION_DT_S="${FULLMAG_TORQUE_CALIBRATION_DT_S:-}" \
      -e FULLMAG_TORQUE_CALIBRATION_TOLERANCE_APM="${FULLMAG_TORQUE_CALIBRATION_TOLERANCE_APM:-}" \
      -e FULLMAG_TORQUE_CALIBRATION_CASE_TIMEOUT_S="${FULLMAG_TORQUE_CALIBRATION_CASE_TIMEOUT_S:-}" \
      fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
        report_dir=.fullmag/reports/fem-relaxation-torque-calibration-v2; \
        scope="$FULLMAG_TORQUE_CALIBRATION_SCOPE"; \
        repeat_count="$FULLMAG_TORQUE_CALIBRATION_REPEAT"; \
        meshes="$FULLMAG_TORQUE_CALIBRATION_MESHES"; \
        scenarios="$FULLMAG_TORQUE_CALIBRATION_SCENARIOS"; \
        steps_list="$FULLMAG_TORQUE_CALIBRATION_STEP_BUDGETS"; \
        thread_counts="$FULLMAG_TORQUE_CALIBRATION_THREAD_COUNTS"; \
        dt_s="$FULLMAG_TORQUE_CALIBRATION_DT_S"; \
        tolerance_apm="$FULLMAG_TORQUE_CALIBRATION_TOLERANCE_APM"; \
        timeout_s="$FULLMAG_TORQUE_CALIBRATION_CASE_TIMEOUT_S"; \
        [ -n "$scope" ] || scope=full; \
        [ -n "$repeat_count" ] || repeat_count=3; \
        [ -n "$meshes" ] || meshes=coarse,medium,fine; \
        [ -n "$scenarios" ] || scenarios=box500_airbox_exchange_only,box500_airbox_exchange_demag,box500_airbox_exchange_demag_anis_uniaxial,box500_airbox_exchange_demag_multidomain; \
        [ -n "$steps_list" ] || steps_list="128 256 512"; \
        [ -n "$thread_counts" ] || thread_counts=auto; \
        [ -n "$dt_s" ] || dt_s=1e-14; \
        [ -n "$tolerance_apm" ] || tolerance_apm=1e-12; \
        [ -n "$timeout_s" ] || timeout_s=900; \
        scope_args=""; \
        if [ "$scope" != full ]; then scope_args="--allow-incomplete-matrix"; fi; \
        calibration_inputs=""; \
        for steps in $steps_list; do \
          python3 scripts/analysis/fem_gpu_benchmark.py \
            --meshes "$meshes" \
            --scenarios "$scenarios" \
            --integrators rk23,rk45 \
            --relax-algorithms projected_gradient_bb,nonlinear_cg,llg_overdamped \
            --timestep-policies fixed,adaptive \
            --backends cpu,gpu \
            --thread-counts "$thread_counts" \
            --steps "$steps" \
            --repeat "$repeat_count" \
            --dt "$dt_s" \
            --relax-torque-tolerance-apm "$tolerance_apm" \
            --case-timeout-s "$timeout_s" \
            --output "$report_dir/raw-$steps.csv" \
            --relaxation-torque-calibration-suite examples/assets/fem_performance/relaxation_torque_calibration_suite_v2.json \
            --generated-domain-mesh-cache-dir "$report_dir/mesh-cache" \
            --reuse-generated-domain-mesh \
            --require-stable-solver-mesh \
            --capture-final-magnetization \
            --require-demag-converged; \
          calibration_inputs="$calibration_inputs $report_dir/raw-$steps.csv"; \
        done; \
        python3 scripts/analysis/calibrate_fem_relaxation_torque_default.py \
          $calibration_inputs \
          --suite examples/assets/fem_performance/relaxation_torque_calibration_suite_v2.json \
          --summary "$report_dir/calibration_summary.json" \
          --plot "$report_dir/final_torque_vs_step_budget.png" \
          $scope_args; \
        cp /workspace/.fullmag/runtime/manifest.json "$report_dir/runtime-manifest.json"'

generate-fem-gpu-performance-fixtures:
    COMPOSE_PROJECT_NAME=fullmag just ensure-managed-fem-runtime
    COMPOSE_PROJECT_NAME=fullmag docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_GMSH_THREADS=1 \
      fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/fem_gpu_benchmark.py \
        --meshes coarse \
        --scenarios box500_airbox_exchange_demag \
        --relax-algorithms nonlinear_cg \
        --steps 1 \
        --reuse-generated-domain-mesh \
        --generated-domain-mesh-cache-dir examples/assets/fem_performance \
        --write-fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json \
        --write-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json'

# Task 1 writes only meshes exported from the canonical execution-plan metadata.
# The recipe is intentionally separate from the historical v1 generator until
# the managed runtime can be regenerated and the strict builder gate passes.
generate-fem-performance-fixture-v2:
    COMPOSE_PROJECT_NAME=fullmag just ensure-managed-fem-runtime
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
      test -x "$runtime_root/bin/fullmag-fem-gpu"; \
      test -f "$runtime_root/manifest.json"; \
      COMPOSE_PROJECT_NAME=fullmag docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtime:ro" \
      -e FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_GMSH_THREADS=1 \
      fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/fem_gpu_benchmark.py \
        --meshes coarse \
        --scenarios box500_airbox_exchange_demag \
        --relax-algorithms nonlinear_cg \
        --demag-rtols 1e-12 \
        --demag-amg-relax-types 6 \
        --steps 1 \
        --reuse-generated-domain-mesh \
        --generated-domain-mesh-cache-dir examples/assets/fem_performance \
        --write-fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v2.fixture.json \
        --write-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v2.json'

verify-fem-performance-fixture-v2:
    COMPOSE_PROJECT_NAME=fullmag just ensure-managed-fem-runtime
    test -f examples/assets/fem_performance/box500_airbox_exchange_demag_v2.fixture.json
    test -f examples/assets/fem_performance/amg_qualification_suite_v2.json
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
      test -x "$runtime_root/bin/fullmag-fem-gpu" && test -f "$runtime_root/manifest.json"; \
      target_slug="$(basename "$PWD" | sed 's/[^A-Za-z0-9._-]/-/g')"; \
      target_digest="$(printf '%s' "$PWD" | sha256sum | cut -c1-64)"; \
      target_dir="/mnt/fullmag-zfn2-native/managed-fem-runtime/${target_slug}-${target_digest}"; \
      test -d "$target_dir" && test -w "$target_dir"; \
      COMPOSE_PROJECT_NAME=fullmag docker compose --profile fem-gpu run --rm \
        -v "$runtime_root:/workspace/.fullmag/runtime:ro" \
        -v "$target_dir:/workspace/target" \
        -e PYTHONPATH=/workspace/packages/fullmag-py/src \
        -e FULLMAG_PYTHON=/usr/bin/python3 \
        -e FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime \
        -e FULLMAG_FEM_EXECUTION=cpu \
        fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
          build_dir=/workspace/target/task1-performance-fixture-v2/native; \
          cmake -S native -B "$build_dir" -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON; \
          cmake --build "$build_dir" --target fem_mixed_p1_contract; \
          LD_LIBRARY_PATH="$build_dir/backends/fem:${LD_LIBRARY_PATH:-}" FULLMAG_MIXED_P1_ROLLBACK_DEVICE=cpu "$build_dir/backends/fem/fem_mixed_p1_contract"; \
          report_dir=.fullmag/reports/fem-performance-fixture-v2; mkdir -p "$report_dir"; \
          while IFS=$'\''\t'\'' read -r resolution solver_mesh domain_hmax airbox_hmax solver_mesh_signature problem_ir_sha256; do \
            FULLMAG_BENCH_DOMAIN_MESH="$solver_mesh" FULLMAG_BENCH_DOMAIN_HMAX="$domain_hmax" FULLMAG_BENCH_AIRBOX_HMAX="$airbox_hmax" \
              python3 scripts/analysis/fem_gpu_benchmark.py \
                --meshes coarse --scenarios box500_airbox_exchange_demag \
                --integrators heun --relax-algorithms nonlinear_cg --backends cpu \
                --demag-solvers CG --demag-preconditioners AMG --demag-rtols 1e-12 \
                --demag-amg-relax-types 6 --steps 1 --repeat 1 \
                --expected-solver-mesh-signature "$solver_mesh_signature" \
                --output "$report_dir/$resolution.csv" --quiet-json-summary; \
          done < <(python3 scripts/analysis/fem_gpu_benchmark.py --list-amg-qualification-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v2.json)'

verify-fem-gpu-performance-regression:
    COMPOSE_PROJECT_NAME=fullmag just ensure-managed-fem-runtime
    COMPOSE_PROJECT_NAME=fullmag docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_BENCH_DOMAIN_HMAX=50e-9 \
      -e FULLMAG_BENCH_AIRBOX_HMAX=100e-9 \
      -e FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP:-3}" \
      -e FULLMAG_BENCH_REPEAT="${FULLMAG_BENCH_REPEAT:-5}" \
      fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
        python3 -c '"'"'import csv,json,subprocess; from pathlib import Path; environment=json.loads(Path("benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json").read_text()); row=next(csv.reader([subprocess.check_output(["nvidia-smi", "--query-gpu=uuid,name,compute_cap", "--format=csv,noheader"], text=True).splitlines()[0]], skipinitialspace=True)); actual={"uuid": row[0].strip(), "name": row[1].strip(), "compute_capability": row[2].strip()}; expected=environment["gpu"]; mismatches=[key for key in ("uuid", "name", "compute_capability") if str(actual[key]) != str(expected[key])]; assert not mismatches, f"GPU identity differs from accepted baseline: {mismatches}; expected={expected}; actual={actual}"'"'"'; \
        python3 scripts/analysis/fem_gpu_benchmark.py \
          --meshes coarse \
          --scenarios box500_airbox_exchange_demag \
          --integrators heun \
          --relax-algorithms nonlinear_cg \
          --demag-preconditioners AMG \
          --demag-amg-relax-types 6 \
          --steps 64 \
          --fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json \
          --fixture-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json \
          --require-fixture-identity \
          --gpu-warmup \
          --repeat "$FULLMAG_BENCH_REPEAT" \
          --reuse-generated-domain-mesh \
          --require-stable-solver-mesh \
          --accepted-baseline benchmarks/fem-gpu/accepted/rtx4080-sm89/benchmark.csv \
          --require-accepted-baseline \
          --max-performance-regression-percent 5 \
          --require-demag-converged \
          --require-cpu-gpu-consistency \
          --require-gpu-strict-residency \
          --require-gpu-control-readback-budget \
          --gpu-ncg-control-readback-per-step "$FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP" \
          --output .fullmag/reports/fem_gpu_performance_regression.csv \
          --cpu-gpu-summary-output .fullmag/reports/fem_gpu_performance_regression_summary.json'

verify-fem-gpu-relaxation-preconditioner-qualification:
    COMPOSE_PROJECT_NAME=fullmag just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports
    COMPOSE_PROJECT_NAME=fullmag docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FEM_STEP_PROFILE=1 \
      -e FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1 \
      -e FULLMAG_GMSH_THREADS=1 \
      fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
        python3 scripts/analysis/fem_gpu_benchmark.py \
          --meshes coarse,medium,fine \
          --scenarios box500_airbox_exchange_demag \
          --integrators heun \
          --backends cpu,gpu \
          --timestep-policies fixed \
          --thread-counts 1 \
          --relax-algorithms nonlinear_cg \
          --relaxation-preconditioner-strategies none \
          --demag-solvers CG \
          --demag-preconditioners AMG \
          --demag-rtols 1e-12 \
          --demag-amg-relax-types 6 \
          --steps 64 \
          --dt 1e-13 \
          --relax-torque-tolerance-apm 8000 \
          --repeat 1 \
          --case-timeout-s 900 \
          --gpu-warmup \
          --reuse-generated-domain-mesh \
          --require-stable-solver-mesh \
          --require-demag-converged \
          --require-gpu-strict-residency \
          --require-gpu-control-readback-budget \
          --capture-final-magnetization \
          --task11-relaxation-preconditioner-cpu-gpu-parity-sweep \
          --task11-qualification-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json \
          --task11-qualification-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json \
          --output .fullmag/reports/task-11-relaxation-preconditioner-cpu-gpu-parity.csv \
          --quiet-json-summary; \
        python3 scripts/analysis/fem_gpu_benchmark.py \
          --meshes coarse,medium,fine \
          --scenarios box500_airbox_exchange_demag \
          --integrators heun \
          --backends gpu \
          --timestep-policies fixed \
          --thread-counts 1 \
          --relax-algorithms nonlinear_cg \
          --relaxation-preconditioner-strategies none,diagonal_mass,lumped_exchange_mass_cg4,lumped_exchange_mass_cg8,stagnation_triggered_cg8 \
          --demag-solvers CG \
          --demag-preconditioners AMG \
          --demag-rtols 1e-12 \
          --demag-amg-relax-types 6 \
          --steps 64 \
          --dt 1e-13 \
          --relax-torque-tolerance-apm 8000 \
          --repeat 5 \
          --case-timeout-s 900 \
          --gpu-warmup \
          --reuse-generated-domain-mesh \
          --require-stable-solver-mesh \
          --require-demag-converged \
          --require-gpu-strict-residency \
          --require-gpu-control-readback-budget \
          --task11-qualification-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json \
          --task11-qualification-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json \
          --output .fullmag/reports/task-11-relaxation-preconditioner.csv \
          --quiet-json-summary; \
        python3 scripts/analysis/fem_gpu_benchmark.py \
          --relaxation-preconditioner-qualification-input .fullmag/reports/task-11-relaxation-preconditioner.csv \
          --relaxation-preconditioner-cpu-gpu-parity-input .fullmag/reports/task-11-relaxation-preconditioner-cpu-gpu-parity.csv \
          --task11-qualification-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json \
          --task11-qualification-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json \
          --relaxation-preconditioner-qualification-output .fullmag/reports/task-11-relaxation-preconditioner-qualification.json'

verify-fem-gpu-host-thread-policy-qualification:
    COMPOSE_PROJECT_NAME=fullmag just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports/task-12-host-thread-policy/mesh-cache
    COMPOSE_PROJECT_NAME=fullmag docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1 \
      -e FULLMAG_GMSH_THREADS=1 \
      fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
        FULLMAG_BENCH_THREAD_COUNTS="1,2,4,8"; \
        FULLMAG_BENCH_REPEAT="5"; \
        FULLMAG_FEM_STEP_PROFILE=0 python3 scripts/analysis/fem_gpu_benchmark.py \
          --meshes fine --scenarios box500_airbox_exchange_demag \
          --integrators heun --backends gpu --timestep-policies fixed \
          --thread-counts "$FULLMAG_BENCH_THREAD_COUNTS" \
          --relax-algorithms projected_gradient_bb \
          --demag-solvers CG --demag-preconditioners AMG --demag-rtols 1e-12 \
          --demag-amg-relax-types 6 --steps 32 --repeat "$FULLMAG_BENCH_REPEAT" \
          --gpu-warmup --reuse-generated-domain-mesh \
          --gpu-host-thread-qualification-run \
          --generated-domain-mesh-cache-dir .fullmag/reports/task-12-host-thread-policy/mesh-cache \
          --require-stable-solver-mesh --require-demag-converged \
          --require-gpu-strict-residency --require-gpu-control-readback-budget \
          --ui-surface headless \
          --output .fullmag/reports/task-12-host-thread-policy/headless-profiler-off.csv \
          --quiet-json-summary; \
        FULLMAG_FEM_STEP_PROFILE=1 python3 scripts/analysis/fem_gpu_benchmark.py \
          --meshes fine --scenarios box500_airbox_exchange_demag \
          --integrators heun --backends gpu --timestep-policies fixed \
          --thread-counts "$FULLMAG_BENCH_THREAD_COUNTS" \
          --relax-algorithms projected_gradient_bb \
          --demag-solvers CG --demag-preconditioners AMG --demag-rtols 1e-12 \
          --demag-amg-relax-types 6 --steps 32 --repeat "$FULLMAG_BENCH_REPEAT" \
          --gpu-warmup --reuse-generated-domain-mesh \
          --gpu-host-thread-qualification-run \
          --generated-domain-mesh-cache-dir .fullmag/reports/task-12-host-thread-policy/mesh-cache \
          --require-stable-solver-mesh --require-demag-converged \
          --require-gpu-strict-residency --require-gpu-control-readback-budget \
          --ui-surface headless \
          --output .fullmag/reports/task-12-host-thread-policy/headless-profiler-on.csv \
          --quiet-json-summary; \
        FULLMAG_FEM_STEP_PROFILE=0 python3 scripts/analysis/fem_gpu_benchmark.py \
          --meshes fine --scenarios box500_airbox_exchange_demag \
          --integrators heun --backends gpu --timestep-policies fixed \
          --thread-counts "$FULLMAG_BENCH_THREAD_COUNTS" \
          --relax-algorithms projected_gradient_bb \
          --demag-solvers CG --demag-preconditioners AMG --demag-rtols 1e-12 \
          --demag-amg-relax-types 6 --steps 32 --repeat "$FULLMAG_BENCH_REPEAT" \
          --gpu-warmup --reuse-generated-domain-mesh \
          --gpu-host-thread-qualification-run \
          --generated-domain-mesh-cache-dir .fullmag/reports/task-12-host-thread-policy/mesh-cache \
          --require-stable-solver-mesh --require-demag-converged \
          --require-gpu-strict-residency --require-gpu-control-readback-budget \
          --ui-surface interactive \
          --output .fullmag/reports/task-12-host-thread-policy/interactive-profiler-off.csv \
          --quiet-json-summary; \
        FULLMAG_FEM_STEP_PROFILE=1 python3 scripts/analysis/fem_gpu_benchmark.py \
          --meshes fine --scenarios box500_airbox_exchange_demag \
          --integrators heun --backends gpu --timestep-policies fixed \
          --thread-counts "$FULLMAG_BENCH_THREAD_COUNTS" \
          --relax-algorithms projected_gradient_bb \
          --demag-solvers CG --demag-preconditioners AMG --demag-rtols 1e-12 \
          --demag-amg-relax-types 6 --steps 32 --repeat "$FULLMAG_BENCH_REPEAT" \
          --gpu-warmup --reuse-generated-domain-mesh \
          --gpu-host-thread-qualification-run \
          --generated-domain-mesh-cache-dir .fullmag/reports/task-12-host-thread-policy/mesh-cache \
          --require-stable-solver-mesh --require-demag-converged \
          --require-gpu-strict-residency --require-gpu-control-readback-budget \
          --ui-surface interactive \
          --output .fullmag/reports/task-12-host-thread-policy/interactive-profiler-on.csv \
          --quiet-json-summary; \
        python3 scripts/analysis/fem_gpu_benchmark.py \
          --gpu-host-thread-qualification-inputs \
            .fullmag/reports/task-12-host-thread-policy/headless-profiler-off.csv,.fullmag/reports/task-12-host-thread-policy/headless-profiler-on.csv,.fullmag/reports/task-12-host-thread-policy/interactive-profiler-off.csv,.fullmag/reports/task-12-host-thread-policy/interactive-profiler-on.csv \
          --gpu-host-thread-qualification-output \
            .fullmag/reports/task-12-host-thread-policy/qualification.json'

capture-fem-gpu-pre-remediation-performance-baseline:
    COMPOSE_PROJECT_NAME=fullmag just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports
    COMPOSE_PROJECT_NAME=fullmag docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_BENCH_DOMAIN_HMAX=50e-9 \
      -e FULLMAG_BENCH_AIRBOX_HMAX=100e-9 \
      fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/fem_gpu_benchmark.py \
        --meshes coarse \
        --scenarios box500_airbox_exchange_demag \
        --integrators heun \
        --relax-algorithms nonlinear_cg \
        --demag-preconditioners AMG \
        --demag-amg-relax-types 6 \
        --steps 64 \
        --repeat 5 \
        --fixture-manifest examples/assets/fem_performance/box500_airbox_exchange_demag_v1.fixture.json \
        --fixture-environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json \
        --require-fixture-identity \
        --gpu-warmup \
        --reuse-generated-domain-mesh \
        --require-stable-solver-mesh \
        --require-demag-converged \
        --require-cpu-gpu-consistency \
        --require-gpu-strict-residency \
        --output .fullmag/reports/fullmag_fem_gpu_pre_remediation_performance_baseline.csv \
        --cpu-gpu-summary-output .fullmag/reports/fullmag_fem_gpu_pre_remediation_performance_baseline_summary.json'

verify-fem-gpu-pre-remediation-runtime-restore:
    state_file="$(mktemp /tmp/fullmag-fem-gpu-restore-state.XXXXXX.json)"; \
      trap 'rm -f -- "$state_file"' EXIT; \
      python3 scripts/verify_fem_gpu_runtime_restore.py capture \
        --environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json \
        --state "$state_file"; \
      COMPOSE_PROJECT_NAME=fullmag just rebuild-fem-runtime; \
      python3 scripts/verify_fem_gpu_runtime_restore.py compare \
        --environment benchmarks/fem-gpu/accepted/rtx4080-sm89/environment.json \
        --state "$state_file"

verify-fem-gpu-demag-performance-benchmark:
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_BENCH_DOMAIN_HMAX="${FULLMAG_BENCH_DOMAIN_HMAX:-50e-9}" \
      -e FULLMAG_BENCH_AIRBOX_HMAX="${FULLMAG_BENCH_AIRBOX_HMAX:-100e-9}" \
      -e FULLMAG_BENCH_MESHES="${FULLMAG_BENCH_MESHES:-coarse}" \
      -e FULLMAG_BENCH_SCENARIOS="${FULLMAG_BENCH_SCENARIOS:-box500_airbox_exchange_demag,box500_airbox_exchange_demag_anis_uniaxial,box500_airbox_exchange_demag_anis_cubic}" \
      -e FULLMAG_BENCH_INTEGRATORS="${FULLMAG_BENCH_INTEGRATORS:-heun}" \
      -e FULLMAG_BENCH_RELAX_ALGORITHMS="${FULLMAG_BENCH_RELAX_ALGORITHMS:-llg_overdamped,projected_gradient_bb,nonlinear_cg}" \
      -e FULLMAG_BENCH_DEMAG_SOLVERS="${FULLMAG_BENCH_DEMAG_SOLVERS:-CG}" \
      -e FULLMAG_BENCH_DEMAG_PRECONDITIONERS="${FULLMAG_BENCH_DEMAG_PRECONDITIONERS:-OMIT,AMG,JACOBI}" \
      -e FULLMAG_BENCH_DEMAG_RTOLS="${FULLMAG_BENCH_DEMAG_RTOLS:-1e-8}" \
      -e FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS="${FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS:-100}" \
      -e FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES="${FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES:-18}" \
      -e FULLMAG_BENCH_DEMAG_AMG_COARSENINGS="${FULLMAG_BENCH_DEMAG_AMG_COARSENINGS:-8}" \
      -e FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS="${FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS:-6}" \
      -e FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS="${FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS:-1}" \
      -e FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS="${FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS:-}" \
      -e FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS="${FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS:-}" \
      -e FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC="${FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC:-demag_solver_apply_wall_time_ms}" \
      -e FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS="${FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS:-5000}" \
      -e FULLMAG_BENCH_STEPS="${FULLMAG_BENCH_STEPS:-4}" \
      -e FULLMAG_BENCH_CASE_TIMEOUT_S="${FULLMAG_BENCH_CASE_TIMEOUT_S:-900}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL="${FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J="${FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J:-1e-30}" \
      -e FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL="${FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL:-1e-6}" \
      -e FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP:-4}" \
      -e FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP:-0}" \
      -e FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP:-4}" \
      -e FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP="${FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP:-3}" \
      -e FULLMAG_BENCH_MIN_SOLVER_NODES="${FULLMAG_BENCH_MIN_SOLVER_NODES:-800}" \
      -e FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP="${FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP:-2}" \
      -e FULLMAG_BENCH_ACCEPTED_BASELINE="${FULLMAG_BENCH_ACCEPTED_BASELINE:-}" \
      -e FULLMAG_BENCH_REQUIRE_ACCEPTED_BASELINE="${FULLMAG_BENCH_REQUIRE_ACCEPTED_BASELINE:-0}" \
      -e FULLMAG_BENCH_MAX_PERFORMANCE_REGRESSION_PERCENT="${FULLMAG_BENCH_MAX_PERFORMANCE_REGRESSION_PERCENT:-10}" \
      -e FULLMAG_BENCH_OUTPUT="${FULLMAG_BENCH_OUTPUT:-.fullmag/reports/fullmag_fem_gpu_demag_performance_benchmark.csv}" \
      -e FULLMAG_BENCH_SUMMARY="${FULLMAG_BENCH_SUMMARY:-.fullmag/reports/fullmag_fem_gpu_demag_performance_benchmark_summary.json}" \
      -e FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR="${FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR:-}" \
      -e FULLMAG_FEM_STEP_PROFILE="${FULLMAG_FEM_STEP_PROFILE:-1}" \
      -e FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC="${FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC:-1}" \
      fem-gpu bash -lc 'cd /workspace && \
        baseline_args=(); \
        demag_budget_args=(); \
        cache_args=(); \
        if [ -n "$FULLMAG_BENCH_ACCEPTED_BASELINE" ]; then baseline_args+=(--accepted-baseline "$FULLMAG_BENCH_ACCEPTED_BASELINE"); fi; \
        if [ "$FULLMAG_BENCH_REQUIRE_ACCEPTED_BASELINE" = "1" ]; then baseline_args+=(--require-accepted-baseline); fi; \
        if [ -n "$FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS" ]; then demag_budget_args+=(--max-demag-solver-apply-ms "$FULLMAG_BENCH_MAX_DEMAG_SOLVER_APPLY_MS"); fi; \
        if [ -n "$FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR" ]; then cache_args+=(--generated-domain-mesh-cache-dir "$FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR"); fi; \
        python3 scripts/analysis/fem_gpu_benchmark.py \
        --meshes "$FULLMAG_BENCH_MESHES" \
        --scenarios "$FULLMAG_BENCH_SCENARIOS" \
        --integrators "$FULLMAG_BENCH_INTEGRATORS" \
        --relax-algorithms "$FULLMAG_BENCH_RELAX_ALGORITHMS" \
        --demag-solvers "$FULLMAG_BENCH_DEMAG_SOLVERS" \
        --demag-preconditioners "$FULLMAG_BENCH_DEMAG_PRECONDITIONERS" \
        --demag-rtols "$FULLMAG_BENCH_DEMAG_RTOLS" \
        --demag-amg-relax-types "$FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES" \
        --demag-amg-coarsenings "$FULLMAG_BENCH_DEMAG_AMG_COARSENINGS" \
        --demag-amg-interpolations "$FULLMAG_BENCH_DEMAG_AMG_INTERPOLATIONS" \
        --demag-amg-aggressive-coarsenings "$FULLMAG_BENCH_DEMAG_AMG_AGGRESSIVE_COARSENINGS" \
        --demag-amg-strength-thresholds "$FULLMAG_BENCH_DEMAG_AMG_STRENGTH_THRESHOLDS" \
        --demag-amg-max-levels "$FULLMAG_BENCH_DEMAG_AMG_MAX_LEVELS" \
        --demag-convergence-max-iterations "$FULLMAG_BENCH_DEMAG_CONVERGENCE_MAX_ITERATIONS" \
        --require-demag-setup-reused \
        --require-ncg-accepted-endpoint-reuse \
        --require-demag-single-setup \
        --require-zero-strict-gpu-global-sync \
        --steps "$FULLMAG_BENCH_STEPS" \
        --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
        --cpu-gpu-energy-rtol "$FULLMAG_BENCH_CPU_GPU_ENERGY_RTOL" \
        --cpu-gpu-energy-atol "$FULLMAG_BENCH_CPU_GPU_ENERGY_ATOL_J" \
        --cpu-gpu-torque-rtol "$FULLMAG_BENCH_CPU_GPU_TORQUE_RTOL" \
        --output "$FULLMAG_BENCH_OUTPUT" \
        --cpu-gpu-summary-output "$FULLMAG_BENCH_SUMMARY" \
        --quiet-json-summary \
        --gpu-warmup \
        --reuse-generated-domain-mesh \
        "${cache_args[@]}" \
        --require-adaptive-gpu-rk-acceptance \
        --emit-best-demag-policy \
        --best-demag-policy-metric "$FULLMAG_BENCH_BEST_DEMAG_POLICY_METRIC" \
        --require-best-demag-policy \
        --require-gpu-control-readback-budget \
        --require-gpu-phase-timings \
        --gpu-control-readback-per-step "$FULLMAG_BENCH_GPU_CONTROL_READBACK_PER_STEP" \
        --gpu-llg-control-readback-per-step "$FULLMAG_BENCH_GPU_LLG_CONTROL_READBACK_PER_STEP" \
        --gpu-pgbb-control-readback-per-step "$FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP" \
        --gpu-ncg-control-readback-per-step "$FULLMAG_BENCH_GPU_NCG_CONTROL_READBACK_PER_STEP" \
        --require-min-solver-nodes "$FULLMAG_BENCH_MIN_SOLVER_NODES" \
        --min-gpu-demag-total-speedup "$FULLMAG_BENCH_MIN_GPU_DEMAG_TOTAL_SPEEDUP" \
        --require-demag-converged \
        --require-cpu-gpu-consistency \
        --require-gpu-strict-residency \
        --max-performance-regression-percent "$FULLMAG_BENCH_MAX_PERFORMANCE_REGRESSION_PERCENT" \
        "${baseline_args[@]}" \
        "${demag_budget_args[@]}"'

# T12: prove that profiled FEM GPU HYPRE solves publish separate host/device
# timing, while the disabled profiler publishes no timing events. This is a
# diagnostic gate, not a performance claim; both profiler states use the same
# coarse/fine workload and exact demag policy.
verify-fem-hypre-device-timing:
    just ensure-managed-fem-runtime
    mkdir -p .fullmag/reports/task-12-hypre-device-timing
    runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"; \
      test -x "$runtime_root/bin/fullmag-fem-gpu"; \
      test -f "$runtime_root/manifest.json"; \
      COMPOSE_PROJECT_NAME=fullmag docker compose --profile fem-gpu run --rm \
      -v "$runtime_root:/workspace/.fullmag/runtime:ro" \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime \
      -e FULLMAG_BENCH_GPU_BIN=/workspace/.fullmag/runtime/bin/fullmag-fem-gpu \
      -e FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1 \
      -e FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE="${FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE:-8000.0}" \
      -e FULLMAG_BENCH_CASE_TIMEOUT_S="${FULLMAG_BENCH_CASE_TIMEOUT_S:-900}" \
      fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
        report_dir=.fullmag/reports/task-12-hypre-device-timing; \
        for profiler in off on; do \
          if [ "$profiler" = on ]; then profile=1; profile_args=(--require-gpu-phase-timings); else profile=0; profile_args=(); fi; \
          FULLMAG_FEM_STEP_PROFILE="$profile" python3 scripts/analysis/fem_gpu_benchmark.py \
            --meshes coarse,fine \
            --scenarios box500_airbox_exchange_demag \
            --integrators heun \
            --backends gpu \
            --timestep-policies fixed \
            --relax-algorithms nonlinear_cg \
            --demag-solvers CG \
            --demag-preconditioners AMG \
            --demag-rtols 1e-12 \
            --demag-amg-relax-types 6 \
            --demag-amg-coarsenings 8 \
            --demag-amg-interpolations 6 \
            --demag-amg-aggressive-coarsenings 1 \
            --steps 2 \
            --dt 1e-13 \
            --repeat 1 \
            --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
            --gpu-warmup \
            --relaxation-torque-calibration-suite examples/assets/fem_performance/relaxation_torque_calibration_suite_v2.json \
            --require-demag-converged \
            --require-zero-strict-gpu-global-sync \
            --require-gpu-strict-residency \
            --output "$report_dir/profiler-$profiler.csv" \
            --quiet-json-summary \
            "${profile_args[@]}"; \
        done; \
        python3 scripts/validate_fem_hypre_device_timing.py \
          --input "$report_dir/profiler-off.csv" "$report_dir/profiler-on.csv" \
          --output "$report_dir/summary.json"'

bench-fem-gpu-demag-amg-profile-sweep:
    just ensure-managed-fem-runtime
    just verify-fem-demag-poisson-contract
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES="${FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES:-18,6}" \
      -e FULLMAG_BENCH_RELAX_ALGORITHMS="${FULLMAG_BENCH_RELAX_ALGORITHMS:-projected_gradient_bb,nonlinear_cg}" \
      -e FULLMAG_BENCH_REPEAT="${FULLMAG_BENCH_REPEAT:-5}" \
      -e FULLMAG_BENCH_CASE_TIMEOUT_S="${FULLMAG_BENCH_CASE_TIMEOUT_S:-300}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
        report_dir=.fullmag/reports/fem-amg-relax-policy-qualification; \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" "$report_dir" 2>/dev/null || true'\'' EXIT; \
        rm -rf "$report_dir"; mkdir -p "$report_dir"; \
        input_csvs=(); \
        while IFS=$'\''\t'\'' read -r resolution solver_mesh domain_hmax airbox_hmax solver_mesh_signature problem_ir_sha256; do \
          for profiler in off on; do \
            if [ "$profiler" = on ]; then export FULLMAG_FEM_STEP_PROFILE=1; profile_args=(--require-gpu-phase-timings); else export FULLMAG_FEM_STEP_PROFILE=0; profile_args=(); fi; \
            export FULLMAG_BENCH_DOMAIN_MESH="$solver_mesh" FULLMAG_BENCH_DOMAIN_HMAX="$domain_hmax" FULLMAG_BENCH_AIRBOX_HMAX="$airbox_hmax"; \
            stem="$report_dir/${resolution}-profiler-${profiler}"; \
            benchmark_args=( \
              --meshes coarse \
              --scenarios box500_airbox_exchange_demag \
              --integrators heun \
              --backends fem_cpu,fem_gpu \
              --timestep-policies fixed \
        --relax-algorithms "$FULLMAG_BENCH_RELAX_ALGORITHMS" \
              --demag-solvers CG \
              --demag-preconditioners AMG \
              --demag-rtols 1e-12 \
        --demag-amg-relax-types "$FULLMAG_BENCH_DEMAG_AMG_RELAX_TYPES" \
              --demag-amg-coarsenings 8 \
              --demag-amg-interpolations 6 \
              --demag-amg-aggressive-coarsenings 1 \
              --steps 64 \
              --relax-torque-tolerance-t 1e-4 \
              --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
              --expected-solver-mesh-signature "$solver_mesh_signature" \
              --qualification-fixture-problem-ir-sha256 "$problem_ir_sha256" \
              --quiet-json-summary ); \
            python3 scripts/analysis/fem_gpu_benchmark.py "${benchmark_args[@]}" --repeat 1 --output "$stem-warmup.csv" --cpu-gpu-summary-output "$stem-warmup-summary.json"; \
            python3 scripts/analysis/fem_gpu_benchmark.py "${benchmark_args[@]}" \
              --repeat "$FULLMAG_BENCH_REPEAT" \
              --output "$stem.csv" \
              --cpu-gpu-summary-output "$stem-summary.json" \
              --human-report-output "$stem.md" \
              --emit-best-demag-policy \
              --best-demag-policy-metric demag_solver_apply_wall_time_ms \
              --require-best-demag-policy \
              --require-stable-solver-mesh \
              --require-demag-converged \
              --require-cpu-gpu-consistency \
              --require-gpu-strict-residency \
              "${profile_args[@]}"; \
            input_csvs+=("$stem.csv"); \
          done; \
        done < <(python3 scripts/analysis/fem_gpu_benchmark.py --list-amg-qualification-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json); \
        if [ "${#input_csvs[@]}" -ne 6 ]; then echo "expected six measured AMG qualification CSVs" >&2; exit 2; fi; \
        joined_inputs="$(IFS=,; echo "${input_csvs[*]}")"; \
        python3 scripts/analysis/fem_gpu_benchmark.py \
          --amg-relax-qualification-inputs "$joined_inputs" \
          --amg-relax-qualification-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json \
          --amg-relax-qualification-output "$report_dir/qualification-summary.json" \
          --amg-relax-cpu-gpu-parity-passed \
          --amg-relax-pcg-symmetry-passed'

verify-fem-demag-mesh-airbox-convergence:
    just ensure-managed-fem-runtime
    just verify-fem-demag-poisson-contract-focused
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_BENCH_REPEAT="${FULLMAG_BENCH_REPEAT:-5}" \
      -e FULLMAG_BENCH_STEPS="${FULLMAG_BENCH_STEPS:-64}" \
      -e FULLMAG_BENCH_CASE_TIMEOUT_S="${FULLMAG_BENCH_CASE_TIMEOUT_S:-300}" \
      -e FULLMAG_HOST_UID="$(id -u)" \
      -e FULLMAG_HOST_GID="$(id -g)" \
      fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
        python3 scripts/test_validate_fem_demag_mesh_airbox_convergence.py; \
        report_dir=.fullmag/reports/fem-demag-mesh-airbox-convergence; \
        trap '\''chown -R "$FULLMAG_HOST_UID:$FULLMAG_HOST_GID" "$report_dir" 2>/dev/null || true'\'' EXIT; \
        rm -rf "$report_dir"; mkdir -p "$report_dir"; \
        while IFS=$'\''\t'\'' read -r resolution solver_mesh domain_hmax airbox_hmax solver_mesh_signature problem_ir_sha256; do \
          export FULLMAG_BENCH_DOMAIN_MESH="$solver_mesh" FULLMAG_BENCH_DOMAIN_HMAX="$domain_hmax" FULLMAG_BENCH_AIRBOX_HMAX="$airbox_hmax"; \
          stem="$report_dir/$resolution"; \
          benchmark_args=( \
            --meshes coarse \
            --scenarios box500_airbox_exchange_demag \
            --integrators heun \
            --backends fem_cpu,fem_gpu \
            --timestep-policies fixed \
            --relax-algorithms projected_gradient_bb,nonlinear_cg \
            --demag-solvers CG \
            --demag-preconditioners AMG \
            --demag-rtols 1e-12 \
            --demag-amg-relax-types 6 \
            --demag-amg-coarsenings 8 \
            --demag-amg-interpolations 6 \
            --demag-amg-aggressive-coarsenings 1 \
            --steps "$FULLMAG_BENCH_STEPS" \
            --relax-torque-tolerance-t 1e-4 \
            --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
            --expected-solver-mesh-signature "$solver_mesh_signature" \
            --qualification-fixture-problem-ir-sha256 "$problem_ir_sha256" \
            --quiet-json-summary ); \
          python3 scripts/analysis/fem_gpu_benchmark.py "${benchmark_args[@]}" \
            --repeat 1 \
            --output "$stem-warmup.csv" \
            --cpu-gpu-summary-output "$stem-warmup-summary.json"; \
          python3 scripts/analysis/fem_gpu_benchmark.py "${benchmark_args[@]}" \
            --repeat "$FULLMAG_BENCH_REPEAT" \
            --output "$stem.csv" \
            --cpu-gpu-summary-output "$stem-summary.json" \
            --human-report-output "$stem.md" \
            --require-stable-solver-mesh \
            --require-demag-converged \
            --require-cpu-gpu-consistency \
            --require-gpu-strict-residency; \
        done < <(python3 scripts/analysis/fem_gpu_benchmark.py --list-amg-qualification-fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json); \
        unset FULLMAG_BENCH_DOMAIN_MESH; \
        export FULLMAG_BENCH_DOMAIN_HMAX=1e-7 FULLMAG_BENCH_AIRBOX_HMAX=2.5e-7; \
        for airbox_scale in 1.0 1.5 2.0; do \
          stem="$report_dir/airbox-$airbox_scale"; \
          python3 scripts/analysis/fem_gpu_benchmark.py \
            --meshes coarse \
            --scenarios box500_airbox_exchange_demag \
            --integrators heun \
            --backends fem_cpu,fem_gpu \
            --timestep-policies fixed \
            --relax-algorithms nonlinear_cg \
            --demag-solvers CG \
            --demag-preconditioners AMG \
            --demag-rtols 1e-12 \
            --demag-amg-relax-types 6 \
            --demag-amg-coarsenings 8 \
            --demag-amg-interpolations 6 \
            --demag-amg-aggressive-coarsenings 1 \
            --steps "$FULLMAG_BENCH_STEPS" \
            --relax-torque-tolerance-t 1e-4 \
            --case-timeout-s "$FULLMAG_BENCH_CASE_TIMEOUT_S" \
            --airbox-extent-scale "$airbox_scale" \
            --repeat 1 \
            --reuse-generated-domain-mesh \
            --output "$stem.csv" \
            --cpu-gpu-summary-output "$stem-summary.json" \
            --require-stable-solver-mesh \
            --require-demag-converged \
            --require-cpu-gpu-consistency \
            --require-gpu-strict-residency \
            --quiet-json-summary; \
        done; \
        python3 scripts/validate_fem_demag_mesh_airbox_convergence.py \
          --fixture-suite examples/assets/fem_performance/amg_qualification_suite_v1.json \
          --mesh-input coarse:"$report_dir/coarse-warmup.csv":"$report_dir/coarse.csv" \
          --mesh-input medium:"$report_dir/medium-warmup.csv":"$report_dir/medium.csv" \
          --mesh-input fine:"$report_dir/fine-warmup.csv":"$report_dir/fine.csv" \
          --airbox-input 1.0:"$report_dir/airbox-1.0.csv" \
          --airbox-input 1.5:"$report_dir/airbox-1.5.csv" \
          --airbox-input 2.0:"$report_dir/airbox-2.0.csv" \
          --repeat "$FULLMAG_BENCH_REPEAT" \
          --output "$report_dir/qualification-summary.json"'

# This is deliberately fail-closed until the managed runtime can emit the
# prescribed-uniform single-evaluation matrix declared by the suite.  The
# legacy relaxed-box recipe above remains supplemental trend regression only.
verify-fem-demag-analytic-qualification artifact=".fullmag/reports/fem-demag-analytic-qualification/analytic-qualification.v1.json":
    just ensure-managed-fem-runtime
    just verify-fem-demag-poisson-contract-focused
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      fem-gpu bash -lc 'cd /workspace && set -euo pipefail; \
        python3 -m pytest -q -s tests/fem_demag_validation/test_acceptance.py scripts/test_validate_fem_demag_analytic_qualification.py scripts/test_validate_fem_demag_mesh_airbox_convergence.py; \
        report_dir=.fullmag/reports/fem-demag-analytic-qualification; \
        mkdir -p "$report_dir"; \
        python3 scripts/capture_source_snapshot_identity.py --repo-root /workspace --output "$report_dir/current-source-identity.v1.json"; \
        test -f .fullmag/runtimes/fem-gpu-host/manifest.json; \
        python3 scripts/validate_fem_demag_analytic_qualification.py \
          --suite examples/assets/fem_demag_analytic_qualification_suite_v1.json \
          --artifact "{{artifact}}" \
          --expected-source-identity "$report_dir/current-source-identity.v1.json" \
          --expected-runtime-manifest .fullmag/runtimes/fem-gpu-host/manifest.json \
          --output .fullmag/reports/fem-demag-analytic-qualification/summary.v1.json'

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

run-viewport-3d-smoke-disposable fixture="examples/fdm_cpu_relax_smoke.py" backend="fdm" device="cpu" web_port="3197" api_port="8197":
    just ensure-python
    just build fullmag
    bash -euo pipefail -c '\
      fixture="$(realpath "{{fixture}}")"; \
      backend="{{backend}}"; device="{{device}}"; \
      case "$backend" in fdm|fem) ;; *) echo "unsupported backend: $backend" >&2; exit 2 ;; esac; \
      case "$device" in cpu|gpu) ;; *) echo "unsupported device: $device" >&2; exit 2 ;; esac; \
      if command -v pnpm >/dev/null 2>&1; then PNPM_CMD=pnpm; \
      elif command -v corepack >/dev/null 2>&1; then PNPM_CMD="corepack pnpm"; \
      else echo "pnpm or corepack not found on PATH" >&2; exit 127; fi; \
      smoke_dir="$(TMPDIR=/tmp mktemp -d)"; \
      smoke_script="$smoke_dir/$(basename "$fixture")"; \
      token="$(python3 -c "import uuid; print(uuid.uuid4())")"; \
      original_sha="$(sha256sum "$fixture" | cut -d " " -f1)"; \
      cp "$fixture" "$smoke_script"; \
      printf "%s\n" "$token" > "$smoke_dir/.fullmag-smoke-disposable"; \
      sim_pid=""; \
      cleanup() { \
        status=$?; trap - EXIT INT TERM; \
        if [ -n "$sim_pid" ] && kill -0 "$sim_pid" >/dev/null 2>&1; then kill "$sim_pid" >/dev/null 2>&1 || true; wait "$sim_pid" >/dev/null 2>&1 || true; fi; \
        post_sha="$(sha256sum "$fixture" | cut -d " " -f1)"; \
        rm -rf "$smoke_dir"; \
        if [ "$post_sha" != "$original_sha" ]; then echo "original smoke fixture changed: $fixture before=$original_sha after=$post_sha" >&2; exit 1; fi; \
        exit "$status"; \
      }; \
      trap cleanup EXIT INT TERM; \
      PATH="{{local_bin}}:$PATH" \
      FULLMAG_PYTHON="{{repo_python}}" \
      FULLMAG_API_PORT="{{api_port}}" \
      FULLMAG_FDM_EXECUTION="$device" \
      FULLMAG_FEM_EXECUTION="$device" \
      fullmag --dev --web-port "{{web_port}}" --backend "$backend" -i "$smoke_script" \
        > "$smoke_dir/fullmag.log" 2>&1 & \
      sim_pid=$!; \
      api_url="http://localhost:{{api_port}}"; web_url="http://localhost:{{web_port}}/workspace"; \
      for _ in $(seq 1 600); do \
        if curl -fsS "$api_url/v2/sessions/current" >/dev/null 2>&1 && curl -fsS "$web_url" >/dev/null 2>&1; then break; fi; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then tail -n 120 "$smoke_dir/fullmag.log" >&2 || true; exit 1; fi; \
        sleep 0.5; \
      done; \
      curl -fsS "$api_url/v2/sessions/current" >/dev/null; \
      TMPDIR=/tmp \
      CONTROL_ROOM_API_BASE_URL="$api_url" \
      CONTROL_ROOM_URL="$web_url" \
      CONTROL_ROOM_SMOKE_DISPOSABLE_SCRIPT_PATH="$smoke_script" \
      CONTROL_ROOM_SMOKE_DISPOSABLE_FIXTURE_TOKEN="$token" \
      $PNPM_CMD --dir apps/control-room smoke:viewport-3d'

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
          --build|build) build="$value_lc" ;; \
          --force|force) if [ "$key" = "$raw" ]; then force="true"; else force="$value_lc"; fi ;; \
          --frontend|frontend|ui) frontend="$value_lc" ;; \
          --backend|--discretization|--engine|backend|discretization|engine) backend="$value_lc" ;; \
          --device|--execution|device|execution) device="$value_lc" ;; \
          --mode|--run_mode|mode|run_mode) run_mode="$value_lc" ;; \
          --script|script) script="$value" ;; \
          --web_port|--web-port|--port|web_port|web-port|port) web_port="$value" ;; \
          --static|static) frontend="static" ;; \
          --dev|dev) frontend="dev" ;; \
          --fem|fem) backend="fem" ;; \
          --fdm|fdm) backend="fdm" ;; \
          --auto|auto) backend="auto" ;; \
          --gpu|gpu) device="gpu" ;; \
          --cpu|cpu) device="cpu" ;; \
          --interactive|-i|interactive) run_mode="interactive" ;; \
          --headless|headless) run_mode="headless" ;; \
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
        runtime_copy_helper="{{repo_root}}/scripts/lib/runtime_bundle_copy.sh"; \
        test -f "$runtime_copy_helper" || { echo "managed FEM runtime copy helper is missing: $runtime_copy_helper" >&2; exit 2; }; \
        if [ "$force" = "true" ]; then just rebuild-fem-runtime; else just ensure-managed-fem-runtime; fi; \
        bin="{{gpu_runtime_bin}}"; path_prefix=""; \
      else \
        if [ "$force" = "true" ]; then \
          if [ "$backend" = "fdm" ]; then FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 just build fullmag; else just build fullmag; fi; \
        elif [ "$build" = "true" ]; then \
          if [ "$backend" = "fdm" ]; then FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 just build fullmag; else just build fullmag; fi; \
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

_run-hysteresis-waveguide-managed-headless device="cpu":
    just ensure-managed-fem-runtime
    bash -euo pipefail -c '\
      device="{{device}}"; \
      case "$device" in cpu|gpu) ;; *) echo "unsupported FEM execution mode: $device (expected cpu or gpu)" >&2; exit 2 ;; esac; \
      FULLMAG_PYTHON="{{repo_python}}" \
      FULLMAG_FDM_EXECUTION=cpu \
      FULLMAG_FEM_EXECUTION="$device" \
      FULLMAG_RELAX_DEVICE="$device" \
      "{{gpu_runtime_bin}}" \
      examples/hysteresis_waveguide_300x50x10nm.py \
      --backend fem \
      --headless \
      --json'

run-hysteresis-waveguide-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50 FULLMAG_HYSTERESIS_MAX_STEPS=25 \
    just _run-hysteresis-waveguide-managed-headless "{{device}}"

run-hysteresis-waveguide-gpu-smoke:
    just run-hysteresis-waveguide-smoke gpu

run-hysteresis-waveguide-playback-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50 FULLMAG_HYSTERESIS_MAX_STEPS=25 \
    FULLMAG_HYSTERESIS_MAGNETIZATION_STORAGE=every_step \
    just _run-hysteresis-waveguide-managed-headless "{{device}}"

run-hysteresis-waveguide-gpu-playback-smoke:
    just run-hysteresis-waveguide-playback-smoke gpu

verify-hysteresis-playback-artifacts artifacts_dir:
    python3 scripts/verify_hysteresis_playback_artifacts.py "{{artifacts_dir}}"

verify-hysteresis-points-chart-data artifacts_dir:
    python3 scripts/verify_hysteresis_points_chart_data.py "{{artifacts_dir}}"

verify-hysteresis-fdm-playback-runtime:
    just ensure-python
    just build fullmag
    rm -rf .fullmag/reports/hysteresis-fdm-playback-runtime
    mkdir -p .fullmag/reports/hysteresis-fdm-playback-runtime
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" \
    fullmag examples/fdm_hysteresis_snapshot_smoke.py \
      --backend fdm \
      --headless \
      --json \
      --output-dir .fullmag/reports/hysteresis-fdm-playback-runtime/artifacts
    python3 scripts/verify_hysteresis_points_chart_data.py \
      .fullmag/reports/hysteresis-fdm-playback-runtime/artifacts
    python3 scripts/verify_hysteresis_playback_artifacts.py \
      .fullmag/reports/hysteresis-fdm-playback-runtime/artifacts

verify-hysteresis-waveguide-playback-runtime device="cpu":
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm \
      -e PYTHONPATH=/workspace/packages/fullmag-py/src \
      -e FULLMAG_PYTHON=/usr/bin/python3 \
      -e FULLMAG_FDM_EXECUTION=cpu \
      -e FULLMAG_FEM_EXECUTION="{{device}}" \
      -e FULLMAG_RELAX_DEVICE="{{device}}" \
      -e FULLMAG_DISABLE_CHARTS=1 \
      -e FULLMAG_DISABLE_PREVIEW_3D=1 \
      -e FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50 \
      -e FULLMAG_HYSTERESIS_MAX_STEPS=1 \
      -e FULLMAG_HYSTERESIS_MAGNETIZATION_STORAGE=every_step \
      fem-gpu bash -lc 'cd /workspace && \
        rm -rf .fullmag/reports/hysteresis-waveguide-playback-runtime && \
        mkdir -p .fullmag/reports/hysteresis-waveguide-playback-runtime && \
        .fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu \
          examples/hysteresis_waveguide_300x50x10nm.py \
          --backend fem \
          --headless \
          --json \
          --output-dir .fullmag/reports/hysteresis-waveguide-playback-runtime/artifacts && \
        python3 scripts/verify_hysteresis_points_chart_data.py \
          .fullmag/reports/hysteresis-waveguide-playback-runtime/artifacts && \
        python3 scripts/verify_hysteresis_playback_artifacts.py \
          .fullmag/reports/hysteresis-waveguide-playback-runtime/artifacts'

verify-hysteresis-waveguide-playback-data-plane api_url="http://localhost:8081" artifact_dir=".fullmag/reports/hysteresis-waveguide-playback-runtime/artifacts":
    python3 scripts/verify_hysteresis_points_chart_data.py "{{artifact_dir}}"
    python3 scripts/verify_hysteresis_playback_artifacts.py "{{artifact_dir}}"
    python3 scripts/verify_hysteresis_playback_data_plane.py "{{api_url}}" "{{artifact_dir}}"

verify-hysteresis-waveguide-browser-replay device="cpu" api_port="8181" web_port="3191":
    just verify-hysteresis-waveguide-playback-runtime "{{device}}"
    bash -euo pipefail -c '\
      api_port="{{api_port}}"; \
      web_port="{{web_port}}"; \
      api_url="http://localhost:${api_port}"; \
      web_url="http://localhost:${web_port}/workspace"; \
      artifact_dir=".fullmag/reports/hysteresis-waveguide-playback-runtime/artifacts"; \
      if [ ! -d "$artifact_dir" ]; then echo "missing hysteresis artifact dir: $artifact_dir" >&2; exit 2; fi; \
      if command -v pnpm >/dev/null 2>&1; then PNPM_CMD=pnpm; \
      elif command -v corepack >/dev/null 2>&1; then PNPM_CMD="corepack pnpm"; \
      else echo "pnpm or corepack not found on PATH" >&2; exit 127; fi; \
      mkdir -p .fullmag/logs; \
      api_pid=""; web_pid=""; \
      cleanup() { \
        if [ -n "$web_pid" ] && kill -0 "$web_pid" >/dev/null 2>&1; then kill "$web_pid" >/dev/null 2>&1 || true; fi; \
        if [ -n "$api_pid" ] && kill -0 "$api_pid" >/dev/null 2>&1; then kill "$api_pid" >/dev/null 2>&1 || true; fi; \
      }; \
      trap cleanup EXIT INT TERM; \
      FULLMAG_API_PORT="$api_port" CARGO_TARGET_DIR=.fullmag/codex-target cargo +nightly run -p fullmag-api \
        > .fullmag/logs/hysteresis-waveguide-browser-replay-api.log 2>&1 & \
      api_pid=$!; \
      for i in $(seq 1 600); do \
        curl -fsS "$api_url/healthz" >/dev/null 2>&1 && break; \
        if ! kill -0 "$api_pid" >/dev/null 2>&1; then echo "fullmag-api exited early; see .fullmag/logs/hysteresis-waveguide-browser-replay-api.log" >&2; exit 1; fi; \
        sleep 0.2; \
      done; \
      curl -fsS "$api_url/healthz" >/dev/null 2>&1 || { echo "fullmag-api did not become ready at $api_url" >&2; exit 1; }; \
      python3 scripts/verify_hysteresis_playback_data_plane.py "$api_url" "$artifact_dir"; \
      NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL="$api_url" \
      NEXT_PUBLIC_RUNTIME_HTTP_BASE="$api_url" \
      NEXT_PUBLIC_API_URL="$api_url" \
      NEXT_PUBLIC_FULLMAG_API_URL="$api_url" \
      FULLMAG_API_URL="$api_url" \
      FULLMAG_API_PROXY_TARGET="$api_url" \
      $PNPM_CMD --dir apps/control-room dev --hostname 127.0.0.1 --port "$web_port" \
        > .fullmag/logs/hysteresis-waveguide-browser-replay-web.log 2>&1 & \
      web_pid=$!; \
      for i in $(seq 1 600); do \
        curl -fsS "$web_url" >/dev/null 2>&1 && break; \
        if ! kill -0 "$web_pid" >/dev/null 2>&1; then echo "control-room dev server exited early; see .fullmag/logs/hysteresis-waveguide-browser-replay-web.log" >&2; exit 1; fi; \
        sleep 0.2; \
      done; \
      curl -fsS "$web_url" >/dev/null 2>&1 || { echo "control-room did not become ready at $web_url" >&2; exit 1; }; \
      CONTROL_ROOM_URL="$web_url" \
      CONTROL_ROOM_API_BASE_URL="$api_url" \
      NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL="$api_url" \
      CONTROL_ROOM_SMOKE_HYSTERESIS_REPLAY=1 \
      CONTROL_ROOM_SMOKE_HYSTERESIS_REPLAY_ONLY=1 \
      CONTROL_ROOM_SMOKE_HYSTERESIS_STAGE_ID=stage_0 \
      CONTROL_ROOM_SMOKE_HYSTERESIS_POINT_ID=0 \
      CONTROL_ROOM_SMOKE_HYSTERESIS_SNAPSHOT_ID=hysteresis_point_001 \
      CONTROL_ROOM_SMOKE_SKIP_CAMERA_GESTURES=1 \
      $PNPM_CMD --dir apps/control-room smoke:viewport-3d'

run-hysteresis-waveguide-angular-family-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50 FULLMAG_HYSTERESIS_MAX_STEPS=25 \
    FULLMAG_HYSTERESIS_ANGULAR_FAMILY=1 \
    just _run-hysteresis-waveguide-managed-headless "{{device}}"

run-hysteresis-waveguide-gpu-angular-family-smoke:
    just run-hysteresis-waveguide-angular-family-smoke gpu

verify-hysteresis-angular-family-artifacts artifacts_dir:
    python3 scripts/verify_hysteresis_angular_family_artifacts.py "{{artifacts_dir}}"

run-hysteresis-waveguide-projection-benchmark-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=50,0,-50,0,50 FULLMAG_HYSTERESIS_MAX_STEPS=1 \
    FULLMAG_HYSTERESIS_ANGULAR_FAMILY=1 \
    just _run-hysteresis-waveguide-managed-headless "{{device}}"

verify-hysteresis-projection-benchmark artifacts_dir:
    python3 scripts/verify_hysteresis_projection_benchmark.py "{{artifacts_dir}}"

run-hysteresis-waveguide-saturation-limit-smoke device="cpu":
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    FULLMAG_HYSTERESIS_FIELD_VALUES_MT=0 FULLMAG_HYSTERESIS_MAX_STEPS=1 \
    FULLMAG_HYSTERESIS_SATURATION_PROBE=1 \
    FULLMAG_HYSTERESIS_SATURATION_MAX_FIELD_MT=10 \
    FULLMAG_HYSTERESIS_SATURATION_SUSCEPTIBILITY_THRESHOLD=1e-12 \
    FULLMAG_HYSTERESIS_SATURATION_TRANSVERSE_THRESHOLD=1e-12 \
    just _run-hysteresis-waveguide-managed-headless "{{device}}"

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
    just _run-hysteresis-waveguide-managed-headless "{{device}}"

run-hysteresis-waveguide-gpu-minor-loop-smoke:
    just run-hysteresis-waveguide-minor-loop-smoke gpu

verify-hysteresis-minor-loop artifacts_dir:
    python3 scripts/verify_hysteresis_minor_loop_artifacts.py "{{artifacts_dir}}"

run-hysteresis-fdm-macrospin-sw-smoke:
    just ensure-python
    just build fullmag
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_HYSTERESIS_MAX_STEPS=2000 \
    fullmag examples/hysteresis_fdm_macrospin_stoner_wohlfarth.py --backend fdm --headless --json

verify-hysteresis-fdm-macrospin-sw artifacts_dir:
    python3 scripts/verify_hysteresis_fdm_macrospin_sw_artifacts.py "{{artifacts_dir}}"

run-hysteresis-fdm-thinfilm-oop-ip-smoke:
    just ensure-python
    just build fullmag
    FULLMAG_DISABLE_CHARTS=1 FULLMAG_DISABLE_PREVIEW_3D=1 \
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" \
    FULLMAG_HYSTERESIS_MAX_STEPS=200 \
    fullmag examples/hysteresis_fdm_thinfilm_oop_ip_validation.py --backend fdm --headless --json

verify-hysteresis-fdm-thinfilm-oop-ip artifacts_dir:
    python3 scripts/verify_hysteresis_fdm_thinfilm_oop_ip_artifacts.py "{{artifacts_dir}}"

verify-hysteresis-publication-suite manifest:
    python3 scripts/verify_hysteresis_publication_suite.py "{{manifest}}"

verify-hysteresis-metrics-parity manifest:
    python3 scripts/verify_hysteresis_metrics_parity.py "{{manifest}}"

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
      web_port="$(python3 scripts/control_room_port.py pick 0.0.0.0 3100 3101 3102 3103 3006 3007 3008 3009 3010)"; \
      web_public_host="${FULLMAG_WEB_HOST:-}"; \
      if [ -z "$web_public_host" ] && { [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ]; }; then web_public_host="$(hostname -I 2>/dev/null | awk "{ for (i = 1; i <= NF; i++) if (\$i !~ /:/) { print \$i; exit } }")"; fi; \
      if [ -z "$web_public_host" ]; then web_public_host="localhost"; fi; \
      browser_api_url="http://${web_public_host}:8081"; \
      web_url="http://${web_public_host}:${web_port}"; \
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
      echo "Freeing ports ${web_port} and 8081 ..." >&2; \
      fuser -k "${web_port}/tcp" 2>/dev/null || true; \
      fuser -k 8081/tcp 2>/dev/null || true; \
      pkill -9 -f "fullmag-fem-gpu-bi[n]" >/dev/null 2>&1 || true; \
      pkill -9 -f "fullmag-ap[i]" >/dev/null 2>&1 || true; \
      pkill -9 -f "helper.p[y]" >/dev/null 2>&1 || true; \
      rm -rf apps/control-room/.next/dev; \
      mkdir -p .fullmag/logs; \
      echo "Starting v2 control room on :${web_port} ..." >&2; \
      NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL="$browser_api_url" \
      NEXT_PUBLIC_RUNTIME_HTTP_BASE="$browser_api_url" \
      NEXT_PUBLIC_API_URL="$browser_api_url" \
      NEXT_PUBLIC_FULLMAG_API_URL="$browser_api_url" \
      FULLMAG_API_URL="$api_url" \
      FULLMAG_API_PROXY_TARGET="$api_url" \
      FULLMAG_WEB_PUBLIC_HOST="$web_public_host" \
      $PNPM_CMD --dir apps/control-room dev --hostname 0.0.0.0 --port "$web_port" \
        >.fullmag/logs/control-room-v2.log 2>&1 & \
      printf "%s\n" "$web_url" > .fullmag/control-room-url.txt; \
      printf "%s\n" "$web_url" > .fullmag/control-room-v2-url.txt; \
      printf "dev\n" > .fullmag/control-room-mode.txt; \
      echo "Waiting for v2 frontend (/workspace) on :${web_port} (up to 120s) ..." >&2; \
      for i in $(seq 1 600); do \
        curl -fsS "http://localhost:${web_port}/workspace" >/dev/null 2>&1 && break; \
        sleep 0.2; \
      done; \
      if ! curl -fsS "http://localhost:${web_port}/workspace" >/dev/null 2>&1; then \
        echo "v2 frontend did not become ready on :${web_port}" >&2; \
        echo "Log: $(pwd)/.fullmag/logs/control-room-v2.log" >&2; \
        exit 1; \
      fi; \
      echo "v2 frontend ready on ${web_url}/workspace - launching simulation ..." >&2; \
      physical_cores=$(lscpu -p=CORE 2>/dev/null | grep "^[0-9]" | sort -u | wc -l || echo ""); \
      cpu_threads="${physical_cores:-auto}"; \
      if [ -z "$cpu_threads" ] || [ "$cpu_threads" = "0" ]; then cpu_threads="auto"; fi; \
      if [ "$cpu_threads" != "auto" ] && [ "$cpu_threads" -gt 8 ]; then cpu_threads=8; fi; \
      echo "cpu_threads=$cpu_threads (capped at 8 for WSL memory stability)" >&2; \
      FULLMAG_DISABLE_STATIC_CONTROL_ROOM=1 just run-arch-waveguide-interactive-managed "$mode" "$cpu_threads" "$web_port"'



run-nanoflower-interactive-quadro:
    just ensure-python
    just build fullmag-dev
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag --dev -i examples/nanoflower_fem_quadro.py

# Run nanoflower quadro on the managed GPU runtime (MFEM + CUDA, built via Docker).
# Run `just rebuild-gpu-runtime` if the binary is stale or after source changes.
gpu_runtime_bin := repo_root + "/.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu"
gpu_runtime_manifest := repo_root + "/.fullmag/runtimes/fem-gpu-host/manifest.json"

validate-fem-gpu-runtime-variant variant:
    variant_root=".fullmag/runtimes/fem-gpu-variants/{{variant}}"; \
      if [ ! -d "$variant_root" ]; then \
        echo "Managed FEM runtime variant is missing: $variant_root" >&2; \
        exit 2; \
      fi; \
      python3 scripts/validate_managed_fem_runtime_bundle.py --runtime-root "$variant_root"

select-fem-gpu-runtime-variant variant:
    just validate-fem-gpu-runtime-variant "{{variant}}"
    active=".fullmag/runtimes/fem-gpu-host"; \
      if [ -e "$active" ] && [ ! -L "$active" ]; then \
        echo "Refusing to replace non-symlink managed FEM runtime: $active" >&2; \
        exit 2; \
      fi; \
      next=".fullmag/runtimes/.fem-gpu-host.next.$$"; \
      ln -sfn "fem-gpu-variants/{{variant}}" "$next"; \
      mv -Tf "$next" "$active"
    python3 scripts/validate_managed_fem_runtime_bundle.py --runtime-root .fullmag/runtimes/fem-gpu-host

restore-fem-gpu-runtime-variant variant:
    just select-fem-gpu-runtime-variant "{{variant}}"

build-fem-gpu-task6-runner-harness candidate_variant:
    bash scripts/build_managed_fem_gpu_runner_harness.sh "{{candidate_variant}}"

benchmark-fem-gpu-runtime-architecture-ab baseline_variant candidate_variant runner output_dir:
    python3 scripts/analysis/benchmark_fem_gpu_runtime_architectures.py \
      --baseline-variant "{{baseline_variant}}" \
      --candidate-variant "{{candidate_variant}}" \
      --runner "{{runner}}" \
      --output-dir "{{output_dir}}"

migrate-active-fem-gpu-runtime-to-variant exact_copy_variant selected_variant:
    active=".fullmag/runtimes/fem-gpu-host"; \
      exact_copy=".fullmag/runtimes/fem-gpu-variants/{{exact_copy_variant}}"; \
      selected=".fullmag/runtimes/fem-gpu-variants/{{selected_variant}}"; \
      if [ ! -d "$active" ] || [ -L "$active" ]; then \
        echo "Active managed FEM runtime must be a directory for one-time migration: $active" >&2; \
        exit 2; \
      fi; \
      if [ ! -d "$exact_copy" ]; then \
        echo "Exact preserved FEM runtime copy is missing: $exact_copy" >&2; \
        exit 2; \
      fi; \
      python3 scripts/validate_managed_fem_runtime_bundle.py --runtime-root "$active" --compare-exact "$exact_copy"; \
      just validate-fem-gpu-runtime-variant "{{selected_variant}}"; \
      backup="${active}.directory-backup.$(date -u +%Y%m%dT%H%M%SZ)"; \
      if [ -e "$backup" ]; then \
        echo "Migration backup already exists: $backup" >&2; \
        exit 2; \
      fi; \
      mv "$active" "$backup"; \
      next=".fullmag/runtimes/.fem-gpu-host.next.$$"; \
      ln -sfn "fem-gpu-variants/{{selected_variant}}" "$next"; \
      if ! mv -Tf "$next" "$active" || ! python3 scripts/validate_managed_fem_runtime_bundle.py --runtime-root "$active"; then \
        if [ -L "$active" ]; then mv "$active" "${active}.failed-symlink.$$"; fi; \
        mv "$backup" "$active"; \
        exit 2; \
      fi; \
      echo "Preserved original active runtime directory at: $backup"

restore-active-fem-gpu-runtime-directory-backup backup_name:
    active=".fullmag/runtimes/fem-gpu-host"; \
      backup=".fullmag/runtimes/{{backup_name}}"; \
      if [ ! -L "$active" ]; then \
        echo "Active managed FEM runtime must be a symlink before directory restore: $active" >&2; \
        exit 2; \
      fi; \
      if [ ! -d "$backup" ] || [ -L "$backup" ]; then \
        echo "Managed FEM runtime directory backup is missing: $backup" >&2; \
        exit 2; \
      fi; \
      previous_link="${active}.variant-link-backup.$(date -u +%Y%m%dT%H%M%SZ)"; \
      mv "$active" "$previous_link"; \
      mv "$backup" "$active"; \
      test -x "$active/bin/fullmag-fem-gpu"; \
      test -f "$active/manifest.json"; \
      echo "Preserved previous active variant symlink at: $previous_link"

run-nanoflower-interactive-quadro-gpu:
    just ensure-python
    just build fullmag-dev
    FULLMAG_PYTHON="{{repo_python}}" '{{gpu_runtime_bin}}' --dev -i examples/nanoflower_fem_quadro.py

ensure-managed-fem-runtime:
    bash -euo pipefail -c '\
      runtime_copy_helper="{{repo_root}}/scripts/lib/runtime_bundle_copy.sh"; \
      test -f "$runtime_copy_helper" || { echo "managed FEM runtime copy helper is missing: $runtime_copy_helper" >&2; exit 2; }; \
      identity_file="$(mktemp "${TMPDIR:-/tmp}/fullmag-current-source.XXXXXXXXXX.json")"; \
      trap '\''rm -f -- "$identity_file"'\'' EXIT; \
      python3 scripts/capture_source_snapshot_identity.py --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --output "$identity_file"; \
      git_commit="$(python3 -c '\''import json,sys; print(json.load(open(sys.argv[1]))["head_commit_full"])'\'' "$identity_file")"; \
      worktree_state="$(python3 -c '\''import json,sys; print("dirty" if json.load(open(sys.argv[1]))["source_snapshot_dirty"] else "clean")'\'' "$identity_file")"; \
      source_snapshot="$(python3 -c '\''import json,sys; print(json.load(open(sys.argv[1]))["source_snapshot_sha256"])'\'' "$identity_file")"; \
      runtime_rebuilt=0; \
      runtime_reused_for_non_runtime_changes=0; \
      validate_current() { \
        python3 scripts/validate_managed_fem_runtime_bundle.py \
          --runtime-root .fullmag/runtimes/fem-gpu-host \
          --require-git-commit "$git_commit" \
          --require-worktree-state "$worktree_state" \
          --require-source-snapshot-sha256 "$source_snapshot"; \
      }; \
      if [ ! -x "{{gpu_runtime_bin}}" ] || [ ! -f "{{gpu_runtime_manifest}}" ]; then \
        echo "Managed FEM runtime bundle is missing or incomplete; restoring the persistent build first." >&2; \
        bash scripts/restore_persistent_fem_runtime.sh || true; \
      fi; \
      if ! validate_current >/dev/null 2>&1; then \
        echo "Managed FEM runtime bundle is invalid; restoring the persistent build first. Exact source mismatch will rebuild." >&2; \
        bash scripts/restore_persistent_fem_runtime.sh >/dev/null 2>&1 || true; \
        if ! validate_current >/dev/null 2>&1; then \
          if python3 scripts/runtime_source_change_policy.py \
              --repo-root "{{repo_root}}" \
              --runtime-root .fullmag/runtimes/fem-gpu-host \
              --identity "$identity_file"; then \
            echo "Managed FEM runtime source differs only in documentation, CI, tests, or packaging helpers; reusing the validated binary." >&2; \
            python3 scripts/validate_managed_fem_runtime_bundle.py \
              --runtime-root .fullmag/runtimes/fem-gpu-host; \
            runtime_reused_for_non_runtime_changes=1; \
          else \
            FULLMAG_ALLOW_DIRTY_RUNTIME_EXPORT=1 FULLMAG_FEM_RUNTIME_REUSE_BUILD=1 just rebuild-fem-runtime; \
            runtime_rebuilt=1; \
          fi; \
        fi; \
      fi; \
      if [ ! -x "{{gpu_runtime_bin}}" ] || [ ! -f "{{gpu_runtime_manifest}}" ]; then \
        echo "Managed FEM runtime rebuild did not produce {{gpu_runtime_bin}} and {{gpu_runtime_manifest}}" >&2; \
        exit 2; \
      fi; \
      python3 scripts/capture_source_snapshot_identity.py --repo-root "{{repo_root}}" --ignore-non-runtime-dirty --compare "$identity_file" --allow-source-drift; \
      if [ "${FULLMAG_RUNTIME_PRUNE:-1}" = "1" ]; then \
        bash scripts/prune_managed_fem_runtimes.sh; \
      fi; \
      if [ "$runtime_rebuilt" = "1" ] || [ "$runtime_reused_for_non_runtime_changes" = "1" ]; then \
        python3 scripts/validate_managed_fem_runtime_bundle.py \
          --runtime-root .fullmag/runtimes/fem-gpu-host; \
      else \
        validate_current; \
      fi'

verify-managed-fem-runtime-source-provenance:
    tmp_provenance="$(mktemp "${TMPDIR:-/tmp}/fullmag-fem-runtime-source-provenance.XXXXXXXXXX.json")"; trap 'rm -f -- "$tmp_provenance"' EXIT; \
    python3 scripts/hash_managed_fem_runtime_sources.py --repo-root . --source-input-manifest scripts/managed_fem_runtime_source_inputs.v1.txt --output "$tmp_provenance"; \
    python3 -c 'import json, sys; from pathlib import Path; expected=json.loads(Path(sys.argv[1]).read_text())["source_provenance"]; actual=json.loads(Path(".fullmag/runtimes/fem-gpu-host/manifest.json").read_text()).get("source_provenance"); assert actual == expected, "managed FEM runtime source provenance differs; run: just rebuild-fem-runtime"' "$tmp_provenance"; \
    python3 scripts/validate_managed_fem_runtime_bundle.py --runtime-root .fullmag/runtimes/fem-gpu-host

inspect-managed-fem-frequency-domain-deps:
    just ensure-managed-fem-runtime
    docker compose --profile fem-gpu run --rm -T \
      fem-gpu bash -lc 'printf "PETSc version: "; pkg-config --modversion PETSc; printf "SLEPc version: "; pkg-config --modversion SLEPc; printf "PETSc pkg-config dir: "; pkg-config --variable=pcfiledir PETSc; printf "SLEPc pkg-config dir: "; pkg-config --variable=pcfiledir SLEPc'
    python3 -c 'import json; from pathlib import Path; manifest = json.loads(Path(".fullmag/runtimes/fem-gpu-host/manifest.json").read_text()); deps = manifest.get("frequency_domain_dependencies", {}); print("Manifest modal_eigen_native_cpu_slepc_available: " + str(deps.get("modal_eigen_native_cpu_slepc_available"))); print("Manifest PETSc version: " + deps.get("petsc_version", "")); print("Manifest SLEPc version: " + deps.get("slepc_version", "")); print("Manifest PETSc pkg-config dir: " + deps.get("petsc_pkgconfig_dir", "")); print("Manifest SLEPc pkg-config dir: " + deps.get("slepc_pkgconfig_dir", "")); print("Manifest exported runtime library paths:"); [print("  " + path) for path in deps.get("exported_runtime_library_paths", [])]; print("Manifest exported CMake module paths:"); [print("  " + path) for path in deps.get("exported_cmake_module_paths", [])]'

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

run-cofeb-rings-relax-diagnostics fem_execution="gpu" cpu_threads="auto" web_port="3192" scenario="viewport-3d" api_port="8194":
    just ensure-python
    just ensure-managed-fem-runtime
    bash -euo pipefail -c '\
      mode="{{fem_execution}}"; \
      case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
      if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
      if command -v pnpm >/dev/null 2>&1; then PNPM_CMD=pnpm; \
      elif command -v corepack >/dev/null 2>&1; then PNPM_CMD="corepack pnpm"; \
      else echo "pnpm or corepack not found on PATH" >&2; exit 127; fi; \
      report_dir="{{repo_root}}/.fullmag/reports/cofeb-rings-relax-diagnostics"; \
      artifact_root="$report_dir/browser"; \
      app_log="$report_dir/fullmag-interactive.log"; \
      recorder_log="$report_dir/diagnostic-recorder.log"; \
      mkdir -p "$artifact_root"; \
      sim_pid=""; \
      cleanup() { \
        if [ -n "$sim_pid" ] && kill -0 "$sim_pid" >/dev/null 2>&1; then \
          kill "$sim_pid" >/dev/null 2>&1 || true; \
          wait "$sim_pid" >/dev/null 2>&1 || true; \
        fi; \
      }; \
      trap cleanup EXIT INT TERM; \
      FULLMAG_PYTHON="{{repo_python}}" \
      FULLMAG_FDM_EXECUTION=cpu \
      FULLMAG_FEM_EXECUTION="$mode" \
      FULLMAG_RELAX_DEVICE="$mode" \
      FULLMAG_API_PORT="{{api_port}}" \
      FULLMAG_CPU_THREADS="$cpu_threads_env" \
      FULLMAG_COFEB_RINGS_MINIMIZE_MAX_STEPS="${FULLMAG_COFEB_RINGS_MINIMIZE_MAX_STEPS:-10}" \
      FULLMAG_COFEB_RINGS_RELAX_MAX_STEPS="${FULLMAG_COFEB_RINGS_RELAX_MAX_STEPS:-10}" \
      "{{gpu_runtime_bin}}" --dev --web-port "{{web_port}}" -i examples/permalloy_layer_cofeb_rings_relax_300nm.py \
        > "$app_log" 2>&1 & \
      sim_pid=$!; \
      web_url="http://localhost:{{web_port}}/workspace"; \
      for _ in $(seq 1 600); do \
        curl -fsS "$web_url" >/dev/null 2>&1 && break; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then \
          echo "CoFeB rings simulation exited before control room became ready; see $app_log" >&2; \
          tail -n 120 "$app_log" >&2 || true; \
          exit 1; \
        fi; \
        sleep 0.5; \
      done; \
      curl -fsS "$web_url" >/dev/null 2>&1 || { echo "control room did not become ready at $web_url; see $app_log" >&2; exit 1; }; \
      CONTROL_ROOM_URL="$web_url" \
      CONTROL_ROOM_API_BASE_URL="http://localhost:{{api_port}}" \
      CONTROL_ROOM_DIAGNOSTICS_SCENARIO="{{scenario}}" \
      CONTROL_ROOM_DIAGNOSTICS_OUTPUT_DIR="$artifact_root" \
      CONTROL_ROOM_DIAGNOSTICS_TIMEOUT_MS="${CONTROL_ROOM_DIAGNOSTICS_TIMEOUT_MS:-180000}" \
      CONTROL_ROOM_DIAGNOSTICS_CANVAS_TIMEOUT_MS="${CONTROL_ROOM_DIAGNOSTICS_CANVAS_TIMEOUT_MS:-180000}" \
      $PNPM_CMD --dir apps/control-room diagnostics:record | tee "$recorder_log"; \
      artifact_dir="$(sed -n "s/^Diagnostic artifact: //p" "$recorder_log" | tail -n 1)"; \
      if [ -z "$artifact_dir" ] || [ ! -f "$artifact_dir/summary.json" ]; then \
        echo "diagnostic recorder did not produce a readable artifact; see $recorder_log" >&2; \
        exit 1; \
      fi; \
      stages_url="${web_url%/workspace}/v2/sessions/current/simulation/stages/execution"; \
      stages_terminal=false; \
      for _ in $(seq 1 600); do \
        stage_json="$(curl -fsS "$stages_url" 2>/dev/null || true)"; \
        if [ -n "$stage_json" ] && node -e '\''const x=JSON.parse(process.argv[1]); const s=x.stages??[]; process.exit(s.length>0&&s.every(v=>["completed","failed","cancelled","rejected","skipped"].includes(v.status))?0:1)'\'' "$stage_json"; then stages_terminal=true; break; fi; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then break; fi; \
        sleep 0.5; \
      done; \
      if [ "$stages_terminal" != true ]; then \
        echo "CoFeB rings published stages did not reach terminal state; see $app_log" >&2; \
        tail -n 120 "$app_log" >&2 || true; \
        exit 1; \
      fi; \
      printf "\nCoFeB rings diagnostic logs:\n"; \
      printf "  fullmag: %s\n" "$app_log"; \
      printf "  recorder: %s\n" "$recorder_log"; \
      printf "  artifact: %s\n" "$artifact_dir"; \
      node -e '\''const fs=require("fs"); const dir=process.argv[1]; const summary=JSON.parse(fs.readFileSync(`${dir}/summary.json`,"utf8")); const report=fs.readFileSync(`${dir}/suspect-report.md`,"utf8").split("\n").slice(0,28).join("\n"); console.log(`  records: ${summary.recordCount}, warnings: ${summary.warningCount}, critical: ${summary.criticalCount}, dropped: ${summary.droppedCount}`); console.log(report);'\'' "$artifact_dir"'

run-cofeb-rings-relax-mixed-target-smoke fem_execution="gpu" cpu_threads="auto" web_port="3193" api_port="8195":
    just ensure-python
    just ensure-managed-fem-runtime
    bash -euo pipefail -c '\
      mode="{{fem_execution}}"; \
      case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
      if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
      if command -v pnpm >/dev/null 2>&1; then PNPM_CMD=pnpm; \
      elif command -v corepack >/dev/null 2>&1; then PNPM_CMD="corepack pnpm"; \
      else echo "pnpm or corepack not found on PATH" >&2; exit 127; fi; \
      report_dir="{{repo_root}}/.fullmag/reports/cofeb-rings-relax-mixed-target-smoke"; \
      app_log="$report_dir/fullmag-interactive.log"; \
      smoke_log="$report_dir/mixed-target-smoke.log"; \
      mkdir -p "$report_dir"; \
      sim_pid=""; \
      cleanup() { \
        if [ -n "$sim_pid" ] && kill -0 "$sim_pid" >/dev/null 2>&1; then \
          kill "$sim_pid" >/dev/null 2>&1 || true; \
          wait "$sim_pid" >/dev/null 2>&1 || true; \
        fi; \
      }; \
      trap cleanup EXIT INT TERM; \
      FULLMAG_PYTHON="{{repo_python}}" \
      FULLMAG_FDM_EXECUTION=cpu \
      FULLMAG_FEM_EXECUTION="$mode" \
      FULLMAG_RELAX_DEVICE="$mode" \
      FULLMAG_API_PORT="{{api_port}}" \
      FULLMAG_CPU_THREADS="$cpu_threads_env" \
      FULLMAG_COFEB_RINGS_MINIMIZE_MAX_STEPS="${FULLMAG_COFEB_RINGS_MINIMIZE_MAX_STEPS:-10}" \
      FULLMAG_COFEB_RINGS_RELAX_MAX_STEPS="${FULLMAG_COFEB_RINGS_RELAX_MAX_STEPS:-10}" \
      "{{gpu_runtime_bin}}" --dev --web-port "{{web_port}}" -i examples/permalloy_layer_cofeb_rings_relax_300nm.py \
        > "$app_log" 2>&1 & \
      sim_pid=$!; \
      web_url="http://localhost:{{web_port}}/workspace"; \
      api_url="http://localhost:{{api_port}}"; \
      for _ in $(seq 1 600); do \
        curl -fsS "$web_url" >/dev/null 2>&1 && break; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then \
          echo "CoFeB rings simulation exited before control room became ready; see $app_log" >&2; \
          tail -n 120 "$app_log" >&2 || true; \
          exit 1; \
        fi; \
        sleep 0.5; \
      done; \
      curl -fsS "$web_url" >/dev/null 2>&1 || { echo "control room did not become ready at $web_url; see $app_log" >&2; exit 1; }; \
      CONTROL_ROOM_URL="$web_url" \
      CONTROL_ROOM_API_BASE_URL="$api_url" \
      CONTROL_ROOM_MIXED_TARGET_SMOKE_TIMEOUT_MS="${CONTROL_ROOM_MIXED_TARGET_SMOKE_TIMEOUT_MS:-600000}" \
      $PNPM_CMD --dir apps/control-room smoke:viewport-3d-mixed-targets | tee "$smoke_log"; \
      printf "\nCoFeB rings mixed-target smoke logs:\n"; \
      printf "  fullmag: %s\n" "$app_log"; \
      printf "  smoke: %s\n" "$smoke_log"'

_run-viewport-3d-browser-smoke fixture smoke_script report_name smoke_log_name smoke_label max_steps_env max_steps_default smoke_timeout_env smoke_timeout_default fem_execution="gpu" cpu_threads="auto" web_port="3193" api_port="8193":
    just ensure-python
    just ensure-managed-fem-runtime
    bash -euo pipefail -c '\
      mode="{{fem_execution}}"; \
      case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
      if [ "{{cpu_threads}}" = "auto" ]; then cpu_threads_env=auto; else cpu_threads_env="{{cpu_threads}}"; fi; \
      api_url="http://localhost:{{api_port}}"; \
      max_steps="$(printenv "{{max_steps_env}}" || true)"; \
      if [ -z "$max_steps" ]; then max_steps="{{max_steps_default}}"; fi; \
      smoke_timeout="$(printenv "{{smoke_timeout_env}}" || true)"; \
      if [ -z "$smoke_timeout" ]; then smoke_timeout="{{smoke_timeout_default}}"; fi; \
      if command -v pnpm >/dev/null 2>&1; then PNPM_CMD=pnpm; \
      elif command -v corepack >/dev/null 2>&1; then PNPM_CMD="corepack pnpm"; \
      else echo "pnpm or corepack not found on PATH" >&2; exit 127; fi; \
      report_dir="{{repo_root}}/.fullmag/reports/{{report_name}}"; \
      app_log="$report_dir/fullmag-interactive.log"; \
      smoke_log="$report_dir/{{smoke_log_name}}"; \
      mkdir -p "$report_dir"; \
      sim_pid=""; \
      cleanup() { \
        if [ -n "$sim_pid" ] && kill -0 "$sim_pid" >/dev/null 2>&1; then \
          kill "$sim_pid" >/dev/null 2>&1 || true; \
          wait "$sim_pid" >/dev/null 2>&1 || true; \
        fi; \
      }; \
      trap cleanup EXIT INT TERM; \
      FULLMAG_PYTHON="{{repo_python}}" \
      FULLMAG_FDM_EXECUTION=cpu \
      FULLMAG_FEM_EXECUTION="$mode" \
      FULLMAG_RELAX_DEVICE="$mode" \
      FULLMAG_CPU_THREADS="$cpu_threads_env" \
      FULLMAG_API_PORT="{{api_port}}" \
      {{max_steps_env}}="$max_steps" \
      "{{gpu_runtime_bin}}" --dev --web-port "{{web_port}}" -i "{{fixture}}" \
        > "$app_log" 2>&1 & \
      sim_pid=$!; \
      web_url="http://localhost:{{web_port}}/workspace"; \
      for _ in $(seq 1 600); do \
        curl -fsS "$web_url" >/dev/null 2>&1 && break; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then \
          echo "{{smoke_label}} fixture exited before control room became ready; see $app_log" >&2; \
          tail -n 120 "$app_log" >&2 || true; \
          exit 1; \
        fi; \
        sleep 0.5; \
      done; \
      curl -fsS "$web_url" >/dev/null 2>&1 || { echo "control room did not become ready at $web_url; see $app_log" >&2; exit 1; }; \
      if ! kill -0 "$sim_pid" >/dev/null 2>&1; then \
        echo "Viewport 3D mixed-target fixture exited before smoke started; see $app_log" >&2; \
        tail -n 120 "$app_log" >&2 || true; \
        exit 1; \
      fi; \
      CONTROL_ROOM_API_BASE_URL="$api_url" \
      CONTROL_ROOM_URL="$web_url" \
      {{smoke_timeout_env}}="$smoke_timeout" \
      $PNPM_CMD --dir apps/control-room "{{smoke_script}}" | tee "$smoke_log"; \
      printf "\n{{smoke_label}} logs:\n"; \
      printf "  fullmag: %s\n" "$app_log"; \
      printf "  smoke: %s\n" "$smoke_log"'

run-viewport-3d-mixed-target-smoke fem_execution="gpu" cpu_threads="auto" web_port="3193" api_port="8193":
    just _run-viewport-3d-browser-smoke "examples/viewport_3d_mixed_targets_smoke.py" "smoke:viewport-3d-mixed-targets" "viewport-3d-mixed-target-smoke" "mixed-target-smoke.log" "Viewport 3D mixed-target smoke" "FULLMAG_VIEWPORT3D_MIXED_TARGET_MAX_STEPS" "2000" "CONTROL_ROOM_MIXED_TARGET_SMOKE_TIMEOUT_MS" "180000" "{{fem_execution}}" "{{cpu_threads}}" "{{web_port}}" "{{api_port}}"

run-viewport-3d-mixed-topology-smoke fem_execution="gpu" cpu_threads="auto" web_port="3195" api_port="8196":
    just _run-viewport-3d-browser-smoke "examples/viewport_3d_mixed_topology_smoke.py" "smoke:viewport-3d-mixed-topology" "viewport-3d-mixed-topology-smoke" "mixed-topology-smoke.log" "Viewport 3D mixed-topology smoke" "FULLMAG_VIEWPORT3D_MIXED_TOPOLOGY_MAX_STEPS" "50" "CONTROL_ROOM_MIXED_TOPOLOGY_SMOKE_TIMEOUT_MS" "180000" "{{fem_execution}}" "{{cpu_threads}}" "{{web_port}}" "{{api_port}}"

run-viewport-2d-planar-monitor-smoke backend="fdm" device="cpu" web_port="3194" api_port="8194":
    just ensure-python
    just ensure-managed-fem-runtime
    bash -euo pipefail -c '\
      backend="{{backend}}"; \
      device="{{device}}"; \
      case "$backend" in fdm|fem) ;; *) echo "unsupported backend: $backend (expected fdm or fem)" >&2; exit 2 ;; esac; \
      case "$device" in cpu|gpu) ;; *) echo "unsupported device: $device (expected cpu or gpu)" >&2; exit 2 ;; esac; \
      if [ "$backend" = "fdm" ] && [ "$device" != "cpu" ]; then echo "the managed FDM planar smoke currently qualifies cpu only" >&2; exit 2; fi; \
      if command -v pnpm >/dev/null 2>&1; then PNPM_CMD=pnpm; \
      elif command -v corepack >/dev/null 2>&1; then PNPM_CMD="corepack pnpm"; \
      else echo "pnpm or corepack not found on PATH" >&2; exit 127; fi; \
      fixture="examples/viewport_2d_planar_monitor_${backend}_smoke.py"; \
      report_dir="{{repo_root}}/.fullmag/reports/viewport-2d-planar-monitor-smoke/${backend}-${device}"; \
      browser_dir="$report_dir/browser"; \
      runtime_log="$report_dir/runtime.log"; \
      browser_log="$report_dir/browser.log"; \
      science_report="$report_dir/science-report.json"; \
      mkdir -p "$browser_dir"; \
      sim_pid=""; \
      cleanup() { \
        if [ -n "$sim_pid" ] && kill -0 "$sim_pid" >/dev/null 2>&1; then \
          kill "$sim_pid" >/dev/null 2>&1 || true; \
          wait "$sim_pid" >/dev/null 2>&1 || true; \
        fi; \
      }; \
      trap cleanup EXIT INT TERM; \
      FULLMAG_PYTHON="{{repo_python}}" \
      FULLMAG_PLANAR_DEVICE="$device" \
      FULLMAG_FDM_EXECUTION="$device" \
      FULLMAG_FEM_EXECUTION="$device" \
      FULLMAG_RELAX_DEVICE="$device" \
      FULLMAG_API_PORT="{{api_port}}" \
      NEXT_PUBLIC_AUDIT_BUILD=1 \
      "{{gpu_runtime_bin}}" --dev --web-port "{{web_port}}" -i "$fixture" \
        > "$runtime_log" 2>&1 & \
      sim_pid=$!; \
      api_url="http://localhost:{{api_port}}"; \
      web_url="http://localhost:{{web_port}}/workspace"; \
      for _ in $(seq 1 600); do \
        if curl -fsS "$api_url/v2/sessions/current/model/planar-monitors" >/dev/null 2>&1 && curl -fsS "$web_url" >/dev/null 2>&1; then break; fi; \
        if ! kill -0 "$sim_pid" >/dev/null 2>&1; then \
          echo "planar fixture exited before API/workspace became ready; see $runtime_log" >&2; \
          tail -n 120 "$runtime_log" >&2 || true; \
          exit 1; \
        fi; \
        sleep 0.5; \
      done; \
      curl -fsS "$api_url/v2/sessions/current/model/planar-monitors" >/dev/null || { echo "planar API did not become ready; see $runtime_log" >&2; exit 1; }; \
      "{{repo_python}}" scripts/analysis/validate_planar_monitor_sampling.py \
        --api-base "$api_url" --backend "$backend" --device "$device" --output "$science_report"; \
      CONTROL_ROOM_API_BASE_URL="$api_url" \
      CONTROL_ROOM_URL="$web_url" \
      CONTROL_ROOM_PLANAR_BACKEND="$backend" \
      CONTROL_ROOM_PLANAR_OUTPUT_DIR="$browser_dir" \
      $PNPM_CMD --dir apps/control-room smoke:viewport-2d | tee "$browser_log"; \
      printf "\nViewport 2D planar-monitor reports:\n"; \
      printf "  runtime: %s\n" "$runtime_log"; \
      printf "  browser: %s\n" "$browser_log"; \
      printf "  science: %s\n" "$science_report"'

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

fem-managed-headless fem_execution script output_dir="":
    if [ -z "${FULLMAG_PYTHON:-}" ]; then just ensure-python; fi
    just ensure-managed-fem-runtime
    managed_python="${FULLMAG_PYTHON:-{{repo_python}}}"; mode="{{fem_execution}}"; output_dir="{{output_dir}}"; output_args=(); \
    if [ ! -x "$managed_python" ]; then echo "managed FEM Python interpreter is not executable: $managed_python" >&2; exit 2; fi; \
    case "$mode" in 0|cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported FEM execution mode: $mode (expected cpu or gpu)" >&2; exit 2 ;; esac; \
    if [ -n "$output_dir" ]; then output_args=(--output-dir "$output_dir" --workspace-root "$output_dir/workspace-history"); fi; \
    FULLMAG_PYTHON="$managed_python" \
    FULLMAG_FDM_EXECUTION=cpu \
    FULLMAG_FEM_EXECUTION="$mode" \
    FULLMAG_RELAX_DEVICE="$mode" \
    FULLMAG_CPU_THREADS=auto \
    '{{gpu_runtime_bin}}' {{script}} --backend fem --headless --json "${output_args[@]}"

fem-sp4-run fem_execution output_dir:
    just ensure-python
    just ensure-managed-fem-runtime
    mode="{{fem_execution}}"; case "$mode" in cpu|CPU) mode="cpu" ;; gpu|GPU) mode="gpu" ;; *) echo "unsupported SP4 FEM device: $mode" >&2; exit 2 ;; esac; \
    FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION="$mode" FULLMAG_RELAX_DEVICE="$mode" FULLMAG_CPU_THREADS=auto \
    '{{gpu_runtime_bin}}' tests/standard_problems/mumag/sp4/fem/problem.py --backend fem --headless --json --output-dir "{{output_dir}}"

fem-sp4-scenario device script attempt_id build="false" ledger=".fullmag/reports/standard-problems/mumag/sp4/fem/ledger/results.csv":
    bash scripts/run_fem_sp4_scenario.sh "{{device}}" "{{script}}" "{{attempt_id}}" "{{build}}" "{{ledger}}"

verify-fem-standard-problem-4:
    just verify-fem-time-domain-native-contract
    just ensure-managed-fem-runtime
    FULLMAG_SP4_QUALIFYING=1 ./scripts/verify_fem_standard_problem_4.sh

verify-fem-standard-problem-4-smoke:
    just verify-fem-time-domain-native-contract
    just ensure-managed-fem-runtime
    FULLMAG_SP4_QUALIFYING=0 FULLMAG_SP4_DEVICES="cpu gpu" FULLMAG_SP4_RELAX_ALGORITHMS=llg_overdamped FULLMAG_SP4_MESH_LEVELS=coarse FULLMAG_SP4_CASES="case-a case-b" FULLMAG_SP4_AIRBOXES=baseline FULLMAG_SP4_DURATION_S=1e-14 FULLMAG_SP4_RELAX_MAX_STEPS=1 ./scripts/verify_fem_standard_problem_4.sh

verify-fem-sp4-mixed-matrix-smoke:
    just ensure-managed-fem-runtime
    durable_root="${FULLMAG_SP4_MIXED_MATRIX_DURABLE_ROOT:-/mnt/fullmag-zfn2-native}"; \
      report_base="${FULLMAG_SP4_MIXED_MATRIX_REPORT_ROOT:-${durable_root}/reports/fullmag/standard-problems/mumag/sp4/fem/mixed-matrix-smoke}"; \
      source scripts/lib/managed_fem_runtime_storage.sh; \
      source scripts/lib/managed_fem_report_storage.sh; \
      report_root="$(create_managed_fem_report_run_root "$durable_root" "$report_base" "/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4" "/sys/block")"; \
      echo "mixed SP4 matrix report root: $report_root"; \
      python3 scripts/run_fem_sp4_mixed_matrix.py --durable-root "$durable_root" --report-root "$report_root" --max-steps 1 --evidence-mode one_step_runtime_smoke

verify-fem-sp4-mixed-matrix:
    just ensure-managed-fem-runtime
    durable_root="${FULLMAG_SP4_MIXED_MATRIX_DURABLE_ROOT:-/mnt/fullmag-zfn2-native}"; \
      report_base="${FULLMAG_SP4_MIXED_MATRIX_REPORT_ROOT:-${durable_root}/reports/fullmag/standard-problems/mumag/sp4/fem/mixed-matrix}"; \
      source scripts/lib/managed_fem_runtime_storage.sh; \
      source scripts/lib/managed_fem_report_storage.sh; \
      report_root="$(create_managed_fem_report_run_root "$durable_root" "$report_base" "/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4" "/sys/block")"; \
      echo "mixed SP4 matrix report root: $report_root"; \
      python3 scripts/run_fem_sp4_mixed_matrix.py --durable-root "$durable_root" --report-root "$report_root"

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
      -e FULLMAG_RELAX_ENABLE_DEMAG="${FULLMAG_RELAX_ENABLE_DEMAG:-1}" \
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

# Capture the fixed FEM GPU NCG fixture in the managed fem-gpu image. The
# preflight is fail-closed: missing Nsight tools write status=unavailable and
# stop before an instrumented runtime rebuild or a fabricated capture.
capture-fem-gpu-nsight:
    set -eu; \
      mkdir -p .fullmag/reports/task-13-nsight; \
      active=".fullmag/runtimes/fem-gpu-host"; \
      if [ ! -L "$active" ]; then \
        echo "status=unavailable: active managed FEM runtime must be a symlink before capture" >&2; \
        exit 2; \
      fi; \
      prior_target="$(readlink "$active")"; \
      restore_active() { \
        status=$?; \
        trap - EXIT; \
        next=".fullmag/runtimes/.fem-gpu-host.restore.$$"; \
        ln -sfn "$prior_target" "$next"; \
        mv -Tf "$next" "$active"; \
        exit "$status"; \
      }; \
      trap restore_active EXIT; \
      docker compose --profile fem-gpu build fem-gpu; \
      if ! docker compose --profile fem-gpu run --rm -T \
        --cap-add SYS_ADMIN \
        -e PYTHONPATH=/workspace/packages/fullmag-py/src \
        fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/capture_fem_gpu_nsight.py --preflight-only'; then \
          echo "status=unavailable: Nsight preflight failed in managed fem-gpu fixture image" >&2; \
          exit 2; \
      fi; \
      FULLMAG_ENABLE_NVTX=1 just rebuild-fem-runtime; \
      runtime_root="$(readlink -f "$active")"; \
      test -x "$runtime_root/bin/fullmag-fem-gpu"; \
      test -f "$runtime_root/manifest.json"; \
      if ! docker compose --profile fem-gpu run --rm -T \
        --cap-add SYS_ADMIN \
        -v "$runtime_root:/workspace/.fullmag/runtime:ro" \
        -e PYTHONPATH=/workspace/packages/fullmag-py/src \
        -e FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime \
        fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/capture_fem_gpu_nsight.py --preflight-only --runtime-root /workspace/.fullmag/runtime'; then \
          echo "status=unavailable: Nsight preflight failed in rebuilt managed fem-gpu fixture image" >&2; \
          exit 2; \
      fi; \
      docker compose --profile fem-gpu run --rm -T \
        --cap-add SYS_ADMIN \
        -v "$runtime_root:/workspace/.fullmag/runtime:ro" \
        -e PYTHONPATH=/workspace/packages/fullmag-py/src \
        -e FULLMAG_PYTHON=/usr/bin/python3 \
        -e FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime \
        fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/capture_fem_gpu_nsight.py --runtime-root /workspace/.fullmag/runtime'

# Build and export one immutable, hash-addressed HYPRE memory-strategy bundle.
# The exporter atomically selects the resulting bundle as fem-gpu-host only
# after its manifest and CUDA architecture contract have validated.
build-fem-hypre-memory-variant variant:
    variant="{{variant}}"; \
      case "$variant" in baseline|umpire|cuda_async|thrust_async) ;; \
        *) echo "unsupported HYPRE memory variant: $variant" >&2; exit 2 ;; \
      esac; \
      FULLMAG_HYPRE_MEMORY_VARIANT="$variant" \
      FULLMAG_FEM_RUNTIME_VARIANT="hypre-${variant//_/-}" \
      ./scripts/export_fem_gpu_runtime.sh

# Build the three variants supported by the pinned HYPRE release. The fourth
# requested candidate is invoked last and must fail closed if HYPRE 3.1.0 does
# not expose --enable-thrust-async; it is never silently mapped to baseline.
build-all-fem-hypre-memory-variants:
    just build-fem-hypre-memory-variant baseline
    just build-fem-hypre-memory-variant umpire
    just build-fem-hypre-memory-variant cuda_async
    just build-fem-hypre-memory-variant thrust_async

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
