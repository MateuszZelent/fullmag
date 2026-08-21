# Audyt solverów mikromagnetycznych LLG — FDM/FEM, CPU/GPU

**Data audytu:** 2026-08-21  
**Repozytorium:** `MateuszZelent/fullmag`  
**Audytowany commit:** `04e362df5dd51b1e6acca3aab9033c8124d3d6d0`  
**Tryb:** read-only audit kodu źródłowego; raporty nie zmieniają implementacji solvera  
**Zakres:** standardowa dynamika LLG w dziedzinie czasu, adaptacja kroku, pola efektywne używane przez integratory, transakcyjność kroku, telemetria oraz koszt gorącej pętli

## Raporty szczegółowe

1. [FDM CPU](fdm-cpu.md)
2. [FDM GPU/CUDA](fdm-gpu.md)
3. [FEM CPU/MFEM](fem-cpu.md)
4. [FEM GPU/CUDA + Hypre](fem-gpu.md)

Każdy raport jest samodzielny i zawiera mapę architektury, ustalenia fizyczne, numeryczne i wydajnościowe, proponowane testy regresyjne oraz kolejność napraw.

## Metoda i granice dowodu

Audyt prześledził przepływ:

```text
Python/ProblemIR
  -> planner i wybór backendu
  -> runner / C ABI
  -> kontekst stanu i cache
  -> integrator LLG
  -> składanie H_eff i momentów bezpośrednich
  -> akceptacja/odrzucenie kroku
  -> statystyki, energie, snapshoty i provenance
```

Ustalenia oznaczono jako:

- **potwierdzony defekt** — zachowanie wynika bezpośrednio z wykonywanej ścieżki kodu;
- **ryzyko numeryczne/fizyczne** — algorytm zmienia model lub formalne własności metody i wymaga oracla/zbieżności;
- **luka kwalifikacyjna** — brak dowodu pozwalającego uznać daną kombinację za naukowo lub wydajnościowo zakwalifikowaną.

Nie wykonano benchmarków na docelowych GPU ani pełnego builda CUDA/MFEM. W szczególności ustalenia o czasie wykonania są analizą kosztu algorytmicznego, transferów, synchronizacji, liczby rozwiązań Poissona/FFT i alokacji — nie pomiarem wall-clock. Wykryty błąd konstrukcji ABI FDM GPU jest defektem źródłowym, ale nie został odtworzony kompilatorem CUDA w tym środowisku.

## Skala priorytetu

| Priorytet | Znaczenie |
|---|---|
| **P0** | możliwe zawieszenie, brak kompilowalności utrzymywanej ścieżki, złamanie atomowości lub jakościowo błędna dynamika |
| **P1** | istotny błąd fizyczny/numeryczny albo koszt dominujący normalne obliczenia |
| **P2** | ograniczenie architektury, istotny dług techniczny, nieoptymalna realizacja lub brak kwalifikacji |
| **P3** | utrzymanie, ergonomia, telemetria lub testy o mniejszym wpływie |

## Werdykt porównawczy

| Ścieżka | Werdykt poprawności | Największy bloker wydajności | Najpilniejsze działanie |
|---|---|---|---|
| **FDM CPU** | **blocked dla adaptacyjnego RK23/RK45** | dodatkowa pełna ewaluacja obserwabli i demag po każdym kroku; RustFFT i wielokrotne przebiegi pamięci | naprawić retry `dt`, atomowość RNG i wprowadzić maskę kosztu obserwabli |
| **FDM GPU** | **blocked dla bieżącej konstrukcji CUDA; stochastic FSAL niebezpieczny** | synchronizacja hosta przy adaptacji, nadmiarowe odświeżenia pól/statystyk, brak kompilowalnego spięcia ABI | wyrównać ABI, wyłączyć FSAL dla termiki, dodać feature-build CI |
| **FEM CPU** | rdzeń LLG/adaptacja jest funkcjonalnie dojrzalszy; brak P0 w przeanalizowanym rdzeniu | głębokie kopie całego kontekstu przy każdym kroku i każdej próbie; niepreconditionowany consistent-mass solve | zastąpić snapshoty dziennikiem transakcyjnym i zredukować koszt projekcji masowej |
| **FEM GPU** | strict device path jest logicznie spójny, ale nie jest jeszcze wydajnościowo „all-in-GPU” | kopia 13 pól + Poisson na krok, hostowe decyzje adaptacyjne, energia demag w każdej fazie, hybrydowy CPU Poisson | minimalny checkpoint, device-side adaptivity, `need_energy`, zakaz hybrydy w profilu performance |

