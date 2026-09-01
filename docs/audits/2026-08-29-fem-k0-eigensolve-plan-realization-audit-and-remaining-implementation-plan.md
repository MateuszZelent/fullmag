# Audyt realizacji planu FEM eigensolve K0 CPU/GPU i plan domknięcia

**Data audytu:** 2026-08-29
**Ostatnia aktualizacja wykonawcza (Windows/Docker Desktop):** 2026-08-31
**Audytowany task Codex:** `codex://threads/019ff50c-f17c-79f2-9473-edac793b79c4`
**Tytuł tasku:** `Dokończ eigensolve k0 demag (2)`
**Bieżący worktree:** `C:\git\fullmag\worktrees\eigensolve-k0-finalization`
**Bieżący branch:** `codex/eigensolve-k0-finalization-20260829`
**Commit bazowy audytu:** `5e5849c8acf8ec0f80c0f463fc5d9109ea9a4e14`
**Tryb audytu:** analiza źródeł i dokumentów, świeży CPU solve oraz częściowy hardware/profile proof GPU przez Docker Desktop; bez browser proof
**Werdykt:** **GO dla dalszej implementacji w dedykowanym worktree; NO-GO dla claimu produkcyjnego CPU/GPU i bezpośredniej promocji do `master`**

> **Uwaga o aktualności:** sekcje 1–12 zachowują stan i rozumowanie audytu
> sprzed lokalnej konsolidacji. R0–R2 zostały następnie wykonane przez utworzenie
> windowsowego worktree i merge aktualnego `master` z rescue. Sekcje 13–15 są
> aktualizacją po konsolidacji i zastępują wcześniejszy plan tam, gdzie występuje
> różnica.

### Aktualizacja wykonawcza: regresja przykładu okresowego antidot K0

Próba odtworzenia historycznej ścieżki `nearest` na rzeczywistym przykładzie
`fem_periodic_antidot_relax_eigenmodes.py` potwierdziła, że funkcja istniała i
nie została usunięta. Aktualna regresja składała się z dwóch niezależnych
problemów integracyjnych:

1. Usługa `fem-modal-cpu` uruchamiała wspólny, CUDA-capable managed binary bez
   dostępnego `libcuda.so.1`. Nie był to wybór urządzenia GPU ani błąd solvera.
   CPU lane nadal nie żąda GPU i używa `FULLMAG_FEM_MFEM_DEVICE=cpu`; loader
   otrzymał image-owned `/usr/local/cuda/compat` w commitcie `90b738179`.
2. Dodany później check handoffu porównywał natywne okresowe
   `H_demag0/H_eff0/phi0` z wynikiem referencyjnego `FemLlgProblem`, który nie
   implementuje produkcyjnej redukcji Poissona `periodic_airbox_k0`. Było to
   porównanie dwóch różnych warunków brzegowych, a nie niezależny recompute tego
   samego problemu.

Dowód z managed CPU przed korektą drugiego problemu:

- źródło/runtime: exact schema 3, commit `937b5d694`, dirty patch
  `4e697d6a5513b241b4c45306930d1318ef5ecaa7b62d526cdbb01f3e616efe16`;
- mesh: 5156 węzłów, 27384 tetraedry; część magnetyczna 3036 tetraedrów;
- relaksacja: zakończona kryterium torque w kroku 3135,
  `max_torque=9.9930e-7 T`, `E_total=-2.3662e-18 J`;
- przejście do etapu `flat_eigenmodes` nastąpiło, lecz fałszywy check zatrzymał
  wykonanie komunikatem
  `relax_stage_handoff_h_demag0_recompute_mismatch` i różnicą `9.995e4 A/m`.

Korekta zachowuje niezależny check zgodnych składników `H_ex/H_ext` oraz pełny
check nieokresowych problemów. Dla meshu z parami okresowymi nie używa solvera
otwartego jako rzekomego oracle dla okresowego `H_demag/H_eff/phi`; pola nadal
są kompletne, digest-bound i sprawdzane pod kątem dekompozycji. Testy źródłowe
`fem::eigen_tests`: **132/132 PASS**. Ponowny managed solve po tej korekcie jest
**NOT VERIFIED**. WSL nie jest środowiskiem wykonawczym tego worktree ani
warunkiem dalszych prac: aktywnym środowiskiem jest Windows, a linuxowy runtime
ma być uruchamiany bezpośrednio przez Docker Desktop. Windowsowy klient i daemon
Docker Desktop zostały potwierdzone (`29.6.1`, daemon `linux`); pozostało
zmaterializować świeży bundle runtime z bieżącego Windowsowego worktree i
uruchomić recepturę bez zależności od starego WSL-owego aliasu runtime.

Konsekwencja dla planu: R4 pozostaje **PARTIAL**, dopóki recompute okresowego
`H_demag0/phi0` nie zostanie wykonany przez niezależne wywołanie tego samego
natywnego operatora `periodic_airbox_k0` i związany osobnym certyfikatem. Nie
wolno uznać samego usunięcia fałszywego porównania za realizację bramki R4.

### Aktualizacja wykonawcza: natywny certyfikat recompute R4

Finalizacja relaksacji zachowuje teraz pola zaakceptowanego endpointu, wykonuje
obowiązkowy świeży snapshot tym samym natywnym backendem (w tym tym samym
operatorem `periodic_airbox_k0`) i porównuje `m0`, `H_ex0`, `H_demag0`, `H_ext0`,
`H_eff0` oraz `phi0`. Rozjazd kształtu, wartości niefinitywne, zmiana `m0` lub
przekroczenie tolerancji zatrzymują handoff fail-closed.

Po zgodnym recompute publikowany jest
`equilibrium/recomputed_fem_linearization_certificate.v1.json`. Certyfikat wiąże
digest `m0`, topologię meshu, sygnatury materiału/statycznej fizyki/BC, digesty
pól przed i po recompute oraz metryki różnic. Orchestrator wymaga i waliduje ten
certyfikat przed utworzeniem typowanego handoffu relaksacja -> eigensolve.
Negatywne testy odrzucają certyfikat z niezgodnym własnym SHA, `m0`, meshem lub
polem recomputed; targetowany test CLI przechodzi na Windowsie.

Ten slice nadal oznacza R4 **PARTIAL**, nie `DONE`: trzeba rozszerzyć związanie o
operator/pencil, acceptance i source SHA, domknąć wymagania masy FE/energii oraz
uzyskać rzeczywisty Windows Docker Desktop runtime proof na okresowym antydocie.

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
Pełny zestaw powtórzony na zamrożonym commicie kodu `af4a87c37` zakończył się
terminalnie wynikiem **277 passed, 15 skipped, 37 subtests passed** w 163.06 s.
Source gate mixed mesh/persistence/native certificate jest zatem zielony; nie
jest to jednak substytut managed runtime receipt R3 ani naukowej kwalifikacji R7.

Pełna receptura `verify-fem-frequency-domain-native-contract` rozpoczęta przed
synchronizacją została świadomie przerwana, ponieważ jej wynik dotyczyłby
nieaktualnego źródła `c61c3f56a`. Musi zostać powtórzona po tej aktualizacji
dokumentu na nowym, nieruchomym HEAD.

### 16.4. Zmieniona kolejność najbliższych prac

1. Wykonać pełne R3 na nieruchomym HEAD po tej aktualizacji dokumentu.
2. Sprawdzić R4 względem nowych adapterów local/true i mixed certificate.
3. Dopiero na tej bazie kontynuować R5–R7 i policzyć antydot CPU.

Synchronizacja nie zmienia końcowego werdyktu: **NO-GO dla claimu produkcyjnego
K0**, dopóki nowy HEAD nie uzyska managed CPU Q1, a później niezależnego GPU Q2.

## 17. Aktualizacja wykonawcza: Windows-only CPU nearest na realnym antydocie

### 17.1. Twarda granica środowiska

Od tej aktualizacji jedynym checkoutem roboczym jest:

`C:\git\fullmag\worktrees\eigensolve-k0-finalization`

Git, edycja, testy źródłowe i sterowanie runtime odbywają się w Windows.
Kontenery Linux są uruchamiane wyłącznie przez Docker Desktop bezpośrednio z
PowerShella, z bind mountem powyższego Windowsowego worktree do `/workspace`.
WSL, checkouty `/home/...`, ścieżki `/mnt/...` i alias runtime wskazujący poza
Windowsowy worktree nie należą do workflow i nie mogą być używane jako dowód.

Historyczna nazwa launchera została usunięta. Kanoniczny launcher FEM na Windows
to `scripts/windows/run_fullmag_docker.ps1`, a `justfile`,
`compose.windows.yaml`, kontrakty i reguła repozytorium wskazują teraz tę nazwę.
Launcher używa Docker Desktop, zewnętrznych Windowsowych katalogów build/cache i
fail-closed wyboru CPU/GPU. Wszystkie 22 testy kontraktu launchera przeszły, a
plik PowerShell przeszedł parser składni.

### 17.2. Regresja residualu i naprawa przyczynowa

Pierwszy świeży solve realnego `fem_periodic_antidot_relax_eigenmodes.py`
ujawnił regresję inną niż wcześniejszy handoff. SLEPc zwrócił 40 zbieżnych par,
30 dodatnich częstotliwości i 30 zrekonstruowanych wektorów, lecz 28 par trafiło
do niepoprawnej korekty KSP i zostało odrzuconych. Opublikowano tylko jeden mod
`2.54879717697576 GHz`, a przebieg trwał `1093.689 s`.

Przyczyną było niespójne mapowanie wartości własnej obróconego pencila. Dla
`w = kr + i*ki` oryginalny descriptor wymaga
`lambda = i*w = -ki + i*kr`, lecz produkcyjny kod zerował część `-ki` przy
certyfikacji residualu i przekazywał zero również do refinement. Nawet małe
`ki` tworzyło fałszywy residual ponad tolerancją i kierowało poprawne wektory do
źle postawionej korekty.

Commit `7d0a6580d` wprowadził jedno kanoniczne mapowanie
`original_descriptor_eigenvalue_from_rotated`, używane przez residual i
refinement. Publiczna częstotliwość niedampowanego moda nadal ma zerową
publikowaną część rzeczywistą; surowe `-ki` jest zachowane wyłącznie tam, gdzie
wymaga go matematyka certyfikacji.

Dowody źródłowe:

- nowy test `fem_real_frequency_rotated_pencil_contract` — **PASS**;
- `cargo test -p fullmag-runner fem::eigen_tests` — **133/133 PASS**;
- szerszy `fem_poisson_airbox_modal_eigen_slepc_contract` nadal ma jeden
  niezależny, istniejący również przed zmianą błąd bramki frequency-window:
  `production shared-domain K0 Schur frequency window was not certified`.
  Nie jest on zaliczony jako regresja nearest ani jako dowód Q1.

### 17.3. Świeży wynik CPU nearest

Runtime zbudowano bezpośrednio z czystego Windowsowego źródła przez Docker
Desktop. Tożsamość solve:

- commit: `7d0a6580d971537bbefa44f942dccd6e71078096`;
- source snapshot:
  `8c6b2d06931f348d69af02f0da5c3f9cd2cfbe0602d5a622549e229422c21d30`;
- binary SHA-256:
  `cfe7f707d88e0deb028947efe7a4f3d102fc4f574bfe1234fbd8a9ad428e1dce`;
- native FEM library SHA-256:
  `2adac303affc8a6e3a4493e7995bf6c0ca615582cff29f8cfd02644dbd03220c`;
- źródło było czyste (`source_snapshot_dirty=false`).

Raport:

`.fullmag/reports/fem-periodic-antidot-relax-eigenmodes/windows-cpu-nearest-7d0a6580d-cache-mfem`

Wynik:

- realny mesh okresowej warstwy z otworem: 5156 węzłów i 27384 Tet4;
- target `nearest_frequency=2 GHz`, żądane 8 modów, zapisane pola 4 modów;
- **8/8 modów zaakceptowanych**, najniższy `2.54879717697576 GHz`;
- residuale opublikowanych modów od `7.89e-14` do `3.68e-12`;
- `full_residual_accepted_count=15`, `full_residual_rejected_count=15`;
- `refinement_succeeded_count=30`, `refinement_failed_count=0`;
- brak fallbacku, lane `production_cpu`, pełny residual certyfikowany;
- czas `144.063 s`, wobec `1093.689 s` w przebiegu diagnostycznym przed
  naprawą;
- walidator artefaktów z `--require-k0-periodic-airbox-production` — **PASS**;
- walidator kompletnego relax-to-eigen handoff — **PASS**.

Cache equilibrium nie jest skrótem fizycznym eigensolve: przechowuje wcześniej
zaakceptowany stan tego samego meshu. Walidator dopuszcza teraz `executed_steps=0`
wyłącznie dla `fem_periodic_antidot_equilibrium_cache.v2` z niepustym i dokładnie
zgodnym `mesh_generation_id` oraz `topology_fingerprint`. Brak cache, stary schema
albo drift meshu są odrzucane fail-closed. Poprawka jest w commicie `73c39d4ed`.
Rzeczywisty raport i 19 uruchomionych natywnie przypadków walidatora przeszły;
pełny runner `pytest` nie był dostępny w Windowsowym Pythonie ani lokalnym obrazie,
co pozostaje jawną granicą dowodu.

### 17.4. Aktualny stopień realizacji planu v2

| Etap | Stan | Ocena | Co jest dowiedzione / czego brakuje |
|---|---|---:|---|
| R0–R2 | DONE-D1 | 100% | recovery, dedykowany Windows worktree i synchronizacja z master wykonane |
| R3 | DONE dla solve `7d0a6580d`; otwarty dla finalnego SHA | 85% | clean source identity, build i runtime hash są związane; bieżący dirty snapshot ma aktualny manifest, ale finalny clean SHA wymaga zamrożenia kandydata |
| R4 | PARTIAL | 80% | natywny recompute, certyfikat, negatywne testy i FE-weighted leakage istnieją; pozostaje pełne związanie operator/pencil/acceptance/source SHA oraz domknięcie testów masy/energii |
| R5 | PARTIAL | 75% | cache-backed relax→eigen handoff i publikacja topology identity przechodzą na świeżym Windows CPU nearest; pozostaje pełny call graph oraz runtime/API proof wszystkich statusów |
| R6 | PARTIAL, solve działa | 95% | poprawny obrócony pencil, pełne residuale, current CPU contract 10/10 i świeży nearest 8/8 z artefaktami są zielone; zakres pozostaje jawnie `selected_only`, bez pełnego window |
| R7 | PARTIAL, terminal run failed | 55% | syntetyczny complete-window certificate, pełny CPU/SLEPc kontrakt oraz phase/current/total/timing przechodzą; kanoniczny realny window zakończył się segfaultem po 66173.943 s bez terminalnych artefaktów, a convergence mesh/airbox pozostaje niewykonane |
| R8 | PARTIAL, source/API/FMS/UI i transport owner identity zielone | 70% | rozdzielone statusy, identity tuple, revision-aware cache, typowany OpenAPI, FMS, live spectrum, odczyt pola, publikacja zgodnej topologii FEM i transport pełnej tożsamości klikniętego moda są zielone; historyczny artifact nadal nie ma kompletnego nowego kontraktu, a rzeczywisty restart procesu i pełny WebGL overlay na finalnym runtime SHA pozostają otwarte |
| R9 | PARTIAL, hardware contract i adapter-scale zielone | 50% | właściwy Windows/Docker Desktop runtime PETSc 3.24/SLEPc 3.24/HYPRE CUDA jest związany z bieżącym snapshotem; kontrakt GPU 12/12 i bramka adapter-scale `1026 DOF` przechodzą z zaakceptowanym residualem i 45 748 aplikacjami operatora, a lifecycle 50/50 oraz ABI KSP przechodzą; brak realnego antydotu GPU, profiler receipt, parity oraz odporności exact/near-shift |
| R10 | NOT STARTED | 0% | nie ma immutable final candidate ani podstaw do promocji na master |

