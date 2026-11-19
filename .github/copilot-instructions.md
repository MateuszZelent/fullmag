# Copilot instructions for Fullmag

> **Canonical source: [`AGENTS.md`](../AGENTS.md)**
> This file is a summary for Copilot. If anything here contradicts `AGENTS.md`, `AGENTS.md` wins.

## Key rules (summary of AGENTS.md)

- **Physics before implementation.** Before implementing any physics or numerics feature, create or update a publication-style note in `docs/physics/` using `docs/physics/TEMPLATE.md`. Missing physics documentation is a blocker.
- Fullmag has one semantic core across Python, UI, `ProblemIR`, planning, session/run APIs, and backend execution.
- The only canonical public scripting surface is the embedded Python DSL in `packages/fullmag-py`.
- Python and UI authoring flows must converge to canonical `ProblemIR`; Rust validates, normalizes, plans, and orchestrates execution.
- UI-authored simulations must be exportable as canonical, human-editable Python scripts.
- The shared API must describe physics and runtime truth, not grid internals, raw GPU arrays, or FEM-only implementation details.
- The canonical local browser contract is resource-first: thin `status`, on-demand resources, JSON control plane, binary data plane.
- `POST /v1/live/current/commands` should use the structured discriminated `kind` union body, not loose `command + params`.
- Frontend components should go through one typed API client and one resource-hook layer; avoid direct `fetch()` calls in React components.
- FDM/FEM control-room differences belong in capability guards and domain adapters, not duplicated UI trees.
- Current execution priority is calibrated GPU-first FDM/CUDA, but the product shell must remain modular and backend-neutral enough for explicit CPU/GPU and FDM/FEM selection.
- Requested execution intent and resolved execution reality must stay explicit across user surfaces, planning, and provenance.
- Treat `docs/specs/fullmag-application-architecture-v2.md`, `docs/specs/resource-first-control-room-api-v1.md`, `docs/specs/control-room-api-endpoint-reference-v1.md`, `docs/specs/session-run-api-v1.md`, `docs/specs/runtime-distribution-and-managed-backends-v1.md`, `docs/physics/`, and ADRs as canonical architecture references.
- Assume container-first verification and prefer canonical `just` workflows over ad-hoc commands.
- For code review, PR descriptions, review comments, and reviewer-feedback handling, follow `.agents/skills/google-eng-review-practices/SKILL.md` together with the relevant Fullmag domain instructions.
- Daily development uses the selected checkout's managed Compose group: `python -B scripts/setup_docker.py`, `just docker-dev-toolchain`, then `just docker-dev`. Application compilation and API run in the same `backend`; frontend uses HMR. Release/scientific/CI routes keep their separately documented recipes. Do not use host Cargo/CMake, the old runner or raw Docker as a daily DEV fallback.
- New DEV renders use exactly one stable private `BuildControl.volume` per worktree/group with `private/backend`, `private/frontend` and `private/ledger` subpaths (ADR 0076). The frontend never mounts the control root. Shared Cargo/pnpm/packages remain project resources. Fingerprints validate compatibility without creating new private volume names.
- Clean only managed `.fullmag-build` compiler outputs before actual compilation and after verified atomic package publication. Preserve current plus one verified rollback, sources, logs, control, ledger and user data. Cache hits do not compile or clean. Existing groups need separate managed migration; runtime remains NOT VERIFIED without receipt/mount evidence.
- Image-only builds need Git/source and Docker, without host build storage. Host sessions, projects, results and settings used by the API remain protected user data.
- Do not compile unit tests (`cargo test`, `just test`) until the user revokes the temporary ban in AGENTS.md.
- Review complexity and contracts using the review skill; file size is a signal for review, not an automatic split threshold.
