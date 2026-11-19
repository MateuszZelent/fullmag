# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Binding rules live in AGENTS.md

[`AGENTS.md`](AGENTS.md) is the canonical, binding instruction set; this file only
summarizes commands and architecture. When they disagree, AGENTS.md wins. Load the
area rules it points to before changing an area:
[contracts](.agents/instructions/contracts.md), [backend/build/storage](.agents/instructions/backend.md),
[frontend/API](.agents/instructions/frontend.md), [science/docs](.agents/instructions/scientific.md).
Task skills are in `.agents/skills/` (e.g. `fullmag-docker-build`, `using-git-worktrees`,
`finishing-a-development-branch`, `scientific-documentation-contract`).

Points that trip new sessions most often:

- Write reports, plans and audits in Polish; code, identifiers, comments and commit
  messages in English.
- Implementation happens in a worktree (`<project-root>/worktrees/<task-id>`, branch
  `codex/<task-id>`), finished by the full cycle: tests → commit → PR to `master` → merge →
  fast-forward the main checkout → stop and remove the task's Docker group → `git worktree remove`
  → registry entry in `storage/index`. Preserve other agents' uncommitted changes in the main
  checkout.
- **Do not compile unit tests** (`cargo test`, `just test`) until the user revokes that ban.
  Application code is compiled inside the Docker `backend` service; never on the host.
- Physics/numerics changes need the scientific note in `docs/physics/` first.
- Review complexity and contracts using `.agents/skills/google-eng-review-practices/SKILL.md`; file size is a review signal, not an automatic reason to split.

## Commands

### Daily development (Docker Compose group of the selected checkout)

