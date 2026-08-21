# Wymagania provenance dla wykonania LLG

Wynik każdej sesji powinien przechowywać:

- requested, resolved i executed solver/backend/device/precision;
- wersję równania LLG, konwencję `gamma`, pole `H`/`B` i użycie `mu0`;
- integrator, tableau, tolerancje, limiter kroku i politykę projekcji normy;
- receipt każdego składnika `H_eff`, jego lokalizację wykonania i cache revision;
- mesh/grid/material/boundary/PBC revisions;
- accepted/rejected steps i liczbę field evaluations;
- transfery, synchronizacje, assembly/preconditioner rebuilds;
- RNG algorithm, seed, counter i rejected-step policy dla termiki;
- stop reason oraz jednostki torque/energy/error metrics.

Bez tych danych porównanie CPU/GPU i odtworzenie wyniku nie jest wiarygodne.
