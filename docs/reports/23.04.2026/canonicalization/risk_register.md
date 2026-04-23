# Canonicalization Risk Register (2026-04-23 baseline)

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| Python/UI emit non-equivalent IR | medium | high | golden parity fixtures + export gates | `arch/core` |
| Lifecycle state drift between runtime and UI | medium | high | typed lifecycle contract + matrix tests | `runtime` |
| Resource invalidation regressions | medium | high | revision-family tests + status-thin gate | `api/data` |
| Mesh semantic mismatch after remesh | medium | high | mesh round-trip goldens + provenance checks | `fem/mesh` |
| Legacy 3D path leaks into new features | high | medium | deny-legacy-viewports CI gate | `ui/platform` |
| Capability heuristics reintroduced in UI | high | medium | deny-capability-synthesis CI gate | `ui/platform` |
