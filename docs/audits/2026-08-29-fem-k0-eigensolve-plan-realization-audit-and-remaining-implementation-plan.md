# Audyt realizacji planu FEM eigensolve K0 CPU/GPU i plan domknięcia

**Data audytu:** 2026-08-29
**Aktualizacja po konsolidacji i re-audycie GPT Pro:** 2026-08-29
**Audytowany task Codex:** `codex://threads/019ff50c-f17c-79f2-9473-edac793b79c4`
**Tytuł tasku:** `Dokończ eigensolve k0 demag (2)`
**Bieżący worktree:** `C:\git\fullmag\worktrees\eigensolve-k0-finalization`
**Bieżący branch:** `codex/eigensolve-k0-finalization-20260829`
**Bieżący commit:** `5e5849c8acf8ec0f80c0f463fc5d9109ea9a4e14`
**Tryb audytu:** analiza źródeł i dokumentów; bez nowego managed solve, GPU profile i browser proof
**Werdykt:** **GO dla dalszej implementacji w dedykowanym worktree; NO-GO dla claimu produkcyjnego CPU/GPU i bezpośredniej promocji do `master`**

> **Uwaga o aktualności:** sekcje 1–12 zachowują stan i rozumowanie audytu
> sprzed lokalnej konsolidacji. R0–R2 zostały następnie wykonane przez utworzenie
> windowsowego worktree i merge aktualnego `master` z rescue. Sekcje 13–15 są
> aktualizacją po konsolidacji i zastępują wcześniejszy plan tam, gdzie występuje
> różnica.

## 1. Wynik pierwotnego audytu w skrócie (stan przed konsolidacją)

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

## 9. Pierwotny plan wdrożenia pozostałych prac (R0–R2 wykonane później)

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

## 12. Pierwotna decyzja końcowa (przed konsolidacją)

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

## 13. Aktualizacja po konsolidacji i ocena wniosków GPT Pro

### 13.1. Co zmieniło się od pierwotnego audytu

Stan operacyjny opisany w sekcjach 3, 8 i R0–R2 nie jest już stanem bieżącym:

- istnieje dedykowany windowsowy worktree
  `C:\git\fullmag\worktrees\eigensolve-k0-finalization`;
- branch `codex/eigensolve-k0-finalization-20260829` jest czysty przed zmianą tego
  dokumentu;
- commit `5e5849c8acf8ec0f80c0f463fc5d9109ea9a4e14` jest merge'em aktualnej w chwili
  konsolidacji bazy `master` (`9d7bd3191959513ad31879a9c5ccecaa48e28558`) i rescue
  (`bc5ca20f67645145fa0a9c3250fd9d905ed4e135`);
- dirty checkout `C:\git\fullmag\fullmag` nie został użyty do integracji ani
  zmodyfikowany;
- historyczne worktree WSL pozostają kopią bezpieczeństwa.

Oznacza to, że problemy `REC-01`, `REC-02` i `SCM-02` są lokalnie zamknięte na
poziomie konsolidacji źródeł. Nie oznacza to jeszcze przejścia Q1–Q3 ani gotowości
do promocji.

### 13.2. Metoda oceny dokumentów GPT Pro

Dwa dokumenty GPT Pro potraktowano wyłącznie jako źródło hipotez. Każda teza została
porównana z bieżącym scalonym drzewem, a nie z historycznym `master` ani rescue.
Klasy werdyktu:

| Werdykt | Znaczenie |
|---|---|
| `CONFIRMED` | problem jest bezpośrednio widoczny w bieżącym źródle |
| `PARTIAL` | sedno ryzyka jest trafne, ale opis jest zbyt szeroki lub część ochron już istnieje |
| `STALE/RESOLVED` | teza była prawdziwa dla wcześniejszego drzewa albo nie uwzględnia kodu po konsolidacji |
| `NOT VERIFIED` | nie da się rozstrzygnąć bez managed runtime, GPU profilera albo browsera |

### 13.3. Tezy GPT Pro, które realnie poprawiają audyt