## Najważniejsze ustalenia przekrojowe

### P0-1 — FDM CPU może wykonywać nieskończoną liczbę identycznych prób RK

W adaptacyjnych implementacjach RK23 i RK45 odrzucenie kroku nie przypisuje zmniejszonego `dt` przed `continue`. Dla `error > tolerance` i `dt > dt_min` solver ponawia ten sam stan, ten sam krok i ten sam błąd bez warunku wyjścia. Istnieje wspólny kontroler `decide_adaptive_step`, ale gorące ścieżki go nie używają.

### P0-2 — FDM GPU ma drift konstrukcji ABI

`fullmag_fdm_plan_desc` zawiera m.in. pola `ms_field`, `a_field`, `alpha_field`, pola DMI, formuły STT oraz maski. Konstruktor w runnerze tworzy literal tego samego typu bez wielu wymaganych członów i bez `..Default`. Przy włączonym feature `cuda` jest to źródłowy błąd kompilacji klasy „missing fields”. Domyślne CI nie buduje tego feature, więc drift pozostał niewykryty.

### P0/P1-3 — FDM GPU ponownie używa FSAL z aktywnym szumem termicznym

Termika generuje nowy Philox draw dla kolejnego zaakceptowanego `step_count`, natomiast RK23/RK45 może zachować końcowy RHS jako początkowy RHS następnego kroku bez sprawdzenia temperatury. Oznacza to użycie poprzedniej realizacji szumu w nowym przedziale. FEM GPU posiada osobną poprawną politykę `gpu_rk_rhs_allows_fsal_reuse`, która wyłącza FSAL dla `temperature > 0`; FDM GPU powinien współdzielić ten sam kontrakt.

### P1-4 — Telemetria jest częścią gorącej pętli zamiast polityką kosztu

We wszystkich czterech ścieżkach pełne statystyki i energie są zbyt mocno sprzężone z akceptacją kroku. Skutki:

- dodatkowe FFT demag w FDM CPU;
- dodatkowe składanie pól i redukcje w FDM GPU;
- dodatkowy końcowy RHS/Poisson w FEM CPU;
- energie wszystkich interakcji, redukcje i synchronizacja D2H po każdym kroku FEM GPU.

Potrzebny jest wspólny kontrakt:

```text
StepEvaluation = None | Control | Requested(mask) | Full
```

`Control` powinien zawierać tylko wielkości potrzebne do adaptacji, stop criteria i bezpieczeństwa. `Full` powinno być uruchamiane wyłącznie zgodnie z harmonogramem outputu.

### P1-5 — Projekcja `|m|=1` w każdej fazie zmienia formalną metodę RK

FDM CPU/GPU i FEM CPU/GPU normalizują wektory etapowe, a nie tylko stan zaakceptowany. Jest to dopuszczalna heurystyka stabilizacyjna, lecz nie jest klasycznym RK o deklarowanym rzędzie. W parach embedded błąd lokalny jest liczony dla dynamiki z projekcjami; w FEM GPU RK23 końcowy `k3` jest dodatkowo liczony w znormalizowanym punkcie, podczas gdy kandydat używany do części kontroli błędu został zachowany przed normalizacją.

Nie należy usuwać projekcji bez testów. Należy wybrać jeden jawny kontrakt:

1. RK w przestrzeni otaczającej + projekcja wyłącznie zaakceptowanego stanu;
2. metoda geometryczna/tangent-plane o udokumentowanym rzędzie;
3. projected RK jako osobny integrator z własnymi testami zbieżności i regulatorem błędu.

### P1-6 — Transakcje FEM kopiują znacznie więcej danych niż stan konieczny do rollbacku

FEM CPU kopiuje rozbudowany kontekst pól, cache i rozwiązań Poissona przy każdym publicznym kroku. FEM GPU dodatkowo kopiuje na urządzeniu 13 pól trójskładowych oraz rozwiązania Poissona. Na ścieżce sukcesu prawie cały koszt istnieje wyłącznie „na wszelki wypadek”.

Docelowy mechanizm powinien używać:

- dwóch prealokowanych buforów stanu i `swap` przy commit;
- dziennika małych liczników/flag;
- wersjonowania cache zamiast kopiowania pochodnych pól;
- checkpointu solvera Poissona przez zamianę buforów rozwiązania, a nie kopię całej struktury.

### P1-7 — Warunki brzegowe DMI nie mają jednej realizacji przekrojowej

FDM CPU dla brakującego sąsiada podstawia spin centralny. CUDA FDM ma korektę na zewnętrznej prostokątnej granicy dla części interfacial DMI, ale granice wewnętrznych masek oraz bulk DMI nie mają równoważnego kontraktu. FEM używa słabej postaci. Bez jednego oracla „boundary twist” backendy mogą rozwiązywać różne problemy fizyczne.

## Kolejność napraw

### Etap 0 — blokery, przed dalszą optymalizacją

1. Naprawić adaptacyjne retry FDM CPU i dodać timeoutowy test regresyjny dla RK23/RK45 AoS/SoA.
2. Przesuwać termiczny licznik FDM CPU wyłącznie po zaakceptowanym kroku.
3. Wyrównać `fullmag_fdm_plan_desc` z konstruktorem runnera i dodać CI budujące `fullmag-runner --features cuda`.
4. Wyłączyć FSAL FDM GPU dla aktywnej termiki i po zmianie realizacji pola zależnego od czasu.
5. Dodać test DMI natural-boundary twist dla każdej ścieżki.

### Etap 1 — szybkie zyski o małym ryzyku

1. Wprowadzić maskę obserwabli i wyłączyć pełne energie w etapach RK.
2. Usunąć podwójne odświeżenie końcowego pola w FDM GPU i FEM GPU RK23.
3. Przenieść regulator adaptacyjny GPU na urządzenie albo co najmniej zgrupować redukcje i jeden odczyt kontrolny.
4. Prealokować wszystkie snapshoty prób; usunąć `make_unique` i `Vec::clone` z hot loop.
5. Dodać lekkie stats `Control` oraz konfigurowalny stride.

### Etap 2 — refaktoryzacja wydajnościowa

1. Minimalny journal transakcyjny FEM CPU/GPU.
2. Blokowy/SoA consistent-mass solve dla trzech komponentów z preconditionerem.
3. Matrix-free/partial-assembly exchange FEM po zakwalifikowaniu wersji MFEM.
4. CUDA Graphs lub persistent multi-step loop dla stałej topologii FDM/FEM.
5. Wspólny backend-neutralny kontrakt adaptacji, FSAL, termiki i projection policy.

## Minimalna macierz kwalifikacyjna po naprawach

| Test | Cel fizyczny/numeryczny | Wymagane ścieżki |
|---|---|---|
| makrospin w stałym polu, `alpha=0` | częstotliwość i zachowanie normy | wszystkie 4 |
| makrospin z tłumieniem | monotoniczny spadek energii | wszystkie 4 |
| zbieżność Heun/RK4/RK23/RK45 | obserwowany rząd bez i z projection policy | wszystkie 4 |
| celowo odrzucony krok | rollback stanu, cache, RNG i czasu | wszystkie 4 |
| `dt_min_exhausted` | brak akceptacji błędnego kroku i brak hang | wszystkie 4 |
| termika | wariancja, retry invariance, restart determinism | wszystkie 4 |
| DMI boundary twist | naturalny warunek brzegowy | wszystkie 4 |
| cienka warstwa demag | energia i pole względem oracla | FDM/FEM CPU/GPU |
| sharp `Ms/A/alpha` | jedna semantyka materiałowa | wszystkie 4 |
| benchmark hot-loop | RHS/s, FFT/Poisson solves, transfery, synchronizacje, alokacje | wszystkie 4 |

## Metryki wydajności, które powinny stać się częścią provenance

- liczba RHS na zaakceptowany krok;
- liczba odrzuconych prób;
- liczba FFT forward/inverse i rozwiązań Poissona;
- liczba pełnych oraz kontrolnych redukcji;
- D2H/H2D bytes i host synchronization count;
- bytes skopiowane przez transaction snapshot;
- liczba alokacji w gorącej pętli;
- czas interakcji, integratora, obserwabli i I/O osobno;
- osiągnięty błąd adaptacyjny, norm defect i maksymalny obrót spinu;
- rzeczywisty backend/device/precision bez domniemania na podstawie requestu.
