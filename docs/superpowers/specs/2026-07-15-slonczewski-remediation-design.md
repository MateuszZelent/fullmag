# Canonical Slonczewski Remediation Design

## Scope

Repair the canonical `slonczewski.fullmag.v1` FDM contract without changing
dynamic Oersted behavior or the bit-compatible
`slonczewski.legacy_fullmag.v0` evaluator.

## Physics and versioning

The engine configuration carries an explicit formula discriminator. Legacy v0
continues to use the historical rounded charge constant, current magnitude,
fixed-layer sign, and historical interpretation of `epsilon_prime`. Canonical
v1 uses signed `J_c dot n_stack`, the exact SI elementary charge, a resolved
target mask, and the independent field-like coefficient from physics note 0960.

For `D=m x (m x p)` and `C=m x p`, the canonical explicit RHS is

```text
Omega_J [(epsilon + alpha epsilon_prime) D
       + (epsilon_prime - alpha epsilon) C] / (1 + alpha^2).
```

## Lane behavior

- FDM CPU double executes canonical thin-layer homogenized v1 and remains the
  algebraic oracle.
- FDM CUDA retains legacy v0 execution. Canonical v1 fails during native
  construction until its ABI carries formula version, stack normal, signed
  current, and the separate target mask.
- `slonczewski_interface_flux.v1` fails in FDM planning. Its realization
  identity remains in planning state so the rejection is explicit and
  provenance-safe; it is not lowered to a bulk `1/t_F` source.

## Validation and normalization

Canonical axes are finite, nonzero, and normalized before execution. Raw
ProblemIR and Python reject nonfinite `lambda_asymmetry`, `epsilon_prime`, and
free-layer thickness. Python canonical construction emits normalized axes;
Rust planning repeats normalization so non-Python authoring has identical
semantics.

## Verification

Tests use an independent macrospin oracle derived directly from the Gilbert
source. They cover nonzero independent `epsilon_prime`, exact SI scaling,
signed-current reversal, target masking, and AoS/SoA parity. Separate tests
prove legacy regression behavior, InterfaceFlux FDM rejection, nonfinite input
rejection, normalization, and CUDA canonical fail-closed behavior.

