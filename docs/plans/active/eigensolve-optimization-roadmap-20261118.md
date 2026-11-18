# Roadmap Optymalizacji Eigensolve (FEM) - 2026-11-18

## Cel
Przyspieszenie solvera eigensolve FEM poprzez eliminację wąskich gardeł zidentyfikowanych w audycie z 2026-11-18.

## Priorytety (kolejność zysk/koszt)
1. **Etap 0:** Pomiary bazowe (liczniki iteracji, profile runtime).
2. **Etap 1:** Wdrożenie układu rozszerzonego (shift-invert) dla CPU (MUMPS) i GPU (cuDSS) - A1.
3. **Etap 2:** Optymalizacja digestów i provenance (v2 - binarna, CSR) - A8/D1.
4. **Etap 3:** Optymalizacja frontend-u (faza animacji, throtling) - E1.
5. **Etap 4:** Parallelizacja k-path - A5/A7.

## Weryfikacja
Wszystkie zmiany wymagają regresji przeciwko zestawom testowym z `tests/standard_problems/`.
