# Plany naprawcze — FEM GPU

Liczba ustaleń: **17**.

| ID | Priorytet | Klasa | Tytuł |
|---|---|---|---|
| `FEM-GPU-ARCH-001` | **P0** | `architecture` | [Executed-device proof i ścisła klasyfikacja FEM GPU](FEM-GPU-ARCH-001.md) |
| `FEM-GPU-PERF-001` | **P0** | `performance` | [Usunięcie hostowego integratora i hostowego Krylov z hot loop](FEM-GPU-PERF-001.md) |
| `FEM-GPU-PERF-009` | **P0** | `performance` | [Eliminacja hybrid CPU Poisson round-trip per stage](FEM-GPU-PERF-009.md) |
| `FEM-GPU-NUM-001` | **P1** | `numerics` | [Mixed precision i tolerancje solverów jako time-to-accuracy policy](FEM-GPU-NUM-001.md) |
| `FEM-GPU-NUM-002` | **P1** | `numerics` | [Device tangent-plane/IMEX dla sztywnych siatek](FEM-GPU-NUM-002.md) |
| `FEM-GPU-NUM-003` | **P1** | `numerics` | [Zgodność adaptive error z projected high-order candidate](FEM-GPU-NUM-003.md) |
| `FEM-GPU-PERF-002` | **P1** | `performance` | [Trwałe device assembly, restrictions, quadrature i preconditionery](FEM-GPU-PERF-002.md) |
| `FEM-GPU-PERF-003` | **P1** | `performance` | [Planner matrix-free/partial assembly zamiast wymuszonego legacy sparse](FEM-GPU-PERF-003.md) |
| `FEM-GPU-PERF-004` | **P1** | `performance` | [Device reductions i stop criteria bez synchronizacji per stage](FEM-GPU-PERF-004.md) |
| `FEM-GPU-PERF-005` | **P1** | `architecture` | [Jawna lokalizacja i lifecycle preconditionera](FEM-GPU-PERF-005.md) |
| `FEM-GPU-PERF-006` | **P1** | `performance` | [Device-side decyzja adaptacyjna bez `cudaStreamSynchronize`](FEM-GPU-PERF-006.md) |
| `FEM-GPU-PERF-007` | **P1** | `performance` | [Usunięcie podwójnego RK23 endpoint RHS i ogólna polityka FSAL](FEM-GPU-PERF-007.md) |
| `FEM-GPU-PERF-008` | **P1** | `performance` | [Harmonogram pełnych energii i obserwabli zamiast redukcji co krok](FEM-GPU-PERF-008.md) |
| `FEM-GPU-PHY-001` | **P1** | `physics` | [Pełna parity materiałów, Airbox, PBC, DMI i termiki](FEM-GPU-PHY-001.md) |
| `FEM-GPU-QUAL-001` | **P1** | `qualification` | [Sprzętowy CI, sanitizer, leak i time-to-accuracy qualification](FEM-GPU-QUAL-001.md) |
| `FEM-GPU-TRX-001` | **P1** | `transactionality` | [Minimalizacja device transaction kopiującej 13 pól i Poisson](FEM-GPU-TRX-001.md) |
| `FEM-GPU-PERF-010` | **P2** | `performance` | [CUDA Graphs i trwały harmonogram stage](FEM-GPU-PERF-010.md) |

Powrót do [indeksu głównego](../README.md).