| ID GPT Pro | Werdykt | Dowód w scalonym źródle | Konsekwencja |
|---|---|---|---|
| SCM-01 | `CONFIRMED P0` | materializacja managed source zatrzymała się na pustych celach symlinków `.claude/skills/*` | naprawić checkout/source identity przed jakimkolwiek Q1 |
| PHY-01 | `CONFIRMED P0` | `linearization_state.cpp:323–369` normalizuje `m0`, ale kopiuje stare `H_eff0` i `H_demag0` bez recompute | domyślnie fail-closed; renormalizacja tylko z ponownym obliczeniem zależnych pól i certyfikatu |
| PHY-02 | `CONFIRMED P0` | `require_symmetric_periodic_mesh` i `recompute_h_eff0_and_compare` występują tylko w deklaracji `linearization_state.hpp:64–65` | zaimplementować opcje albo usunąć je z publicznego kontraktu; nie mogą być martwymi przełącznikami |
| PHY-03 | `PARTIAL P0` | builder wymaga v7, SHA-256 i spójnego acceptance certificate, ale nie przelicza niezależnie `H_eff0`/residualu | zachować istniejące walidacje i dodać recomputed linearization certificate |
| PHY-04 | `CONFIRMED P1` | `linearization_state.cpp:305–346` liczy maksimum nodalnego względnego torque bez wag FE | dodać ważoną normę FE i zachować max-nodal jako diagnostykę pomocniczą |
| PHY-05 | `CONFIRMED P0` | `linearization_state.cpp:303` ustawia `tangent_lumped_mass` na same jedynki | wyprowadzić rzeczywisty lumped mass z assembly i związać go z mesh/operator digest |
| NUM-01 | `CONFIRMED P0 dla wspólnego helpera CPU` | `slepc_modal_eigen.cpp:225–250` ustawia rzeczywisty target `+omega`, a `:316–320` interpretuje częstotliwość z części urojonej eigenvalue | naprawić pencil/target i dodać test, który odróżnia target realny od `+i omega` |
| NUM-02 | `CONFIRMED P0 dla tego helpera` | `slepc_modal_eigen.cpp:235–239` pobiera tylko `2 * requested`, po czym filtruje znak, okno i residual | adaptacyjnie zwiększać `nev/ncv` albo zwracać jawne incomplete; bez milczącego niedoboru |
| NUM-11 | `CONFIRMED P1` | `slepc_modal_eigen.cpp:294–299` odczytuje licznik KSP po `EPSSolve`, co nie dowodzi sumy wszystkich solve'ów | zliczać iteracje monitorem/callbackiem i nazwać pola zgodnie z semantyką |
| ID-01 | `CONFIRMED P1` | `linearization_state.cpp:62–68,408–431` buduje tekst `key=value;`, choć pole nazywa się `*_hash` | użyć kanonicznego SHA-256 albo zmienić nazwę na `signature_preimage` |
| TEST-02 | `CONFIRMED P0` | brak świeżego pełnego CPU window związanego z obecnym commit/runtime | pozostaje główną bramką Q1 |
| TEST-03 | `CONFIRMED P0` | brak profiler-backed GPU qualification dla obecnego candidate | pozostaje główną bramką Q2 |
| UI-02 | `CONFIRMED P0` | brak live WebGL proof na tych samych natywnych artefaktach | pozostaje główną bramką Q3 |

Największą wartością dokumentów GPT Pro jest więc nie ogólne stwierdzenie „brak
kwalifikacji”, które audyt już zawierał, lecz wskazanie trzech konkretnych defektów
przed Q1: niespójnej renormalizacji stanu, fikcyjnej masy lumped i błędnej geometrii
targetu SLEPc.

### 13.4. Tezy wymagające zawężenia albo odrzucenia

