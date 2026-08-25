# Plan remediacji solvera LLG

## M0 — correctness gate

- jeden kanoniczny kontrakt LLG i jednostek;
- macrospin, norma i energy-dissipation oracles;
- rollback rejected step wraz z RNG/cache;
- parity RHS/stage/step/trajectory;
- strict requested/resolved/executed backend.

## M1 — steady-state memory gate

- brak alokacji i assembly w hot path;
- trwałe stage/scratch/field buffers;
- cache planów FFT, form FEM, restrictions, quadrature i preconditionerów;
- jawne dependency invalidation.

## M2 — CPU optimization

- SoA, SIMD, chunking i aktywne indeksy dla FDM;
- matrix-free/partial assembly i tolerancje solverów dla FEM;
- NUMA/thread-budget policy bez oversubscription.

## M3 — GPU residency

- zero pełnych H2D/D2H w steady-state step;
- urządzeniowe redukcje, accept/reject i stop criteria;
- brak silent fallback;
- graph/command reuse i sprzętowe CI.

## M4 — algorithmic time-to-solution

- liczba kosztownych field evaluations na osiągniętą dokładność;
- przyszły fizyczno-czasowy tangent-plane/semi-implicit/IMEX dla stiffness; bieżący FEM CPU TPI pozostaje wyłącznie relaksacją time-to-equilibrium;
- single/mixed precision wyłącznie w lane, który najpierw ma implementację i jawne capability, a następnie przechodzi time-to-accuracy qualification;
- progi regresji poprawności i wydajności w CI.
