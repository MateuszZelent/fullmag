# Audyt realizacji planu FEM eigensolve K0 CPU/GPU i plan domknięcia

**Data audytu:** 2026-08-29  
**Audytowany task Codex:** `codex://threads/019ff50c-f17c-79f2-9473-edac793b79c4`  
**Tytuł tasku:** `Dokończ eigensolve k0 demag (2)`  
**Tryb audytu:** read-only dla kodu, historii tasku, referencji Git i worktree; jedyną zmianą jest ten dokument  
**Werdykt:** **NO-GO dla merge do `master` i NO-GO dla claimu produkcyjnego CPU/GPU**

## 1. Wynik w skrócie

Oryginalny plan nie został porzucony: większość jego architektury została rzeczywiście
zaimplementowana na poziomie źródeł. Powstały realne ścieżki FEM K0 z dynamicznym
demagiem, CPU Schur/SLEPc, GPU PETSc/SLEPc, artefakty spektrum i pól modów, API,
Results/Inspectory, wizualizacja zespolonych modów oraz mechanizm `.fms`.

Plan nie został jednak domknięty jako jeden odtwarzalny produkt. Dzisiaj istnieją
równocześnie:

- dwa rozbieżne tipy rescue;
- dwa bardzo zabrudzone historyczne worktree;
- brak końcowego worktree rescue, na którym wykonano ostatnie poprawki;
- brak świeżej, kompletnej kwalifikacji CPU;
- brak kwalifikacji GPU na rzeczywistym operatorze, sprzęcie i profilerze;
- brak końcowego browser/WebGL proof;
- brak integracji z aktualnym `master`.

Najuczciwsza ocena stopnia realizacji jest wielowymiarowa:

| Wymiar | Ocena | Uzasadnienie |
|---|---:|---|
| Szerokość implementacji źródłowej | 75–85% historycznie | większość warstw planu ma realny kod, testy i raporty |
| Realizacja etapów oryginalnego DAG | około 55–60% | 5/18 etapów jest źródłowo domkniętych, 11/18 częściowych, 2/18 terminalnych niewykonanych |
| Konsolidacja w jednym trwałym branchu | około 40–50% | lokalny i zdalny rescue są rozbieżne, późne zmiany żyły w zaginionym worktree |
| Kwalifikacja CPU | częściowa, historyczna | Kittel i pojedynczy `nearest_frequency` przeszły, pełne aktualne okno nie |
| Kwalifikacja GPU | nieukończona | źródła i testy kontraktowe istnieją, brak świeżego device/profiled E2E |
| Kwalifikacja UI/WebGL | nieukończona | testy modeli i transportu istnieją, brak końcowego proof na natywnych artefaktach |
| Gotowość produkcyjna | 0% | żaden terminalny ciąg `R1 -> Q1 -> Q2 -> Q3 -> G2` nie został zamknięty |

Powyższe procenty nie są zamienne. W szczególności 80% obecności kodu nie oznacza
80% gotowości produkcyjnej.

## 2. Źródła dowodowe

Audyt opiera się na następujących źródłach:

1. Pełna historia tasku Codex, w tym komunikaty użytkownika, raporty wykonania,
   przeglądy niezależnych agentów, wyniki testów i końcowe blokery.
2. Oryginalny masterplan:
   `origin/codex/eigensolve-master-rescue:docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md`.
3. Plan wykonawczy:
   `origin/codex/eigensolve-master-rescue:docs/superpowers/plans/2026-08-09-fem-k0-eigensolve-current-audit-and-execution.md`.
4. Plan full-GPU T0–T15:
   `origin/codex/eigensolve-master-rescue:docs/superpowers/plans/2026-08-11-fem-k0-eigensolve-full-gpu-implementation.md`.
5. Audyt brancha z 2026-08-20:
   `origin/codex/eigensolve-master-rescue:docs/audits/eigensolve-master-rescue-cpu-gpu-fem-audit.md`.
6. Bieżące referencje Git i odczyt istniejących worktree w WSL.

### 2.1. Klasy dowodu

| Kod | Znaczenie |
|---|---|
| D1 | kod, dokument lub kontrakt istnieje |
| D2 | test źródłowy/focused przeszedł |
| D3 | świeży managed/container runtime związany z dokładnym źródłem przeszedł |
| D4 | walidacja naukowa CPU/GPU na kanonicznym przypadku przeszła |
| D5 | live API + browser/WebGL proof na tych samych artefaktach przeszedł |