| ID GPT Pro | Werdykt | Korekta po sprawdzeniu scalonego drzewa |
|---|---|---|
| SCM-02 | `STALE/RESOLVED` | kod rescue i bieżąca baza są już połączone w jednym dedykowanym branchu |
| ABI-01 | `STALE/RESOLVED` | publiczne modalne deskryptory, request i result mają `struct_size` w `native/include/fullmag_fem.h` |
| ABI-03 | `STALE/RESOLVED` | request ma jawny `execution_target`, result publikuje `resolved_execution_target` i `resolved_engine_id` |
| ABI-04 | `STALE/RESOLVED` | modalne rozmiary i offsety są objęte layout/fingerprint v2–v4 w nagłówku ABI |
| PHY-07 | `PARTIAL` | backendowy operator i mode kinematics walidują enum fail-closed, ale opcjonalność/fallback w projekcji UI nadal wymaga testu end-to-end |
| POI-01 | `STALE na poziomie D1/D2` | scalone drzewo ma realny shared-domain MFEM/Poisson-airbox assembly i testy; nadal brak aktualnego D3/D4 |
| POI-02 | `STALE na poziomie D1/D2` | `periodic_mesh_certificate.v6` waliduje relacje seam/corner, role regionów, klasy i kanoniczne digests; nadal trzeba sprawdzić receipt runtime |
| GPU-01 | `STALE jako opis całego GPU` | limit 64 DOF dotyczy bounded dense validation lane; `kMaxGpuModalDofs` i produkcyjny adapter są osobne |
| GPU-02 | `STALE na poziomie źródeł` | istnieje osobny `gpu/frequency_domain/modal_petsc_slepc.cpp` z PETSc/SLEPc CUDA; jego produkcyjność pozostaje `NOT VERIFIED` |
| GPU-03 | `PARTIAL/NOT VERIFIED` | kod deklaruje persistent setup i brak transferów w iteracji, lecz prawdziwość musi potwierdzić profiler, nie self-report |
| GPU-04 | `STALE/RESOLVED` | modalny CUDA kod jest wydzielony do `modal_krylov.cu` i `modal_petsc_slepc.cpp` |
| UI-01 | `STALE/RESOLVED na D1/D2` | scalony Control Room zawiera resources, selection/composition, Inspectory i viewport mode overlay; nie ma jednak D5 |

Pozostałych tez GPT Pro, zwłaszcza `NUM-03..10`, `PERF-01..06`, `ART-01..03`,
`TEL-01` i `GPU-05`, nie należy automatycznie uznawać za potwierdzone dla całej
architektury. Część dotyczy oracle/validation lane, część route produkcyjnego, a
część wymaga pomiaru. Trafiają do ukierunkowanego audytu R3/R4, nie do listy
zamkniętych faktów.

### 13.5. Zaktualizowany rejestr P0

| ID | Problem bieżący | Bramka zamknięcia |
|---|---|---|
| WIN-SRC-01 | puste symlinki blokują czystą materializację managed source | clean source export i identity manifest z dokładnego commit SHA |
| LIN-PHY-01 | `m0` może zostać zmienione bez recompute pól zależnych | fail-closed lub atomowy recompute `m0/H_eff0/H_demag0/phi0/energy` |
| LIN-FE-01 | tangent mass jest wektorem jedynek | rzeczywista FE lumped mass + unit/invariance tests |
| LIN-CERT-01 | acceptance artifact nie jest niezależnym linearization certificate | recomputed, digest-bound certificate i weighted residual |
| CPU-SPEC-01 | helper SLEPc targetuje oś rzeczywistą mimo spektrum `+-i omega` | poprawny pencil/target + analityczny test regresyjny |
| CPU-COMP-01 | stałe oversampling `2*requested` nie gwarantuje coverage | adaptacyjne żądanie albo jawne incomplete |
| CPU-Q1 | brak świeżego certified window na realnym antydocie | Q1 receipt z residualami, completeness i convergence |
| GPU-Q2 | źródła GPU istnieją, lecz nie są profiler-qualified | Q2 z device trace, parity i scaling |
| UI-Q3 | UI istnieje, lecz nie ma live proof | Q3 na artefaktach tego samego immutable candidate |

## 14. Skorygowany plan wdrożenia v2

Plan poniżej zastępuje R0–R9 jako plan wykonawczy. Nie powtarza wykonanej
konsolidacji i rozdziela naprawy fizyki od kwalifikacji produktu.

### R0–R2 — wykonane lokalnie

**Stan:** `DONE-D1`.

- odzyskano rescue i zachowano historyczne worktree;
- utworzono dedykowany worktree Windows;
- scalono aktualną bazę z rescue bez dotykania dirty `master`;
- focused baseline przed ostatnim, skryptowym amendem obejmował 193/193 testów
  runnera eigensolve, 49/49 testów API i Control Room typecheck;
- targetowane UI Vitest nie wystartowały z powodu istniejącego
  `ERR_REQUIRE_ESM`; nie był to wynik assertion testów;
- managed CPU gate został zablokowany przez source materialization na pustych
  symlinkach, więc D3/D4 nadal nie istnieje.

Ponieważ ostatni amend dotyczył skryptów runtime, dla ścisłej tożsamości candidate
focused baseline należy powtórzyć na finalnym SHA po naprawach R3–R6.

### R3 — odtwarzalny Windows/managed source

