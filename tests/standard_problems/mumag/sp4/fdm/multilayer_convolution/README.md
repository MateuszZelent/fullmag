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

## Verification

Run the configuration verifier:

```bash
python tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/verify.py
python -m pytest tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/test_verify.py -q
```

Passing these checks validates schema and immutable inputs only. It is not a
CPU, CUDA, direct-oracle, Airbox-rendering, or production-qualification pass.