W tym audycie nie promuje się D1/D2 do D3–D5.

### 2.2. Ograniczenia

- Nie uruchamiano builda FEM, solve, benchmarku ani przeglądarki.
- Wyniki runtime z tasku są historyczne i nie są przypisane do aktualnego
  `master` ani do jednego istniejącego, czystego worktree.
- Ostatni rescue worktree nie istnieje, więc jego niezacommitowanego końcowego
  diffu nie można bezpośrednio odczytać.
- Wszelkie brakujące świeże dowody są oznaczone `NOT VERIFIED`.

## 3. Krytyczny audyt worktree i Git

### 3.1. Gdzie faktycznie prowadzono prace

Prace nie były prowadzone w bieżącym checkoutcie Windows. Historia tasku ma trzy
główne fazy:

| Faza | Worktree | Branch | Rola |
|---|---|---|---|
| Recovery | `/home/kkingstoun/git/fullmag/fullmag/.worktrees/eigensolve-k0-demag-recovery` | `codex/eigensolve-k0-demag` | pierwotny rozwój solvera, ABI, UI i eksperymentów |
| Integracja | `/mnt/fullmag-zfn2-native/worktrees/eigensolve-master-integration` | `codex/eigensolve-master-integration` | próba selektywnego przeniesienia recovery na bazę `master` |
| Rescue | `/tmp/fullmag-eigensolve-master-rescue` | `codex/eigensolve-master-rescue` | kanoniczna gałąź wybrana później do konsolidacji solvera, FMS i UI |

Końcowe komunikaty tasku oraz zmiany plików odnoszą się do rescue pod `/tmp`, nie
do obecnego checkoutu `C:\git\fullmag\fullmag`.

### 3.2. Stan zweryfikowany 2026-08-29

| Element | Stan |
|---|---|
| Bieżący `master` | `adec82a86b5623cade88ffc77652cb56ec81149a` |
| Bieżący checkout | `C:\git\fullmag\fullmag`, 30 zmodyfikowanych ścieżek niezwiązanych z tym audytem |
| Recovery | istnieje; HEAD `24ca296fbb5dbb312d154f2b2cf667de026006ed`; 127 wpisów porcelain, 117 unstaged, 22 untracked |
| Integration | istnieje; HEAD `d9518082eaee2131c3e7160bd8ae952ed2f45899`; 365 wpisów porcelain, 364 staged, 14 unstaged |
| Rescue worktree | **brak**: `/tmp/fullmag-eigensolve-master-rescue` nie istnieje |
| Lokalny rescue branch | `bc5ca20f67645145fa0a9c3250fd9d905ed4e135` |
| Zdalny rescue branch | `e587df3c5ade76026346cc36671fc885a9d95d18` |
| Rozjazd lokalny/zdalny rescue | 10 commitów tylko lokalnie, 1 commit tylko zdalnie; merge-base `f63c59a0c48ce731cee58ccc103104dd3321e8d4` |
| `master...local rescue` | 491 commitów tylko po stronie `master`, 131 tylko po stronie rescue |
| `master...remote rescue` | 491 commitów tylko po stronie `master`, 122 tylko po stronie rescue |

Dziesięć lokalnych commitów rescue zawiera hardening i import FMS. Jedyny zdalny
commit po wspólnym `f63c59a0c` zawiera audyt implementacji. Nie wolno wybrać jednej
z tych gałęzi jako kanonicznej bez ich jawnego połączenia.

### 3.3. Konsekwencja

Pierwszym etapem dalszych prac nie może być kolejna poprawka numeryczna. Najpierw
trzeba odzyskać i skonsolidować stan. W przeciwnym razie można:

- utracić unikalne zmiany FMS z lokalnego rescue;
- pominąć dokument audytu ze zdalnego rescue;
- nadpisać niezacommitowane zmiany recovery;
- błędnie włączyć 364 staged pliki starego worktree integracyjnego;
- próbować kwalifikować źródło niezgodne z aktualnym `master`.

## 4. Oryginalny plan wdrożenia

Oryginalny masterplan definiował następujący DAG:

```text
G0 -> C1 -> C2/C3 -> N1 -> N2 + N3 + A1S
                         A1S -> A2 -> U0 -> U1/U2
N2 + N3 + A1E + A2 + U0 + U1 + U2 -> R1
R1 -> Q1 CPU -> Q2 GPU -> Q3 browser/release -> G2 promotion
```

