# P6-A — jawna tożsamość pochodnego Kittel fit

Data: 29.09.2026

Status: **SOURCE VERIFIED / REGRESSION TEST AUTHORED, NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

Bezpośredni writer modal-eigen przekazuje teraz
`FrequencyDomainArtifactIdentity` także do pochodnego
`fmr/kittel_fit.v1.json`. Identity-aware builder zapisuje dokładne
`session_id`, `run_id`, `stage_id` i `runtime_id`; walidacja wspólnego typu
odrzuca mutable alias przed utworzeniem artefaktu.

Dotychczasowy builder bez kontekstu pozostaje wyłącznie compatibility boundary
dla niemigrowanych adapterów FEM i historycznych test fixtures. Nowa gałąź nie
interpretuje jego `run:current` jako prawdziwego ID i nie migruje starego pliku
in-place.

## Dowody

- `cargo check -p fullmag-runner --lib`: **PASS**.
- Regression check bezpośredniego writera weryfikuje cztery dokładne ID w
  zapisanym Kittel fit.
- Test pozostaje **NOT RUN** zgodnie z tymczasowym zakazem budowania i
  uruchamiania testów jednostkowych w `AGENTS.md`.

## Otwarte elementy

Legacy builder zostanie usunięty dopiero po przeprowadzeniu publication identity
przez generatory FEM. Resource keys, FMR, copy-on-write migrator, publiczne API,
generated client i czterolane runtime/scientific qualification pozostają
otwarte.