Ważona realizacja skorygowanego planu R0–R10 wynosi obecnie około **70–75%**.
Gotowość do uruchamiania wiarygodnego przykładu CPU nearest warstwy z dziurą jest
wysoka, około **90–95%**, i sam solve wraz z publikacją artefaktów już działa. Gotowość do claimu pełnego
spektrum/okna Q1 pozostaje niska, około **15–25%**, ponieważ nearest nie dowodzi
kompletności okna. Gotowość produkcyjna całego CPU+GPU+UI release pozostaje
**0%**, dopóki R7, R8, R9 i R10 nie przejdą swoich terminalnych bramek.

### 17.5. Nowy plan wdrożenia tego, co pozostało

Kolejność poniżej zastępuje sekcję 16.4 i nie wraca do recovery ani WSL:

1. **R5/R6 — domknąć propagację semantyki nearest.** Przebudować runtime z
   nowymi polami `engine_id`, `solve_succeeded`, `fields_available`,
   `spectrum_completeness=selected_only` i `window_complete=false`, a następnie
   dodać testy propagacji backend -> artifact/API. `complete=true` nie może być
   interpretowane jako `window_complete=true`.
2. **R4 — domknąć certificate binding.** Związać recompute certificate z
   operator/pencil, acceptance artifact, pełnym source identity oraz dowieść
   invariance/skaling rzeczywistej masy FE na aktualnym true-DOF mesh.
3. **R7 — naprawić istniejącą bramkę frequency-window.** Ustalić, czy problemem
   jest coverage/oversampling, deduplikacja, subwindow termination czy certificate;
   dodać adaptacyjne `nev/ncv` i fail-closed incomplete zamiast pozornego sukcesu.
4. **R7/Q1 — wykonać pełne CPU window.** Na realnym antydocie uruchomić base i
   refinement, Kittel oracle oraz uzgodnioną convergence mesh/airbox. Wszystkie
   opublikowane mody muszą mieć pełny residual, a `window_complete=true` wymaga
   niezależnego certificate. Produkcyjny przebieg musi również publikować
   obserwowalny postęp `phase=base|refinement`, `current_subwindow/total_subwindows`,
   czas każdego podokna i czas całkowity. Przed Q1 należy ustalić jawny budżet
   czasu dla kanonicznego wejścia; samo aktywne zużycie CPU nie dowodzi akceptowalnej
   wydajności ani postępu kompletności.
5. **R8 — artifact/API/FMS/UI.** Po wdrożonej propagacji statusów, identity tuple,
   typowanego OpenAPI i revision-aware cache przebudować finalny runtime, wykonać
   export -> restart -> import bez historii oraz zrobić 60-sekundowy live
   browser/WebGL proof na artefaktach CPU Q1.
6. **R9 — GPU Q2.** Uruchomić produkcyjny PETSc/SLEPc CUDA lane na tym samym
   antydocie, zebrać profiler trace, wykazać brak transferów/fallbacku oraz parity
   częstotliwości, residuali i podprzestrzeni klastrów.
7. **R10 — finalizacja.** Dopiero po powyższych zmianach uchwycić nowy czysty
   source identity, przebudować runtime, powtórzyć bramki, zsynchronizować z
   najnowszym masterem i przygotować jeden immutable candidate do promocji.

Najbliższy krok implementacyjny to punkt 1, nie ponowne liczenie tego samego
nearest i nie ponowny recovery. Aktualny wynik rozstrzyga pierwotną wątpliwość:
**warstwę z dziurą można już policzyć na CPU w trybie nearest; brakuje przede
wszystkim uczciwej semantyki statusu i pełnego, certyfikowanego okna.**

### 17.29. R5/R6: świeży Windows CPU nearest po naprawie publikacji

W aktualnym worktree uruchomiono ponownie przykład z katalogu raportu
`C:\fullmag-cache\state\fem-gpu\reports\fem-periodic-antidot-relax-eigenmodes\windows-cpu-nearest-7225-cache-rerun-3`.
Przebieg użył jawnego, hash-pinned cache równowagi z tego samego meshu i
Windowsowego managed runtime `fullmag/fem-gpu:windows-local`; nie użyto WSL ani
ścieżki `/home`/`/mnt/c`. Manifest runtime wiąże commit
`40540afdf0acbe3fbd1b8fcbd903071cae374c4d`, `worktree_state=dirty` i source
snapshot `7225e5102de93d49ebc1c1d40bc24dbb75714ead7112e168fddb6b22906f89d1`.

Wcześniejszy przebieg tego samego nearest kończył się po poprawnym solve błędem
`production K0 modal publication requires solver_diagnostics.source_mesh_topology_sha256`.
Przyczyną był brak odtworzenia pola topology identity przy cache-backed
equilibrium, gdy nie istniał in-memory relax handoff. W
`crates/fullmag-runner/src/fem/eigen_native_artifacts.rs` dodano fail-closed
uzupełnienie tego pola z dokładnego `plan.mesh.topology_fingerprint_v6()` dla
produkcyjnych adapterów K0 CPU/GPU. Nie omija to walidacji: późniejsze bramki nadal
porównują fingerprint z opublikowanym meshem.

Receipt świeżego przebiegu:

- mesh: 5156 węzłów, 27384 elementy Tet4, extent 200×200×400 nm;
- relaksacja z cache: `max_torque=9.9930e-7 T`, próg `1e-6 T`;
- target `nearest_frequency=2 GHz`, 8 żądanych i **8/8 zaakceptowanych** modów,
  zapisane pola 4 modów;
- najniższa częstotliwość `2.54879717697576 GHz`;
- residuale `7.890452463226588e-14` … `3.679449537027831e-12`;
- `full_residual_accepted_count=15`, `full_residual_rejected_count=15`,
  `refinement_succeeded_count=30`, `refinement_failed_count=0`;
- `solve_succeeded=true`, `status=ready`, `fallback_used=false`, lane
  `production_cpu`, `implementation_state=executable`,
  `source_mesh_topology_sha256=sha256:ba23915ec16796f7c55a84a6295384d3d1cbd442fa5beb54f596805912a8c8df`;
- `eigen/spectrum.v2.json`, `eigen/spectrum.v3.json`, `eigen/mode_fields.zarr`,
  `frequency_domain/manifest.v1.json` i `eigen/diagnostics/solver.v1.json`
  zostały opublikowane;
- `verify_fem_frequency_domain_eigen_artifacts.py` — **PASS**;
- `validate_fem_periodic_antidot_relax_eigenmodes_runtime.py` — **PASS**;
- czas z logu procesu: `real_seconds=138.277`, `user_seconds=188.093`,
  `system_seconds=110.671`.

To zamyka konkretną ścieżkę publikacji i nearest handoff R5/R6, ale zakres widma
pozostaje `spectrum_completeness=selected_only`, `window_complete=false`, a
`window_completeness.status=not_certified`. Nie jest to dowód R7/Q1 ani dowód
pełnego okna 0.5–30 GHz.

### 17.30. R7: telemetryka live dla okna frequency-domain

Źródłowy callback `fem_eigen_progress_update` został rozszerzony o pola
`current_subwindow`, `total_subwindows`, `subwindow_elapsed_seconds` i
`window_elapsed_seconds`, a parser native zachowuje fazę `base|refinement`.
CLI pokazuje teraz w linii terminala m.in.:
`modal window phase=refinement subwindow=17/34 subwindow_s=… window_s=… relres=…`.
Dodano test parsera native oraz test terminalnej linii i propagacji szczegółów do
stage execution. Zmiana nie zmienia harmonogramu ani kryteriów akceptacji; ma
jedynie uczynić postęp i zawieszenie solvera obserwowalnymi. Po przebudowie
managed runtime trzeba jeszcze zebrać terminalne logi tej telemetryki z pełnego
16+34 window; do tego czasu R7 pozostaje `PARTIAL` i `window_complete=true` nie
może być raportowane.

### 17.6. Aktualizacja źródłowa R5/R6 po audycie raportu

Natywny Schur/SLEPc diagnostics rozdziela teraz techniczny sukces wywołania od
zakresu spektrum. Dla `nearest_frequency` publikuje:

- `solve_succeeded=true` dopiero przy statusie `ok`;
- `fields_available=true` tylko przy co najmniej jednym zaakceptowanym modzie;
- stabilny `engine_id`:
  `native_fem.frequency_domain.k0_poisson_airbox_cpu_schur_slepc.v1`;
- `spectrum_completeness="selected_only"`;
- `window_complete=false` niezależnie od technicznego `complete=true`.

Skupiony natywny kontrakt nearest przeszedł. Fixture kontraktu został również
naprawiony tak, aby jawnie żądał `nearest_frequency`, zamiast odziedziczyć
`frequency_window` z helpera i generować mylący błąd kompletności. Pełny zestaw
CPU/SLEPc nadal zatrzymuje się na osobnym, rzeczywistym teście window z tym samym
komunikatem; R7 pozostaje zatem czerwone i nie jest maskowane przez naprawę
fixture nearest. Rust `fem::eigen_tests` pozostaje zielony: **133/133 PASS**.

### 17.7. Aktualizacja źródłowa R7: certyfikat pełnego okna

Dokładna diagnostyka czerwonej bramki wykazała, że oba przebiegi solvera były
numerycznie poprawne: 16/16 base i 34/34 refinement subwindowów zakończyło się,
znaleziono dwa oczekiwane mody 1 i 2 GHz, residual pełnego descriptora wynosił
około `1.34e-15`, a marginesy pokrycia obu krawędzi były dodatnie. Certyfikat był
odrzucany wyłącznie przez `frequency_window_schedule_summary_truncated`:
64-kilobajtowy bufor nie mieścił 50 wpisów z osadzoną klasyfikacją Ritz.

Wewnętrzny, nie-ABI rekord wyniku ma teraz 256 KiB na pełny
`executed_subwindows_json` i 512 KiB na diagnostics, który osadza ten dowód.
Fail-closed zachowanie pozostaje: każde rzeczywiste przepełnienie nadal ustawia
`diagnostics_truncated` i blokuje certyfikat. Po czystym rebuildzie przeszły:

- focused window suite: complete window, invariant subspace dla klastra
  zdegenerowanego, split klastra fail-closed, failure accounting i cancellation;
- focused nearest semantics;
- pełny kontrakt CPU/SLEPc z wyłączoną częścią GPU.

Przy pełnym przebiegu ujawniono także stary drift fixture GMRES: jego split
dimension wynosił 1028, podczas gdy aktualny exact-preconditioner cap to 8192.
Fixture ma teraz minimalny wymiar 8196 i ponownie rzeczywiście testuje skalowalną
ścieżkę GMRES. Jest to korekta testu do istniejącego kontraktu solvera, nie zmiana
cap ani poluzowanie bramki.

R7 pozostaje `PARTIAL`: powyższe dowodzi algorytmu i certyfikatu na kontrolowanym
spektrum, lecz realny periodic-antidot `frequency_window` oraz convergence
mesh/airbox nie zostały jeszcze wykonane na świeżym immutable source identity.

### 17.8. Windows-only rebuild po usunięciu niespójnego cache

Kanoniczny build wykonano wyłącznie z PowerShella i Docker Desktop, z
Windowsowego worktree
`C:\git\fullmag\worktrees\eigensolve-k0-finalization`. Nie użyto WSL ani
linuxowego checkoutu. Pierwszy świeży przebieg ujawnił, że zewnętrzny katalog
`C:\fullmag-build\cargo-targets\fem-cpu` zawierał niespójne metadane Cargo:
kompilator zgłaszał brak typów i metod, które były obecne w bieżących źródłach.
Po wyczyszczeniu wyłącznie tego odtwarzalnego targetu pełny runner, CLI, API i
Python core skompilowały się poprawnie.

Build ujawnił następnie niezależny błąd Windowsowego launchera. Funkcja
`Get-DockerImageId` odczytywała `$LASTEXITCODE` dopiero po potoku PowerShell,
przez co poprawne `docker image inspect` było klasyfikowane jako brak obrazu.
Exit code jest teraz przechwytywany bezpośrednio po wywołaniu Dockera, zanim
wynik trafi do `Select-Object`. Dowody:

- 23/23 testów `test_windows_fullmag_launcher_contract.py` — **PASS**;
- parser PowerShell dla `run_fullmag_docker.ps1` — **PASS**;
- pełny `BuildMode=true -BuildOnly -Backend fem -Device cpu` — **PASS**;
- runtime zapisany w `C:\fullmag-cache\state\fem-cpu`;
- obraz `fullmag/fem-cpu:windows-local`, ID
  `sha256:6ceeda1637917e5289b4f17a2277a6d9b8aff26ef6d6720c8bb76a745fcb7d83`.

Manifest tego przebiegu prawidłowo wskazuje dedykowany Windowsowy worktree.
Ponieważ poprawka launchera była jeszcze niezatwierdzona podczas tego builda,
manifest ma jawny `worktree_state=dirty`; po commicie wymagany jest krótki
recapture/rebuild tożsamości przed realnym przebiegiem R7.

### 17.9. Regresja stosu ujawniona przez realny frequency window

Po czystym buildzie Windows uruchomiono realny antydot `frequency_window`
0,5–30 GHz na tym samym cache equilibrium v2 i meshu 5156/27384. Pierwsza próba
na obrazie `fem-cpu:windows-local` została prawidłowo odrzucona jako
`slepc_not_available`; ten obraz pozostaje runtime'em FEM CPU time-domain, ale
nie jest runtime'em modalnym. Bieżący commit przebudowano następnie w obrazie
Docker Desktop `fullmag/fem-gpu:local`, używanym jako nośnik PETSc/SLEPc, z
wykonaniem modalnym nadal ustawionym na CPU.

Właściwy solve PETSc/SLEPc ujawnił `stack overflow` przed pierwszym subwindowem.
Przyczyną było zagnieżdżenie w produkcyjnym wątku Rust kilku lokalnych
`PoissonAirboxModalEigenResult` (każdy zawiera 256 KiB schedule i 512 KiB
diagnostics) oraz dodatkowego 256-KiB bufora schedule. Syntetyczny natywny test
uruchamiany z większego stosu procesu nie ujawniał tej regresji.

Naprawa zachowuje rozmiary i treść dowodu, ale przenosi poza stos:

- wynik modalny na granicy `modal_eigen_solver`;
- wynik każdego CPU subwindow;
- agregat pełnego okna;
- roboczy bufor `executed_subwindows_json`.

