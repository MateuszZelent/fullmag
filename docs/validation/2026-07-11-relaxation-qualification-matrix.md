# Relaxation qualification matrix — 2026-07-11

This report records the current production contract after the complete
relaxation audit. The canonical physics definition is
`docs/physics/0580-canonical-relaxation-equilibrium-contract.md`.

## Contract conclusions

- `max_torque_Apm` is exactly `max_i |m_i × H_eff,i|` in `A/m`. Exact zero is
  valid. `max_torque_T = mu0 * max_torque_Apm` is a derived presentation value.
  The LLG RHS norm remains a separate quantity in `1/s` and is never used as a
  torque substitute.
- LLG owns integrator, `dt`, and physical time. PG-BB, NCG, and TPI own no
  dynamics or seconds-valued pseudo-time; their accepted line-search step is in
  `m/A`.
- Direct-minimizer scalar products use the physical `mu0 Ms_i V_i` metric.
  Every trial is norm-preserving and conservative interactions are refreshed
  before energy acceptance.
- Relaxation rejects thermal fields, spin torque, time-dependent fields, and
  unqualified Oersted fields. These remain dynamics workloads.
- FEM demag line searches use deterministic fresh Poisson initial states.
  NCG and development-only TPI resolve missing demag solver tolerance to
  `rtol=1e-12`; explicitly looser policies reject before runtime.
- FEM PG-BB with demag is production-qualified after direct, polarized Armijo
  increments for demag, exchange, uniaxial/cubic anisotropy, and DMI. The
  managed CPU/GPU interaction-matrix benchmark is the promotion evidence; no
  endpoint-total subtraction or hidden algorithm fallback remains.

## Algorithm and lane matrix

| Algorithm | FDM CPU | FDM CUDA | FEM CPU | FEM CUDA | Time semantics | Production status |
|---|---|---|---|---|---|---|
| `llg_overdamped` | qualified | qualified | qualified | qualified | requested explicit RK tableau and physical `dt`, seconds | production |
| `projected_gradient_bb` | qualified | qualified for supported material payloads | qualified, including demag at `rtol<=1e-12` | qualified, including demag at `rtol<=1e-12` | Armijo/BB step in `m/A`, time and `dt` absent | production |
| `nonlinear_cg` | qualified | qualified for supported material payloads | qualified, including demag at `rtol<=1e-12` | qualified, including demag at `rtol<=1e-12` | Armijo/PR+ step in `m/A`, time and `dt` absent | production |
| `tangent_plane_implicit` | unsupported | unsupported | development-only in `extended` mode | unsupported | implicit minimizer step in `m/A`, time and `dt` absent | development-only, fail-closed elsewhere |

Unsupported adaptive/tableau combinations and unsupported heterogeneous CUDA
material payloads fail capability checks; no lane silently substitutes Heun,
CPU execution, another minimizer, or a looser physical model.

## Cross-layer contract evidence

| Surface | Verified contract |
|---|---|
| Python DSL | finite SI validation, canonical defaults, algorithm-specific dynamics, symmetric script export/import |
| ProblemIR and planner | typed algorithm/stop fields, conservative legality, explicit requested/resolved execution, TPI gating, FEM PG-BB demag `rtol<=1e-12` policy |
| Native runtime | authoritative completion, exact torque telemetry, separate RHS norm, zero-time direct minimizers, deterministic demag energy oracle |
| OpenAPI v2 | typed algorithms, stop reasons, metric kinds and units; canonical fields plus formal deprecated aliases |
| Control Room | algorithm-specific Inspector fields, fixed/adaptive controls, exact `A/m`/`T` display, capability-gated TPI, no torque-unit fallback |

## Final evidence

- Managed runtime rebuild: PASS; bundle validated and promoted.
- Production FEM benchmark: PASS, including PG-BB FEM CPU/GPU demag, uniaxial, cubic, and DMI cases,
  `39` comparison pairs, required coverage `21/21`.
- Managed native source/operator/energy-derivative contracts: PASS, including
  demag directional derivative.
- Managed runtime and convergence gates: PASS for every supported lane;
  GPU TPI is explicitly skipped, and FEM PG-BB runs the qualified no-demag
  fixture. CPU/GPU consistency: PASS (`6/6` rows, `3/3` pairs).
- Python suite: `633` pass, `4` unrelated frequency/example failures, `1` skip;
  no relaxation failure.
- `fullmag-ir`: `119/119` PASS.
- `fullmag-plan`: `185` pass and one unrelated frequency-response assertion;
  all focused relaxation/demag policy tests PASS.
- `fullmag-engine`: `220/220` PASS; runner library `498/498` PASS; CLI
  `134/134` PASS. Remaining full-runner source-layout and API frequency test
  failures are outside relaxation.
- Control Room: typecheck PASS, lint PASS, Vitest `2750/2750` PASS, and the
  relaxation browser smoke PASS.
- OpenAPI regeneration: byte-identical generated output; no drift.
- Relaxation documentation checker: PASS (`3/3`).

Authoritative final benchmark artifacts:

- `.fullmag/reports/fullmag_relaxation_production_benchmark.csv`
- `.fullmag/reports/fullmag_relaxation_production_benchmark_summary.json`
- `.fullmag/reports/task13-managed-qualification/rebuild-fem-runtime-final4.log`
- `.fullmag/reports/task13-managed-qualification/verify-fem-relaxation-production-benchmark-final4.log`
- `.fullmag/reports/task13-managed-qualification/verify-fem-relaxation-runtime-final7.log`
- `.fullmag/reports/task13-managed-qualification/verify-fem-relaxation-convergence-final7.log`

The unrelated failures listed above are retained as baseline evidence and were
not weakened, skipped globally, or changed to make relaxation qualification
green.