Znaczenie etapów:

| Etap | Oryginalny cel |
|---|---|
| G0 | checkpoint recovery, synchronizacja `master`, świeży baseline i runtime |
| C1 | zamrożenie fizyki, scope i dokumentacji |
| C2 | Python DSL, `BiasFieldSweepIR`, planner i authoring |
| C3 | certyfikaty, handoff i ostateczny ABI fail-closed |
| N1 | pełne natywne shared-domain MFEM assembly |
| N2 | CPU selected spectrum i complete window |
| N3 | GPU persistent PETSc/SLEPc, HYPRE CUDA, telemetryka |
| A1S | wersjonowane artefakty naukowe |
| A1E | atomowy, przyczynowo zamknięty bundle dowodowy |
| A2 | typowane OpenAPI v2, revisions i realtime invalidation |
| U0 | Results Navigator, stabilna selekcja i adaptery |
| U1 | Results, FMR, wykresy i Inspectory |
| U2 | zespolone pola modów w unified viewport |
| R1 | jeden zamrożony release candidate i fresh managed runtime |
| Q1 | pełna kwalifikacja CPU |
| Q2 | pełna kwalifikacja GPU |
| Q3 | live API, browser/WebGL i regresja przedwydaniowa |
| G2 | governance-only promotion i merge readiness |

Późniejszy plan full-GPU rozwinął ten DAG na T0–T15. Nie zmienił końcowego
warunku sukcesu: źródła, testy, runtime, fizyka, GPU residency, UI i release miały
być związane jednym immutable candidate.

## 5. Porównanie planu z realizacją

Legenda: `DONE-D1/D2` — źródła i focused tests; `PARTIAL` — realna implementacja,
ale brak części kontraktu albo bramki; `NOT VERIFIED` — brak świeżego dowodu;
`BLOCKED` — nie można promować dalej.

| Etap | Stopień | Co wykonano | Czego brakuje |
|---|---|---|---|
| G0 | PARTIAL | historycznie zabezpieczono i wypchnięto solver, utworzono integration i rescue | aktualny master jest 491 commitów przed rescue; worktree są rozbieżne i brudne; G0 trzeba wykonać ponownie |
| C1 | DONE-D1/D2 | nota 0830, source-map, masterplan, scope K0, rozdzielenie modal/driven | dokumenty nie są na aktualnym `master`; późne korekty były niezacommitowane |
| C2 | PARTIAL | `BiasFieldSweepIR`, DSL/planner, provenance i testy; później migracja `ProblemIR 0.4` uzyskała review APPROVE | finalna migracja `.study -> .execution` była wykonana w zaginionym rescue; trwałość `NOT VERIFIED` |
| C3 | PARTIAL | ABI v18/v19/v20, artefakt równowagi v7, handoff i identity signatures | audyt wykazał niespójną kwalifikację równowagi, taksonomię engine i drift wersji; brak finalnego jednego ABI/certificate bundle |
| N1 | PARTIAL | realne `A_qq`, `A_qphi`, `A_phiq`, `A_phiphi`, `B_qq`, P1 Tet4/Prism6 i testy assembly | tylko wąski shared-domain K0 jest sensownie ograniczony; generic MFEM route ma pozostać niedostępny; brak świeżego managed proof |
| N2 | PARTIAL | CPU Schur/SLEPc, persistent context, residuale, nearest i window infrastructure | brak świeżego certyfikowanego pełnego okna na kanonicznym antydocie i aktualnym source identity |
| N3 | PARTIAL | PETSc/SLEPc CUDA, HYPRE policy, W1/W2, lifecycle, fail-closed i telemetryka źródłowa | brak świeżej kwalifikacji rzeczywistego GPU, Nsight/PETSc trace, >1024 DOF, trzech rozmiarów i pełnego antidot E2E |
| A1S | DONE-D1/D2 | `spectrum.v2/v3`, diagnostics, complex mode fields, identity, completeness structures, FMS snapshot | kompletność i scientific qualification nie są wszędzie konsekwentnie publikowane |
| A1E | PARTIAL | walidatory i candidate/evidence infrastructure istnieją | brak immutable final candidate powiązanego z jednym R1 |
| A2 | PARTIAL | typowane trasy v2, resources, invalidation, mode composition API | późna fala API/FMS była niezacommitowana; katalog API był chwilowo utracony; końcowy kontrakt nie jest skonsolidowany |
| U0 | DONE-D1/D2 | Results tree, stabilne IDs, selekcja, ukrywanie nieaktywnych produktów | brak finalnej regeneracji na aktualnym OpenAPI/master |
| U1 | DONE-D1/D2 | spectrum, FMR/Kittel, Inspectory, responsive Results, per-object composition | audit wykrył fałszywe `qualified`, mylenie resonansu z pierwszym modem i brak pełnej semantyki certyfikatu |
| U2 | PARTIAL | complex field projection, coolwarm, komponenty, faza, per-object controller, shader exclusivity | brak końcowego browser/WebGL proof na rzeczywistych artefaktach CPU/GPU; historyczne screeny nie zamykają gate |
| R1 | PARTIAL | managed build wielokrotnie dochodził do kontraktów; powstały source manifests | nie istnieje zamrożony, odtwarzalny release candidate po konsolidacji wszystkich zmian |
| Q1 | PARTIAL/NOT VERIFIED | historyczny Kittel 15/15 z błędem około 1,67%; nearest antidot 2,5487973357 GHz z residualem około 1,45e-20 | pełne okno 0,5–30 GHz nie ma świeżego końcowego certyfikatu na aktualnym źródle; convergence mesh/airbox niezamknięte |
| Q2 | PARTIAL/NOT VERIFIED | historyczne testy kontraktowe GPU i częściowa parity | brak świeżej kwalifikacji sprzętowej, profiler-backed residency, parity klastrów i antydotu |
| Q3 | NOT VERIFIED | testy UI modeli i transportu, częściowe screeny/smoke | brak jednego live backend/API/browser runu przez 60 s z WebGL, FMS restart i rzeczywistymi polami modów |
| G2 | BLOCKED | nie wykonano | brak Q1–Q3, brak finalnego manifestu i master jest rozbieżny |

