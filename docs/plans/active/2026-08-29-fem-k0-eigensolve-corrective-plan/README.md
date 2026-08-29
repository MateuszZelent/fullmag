# FEM K0 eigensolve — plan naprawczy i plan domknięcia (2026-08-29)

Ten katalog jest modularną wersją wykonawczego planu F0–F11. Kolejność jest bramkowana: najpierw repozytorium i kontrakty, następnie fizyka oraz produkcyjny CPU, później artefakty/UI, a dopiero na końcu produkcyjny GPU i release.

## Części

- [Plan: zasady, architektura, F0–F1](./01-principles-architecture-f0-f1.md)
- [Plan: F2–F4 kontrakty, równowaga i operator](./02-f2-f4-contracts-equilibrium-operator.md)
- [Plan: F5–F7 kwalifikacja CPU](./03-f5-f7-cpu-qualification.md)
- [Plan: F8–F11 artefakty, UI, GPU i release](./04-f8-f11-artifacts-ui-gpu-release.md)
- [Plan: DoD, ownership, test matrix i reguły](./05-dod-ownership-test-matrix-and-rules.md)

## Zasada nadrzędna

Nie wolno promować testu algebraicznego, syntetycznego Poisson-airbox ani bounded CUDA oracle do statusu produkcyjnego. Każdy lane ma osobny engine ID, zakres zastosowania, certyfikat i bramkę akceptacyjną.
