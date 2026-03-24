.PHONY: up down shell fmt check cargo-check cargo-test web-install py-install py-test repo-check smoke install-cli show-cli-path control-room control-room-stop

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

py-install:
	docker compose run --rm --no-deps dev bash -lc "python3 -m venv .venv && . .venv/bin/activate && pip install -e packages/fullmag-py"

py-test:
	docker compose run --rm --no-deps dev bash -lc "python3 -m venv .venv && . .venv/bin/activate && pip install -e packages/fullmag-py && python -m unittest discover -s packages/fullmag-py/tests -v"

repo-check:
	docker compose run --rm --no-deps dev python3 scripts/check_repo_consistency.py

smoke:
	docker compose run --rm --no-deps dev bash -lc "python3 -m venv .venv && . .venv/bin/activate && pip install -e packages/fullmag-py && /usr/local/cargo/bin/cargo build -p fullmag-cli --bin fullmag && python scripts/run_python_ir_smoke.py --cli target/debug/fullmag"

install-cli:
	mkdir -p .fullmag/local
	CARGO_TARGET_DIR=.fullmag/target cargo +nightly install --path crates/fullmag-cli --root .fullmag/local --force
	@echo ""
	@echo "Installed repo-local launcher:"
	@echo "  $(PWD)/.fullmag/local/bin/fullmag"
	@echo ""
	@echo "Add it to PATH for this shell:"
	@echo "  export PATH=\"$(PWD)/.fullmag/local/bin:\$$PATH\""

show-cli-path:
	@echo "$(PWD)/.fullmag/local/bin/fullmag"

control-room:
	./scripts/dev-control-room.sh

control-room-stop:
	./scripts/stop-control-room.sh