Focused native complete-window po zmianie — **PASS**. Realny Windows CPU window
musi zostać powtórzony po commicie i clean source recapture; do tego czasu R7
pozostaje `PARTIAL`.

### 17.10. Windows-only obserwowalność realnego CPU window

Powtórzony przebieg R7 uruchomiono z PowerShella w Windowsowym worktree
`C:\git\fullmag\worktrees\eigensolve-k0-finalization`, przez Docker Desktop,
bez `wsl.exe`, ścieżek `/home` lub `/mnt` i bez linuxowego checkoutu. Kandydat
źródłowy był czysty na commicie
`40540afdf0acbe3fbd1b8fcbd903071cae374c4d`; użyto cache equilibrium v2 dla tego
samego meshu 5156 węzłów / 27384 `tet4`, zakresu 0,5–30 GHz, 8 żądanych modów i
4 pól modów do zapisu. Obraz `fullmag/fem-gpu:local` służy wyłącznie jako nośnik
PETSc/SLEPc; resolved modal execution pozostaje CPU i kontener nie został
uruchomiony z dostępem do GPU.

W trakcie obserwacji proces był nadal aktywny po ponad 171 minutach. Bezpośredni
Windowsowy odczyt `docker stats` o 04:12 CEST wskazywał 195,77% CPU,
312,2 MiB pamięci i 106 procesów. `runtime.log` rósł i zawierał świeże wywołania
operatora (1 444 951 bajtów o 04:12 CEST), natomiast `time.txt`
pozostawał pusty, a z artefaktów
końcowych istniał wyłącznie wstępny `field-storage.v1.json`. Nie było awarii,
fallbacku ani terminalnego wyniku. Jest to **zweryfikowane oczekiwanie**, nie
dowód przejścia R7/Q1.

Produkcja nie publikuje numeru aktualnego podokna ani rozróżnienia faz base i
refinement. Dla porównania log ukończonego nearest zawierał 159 wywołań operatora,
a bieżący log pełnego okna 1585, lecz z tego stosunku nie wolno wyprowadzać procentu:
różne przesunięcia mają różną liczbę iteracji i koszt rozwiązań Poissona. Przed
zamknięciem R7 należy zatem dodać telemetrykę `current/total`, fazę harmonogramu,
czas per podokno i jawny budżet wydajności. Wynik oraz oba walidatory artefaktów
muszą zostać dopisane do tej sekcji dopiero po terminalnym zakończeniu tej samej
sesji; nie wolno zastępować jej nowym przebiegiem tylko dlatego, że jest długa.

### 17.11. R8: rozdzielone statusy i tożsamość artifact -> API -> UI

W Windowsowym worktree wdrożono brakujący kontrakt publikacji R8. Producent
`eigen/spectrum.v2.json`, `eigen/spectrum.v3.json`, metadanych modów i
`frequency_domain/manifest.v1.json` publikuje teraz bez inferencji:

- `engine_id`;
- `solve_succeeded`;
- `fields_available`;
- `spectrum_completeness`;
- `window_complete`;
- `candidate_identity` z `mesh_id`, rzeczywistym `mesh_generation_id`,
  `topology_fingerprint`, digestem equilibrium, engine, device i build/source
  identity.

Dla produkcyjnych adapterów K0 brak któregokolwiek wymaganego statusu,
equilibrium digestu, topology identity albo resolved device zatrzymuje publikację
fail-closed. Topologia diagnostics musi być identyczna z topologią publikowanego
meshu. `eigen/diagnostics/solver.v1.json` zachowuje teraz rzeczywiste natywne
diagnostyki zamiast zastępować je generycznym opisem. Metadane pola moda zawierają
`source_spectrum_revision`, czyli SHA-256 dokładnych bajtów `spectrum.v2`; rewizja
samego spektrum pozostaje w obudowie API, aby uniknąć kołowego hashowania pliku.

API rozszerza immutable resource envelope o rzeczywiste `session_id`, `run_id`,
`stage_id` i `mesh_generation_id`. Payloady manifest/spectrum v2/spectrum v3/mode
mają jawne typy statusów i `candidate_identity`, a kanoniczny OpenAPI został
wygenerowany na Windowsie. Domyślny stos binarium generatora okazał się za mały
(`STATUS_STACK_OVERFLOW`); ten sam generator przeszedł po zlinkowaniu tymczasowego
binarium z 16-MiB stosem. Typy wygenerowano dokładnym `openapi-typescript 7.13.0`
zgodnym z lockfile.

Wiązanie envelope z etapem jest fail-safe względem późniejszego aktywnego etapu:
API wybiera najpierw dokładny `artifact_ref`, następnie ostatni etap zgodnej
rodziny (`eigen` albo `frequency`), a dopiero przy braku obu dowodów używa etapu
aktywnego. Test regresyjny ustawia ukończony `flat_eigenmodes` oraz późniejszy
aktywny `relax` i potwierdza, że spectrum zachowuje `stage_id` oraz
`mesh_generation_id` etapu eigensolvera.

Control Room:

- nie klasyfikuje już każdego `status=ready` jako kompletnego spektrum;
- pokazuje osobno solve, dostępność pól, kompletność spektrum i certyfikat okna;
- pokazuje run/stage/artifact revision/mesh generation/device kandydata;
- klasyfikuje `selected_only` lub `window_complete=false` jako `partial`;
- nie nazywa wyniku qualified bez jawnego `validation_state`;
- wiąże revision cache również z run, stage i mesh generation, eliminując kolizję
  starego cache przy identycznym payloadzie w innym przebiegu.

Dowody źródłowe na bieżącym, jeszcze niezapisanym finalnym candidate:

- `cargo test -p fullmag-runner native_eigen_v2_ --lib` — **4/4 PASS**;
- `cargo test -p fullmag-api frequency_domain` — **50/50 PASS**;
- targetowane Vitest dla published-state i resource cache — **64/64 PASS**;
- ponowny targetowany published-state — **15/15 PASS**;
- `cargo test -p fullmag-api session_import` — **7/7 PASS**;
- targetowany solved FMS frequency-domain round-trip — **1/1 PASS**;
- `pnpm --dir apps/control-room typecheck` — **PASS**;
- `cargo fmt --all -- --check` i `git diff --check` — **PASS**.

Skrypt `typecheck-control-room.mjs` uruchamia teraz entrypointy Next i TypeScript
bezpośrednio przez bieżący `node.exe`, dzięki czemu Windows/Node 24 nie zatrzymuje
się na `spawnSync next.cmd EINVAL` i nie wymaga `shell: true`.

Test solved FMS zapisuje exact bytes spectrum, metadanych moda i binarnego pola,
usuwa pierwotny katalog historii, zeruje aktywny live state, importuje archiwum w
trybie `visualization_only`, po czym odczytuje spectrum przez publiczny endpoint.
Potwierdza zachowanie `candidate_identity`, `spectrum_completeness`,
`window_complete` i identycznego `content_digest`. Przy okazji ujawniono, że
ogólny terminal-session guard zasłaniał precyzyjny kod `imported_read_only`;
kolejność guardów została poprawiona, a import nadal odrzuca mutującą komendę
przed wpisaniem jej do ledgeru.

R8 pozostaje `PARTIAL`: testy dowodzą kontraktu źródłowego, FMS i UI, lecz nadal
nie ma finalnego clean-source runtime z tym kontraktem, rzeczywistego restartu
procesu API między exportem i importem ani 60-sekundowego live browser/WebGL proof
na artefaktach CPU Q1.

### 17.12. R9: Windows/Docker Desktop hardware contract i granica profilera

Pierwszy świeży etap R9 wykonano z PowerShella, bezpośrednio przez Docker Desktop,
na fizycznej karcie NVIDIA GeForce RTX 4080 SUPER (16 376 MiB, driver 591.86).
Źródłem był wyłącznie Windowsowy worktree
`C:\git\fullmag\worktrees\eigensolve-k0-finalization`; Linux występował tylko
wewnątrz kontenera `fullmag/fem-gpu:local` z CUDA 12.4.1. Nie użyto WSL ani
drugiego checkoutu.

Najpierw przeszedł podstawowy kontrakt runtime PETSc/SLEPc/HYPRE:

- `vec=seqcuda`;
- `mat=seqaijcusparse`;
- `pc=hypre`;
- basis SLEPc `seqcuda`;
- trzy zbieżne pary własne.

Pełny kontrakt `fem_gpu_k0_modal_petsc_slepc_contract` ujawnił dwa niezależne
problemy stosu. Produkcyjny solver trzymał duży aggregate, wynik każdego shiftu i
256-KiB harmonogram na stosie, a Release tworzył dodatkowe duże temporaries przy
dodawaniu kandydatów. Dane te przeniesiono do kontrolowanych alokacji heap:

- schedule jest teraz `std::vector<char>` o pojemności publicznego rekordu;
- wynik shiftu i aggregate są alokowane `nothrow` i zawodzą fail-closed;
- kandydat jest konstruowany in-place bez wielkiego braced temporary.

Osobno testowe `main()` trzymało równocześnie kilka rekordów wyniku po około
0,8 MiB. Negatywne przypadki walidacji używają teraz jednego resetowanego bufora,
a target testowy jest kompilowany bez agresywnego inline, które scalało duże
ramki funkcji pomocniczych. Nie zmieniono w tym celu limitu stosu kontenera.

Stary test `FrequencyWindowFailsClosedWhenGpuScheduleTruncates` był nieaktualny po
zwiększeniu pojemności pełnego harmonogramu. Jego wejście z 15 modami kończy się
obecnie prawidłowym certyfikatem: 15 zaakceptowanych modów, 50/50 podokien,
0 failures, dodatnie marginesy obu krawędzi i `window_complete`. Test zastąpiono
regresją wymagającą zachowania kompletnego high-occupancy schedule; produkcyjnego
solvera nie poluzowano ani nie zmuszono do fałszywej porażki.

Na standardowym stosie i realnym GPU przeszły:

- focused N3-W1, w tym complete window, degeneracy, split-cluster fail-closed,
  subwindow failure, cancellation i high-occupancy schedule;
- focused N3-W2, w tym persistent operator/solver graph, canonical invalidation,
  callback lifetime i fail-closed `EPSSolve`;
- teardown lifecycle: **50/50 accepted, 0 residual rejected, 0 unexpected**;
- KSP destroy ABI z `PETSC_OPTIONS=-malloc_debug`;
- domyślna pełna bramka binarium;
- CUDA Compute Sanitizer memcheck dla N3-W2: **0 errors**.

Nsight Systems 2024.1.1 zapisał Windowsowy artefakt:

`.fullmag/reports/fem-k0-gpu-contract/windows-rtx4080-super/fem-k0-n3-w2.nsys-rep`

Ślad potwierdza rzeczywiste użycie CUDA, między innymi 20 670 wywołań
`cudaLaunchKernel`, 20 `cudaLaunchCooperativeKernel` i 8 455
`cudaMemcpyAsync`. W środowisku Docker Desktop/WDDM raport nie zawiera jednak
rekordów `CUDA GPU Kernel` ani `GPU Memory`; sama liczba wywołań API nie dowodzi
braku transferów i synchronizacji w hot loop. Próba Nsight Compute połączyła się
z procesem, lecz została zatrzymana przez
`ERR_NVGPUCTRPERM` — liczniki wydajności GPU są wyłączone dla bieżącego konta.
Nie jest to zaliczone jako pełny profiler-backed Q2.

R9 awansuje z `NOT VERIFIED` do `PARTIAL`, ale Q2 pozostaje otwarte. Do jego
zamknięcia nadal potrzeba:

1. włączenia dostępu do liczników wydajności NVIDIA i zebrania kernel/memory
   trace albo równoważnego niezależnego dowodu residency;
2. produkcyjnego przypadku pośredniego oraz `operator_dimension > 1024`;
3. tego samego okresowego antydotu i tej samej siatki co CPU R7;
4. parity częstotliwości, pełnych residuali i podprzestrzeni klastrów;
5. repeatability, cancellation i peak-memory na przypadkach produkcyjnych.

Obecny hardware contract dowodzi, że adapter PETSc/SLEPc CUDA rzeczywiście działa
na karcie i nie ma błędów pamięci w badanym wariancie. Nie dowodzi jeszcze
produkcyjnej skalowalności ani pełnej rezydencji tego samego problemu warstwy z
dziurą, dlatego nie zmienia końcowego `NO-GO` dla R9/Q2 i R10/G2.

### 17.13. Telemetria base/refinement dla następnego przebiegu R7

Ograniczenie obserwowalności opisane w sekcji 17.10 zostało naprawione na poziomie
źródłowym dla CPU i GPU. Wewnętrzny problem modalny przenosi teraz przez zagnieżdżone
callbacki shift-invert:

- `window_phase=base|refinement`;
- one-based `current_subwindow` oraz globalne `total_subwindows=50`;
- czas bieżącego podokna i czas całego okna w sekundach.

Producent emituje osobne zdarzenie rozpoczęcia i zakończenia podokna. Trwały
`executed_subwindows_json` zapisuje również `elapsed_seconds` dla każdego shiftu.
Runner mapuje fazę na
`solving_native_frequency_window_base` albo
`solving_native_frequency_window_refinement`, a `iteration/max_iterations`
pokazuje globalne `current/total` zamiast lokalnej iteracji KSP. Procent jest
monotonicznie wyprowadzany z globalnej pozycji harmonogramu, nie z liczby wpisów
w logu operatora.

Dowody po zmianie:

- test parsera runnera dla `refinement`, `23/50` i jawnego czasu — **PASS**;
- pełny `cargo test -p fullmag-runner fem::eigen_tests --lib` — **135/135 PASS**;
- pełny natywny kontrakt CPU/SLEPc z `FULLMAG_SKIP_GPU_TESTS=1` — **PASS**;
- focused GPU N3-W1 z asercją `base 1/50`, `refinement 17/50` i niezerowego
  czasu zakończonego podokna — **PASS**.

Trwający realny CPU window na commicie `40540afdf` powstał przed tą zmianą i z
założenia nie może jej pokazywać. Nie został przerwany ani zastąpiony. Nowa
telemetria wymaga finalnego clean-source rebuild dopiero po zapisaniu wyniku tego
przebiegu; nie wolno przypisywać jej historycznemu runtime.

### 17.14. R8: live Windows API/Control Room i granica dowodu WebGL

Bieżący API uruchomiono bezpośrednio z Windowsowego worktree na
`http://127.0.0.1:8081`, a Control Room z lokalnych zależności projektu na
`http://127.0.0.1:3104`. Do aktywnej sesji zarejestrowano rzeczywisty artefakt
CPU nearest z `spectrum.v3`, czterema polami modów i manifestem
frequency-domain. Nie jest to finalny certyfikat pełnego okna R7/Q1 i nie wolno
go tak klasyfikować.

Live browser potwierdził:

- poprawny odczyt spektrum 8 modów w zakresie
  `2.54879717697576–10.722602066523397 GHz`;
- wybór punktu spektrum i Inspector dla moda 0 z częstotliwością
  `2.54879717697576 GHz` oraz residualem `7.890e-14`;
- odczyt rzeczywistego pola
  `analysis:eigen:sample-0000:mode-0000` przez endpoint
  `samples/vector?view=phase_rotated_real&phase_rad=0`;
