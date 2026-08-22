# Dokumentacja naprawcza solvera LLG

**Repozytorium:** `MateuszZelent/fullmag`  
**Źródłowy audyt:** `docs/audits/llg-solver-2026-08-21`  
**Audytowany snapshot kodu:** `04e362df5dd51b1e6acca3aab9033c8124d3d6d0`  
**Liczba osobnych planów naprawczych:** **52**

## Cel

Katalog zawiera osobny plik Markdown dla każdego ustalenia wymagającego naprawy lub kwalifikacji w ścieżkach:

- FDM CPU;
- FDM GPU/CUDA;
- FEM CPU/MFEM;
- FEM GPU/CUDA/Hypre.

Każdy plik definiuje mechanizm błędu, target architecture, plan zmian, spodziewane pliki kodu, testy, telemetrykę, ryzyka i jednoznaczne `Definition of Done`.

## Reguły wykonania

1. Najpierw zamykane są P0: hang, drift ABI, błędny FSAL i niejawne tryby hybrydowe.
2. Optymalizacja nie może zmieniać physics realization bez nowego realization ID.
3. Każdy PR implementacyjny musi zawierać test reprodukujący oraz dowód requested/resolved/executed path.
4. Smoke test nie jest kwalifikacją fizyczną.
5. `steps/s` bez kontroli błędu nie jest kwalifikacją wydajności.
6. Stary lane może pozostać wyłącznie jako jawny `legacy` lub `hybrid`, nie jako silent fallback.

## Zestawienie

