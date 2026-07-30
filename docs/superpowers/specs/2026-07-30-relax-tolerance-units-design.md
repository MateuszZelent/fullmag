# Relaxation tolerance units: `tolT` and `tolA`

## Decision

`tolT` is the public default relaxation-torque tolerance.  Its unit is tesla,
matching the `Max Torque` scalar convention exposed by MuMax-like interfaces.
The default is `tolT=1e-6`.

`tolA` is the explicit alternative for authoring the same threshold in
amperes per metre.  Exactly one of `tolT` and `tolA` may be supplied.  The
former unqualified `tol` keyword is removed; its use is a validation error
with a migration hint.

The numerical and `ProblemIR` canonical representation remains
`torque_tolerance_apm`.  Lowering converts the public tesla value according to

```{math}
\mu_0 H_{\mathrm{tol}} = \mathrm{tolT},
\qquad
H_{\mathrm{tol}} = \frac{\mathrm{tolT}}{\mu_0},
\qquad
\mu_0 = 4\pi\times10^{-7}\ \mathrm{T\,m\,A^{-1}}.
```

Therefore `tolT=1e-6` lowers to
`torque_tolerance_apm=0.7957747154594767`.

## API and compatibility

- Every public relaxation entry point, including staged and flat APIs, accepts
  `tolT` and `tolA`.
- Omitting both uses `tolT=1e-6`; no implicit A/m interpretation remains.
- Supplying both is rejected before a stage is captured or executed.
- Supplying `tol` is rejected with a message to use `tolT` or `tolA`.
- Script export always emits `tolT`, converting the canonical A/m IR value so
  newly exported scripts use the default public unit.

## Scope and verification

The migration updates all repository-owned relaxation scripts, examples, and
tests that use the removed `tol` keyword.  Tests first prove the default,
each explicit unit, exact mutual-exclusion rejection, legacy-keyword rejection,
IR lowering, and canonical script export.  Existing backend execution remains
unchanged because it continues to consume the canonical A/m threshold.

The canonical relaxation publication at
`docs/physics/0580-canonical-relaxation-equilibrium-contract.md` will be
updated before implementation to describe the public unit contract and retain
the A/m internal stop criterion.