1. Naprawić puste cele `.claude/skills/*` w sposób zgodny z polityką repozytorium.
2. Udowodnić clean checkout/export na Windows i w managed builderze.
3. Zapisać commit SHA, tree SHA, source manifest i runtime manifest jako różne pola.
4. Uruchomić source-identity gate przed buildem.

**Bramka:** managed runtime widzi dokładnie to samo drzewo co worktree; brak pustych
symlinków i brak ręcznie skopiowanych źródeł.

### R4 — korekta stanu liniaryzacji i certyfikatu fizycznego

1. Ustawić `allow_m0_renormalization=false` jako produkcyjny default.
2. Jeżeli renormalizacja pozostaje wspierana, przeliczać atomowo wszystkie zależne
   pola i energię; w przeciwnym razie odrzucać wejście.
3. Zaimplementować `recompute_h_eff0_and_compare` i
   `require_symmetric_periodic_mesh` albo usunąć martwe opcje z kontraktu.
4. Zastąpić `tangent_lumped_mass=1` rzeczywistą masą FE z tego samego assembly.
5. Dodać ważone normy torque, tangent leakage i full descriptor residual.
6. Związać certificate z mesh, magnetic/airbox topology, material, BC, `phi0`,
   operator/pencil, acceptance i source SHA przez kanoniczny SHA-256.
7. Dodać negatywne testy: zmienione `m0`, `H_eff0`, masa, `phi0`, mesh i certificate.

**Bramka:** nie da się zbudować stanu liniaryzacji z niespójną parą `m0/H_eff0`;
test stałego pola i test skalowania FE przechodzą.

### R5 — audyt lane'ów i semantyki statusów

1. Sporządzić call graph każdej publicznej ścieżki: oracle, bounded validation,
   CPU production i GPU production.
2. Przypisać stabilne engine ID i jawny status `validation_only`/`production`.
3. Dla każdej tezy `NUM-03..10`, `PERF-01..06`, `ART-01..03`, `TEL-01` wskazać
   dokładny lane; nie naprawiać oracle tak, jakby był production hot path.
4. Rozdzielić `solve_succeeded`, `fields_available`, `selected_only`,
   `window_complete`, `scientifically_qualified` i `release_qualified`.
5. Unknown phase convention odrzucać na backendzie, API i w viewport bez fallbacku.

**Bramka:** każdy publiczny wynik ujawnia lane/engine i nie może promować
availability do completeness/qualification.

### R6 — poprawny CPU nearest-frequency

1. Naprawić reprezentację problemu własnego tak, aby shift-and-invert targetował
   fizyczne `+i omega` albo równoważny, jawnie obrócony realny pencil.
2. Dodać analityczny makrospin test, w którym target realny i urojony wybierają
   różne wyniki; test ma wykrywać regresję NUM-01.
3. Zastąpić stałe `2*requested` adaptacyjnym `nev/ncv` i retry po filtracji.
4. Liczyć residual pełnego oryginalnego descriptor pencil dla każdego moda.
5. Poprawić telemetrykę iteracji KSP i jawnie raportować ostatni/łączny licznik.
6. Zachować nearest jako `selected_only`, nigdy `complete`.

**Bramka:** nearest na małym oracle i realnym shared-domain case zwraca właściwy
mod, pełny residual i jawny status incomplete/selected-only.

### R7 — certyfikowane CPU complete window

1. Zaimplementować adaptacyjne pokrycie okna i niezależny warunek kompletności.
2. Wymagać zgodności base/refinement, stabilności klastrów i braku truncation.
3. `window_complete=true` ustawiać wyłącznie po przejściu pełnego certificate.
4. Uruchomić Kittel jako niezależny oracle oraz realny okresowy antidot z dziurą.
5. Wykonać uzgodniony zestaw mesh/airbox convergence i zapisać receipt.

**Bramka R7/Q1:** pełne okno, wszystkie residuale, brak fallbacku, convergence i
immutable source/runtime/input identity są zielone.

### R8 — artefakty, API, FMS i Control Room

1. Propagować rozdzielone statusy i pełny identity tuple do artifact/API/UI.
2. Regenerować OpenAPI kanonicznym generatorem.
3. Wykonać FMS export -> restart -> import bez pierwotnej historii.
4. Naprawić środowisko Vitest `ERR_REQUIRE_ESM` i uruchomić targetowane testy UI.
5. Wykonać live browser/WebGL proof na natywnych artefaktach CPU Q1.

