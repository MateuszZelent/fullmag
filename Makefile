.PHONY: up down shell fmt check cargo-check cargo-test web-install web-build-static web-build-static-if-needed py-install py-test repo-check smoke install-cli install-cli-dev install-cli-static show-cli-path control-room control-room-stop fem-gpu-build fem-gpu-shell fem-gpu-check fem-gpu-test fem-gpu-native-test

FULLMAG_CARGO_TARGET_DIR ?= /tmp/fullmag-zfn2-build/cargo-targets/fullmag-cli

up:
	docker compose up -d postgres minio nats dev

down:
	docker compose down

shell:
	docker compose exec dev bash

fmt:
	docker compose exec dev cargo fmt --all

check:
	docker compose exec dev cargo check --workspace

cargo-check:
	docker compose run --rm --no-deps dev cargo check --workspace

cargo-test:
	docker compose run --rm --no-deps dev cargo test --workspace

web-install:
	docker compose run --rm --no-deps dev pnpm install --dir apps/control-room

web-build-static:
	@set -e; \
	WEB_APP_DIR="apps/control-room"; \
	if command -v pnpm >/dev/null 2>&1; then \
		PNPM_CMD="pnpm"; \
	elif command -v corepack >/dev/null 2>&1; then \
		PNPM_CMD="corepack pnpm"; \
	else \
		echo "Neither pnpm nor corepack is available on PATH." >&2; \
		exit 127; \
	fi; \
	if [ ! -d "$$WEB_APP_DIR/node_modules" ] && [ ! -d "node_modules" ]; then \
		$$PNPM_CMD install --dir "$$WEB_APP_DIR"; \
	fi; \
	rm -rf "$$WEB_APP_DIR/.next" "$$WEB_APP_DIR/out" .fullmag/local/web.new; \
	if ! FULLMAG_CONTROL_ROOM_STATIC_EXPORT=1 $$PNPM_CMD --dir "$$WEB_APP_DIR" run build:webpack; then \
		echo "Static control room build failed; retrying once from a clean Next cache..."; \
		rm -rf "$$WEB_APP_DIR/.next" "$$WEB_APP_DIR/out"; \
		FULLMAG_CONTROL_ROOM_STATIC_EXPORT=1 $$PNPM_CMD --dir "$$WEB_APP_DIR" run build:webpack; \
	fi; \
	mkdir -p .fullmag/local; \
	cp -a "$$WEB_APP_DIR/out" .fullmag/local/web.new; \
	touch .fullmag/local/web.new/.build-stamp; \
	rm -rf .fullmag/local/web; \
	mv .fullmag/local/web.new .fullmag/local/web; \
	echo "Installed static control room:"; \
	echo "  $(PWD)/.fullmag/local/web"

web-build-static-if-needed:
	@set -e; \
	WEB_APP_DIR="apps/control-room"; \
	stamp=".fullmag/local/web/.build-stamp"; \
	index=".fullmag/local/web/index.html"; \
	if [ ! -f "$$stamp" ] || [ ! -f "$$index" ]; then \
		$(MAKE) web-build-static; \
	else \
		stale_path="$$(find "$$WEB_APP_DIR" \
			\( -path "$$WEB_APP_DIR/node_modules" -o -path "$$WEB_APP_DIR/.next" -o -path "$$WEB_APP_DIR/out" \) -prune \
			-o -type f -newer "$$stamp" -print -quit)"; \
		if [ -n "$$stale_path" ]; then \
			echo "Static control room is stale; rebuilding..."; \
			$(MAKE) web-build-static; \
		else \
			echo "Reusing static control room:"; \
			echo "  $(PWD)/.fullmag/local/web"; \
		fi; \
	fi

py-install:
	docker compose run --rm --no-deps dev bash -lc "python3 -m venv .venv && . .venv/bin/activate && pip install -e 'packages/fullmag-py[meshing]'"

py-test:
	docker compose run --rm --no-deps dev bash -lc "python3 -m venv .venv && . .venv/bin/activate && pip install pytest pytest-mock -e 'packages/fullmag-py[meshing]' && python -m unittest discover -s packages/fullmag-py/tests -v"

repo-check:
	docker compose run --rm --no-deps dev python3 scripts/check_repo_consistency.py

smoke:
	docker compose run --rm --no-deps dev bash -lc "python3 -m venv .venv && . .venv/bin/activate && pip install -e 'packages/fullmag-py[meshing]' && /usr/local/cargo/bin/cargo build -p fullmag-cli --bin fullmag && python scripts/run_python_ir_smoke.py --cli target/debug/fullmag"

