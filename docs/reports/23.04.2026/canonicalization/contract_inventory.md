# Contract Inventory (2026-04-25 snapshot)

| Public contract | Current producer(s) | Current consumer(s) | Drift symptom | Desired owner | Existing tests | Missing tests |
|---|---|---|---|---|---|---|
| `ProblemIR` payload | Python exporter, UI exporter | planner, runtime, CLI | previous public IR needed explicit read migration | `arch/core` | `fullmag-ir` + planner tests | cross-surface golden parity |
| Session lifecycle model | runtime + API status projection | UI status panels, telemetry | mixed lifecycle vocabulary in runtime/UI views | `runtime` | selected API/runtime tests | terminal-state matrix + stop reason parity |
| Command completion read model | runtime command ledger | UI command tracking | lifecycle states and outcomes were not separately documented | `runtime` | router tests + `command-lifecycle-v1` | richer runtime completion event coverage |
| Resource revision map | API status + resource handlers | resource hooks/cache keys | topology/field/slice aliases could hide invalidation bugs | `api/data` | endpoint reference + hook tests | realtime revision parity assertions |
| Mesh 3-level semantics | authoring + planner + mesh runtime | UI mesh workspace + export | per-object/shared-domain semantics can diverge | `fem/mesh` | mesh route tests | round-trip semantic equivalence suite |
| `status.capabilities` gating | API status | UI toolbar/routing guards | local synthesis function removed; remaining bridges require canonical capability input or explicit fallback | `ui/platform` | capability guard unit tests | end-to-end gating source-of-truth tests |