### 5.1. Ocena ilościowa etapów

Z 18 etapów oryginalnego DAG:

- 4 mają szeroko domknięty zakres źródłowy D1/D2;
- 12 jest częściowych, w tym Q2 bez aktualnego dowodu kwalifikacyjnego;
- 2 terminalne etapy pozostają niewykonane/zablokowane;
- 0 ma kompletne, aktualne przejście od R1 przez Q1–Q3 do G2.

Ważenie `DONE=1`, `PARTIAL=0,5`, `NOT VERIFIED/BLOCKED=0` daje około 56%
realizacji planu implementacyjnego. Wartość ta nie jest miarą produkcyjności.

## 6. Co rzeczywiście działało w historii tasku

### 6.1. CPU

Potwierdzone historycznie:

- relaksacja i eigensolve używały tej samej siatki antydotu;
- siatka miała 5156 węzłów i 27384 elementy;
- relaksacja osiągała próg użytkownika;
- pojedynczy `nearest_frequency` zwrócił mod około 2,5487973357 GHz;
- pełny residual deskryptora wynosił około `1,4523e-20`;
- zapisano spectrum i zespolone pole moda;
- walidator scenariusza zwracał `status: ok`;
- test Kittela obejmował 15 punktów i błąd maksymalny około 1,67%.

Niepotwierdzone dla aktualnego źródła:

- kompletne, certyfikowane okno 0,5–30 GHz;
- trzy siatki i trzy airboxy;
- stabilność klastrów i tracking po sweepie;
- bounded performance envelope;
- finalny immutable receipt.

Werdykt CPU: **realny solver istnieje i przeszedł wartościowe próby, ale Q1 jest
otwarte**.

### 6.2. GPU

Potwierdzone historycznie na poziomie źródeł/testów:

- strict fail-closed bez CUDA;
- PETSc/SLEPc/HYPRE device policy;
- lifecycle 50/50 i teardown;
- split-cluster/W1/W2 w wybranych fixture;
- ABI/attestation i telemetryka;
- historyczna bliska zgodność CPU/GPU dla bounded case.

Brakuje:

- świeżego wspólnego source/runtime identity;
- rzeczywistego antydot solve GPU;
- niezależnego profiler trace;
- pomiaru transferów i synchronizacji;
- >1024 DOF i trzech rozmiarów;
- pamięci szczytowej, cancellation i sanitizerów;
- parity wartości i podprzestrzeni z aktualnym CPU oracle.