**Bramka R8/Q3-CPU:** spectrum, mode field i viewport wskazują ten sam candidate;
60 s bez utraty WebGL context, stale cache i konfliktu shaderów.

### R9 — GPU production i Q2

1. Kwalifikować `modal_petsc_slepc.cpp`, nie bounded dense CUDA oracle.
2. Potwierdzić przez profiler `VECCUDA`, `MATAIJCUSPARSE`, HYPRE device path,
   persistent setup i brak transferów/synchronizacji w hot loop.
3. Wykonać bounded, pośredni i `>1024 DOF`, następnie ten sam antydot co CPU.
4. Porównać częstotliwości, pełne residuale i podprzestrzenie klastrów.
5. Wykonać repeatability, cancellation, teardown, peak-memory i sanitizer gates.

**Bramka R9/Q2:** profiler i parity potwierdzają production path bez fallbacku;
self-report bez trace nie wystarcza.

### R10 — immutable candidate i promocja

1. Po R3–R9 zamrozić jeden candidate.
2. Powtórzyć focused source tests na dokładnym finalnym SHA.
3. Powtórzyć wymagane D3–D5 po każdej zmianie wpływającej na source identity.
4. Zbudować DoD manifest z osobnym statusem CPU, GPU i browser.
5. Dopiero wtedy pobrać najnowszy `master`, rozwiązać konflikt i przygotować merge.

**Bramka R10/G2:** commit, runtime, receipts, profiler i browser proof mają wspólną
tożsamość; brak `pending`, historycznych substytutów i ręcznych wyjątków.

### 14.1. Zależności i najkrótsza ścieżka do przykładu warstwy z dziurą

```text
R3 clean source
 -> R4 physical linearization
 -> R5 lane/status audit
 -> R6 correct CPU nearest
 -> R7 real periodic antidot CPU Q1
 -> R8 artifact/API/UI Q3-CPU

R7 CPU oracle -> R9 GPU Q2
R8 + R9 -> R10/G2
```

Pierwszy wiarygodny przykład „warstwa z dziurą” nie musi czekać na GPU ani pełny
release. Minimalny naukowo uczciwy milestone to R3–R7: poprawny stan
liniaryzacji, rzeczywista masa FE, poprawny target SLEPc, realny periodic
Poisson-airbox assembly, pełny residual i jawny status selected-only lub certified
window. UI może zostać dołączone w R8.

## 15. Zaktualizowana decyzja

Wnioski GPT Pro są użyteczne, ale nie jako gotowy werdykt o całym repozytorium.
Do planu należy przyjąć przede wszystkim `PHY-01`, `PHY-02`, `PHY-05`, `NUM-01`,
`NUM-02`, `ID-01` oraz nacisk na niezależną kompletność i profiler-backed Q2.

Nie należy ponownie wykonywać recovery ani przepisywać solvera od zera. Należy
kontynuować wyłącznie w
`C:\git\fullmag\worktrees\eigensolve-k0-finalization`, zaczynając od R3 i R4.
Najbliższym celem nie jest merge do `master`, lecz wiarygodny CPU example warstwy
z dziurą zamykający R7/Q1.

## 16. Aktualizacja po synchronizacji z `origin/master`

### 16.1. Tożsamość i zakres synchronizacji

Na żądanie użytkownika prace pozostały w dedykowanym worktree
`C:\git\fullmag\worktrees\eigensolve-k0-finalization`, ale gałąź została
zsynchronizowana z aktualnym `origin/master`:

- pobrany `origin/master`: `c0aa1ff9f` (`Harden production and development build paths`),
- merge do gałęzi K0: `ddabf6a5e`,
- checkout `master` nie został zmieniony,
- nic nie zostało wypchnięte do zdalnego repozytorium.

Merge wniósł 12 commitów i zmiany w 165 plikach. Cztery konflikty zostały
rozwiązane merytorycznie:

1. `dispatch.rs` zachowuje nowy modułowy orchestrator K0 z
   `fem/eigen_path.rs` oraz równocześnie refaktor mastera przenoszący CUDA FDM
   do `solvers/fdm/...`; żadna ze starych zduplikowanych implementacji nie została
   przywrócona.
2. `backends/fem/CMakeLists.txt` zachowuje źródła i kontrakty K0
   (shared-domain, rotated pencil i GPU PETSc/SLEPc), a z mastera przyjmuje
   wymagane linkowanie `fem_aos_field_contract` z MFEM.
