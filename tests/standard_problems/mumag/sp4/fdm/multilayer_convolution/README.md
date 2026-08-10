# SP4-derived FDM multilayer convolution qualification

Ten katalog definiuje wyłącznie deterministyczne wejścia kwalifikacyjne dla
wielowarstwowej konwolucji FDM. Każdy artefakt i każdy przyszły wynik musi być
oznaczony: **SP4-derived, not canonical SP4 qualification**. Nie zmienia on
kanonicznego kontraktu ani referencji NIST dla µMAG Standard Problem 4.

This directory contains deterministic qualification inputs only. It does not
claim a runtime result, physical validation, or canonical SP4 qualification.

## Frozen baseline

- Two disconnected films, each `500 x 125 x 3 nm`, derived from the canonical
  SP4 material and dynamics contract.
- Each native film uses `128 x 32 x 1` cells with spacing
  `3.90625 x 3.90625 x 3 nm`.
- The baseline centre separation is `9 nm`; the non-magnetic vacuum gap is
  `6 nm`. Inter-object exchange is disabled and is included in provenance.
- The grid-aligned vacuum-gap sweep is `3, 6, 12, 24 nm`. Off-grid gaps belong
  to a separately labelled push/pull-transfer lane.
- Cross coupling must later be checked as
  `H_A<-B = H_A(A+B) - H_A(A)`, with a source-sign flip and a zero-pair-kernel
  negative control.

## Airbox observation contract

The target-only Airbox uses `128 x 32` XY cells and `3 nm` Z spacing. It
requires padding of `3`, `6`, and `12` cells above and below each support;
direct samples use offsets `1`, `2`, and `4` cells at the centre, long edge,
and short edge. Its only published field is `H_demag` under `scope_kind=airbox`.
`H_eff` is intentionally unavailable with reason code
`fdm_multilayer_airbox_h_eff_unavailable.v1`.

Coordinates are deterministic: the coordinate system is Cartesian SI; the
XY origin is the lower support bound; the Z origin is the lower support bound
minus the selected symmetric padding; and cell centres follow
`origin + (i+0.5,j+0.5,k+0.5)*spacing`. The padding is target-only (`target_only:
true`) and never becomes a magnetic source. Samples are taken along centre,
long-edge, and short-edge support normals at offsets `1`, `2`, and `4` cell
centres, with no sample on a cell boundary.

The zero-based anchor cells are explicit: `center=(64,16)`,
`long_edge=(64,31)` on the Y-normal edge, and `short_edge=(127,16)` on the
X-normal edge. The verifier records this anchor rule and rejects any drift.

The material/dynamics slice is frozen against the canonical SP4 contract:
`Ms=8e5 A/m`, `Aex=1.3e-11 J/m`, `alpha=0.02`,
`gamma_mu0=2.211e5 m/(A s)`, the canonical normalized initial magnetization,
and case-a/case-b applied fields. The verifier fails closed if that canonical
slice changes.

## Verification

Run the configuration verifier:

```bash
python tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/verify.py
python -m pytest tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/test_verify.py -q
```

Passing these checks validates schema and immutable inputs only. It is not a
CPU, CUDA, direct-oracle, Airbox-rendering, or production-qualification pass.

## SP4-derived CPU scenario

`scenario.py` is a separate, non-canonical SP4-derived run. It requests the
FDM `multilayer_convolution` / `two_d_stack` strategy and deliberately changes
the target-only Airbox to `160 x 40` cells in XY, with five cells above and
nine below the magnetic supports. The Airbox publishes only `H_demag`; `H_eff`
remains unavailable under the reason code above. Loading the script and
inspecting its `ProblemIR` is covered by `test_runtime.py`.

Fresh CPU output is accepted only through the fail-closed verifier:

```bash
PYTHONPATH=packages/fullmag-py/src \
  python -m tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.runtime_verify \
  /path/to/runtime.json
```

The JSON must be produced by an actual `fdm/cpu/double` run and contain the
declared Airbox provenance, `H_A<-B`, demagnetizing energy, and coupling
outputs. A missing or synthetic artifact is rejected and does not qualify the
runtime or the physics.

To derive that JSON from real solver output, run the A+B scenario and two
control scenarios (A-only and B-only), each with `H_demag` snapshots, then use
the repository measurement utility:

```bash
PYTHONPATH=packages/fullmag-py/src:. \
  python -m tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.measure_runtime \
  /path/to/ab-runtime /path/to/a-only-runtime /path/to/b-only-runtime \
  /path/to/runtime.json

PYTHONPATH=packages/fullmag-py/src:. \
  python -m tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.runtime_verify \
  /path/to/runtime.json
```

`measure_runtime.py` only reads per-layer step-zero snapshots and
`m_initial.json`; it computes `H_A<-B` by the declared field difference and
checks the reciprocal energy from the B-only control. It never fills missing
values or turns fixture data into a qualification result.