Werdykt GPU: **D1/D2, częściowo historyczne D3; D4 niezamknięte**.

### 6.3. FMS i API

Lokalny rescue zawiera 10 commitów hardeningu FMS, m.in. ochronę namespace ZIP,
portable paths, CAS integrity, scripts/artifacts export, typed preflight i publikację
read-only. Później w tasku przeprowadzono realny FMS E2E i niezależny review.

Problem polega na tym, że późna fala napraw po `bc5ca20f6` była wykonywana w
zaginionym worktree. Nie wolno przyjąć, że cały GREEN z tasku istnieje dzisiaj
w lokalnym branchu.

Werdykt: **znaczny postęp, ale najpierw recovery diff i rekonstrukcja z testów**.

### 6.4. Control Room

Powstały:

- Results Navigator i semantyczne węzły;
- widmo, FMR/Kittel i Inspectory;
- object-scoped mode fields;
- `ModeCompositionController`;
- wybór `Mx/My/Mz/total`;
- coolwarm dla wartości podpisanych;
- wyłączenie tekstury magnetyzacji na obiekcie z aktywnym shaderem moda;
- source mesh identity, revision-bound cache i invalidation.

Audyt z 2026-08-20 potwierdził jednak P0/P1:

- scientific `qualified` było wyznaczane z dostępności pól;
- fallback konwencji fazy był sprzeczny;
- completeness nie docierało konsekwentnie do UI;
- pierwszy mod mógł być opisany jak resonance;
- brakowało pełnego browser proof i testów semantycznych.

Werdykt: **duży zakres D1/D2, brak D5**.

## 7. Najważniejsze odchylenia od oryginalnego planu

1. **G0 nie pozostało zamknięte.** Synchronizowano branch wielokrotnie, ale nie
   utrzymano jednego kanonicznego, czystego punktu integracji.
2. **Scope rozszerzył się przed Q1/Q2.** Do solvera dołączono pełne FMS, per-object
   composition i rozbudowane UI zanim zamknięto kwalifikację CPU/GPU.
3. **Kontrakty wersjonowane zmieniały się w trakcie implementacji.** ABI v18/v19/v20,
   handoff v2/v3, equilibrium v7/v8 i ProblemIR 0.3/0.4 zwiększyły koszt integracji.
4. **Focused GREEN bywał traktowany jako bliskość produkcji.** Późniejszy audyt
   słusznie oddzielił testy źródłowe od kwalifikacji managed/scientific/browser.
5. **Środowisko zdominowało przebieg.** Pełne dyski, locki, mounty i runtime export
   wielokrotnie przerywały prace i prowadziły do nowych worktree.
6. **Końcowy rescue nie został trwale zachowany.** To obecnie największe ryzyko
   operacyjne, niezależne od fizyki solvera.

## 8. Rejestr otwartych problemów

| ID | Priorytet | Problem | Warunek zamknięcia |
|---|---|---|---|
| REC-01 | P0 | brak worktree rescue i rozjazd lokalny/remote rescue | pełny manifest commitów/diffów i jeden kanoniczny branch |
| REC-02 | P0 | recovery i integration mają setki zmian | każda ścieżka sklasyfikowana jako keep/drop/rebuild, bez utraty |
| PHY-01 | P0 | kwalifikacja equilibrium była semantycznie niespójna | oddzielny recomputed linearization certificate; brak heurystyki |
| FE-01 | P0 | `qualified` z field availability | status tylko z backend certificate |
| VIS-06 | P0 | sprzeczny phasor fallback | jeden wymagany enum, fail-closed unknown |
| API-04 | P0 | taksonomia PETSc/SLEPc kontra native Krylov | osobne engine IDs i zgodna provenance |
| NUM-02 | P0 | incomplete completeness propagation | certyfikat w artifact/API/UI, nearest jawnie selected-only |
| N1-01 | P0 | generic MFEM route niekwalifikowany | pozostaje niedostępny albo dostaje pełny Hessian i testy |
| CPU-Q1 | P0 | brak świeżego full-window CPU | complete-window + residuale + convergence + receipt |
| GPU-Q2 | P0 | brak świeżego hardware proof | profiler-backed residency, parity, scaling, sanitizers |
| UI-Q3 | P1 | brak końcowego live browser proof | 60 s WebGL smoke na tym samym immutable candidate |
| REL-G2 | P0 | brak finalnej integracji | verified candidate, manifest, promotion attestation, clean merge |

