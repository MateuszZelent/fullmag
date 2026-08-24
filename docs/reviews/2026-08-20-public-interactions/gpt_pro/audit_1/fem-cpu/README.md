# Plany naprawcze — FEM CPU

Liczba ustaleń: **12**.

| ID | Priorytet | Klasa | Tytuł |
|---|---|---|---|
| `FEM-CPU-ARCH-001` | **P1** | `architecture` | [Kanoniczna reprezentacja true/local/element/quadrature state](FEM-CPU-ARCH-001.md) |
| `FEM-CPU-NUM-001` | **P1** | `numerics` | [Norma adaptacyjna i stop criteria uwzględniające miarę FEM](FEM-CPU-NUM-001.md) |
| `FEM-CPU-NUM-002` | **P1** | `numerics` | [Stiffness-aware wybór integratora dla `h_min` i exchange](FEM-CPU-NUM-002.md) |
| `FEM-CPU-PERF-001` | **P1** | `performance` | [Rozdzielenie setup/assembly od wielokrotnego operator apply](FEM-CPU-PERF-001.md) |
| `FEM-CPU-PERF-002` | **P1** | `performance` | [Minimalny journal zamiast głębokiej kopii `RkStepTransaction`](FEM-CPU-PERF-002.md) |
| `FEM-CPU-PERF-003` | **P1** | `performance` | [Bez-alokacyjny snapshot pojedynczej próby adaptacyjnej](FEM-CPU-PERF-003.md) |
| `FEM-CPU-PERF-004` | **P1** | `performance` | [Preconditioned, blokowy solve macierzy masy](FEM-CPU-PERF-004.md) |
| `FEM-CPU-PERF-005` | **P1** | `performance` | [Reuse operatora i warm-start demag Poissona/Airbox](FEM-CPU-PERF-005.md) |
| `FEM-CPU-PERF-006` | **P1** | `performance` | [Eliminacja nadmiarowego final endpoint RHS/Poisson](FEM-CPU-PERF-006.md) |
| `FEM-CPU-PHY-001` | **P1** | `physics` | [Spójność materiałów, DMI/PBC i wykluczenie Airbox](FEM-CPU-PHY-001.md) |
| `FEM-CPU-PERF-007` | **P2** | `performance` | [Jedna polityka wątków, NUMA i bibliotek solverowych](FEM-CPU-PERF-007.md) |
| `FEM-CPU-QUAL-001` | **P2** | `qualification` | [Pełna kwalifikacja przestrzenna, czasowa i wydajnościowa FEM CPU](FEM-CPU-QUAL-001.md) |

Powrót do [indeksu głównego](../README.md).