- dostępność widoków `complex`, `real`, `imag`, `abs`, `amplitude`, `phase` i
  `phase_rotated_real` oraz przekazanie wybranego moda do kontrolek 3D.

Pierwsza próba selekcji ujawniła regresję Control Room: selektor route override
zwracał nowy obiekt przy każdym odczycie `useSyncExternalStore`, co powodowało
`Maximum update depth exceeded`. Zastąpiono świeże literały stabilnymi stałymi
route. Po poprawce:

- targetowane Vitest — **51/51 PASS**;
- TypeScript `--noEmit` — **PASS**;
- ponowny live wybór moda — **PASS**, bez error boundary i bez pętli renderu.

Pełny gate WebGL pozostaje otwarty. Pierwsza próba po wybraniu moda 0 zachowała
poprawny field ID i URL zasobu, lecz raportowała `field:none`, `surface:idle` oraz
`Mesh not built`. Kanoniczna topologia użyta przez ten sam solve nie zaginęła:
znajduje się w Windowsowym cache równowagi i zawiera 5156 węzłów oraz 27 384
elementy. Opublikowano ją do tej samej sesji z oryginalnym
`mesh_generation_id=07b26a12407e6c17a7db9f5de02ee6d2d75e69892f1e498a731b7d923763406f`
i fingerprintem
`sha256:ba23915ec16796f7c55a84a6295384d3d1cbd442fa5beb54f596805912a8c8df`.
Control Room przeszedł do `mesh-ready study_domain`, a
worker WebGL zbudował indeks topologii.

Następna próba zatrzymała się na właściwej bramce fail-closed właściciela pola.
Viewport raportuje opublikowaną topologię, ale `field:none`, a Explorer jawnie
wyświetla `Active analysis overlay artifact revision is missing`. Historyczny
artefakt nearest ma prawdziwy payload pola i zgodny mesh generation ID, lecz nie
ma pełnej tożsamości nowego kontraktu: artifact revision, equilibrium identity,
run/stage owner, study product i kontekst k. Dlatego nie wolno go po cichu
przypisać do bieżącego candidate ani użyć do 60-sekundowego smoke WebGL. Jest to
poprawne odrzucenie niepełnego provenance, nie awaria meshu lub WebGL.

Skorygowany następny krok R8 jest jednoznaczny: po terminalnym R7 uruchomić API z
finalnym candidate i opublikować w tej samej sesji istniejącą rzeczywistą
topologię FEM oraz kompletną artifact/owner identity z producenta, wykonać
`export -> zatrzymanie procesu -> nowy proces -> import`, a następnie powtórzyć
wybór moda i 60-sekundowy WebGL smoke. Spectrum, pole, mesh i viewport muszą
wskazywać ten sam immutable candidate. Do tego czasu R8 wynosi **70%** i
pozostaje `PARTIAL`.

### 17.15. R7: potwierdzony wielogodzinny koszt pełnego okna

Przebieg R7 na commicie `40540afdf` pozostaje aktywny i nie został zrestartowany.
O 11:10 CEST proces miał około 32 590 s czasu życia, używał około 212% CPU, a
kontener 213,86% CPU i 311 MiB RAM. `runtime.log` miał 6,90 MB i był nadal
aktualizowany; proces wykonywał kolejne wywołania operatora w etapie
`flat_eigenmodes`. Jest to dowód żywego solve, ale nie dowód postępu kompletności
okna, ponieważ runtime powstał przed telemetrią `base/refinement current/total`.

Ponad dziewięć godzin dla meshu 5156 węzłów jest osobnym wynikiem audytu
wydajnościowego. Nawet jeśli przebieg zakończy się poprawnym certyfikatem, nie
można automatycznie uznać czasu za akceptowalny produkcyjnie. Po jego terminalnym
wyniku należy zachować log i czasy per subwindow, a na finalnym źródle wykonać
krótszy probe z nową telemetrią, aby rozdzielić koszt base, refinement,
shift-invert/KSP i nadmiarowych operator probes. Nie wolno zatrzymywać obecnego
przebiegu tylko na podstawie długiego czasu, ponieważ nadal zużywa CPU i zapisuje
nowe wyniki pośrednie.

### 17.16. R8: naprawa transportu tożsamości moda i kontraktu manifestu

Live próba z sekcji 17.14 ujawniła drugi, niezależny od historycznego artefaktu
defekt: nawet manifest zawierający komplet owner identity nie mógł otworzyć
warstwy 3D, ponieważ mapowanie klikniętego punktu wykresu odrzucało `run_id`,
`stage_id`, rewizję artefaktu, equilibrium identity, kontekst k oraz stabilne
`mode_id` i `sample_id`. `ModeFieldOverlayIntent` słusznie odrzucał taką selekcję.

W Windowsowym worktree naprawiono cały transport:

- parser `spectrum.v2/v3` zachowuje nadrzędny `sample_id` oraz `mode_id`;
- selekcja moda przenosi run/stage, rewizję, equilibrium, częstotliwość,
  `mode_id`, `sample_id`, `study_product`, reprezentację complex-vector-xyz,
  źródło eigen-mode i wektor Γ `[0,0,0]`;
- analogiczna selekcja response przenosi owner identity i źródło
  frequency-response;
- hook bierze run/stage i mesh generation z autorytatywnej koperty zasobu API,
  bez przepisywania historycznych plików;
- producent nowego manifestu publikuje `equilibrium_identity`, `mesh_identity`,
  jawny `boundary_context` oraz typowane `k_sampling`.

Dowody po zmianie:

- targetowane Control Room Vitest — **112/112 PASS**;
- dodatkowy focused zestaw po spięciu koperty API — **52/52 PASS**;
- pełny TypeScript `tsc --noEmit` — **PASS**;
- focused natywny Windows Rust test producenta manifestu
  `native_eigen_v2_mode_metadata_preserves_operator_provenance` — **PASS**;
- pełny `cargo test -p fullmag-runner fem::eigen_tests --lib` — **135/135 PASS**;
- `cargo test -p fullmag-api frequency_domain` — **49/49 PASS**;
- `cargo test -p fullmag-api session_import` — **7/7 PASS**;
- `git diff --check` — **PASS**; ostrzeżenia dotyczą jedynie oczekiwanej polityki
  LF/CRLF Windows.

Nie podnosi to historycznego nearest artefaktu do rangi finalnego dowodu:
brakuje mu jawnego boundary/k contract i nie wolno go modyfikować po fakcie.
R8 wzrasta do **70%**, ale terminalny PASS wymaga świeżego finalnego candidate,
restart/import FMS i 60-sekundowego browser/WebGL smoke ze spectrum, polem,
meshem i viewportem związanymi z tą samą immutable revision.

### 17.17. R8: rzeczywisty restart Windows API i odzyskanie mesh owner identity

Kontrolowany restart procesu API wykonano natywnie w Windowsie. Zatrzymano
wyłącznie dokładnie zidentyfikowany proces `target\\debug\\fullmag-api.exe`,
uruchomiono nowy proces przez Windows Cargo, a następnie odtworzono sesję z
niezmienionego historycznego artefaktu nearest oraz kanonicznego
`domain_mesh.json`. Nie użyto WSL, linuksowego host checkoutu ani ścieżek
`/home/...` lub `/mnt/c/...`; Linux występuje wyłącznie wewnątrz kontenera
Docker Desktop uruchamiającego długą kwalifikację R7.

Restart ujawnił brak w kopercie zasobu API: kiedy nie istnieje aktywny stage ani
`live_state.latest_step`, funkcja `frequency_domain_live_artifact_identity()`
nie pobierała `mesh_generation_id` z top-level `snapshot.fem_mesh`. Dodano ten
autorytatywny fallback oraz test negatywnie rozdzielający źródła identity:

- brak stage execution;
- brak `live_state`;
- obecny wyłącznie top-level `fem_mesh.generation_id`;
- zasób artifact musi zwrócić dokładnie tę generację meshu i `stage_id=null`.

Po poprawce i ponownym uruchomieniu live endpoint opublikował rzeczywisty
`mesh_generation_id=07b26a12407e6c17a7db9f5de02ee6d2d75e69892f1e498a731b7d923763406f`,
`run_id=run-session-1788039517886-10` oraz niezmieniony historyczny spectrum.
Control Room pokazał zgodny mesh owner envelope. `stage_id`, boundary context i
k pozostają jawnie niedostępne, ponieważ historyczny artefakt ich nie zawiera;
system nie fabricuje tych pól i nadal odrzuca pełny overlay fail-closed.

Dowody:

- focused test `frequency_domain_artifact_identity_uses_top_level_fem_mesh_generation`
  — **1/1 PASS**;
- pełny `cargo test -p fullmag-api frequency_domain` po dodaniu regresji —
  **50/50 PASS**;
- nowy Windows API działa na `http://127.0.0.1:8081`, a Control Room na
  `http://127.0.0.1:3104`;
- długi R7 nadal działa w tym samym kontenerze Docker Desktop i nie został
  przerwany ani zrestartowany.

Jest to rzeczywisty dowód restartu procesu i poprawnego odzyskania mesh identity,
ale nie pełny FMS export/import gate finalnego candidate. Ocena R8 pozostaje
konserwatywnie **70%**: do terminalnego PASS nadal potrzeba artefaktu z nowego
producenta, autorytatywnego run/stage/boundary/k oraz 60-sekundowego WebGL smoke
na tej samej immutable revision.

### 17.18. R9: właściwy Windows GPU runtime i bramka skali większej niż 1024 DOF

Próba rozszerzenia R9 ujawniła, że lokalny obraz
`fullmag/fem-gpu:local` nie jest właściwym runtime kwalifikacyjnym dla Windows:
zawiera systemowy PETSc 3.15 z HYPRE, ale bez `PETSC_HAVE_CUDA`. Źródło i pełna
biblioteka `libfullmag_fem.so` kompilowały się w tym obrazie po poprawkach
zgodności, natomiast test kończył się przed alokacją stabilnym powodem
`petsc_cuda_hypre_unavailable`. Jest to poprawne odrzucenie niezdolnego runtime,
nie błąd solvera i nie dowód Q2.

Wspólny kod CPU/GPU dostosowano do rzeczywistego zakresu wersji PETSc używanego
przez managed lanes:

- PETSc 3.15 otrzymuje zgodne definicje brakujących makr błędów;
- callback niszczący kontekst KSP używa dokładnego ABI `void *` przed PETSc
  3.24 oraz `void **` od PETSc 3.24;
- `petscdevice.h` i `PetscDeviceInitialize()` są używane wyłącznie w wersjach,
  które je udostępniają;
- ręczne ścieżki cleanup wywołują wspólny helper niszczący wartość kontekstu.

Dodano oddzielną bramkę
`verify-fem-frequency-domain-eigen-k0-gpu-adapter-scale-contract`. Używa ona
rzadkiego algebraicznego operatora o `q_dof_count=1026` i
`augmented_dof_count=1027`, wymusza scalable matrix-free Schur CUDA oraz odrzuca
fallback i raportowany hot-loop traffic. Recepta i komentarze jawnie klasyfikują
ją jako dowód D2 adapter-scale: nie jest to fizyczny mesh MFEM, profiler ani
substytut rzeczywistego antydotu R9/Q2.

Właściwy obraz `fullmag/fem-gpu:windows-local` został zbudowany przez natywny
PowerShell launcher i Docker Desktop z `docker/fem-gpu/Dockerfile`, który pinuje
PETSc 3.24.6 i SLEPc 3.24.3 oraz buduje HYPRE z CUDA. Inspekcja BuildKit
potwierdziła kompilację HYPRE przez `nvcc` dla architektur 60, 70, 80, 89 i 90;
świeży image ID to
`sha256:244c294411e910a364b48e99666f34e5216c4d779aac81f0caf70e44e7287c9f`.
Pierwotny manifest tego przebiegu wiązał `git_commit=40540afdf0acbe3fbd1b8fcbd903071cae374c4d`
z `source_snapshot_sha256=847ddea80cf456a50595b63e4c22f09fee31555432428bd94263980365385193`,
`binary_sha256=bd6df3635c763099cb7e55cbff995591fe2810f59bda24f59ba184257da1e08a`
i `api_binary_sha256=f881ec5fc8bf6cfad2f4033e5351267b61d9a18a982d1521cfa513ebc70f6919`.
Po poprawce polityki urządzenia (dołączenie konfiguracji MFEM/HYPRE i
`mfem::Hypre::InitDevice()` przed setterami) właściwy test adapter-scale
przechodzi terminalnie: `q=1026`, `augmented=1027`, `accepted=1`,
`frequency_hz=3559999999.8517327`, `full_residual=4.5804911134016216e-08` i
`operator_applies=45748`, przy braku fallbacku. Osobny teardown uruchomiony na
50 celach kończy się `accepted=50`, `residual_rejected=0`,
`unexpected=0`, `finalizer_status=0`; test ABI callbacku KSP z
`PETSC_OPTIONS=-malloc_debug` również przechodzi. Są to świeże dowody D2
adapter-scale i lifecycle, a nie jeszcze Q2.

Stabilność solvera nie jest jednak zamknięta dla wszystkich shiftów. Na tym
samym syntetycznym operatorze target exact `2.0 GHz` oraz near-shift
`2.0025 GHz` kończą się po 1024 iteracjach `DIVERGED_ITS`; adapter-scale PASS
dotyczy bezpiecznego targetu `5.0 GHz` i nie dowodzi odporności produkcyjnego
nearest. Równolegle uruchomiono rzeczywisty Windows/Docker Desktop przebieg
GPU przykładu z okresową geometrią body+airbox (`100` węzłów, `290` Tet4,
`216` boundary faces). GPU i relaksacja (`3` kroki, max torque około
`5.3e-17 T`) przeszły. Po długim przebiegu modalnym runner odrzucił wynik jako
`k0_poisson_airbox_gpu_attestation_unavailable`; proces zakończył się dodatkowo
`double free or corruption (fasttop)` podczas `PetscFinalize`/`SlepcFinalize`.
Nie powstał terminalny spectrum/mode artifact. Ten przebieg jest więc świeżym
dowodem wejścia w fizyczny GPU mesh, ale terminalnie **FAILED/NOT VERIFIED** dla
Q2 i potwierdza, że problem exact/near-shift oraz bezpiecznego teardownu nie jest
jeszcze rozwiązany.

Do zamknięcia R9/Q2 pozostają:

1. terminalny realny nearest na tym samym okresowym antydocie i meshu co CPU;
2. profiler kerneli i transferów oraz parity CPU--GPU;
3. repeatability, cancellation, peak-memory i pełny window/convergence;
4. osobne potwierdzenie ścieżki wielofazowego Poissona/HYPRE na fizycznym meshu.

Cała operacja odbywa się w Windowsowym worktree. Nie uruchomiono WSL ani
checkoutu ze ścieżkami `/home` lub `/mnt/c`; powłoka linuksowa występuje tylko
wewnątrz obrazu uruchamianego przez Docker Desktop.

### 17.19. R3--R6: kanoniczna recepta kontraktowa przeniesiona na Windows