## 9. Nowy plan wdrożenia pozostałych prac

Nowy plan zachowuje logikę oryginalnego DAG, ale dodaje obowiązkową fazę odzysku.
Nie wolno rozpoczynać R3–R9 przed zamknięciem R0–R2.

### R0 — zamrożenie i inwentaryzacja

**Cel:** niczego nie utracić i nie pomieszać z aktualnym dirty `master`.

Kroki:

1. Nie edytować recovery ani integration.
2. Nie używać bieżącego checkoutu Windows jako miejsca integracji.
3. Zapisać dla każdego worktree: HEAD, branch, status porcelain, staged, unstaged,
   untracked, submodule status i object reachability.
4. Zapisać graf czterech referencji:
   `master`, `codex/eigensolve-k0-demag`, lokalny rescue i zdalny rescue.
5. Utworzyć odzyskiwalne patch bundles dla recovery i integration, bez stash i bez
   usuwania plików.
6. Zabezpieczyć 10 lokalnych commitów FMS oraz zdalny commit audytu.

**Bramka R0:** każdy unikalny commit i każda niezacommitowana ścieżka ma właściciela,
klasyfikację i kopię; niczego nie usunięto.

### R1 — utworzenie czystego worktree finalizacyjnego

**Cel:** jeden branch z aktualnego `origin/master`.

1. Po świeżym `git fetch` utworzyć nowy worktree spoza obecnego dirty checkoutu.
2. Zalecany branch:
   `codex/eigensolve-k0-finalization-20260829`.
3. Związać manifest startowy z dokładnym `origin/master` SHA.
4. Nie kopiować całego starego worktree. Przenosić logiczne batch'e z testami.

**Bramka R1:** czysty status, aktualny master jako przodek, manifest wejściowy,
brak build artifacts w worktree.

### R2 — kontrolowana konsolidacja źródeł

Kolejność batchy:

1. Dokumentacja fizyczna, ADR, scope i source maps.
2. Python DSL, `ProblemIR 0.4`, planner i strict engine resolution.
3. Certyfikaty equilibrium/mesh, ABI i FFI.
4. Natywne shared-domain assembly.
5. CPU, następnie GPU, bez mieszania plików wspólnych.
6. Artefakty i walidatory.
7. API/OpenAPI/resources.
8. Results/UI/viewport.
9. FMS jako osobny batch: 10 lokalnych commitów plus odtworzone poprawki późnego
   E2E z testów i raportów.

Każdy batch musi mieć:

- listę plików;
- source SHA;
- test RED/GREEN;
- niezależny review;
- własny commit;
- `git diff --check`.

**Bramka R2:** wszystkie zamierzone funkcje istnieją na jednym branchu; recovery i
integration nie zawierają nieprzeniesionej unikalnej implementacji.

### R3 — zamrożenie kontraktów P0

**Właściciele:** Python/IR/planner, equilibrium/ABI i API taxonomy; prace mogą być
równoległe dopiero po podziale plików.

Zakres:

1. `ProblemIR 0.4` ma jedno publiczne pole `execution`; rootowe legacy `study` jest
   odrzucane, nie ignorowane.
2. Workflow wielostage zwraca kontrolowany błąd, nigdy panic `single_stage()`.
3. User-owned relaxation stop i linearization qualification są osobnymi faktami.
4. Linearization qualification recomputuje equilibrium residual tym samym
   operatorem, nie zmieniając warunku stopu użytkownika.
5. `qualified` pochodzi wyłącznie z wersjonowanego certyfikatu backendu.
6. Phasor convention jest wymaganym enumem; brak fallbacku.
7. Produkcyjny GPU engine ma osobne ID PETSc/SLEPc; native CUDA Krylov jest
   validation-only.
8. `nearest_frequency` publikuje selected-only; tylko complete-window certificate
   może oznaczać kompletność.
9. Generic MFEM physics route pozostaje fail-closed poza wąskim K0 scope.

**Testy:** Python round-trip; `fullmag-ir`; planner legality; negative ABI; API schema;
frontend pure-model tests.

**Bramka R3:** wszystkie P0 z audytu 2026-08-20 mają test regresyjny i review APPROVE.

### R4 — managed runtime i kwalifikacja wąskiej ścieżki CPU

