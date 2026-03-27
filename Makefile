.PHONY: up down shell fmt check cargo-check cargo-test web-install web-build-static py-install py-test repo-check smoke install-cli install-cli-dev show-cli-path control-room control-room-stop fem-gpu-build fem-gpu-shell fem-gpu-check fem-gpu-test fem-gpu-native-test

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
	docker compose run --rm --no-deps dev pnpm install --dir apps/web

web-build-static:
	@set -e; \
	if command -v pnpm >/dev/null 2>&1; then \
		PNPM_CMD="pnpm"; \
	elif command -v corepack >/dev/null 2>&1; then \
		PNPM_CMD="corepack pnpm"; \
	else \
		echo "Neither pnpm nor corepack is available on PATH." >&2; \
		exit 127; \
	fi; \
	if [ ! -d "apps/web/node_modules" ] && [ ! -d "node_modules" ]; then \
		$$PNPM_CMD install --dir apps/web; \
	fi; \
	rm -rf apps/web/out .fullmag/local/web.new; \
	$$PNPM_CMD --dir apps/web build; \
	mkdir -p .fullmag/local; \
	cp -a apps/web/out .fullmag/local/web.new; \
	touch .fullmag/local/web.new/.build-stamp; \
	rm -rf .fullmag/local/web; \
	mv .fullmag/local/web.new .fullmag/local/web; \
	echo "Installed static control room:"; \
	echo "  $(PWD)/.fullmag/local/web"

py-install:
	docker compose run --rm --no-deps dev bash -lc "python3 -m venv .venv && . .venv/bin/activate && pip install -e 'packages/fullmag-py[meshing]'"

py-test:
	docker compose run --rm --no-deps dev bash -lc "python3 -m venv .venv && . .venv/bin/activate && pip install -e 'packages/fullmag-py[meshing]' && python -m unittest discover -s packages/fullmag-py/tests -v"

repo-check:
	docker compose run --rm --no-deps dev python3 scripts/check_repo_consistency.py

smoke:
	docker compose run --rm --no-deps dev bash -lc "python3 -m venv .venv && . .venv/bin/activate && pip install -e 'packages/fullmag-py[meshing]' && /usr/local/cargo/bin/cargo build -p fullmag-cli --bin fullmag && python scripts/run_python_ir_smoke.py --cli target/debug/fullmag"

install-cli: INSTALL_STATIC_WEB=1
install-cli-dev: INSTALL_STATIC_WEB=0