3. `types.rs` zachowuje `FemEigenExecutionResolutionIR` i przyjmuje nowe typy
   receiptów reprezentacji FEM.
4. Ten audyt zachowuje rozszerzoną wersję worktree; pierwotna wersja dodana
   niezależnie na masterze nie zastąpiła aktualizacji R13–R16.

### 16.2. Wpływ zmian meshu na plan K0

Synchronizacja jest istotna dla przykładu warstwy z dziurą. Master zmienił
jednocześnie:

- generowanie mixed prism/pyramid w `_gmsh_swept.py` i typy Gmsh,
- persistence oraz trust policy artefaktów meshu,
- `Problem`/`World` i przekazywanie mixed certificate do natywnego backendu,
- `mixed_certificate.rs` i testy natywnego certyfikatu,
- adaptery AoS oraz rozróżnienie local/true state w runtime MFEM.

W konsekwencji wcześniejsze wyniki managed runtime i przyszły receipt antydotu
nie mogą być przeniesione na nowy HEAD. R3 zostaje ponownie otwarte dla
`ddabf6a5e`: trzeba zbudować nowy bundle, sprawdzić jego manifest i wykonać
kontrakty K0. W R4/R7 należy dodatkowo dowieść, że masa FE, markery magnetic/
airbox, topology SHA i DOF ordering pochodzą z tej samej, aktualnej reprezentacji
true-DOF. Sama zgodność liczby węzłów nie jest wystarczająca.

### 16.3. Dowód po rozwiązaniu konfliktów

Na scalonym drzewie wykonano:

- `cargo +nightly check -p fullmag-runner --no-default-features` — **PASS**,
- `cargo +nightly test -p fullmag-runner --no-default-features --lib dispatch::tests`
  — pierwszy przebieg ujawnił wyłącznie osiem starych testów po przeniesieniu
  CUDA/FEM helpers; po aktualizacji 89 testów przeszło, a jedyny pozostały test
  przeszedł w osobnym powtórzeniu,
- test wykonujący rzeczywistą ścieżkę CUDA jest teraz jawnie ograniczony przez
  `cfg(feature = "cuda")`, zamiast fałszywie oczekiwać CUDA w buildzie
  `--no-default-features`.

Targetowany zestaw Python mixed mesh/persistence/native certificate uruchomiony
w efemerycznym kontenerze dał początkowo **275 passed, 15 skipped, 2 failed**.
Obie porażki zostały rozdzielone od K0 i naprawione przyczynowo:

- kandydat kwalifikacyjny `Relocate3D` otrzymuje własne deterministyczne
  `qualification.v2` algorithm ID nawet wtedy, gdy parametry są równe polityce
  produkcyjnej; nie podszywa się już pod `fullmag.mixed-tet-repair.v1`,
- `.mphtxt` ma regułę `-text`, dlatego Windows `core.autocrlf` nie zmienia
  kanonicznych bajtów fixture COMSOL; working-tree SHA ponownie wynosi
  `1bb2bfac...a36730f8d`.

Oba wcześniej nieudane testy przeszły następnie w osobnym przebiegu (**2 passed**).
Pełny zestaw należy jeszcze powtórzyć na zamrożonym commicie, aby zamknąć ten
source gate jednym terminalnym receipt.

Pełna receptura `verify-fem-frequency-domain-native-contract` rozpoczęta przed
synchronizacją została świadomie przerwana, ponieważ jej wynik dotyczyłby
nieaktualnego źródła `c61c3f56a`. Musi zostać powtórzona po tej aktualizacji
dokumentu na nowym, nieruchomym HEAD.

### 16.4. Zmieniona kolejność najbliższych prac

1. Zamrozić commit zawierający merge, korekty mixed-mesh i ten dokument.
2. Powtórzyć pełny targetowany zestaw Python na dokładnym SHA.
3. Wykonać pełne R3 na tym samym, nieruchomym SHA.
4. Sprawdzić R4 względem nowych adapterów local/true i mixed certificate.
5. Dopiero na tej bazie kontynuować R5–R7 i policzyć antydot CPU.

Synchronizacja nie zmienia końcowego werdyktu: **NO-GO dla claimu produkcyjnego
K0**, dopóki nowy HEAD nie uzyska managed CPU Q1, a później niezależnego GPU Q2.