**Scope pierwszego wydania:** K0, `alpha=0`, homogeneous exchange, exact static
`H_eff0`, dynamic Poisson demag, P1 Tet4/Prism6, certified periodic shared domain.

Kroki:

1. Sprawdzić aktualne recipe w `justfile`; natywny FEM budować wyłącznie przez
   container-backed `just`.
2. Użyć zewnętrznego trwałego storage; nie budować w repo ani zwykłym `/tmp`.
3. Zbudować świeży runtime związany z dokładnym source SHA, ABI, MFEM, PETSc/SLEPc
   i manifestem środowiska.
4. Uruchomić kontrakty native shared-domain i residuali.
5. Uruchomić Kittel CPU jako oracle, bez przecieku danych referencyjnych do solve.
6. Uruchomić antydot najpierw jako szybki `nearest_frequency` diagnostic.
7. Następnie wykonać pełne `frequency_window`, oba przebiegi base/refinement,
   kompletność klastrów i original-descriptor residual.
8. Wykonać co najmniej trzy siatki i trzy airboxy albo udokumentowany minimalny
   zestaw convergence wymagany przez obowiązujący DoD.

**Bramka R4/Q1:** `window_complete=true`, brak fallbacku, wszystkie publikowane mody
mają residuale, Kittel i convergence są zielone, receipt wiąże source/runtime/input.

### R5 — kwalifikacja GPU

Kroki:

1. Zweryfikować `VECCUDA`, `MATAIJCUSPARSE`, HYPRE device policy i cały object graph
   przed `EPSSolve`.
2. Oddzielić self-report od niezależnego trace.
3. Zmierzyć H2D/D2H, synchronizacje, peak memory, outer/inner iterations i teardown.
4. Wykonać rozmiary bounded, pośredni i `operator_dimension > 1024`.
5. Wykonać parity z CPU dla wartości, residuali i podprzestrzeni klastrów.
6. Wykonać pełny antydot GPU na identycznym wejściu i siatce.
7. Uruchomić cancellation, powtórzenia, sanitizery i brak fallbacku.
8. Zachować profiler output jako immutable qualification artifact.

**Bramka R5/Q2:** brak nieudokumentowanych transferów/fallbacku, parity i convergence
zielone, profiler oraz attestation zgodne, wszystkie dowody związane z R4 candidate.

### R6 — artefakty, FMS i API

Kroki:

1. Zamrozić wersje spectrum, diagnostics, mode fields, completeness, equilibrium i
   execution attestation.
2. Wymagać pełnego identity tuple: run, stage, artifact revision, mesh generation,
   topology hash, equilibrium digest, engine, device i source identity.
3. Odtworzyć późne poprawki FMS:
   ownership barrier, queue barrier, revision round-trip, atomic rollback i wspierany
   wire type zamiast nieobsługiwanego `u128` JSON.
4. Uruchomić realny procesowy FMS E2E: export -> restart -> import -> spectrum i
   binary mode field bez pierwotnej historii.
5. Regenerować OpenAPI wyłącznie kanonicznym generatorem.
6. HTTP v2 pozostaje data plane; realtime tylko invaliduje resources.

**Bramka R6:** pełny FMS E2E przechodzi dwukrotnie, w tym przez niezależnego
reviewera; żadna niezgodność nie mutuje aktywnej sesji częściowo.

### R7 — Control Room i browser

Kroki:

1. Results pokazuje wyłącznie produkty opublikowane w manifestach.
2. `qualified`, completeness, engine, residency i normalization są oddzielnymi polami.
3. Per-object mode selection korzysta z object-scoped fields i jednego ownera shaderu.
4. Włączenie moda atomowo wyłącza teksturę magnetyzacji tylko danego obiektu.
5. Coolwarm jest domyślne dla wartości podpisanych; `abs` ma skalę sekwencyjną.
6. Faza, komponent, playback i physical frequency są semantycznie rozdzielone.
7. Cache key zawiera wszystkie identity/revision fields; stale payload jest odrzucany.
8. Wykonać live browser smoke na tych samych artefaktach CPU i GPU.
9. Przez co najmniej 60 s sprawdzić: canvas visible, `gl.isContextLost()==false`,
   niezerowy drawing buffer, brak rosnącego cache per frame i brak nakładania shaderów.
10. Zapisać screeny: spectrum, wybrany mode, real/imag/Mx/My/Mz oraz per-object modes.