install-cli install-cli-dev:
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
	build_mode="cpu"; \
	if [ -n "$$nvcc_bin" ] && [ -n "$$cmake_bin" ]; then \
		echo "Installing Rust launcher with CUDA support..."; \
		if FULLMAG_USE_MFEM_STACK=ON FULLMAG_CMAKE="$$cmake_bin" CARGO_TARGET_DIR=.fullmag/target cargo +nightly build -p fullmag-cli --release --features "cuda fem-gpu" >"$$build_log" 2>&1 \
			&& FULLMAG_USE_MFEM_STACK=ON FULLMAG_CMAKE="$$cmake_bin" CARGO_TARGET_DIR=.fullmag/target cargo +nightly build -p fullmag-api --release --features "cuda fem-gpu" >>"$$build_log" 2>&1; then \
			echo "Host FEM GPU backend available; installing launcher with CUDA + FEM GPU support..."; \
			build_mode="cuda-fem-gpu"; \
		else \
			echo "Host FEM GPU backend not available; falling back to CUDA-only launcher."; \
			echo "Probe log: $(PWD)/.fullmag/local/install-cli-build.log"; \
			CARGO_TARGET_DIR=.fullmag/target cargo +nightly clean -p fullmag-fem-sys >/dev/null 2>&1 || true; \
			FULLMAG_CMAKE="$$cmake_bin" CARGO_TARGET_DIR=.fullmag/target cargo +nightly build -p fullmag-cli --release --features cuda; \
			FULLMAG_CMAKE="$$cmake_bin" CARGO_TARGET_DIR=.fullmag/target cargo +nightly build -p fullmag-api --release --features cuda; \
			build_mode="cuda"; \
			if [ "$${FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT:-0}" = "1" ]; then \
				echo "Skipping managed FEM GPU host runtime export."; \
			elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then \
				managed_runtime_stale=""; \
				if [ -x "$$managed_runtime_bin" ]; then \
					managed_runtime_stale="$$(find native/backends/fem crates/fullmag-fem-sys crates/fullmag-runner crates/fullmag-cli scripts docker-compose.yml Cargo.lock -type f -newer "$$managed_runtime_bin" 2>/dev/null | head -n 1)"; \
				fi; \
				if [ ! -x "$$managed_runtime_bin" ] || [ ".fullmag/target/release/fullmag" -nt "$$managed_runtime_bin" ] || [ "./scripts/export_fem_gpu_runtime.sh" -nt "$$managed_runtime_bin" ] || [ -n "$$managed_runtime_stale" ]; then \
					echo "Exporting managed FEM GPU host runtime bundle..."; \
					if ./scripts/export_fem_gpu_runtime.sh >"$$managed_log" 2>&1; then \
						echo "Managed FEM GPU host runtime exported successfully."; \
					else \
						echo "Managed FEM GPU host runtime export failed; staying on local CUDA-only launcher."; \
						echo "Managed runtime log: $(PWD)/.fullmag/local/install-cli-managed-fem-gpu.log"; \
					fi; \
				else \
					echo "Reusing managed FEM GPU host runtime bundle."; \
				fi; \
			fi; \
			if [ -x "$$managed_runtime_bin" ]; then \
				build_mode="cuda+managed-fem-gpu-host"; \
			fi; \
		fi; \
	else \
		echo "Installing Rust launcher without CUDA support..."; \
		CARGO_TARGET_DIR=.fullmag/target cargo +nightly build -p fullmag-cli --release; \
		CARGO_TARGET_DIR=.fullmag/target cargo +nightly build -p fullmag-api --release; \
		if [ -x "$$managed_runtime_bin" ]; then \
			build_mode="managed-fem-gpu-host"; \
		fi; \
	fi; \
	mkdir -p .fullmag/local/lib; \
	rm -f .fullmag/local/lib/libfullmag_fdm.so* .fullmag/local/lib/libfullmag_fem.so*; \
	fdm_dir=$$(find .fullmag/target -path '*native-build/backends/fdm' -type d | head -n 1); \
	if [ -n "$$fdm_dir" ]; then cp -a "$$fdm_dir"/libfullmag_fdm.so* .fullmag/local/lib/ 2>/dev/null || true; fi; \
	if [ "$$build_mode" = "cuda-fem-gpu" ]; then \
		fem_dir=$$(find .fullmag/target -path '*native-build/backends/fem' -type d | head -n 1); \
		if [ -n "$$fem_dir" ]; then cp -a "$$fem_dir"/libfullmag_fem.so* .fullmag/local/lib/ 2>/dev/null || true; fi; \
	fi; \
	printf '%s\n' "$$build_mode" > .fullmag/local/launcher-build-mode
	@mkdir -p .fullmag/local/bin
	@cp .fullmag/target/release/fullmag .fullmag/local/bin/fullmag-bin.new
	@mv -f .fullmag/local/bin/fullmag-bin.new .fullmag/local/bin/fullmag-bin
	@cp .fullmag/target/release/fullmag-api .fullmag/local/bin/fullmag-api.new
	@mv -f .fullmag/local/bin/fullmag-api.new .fullmag/local/bin/fullmag-api
	@printf '%s\n' '#!/usr/bin/env bash' \
		'SELF_DIR="$$(cd "$$(dirname "$$0")" && pwd)"' \
		'REPO_ROOT="$$(cd "$$SELF_DIR/../../.." && pwd)"' \
		'export FULLMAG_REPO_ROOT="$$REPO_ROOT"' \
		'export PYTHONPATH="$$REPO_ROOT/packages/fullmag-py/src$${PYTHONPATH:+:$$PYTHONPATH}"' \
		'export FULLMAG_FEM_MESH_CACHE_DIR="$$REPO_ROOT/.fullmag/local/cache/fem_mesh_assets"' \
		'MANAGED_RUNTIME_ROOT="$${SELF_DIR}/../../runtimes/fem-gpu-host"' \
		'MANAGED_RUNTIME_BIN="$${MANAGED_RUNTIME_ROOT}/bin/fullmag-fem-gpu-bin"' \
		'if [ "$${FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME:-0}" != "1" ] && [ -x "$$MANAGED_RUNTIME_BIN" ]; then' \
		'  export LD_LIBRARY_PATH="$$MANAGED_RUNTIME_ROOT/lib:$$SELF_DIR/../lib$${LD_LIBRARY_PATH:+:$$LD_LIBRARY_PATH}"' \
		'  exec "$$MANAGED_RUNTIME_BIN" "$$@"' \
		'fi' \
		'export LD_LIBRARY_PATH="$$SELF_DIR/../lib$${LD_LIBRARY_PATH:+:$$LD_LIBRARY_PATH}"' \
		'exec "$$SELF_DIR/fullmag-bin" "$$@"' \
		> .fullmag/local/bin/fullmag
	@chmod +x .fullmag/local/bin/fullmag
	@if [ "$(INSTALL_STATIC_WEB)" = "1" ]; then $(MAKE) web-build-static; fi
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
