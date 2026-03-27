---
applyTo: "crates/**/*.rs"
description: "Use when editing Rust files in Fullmag. Keep Rust as the typed control plane with explicit domain models, execution-policy seams, and stable interfaces."
---

> **Canonical source: [`AGENTS.md`](../../AGENTS.md)** - this file adds context-scoped detail.

# Rust instructions

- Prefer domain types over free-form maps and raw JSON.
- Keep crate dependencies lean; extract shared types into `fullmag-ir` before duplicating.
- Keep the distinction between backend-neutral problem truth and resolved execution truth explicit in
  types.
- Model requested and resolved execution separately when adding planning, session, run, or
  provenance fields.
- Make invalid states hard to represent.
- Favor `Result`-based APIs with helpful error messages over panics.
- Keep public interfaces ready for CLI, API, worker, control-room, and script-export reuse.
- Prefer repository build/run verification through `justfile` recipes before dropping to raw `cargo` or `docker compose`. For heavy runtimes, treat `just build fem-gpu-runtime-host` and `just package fullmag` as the canonical host-artifact workflow.
- **Keep `.rs` files under ~1000 lines.** Split large modules into submodules with `mod` re-exports. A crate with one monolithic `lib.rs` is a code smell.