Poprzednia recepta `verify-fem-frequency-domain-native-contract` była nadal
zależna od `just ensure-managed-fem-runtime` i ścieżki WSL
`/mnt/fullmag-zfn2-native`. Zastąpiono ją jawnym skryptem
`scripts/windows/verify_fem_frequency_domain_native_contract.ps1`. Skrypt ustawia
zewnętrzne Windowsowe katalogi `C:\fullmag-cache`, `C:\fullmag-build` i
`C:\fullmag-tmp`, pobiera bieżący source identity i uruchamia compose
`fullmag-windows-fem-gpu` bez linuksowego host checkoutu.

Kanoniczne wywołanie:

```text
just verify-fem-frequency-domain-native-contract
```

Weryfikacja terminalna z 2026-08-30 przeszła **12/12** celów native:
`fem_frequency_domain_contract`, `fem_frequency_domain_checked_extent_contract`,
`fem_poisson_airbox_shared_domain_contract`,
`fem_mesh_symmetry_certificate_v6_contract`, `fem_mode_kinematics_contract`,
`fem_linearized_dynamic_pencil_contract`, `fem_operator_contract`,
`fem_modal_eigen_contract`, `fem_driven_response_contract`,
`fem_window_partition_contract`, `fem_mode_deduplication_contract` oraz
`fem_contour_interval_solver_contract`. Wspólna biblioteka i wszystkie binaria
zostały zbudowane przeciwko PETSc `3.24.6`, SLEPc `3.24.3`, CUDA `12.6.85` i
HYPRE CUDA; końcowy komunikat to `Windows FEM gpu native frequency-domain
contract suite passed`.

Dowód jest związany z bieżącym worktree
`C:\git\fullmag\worktrees\eigensolve-k0-finalization`, zewnętrznym build root
`C:\fullmag-build\native-contract\gpu` oraz source snapshot
`dd1faa7f70ad52c74f6752ef2e706ced982d1896a38655bd7c90b41889b7c085`.
Ten hash różni się od wcześniejszego manifestu `847ddea8...`, ponieważ manifest
powstał przed dodaniem i korektą windowsowego skryptu kontraktowego; nie należy
mieszać tych dwóch identity. Zaktualizowany dowód zamyka operacyjną zależność od WSL dla
kontraktów R3--R6, ale nie podnosi go do Q2: nie jest to realny pełny antydot GPU,
profiler/Nsight, parity CPU--GPU ani terminalny immutable candidate.

Ta sama recepta została sprawdzona także jawnie dla Windowsowego obrazu CPU:
`pwsh scripts/windows/verify_fem_frequency_domain_native_contract.ps1 -Device cpu`
przeszła terminalnie **10/10** celów w
`C:\fullmag-build\native-contract\cpu`, z tym samym source snapshot
`dd1faa7f70ad52c74f6752ef2e706ced982d1896a38655bd7c90b41889b7c085`.
Obraz CPU celowo nie zawiera PETSc/SLEPc, dlatego dwa zależne od tej opcjonalnej
warstwy cele (`fem_frequency_domain_contract` i `fem_modal_eigen_contract`) nie
wchodzą do listy CPU; ich odpowiedniki są wykonywane na ścieżce GPU/PETSc. Jest to
jawne rozdzielenie zakresu runtime, a nie ukryte pominięcie nieudanego testu.

Po tym dowodzie wykonano inkrementalny `BuildMode=true -BuildOnly` przez ten sam
Windowsowy launcher. Aktualny manifest
`C:\fullmag-cache\state\fem-gpu\windows-fem-gpu-manifest.json` wiąże ten sam
commit z `source_snapshot_sha256=dd1faa7f70ad52c74f6752ef2e706ced982d1896a38655bd7c90b41889b7c085`,
`binary_sha256=bd6df3635c763099cb7e55cbff995591fe2810f59bda24f59ba184257da1e08a`
oraz `api_binary_sha256=3fa1e65eb53289ee2caddf0a0cfc2cd88c5d5b0db0b1818e30f76d2b8d6990bf`;
obraz pozostał tym samym immutable ID. Ten manifest jest aktualny dla następnych
runów. Dodatkowa walidacja `BuildMode=false -BuildOnly` przeszła fail-closed na
tym manifeście. `worktree_state=dirty` nadal oznacza, że nie jest to candidate R10.

### 17.20. R7: terminalny wynik pełnego CPU window

Kanoniczny przebieg uruchomiony z tego worktree w raporcie
`C:\git\fullmag\worktrees\eigensolve-k0-finalization\.fullmag\reports\fem-periodic-antidot-relax-eigenmodes\windows-cpu-window-40540afdf-cache-mfem-slepc`
został zakończony przez segfault po `real_seconds=66173.943`,
`user_seconds=86017.355` i `system_seconds=43632.846`. Log zatrzymał się w
`stage 2/2 (flat_eigenmodes)` podczas powtarzanych kroków `0/1`; nie powstały
`spectrum`, `mode_fields`, `eigen_summary`, manifest terminalny ani log
walidatora. Początkowa tożsamość procesu była starsza niż obecny snapshot:
commit `40540afdf`, `source_snapshot_sha256=a9f9cb670dfc39cb305c6f1cb64800f8cbfcec6db8879ec7db79b119de56eba3`.
Nie wolno więc przypisywać tego segfaultu bezpośrednio bieżącym zmianom ani
uznawać przebiegu za Q1.

Po zakończeniu tego kontenera Docker Desktop pozostały inne kontenery CPU, ale
ich mount wskazuje `C:\git\fullmag\fullmag`, czyli główny checkout, a nie
dedykowany worktree `C:\git\fullmag\worktrees\eigensolve-k0-finalization`.
Ich logi nie są dowodem dla tego audytu. R7/Q1 pozostaje **55%** i `PARTIAL`.
Następny przebieg musi zostać zbudowany oraz uruchomiony z aktualnego worktree,
z zachowaniem pełnego okna 16+34 podokien i z diagnostyką przyczyny awarii;
nie wolno maskować awarii przez zmniejszenie okna ani przez CPU fallback.

### 17.21. R7: ograniczenie presji pamięci w akumulacji kandydatów CPU

Przed kolejnym przebiegiem usunięto konkretną, potwierdzoną statycznie przyczynę
niepotrzebnego wzrostu pamięci w `backends/fem/cpu/frequency_domain/`
`poisson_airbox_schur_matshell.cpp`. `WindowCandidate` nie kopiuje już całego
`PoissonAirboxModalEigenResult` dla każdego zaakceptowanego moda. Zamiast tego
solver utrzymuje jeden heap-owned template wyniku i przechowuje w kandydacie
wyłącznie zaakceptowany mod oraz `pass_index`; harmonogram pełnego okna pozostaje
bez zmian (16 base + 34 refinement), podobnie jak warunki certyfikatu i deduplikacji.
To ogranicza kopiowanie dużych buforów diagnostycznych bez zmiany semantyki
akceptacji.

Poprawka przeszła zarządzaną, Windowsową receptę natywnego kontraktu CPU:
**10/10 PASS**, build root `C:\fullmag-build\native-contract\cpu`, source snapshot
`096a49ca56971568689cca9eb0d48418cb91113d9d0bf0abacaa952d439e9926`. Ten wynik
jest dowodem kompilacji i kontraktów, ale nie zastępuje terminalnego Q1. Pełny
przebieg 16+34 z aktualnej tożsamości worktree musi zostać wykonany ponownie;
do czasu jego zakończenia R7 pozostaje `PARTIAL`, a `window_complete=true` nie
może być raportowane.

### 17.22. Ponowny przebieg Q1 z aktualnego Windows worktree

Po przebudowie manifestu GPU do snapshotu `096a49ca...` uruchomiono pełny
przebieg CPU przez Docker Desktop z hostowym raportem
`C:\git\fullmag\worktrees\eigensolve-k0-finalization\.fullmag\reports\fem-periodic-antidot-relax-eigenmodes\windows-cpu-window-memoryfix-096a-rerun`.
Kontener używa obrazu z PETSc/SLEPc, ale jawnie ma
`FULLMAG_FEM_EXECUTION=cpu`, `FULLMAG_FEM_MFEM_DEVICE=cpu`,
`FULLMAG_FEM_REQUIRE_GPU=0` i `FULLMAG_FEM_REQUIRE_CEED=0`; nie jest to GPU
fallback. Mesh jest ten sam: 5156 węzłów, 27384 elementy, 200×200×400 nm.

Świeży przebieg przeszedł relaksację do `max_torque_apm=7.9521e-1` przy progu
`7.9577e-1` po 3135 krokach i wszedł do etapu `flat_eigenmodes`. W czasie
obserwacji etap modalny wykonywał obliczenia na około 212% CPU przy stabilnym
zużyciu pamięci około 425 MiB; nie ma jeszcze terminalnego podokna ani artefaktu
końcowego. Jest to dowód postępu i braku natychmiastowego wzrostu pamięci, nie
jest to jeszcze Q1 receipt. R7 pozostaje `PARTIAL` do czasu zakończenia pełnego
16+34, walidatora i terminalnego manifestu.

### 17.23. Bieżąca obserwacja i niezależny check UI

Kolejne pollowanie tego samego kontenera nie wykazało wyjścia procesu ani błędu:
raport nadal zapisuje etap `flat_eigenmodes`, `time.txt` pozostaje nieterminalny,
a katalog `artifacts` nie zawiera jeszcze spectrum, mode fields ani manifestu
window. Nie uruchomiono drugiego solvera. Niezależnie wykonany w tym samym
Windows worktree `pnpm --dir apps/control-room typecheck` zakończył się kodem 0
(generowanie route types PASS), a `git diff --check` nie wykazał błędów. Te dwa
wyniki wzmacniają R7/R8 na poziomie kontraktu źródeł, ale nie zmieniają bramy
Q1: pełne okno 16+34 i terminalne artefakty pozostają `NOT VERIFIED`.

### 17.24. Korekta jednostek częstotliwości w Results

Test adaptora ujawnił, że `buildEigenSpectrumChartModel` publikował częstotliwość
zawsze w Hz, mimo że response i dispersion wybierały skalę Hz/MHz/GHz. Poprawiono
model tak, aby wybierał wspólną skalę na podstawie wszystkich punktów widma,
przeliczał wartości osi Y przez właściwy dzielnik i publikował odpowiadające
`unit`. Przypadek 750 MHz zwraca teraz `unit=MHz` oraz `y=750`, a przypadki
GHz zachowują skalę GHz. Testy `frequencyDomainChartModels` i
`frequencyDomainSeriesAdapter` przeszły łącznie **50/50**. Zmiana dotyczy
kontraktu prezentacji i nie jest dowodem terminalnego solve Q1.

### 17.25. Dodatkowy check UI po korekcie authoringu eigenmodes

Po korekcie widoku setup w `StudyStageDraftEditor.tsx` pola magnetostatycznego
warunku brzegowego oraz próbkowania `k` są dostępne również dla draftu
`eigenmodes`; wcześniej inspektor ukrywał te kontrolki mimo obecności ich
kontraktu w modelu. Ukierunkowany `StageInspectors.test.tsx` zakończył się
terminalnie **74/74 PASS**. Wraz z wcześniejszymi **50/50 PASS** dla modeli
częstotliwości daje to świeży dowód źródłowego kontraktu UI, ale nie zmienia
statusu Q1/Q2: pełny solver nadal nie ma terminalnego receipt, a screenshot/
WebGL R8 i immutable candidate R10 pozostają niewykonane.

### 17.26. R7: usunięcie dużych tymczasowych wyników ze stosu i świeży rerun

Analiza powtarzalnego segfaultu wykazała, że `PoissonAirboxModalEigenResult`
zawiera stałe bufory JSON rzędu setek KiB. Rekurencyjne wejście w każde podokno
frequency-window wykonywało wcześniej reset przez `PoissonAirboxModalEigenResult{}`
oraz tworzyło taki obiekt w wyrażeniu warunkowym agregacji. Zastąpiono to
destrukcją i placement-new już skonstruowanego obiektu wynikowego oraz heap-owned
agregacją; certyfikat sparse-reference również używa teraz storage na stercie.
Semantyka harmonogramu 16+34, deduplikacji i bramek akceptacji nie została
zmniejszona ani wyłączona.

Po tej zmianie wykonano `BuildMode=true -Device gpu -BuildOnly` z aktualnego
Windows worktree. Manifest związał obraz
`fullmag/fem-gpu:windows-local` (`sha256:244c294411e910a364b48e99666f34e5216c4d779aac81f0caf70e44e7287c9f`)
ze snapshotem `e848de8307a56e83e15fad91e0abc9a7016a6bdecf5f4ba0227c2290de6c5210`.
Nowy kanoniczny CPU rerun używa raportu
`C:\fullmag-cache\state\fem-gpu\reports\fem-periodic-antidot-relax-eigenmodes\windows-cpu-window-placement-e848-rerun-3`;
jest to ścieżka stanu zamontowana przez Windowsowy compose, nie checkout WSL.
Mesh ponownie ma 5156 węzłów i 27384 elementy, a relaksacja zakończyła się
`max_torque=9.9930e-7 T` przy progu `1e-6 T`. Proces przeszedł do
`flat_eigenmodes`, przekroczył poprzedni punkt segfaultu bez wzrostu pamięci
(około 437 MiB, około 214% CPU) i w chwili aktualizacji nadal wykonywał solver.

Jest to dowód skutecznego usunięcia natychmiastowej presji stosu, ale nie dowód
terminalny: `time.txt`, spectrum, mode fields, window certificate i walidatory
pozostają nieukończone. R7/Q1 pozostaje `PARTIAL` (**55%**) do zakończenia całego
16+34, terminalnego manifestu i walidacji. Podczas przygotowania rerunu zatrzymano
wyłącznie zidentyfikowany stary duplikat kontenera tego samego worktree; jego raport
zachowano. Żaden kontener głównego checkoutu ani WSL nie był używany.

### 17.27. R9: ograniczenie pamięci kandydatów GPU i recapture kontraktu

W `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` usunięto z
`WindowCandidate` kopiowanie pełnego `PoissonAirboxModalEigenResult` (około
800 KiB na kandydata). Selekcja przechowuje teraz wyłącznie zaakceptowany mod i
`pass_index`, a jeden heap-owned rekord służy jako template metadanych agregatu.
Reset wyniku na wejściu GPU został dodatkowo zastąpiony placement-new, aby nie
materializować dużego tymczasowego obiektu na stosie. Harmonogram 16+34,
deduplikacja, cluster/invariant-subspace checks i fail-closed certyfikatu
pozostają bez zmian.

Poprawka została skompilowana w Windowsowym managed buildzie (`BuildMode=true`,
`Device=gpu`, `BuildOnly`). Następnie świeży natywny kontrakt GPU przeszedł
**12/12 PASS** z build root
`C:\fullmag-build\native-contract\gpu` i snapshotem
`6b86ca072bb00cfd4a75c80288644ac2f62d62bdc92e8d74fcb200bc1bd2ad50`.
To jest terminalny dowód kompilacji i kontraktu sprzętowego, ale nie Q2: nadal
brakuje realnego antydotu GPU, profiler receipt, parity CPU/GPU oraz
exact/near-shift resilience. Bieżący długi CPU rerun został uruchomiony przed
tym GPU recapture i pozostaje przypisany do wcześniejszego snapshotu `e848...`;
nie wolno mieszać tych tożsamości w jednym receipt.

