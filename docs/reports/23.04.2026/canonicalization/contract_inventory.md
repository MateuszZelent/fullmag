# Contract Inventory (2026-04-23 snapshot)

| Public contract | Current producer(s) | Current consumer(s) | Drift symptom | Desired owner | Existing tests | Missing tests |
|---|---|---|---|---|---|---|
| `ProblemIR` payload | Python exporter, UI exporter | planner, runtime, CLI | Python/UI parity not enforced as one gate | `arch/core` | `fullmag-ir` + planner tests | cross-surface golden parity |
| Session lifecycle model | runtime + API status projection | UI status panels, telemetry | mixed lifecycle vocabulary in runtime/UI views | `runtime` | selected API/runtime tests | terminal-state matrix + stop reason parity |
| Command completion read model | runtime command ledger | UI command tracking | queued/dispatched stronger than completion truth | `runtime` | partial router tests | canonical completion resource tests |
| Resource revision map | API status + resource handlers | resource hooks/cache keys | topology/field/slice coupling risk | `api/data` | endpoint reference + hook tests | independent revision assertions |
| Mesh 3-level semantics | authoring + planner + mesh runtime | UI mesh workspace + export | per-object/shared-domain semantics can diverge | `fem/mesh` | mesh route tests | round-trip semantic equivalence suite |
| `status.capabilities` gating | API status | UI toolbar/routing guards | local synthesis from discretization still present | `ui/platform` | capability guard unit tests | end-to-end gating source-of-truth tests |