The only daily dev route is the managed launcher; never run plain `docker compose up`,
`docker system prune` or `docker compose down -v`. Prefer a checkout on ext4 inside WSL
(`/home/<user>/git/fullmag/fullmag`): Windows or `/mnt/c` checkouts reach containers through 9p,
which is slow and forces the frontend to poll. Full walkthrough:
[README quick guide](readme.md#quick-guide-working-with-the-containers-on-windows-and-wsl).

```bash
python3 -B scripts/setup_docker.py --check   # host/storage preflight (PowerShell: python -B scripts\setup_docker.py --check)
just docker-dev-toolchain                    # dependency image for this checkout (slow only the first time)
just docker-dev "$PWD"                       # build backend in its container, start API + frontend
just docker-dev "$PWD" 3197 examples/fem_relax_gpu_smoke.py   # optional port and startup script
just docker-dev-script examples/<file>.py    # run a script in an already healthy group
just docker-dev-codegen "$PWD"               # OpenAPI + TypeScript client codegen via running services
```

After a backend source edit, restart the group's `backend` container (`docker restart <backend>`);
it reuses a verified package or builds a new one and restarts the API. In the single-volume layout, changed sources may require a full build. Frontend edits use HMR. Find a group's containers
with `docker ps -a --filter label=com.docker.compose.project=<project>`; the main checkout is
`fullmag-master`, a worktree is `fullmag-worktree-<worktree_id>`.

### Lightweight checks (allowed without compiling unit tests)

```bash
# Launcher/Docker contract tests are standalone unittest scripts under scripts/
python -B scripts/test_docker_frontend_dev.py -v
cd scripts && python -B -m unittest test_docker_frontend_dev.FrontendDevContractTests.test_watchpack_polling_default_and_override_are_visible_to_child_receipt_and_log

# Python package tests (pytest), using the repo-managed interpreter from `just ensure-python`
PYTHONPATH=packages/fullmag-py/src python -m pytest -q packages/fullmag-py/tests/test_spin_drift_diffusion.py

# Control Room source checks through managed routes (no Next/Rust build)
just lint-control-room-source
just check-control-room-production-source

# Rust source checks without test targets
just check-api-source
just check-cli-source
```

CI (`.github/workflows/bootstrap.yml`) runs the `python-contracts` and `rust-contracts` jobs;
compare a red job with the same job on `master` before treating it as a regression.

## Architecture

### One semantic core

```
Python DSL (packages/fullmag-py, fm.study(...))   Control Room (apps/control-room)
                 \                                   /
                  └──────────► ProblemIR ◄───────────┘   crates/fullmag-ir
                                   │
                validation + capability planning           crates/fullmag-plan
                                   │
                  session → run → ordered stages            crates/fullmag-session, -runner, -api, -cli
                         ┌─────────┴─────────┐
                   FDM (CPU/CUDA)       FEM (MFEM/hypre/libCEED, CPU/CUDA)
                   backends/, native/, crates/fullmag-engine, -fdm-sys, -fem-sys
                                   │
              fields, observables, artifacts, provenance
```

- `packages/fullmag-py` is the only public scripting surface; UI-authored models must export to
  canonical, editable Python. Everything converges on `ProblemIR`; Rust validates, plans and runs.
- Four separate realizations: FDM CPU, FDM GPU, FEM CPU, FEM GPU. Requested intent and resolved
  execution are both recorded; forced GPU never silently falls back to CPU, and `auto` stays
  visible in provenance. Support is per execution lane; see
  [`docs/specs/capability-matrix-v0.md`](docs/specs/capability-matrix-v0.md).
- Scene entities have immutable `object_id`, user `name`, presentational `type` and explicitly
  enabled physics modules; name or type never activates physics.

### Control Room and API

Next.js/React/TypeScript with Three.js and ECharts. One workspace, one viewport, one typed API
client and one resource-hook layer; components do not create their own endpoints or separate
FDM/FEM trees. The JSON control plane is thin and revision-driven; fields and topology use a
binary data plane. The OpenAPI spec and generated TS types under
`apps/control-room/src/kernel/api/generated/` come from `just docker-dev-codegen`.

### Docker DEV runtime

Each checkout is one Compose group with exactly two services:

- `backend`: on every start it checks the read-only source bind and verified package,
  reuses that package or builds and validates a new one, passes host gates, then runs API
  and native runtime in the same container
  (`docker/all-in-one/backend_dev.py`, `backend_source.py`, `runtime_service.py`).
- `frontend`: Next.js dev with HMR (`docker/all-in-one/frontend_dev.py`); it watches natively on
  ext4/xfs/btrfs and polls on other mounts.

Host side: `scripts/docker_dev.py` (CLI) and `scripts/docker_volume_dev.py` (volume lifecycle),
with receipts in the group's `fullmag-build-control-*` volume. Each DEV group keeps its own
resource ledger (`group-ledger-v1`, ADR 0067) and a static CPU/RAM budget (`FULLMAG_DEV_*`), so
groups with different code can run APIs side by side; the global `host-ledger-v1` serves only
release, qualification and managed runtime. User sessions, results and projects live in the
configured host storage (`FULLMAG_PROJECT_STORAGE_ROOT` in the main checkout's `.env`); build data
lives only in Docker volumes and BuildKit.

New renders use one stable private `BuildControl.volume` per group (ADR 0076), with
`private/backend`, `private/frontend` and `private/ledger` subpaths. Frontend never mounts
the control root. Shared Cargo/pnpm/packages remain separate project resources. Toolchain,
profile and dependency changes invalidate compatibility, not the volume name. Only managed
compiler outputs `.fullmag-build` are cleaned before actual compilation and after verified
atomic package publication. Preserve current plus one rollback, source, logs, control,
ledger and user data. Cache hits do not compile or clean. Old groups need separate managed
migration; runtime compliance is NOT VERIFIED without their receipts and mount proof.
Image-only builds use Git/source identity without host storage; API user-data mounts remain.

Key decision records: ADR 0061 (same-container build and runtime), ADR 0064 (Linux/WSL host),
ADR 0067 (independent DEV groups), ADR 0076 (one private volume per group); guides in `docs/guides/docker-development-architecture.md` and
`docs/guides/docker-build-storage-lifecycle.md`; current state and measurements in
`docs/audits/2026-10-21-docker-dev-workflow-audit.md`.

### Documentation map

`docs/physics/` holds the physics; `docs/specs/` and `docs/adr/` hold application contracts;
`docs/architecture/backend-golden-masterplan.md` holds the backend architecture;
`public_docs/site/` is the published Sphinx/MyST site. Plans and audits under `docs/` are not
proof of a working runtime.