### 17.28. Recapture R6/R7 kontraktu CPU po zmianie snapshotu

Po zmianie GPU source snapshotu wykonano również świeży Windows-only native
contract dla CPU. Zestaw `verify_fem_frequency_domain_native_contract.ps1
-Device cpu` zakończył się terminalnie **10/10 PASS** z build root
`C:\fullmag-build\native-contract\cpu` i snapshotem
`6b86ca072bb00cfd4a75c80288644ac2f62d62bdc92e8d74fcb200bc1bd2ad50`.
Potwierdza to, że bieżąca poprawka jest kompilowalna w obu wariantach managed
runtime. Nie podnosi jeszcze R7 do Q1: długi realny CPU window uruchomiony przed
recapture nadal ma tożsamość `e848...`, a terminalny pełny solve, walidatory i
convergence muszą być wykonane na jednym finalnym snapshotcie.

### 17.31. Recapture kontraktów CPU/GPU i managed manifestu po telemetry fix

Po dodaniu telemetrii podokien frequency-window oraz testów propagacji do CLI
odświeżono oba kontrakty z bieżącego Windows worktree. GPU przeszedł terminalnie
**12/12 PASS**, a CPU **10/10 PASS**, oba z jednym source snapshotem
`25c8c62da7ef3017ed081be52280c71f8d6c10041cb3445054f575fc2622fcd1` i z tym
samym commit `40540afdf0acbe3fbd1b8fcbd903071cae374c4d`. Dowód powstał przez
`scripts/windows/verify_fem_frequency_domain_native_contract.ps1` z build roots
`C:\fullmag-build\native-contract\gpu` oraz `C:\fullmag-build\native-contract\cpu`.

Następnie wykonano inkrementalny `BuildMode=true -Device gpu -BuildOnly` przez
Windowsowy launcher. Manifest
`C:\fullmag-cache\state\fem-gpu\windows-fem-gpu-manifest.json` jest teraz
zgodny z tym snapshotem i wiąże obraz
`fullmag/fem-gpu:windows-local` (`sha256:244c294411e910a364b48e99666f34e5216c4d779aac81f0caf70e44e7287c9f`),
`binary_sha256=bd6df3635c763099cb7e55cbff995591fe2810f59bda24f59ba184257da1e08a`
oraz `api_binary_sha256=2d454368a79726e74ce3c17f68cbe106847c5e70b8bce860ca66f8a1175363dc`.
`worktree_state=dirty` pozostaje prawidłowe dla bieżącego audytu, ale wyklucza
R10.

### 17.32. R7 telemetry: testy źródłowe i granica dowodu runtime

Telemetria frequency-window jest teraz zachowywana od natywnego eventu przez
runner do CLI: `window_phase`, `current_subwindow`, `total_subwindows`,
`subwindow_elapsed_seconds` i `window_elapsed_seconds`. W managed Windows
runtime przeszły terminalnie ukierunkowane testy:

- `fullmag-runner` parser telemetry: **1/1 PASS**;
- `fullmag-cli` formatowanie linii terminalnej: **1/1 PASS**;
- `fullmag-cli` propagacja live-step do aktywnego stage: **1/1 PASS**.

Testy potwierdzają kontrakt i prezentację postępu, ale nie tworzą dowodu Q1.
Nie ma jeszcze terminalnego pełnego okna 0.5--30 GHz z harmonogramem **16 base
+ 34 refinement**, pełnego `window_complete=true`, terminalnego manifestu,
walidatora i convergence na jednym aktualnym snapshotcie. R7 pozostaje zatem
`PARTIAL` (**55%**); starsze długie przebiegi z `e848...`/`096a...` nie mogą
być łączone z bieżącym manifestem `25c8...`.

### 17.33. R7: korekta lokalnego NEV i certyfikacji pokrycia podokna

W bieżącym Windows worktree skorygowano logikę frequency-window w
`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`.
`base_window_requested_mode_count` i `refinement_window_requested_mode_count`
ograniczają początkowe żądanie NEV lokalnie, a
`pass_effective_requested_mode_count` zachowuje faktyczny request każdej fazy.
Refinement zaczyna się co najmniej od `base_effective + 1`, dzięki czemu
certyfikat nie może opublikować `refined_nev <= requested_nev` tylko dlatego,
że lokalny base request został ograniczony.

Retry nie opiera się już wyłącznie na równości liczby zaakceptowanych modów i
żądanego NEV. Każde podokno publikuje teraz:

- `required_local_coverage_radius_hz`;
- `selected_coverage_radius_hz`;
- `result_truncated_at_requested_count`;
- `local_coverage_certified`;
- `local_accepted_mode_count`, `requested_mode_count`, `retry_count` i
  `elapsed_seconds`.

`local_request_saturated` uruchamia retry wyłącznie dla obciętego wyniku bez
certyfikowanego pokrycia lokalnego interwału. Request rośnie ograniczenie przez
`max(n + 1, 2n)` do `maximum_subwindow_requested_mode_count`; harmonogram
pełnego okna i bramki residual/certificate nie zostały zmniejszone.

Dodano i włączono do ścieżek focused/full trzy testy regresyjne:

- `FrequencyWindowDoesNotRetryWhenOnlyTheGlobalRequestIsSaturated`;
- `FrequencyWindowRetriesWhenALocalIntervalIsSaturated`;
- `FrequencyWindowRetriesUntilBothClippedEdgesAreCovered`.

Obejmują one brak fałszywego retry przy samym globalnym nasyceniu, odzyskanie
modów przy lokalnym nasyceniu oraz pokrycie obu obciętych brzegów okna.

### 17.34. Recapture aktualnego Windows runtime po poprawce retry

Aktualny dowód jest związany z jednym checkoutem i jednym snapshotem:

- worktree:
  `C:\git\fullmag\worktrees\eigensolve-k0-finalization`;
- branch: `codex/eigensolve-k0-finalization-20260829`;
- commit: `40540afdf0acbe3fbd1b8fcbd903071cae374c4d`;
- source snapshot:
  `1bfb3d001f1f1f50a21289a2b9763ab20f1b69a1592bfbe3c94fb3d62a6c4196`;
- image: `fullmag/fem-gpu:windows-local`;
- image ID:
  `sha256:244c294411e910a364b48e99666f34e5216c4d779aac81f0caf70e44e7287c9f`.

Świeży manifest Windows managed runtime raportuje
`binary_sha256=bd6df3635c763099cb7e55cbff995591fe2810f59bda24f59ba184257da1e08a`
i
`api_binary_sha256=7d3e6045849f664b05432518feffabbe1f233ac0e4b9be26fde46e181efeecce`.
Po poprawce kontrakt GPU/PETSc przeszedł **13/13 PASS**, a kontrakt CPU
**10/10 PASS**, oba dla snapshotu `1bfb3d...`. `git diff --check` nie wykazał
błędów. Jest to terminalny dowód kompilacji oraz kontraktów obu wariantów
Windows runtime, ale nie terminalny dowód Q1 lub Q2. `worktree_state=dirty`
poprawnie opisuje bieżący stan i nadal wyklucza R10.

### 17.35. R7/Q1: świeże próby realnego CPU window i granica dowodu

Pierwsza próba z aktualnej tożsamości, w raporcie
`C:\fullmag-cache\state\fem-gpu\reports\fem-periodic-antidot-relax-eigenmodes\windows-cpu-window-localretry-1bfb3d`,
zakończyła się przed solverem komunikatem:

```text
headless FULLMAG_API_PORT=8081 must already serve a compatible fullmag-api
```

Był to błąd konfiguracji launchera, a nie regresja solvera. Następna próba
`windows-cpu-window-localretry-1bfb3d-r2` uruchomiła właściwą Windows/Docker
Desktop ścieżkę CPU z PETSc/SLEPc, wykorzystała zweryfikowany cache równowagi i
potwierdziła:

- mesh 5156 węzłów, 27384 elementy i 5158 boundary faces;
- extent 200×200×400 nm;
- relaksację zakończoną po jednym kroku;
- `max_torque=9.9930e-7 T` i `max_torque_apm=7.9521e-1`, poniżej progu
  `7.9577e-1`;
- wejście do `base subwindow=1/50` oraz spadek residualu z około `1.49e3`
  poniżej `1e-9`.

Przebieg `r2` przerwano diagnostycznie z powodu wielotysięcznego strumienia
komunikatów GMRES w terminalu; nie powstał terminalny artefakt. Próba `r3`
z wyciszonym stdout również zakończyła się jeszcze przed solverem, ponieważ
obraz nie zawierał opcjonalnego `/usr/bin/time`. Jej katalog i `runtime.log`
zachowano jako dowód przyczyny, a pomiar zastąpiono przenośnym licznikiem
powłoki bez zmiany konfiguracji fizycznej.

Właściwy wyciszony przebieg używa nowego, nieprzetwarzanego ponownie katalogu:

`C:\fullmag-cache\state\fem-gpu\reports\fem-periodic-antidot-relax-eigenmodes\windows-cpu-window-localretry-1bfb3d-r4`.

Został uruchomiony z `FULLMAG_API_PORT=0`, pełnym zakresem 0.5--30 GHz,
targetem `frequency_window`, 8 żądanymi i 4 zapisywanymi modami, cache
`periodic-antidot-6b86` oraz jawnymi ustawieniami CPU. W chwili aktualizacji
proces używał około 220--280% CPU i około 425 MiB RAM, pozostawał w
`base subwindow=1/50`, a residual schodził poniżej `2e-10`. Jest to świeży
dowód aktywnego realnego solve, nie terminalny receipt.

Pełne 0.5--30 GHz, ukończone **16 base + 34 refinement**,
`window_complete=true`, spectrum, mode fields, certificate, convergence i oba
walidatory nadal pozostają **NOT VERIFIED**. R7 pozostaje `PARTIAL`; Q1 wolno
zamknąć dopiero po terminalnym zakończeniu `r4` i związaniu wszystkich
artefaktów z tym samym snapshotem `1bfb3d...`.

### 17.36. Pozostałe bramki R8--R10 i Q2

Po terminalnym Q1 należy kolejno wykonać
`verify_fem_frequency_domain_eigen_artifacts.py
--require-k0-periodic-airbox-production` oraz
`validate_fem_periodic_antidot_relax_eigenmodes_runtime.py` z oczekiwanym
targetem `frequency_window`, 8 modami i 4 zapisanymi modami. Nie wolno zamykać
bramki przez zmniejszenie liczby podokien, zmianę geometrii, fallback GPU→CPU
ani pominięcie walidatora.

R8 nadal wymaga świeżego FMS restart/import oraz 60-sekundowego browser/WebGL
smoke na terminalnym artefakcie. Zielone testy źródłowe UI (**50/50** modeli i
adapterów, **74/74** StageInspectors) nie są dowodem przeglądarkowym.

R9/Q2 pozostaje osobną bramką. Adapter-scale i lifecycle GPU przeszły kontrakt,
ale nadal brakuje realnego GPU solve na tym samym antydocie, profiler receipt,
parity CPU--GPU, repeatability, cancellation, peak-memory, odporności
exact/near-shift i bezpiecznego teardownu. Wcześniejszy pełny wariant GPU
ujawnił dodatkowo brak trwałego kontekstu diagnostycznego; nie należy mieszać
tego problemu z CPU Q1.

R10 pozostaje **NOT VERIFIED**, ponieważ worktree jest dirty i nie istnieje
jeszcze immutable candidate.

### 17.37. Finalny Windows-only build i fizyczny sweep K0 (15 pól)

Po domknięciu kontraktów metadanych wykonano świeży build i świeży przebieg z
jednej, zgodnej tożsamości źródła. Obowiązuje następujący immutable runtime
receipt (immutable w sensie związania artefaktów, nie w sensie czystego brancha):

- worktree: `C:\git\fullmag\worktrees\eigensolve-k0-finalization`;
- branch: `codex/eigensolve-k0-finalization-20260829`;
- commit: `40540afdf0acbe3fbd1b8fcbd903071cae374c4d`;
- source snapshot: `1ad03755820a8c145959fee45e793f4a59bd1228e62ad0bd141f52f8221db69f`;
- runtime: `docker-desktop-linux-container-local` uruchomiony z Windows
  PowerShell przez `compose.windows.yaml` (bez WSL);
- image: `fullmag/fem-gpu:windows-local`, image ID
  `sha256:244c294411e910a364b48e99666f34e5216c4d779aac81f0caf70e44e7287c9f`;
- binary SHA-256: `bd6df3635c763099cb7e55cbff995591fe2810f59bda24f59ba184257da1e08a`;
- API binary SHA-256: `61ddae0723392b5357b92ff5851370b50b6c9986d4946665863bcaa3a16c3ab3`;
- build manifest: `C:\fullmag-cache\state\fem-gpu\windows-fem-gpu-manifest.json`;
- artefakty: `C:\fullmag-cache\state\fem-gpu\reports\k0-kittel-periodic-airbox-physical-r10\artifacts`.

Build `BuildMode=true -BuildOnly -Frontend dev -Backend fem -Device gpu` zakończył
się kodem 0. Następnie ten sam launcher wykonał przykład
`examples/fem_eigen_k0_kittel_periodic_airbox.py` z jawnym `FULLMAG_FEM_EXECUTION=cpu`,
`FULLMAG_FEM_MFEM_DEVICE=cpu`, `FULLMAG_FEM_REQUIRE_GPU=0` i trybem strict.
CLI zakończył się kodem 0 (`status=completed`, `total_steps=3`,
`eigen_mode_count=15`). Jest to runtime przez Docker Desktop na Windowsie; WSL
nie uczestniczył w materializacji, buildzie ani solve.

### 17.38. Wynik fizyczny sweepu i walidacja artefaktów

Przebieg obejmuje dokładnie 15 niezależnych próbek pola `bias_field_sweep` z
`equilibrium_policy=relax_each`, `continuation_seed=initial_state`, przy
`k=(0,0,0)` i `demag_kind=periodic_airbox_k0`:

| Zakres / wynik | Wartość |
|---|---:|
| pola | `mu0 H = 5--100 mT` (`3978.8736--79577.4715 A/m`) |
| próbek spektrum | `15/15`, `complete=true` |
| wybranych gałęzi | `1` (`branch_id=0`) |
| solver | `k0_poisson_airbox_cpu_schur_slepc` |
| execution lane | `production_cpu`, `fallback_used=false` |
| mesh | `100` węzłów, `290` elementów, `216` boundary faces |
| pary okresowe | `22` magnetic, `32` airbox |
| residual Poissona | `5.593335217729862e-16` |
| względny residual własny | `1.3615721273286655e-14` |
| pól modów | `15` binarnych `vector.bin` + `15` grup Zarr |
| manifest | `complete=true`, `status=complete`, `15` zasobów `.../mode-field/{sample}/0/meta` |

Otrzymane częstotliwości (pierwszy mod, zaokrąglone):

