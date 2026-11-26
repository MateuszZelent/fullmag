# Physics documentation

`docs/physics/` is the mandatory publication-style record of Fullmag's physical and numerical scope.

## Golden rule

Before implementing any new physics or numerics feature, create or update a note in this directory.

That note must describe:

- problem statement and motivation,
- governing equations, symbols, and SI units,
- assumptions and approximations,
- FDM, FEM, and hybrid interpretation,
- Python API and `ProblemIR` impact,
- planner and capability-matrix impact,
- validation strategy,
- completeness across the stack,
- deferred work.

## Why this exists

This directory is intended to evolve into:

- internal technical notes,
- reproducibility and validation records,
- publication supplements,
- the canonical physics reference for human contributors and coding agents.

## Naming convention

Recommended filenames:

- `0000-physics-documentation-standard.md`
- `0050-shared-problem-semantics-and-embedded-python-api.md`
- `0100-mesh-and-region-discretization.md`
- `units.md`
- `0200-llg-exchange-reference-engine.md`
- `0300-gpu-fdm-precision-and-calibration.md`
- `0400-demagnetization.md`
- `0406-rotated-interfacial-dmi.md` — kanoniczny kontrakt obróconego interfejsowego DMI z pracy Göbel 2019, stabilizującego bimerony; realizacje FDM/FEM CPU/GPU pozostają `NOT VERIFIED` do przejścia bramek runtime i naukowych.
- `0421-fdm-multilayer-convolution-demag.md` — kanoniczny kontrakt FDM dla wielowarstwowej konwolucji demagnetyzacyjnej; statusy kwalifikacji są w `multilayer_convolution/qualification-matrix.md`.
  Powiązane dowody: `0421-fdm-multilayer-convolution-demag.source-map.json`, źródłowy PDF w `multilayer_convolution/1_5116754 -- 4fb8226c2651eae7580a917b21d4fb18 -- Anna’s Archive.pdf` oraz jedyny manifest snapshotu BORIS `multilayer_convolution/boris-reference-manifest.v1.json`.
- `fem_exchange.md`
- `llg_conventions.md`
- `fem_zeeman.md`
- `fem_anisotropy_uniaxial.md`
- `fem_anisotropy_cubic.md`
- `fem_demag_poisson.md`
- `fem_demag_fem_bem.md`
- `fem_dmi.md`
- `fem_magnetoelastic.md`
- `fem_oersted.md`
- `fem_stt.md`
- `fem_thermal.md`
- `fem_thermal_brown.md`
- `0700-frequency-domain-linearized-llg.md`
- `0710-periodic-and-floquet-boundary-conditions.md`
- `0870-fem-bem-demag-open-boundary.md`
- `0880-active-effective-field-terms.md`
- `0900-native-fem-operator-contracts-and-validation.md`
- `0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
- [0952 · Harmoniczne źródło antenowe RF dla CPW](0952-harmonic-rf-antenna-cpw.md) — projekt modelu RF i kwalifikacji względem Maxwella.
- `0960-canonical-llg-time-domain-solver-and-qualification-contract.md`
- `1001-fem-gpu-pure-prism-p2-and-csr-dmi.md` — czysto-pryzmatyczna dyskretyzacja `pure_prism_p2` (P1 $\mathbf m$ + P2 $\phi$) na FEM CPU/GPU, zunifikowany operator CSR GPU DMI (`tet4`/`prism6`/`mixed`) oraz naprawa konforemności `layers >= 2`.
- `1005-fem-multiphysics-sparse-and-parallel-solvers.md` — modernizacja rzadkich i równoległych solverów multifizycznych FEM (OE-F2, OE-F1, transport ładunku/spinu, OE-T0 KKT).

The numbering is semantic, not bureaucratic.
