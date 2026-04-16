set shell := ["bash", "-euo", "pipefail", "-c"]

repo_root := justfile_directory()
local_bin := repo_root + "/.fullmag/local/bin"
repo_python := repo_root + "/.fullmag/local/python/bin/python"

default:
    @just --list

help:
    @just --list

ensure-python:
    mkdir -p .fullmag/local
    if [ ! -x "{{repo_python}}" ]; then python3 -m venv .fullmag/local/python; fi
    "{{repo_python}}" -m pip install 'numpy>=1.24' 'scipy>=1.10' 'gmsh>=4.12' 'meshio>=5.3' 'trimesh>=4.2' 'h5py>=3.8' 'zarr>=2.16'

build target="fullmag" cpu_only="0":
    if [ "{{target}}" = "fullmag" ]; then FULLMAG_BUILD_CPU_ONLY="{{cpu_only}}" make install-cli; \
    elif [ "{{target}}" = "fullmag-static" ]; then FULLMAG_BUILD_CPU_ONLY="{{cpu_only}}" make install-cli-static; \
    elif [ "{{target}}" = "fullmag-dev" ]; then FULLMAG_BUILD_CPU_ONLY="{{cpu_only}}" make install-cli-dev; \
    elif [ "{{target}}" = "fullmag-host" ]; then make install-cli; \
    elif [ "{{target}}" = "dev-image" ]; then docker compose build dev; \
    elif [ "{{target}}" = "fem-gpu-runtime" ]; then docker compose --profile fem-gpu build fem-gpu; \
    elif [ "{{target}}" = "fem-gpu-runtime-host" ]; then ./scripts/export_fem_gpu_runtime.sh; \
    else echo "unknown build target: {{target}}" >&2; echo "supported targets: fullmag, fullmag-static, fullmag-dev, fullmag-host, dev-image, fem-gpu-runtime, fem-gpu-runtime-host" >&2; exit 1; fi

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
    cargo +nightly check --workspace

test:
    cargo +nightly test --workspace

repo-check:
    python3 scripts/check_repo_consistency.py

control-room session="":
    if [ -n "{{session}}" ]; then ./scripts/dev-control-room.sh "{{session}}"; else ./scripts/dev-control-room.sh; fi

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

run-stno-interactive cpu_only="0":
    if [ "{{cpu_only}}" = "1" ]; then \
        echo "run-stno-interactive requires MFEM-native FEM runtime; cpu_only=1 is incompatible." >&2; \
        echo "Use: just run-stno-interactive 0" >&2; \
        exit 2; \
    fi
    just ensure-python
    just build fullmag-dev {{cpu_only}}
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION=cpu fullmag --dev -i examples/stno_vortex_mtj_workflow.py


run-nanoflower-interactive-quadro:
    just ensure-python
    just build fullmag-dev
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag --dev -i examples/nanoflower_fem_quadro.py

# Run nanoflower quadro on the managed GPU runtime (MFEM + CUDA, built via Docker).
# Run `just rebuild-gpu-runtime` if the binary is stale or after source changes.
gpu_runtime_bin := repo_root + "/.fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu"

run-nanoflower-interactive-quadro-gpu:
    just ensure-python
    just build fullmag-dev
    FULLMAG_PYTHON="{{repo_python}}" '{{gpu_runtime_bin}}' --dev -i examples/nanoflower_fem_quadro.py

run-stno-interactive-managed fem_execution="gpu" cpu_threads="auto":
    just ensure-python
    if [ ! -x '{{gpu_runtime_bin}}' ]; then \
        echo "Managed FEM runtime bundle is missing (used for both FEM CPU and FEM GPU)." >&2; \
        echo "Run: just rebuild-fem-runtime" >&2; \
        exit 2; \
    fi
    if [ "{{cpu_threads}}" = "auto" ]; then \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION="{{fem_execution}}" FULLMAG_CPU_THREADS=auto '{{gpu_runtime_bin}}' --dev -i examples/stno_vortex_mtj_workflow.py; \
    else \
        FULLMAG_PYTHON="{{repo_python}}" FULLMAG_FDM_EXECUTION=cpu FULLMAG_FEM_EXECUTION="{{fem_execution}}" FULLMAG_CPU_THREADS="{{cpu_threads}}" '{{gpu_runtime_bin}}' --dev -i examples/stno_vortex_mtj_workflow.py; \
    fi

run-nanoflower-quadro-gpu-headless:
    just ensure-python
    just build fullmag-dev
    FULLMAG_PYTHON="{{repo_python}}" '{{gpu_runtime_bin}}' --dev examples/nanoflower_fem_quadro.py --headless

run-pylayer-interactive:
    just ensure-python
    just build fullmag-dev
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag --dev -i examples/py_layer_hole_relax_150nm.py

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
    docker compose --profile fem-gpu run --rm fem-gpu bash -lc '\
      set -euo pipefail; \
      cargo +nightly clean -p fullmag-fdm-demag >/dev/null 2>&1 || true; \
      FULLMAG_USE_MFEM_STACK=ON cargo +nightly build -p fullmag-cli --features "cuda fem-gpu" >/tmp/fullmag-build.log; \
      FEM_LIB=$$(dirname "$$(find target/debug/build -path "*fullmag-fem-sys*/out/native-build/backends/fem/libfullmag_fem.so.0" | head -n1)"); \
      FDM_LIB=$$(dirname "$$(find target/debug/build -path "*fullmag-fdm-sys*/out/native-build/backends/fdm/libfullmag_fdm.so.0" | head -n1)"); \
      export LD_LIBRARY_PATH="$$FEM_LIB:$$FDM_LIB:/opt/fullmag-deps/lib:$${LD_LIBRARY_PATH:-}"; \
      FULLMAG_FEM_EXECUTION=gpu FULLMAG_FEM_GPU_INDEX=0 FULLMAG_FDM_GPU_INDEX=0 \
      ./target/debug/fullmag {{script}} --backend fem --headless --json \
    '

fem-gpu-py-layer-hole-headless:
    just fem-gpu-headless examples/py_layer_hole_relax_150nm.py

# Rebuild the managed FEM host runtime bundle (MFEM + HYPRE + CUDA-enabled build stack).
# This bundle is used for both FEM CPU and FEM GPU execution paths.
# Required after source changes to fullmag-plan, fullmag-runner, fullmag-fem-sys, or native/backends/fem.
rebuild-fem-runtime:
    ./scripts/export_fem_gpu_runtime.sh

# Backward-compatible alias.
rebuild-gpu-runtime:
    just rebuild-fem-runtime

# ── Benchmarks ──────────────────────────────────────────────────────────

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