| `mu0 H` [mT] | `f_FEM` [GHz] | błąd względem Kittela |
|---:|---:|---:|
| 5.000 | 1.853543 | 6.8696% |
| 11.786 | 2.856739 | 6.8221% |
| 18.571 | 3.599793 | 6.7753% |
| 25.357 | 4.222355 | 6.7290% |
| 32.143 | 4.771819 | 6.6835% |
| 38.929 | 5.271096 | 6.6385% |
| 45.714 | 5.733311 | 6.5941% |
| 52.500 | 6.166805 | 6.5503% |
| 59.286 | 6.577258 | 6.5071% |
| 66.071 | 6.968742 | 6.4645% |
| 72.857 | 7.344292 | 6.4224% |
| 79.643 | 7.706238 | 6.3809% |
| 86.429 | 8.056413 | 6.3399% |
| 93.214 | 8.396291 | 6.2994% |
| 100.000 | 8.727073 | 6.2594% |

Ważne: ogólny validator artefaktów
`python scripts/verify_fem_frequency_domain_eigen_artifacts.py <artifacts>`
przechodzi (**PASS**). Validator z wymaganiem fizycznym
`--require-k0-kittel-periodic-airbox-demag` zatrzymuje się wyłącznie na bramce
numerycznej:

```text
k0 Kittel field sweep max relative error is too large for branch 0:
got 0.0686963, expected <= 0.05
```

To jest prawidłowy wynik diagnostyczny, a nie błąd eksportu: solver policzył
wszystkie punkty, ale obecna konfiguracja nie spełnia jeszcze tolerancji
Kittela. `uniformity_score` minimum wynosi `0.48`, overlap gałęzi `1.0`, a
maksymalny tangent leakage `9.8550815e-26`; jednocześnie metadata meshu jawnie
ostrzega o tylko jednej warstwie przez grubość (`requested/estimated layers
below 4`). Nie wolno więc twierdzić, że wynik jest już kwalifikacją fizyczną.

Artefakt `fmr/kittel_fit.v1.json` jest `status=partial`,
`complete=false`, `stop_reason=statistical_fit_covariance_not_available`,
`validation_status=failed`. Oznacza to, że postsolve oracle i krzywa są
dostępne, ale nie ma jeszcze pełnej niepewności statystycznej wymaganej dla
produkcyjnego dopasowania.

### 17.39. Co zostało faktycznie zaimplementowane w tym slice

1. Runner wykonuje dla każdego pola fizyczną relaksację, dekoduje
   `certified_fem_equilibrium_fields.v1.json` i
   `recomputed_fem_linearization_certificate.v1.json`, waliduje certyfikat i
   dopiero wtedy przekazuje typowany handoff do natywnego eigensolve.
2. Plan pojedynczej próbki czyści zagnieżdżony sweep i oracle Kittela, więc
   solver nie może „rozwiązać” pola przez ponowne wejście w rekurencyjny sweep
   ani przez podstawienie wzoru analitycznego zamiast operatora.
3. Direct `magnetic_pair_count`/`airbox_pair_count` są propagowane do
   diagnostyki; odczyt certyfikatu obsługuje także zgodne pola zagnieżdżone.
4. Manifest publikuje metadata endpointy pól modów zgodne z indeksem próbki i
   raw mode (`.../mode-field/{sample_index}/{raw_mode_index}/meta`).
5. `field_sweep.v1` publikuje kanoniczną oś `bias_field_a_per_m`, jawny status
   `requested`/`ok` i `execution_mode=strict`; dzięki temu ogólny validator nie
   maskuje braków metadanych.

### 17.40. Zaktualizowany status względem oryginalnego planu

| Zakres oryginalnego planu | Stan po tym slice | Dowód / granica |
|---|---|---|
| C2: schema/planner/adapter dla K0 field sweep | **DONE** | źródła + focused tests + artefakt 15 punktów |
| C3: relaksacja per próbka i certyfikowany handoff | **IMPLEMENTED; smoke DONE** | 15/15 physical CPU samples, brak fallbacku |
| N1: CPU K0/PBC na prostym filmie | **DONE jako smoke**, nie Q1 | finalny `r10`, ogólny validator PASS |
| N2: GPU K0/PBC na tym samym sweepie | **NOT VERIFIED** | build GPU-capable istnieje, solve wykonano jawnie CPU |
| A1S: spectrum/branches/mode fields/Zarr/manifest | **DONE dla smoke bundle** | kompletne artefakty i resource metadata |
| R7/Q1: realny periodic antidot, 0.5--30 GHz | **NOT DONE** | nadal brak terminalnego 16 base + 34 refinement |
| R8: FMS + API + browser/WebGL projection | **NOT VERIFIED** | brak screenshotu i live browser proof |
| R9/Q2: realny GPU, parity, profiler, cancellation | **NOT DONE** | brak device-resident terminalnego solve |
| R10: clean candidate i integracja do master | **NOT VERIFIED** | worktree dirty; brak zgody na merge/push |

Konserwatywna ocena postępu pozostaje wielowymiarowa:

- szerokość implementacji źródłowej: około **85%**;
- realizacja całego DAG-u oryginalnego planu: około **70%** po zamknięciu
  fizycznego smoke slice, ale nadal bez Q1/Q2/R8/R10;
- kwalifikacja produkcyjna (CPU/GPU + nauka + UI): **0% jako zamknięty
  claim**, ponieważ nie przeszły jeszcze bramy pełnego przypadku kanonicznego.

Nie należy interpretować `70%` jako „70% poprawności fizycznej”. Aktualny
wynik pokazuje, że ścieżka obliczeniowa działa, a test Kittela wykrywa
systematyczny deficyt częstotliwości około `6.26--6.87%`.

### 17.41. Nowy plan wdrożenia pozostałej pracy

Plan jest celowo sekwencyjny: nie przechodzimy do UI/GPU, dopóki CPU nie ma
powtarzalnego, zbieżnego punktu odniesienia.

1. **Domknąć Kittel/convergence na prostym filmie (CPU).** Uruchomić co
   najmniej trzy rozdzielczości meshu oraz trzy rozmiary airboxu, zachowując
   te same 15 pól, `k=0`, materiał i operator `periodic_airbox_k0`. Akceptacja:
   `max_relative_frequency_error <= 0.05`, stabilny branch, brak naruszenia
   residual/gauge/Poisson oraz jawny raport wpływu warstw przez grubość. Jeśli
   błąd pozostanie, rozdzielić przyczynę na discretization, airbox i parametry
   modelu zamiast luzować próg.
2. **Powtórzyć CPU/GPU native contracts na finalnym snapshotcie.** Starsze
   receipts `10/10` i `13/13` z wcześniejszych snapshotów są historyczne;
   wykonać świeży `verify_fem_frequency_domain_native_contract.ps1 -Device cpu`
   oraz `-Device gpu` po zakończeniu punktu 1.
3. **Wykonać Q1 na rzeczywistym periodic antydocie.** Użyć jednego snapshotu,
   kanonicznego cache równowagi i jawnej konfiguracji 0.5--30 GHz, `16 base +
   34 refinement`, 8 żądanych i 4 zapisanych modów. Wymagane są: terminalny
   `window_complete=true`, spectrum/branches, mode fields, window certificate,
   oba walidatory i convergence.
4. **Wykonać Q2 GPU na tym samym antydocie.** Zweryfikować device-resident
   operator, HYPRE/SLEPc receipt, brak CPU fallbacku, parity CPU--GPU,
   repeatability, cancellation, peak memory, exact/near-shift i bezpieczny
   teardown. GPU smoke K0 z tego dokumentu nie zastępuje tego punktu.
5. **Dopiero po Q1/Q2 zrobić R8.** Zaimportować finalny `.fms`, uruchomić API na
   tym samym katalogu, sprawdzić wszystkie endpointy `meta`/`vector`, wybrać
   próbkę i mod, wykonać screenshot Control Room oraz 60-sekundowy WebGL smoke.
   Artefakt/API/DOM bez obrazu przeglądarki pozostaje `NOT VERIFIED`.
6. **Na końcu R10.** Ustabilizować checkout Windows, rozdzielić i opisać
   wszystkie unrelated dirty changes, utworzyć immutable candidate, wykonać
   końcowy diff/manifest/source identity i dopiero po jawnej decyzji użytkownika
   integrować do `master`. Nie wykonywać force-push ani nie usuwać bieżącego
   worktree.

Do czasu spełnienia punktu 1 obowiązuje werdykt: **solver i artefakty są gotowe
do dalszej pracy i debugowania, ale fizyczny claim Kittel/produkcyjny pozostaje
NO-GO**.

### 17.42. Aktualny wynik zależności widma od pola (Windows, świeży snapshot)

Na pytanie, czy mamy już wynik sweepu po polu, odpowiedź brzmi: **tak, dla
kanonicznego smoke przypadku K0/PBC mamy kompletny profil 15 punktów**. Wynik
został powtórzony po poprawce agregowania `stage_continuation` i jest związany
z następującą tożsamością:

- worktree: `C:\git\fullmag\worktrees\eigensolve-k0-finalization`;
- branch: `codex/eigensolve-k0-finalization-20260829`;
- commit: `40540afdf0acbe3fbd1b8fcbd903071cae374c4d`;
- source snapshot: `572a229c13e93dceea10a3f1c60e01e6ddf544cef1e668b6de55fd2c4e889be5`;
- build manifest: `C:\fullmag-cache\state\fem-gpu\windows-fem-gpu-manifest.json`;
- runtime: Docker Desktop Linux container uruchomiony z Windows PowerShell,
  bez WSL; image `fullmag/fem-gpu:windows-local`,
  `sha256:244c294411e910a364b48e99666f34e5216c4d779aac81f0caf70e44e7287c9f`;
- binary SHA-256: `bd6df3635c763099cb7e55cbff995591fe2810f59bda24f59ba184257da1e08a`;
- API binary SHA-256: `514efd1ea0ab3827281fd81401c0443be5f064ff860109a17c74613b646b3e18`.

Artefakt referencyjny znajduje się w:
`C:\fullmag-cache\state\fem-gpu\reports\k0-kittel-conv-m20-a5-v2\artifacts`.
Przebieg ma `status=complete`, `15/15` próbek, jedną śledzoną gałąź (`branch_id=0`),
solver `k0_poisson_airbox_cpu_schur_slepc`, `production_cpu` i
`fallback_used=false`. Dla każdego punktu zapisano też binarny wektor pola
modu oraz endpoint resource metadata. Agregowane metadata potwierdzają
`equilibrium_source.handoff=stage_continuation` przy `relaxation_steps=0`,
czyli brak relaksacji nie jest już mylony z brakiem certyfikowanego handoffu.

Przy geometrii `160 x 80 x 10 nm`, 20 nm mesh i airbox factor 5 widmo pierwszego
modu rośnie monotonicznie:

| `mu0 H` [mT] | `f_FEM` [GHz] |
|---:|---:|
| 5.000 | 1.912581 |
| 11.786 | 2.947042 |
| 18.571 | 3.712730 |
| 32.143 | 4.919310 |
| 52.500 | 6.353274 |
| 72.857 | 7.561647 |
| 100.000 | 8.978235 |

Pełna oś znajduje się w `eigen/field_sweep.v1.json`; wszystkie rekordy mają
`status=complete`. Niezależny residual Poissona wynosi około `5.10e-16`, a
residual własny około `1e-14`. Ogólny oraz fizyczny validator
`--require-k0-kittel-periodic-airbox-demag` przechodzą dla pięciu świeżych
rootów zbieżności.

Jednocześnie nie jest to jeszcze zamknięta kwalifikacja fizyczna. Formalny
raport zbieżności dla trzech meshów (`20/15/10 nm`) i trzech airboxów
(`0.48/0.80/1.28 um`) zatrzymuje się na rzeczywistym warunku dopasowania:

```text
fitted M_eff relative error 0.0769231 exceeds 0.02
```

Diagnostyczny raport z progiem tylko do analizy (nie do akceptacji) pokazał
plateau roundoff po mesh refinement oraz stabilizację wpływu airboxu, ale
`M_eff=738461.538 A/m` zamiast referencyjnych `800000 A/m`. Próba większej
komórki `320 x 160 nm` zmniejszyła maksymalny błąd częstotliwości do około
`2.40%` i fit do `4.76%` (airbox factor 5), lecz nie domknęła jeszcze progu
`2%`; jeden najdrobniejszy test przerwał się na niezależnym, bardzo ciasnym
porównaniu `h_ex` (`1.067e-8 > 1.000e-8 A/m`). Te przebiegi są oznaczone jako
eksploracyjne i nie zastępują formalnego zestawu akceptacyjnego.

Wniosek: **mamy działający i kompletny wynik `f(H)` dla CPU K0/PBC oraz pola
modów**, więc można go już używać do diagnostyki i przygotowania UI. Nadal
obowiązuje `NO-GO` dla claimu zgodności z nieskończoną warstwą Kittela do czasu
rozstrzygnięcia skończonej komórki/airboxu (bez luzowania progów), a realny Q1
periodic-antidot `0.5--30 GHz` pozostaje niewykonany.

### 17.43. Świeże kontrakty native po zmianie handoffu

Na tym samym snapshotcie wykonano oba kontrakty Windows/Docker (nie używając
WSL):

| lane | wynik | liczba targetów | build root |
|---|---|---:|---|
| CPU | **PASS** | `10/10` | `C:\fullmag-build\native-contract\cpu` |
| GPU | **PASS** | `13/13` | `C:\fullmag-build\native-contract\gpu` |

GPU został uruchomiony z wykrytą kartą `NVIDIA GeForce RTX 4080 SUPER`, a suite
obejmował m.in. `fem_poisson_airbox_modal_eigen_slepc_contract`. Są to świeże
receipts związane z `572a229c...`; wcześniejsze `10/10` i `13/13` pozostają
historyczne. Kontrakty potwierdzają integralność builda i interfejsów, ale nie
zastępują jeszcze Q2: realnego antydotu na GPU, parity CPU--GPU, profilerów,
cancellation i pomiaru pamięci.

### 17.44. Aktualizacja tożsamości po naprawie jawnego wyboru GPU

Fixture K0 miała wcześniej plan urządzenia zapisany na stałe jako CPU. Przy
rzeczywistym żądaniu GPU runtime poprawnie uruchamiał `fem_native_gpu`,
`ceed-cuda:/gpu/cuda/shared` i `device_hypre_poisson`, ale zapis artefaktu
odrzucał niespójność `effective=cpu` kontra `resolved=gpu`. Naprawiono to przez
parametr `FULLMAG_K0_KITTEL_DEVICE` (domyślnie `cpu`, jawne `gpu` tylko na
żądanie), po czym wykonano nowy build. Aktualna tożsamość builda to:

- source snapshot: `7394b5d68109b6029b3bf8d85c7665866a08c6e1d50ba98fb3f979217166a120`;
- build UTC: `2026-08-31T08:38:34Z`;
- binary SHA-256: `bd6df3635c763099cb7e55cbff995591fe2810f59bda24f59ba184257da1e08a`;
- API binary SHA-256: `0e9a41066c26be2de98f411d2deace523dcbcf7d845d2baaa390b9d913ce9c76`.