| ID | Priorytet | Lane | Klasa | Dokument |
|---|---|---|---|---|
| `FDM-CPU-NUM-001` | **P0** | FDM CPU | `numerics` | [Naprawa kontrolera retry adaptacyjnego RK23/RK45](fdm-cpu/FDM-CPU-NUM-001.md) |
| `FDM-GPU-ABI-001` | **P0** | FDM GPU | `architecture` | [Usunięcie driftu `fullmag_fdm_plan_desc` i obowiązkowy build feature CUDA](fdm-gpu/FDM-GPU-ABI-001.md) |
| `FDM-GPU-ARCH-001` | **P0** | FDM GPU | `architecture` | [Strict device-resident LLG i zakaz niejawnego fallbacku](fdm-gpu/FDM-GPU-ARCH-001.md) |
| `FDM-GPU-NUM-003` | **P0** | FDM GPU | `numerics` | [Wyłączenie FSAL dla termiki i niezgodnych źródeł zależnych od czasu](fdm-gpu/FDM-GPU-NUM-003.md) |
| `FEM-GPU-ARCH-001` | **P0** | FEM GPU | `architecture` | [Executed-device proof i ścisła klasyfikacja FEM GPU](fem-gpu/FEM-GPU-ARCH-001.md) |
| `FEM-GPU-PERF-001` | **P0** | FEM GPU | `performance` | [Usunięcie hostowego integratora i hostowego Krylov z hot loop](fem-gpu/FEM-GPU-PERF-001.md) |
| `FEM-GPU-PERF-009` | **P0** | FEM GPU | `performance` | [Eliminacja hybrid CPU Poisson round-trip per stage](fem-gpu/FEM-GPU-PERF-009.md) |
| `FDM-CPU-ARCH-001` | **P1** | FDM CPU | `architecture` | [Jedna semantyka fizyki dla AoS i SoA](fdm-cpu/FDM-CPU-ARCH-001.md) |
| `FDM-CPU-NUM-002` | **P1** | FDM CPU | `numerics` | [Jawny kontrakt projected RK i kwalifikacja rzędu](fdm-cpu/FDM-CPU-NUM-002.md) |
| `FDM-CPU-PERF-001` | **P1** | FDM CPU | `performance` | [Warstwowa polityka obserwabli zamiast `EvaluationRequest::Full` co krok](fdm-cpu/FDM-CPU-PERF-001.md) |
| `FDM-CPU-PERF-002` | **P1** | FDM CPU | `performance` | [Usunięcie klonów i alokacji z gorącej pętli](fdm-cpu/FDM-CPU-PERF-002.md) |
| `FDM-CPU-PHY-001` | **P1** | FDM CPU | `physics` | [Kanoniczny naturalny warunek brzegowy DMI dla masek i obiektów](fdm-cpu/FDM-CPU-PHY-001.md) |
| `FDM-CPU-PHY-002` | **P1** | FDM CPU | `physics` | [Przestrzenne `Ms` i `alpha` w termice oraz lokalnych kontraktach](fdm-cpu/FDM-CPU-PHY-002.md) |
| `FDM-CPU-TRX-001` | **P1** | FDM CPU | `transactionality` | [Atomowy commit termicznego RNG i stanu integratora](fdm-cpu/FDM-CPU-TRX-001.md) |
| `FDM-GPU-NUM-001` | **P1** | FDM GPU | `numerics` | [Kanoniczna norma błędu adaptacyjnego na GPU](fdm-gpu/FDM-GPU-NUM-001.md) |
| `FDM-GPU-NUM-002` | **P1** | FDM GPU | `numerics` | [Polityka precyzji dla stanu, pól, FFT i redukcji](fdm-gpu/FDM-GPU-NUM-002.md) |
| `FDM-GPU-PERF-001` | **P1** | FDM GPU | `performance` | [Usunięcie hostowej synchronizacji z decyzji adaptacyjnej](fdm-gpu/FDM-GPU-PERF-001.md) |
| `FDM-GPU-PERF-002` | **P1** | FDM GPU | `performance` | [Oddzielenie statystyk kontrolnych od pełnego odświeżania obserwabli](fdm-gpu/FDM-GPU-PERF-002.md) |
| `FDM-GPU-PERF-003` | **P1** | FDM GPU | `performance` | [Fuzja kerneli lokalnych i ograniczenie launch overhead](fdm-gpu/FDM-GPU-PERF-003.md) |
| `FDM-GPU-PERF-004` | **P1** | FDM GPU | `performance` | [Trwałe bufory, plany FFT i wersjonowane deskryptory urządzeniowe](fdm-gpu/FDM-GPU-PERF-004.md) |
| `FDM-GPU-PHY-001` | **P1** | FDM GPU | `physics` | [Pełne spięcie pól materiałowych i warunków DMI w CUDA](fdm-gpu/FDM-GPU-PHY-001.md) |
| `FDM-GPU-QUAL-001` | **P1** | FDM GPU | `qualification` | [Sprzętowe CI, Compute Sanitizer i time-to-accuracy gate](fdm-gpu/FDM-GPU-QUAL-001.md) |
| `FDM-GPU-TRX-001` | **P1** | FDM GPU | `transactionality` | [Retry-safe termika, cache i checkpoint urządzeniowy](fdm-gpu/FDM-GPU-TRX-001.md) |
| `FEM-CPU-ARCH-001` | **P1** | FEM CPU | `architecture` | [Kanoniczna reprezentacja true/local/element/quadrature state](fem-cpu/FEM-CPU-ARCH-001.md) |
| `FEM-CPU-NUM-001` | **P1** | FEM CPU | `numerics` | [Norma adaptacyjna i stop criteria uwzględniające miarę FEM](fem-cpu/FEM-CPU-NUM-001.md) |
| `FEM-CPU-NUM-002` | **P1** | FEM CPU | `numerics` | [Stiffness-aware wybór integratora dla `h_min` i exchange](fem-cpu/FEM-CPU-NUM-002.md) |
| `FEM-CPU-PERF-001` | **P1** | FEM CPU | `performance` | [Rozdzielenie setup/assembly od wielokrotnego operator apply](fem-cpu/FEM-CPU-PERF-001.md) |
| `FEM-CPU-PERF-002` | **P1** | FEM CPU | `performance` | [Minimalny journal zamiast głębokiej kopii `RkStepTransaction`](fem-cpu/FEM-CPU-PERF-002.md) |
| `FEM-CPU-PERF-003` | **P1** | FEM CPU | `performance` | [Bez-alokacyjny snapshot pojedynczej próby adaptacyjnej](fem-cpu/FEM-CPU-PERF-003.md) |
| `FEM-CPU-PERF-004` | **P1** | FEM CPU | `performance` | [Preconditioned, blokowy solve macierzy masy](fem-cpu/FEM-CPU-PERF-004.md) |
| `FEM-CPU-PERF-005` | **P1** | FEM CPU | `performance` | [Reuse operatora i warm-start demag Poissona/Airbox](fem-cpu/FEM-CPU-PERF-005.md) |
| `FEM-CPU-PERF-006` | **P1** | FEM CPU | `performance` | [Eliminacja nadmiarowego final endpoint RHS/Poisson](fem-cpu/FEM-CPU-PERF-006.md) |
| `FEM-CPU-PHY-001` | **P1** | FEM CPU | `physics` | [Spójność materiałów, DMI/PBC i wykluczenie Airbox](fem-cpu/FEM-CPU-PHY-001.md) |
| `FEM-GPU-NUM-001` | **P1** | FEM GPU | `numerics` | [Mixed precision i tolerancje solverów jako time-to-accuracy policy](fem-gpu/FEM-GPU-NUM-001.md) |
| `FEM-GPU-NUM-002` | **P1** | FEM GPU | `numerics` | [Device tangent-plane/IMEX dla sztywnych siatek](fem-gpu/FEM-GPU-NUM-002.md) |
| `FEM-GPU-NUM-003` | **P1** | FEM GPU | `numerics` | [Zgodność adaptive error z projected high-order candidate](fem-gpu/FEM-GPU-NUM-003.md) |
| `FEM-GPU-PERF-002` | **P1** | FEM GPU | `performance` | [Trwałe device assembly, restrictions, quadrature i preconditionery](fem-gpu/FEM-GPU-PERF-002.md) |
| `FEM-GPU-PERF-003` | **P1** | FEM GPU | `performance` | [Planner matrix-free/partial assembly zamiast wymuszonego legacy sparse](fem-gpu/FEM-GPU-PERF-003.md) |
| `FEM-GPU-PERF-004` | **P1** | FEM GPU | `performance` | [Device reductions i stop criteria bez synchronizacji per stage](fem-gpu/FEM-GPU-PERF-004.md) |
| `FEM-GPU-PERF-005` | **P1** | FEM GPU | `architecture` | [Jawna lokalizacja i lifecycle preconditionera](fem-gpu/FEM-GPU-PERF-005.md) |
| `FEM-GPU-PERF-006` | **P1** | FEM GPU | `performance` | [Device-side decyzja adaptacyjna bez `cudaStreamSynchronize`](fem-gpu/FEM-GPU-PERF-006.md) |
| `FEM-GPU-PERF-007` | **P1** | FEM GPU | `performance` | [Usunięcie podwójnego RK23 endpoint RHS i ogólna polityka FSAL](fem-gpu/FEM-GPU-PERF-007.md) |
| `FEM-GPU-PERF-008` | **P1** | FEM GPU | `performance` | [Harmonogram pełnych energii i obserwabli zamiast redukcji co krok](fem-gpu/FEM-GPU-PERF-008.md) |
| `FEM-GPU-PHY-001` | **P1** | FEM GPU | `physics` | [Pełna parity materiałów, Airbox, PBC, DMI i termiki](fem-gpu/FEM-GPU-PHY-001.md) |
| `FEM-GPU-QUAL-001` | **P1** | FEM GPU | `qualification` | [Sprzętowy CI, sanitizer, leak i time-to-accuracy qualification](fem-gpu/FEM-GPU-QUAL-001.md) |
| `FEM-GPU-TRX-001` | **P1** | FEM GPU | `transactionality` | [Minimalizacja device transaction kopiującej 13 pól i Poisson](fem-gpu/FEM-GPU-TRX-001.md) |
| `FDM-CPU-NUM-003` | **P2** | FDM CPU | `numerics` | [ABM3: stały krok albo poprawne współczynniki variable-step](fdm-cpu/FDM-CPU-NUM-003.md) |
| `FDM-CPU-PERF-003` | **P2** | FDM CPU | `performance` | [Kwalifikowany backend FFT i real-to-complex workspace](fdm-cpu/FDM-CPU-PERF-003.md) |
| `FDM-CPU-QUAL-001` | **P2** | FDM CPU | `qualification` | [Benchmark produkcyjnej ścieżki `Full`, nie tylko `Minimal`](fdm-cpu/FDM-CPU-QUAL-001.md) |
| `FEM-CPU-PERF-007` | **P2** | FEM CPU | `performance` | [Jedna polityka wątków, NUMA i bibliotek solverowych](fem-cpu/FEM-CPU-PERF-007.md) |
| `FEM-CPU-QUAL-001` | **P2** | FEM CPU | `qualification` | [Pełna kwalifikacja przestrzenna, czasowa i wydajnościowa FEM CPU](fem-cpu/FEM-CPU-QUAL-001.md) |
| `FEM-GPU-PERF-010` | **P2** | FEM GPU | `performance` | [CUDA Graphs i trwały harmonogram stage](fem-gpu/FEM-GPU-PERF-010.md) |

## Indeksy per lane

- [FDM CPU](fdm-cpu/README.md)
- [FDM GPU](fdm-gpu/README.md)
- [FEM CPU](fem-cpu/README.md)
- [FEM GPU](fem-gpu/README.md)

## Dokumenty sterujące

- [Kolejność implementacji](IMPLEMENTATION_SEQUENCE.md)
- [Checklist review i promocji capability](REVIEW_CHECKLIST.md)
- [Mapowanie do raportów audytu](MAPPING_TO_AUDIT.md)

## Statusy

- `implementation plan` — dokument gotowy, kod jeszcze niezmieniony;
- `in progress` — aktywny PR implementacyjny;
- `implemented, unqualified` — kod istnieje, ale brakuje pełnego dowodu;
- `qualified` — wszystkie kryteria `Definition of Done` spełnione dla jawnej macierzy capability;
- `legacy` — zachowane wyłącznie dla kompatybilności, niedozwolone jako nowy default.
