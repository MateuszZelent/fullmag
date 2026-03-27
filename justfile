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
    "{{repo_python}}" -m pip install 'numpy>=1.24' 'scipy>=1.10' 'gmsh>=4.12' 'meshio>=5.3' 'trimesh>=4.2'

build target="fullmag":
    if [ "{{target}}" = "fullmag" ]; then make install-cli; \
    elif [ "{{target}}" = "fullmag-static" ]; then make install-cli-static; \
    elif [ "{{target}}" = "fullmag-dev" ]; then make install-cli-dev; \
    elif [ "{{target}}" = "fullmag-host" ]; then make install-cli; \
    elif [ "{{target}}" = "dev-image" ]; then docker compose build dev; \
    elif [ "{{target}}" = "fem-gpu-runtime" ]; then docker compose --profile fem-gpu build fem-gpu; \
    elif [ "{{target}}" = "fem-gpu-runtime-host" ]; then ./scripts/export_fem_gpu_runtime.sh; \
    else echo "unknown build target: {{target}}" >&2; echo "supported targets: fullmag, fullmag-static, fullmag-dev, fullmag-host, dev-image, fem-gpu-runtime, fem-gpu-runtime-host" >&2; exit 1; fi

build-static-control-room:
    make web-build-static-if-needed

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
    FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 just build fullmag
    just build-static-control-room
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag --dev -i examples/nanoflower_fdm.py

run-nanoflower-headless:
    just ensure-python
    FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 just build fullmag
    PATH="{{local_bin}}:$PATH" FULLMAG_PYTHON="{{repo_python}}" fullmag examples/nanoflower_fdm.py --headless --json

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
