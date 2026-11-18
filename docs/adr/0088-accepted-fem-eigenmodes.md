# ADR 0088: Propozycja FEM Eigenmodes

## Status
Propozycja (Accepted)

## Kontekst
Obecny eigensolve FEM cierpi na problemy z wydajnością wynikające z zagnieżdżonego shift-invert oraz braku optymalizacji solverów PETSc.

## Decyzja
Wprowadzenie dokładnej faktoryzacji układu rozszerzonego (q, φ) z MUMPS/cuDSS.

## Konsekwencje
- Poprawa wydajności o rząd wielkości.
- Zwiększona złożoność implementacyjna w backendzie.
