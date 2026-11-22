# ADR 0087: align default `TextureMapping.clamp_mode` to `"none"` across Rust, Python, and Control Room

- Status: accepted for implementation
- Date: 2026-11-22
- Complements: [ADR 0011](0011-resource-first-api.md)
- Physics contract: [`docs/physics/0531-versioned-magnetic-preset-textures.md`](../physics/0531-versioned-magnetic-preset-textures.md), [`docs/physics/0534-magnetic-textures-v2-mapping-clamp-and-wave2-presets.md`](../physics/0534-magnetic-textures-v2-mapping-clamp-and-wave2-presets.md)
- Data contract: [`docs/specs/magnetization-init-policy-v0.md`](../specs/magnetization-init-policy-v0.md)

## Context

In `ProblemIR`, `InitialMagnetizationIR::PresetTexture` carries a `mapping`
object (`TextureMappingIR`) whose `clamp_mode` controls how points outside a
metric tile box $[P_x, P_y, P_z]$ are evaluated (`"none"`, `"clamp"`,
`"repeat"`, `"mirror"`, or `"background"`).

Prior to this change, the two canonical layers disagreed on the default value
when `clamp_mode` was omitted from JSON or constructed with defaults:

- Python (`packages/fullmag-py/src/fullmag/init/textures.py`, `TextureMapping`)
  and Control Room (`DEFAULT_TEXTURE_MAPPING`) defaulted `clamp_mode` to
  `"none"` (unbounded analytic evaluation across the target geometry).
- Rust (`crates/fullmag-ir/src/model.rs`, `default_texture_mapping_clamp_mode`)
  defaulted `clamp_mode` to `"clamp"`, while the v1/v2 evaluator previously did
  not apply metric box clamping unless `clamp_mode` was evaluated explicitly.

Once v2 `clamp_mode` evaluation was wired in both `fullmag-plan` and
`preset_eval_v2.py`, keeping `"clamp"` as the serde default in Rust caused any
IR or `SceneDocument` payload serialized without an explicit `clamp_mode` field
to clamp coordinates in Rust while evaluating unbounded `"none"` in Python.

## Decision

1. **Single default `"none"`.** `default_texture_mapping_clamp_mode()` in
   `crates/fullmag-ir/src/model.rs` returns `"none"`, matching Python
   `TextureMapping(clamp_mode="none")` and Control Room defaults.
2. **Explicit opt-in boundary folding.** Clamping, periodic tiling (`"repeat"`),
   reflection (`"mirror"`), and exterior constant fill (`"background"`) execute
   only when `mapping.clamp_mode` is explicitly set to one of those modes.
3. **Canonical serialization.** Python `PresetTexture.to_ir()`, Rust
   `TextureMappingIR`, and canonical script export always serialize
   `clamp_mode` explicitly; `"none"` is omitted from fluent `.with_mapping(...)`
   calls only when all other mapping fields are also at their defaults.

## Consequences

- **Cross-layer parity:** Rust planner sampling, Python reference evaluation,
  and Control Room 3D texture previews produce identical magnetization fields
  when `clamp_mode` is omitted or set to `"none"`.
- **Historical IR migration:** Pre-existing JSON IR files that omitted
  `mapping.clamp_mode` already received unbounded analytic evaluation in prior
  evaluators (which ignored `"clamp"`); normalizing omitted `clamp_mode` to
  `"none"` therefore preserves their historical numerical output while making
  explicit `"clamp"` opt-in deterministic.