Po poprawce świeży CPU artefakt
`C:\fullmag-cache\state\fem-gpu\reports\k0-kittel-cpu-v3\artifacts`
ponownie ma `15/15`, `1.912580599 -> 8.978234604 GHz`,
`max_relative_frequency_error=3.9033%`, oba walidatory PASS oraz
`handoff=stage_continuation`. Pomocniczy GPU sweep K0 uruchomił rzeczywisty
GPU runtime i nie ujawnił fallbacku, lecz po około 19 minutach nie wygenerował
terminalnego artefaktu; został bezpiecznie zatrzymany. Nie jest liczony jako
wynik ani jako Q2. Właściwy Q2 pozostaje realnym periodic-antidotem z pełnym
receipt/profilingiem, parity i cancellation.

### 17.45. Wykres analityczny i obliczony `f(H)`

Na potrzeby szybkiej inspekcji przygotowano wykres porównujący oba źródła
częstotliwości:

`C:\Users\Mateusz\.codex\visualizations\2026\08\29\01a04c3b-7546-7cc2-b555-fde34bf26ccb\field-frequency-comparison.html`

Krzywa analityczna używa dokładnie tego samego orakla co walidator:

```text
f_Kittel(H) = gamma0/(2*pi) * sqrt(H * (H + Ms))
gamma0 = 2.211e5 rad s^-1 (A m^-1)^-1
Ms = 800000 A m^-1
```

Punkty FEM pochodzą bezpośrednio z bieżącego
`C:\fullmag-cache\state\fem-gpu\reports\k0-kittel-cpu-v3\artifacts\eigen\field_sweep.v1.json`,
nie z danych syntetycznych ani z krzywej analitycznej. Wykres pokazuje więc
zarówno monotoniczny trend obliczeń, jak i systematyczny deficyt względem
idealizowanego filmu Kittela (około `3.56--3.90%` punktowo dla tego przypadku).

### 17.46. Odświeżone kontrakty native na bieżącym snapshotcie

Po poprawce jawnego wyboru urządzenia wykonano ponownie oba kontrakty z
`C:\git\fullmag\worktrees\eigensolve-k0-finalization` bez WSL:

| lane | wynik | liczba targetów | source snapshot | build root |
|---|---|---:|---|---|
| CPU | **PASS** | `10/10` | `7394b5d68109b6029b3bf8d85c7665866a08c6e1d50ba98fb3f979217166a120` | `C:\fullmag-build\native-contract\cpu` |
| GPU | **PASS** | `13/13` | `7394b5d68109b6029b3bf8d85c7665866a08c6e1d50ba98fb3f979217166a120` | `C:\fullmag-build\native-contract\gpu` |

Lane GPU wykrył `NVIDIA GeForce RTX 4080 SUPER`. Ten receipt zamyka świeżą
bramę integralności interfejsów CPU/GPU po zmianie fixture, ale nie zmienia
statusu Q1/Q2: kontraktowe targety nie są pełnym solve'em periodic-antidot,
nie zawierają jeszcze wymaganej parytetu CPU--GPU, cancellation ani pomiaru
pamięci dla kanonicznego przypadku.

### 17.47. Q1 CPU uruchomiony na bieżącym snapshotcie

Po odświeżeniu kontraktów uruchomiono właściwy przebieg Q1 z Windows PowerShell
i Docker Desktop (bez WSL):

- source snapshot: `7394b5d68109b6029b3bf8d85c7665866a08c6e1d50ba98fb3f979217166a120`;
- urządzenie: `cpu`, `FULLMAG_FEM_EXECUTION=cpu`, `FULLMAG_FEM_MFEM_DEVICE=cpu`;
- cache równowagi: `C:\fullmag-cache\state\fem-gpu\equilibrium-cache\periodic-antidot-6b86`;
- siatka cache: `5156` węzłów, `27384` elementów;
- zakres: `0.5--30 GHz`, `frequency_window`, `8` żądanych modów, `4` zapisywane;
- katalog docelowy: `C:\fullmag-cache\state\fem-gpu\reports\periodic-antidot-q1-cpu-current\artifacts`.

Relaksacja zakończyła się certyfikowanym progiem `9.993e-7 T` (`0.79521 A/m`
wobec `0.79577 A/m`). Następnie runtime wszedł w modalne okno `base` i raportuje
`1/50` podokna; proces pozostaje aktywny i nie ma jeszcze terminalnego
`window_complete=true`. Do czasu końca tego procesu Q1 pozostaje
`IN_PROGRESS`, a częściowy katalog nie jest wynikiem akceptacyjnym.

### 17.48. Skąd bierze się rozbieżność względem Kittela

Na pytanie, dlaczego krzywe wyglądają na bardziej rozdzielone przy dużym polu,
trzeba rozdzielić błąd bezwzględny od względnego. Dla bieżącego artefaktu
`k0-kittel-cpu-v3` wartości skrajne są:

| `mu0 H` | `f_FEM` | `f_Kittel` | `f_FEM-f_Kittel` | błąd względny |
|---:|---:|---:|---:|---:|
| 5 mT | 1.9126 GHz | 1.9903 GHz | -0.0777 GHz | -3.90% |
| 100 mT | 8.9782 GHz | 9.3098 GHz | -0.3316 GHz | -3.56% |

Zatem pionowa odległość w GHz rośnie, ale zgodność względna poprawia się
(`3.90% -> 3.56%`). Wynika to z tego, że obie częstotliwości rosną z polem,
podczas gdy różnica efektywnego członu demagnetyzacji daje w przybliżeniu
stałe przesunięcie asymptotyczne. Wykres powinien pokazywać osobny panel
`Delta f` oraz `100*(f_FEM/f_Kittel-1)`, żeby nie mylić tych dwóch miar.

Sam fakt nasycenia magnetyzacji statycznej nie wymusza dokładnej zgodności z
Kittelem. Oracle używa

```text
f_Kittel = gamma0/(2*pi) * sqrt(H * (H + Ms))
```

i zakłada nieskończony, jednorodny film z idealnymi współczynnikami
demagnetyzacji `Nx=Ny=0, Nz=1`. Natywny solve rozwiązuje natomiast skończoną
komórkę FEM z operatorem `periodic_airbox_k0`, a dynamiczny mod widzi własny,
zależny od geometrii tensor demagnetyzacji. Dla ogólnego nasyconego elementu
kształtu odpowiednia postać ma czynniki

```text
f = gamma0/(2*pi) * sqrt((H + (Ny-Nx)*Ms) *
                          (H + (Nz-Nx)*Ms))
```

(`gamma0` jest tu w jednostkach `rad s^-1 (A m^-1)^-1`; przy użyciu
`gamma` w `rad s^-1 T^-1` równoważnie trzeba przeliczyć wszystkie pola na
tesle.)

W ogólnej skończonej lub wzorzystej komórce korekty `Nx,Ny`, skończony airbox
i lokalne zakłócenia dynamicznego pola (w antydocie także krawędź otworu)
obniżają pierwszy mod względem idealnego orakla, mimo że `m=(1,0,0)` jest
statycznie nasycone. Dla bieżącego prostego filmu z PBC trzeba najpierw
rozstrzygnąć wpływ airboxu i dyskretyzacji przez grubość: `10 nm` przy
domyślnym `layers=1` i `hmax=20 nm` nie opisuje wiarygodnie profilu
dynamicznego w osi `z`. Residuale solvera są małe, więc nie jest to błąd
zbieżności liniowego solve'u; to różnica modelu, geometrii albo dyskretyzacji.

Dopasowanie diagnostyczne daje `M_eff=738461.538 A/m` przy zadanym
`Ms=800000 A/m`. Nie oznacza to zmiany materiałowego `Ms`; jest to sygnał, że
efektywny dynamiczny człon demagnetyzacji jest zaniżony względem założeń
Kittela. Przy `100 mT` mamy tylko `H/Ms≈0.10`, więc nie jesteśmy jeszcze w
reżimie `H >> Ms`, w którym wszystkie geometryczne poprawki byłyby względnie
małe.

Kolejność rozstrzygnięcia pozostaje bez luzowania progu: (1) powtórzyć film z
`layers=4/8` i kontrolowanym `h_z`, (2) sprawdzić większy airbox, (3) osobno
wyłączyć/włączyć wymianę i demag, (4) dla antydotu porównywać do rozwiązania
periodycznej komórki, a nie traktować Kittela jako ścisłego orakla. Obecne dane
nie pokazują pogorszenia błędu względnego przy dużym polu; pokazują rosnącą
różnicę absolutną na wspólnej osi GHz.

### 17.49. Test FMS po korekcie przenośności Windows

Uruchomienie `cargo test -p fullmag-session --quiet` na bieżącym Windows
worktree początkowo wykazało dwa nieudane testy oparte na uniksowej enumeracji
plików: `bad:artifact` jest na NTFS nazwą alternatywnego strumienia danych, a
`result.bin` i `RESULT.bin` wskazują ten sam wpis. Nie oznaczało to przepuszczenia
niebezpiecznej ścieżki przez walidator archiwum; oznaczało, że test pakowania nie
mógł odtworzyć na Windows dwóch osobnych nazw.

Naprawa zachowuje testy filesystem-specific pod `cfg(unix)` i dodaje niezależne,
przenośne testy `validate_portable_namespace_path` oraz
`validate_export_entry_metadata`, które nadal wymagają odrzucenia odpowiednio
ścieżki z `:` i kolizji case-fold. Po zmianie bieżący wynik to:

```text
running 38 tests
test result: ok. 38 passed; 0 failed
```

Jest to zamknięcie lokalnego regresyjnego gate'u FMS na Windows, ale nie zastępuje
jeszcze wymaganego procesowego export -> restart -> import na finalnym runtime
ani Q3 browser/WebGL proof.

### 17.50. Procesowy kontrakt API importu FMS

Po korekcie testów przenośności uruchomiono ukierunkowany test API:

```text
cargo test -p fullmag-api session_import --quiet
running 7 tests
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 1051 filtered out
```

Ten wynik wzmacnia R8 na poziomie handlerów i kontroli importu (w tym
odrzucania niespójnego snapshotu przed publikacją), ale nadal nie jest
procesowym dowodem `export -> restart procesu -> import` na terminalnym
artefakcie Q1. Q1 pozostaje aktywny, a aktualny source snapshot po tej zmianie
testowej wymaga osobnego związania przy finalnym candidate.

Bieżący capture źródła po tej zmianie ma
`source_snapshot_sha256=fa83052c96169b14915a4cfca57d459fe6129ca9d1be64316d8d1bca2846e17c`;
aktywny kontener Q1 został uruchomiony wcześniej ze snapshotem `7394b5d6...` i
nie może być użyty jako dowód finalnego snapshotu po zmianie.

### 17.51. Rozdzielenie parametrów materiałowych od przyczyny deficytu FEM

Sprawdzono bezpośrednio parametry zapisane w artefakcie
`C:\fullmag-cache\state\fem-gpu\reports\k0-kittel-cpu-v3\artifacts` oraz
źródło `examples/fem_eigen_k0_kittel_periodic_airbox.py`. Parametry orakla i
solve'u są zgodne:

| parametr | wartość | wniosek |
|---|---:|---|
| `Ms` | `800000 A/m` | identyczne w materiale FEM i w oraklu Kittela |
| `gamma0` | `221100 rad/(s A/m)` | identyczne; odpowiada `gamma=1.75945789588e11 rad/(s T)` |
| równoważne `g` | około `2.0007` | nie ma błędu współczynnika `g` |
| `mu0` | `1.2566370614359173e-6 T m/A` | konwersja użyta poprawnie |
| pole | `5--100 mT`, `H=B/mu0` | te same 15 próbek po obu stronach |
| `Aex` | `1.3e-11 J/m` | włączone; dla jednorodnego `k=0` moda wymiana nie daje przesunięcia |
| `alpha` | `0` | brak tłumienia w solve'ie własnym |

Wartości skrajne potwierdzają tę zgodność: orakl daje `1.990266636 GHz` i
`9.309813711 GHz`, a FEM `1.912580599 GHz` i `8.978234604 GHz`. Nie jest to
więc różnica wynikająca z `g`, `gamma`, `mu0`, jednostek pola ani z innego
`Ms`.

Dodatkowe rozliczenie artefaktu wyklucza dwa częste fałszywe tropy. Pole
statyczne po relaksacji spełnia `H_eff=H_ext` do około `1e-11 A/m`, a
`|H_demag,0|_max=4.81e-11 A/m`; magnetyzacja ma `m0=(1,0,0)` z błędem normy
`0`. Mod ma residual `9.57e-15`, residual Poissona `5.10e-16`, overlap gałęzi
`1.0` i leakage styczny około `1e-26`. Surowy wektor jest stały w 252 węzłach
magnetycznych (komponent `y` i `z` mają współczynnik zmienności około `1e-14`),
a 198 węzłów airboxu ma zero. To jest właściwy jednorodny mod objętości
magnetycznej, nie zły mod brzegowy; wynik nie jest też niedokładnym solve'em.

Najmocniejszy obecnie sygnał wskazuje na dynamiczny operator demagnetyzacji i
jego sztuczną granicę, nie na parametry materiału. Fit wszystkich 15 punktów
ma dokładnie postać Kittela z `M_eff=738461.538 A/m = (12/13) Ms`. Jest to
równoważne obniżeniu członu `Nz-Nx` z idealnego `1` do około `0.92308` (nie
oznacza, że materiałowe `Ms` zmieniło się). W kodzie
`crates/fullmag-runner/src/fem/eigen_shared_domain_geometry.rs:185-233`
funkcja `shared_domain_robin_beta_m` deklaruje bazowanie na osi otwartej, ale
wyznacza `reference_extent` jako maksimum również po wszystkich osiach. Dla
PBC w `x,y` oznacza to, że szerokość okresowej komórki wpływa na współczynnik
Robin:

| komórka | `beta` z artefaktu | maks. błąd Kittela |
|---|---:|---:|
| `80 x 40 x 10 nm` | `50e6 1/m` | `5.69%` |
| `160 x 80 x 10 nm` | `25e6 1/m` | `3.90%` |
| `320 x 160 x 10 nm` | `12.5e6 1/m` | `2.10--2.40%` |

Ta zależność jest fizycznie podejrzana: przy tym samym problemie `k=0` zmiana
rozmiaru okresowej komórki nie powinna sama z siebie stroić granicy otwartej
w osi `z`. Niezależnie od tego, przy stałej komórce zmiana wysokości airboxu z
factor `3` do `8` zmienia błąd `4.63% -> 3.16%`, więc występuje także zwykły
błąd skończonego airboxu. Wniosek jest zatem dwuczęściowy: (a) obecny Robin
jest zależny od szerokości PBC i wymaga korekty/testu, (b) finite-airbox oraz
`layers=1` w osi `z` pozostają osobnymi źródłami błędu.

To wyjaśnia pozornie dużą rozbieżność: FEM liczy poprawnie własny, skończony
operator `periodic_airbox_k0`, ale ten operator nie jest jeszcze tym samym co
idealny nieskończony film Kittela. Następny test rozstrzygający powinien
zmienić wyłącznie regułę `beta` na zależną od otwartej osi i wykonać kontrolę
`layers=1/4/8` oraz airbox `3/5/8`; dopiero zgodność po tych testach pozwoli
nazwać problem błędem implementacji zamiast kontrolowanym przybliżeniem
granicy.
