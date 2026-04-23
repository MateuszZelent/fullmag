# Canonicalization Owner Matrix (2026-04-23 baseline)

| Boundary | Owner | Required reviewer | Test gate | Release gate |
|---|---|---|---|---|
| `ProblemIR` | `arch/core` | `py` + `ui/platform` | golden IR parity | Python/UI export parity |
| Lifecycle | `runtime` | `api` + `ui/platform` | lifecycle matrix | session truth checks |
| Resource-first data-plane | `api/data` | `runtime` + `ui/platform` | revision contract tests | payload budget checks |
| Mesh semantics | `fem/mesh` | `py` + `ui/platform` | mesh round-trip goldens | mesh workspace parity |
| Frontend contracts / `Viewport3D` | `ui/platform` | `api/data` | routing/capability E2E | unified routing cutover |
