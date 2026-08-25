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

## Audyt zamknięcia P0 FEM GPU — 2026-08-24

Pełne dowody requirement-by-requirement znajdują się w
[`fem-gpu/P0-CLOSURE-EVIDENCE.md`](fem-gpu/P0-CLOSURE-EVIDENCE.md).
Audyt dotyczy czystego HEAD
`d1c6193603e53acb11070cfd24e5ca1d3c099747` i zachowuje capability FEM GPU
w stanie `implemented/unvalidated`.

| Finding | Stan ogólny | Kryteria DoD | Decyzja |
|---|---|---|---|
| `FEM-GPU-ARCH-001` | `PARTIALLY CONFIRMED` | sole-production i no-fallback są potwierdzone tylko kontraktem źródłowym; oracle i hot-loop są `NOT VERIFIED`; capability nie została promowana | nie zamykać |
| `FEM-GPU-PERF-001` | `PARTIALLY CONFIRMED` | device RK i fail-closed receipt istnieją w źródle; brak managed hardware receipt, oracle i performance artifacts | nie zamykać |
| `FEM-GPU-PERF-009` | `PARTIALLY CONFIRMED` | hybrid ma jawną klasyfikację, ale brak dowodu odrzucenia publicznego strict przed krokiem oraz brak device-Poisson telemetry/oracle | nie zamykać |

Żaden z trzech findings nie ma kompletnego zestawu pięciu kryteriów Definition
of Done. Source tests i kompilacja nie są dowodem wykonania na GPU, parity
fizycznej ani budżetu hot-loop. Finalny review P0 wykazał dwie pozycje
`Important`: brak bezwarunkowego związania publicznego strict z natywnym
preflight przed krokiem oraz brak jednego exact tuple łączącego scientific
qualification z performance regression. Wymagane `0 Critical / 0 Important`
nie zostało osiągnięte.

Autorytatywne blokery środowiskowe pozostają rozdzielone od braków produktu:
uszkodzone upstream metadata `dpkg` obrazu CUDA, brak `setsid` w Windows managed
export oraz timeout kwalifikacji GPU bez receipt. Nie wykonano hostowego
substytutu i nie promowano capability.