install-cli: INSTALL_STATIC_WEB=0
install-cli-dev: INSTALL_STATIC_WEB=0
install-cli-static: INSTALL_STATIC_WEB=1

install-cli install-cli-dev install-cli-static:
	mkdir -p .fullmag/local
	@set -e; \
	cmake_bin=""; \
	if [ -n "$${FULLMAG_CMAKE:-}" ] && [ -x "$${FULLMAG_CMAKE:-}" ]; then \
		cmake_bin="$${FULLMAG_CMAKE}"; \
	elif [ -x "$$HOME/.local/bin/cmake" ]; then \
		cmake_bin="$$HOME/.local/bin/cmake"; \
	elif command -v cmake >/dev/null 2>&1; then \
		cmake_bin="$$(command -v cmake)"; \
	fi; \
	nvcc_bin=""; \
	if [ -x "/usr/local/cuda/bin/nvcc" ]; then \
		nvcc_bin="/usr/local/cuda/bin/nvcc"; \
	elif command -v nvcc >/dev/null 2>&1; then \
		nvcc_bin="$$(command -v nvcc)"; \
	fi; \
	build_log=".fullmag/local/install-cli-build.log"; \
	managed_log=".fullmag/local/install-cli-managed-fem-gpu.log"; \
	managed_runtime_bin=".fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu-bin"; \
	managed_export_timeout="$${FULLMAG_MANAGED_FEM_GPU_EXPORT_TIMEOUT_SEC:-1800}"; \
	cpu_only="$${FULLMAG_BUILD_CPU_ONLY:-0}"; \
	cargo_target_dir="$(FULLMAG_CARGO_TARGET_DIR)"; \
	mkdir -p "$$cargo_target_dir"; \
	if [ ! -w "$$cargo_target_dir" ]; then echo "Fullmag Cargo target directory is not writable: $$cargo_target_dir" >&2; exit 2; fi; \
	cargo_target_fstype="$$(findmnt -no FSTYPE -T "$$cargo_target_dir" 2>/dev/null || true)"; \
	if [ "$$cargo_target_fstype" = "cifs" ]; then echo "Refusing direct CIFS Fullmag Cargo target directory: $$cargo_target_dir" >&2; exit 2; fi; \
	CARGO_TARGET_DIR="$$cargo_target_dir" cargo +nightly clean -p fullmag-build-info; \
	build_mode="cpu"; \
	if [ "$$cpu_only" = "1" ]; then \
		echo "FULLMAG_BUILD_CPU_ONLY=1 forces CPU-only launcher build; skipping CUDA and managed FEM GPU export."; \
		echo "Installing Rust launcher without CUDA support..."; \
		CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-cli --release; \
		CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-api --release --no-default-features; \
	elif [ -n "$$nvcc_bin" ] && [ -n "$$cmake_bin" ]; then \
		echo "Installing Rust launcher with CUDA support..."; \
		if [ "$${FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT:-0}" = "1" ]; then \
			echo "FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 disables managed FEM GPU export; building a CUDA-only launcher without the 'fem-gpu' feature."; \
			FULLMAG_CMAKE="$$cmake_bin" CUDACXX="$$nvcc_bin" CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-cli --release --features cuda; \
			FULLMAG_CMAKE="$$cmake_bin" CUDACXX="$$nvcc_bin" CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-api --release --no-default-features --features cuda; \
			build_mode="cuda"; \
		elif FULLMAG_USE_MFEM_STACK=ON FULLMAG_CMAKE="$$cmake_bin" CUDACXX="$$nvcc_bin" CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-cli --release --features "cuda fem-gpu" >"$$build_log" 2>&1 \
				&& FULLMAG_USE_MFEM_STACK=ON FULLMAG_CMAKE="$$cmake_bin" CUDACXX="$$nvcc_bin" CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-api --release --no-default-features --features "cuda fem-gpu" >>"$$build_log" 2>&1; then \
			echo "Host FEM GPU backend available; installing launcher with CUDA + FEM GPU support..."; \
			build_mode="cuda-fem-gpu"; \
		else \
			echo "Host FEM GPU backend not available; falling back to CUDA-only launcher."; \
			echo "Probe log: $(PWD)/.fullmag/local/install-cli-build.log"; \
			CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly clean -p fullmag-fem-sys >/dev/null 2>&1 || true; \
				FULLMAG_CMAKE="$$cmake_bin" CUDACXX="$$nvcc_bin" CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-cli --release --features cuda; \
				FULLMAG_CMAKE="$$cmake_bin" CUDACXX="$$nvcc_bin" CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-api --release --no-default-features --features cuda; \
				build_mode="cuda"; \
				managed_runtime_ready="0"; \
				if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then \
				managed_runtime_stale=""; \
				if [ -x "$$managed_runtime_bin" ]; then \
					managed_runtime_stale="$$(find backends/fem crates/fullmag-fem-sys crates/fullmag-runner crates/fullmag-cli scripts compose.yaml Cargo.lock -type f -newer "$$managed_runtime_bin" 2>/dev/null | head -n 1)"; \
					fi; \
					if [ ! -x "$$managed_runtime_bin" ] || [ "./scripts/export_fem_gpu_runtime.sh" -nt "$$managed_runtime_bin" ] || [ -n "$$managed_runtime_stale" ]; then \
						echo "Exporting managed FEM GPU host runtime bundle..."; \
						if command -v timeout >/dev/null 2>&1; then \
							if timeout "$$managed_export_timeout" ./scripts/export_fem_gpu_runtime.sh >"$$managed_log" 2>&1; then \
								echo "Managed FEM GPU host runtime exported successfully."; \
								managed_runtime_ready="1"; \
							else \
								echo "Managed FEM GPU host runtime export failed; staying on local CUDA-only launcher."; \
								echo "If this was a timeout/hang, set FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 or FULLMAG_BUILD_CPU_ONLY=1."; \
								echo "Managed runtime log: $(PWD)/.fullmag/local/install-cli-managed-fem-gpu.log"; \
							fi; \
						else \
							if ./scripts/export_fem_gpu_runtime.sh >"$$managed_log" 2>&1; then \
								echo "Managed FEM GPU host runtime exported successfully."; \
								managed_runtime_ready="1"; \
							else \
								echo "Managed FEM GPU host runtime export failed; staying on local CUDA-only launcher."; \
								echo "If this was a timeout/hang, set FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 or FULLMAG_BUILD_CPU_ONLY=1."; \
								echo "Managed runtime log: $(PWD)/.fullmag/local/install-cli-managed-fem-gpu.log"; \
							fi; \
						fi; \
					else \
						echo "Reusing managed FEM GPU host runtime bundle."; \
						managed_runtime_ready="1"; \
					fi; \
				fi; \
				if [ "$$managed_runtime_ready" = "1" ] && [ -x "$$managed_runtime_bin" ]; then \
					build_mode="cuda+managed-fem-gpu-host"; \
				fi; \
		fi; \
	else \
		echo "Installing Rust launcher without CUDA support..."; \
		CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-cli --release; \
		CARGO_TARGET_DIR="$$cargo_target_dir" CARGO_INCREMENTAL=0 cargo +nightly build -p fullmag-api --release --no-default-features; \
		if [ -x "$$managed_runtime_bin" ]; then \
			build_mode="managed-fem-gpu-host"; \
		fi; \
	fi; \
	mkdir -p .fullmag/local/lib; \
	rm -f .fullmag/local/lib/libfullmag_fdm.so* .fullmag/local/lib/libfullmag_fem.so*; \
	fdm_dir=$$(find "$$cargo_target_dir/release/build" -path '*fullmag-fdm-sys*/out/native-build/backends/fdm/libfullmag_fdm.so.*' -type f -printf '%T@ %h\n' 2>/dev/null | sort -nr | awk 'NR==1 { print $$2 }'); \
	if [ -z "$$fdm_dir" ]; then \
		fdm_dir=$$(find "$$cargo_target_dir" -path '*native-build/backends/fdm/libfullmag_fdm.so.*' -type f -printf '%T@ %h\n' 2>/dev/null | sort -nr | awk 'NR==1 { print $$2 }'); \
	fi; \
	if [ -n "$$fdm_dir" ]; then cp -a "$$fdm_dir"/libfullmag_fdm.so* .fullmag/local/lib/ 2>/dev/null || true; fi; \
	if [ "$$build_mode" = "cuda-fem-gpu" ]; then \
		fem_dir=$$(find "$$cargo_target_dir/release/build" -path '*fullmag-fem-sys*/out/native-build/backends/fem/libfullmag_fem.so.*' -type f -printf '%T@ %h\n' 2>/dev/null | sort -nr | awk 'NR==1 { print $$2 }'); \
		if [ -z "$$fem_dir" ]; then \
			fem_dir=$$(find "$$cargo_target_dir" -path '*native-build/backends/fem/libfullmag_fem.so.*' -type f -printf '%T@ %h\n' 2>/dev/null | sort -nr | awk 'NR==1 { print $$2 }'); \
		fi; \
		if [ -n "$$fem_dir" ]; then cp -a "$$fem_dir"/libfullmag_fem.so* .fullmag/local/lib/ 2>/dev/null || true; fi; \
	fi; \
	printf '%s\n' "$$build_mode" > .fullmag/local/launcher-build-mode
	@mkdir -p .fullmag/local/bin
	@cp "$(FULLMAG_CARGO_TARGET_DIR)/release/fullmag" .fullmag/local/bin/fullmag-bin.new
	@mv -f .fullmag/local/bin/fullmag-bin.new .fullmag/local/bin/fullmag-bin
	@cp "$(FULLMAG_CARGO_TARGET_DIR)/release/fullmag-api" .fullmag/local/bin/fullmag-api.new
	@mv -f .fullmag/local/bin/fullmag-api.new .fullmag/local/bin/fullmag-api
	@if command -v patchelf >/dev/null 2>&1; then \
		patchelf --set-rpath '$$ORIGIN/../lib' .fullmag/local/bin/fullmag-bin; \
		patchelf --set-rpath '$$ORIGIN/../lib' .fullmag/local/bin/fullmag-api; \
	fi
		@printf '%s\n' '#!/usr/bin/env bash' \
			'SELF_DIR="$$(cd "$$(dirname "$$0")" && pwd)"' \
			'REPO_ROOT="$$(cd "$$SELF_DIR/../../.." && pwd)"' \
			'export FULLMAG_REPO_ROOT="$$REPO_ROOT"' \
			'export FULLMAG_API_PORT="$${FULLMAG_API_PORT:-8081}"' \
			'export PYTHONPATH="$$REPO_ROOT/packages/fullmag-py/src$${PYTHONPATH:+:$$PYTHONPATH}"' \
			'export FULLMAG_FEM_MESH_CACHE_DIR="$$REPO_ROOT/.fullmag/local/cache/fem_mesh_assets"' \
			'LOCAL_LD_LIBRARY_PATH="$$SELF_DIR/../lib$${LD_LIBRARY_PATH:+:$$LD_LIBRARY_PATH}"' \
			'MANAGED_RUNTIME_ROOT="$${SELF_DIR}/../../runtimes/fem-gpu-host"' \
			'MANAGED_RUNTIME_LAUNCHER="$${MANAGED_RUNTIME_ROOT}/bin/fullmag-fem-gpu"' \
			'MANAGED_RUNTIME_BIN="$${MANAGED_RUNTIME_ROOT}/bin/fullmag-fem-gpu-bin"' \
			'ALLOW_MANAGED_RUNTIME="0"' \
			'if [ -x "$$MANAGED_RUNTIME_LAUNCHER" ] && [ "$${FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT:-0}" != "1" ]; then' \
			'  ALLOW_MANAGED_RUNTIME="1"' \
			'fi' \
			'RESOLVE_RUNTIME_OUTPUT=""' \
			'if [ "$$ALLOW_MANAGED_RUNTIME" = "1" ] && [ "$${FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME:-0}" != "1" ] && [ -x "$$MANAGED_RUNTIME_LAUNCHER" ]; then' \
			'  RESOLVE_RUNTIME_OUTPUT="$$(LD_LIBRARY_PATH="$$LOCAL_LD_LIBRARY_PATH" "$$SELF_DIR/fullmag-bin" resolve-runtime-invocation --shell -- "$$@" 2>/dev/null || true)"' \
			'fi' \
			'PREFERRED_RUNTIME_FAMILY=""' \
			'RESOLVED_RUNTIME_FAMILY=""' \
			'LOCAL_ENGINE_ID=""' \
			'REQUIRES_MANAGED_RUNTIME="0"' \
			'SHOULD_USE_MANAGED_RUNTIME="0"' \
			'if [ -n "$$RESOLVE_RUNTIME_OUTPUT" ]; then' \
			'  while IFS="=" read -r key value; do' \
			'    case "$$key" in' \
			'      preferred_runtime_family) PREFERRED_RUNTIME_FAMILY="$$value" ;;' \
			'      resolved_runtime_family) RESOLVED_RUNTIME_FAMILY="$$value" ;;' \
			'      local_engine_id) LOCAL_ENGINE_ID="$$value" ;;' \
			'      requires_managed_runtime) REQUIRES_MANAGED_RUNTIME="$$value" ;;' \
			'    esac' \
			'  done <<< "$$RESOLVE_RUNTIME_OUTPUT"' \
			'fi' \
			'if [ "$$REQUIRES_MANAGED_RUNTIME" = "1" ]; then' \
			'  SHOULD_USE_MANAGED_RUNTIME="1"' \
			'fi' \
			'if [ "$$PREFERRED_RUNTIME_FAMILY" = "fem-gpu" ] || [ "$$PREFERRED_RUNTIME_FAMILY" = "fem-eigen-gpu" ]; then' \
			'  if [ "$$REQUIRES_MANAGED_RUNTIME" = "1" ] || [ "$$RESOLVED_RUNTIME_FAMILY" != "$$PREFERRED_RUNTIME_FAMILY" ] || [ "$$LOCAL_ENGINE_ID" = "fem_cpu_native" ] || [ "$$LOCAL_ENGINE_ID" = "fem_eigen_cpu_baseline" ]; then' \
			'    SHOULD_USE_MANAGED_RUNTIME="1"' \
			'  fi' \
			'fi' \
			'if [ "$$ALLOW_MANAGED_RUNTIME" = "1" ] && [ "$$SHOULD_USE_MANAGED_RUNTIME" = "1" ] && [ "$${FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME:-0}" != "1" ] && [ -x "$$MANAGED_RUNTIME_LAUNCHER" ]; then' \
			'  OPENMPI_ROOT="$$MANAGED_RUNTIME_ROOT/openmpi"' \
			'  if [ -d "$$OPENMPI_ROOT/share/openmpi" ]; then' \
			'    export OPAL_PREFIX="$$OPENMPI_ROOT"' \
			'    export PATH="$$OPENMPI_ROOT/bin$${PATH:+:$$PATH}"' \
			'    export OMPI_MCA_mca_base_component_path="$$OPENMPI_ROOT/lib/openmpi3"' \
			'    export OMPI_MCA_orte_launch_agent="$$OPENMPI_ROOT/bin/orted"' \
			'    export OMPI_MCA_reachable="$${OMPI_MCA_reachable:-weighted}"' \
			'  fi' \
			'  if [ -d "$$MANAGED_RUNTIME_ROOT/lib/pmix2/share/pmix" ]; then' \
			'    export PMIX_PREFIX="$$MANAGED_RUNTIME_ROOT/lib/pmix2"' \
			'    export PMIX_EXEC_PREFIX="$$MANAGED_RUNTIME_ROOT/lib/pmix2"' \
			'  fi' \
			'  export LD_LIBRARY_PATH="$$MANAGED_RUNTIME_ROOT/lib:$$LOCAL_LD_LIBRARY_PATH"' \
			'  exec "$$MANAGED_RUNTIME_LAUNCHER" "$$@"' \
			'fi' \
		'export LD_LIBRARY_PATH="$$LOCAL_LD_LIBRARY_PATH"' \
		'exec "$$SELF_DIR/fullmag-bin" "$$@"' \
		> .fullmag/local/bin/fullmag
	@chmod +x .fullmag/local/bin/fullmag
	@if [ "$(INSTALL_STATIC_WEB)" = "1" ]; then $(MAKE) web-build-static-if-needed; fi
	@echo ""
	@echo "Installed repo-local launcher:"
	@echo "  $(PWD)/.fullmag/local/bin/fullmag"
	@echo "Build mode:"
	@echo "  $$(cat .fullmag/local/launcher-build-mode)"
	@echo ""
	@echo "Add it to PATH for this shell:"
	@echo "  export PATH=\"$(PWD)/.fullmag/local/bin:\$$PATH\""

show-cli-path:
	@echo "$(PWD)/.fullmag/local/bin/fullmag"

control-room:
	./scripts/dev-control-room.sh

control-room-stop:
	./scripts/stop-control-room.sh

fem-gpu-build:
	docker compose --profile fem-gpu build fem-gpu

fem-gpu-shell:
	docker compose --profile fem-gpu run --rm fem-gpu bash

fem-gpu-check:
	docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc "FULLMAG_USE_MFEM_STACK=ON cargo +nightly check -p fullmag-runner -p fullmag-cli -p fullmag-api --features 'fem-gpu cuda'"

fem-gpu-test:
	docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc "FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-runner --features fem-gpu native_fem -- --nocapture"

fem-gpu-native-test:
	docker compose --profile fem-gpu run --rm --no-deps fem-gpu bash -lc "FULLMAG_USE_MFEM_STACK=ON cargo +nightly test -p fullmag-runner --features fem-gpu native_fem::tests::native_fem_exchange_only_matches_cpu_reference_when_mfem_stack_is_available -- --nocapture"
