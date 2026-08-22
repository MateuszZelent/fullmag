# Mapowanie dokumentacji naprawczej do audytu

## Raporty źródłowe

- `../fdm-cpu.md`
- `../fdm-gpu.md`
- `../fem-cpu.md`
- `../fem-gpu.md`
- wcześniejszy source-level raport FDM CPU na gałęzi `audit/llg-solver-2026-08-21`;
- bezpośredni przegląd właścicieli integratorów, effective fields, transaction state, reductions, ABI i operatorów.

## Zasada mapowania

Broad finding z raportu skrótowego został rozdzielony na osobne zadania wtedy, gdy:

1. ma innego właściciela kodu;
2. wymaga osobnego reproducer/test gate;
3. może być wdrożony lub wycofany niezależnie;
4. ma inny priorytet albo ryzyko fizyczne;
5. dotyczy odrębnej klasy wykonania CPU/GPU.

Dlatego liczba planów jest większa niż liczba nagłówków P0/P1 w czterech skrótach. Nie są to nowe, arbitralne wymagania: są to wykonawcze granice zmian potrzebne do zamknięcia szerokich ustaleń audytowych.

## Podział

| Lane | Liczba planów |
|---|---:|
| FDM CPU | 11 |
| FDM GPU | 12 |
| FEM CPU | 12 |
| FEM GPU | 17 |
| **Razem** | **52** |