**Bramka R7/Q3:** D5 dla CPU i GPU, bez mocków i bez statycznej magnetyzacji udającej mod.

### R8 — immutable candidate i regresja

1. Zamrozić jeden R1 candidate po R3–R7.
2. Jakakolwiek zmiana kodu, schema, generatora, recipe lub UI unieważnia późniejsze
   dowody i wymaga nowego candidate.
3. Uruchomić pełne testy negatywne: stale mesh, stale revision, wrong engine,
   incomplete window, failed relaxation, unsupported physics, missing GPU i cancelled run.
4. Wygenerować scientific manifest i mapę DoD-01–DOD-14.

**Bramka R8:** wszystkie DoD mają `PASS` z linkiem do immutable artifact albo jawne,
zatwierdzone wyłączenie scope; brak `pending` i brak historycznych dowodów.

### R9 — integracja z `master`

1. Ponownie pobrać `origin/master`.
2. Jeżeli master się zmienił, scalić go i powtórzyć od właściwej bramki; nie przenosić
   starych receipts na nowy source identity.
3. Przygotować czysty, przeglądalny PR bez build artifacts i obcych zmian.
4. Merge bez force-push.
5. Governance-only promotion może dotknąć wyłącznie jawnej allowlisty i musi wiązać
   R1 SHA, governance SHA oraz finalny manifest.

**Bramka R9/G2:** `master` zawiera dokładnie zweryfikowany candidate, a branch,
runtime, manifest i browser proof mają wspólną tożsamość.

## 10. Dozwolona równoległość

Po R2 można uruchomić maksymalnie następujące niezależne lane'y:

| Lane | Zakres | Nie może edytować |
|---|---|---|
| L1 | Python/IR/planner | native CPU/GPU i UI |
| L2 | equilibrium/ABI/certificates | UI i FMS |
| L3 | CPU | GPU hot-loop, API/UI |
| L4 | GPU | CPU implementation, API/UI |
| L5 | artifacts/FMS/API | native solver i viewport shader |
| L6 | Results/UI/viewport | physics claims, native backend, generated OpenAPI ręcznie |

Jeden integrator posiada wspólne typy, managed runtime, OpenAPI generation i finalny
candidate. GPU device i native build są serializowane.

## 11. Minimalne kryteria akceptacji

### 11.1. Równowaga

- user-owned stop pozostaje niezmieniony;
- osobny recomputed linearization residual jest zapisany;
- stan, pola, mesh i fizyka są związane digestami;
- stan niespełniający profilu może być preview/conditional, nigdy `qualified`.

### 11.2. Mody

- każdy mode ma finite frequency i original-descriptor residual;
- Poisson, gauge, tangent leakage i full residual przechodzą;
- klastry są porównywane podprzestrzenią, nie numerem pojedynczego wektora;
- normalization i phasor convention są jawne.

### 11.3. CPU/GPU

- CPU jest oracle dla Q2;
- GPU używa rzeczywistego produkcyjnego PETSc/SLEPc adaptera;
- native CUDA Krylov pozostaje validation-only;
- parity dotyczy częstotliwości, residuali i subspace;
- brak cichego fallbacku.

### 11.4. Artefakty i UI

- `nearest` nie udaje pełnego spektrum;
- field availability nie oznacza qualification;
- spectrum, mode field i viewport mają identyczny identity tuple;
- `.fms` działa po restarcie i usunięciu źródłowej historii;
- live WebGL proof jest obowiązkowy.

## 12. Decyzja końcowa

Nie należy obecnie:

- mergować żadnego z historycznych branchy do `master`;
- kontynuować implementacji w recovery/integration;
- uznawać historycznego nearest lub Kittela za Q1;
- uznawać testów GPU fixture za Q2;
- uznawać source-level UI za Q3;
- usuwać któregokolwiek historycznego worktree przed R0.

Należy rozpocząć od R0–R2. Po konsolidacji najkrótsza ścieżka produktu to:

```text
R3 kontrakty P0
-> R4 pełne CPU Q1
-> R5 GPU Q2
-> R6 FMS/API
-> R7 browser Q3
-> R8 immutable DoD
-> R9/G2 merge
```

Obecna implementacja jest wartościowa i nie wymaga przepisania od zera. Wymaga
jednak odzyskania, ujednolicenia i ponownej kwalifikacji na jednym źródle.
