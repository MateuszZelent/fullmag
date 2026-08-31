# Produkcyjne domknięcie meshingu Fullmag na Windows

## Audyt aktualnego stanu, kompletny rejestr problemów i masterplan napraw

- Data utworzenia: 2026-08-31
- Status dokumentu: `ACTIVE / EXECUTION BASELINE`
- Status produktu: `PARTIAL / NOT_QUALIFIED`
- Główne środowisko: Windows
- Trasy pomocnicze: Docker/Linux dla FEM CPU/GPU; WSL nie jest wymaganiem Fullmaga (Docker Desktop może używać WSL2 wewnętrznie)
- Repozytorium audytowane: `C:\git\fullmag\fullmag`
- Kanoniczna bramka końcowa: `just verify-fem-meshing-production`
- Kanoniczny przypadek wydajnościowy: MuMag SP4, `Box + bbox airbox + mixed_p1`, jedna warstwa
- Właściciel wykonawczy: Fullmag core
- Charakter dokumentu: plan wdrożeniowy i rejestr dowodów; nie jest receiptem kwalifikacyjnym

---

## 1. Cel dokumentu

Ten dokument ma cztery równorzędne cele:

1. zamrozić uczciwy obraz tego, co zostało faktycznie naprawione;
2. spisać wszystkie znane problemy, także te wykraczające poza jeden przypadek SP4;
3. rozdzielić problemy kodu, jakości numerycznej, wydajności, infrastruktury Windows i kwalifikacji;
4. zdefiniować wykonalny masterplan prowadzący do jednego odtwarzalnego statusu `QUALIFIED`.

Dokument nie zakłada, że poprawnie działający pojedynczy przykład oznacza gotowość całego meshera. Nie utożsamia również:

- kompilacji ze zgodnością naukową;
- testu jednostkowego z runtime proof;
- wygenerowanego artefaktu z aktualnym artefaktem;
- uruchomienia CPU z dowodem GPU;
- prawidłowej liczby elementów z prawidłową jakością;
- przyspieszenia jednego przebiegu z trwałym performance gate;
- aktywnego merge z gotowym źródłem release;
- obecności implementacji z produkcyjną kwalifikacją.

---

## 2. Werdykt wykonawczy

### 2.1 Krótka odpowiedź

Nie naprawiono jeszcze wszystkiego.

Naprawiono i zmierzono najważniejszą ścieżkę wydajnościową dla ograniczonego przypadku SP4 mixed-P1. Nie domknięto jednak całego modułu meshowania, pełnej jakości rodzin elementów, transportu FMMQ v2, macierzy geometrii, managed CPU/GPU, browser/WebGL ani finalnej proweniencji release.

### 2.2 Co można dziś powiedzieć uczciwie

Można powiedzieć:

- kanoniczny SP4 mixed-P1 ma realne przyspieszenie;
- wynikowa siatka w zmierzonym snapshotcie zachowała fingerprint i podstawowe bramki topologii;
- ścieżka strict mixed nie wykonuje cichej konwersji `prism6 -> tet4`;
- kosztowne, powtarzane skany repair/certificate/persistence zostały znacząco ograniczone;
- istnieje typed mixed topology `prism6 + pyramid5 + tet4`;
- istnieją fingerprint v3, certyfikat mixed topology i fail-closed native preflight;
- Windows jest obecnie poprawnym punktem wejścia do budowania i uruchamiania Fullmag;
- FEM pozostaje jawnie routowany do kontenera Linux, a FDM może być natywny na Windows.

Nie można powiedzieć:

- że cały mesher jest produkcyjny;
- że wszystkie geometrie mają tę samą jakość i semantykę sweep;
- że FMMQ v1 kwalifikuje mixed topology;
- że obecny checkout ma czystą i stabilną identity release;
- że istnieje aktualny wspólny receipt CPU/GPU/browser;
- że `just verify-fem-meshing-production` ma aktualny PASS;
- że każdy authored parametr dociera do generatora;
- że Gmsh `Mesh.SmoothRatio` dowodzi ograniczenia wzrostu rozmiaru po meshowaniu;
- że cache i manifesty są bezpieczne między równoległymi worktree bez dodatkowej izolacji;
- że dawny obserwowany czas rzędu 20 minut jest porównywalnym baseline'em dla obecnego przypadku.

### 2.3 Decyzja release

Aktualna decyzja brzmi:

```text
SP4 mixed-P1 implementation: GO for continued engineering and bounded use
Whole meshing module:       NO-GO for production qualification
Current source tree:        NO-GO for release evidence
Current managed evidence:   MISSING / INCOMPLETE
```

---

## 3. Hierarchia źródeł prawdy

W razie sprzeczności obowiązuje następująca kolejność:

1. `docs/physics/0105-fem-meshing-production-acceptance.md`;
2. `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`;
3. `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`;
4. `AGENTS.md`;
5. bieżący kod `packages/fullmag-py`, `crates/fullmag-ir`, `crates/fullmag-plan`, `crates/fullmag-api`, `crates/fullmag-runner` i `backends/fem`;
6. testy kontraktowe i managed receipts związane z dokładnym snapshotem źródła;
7. niniejszy masterplan;
8. historyczne audyty i plany.

Ten dokument jest kanonicznym indeksem wykonawczym, ale nie zmienia definicji naukowej zawartej w notach `0105`, `0106` i ADR 0027.

### 3.1 Dokumenty wejściowe

Dokument konsoliduje i aktualizuje ustalenia z:

- `docs/audits/2026-08-27-fem-mesh-pipeline-audit.md`;
- `docs/superpowers/plans/2026-08-27-fem-meshing-production-remediation.md`;
- `docs/superpowers/plans/2026-08-27-fem-mixed-mesh-performance-and-certification.md`;
- `docs/physics/0100-mesh-and-region-discretization.md`;
- `docs/physics/0101-swept-mesh-through-thickness.md`;
- `docs/physics/0102-airbox-mesh-grading-geometric.md`;
- `docs/physics/0103-rectangular-waveguide-edge-corner-mesh-refinement.md`;
- `docs/physics/0104-thin-film-shared-domain-meshing.md`;
- `docs/physics/0105-fem-meshing-production-acceptance.md`;
- `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`;
- `docs/adr/0021-native-mixed-p1-fem-topology.md`;
- `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`;
- `docs/specs/mesh-roundtrip-semantics-v1.md`;
- `docs/specs/capability-matrix-v0.md`;
- `justfile`;
- `scripts/verify_fem_meshing_production.sh`;
- `scripts/verify_fem_meshing_production.py`;
- `scripts/verify_fem_mixed_prism_airbox_runtime.py`;
- `scripts/benchmark_fem_mixed_mesh_pipeline.py`;
- `scripts/windows/run_fullmag.ps1`;
- `scripts/windows/run_fullmag_fem.ps1` (kanoniczny entry point Windows; dawny `run_fullmag_wsl.ps1` pozostaje aliasem kompatybilności);
- `compose.windows.yaml`.

### 3.2 Dlaczego potrzebny jest nowy baseline

Historyczne plany są nadal wartościowe, ale część ich checklist opisuje stan sprzed ostatnich zmian. Od ich napisania pojawiły się między innymi:

- `FemMeshPolicyIR` i policy fingerprint;
- typowane fragmenty authoring/IR;
- trusted mesh artifact fast path;
- native preflight i mutation guard;
- persistent shared-domain mesh cache;
- optymalizacja transition shell airboxa;
- reuse raportu degeneracji tetów;
- ograniczenie powtórnej walidacji certificate/persistence;
- nowy benchmark evidence v2;
- poprawki routingu Windows-first.

Dlatego stare pola wyboru `[ ]` nie są automatycznie prawdą o bieżącym kodzie. Każdy punkt tego dokumentu otrzymuje aktualny status i osobną bramkę potwierdzającą.

---

## 4. Słownik statusów i klas dowodu

### 4.1 Status problemu

| Status | Znaczenie |
|---|---|
| `CONFIRMED_OPEN` | problem istnieje w bieżącym kodzie i nie ma kompletnej naprawy |
| `IMPLEMENTED_UNQUALIFIED` | implementacja istnieje, lecz nie ma pełnego aktualnego dowodu |
| `PARTIALLY_FIXED` | część root cause została usunięta, ale kontrakt pozostaje niepełny |
| `BLOCKED_SOURCE_STATE` | dalszy wiarygodny dowód blokuje niestabilny checkout lub merge |
| `BLOCKED_INFRASTRUCTURE` | blokuje środowisko, storage, runtime, mutex lub narzędzia |
| `NOT_VERIFIED` | hipoteza jest rozsądna, ale brak aktualnego testu lub pomiaru |
| `QUALIFIED_BOUNDED` | dokładnie określona krotka scope/backend/device/precision ma receipt |
| `CLOSED` | poprawka i wszystkie wymagane gate'y przeszły na aktualnym źródle |

### 4.2 Poziomy dowodu

| Poziom | Dowód | Czego nie dowodzi |
|---|---|---|
| E0 | odczyt kodu i dokumentacji | kompilacji i runtime |
| E1 | test jednostkowy/source contract | prawdziwego Gmsh, MFEM, GPU i przeglądarki |
| E2 | test integracyjny na hostcie | managed runtime identity i urządzenia |
| E3 | managed CPU runtime | GPU, browser i parity |
| E4 | managed GPU runtime, forced device, bez fallbacku | browser/WebGL i pełnej naukowej macierzy |
| E5 | real browser/WebGL z tym samym MeshIdentity | innych geometrii i parametrów |
| E6 | finalny receipt ze wspólną source/runtime/policy/topology/quality identity | zakresów niewymienionych w receipcie |

### 4.3 Zasada promocji

Status może przejść wyłącznie w kierunku:

```text
source implemented
    -> planner legal
    -> runtime executable
    -> managed runtime confirmed
    -> scientifically validated
    -> production qualified for an exact scope
```

Przejście któregokolwiek wcześniejszego poziomu nie promuje automatycznie kolejnego.

---

## 5. Migawka źródła i środowiska

### 5.1 Aktualna migawka z 2026-08-31 02:23 CEST

```text
HEAD:       e4f653cfaa4505b8659b1ad173b7aec2b67aaad5
branch:     master...origin/master [ahead 0, behind 0]
MERGE_HEAD: absent
REBASE_HEAD: absent
index.lock: absent
unmerged index entries: 0
git status entries: 93 = 87 unstaged + 6 untracked
source snapshot dirty: true
source snapshot sha256: 36eac9f6d0c7d0a0287c52f659f481f1240d1a3ba1b99a5c48ae9b7d5c51ac62
dirty content sha256: 9be36334f611c0b80a39ab38fd17c8b183219783598c5a1e63969f374f432002
runtime manifest: missing
production evidence manifest: missing
historical benchmark artifact: present
```

Wcześniejsza migawka z 02:07 miała `HEAD 5e4c8c6d...`, aktywny `MERGE_HEAD` i stan
ahead/behind. Do 02:23 merge został zakończony i branch wyrównany, lecz liczba wpisów statusu w
czasie audytu wzrosła z 69 do 93. Jest to bezpośredni dowód, że checkout nadal był modyfikowany
równolegle i nie może jeszcze służyć jako finalny baseline kwalifikacyjny.

### 5.2 Konsekwencje

- nie wolno wiązać finalnego receiptu z samym `HEAD`;
- staged i unstaged content muszą wejść do source snapshot identity;
- merge został domknięty, ale wszystkie pozostałe dirty changes muszą zostać świadomie
  zidentyfikowane przez ich właścicieli;
- po ustabilizowaniu drzewa należy ponownie przeliczyć wszystkie hash'e;
- stare runtime'y i benchmarki mogą być dowodem historycznym, ale nie aktualnym;
- żadna zmiana tego dokumentu nie może automatycznie stage'ować setek cudzych plików;
- przed przyszłym commitem trzeba osobno odczytać `git diff --cached --name-only`;
- finalny build musi zostać wykonany po ostatniej zmianie source snapshotu.

### 5.3 Brakujące artefakty końcowe

W chwili ostatniej migawki finalny manifest był niedostępny przez zerwany łańcuch aliasów, a
production evidence nie istniało:

```text
.fullmag/runtimes/fem-gpu-host/manifest.json
.fullmag/reports/fem-meshing-production/evidence.v1.json
```

Pierwsza ścieżka jest logicznym aliasem, nie zwykłym brakującym plikiem: zarówno Windows, jak i
WSL rozwiązywały ją do nieistniejącego worktree-specific targetu. Docelowy plan zakłada naprawę
przez kontrolowany exporter i nowy manifest produkcyjny, a nie ręczne sklejenie symlinków albo
promowanie historycznego bundle.

### 5.4 Stan procesów

Podczas audytu obserwowano:

- aktywny managed FEM/GPU build lub contract run;
- trzy długowieczne kontenery FEM CPU uruchomione od około 13–14 godzin;
- buildx builder działający od wielu godzin;
- brak aktywnego `index.lock`;
- zmienny stan export lock i runtime publication.

Procesy są stanem dynamicznym. Dokument nie autoryzuje ich zatrzymywania. Każde czyszczenie wymaga ponownego read-only inventory i potwierdzenia, że proces nie jest aktywnym zadaniem użytkownika lub innego agenta.

---

## 6. Zakres

### 6.1 W zakresie

- Python mesh authoring DSL;
- Script Builder i round-trip;
- `ProblemIRV04` i `FemMeshPolicyIR`;
- planner i capability resolution;
- universe mesh policy;
- per-object mesh policy;
- interface refinement policy;
- bbox i spherical airbox semantics;
- Gmsh OCC, GEO i STL fallback;
- shared-domain conformity;
- `tet4`, `prism6`, `pyramid5` i planowane `hex8`;
- exact through-thickness layers;
- repair tetów;
- extraction i typed CSR topology;
- quality metrics;
- mixed topology certificate;
- FMMQ;
- persistence i cache;
- source/runtime identity;
- managed FEM CPU/GPU;
- Windows-first launch/build flow;
- API v2;
- Control Room Inspector i viewport;
- browser/WebGL proof;
- performance evidence;
- release receipt.

### 6.2 Poza zakresem tej iteracji

- nowe równania fizyczne;
- wyższy geometryczny rząd elementów niż P1;
- dowolna automatyczna naprawa niepoprawnego CAD;
- ogólny anisotropic metric tensor meshing;
- pełny hybrid FEM/FDM projection;
- przebudowa całej architektury sesji;
- optymalizacja solvera po zakończeniu meshowania;
- przepisywanie Gmsh lub certifiera bez profilu wskazującego bottleneck;
- ciche poszerzanie capability na nowe geometrie;
- silent CPU fallback dla forced GPU;
- destrukcyjne czyszczenie cache lub worktree.

---

## 7. Kontrakt numeryczny

### 7.1 Jednostki

Wszystkie authored długości mają jednostkę SI `m`. Wewnętrzne skalowanie Gmsh nie może zmieniać semantyki publicznego API, fingerprintu policy ani raportowanych progów.

### 7.2 Rodziny elementów

Docelowe rodziny liniowe:

| Rodzina | Liczba węzłów | Zastosowanie |
|---|---:|---|
| `tet4` | 4 | zwykła domena objętościowa i zewnętrzny airbox |
| `prism6` | 6 | dokładne warstwy thin-film w domenie magnetycznej |
| `pyramid5` | 5 | konformalne przejście prism/quad do tet/tri |
| `hex8` | 8 | planowany explicit swept-hex; obecnie bez pełnej implementacji |

Strict mixed-P1 dla obecnego ograniczonego przypadku wymaga:

- `prism6` w domenie magnetycznej;
- `pyramid5` i `tet4` w airboxie;
- braku `tet4` w magnetycznej warstwie strict;
- dokładnej liczby warstw;
- wspólnych globalnych węzłów na interfejsie;
- dozwolonych owner counts;
- różnych markerów po obu stronach `material_interface`;
- dodatniej orientacji;
- braku non-manifold i same-side two-owner faces;
- zgodnego fingerprintu v3;
- zgodnego certificate digest.

### 7.3 Charakterystyczny rozmiar komórki

Kanoniczny gate planuje definicję:

$$
h_K^{\mathrm{edge}} = \max_{(i,j) \in E(K)} \|\mathbf{x}_i - \mathbf{x}_j\|_2.
$$

Historyczne raporty oparte na objętości równoważnej mogą pozostać diagnostyką, ale nie mogą być nazwane `cell.max_edge.v1`.

### 7.4 Wzrost rozmiaru sąsiadów

Dla dwóch komórek dzielących pełną ścianę:

$$
\rho_{KL} = \frac{\max(h_K^{\mathrm{edge}}, h_L^{\mathrm{edge}})}
{\min(h_K^{\mathrm{edge}}, h_L^{\mathrm{edge}})}.
$$

Gate:

$$
\rho_{KL} \le g(1 + \tau_g),
$$

gdzie `g` pochodzi z normalized policy, a `tau_g` jest jawną tolerancją względną. `Mesh.SmoothRatio` jest jedynie wskazówką generatora i nie zastępuje tego pomiaru.

### 7.5 Jacobian i objętość

Każda rodzina musi mieć jawny `metric_definition_id`. Niedopuszczalne jest używanie jednej nazwy dla różnych proxy Gmsh, tetra decomposition i rodzinnej definicji referencyjnej.

Minimalny wspólny kontrakt obejmuje:

- signed Jacobian;
- scaled Jacobian;
- dodatnią objętość;
- edge aspect ratio;
- family-defined skewness;
- worst ordinal i centroid;
- dystrybucje per family, marker i scope.

### 7.6 Airbox distance bands

Wymagane są co najmniej pasma near, transition i far. Dla bbox osobno należy sprawdzić:

- surface distance;
- edge distance;
- corner distance;
- każdą stronę prostokątnego airboxa;
- niepuste populacje;
- monotoniczny trend p50 i p95;
- osiągnięcie far targetu w tolerancji.

### 7.7 Exact layers

Exact layers oznacza dokładną liczbę elementów przez grubość. Nie oznacza automatycznie:

- structured mesh in-plane;
- identycznych prismów w całej domenie;
- hexahedral topology;
- stałego rozmiaru w płaszczyźnie;
- jakości spełniającej gate.

---

## 8. Mapa pipeline'u

```text
Python DSL / Control Room
        |
        v
SceneDocument / Script Builder
        |
        v
ProblemIRV04 + FemMeshPolicyIR
        |
        v
Planner + capability decision
        |
        v
Python mesh realization request
        |
        +--> OCC direct shared-domain
        +--> strict swept Box mixed-P1
        +--> ordinary tetrahedral OCC
        +--> GEO / imported STL fallback
        |
        v
Gmsh fields + generate
        |
        v
repair -> extraction -> typed MeshData CSR
        |
        v
quality report + topology certificate
        |
        v
persistence/cache + MeshIR/native preflight
        |
        v
FEM CPU / forced FEM GPU
        |
        v
API resources + FMMQ + Control Room
        |
        v
managed CPU/GPU/browser evidence
        |
        v
production receipt
```

Każda strzałka jest granicą kontraktu i musi mieć co najmniej jeden pozytywny oraz jeden negatywny test.

---

## 9. Co zostało naprawione

### 9.1 Direct OCC/swept route

SP4 nie musi przechodzić przez kosztowną, tracącą semantykę ścieżkę powierzchniową STL/Trimesh. Ograniczony Box + bbox airbox może użyć bezpośredniego shared-domain generatora.

Główne miejsca:

- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`.

### 9.2 Transition shell airboxa

Naprawiono przypadek, w którym cienki transition shell utrzymywał bardzo drobny target przez znaczną część airboxa i prowadził do nadmiernej liczby komórek.

Dodana polityka:

- rozszerza shell tylko przy rzeczywiście dużym skoku targetu;
- ogranicza rozszerzenie dostępnym clearance;
- zachowuje historyczną politykę dla małych skoków;
- rozpoczyna far-field grading od kontrolowanego targetu.

### 9.3 Repair tetów

Naprawiono lub ograniczono:

- powtarzane obliczenia geometrii tej samej ściany;
- globalną optymalizację apexów, gdy jakość już przechodzi;
- powtórne pełne skany degeneracji między repair i optimizerem;
- niepotrzebne wywołania repair, gdy lokalny bounded repair wystarcza.

### 9.4 Certyfikacja i persistence

Wdrożono:

- native certificate/preflight;
- trusted topology context;
- mutation guard między native preflight i trusted construction;
- attach certificate bez ponownego pełnego Python CSR validation po poprawnym native audit;
- reuse native certificate result podczas zapisu;
- trusted cached load z fail-closed fallbackiem do pełnego audytu;
- fingerprint v3 parity między Python i Rust dla wspieranego mixed scope.

### 9.5 Cache

W bieżącym kodzie istnieje persistent shared-domain mesh cache i trusted artifact path. Nie oznacza to jeszcze zamknięcia pełnej macierzy concurrency, worktree isolation, invalidation i corruption recovery.

### 9.6 Pomiar kanonicznego przypadku

Historyczny artefakt:

```text
C:\git\fullmag\mesh-benchmark-current3\result.json
```

zawiera:

| Metryka | Wartość |
|---|---:|
| total | 21.18932983 s |
| Gmsh generate | 10.735860658 s |
| repair | 1.493581116 s |
| extraction | 0.299460234 s |
| Python certificate | 1.880587142 s |
| serialize | 2.359122632 s |
| nodes | 48,784 |
| cells | 197,491 |
| facets | 77,674 |

Porównywalny historyczny czas 111.79 s daje:

```text
speedup = 5.2758x
reduction = 81.045%
```

### 9.7 Jakość zmierzonego przypadku

| Gate | Wartość |
|---|---:|
| non-manifold faces | 0 |
| same-side two-owner faces | 0 |
| relative volume error | 0 |
| requested/realized layers | 1/1 |
| prism6 p05 scaled Jacobian | 0.2664693550 |
| pyramid5 p05 scaled Jacobian | 0.2874389346 |
| tet4 p05 scaled Jacobian | 0.2486317009 |
| topology fingerprint v3 | `7892558513047d2e1b74001f79346135cb29b0f6b9a0dcb9dd832b278f332025` |

### 9.8 Ograniczenia tego dowodu

Artefakt pochodzi z wcześniejszego, brudnego snapshotu źródła. Nie jest końcowym receiptem obecnego `HEAD`. Zawiera tylko jeden cold run i status `baseline_recorded`, a nie finalną promocję release. Nie obejmuje pełnej macierzy S1–S13 ani browser proof.

---

## 10. Zasady dalszej pracy

1. Nie optymalizować bez stage timings.
2. Nie zmieniać liczby elementów jako celu samego w sobie.
3. Nie osłabiać quality gate w celu skrócenia czasu.
4. Nie ukrywać fallbacku.
5. Nie używać starego manifestu z innego source snapshotu.
6. Nie wykonywać finalnego builda na zmieniającym się checkoutcie.
7. Nie kasować cache bez jawnej zgody i kontroli aktywnych procesów.
8. Nie używać WSL jako właściciela checkoutu Windows.
9. Nie nazywać hostowego smoke testu managed qualification.
10. Nie promować capability bez exact-scope receipt.
11. Nie wdrażać Rust/Rayon tylko dlatego, że kod Python jest duży.
12. Nie przepisywać działających kontraktów mixed topology bez testu parity.
13. Nie stage'ować całego repo podczas aktywnego merge bez osobnego inventory.
14. Każda faza musi mieć rollback i stop condition.
15. Każdy finalny wynik musi wskazywać source, runtime, policy, topology, quality i workload identity.

---

## 11. Rejestr problemów — indeks

### 11.1 Problemy meshera

| ID | Priorytet | Status skrócony | Temat |
|---|---:|---|---|
| FM-MESH-001 | P0 | `IMPLEMENTED_UNQUALIFIED` | hard gate wzrostu istnieje, brak świeżego production receipt |
| FM-MESH-002 | P0 | `PARTIALLY_FIXED` | brak wspólnej pełnej bramki jakości |
| FM-MESH-003 | P0 | `PARTIALLY_FIXED` | utrata `sweep_direction` |
| FM-MESH-004 | P0 | `PARTIALLY_FIXED` | niespójna walidacja UI/API/Python |
| FM-MESH-005 | P0 | `BLOCKED_SOURCE_STATE` | brak samodzielnego production receipt |
| FM-MESH-006 | P1 | `PARTIALLY_FIXED` | niepełny cutover na jedno policy IR |
| FM-MESH-007 | P1 | `PARTIALLY_FIXED` | brak statystyk per family/region/scope |
| FM-MESH-008 | P1 | `PARTIALLY_FIXED` | brak rodzinnych aspect/skew gates |
| FM-MESH-009 | P1 | `IMPLEMENTED_UNQUALIFIED` | FMMQ v1 bez topology/order identity |
| FM-MESH-010 | P1 | `IMPLEMENTED_UNQUALIFIED` | cache bez pełnej kwalifikacji concurrency/invalidation |
| FM-MESH-011 | P1 | `PARTIALLY_FIXED` | deterministyczność poza strict mixed |
| FM-MESH-012 | P1 | `PARTIALLY_FIXED` | słabszy native material-interface guard |
| FM-MESH-013 | P1 | `PARTIALLY_FIXED` | niepełna parytetowość UI thin-film/prism |
| FM-MESH-014 | P1 | `PARTIALLY_FIXED` | rozproszona obserwowalność jakości |
| FM-MESH-015 | P1 | `CONFIRMED_OPEN` | drift dokumentacji i statusów |
| FM-MESH-016 | P1 | `CONFIRMED_OPEN` | różna semantyka prism między geometriami |
| FM-MESH-017 | P2 | `PARTIALLY_FIXED` | błąd jakości redukowany do tekstu |
| FM-MESH-018 | P1 | `PARTIALLY_FIXED` | słabsze gwarancje po fallbacku OCC/STL |
| FM-MESH-019 | P0 | `IMPLEMENTED_UNQUALIFIED` | growth law jest aktywną bramką publikacji, brak runtime qualification |
| FM-MESH-020 | P2 | `NOT_VERIFIED` | niegładki bbox envelope na tie surfaces |
| FM-MESH-021 | P0 | `IMPLEMENTED_UNQUALIFIED` | próg sliver tet Python/Rust |
| FM-MESH-022 | P1 | `PARTIALLY_FIXED` | `swept_hex` deklarowany, lecz niewdrożony |
| FM-MESH-023 | P1 | `PARTIALLY_FIXED` | `SharedMeshAssemblyPolicy` częściowo compatibility-only |
| FM-MESH-024 | P1 | `CONFIRMED_OPEN` | publiczne `MeshOperation` nie mają executora |
| FM-MESH-025 | P0/P1 | `CONFIRMED_OPEN` | assembly policy jest walidowana, lecz nie steruje realizacją |
| FM-MESH-026 | P0 | `PARTIALLY_FIXED` | non-finite i ciche numeric coercion |
| FM-MESH-027 | P1 | `PARTIALLY_FIXED` | `sweep_source/destination` bez konsumenta |
| FM-MESH-028 | P0 | `IMPLEMENTED_UNQUALIFIED` | brak physical tag maskowany markerem `1` |
| FM-MESH-029 | P0 | `PARTIALLY_FIXED` | heurystyczna identity komponentów po fallbacku |
| FM-MESH-030 | P1 | `PARTIALLY_FIXED` | sphere airbox może zostać zastąpiony bboxem |
| FM-MESH-031 | P1 | `PARTIALLY_FIXED` | mixed-periodic Python/native contract drift |
| FM-MESH-032 | P1 | `IMPLEMENTED_UNQUALIFIED` | legacy quality validator jest tet4-only |
| FM-MESH-033 | P1 | `IMPLEMENTED_UNQUALIFIED` | cleanup tetów unieważnia per-domain quality |
| FM-MESH-034 | P1 | `IMPLEMENTED_UNQUALIFIED` | brak length/finite guards dla Gmsh quality |
| FM-MESH-035 | P0 | `IMPLEMENTED_UNQUALIFIED` | API FMMQ sprawdza magic, nie artifact identity |
| FM-MESH-036 | P2 | `IMPLEMENTED_UNQUALIFIED` | FMMQ writer nie publikuje atomowo |
| FM-MESH-037 | P1 | `PARTIALLY_FIXED` | preview FEM ignoruje `study_universe` |
| FM-MESH-038 | P1 | `IMPLEMENTED_UNQUALIFIED` | effective Gmsh algorithm może różnić się od requested |

### 11.2 Problemy źródła, Windows i runtime

| ID | Priorytet | Status skrócony | Temat |
|---|---:|---|---|
| FM-OPS-001 | P0 | `PARTIALLY_FIXED` | merge zamknięty, lecz worktree nadal dynamiczny |
| FM-OPS-002 | P0 | `PARTIALLY_FIXED` | branch wyrównany, lecz brak clean release baseline |
| FM-OPS-003 | P0 | `BLOCKED_SOURCE_STATE` | source identity zależne od aktywnie zmienianego drzewa |
| FM-OPS-004 | P0 | `BLOCKED_INFRASTRUCTURE` | brak aktualnego managed FEM manifestu |
| FM-OPS-005 | P0 | `BLOCKED_INFRASTRUCTURE` | współdzielone cache/build root między worktree |
| FM-OPS-006 | P1 | `BLOCKED_INFRASTRUCTURE` | długowieczne kontenery i niejasna własność procesów |
| FM-OPS-007 | P1 | `PARTIALLY_FIXED` | manifesty native Windows i hash drift |
| FM-OPS-008 | P1 | `PARTIALLY_FIXED` | sprzeczny kontrakt opcjonalnego Nsight |
| FM-OPS-009 | P1 | `BLOCKED_INFRASTRUCTURE` | niepełne hostowe środowisko testowe |
| FM-OPS-010 | P0 | `CONFIRMED_OPEN` | brak atomowej promocji runtime/evidence |
| FM-OPS-011 | P0 | `CONFIRMED_OPEN` | zerwany łańcuch aliasów managed runtime |
| FM-OPS-012 | P0 | `CONFIRMED_OPEN` | globalne Compose/state/build roots między worktree |
| FM-OPS-013 | P0 | `PARTIALLY_FIXED` | automatyczny prune bez obowiązkowego dry-run |
| FM-OPS-014 | P1 | `PARTIALLY_FIXED` | root npm lockfile usunięty; pinned Corepack bootstrap pozostał |
| FM-OPS-015 | P1 | `CONFIRMED_OPEN` | Git ownership/safe.directory różni się między hostami |
| FM-OPS-016 | P1 | `CONFIRMED_OPEN` | Control Room output zapisywany w checkoutcie |
| FM-OPS-017 | P0 | `CONFIRMED_OPEN` | brak mostu schema 2 Windows -> schema 3 managed |

### 11.3 Problemy kwalifikacji

| ID | Priorytet | Status skrócony | Temat |
|---|---:|---|---|
| FM-QUAL-001 | P0 | `PARTIALLY_FIXED` | v1 verifier ma containment/digest gates, brak pełnego v2 |
| FM-QUAL-002 | P0 | `CONFIRMED_OPEN` | brak pełnej macierzy S1–S13 |
| FM-QUAL-003 | P0 | `CONFIRMED_OPEN` | brak wspólnego managed CPU/GPU proof |
| FM-QUAL-004 | P0 | `CONFIRMED_OPEN` | brak browser/WebGL proof |
| FM-QUAL-005 | P0 | `IMPLEMENTED_UNQUALIFIED` | brak FMMQ v2 |
| FM-QUAL-006 | P1 | `CONFIRMED_OPEN` | brak pełnej parity policy/topology/quality |
| FM-QUAL-007 | P1 | `CONFIRMED_OPEN` | brak determinism matrix |
| FM-QUAL-008 | P1 | `CONFIRMED_OPEN` | brak cold/warm performance gate |
| FM-QUAL-009 | P1 | `CONFIRMED_OPEN` | brak capability promotion tied to receipt |
| FM-QUAL-010 | P0 | `CONFIRMED_OPEN` | brak clean-tree final qualification |

Łącznie rejestr zawiera 65 śledzonych problemów: 38 dotyczących meshera i jego kontraktów,
17 dotyczących źródła/Windows/runtime oraz 10 dotyczących kwalifikacji. Część wpisów dzieli
wspólną przyczynę, ale pozostaje osobna, gdy ma innego właściciela, artefakt lub test akceptacyjny.

---

## 12. Szczegółowy rejestr problemów meshera

Każdy wpis w tym rozdziale jest zadaniem wykonawczym, a nie ogólną sugestią. Status `CLOSED`
wolno nadać dopiero po przejściu wymienionej bramki na jednym, niezmienionym source snapshotcie.

### 12.1 FM-MESH-001 — brak zmierzonego ograniczenia wzrostu sąsiadów

- Priorytet: `P0`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Aktualizacja 2026-08-31: `remesh_cli._mesh_result_payload` wywołuje
  `validate_adjacent_size_growth`, więc przekroczenie limitu albo brak mierzalnej
  pary kończy się `MeshGrowthValidationError` przed publikacją topology/FMMQ;
  sama bramka jest wykonywana przed utworzeniem jakiegokolwiek artefaktu, więc
  odrzucony wynik nie zostawia częściowego pliku.
  Nadal brakuje świeżego managed receipt z rzeczywistą siatką S13.
- Warstwa: generator, certifier, quality resource.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` +
  `apply_mesh_options`; `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`
  + `(canonical-fem-mesh-policy)`.
- Objaw: generator ustawia `Mesh.SmoothRatio`, ale wynikowa siatka nie jest sprawdzana przez
  relację $\rho_{KL}$ dla komórek dzielących pełną ścianę.
- Przyczyna: wartość sterująca generatorem została potraktowana jak metryka wyniku.
- Ryzyko: gwałtowny skok rozmiaru może przejść gate mimo poprawnego przebiegu Gmsh.
- Naprawa: wyznaczyć ściany, owner pairs, $h_K^{\mathrm{edge}}$ i $\rho_{KL}$; zapisać
  rozkład per scope/region/family oraz worst pair.
- Testy: syntetyczny PASS na równomiernej siatce, kontrolowany FAIL ponad progiem, tolerance
  boundary, mixed-family interface i tamper test.
- Gate: `max(adjacent_size_growth) <= resolved_growth_rate * (1 + tolerance)` dla każdego
  kwalifikowanego scope; brak danych oznacza FAIL, a nie `unknown`.
- Stop condition: nie stroić `SmoothRatio`, dopóki pomiar post-mesh nie pokaże rzeczywistego
  rozkładu i miejsca naruszenia.

### 12.2 FM-MESH-002 — brak jednego family-aware quality gate

- Priorytet: `P0`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` +
  `MixedLayerTopologyCertificate`; `crates/fullmag-ir/src/mixed_certificate.rs`.
- Stan istniejący: certyfikat mixed topology sprawdza ważne inwarianty topologiczne, ale nie
  zastępuje kompletnego gate'u jakości wszystkich rodzin.
- Brak: wspólne reguły dla `tet4`, `prism6`, `pyramid5` i przyszłego `hex8`, z jawnym
  `metric_definition_id`.
- Ryzyko: dobra wartość zagregowana może ukryć złą rodzinę, region albo cienką strefę.
- Naprawa: zbudować `FamilyQualitySummaryV2` i oceniać minimum, percentyle, liczbę naruszeń,
  histogram oraz worst ordinals osobno dla każdej rodziny i scope.
- Testy: osobny negatywny fixture dla odwróconego elementu, slivera, złego aspect ratio,
  family mismatch i brakującego kanału.
- Gate: wszystkie wymagane kanały istnieją i przechodzą progi; `NaN`, brak rodziny lub pusty
  zakres kwalifikowany jest FAIL.

### 12.3 FM-MESH-003 — utrata `sweep_direction`

- Priorytet: `P0`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` +
  `_mesh_options_from_runtime_metadata`; `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
  + `MeshOptions`.
- Objaw: authoring i część IR akceptują `sweep_direction`, lecz runtime lowering do
  `MeshOptions` nie zachowuje pola w całej ścieżce.
- Przyczyna: dwa modele opcji mają różne zbiory pól.
- Ryzyko: użytkownik żąda osi `x` albo `y`, a generator rozwiązuje lub przyjmuje inną oś.
- Naprawa: dodać typed requested/resolved sweep axis do jednej polityki i usunąć rekonstrukcję
  z luźnego metadata.
- Testy: round-trip `x/y/z/auto`, permutacje wymiarów Box, rotowana geometria, malformed enum,
  konflikt authoring/legacy metadata.
- Gate: authored, normalized, planned, generated i certified axis są identyczne albo plan
  kończy się jawnym structured rejection.
- Aktualizacja 2026-08-31: `MeshOptions.sweep_direction` jest zachowywane przez lowering,
  generator rozwiązuje je przez jeden typed resolver, a raport niesie requested/resolved axis.
  Testy obejmują `x/y/z/auto`, niedozwoloną oś cylindra i named selector rejection. Nadal brak
  pełnego managed receipt dla wszystkich geometrii i round-trip UI/Rust.

### 12.4 FM-MESH-004 — niespójna walidacja UI, API, Python i Rust

- Priorytet: `P0`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` +
  `_coerce_positive_float`; `crates/fullmag-ir/src/mesh_policy.rs`; formularze Script Builder.
- Objaw: niepoprawna liczba może zostać zamieniona na `None`, podczas gdy inna warstwa ją
  odrzuca albo interpretuje jako default.
- Przyczyna: walidacja jest kopiowana zamiast generowana z jednego kontraktu.
- Ryzyko: silent default, różne fingerprinty i niemożliwy do odtworzenia rezultat.
- Naprawa: jeden zbiór typów, enumów, zakresów, zależności i kodów błędów; adapter legacy może
  tylko mapować albo odrzucać.
- Testy: `null`, missing, zero, liczba ujemna, `NaN`, `Inf`, string, wartość graniczna,
  konflikt dwóch źródeł i nieznane pole.
- Gate: ta sama macierz wejść daje tę samą klasę wyniku w UI, API, Python i Rust.
- Aktualizacja 2026-08-31: wspólne strict parsers (`parse_finite_float`, `parse_integer`,
  `parse_bool`, `parse_vector3`) i `MeshOptions.__post_init__` odrzucają non-finite, bool jako
  liczbę oraz ułamkowe integer controls. Pozostaje wygenerowanie/udowodnienie identycznej
  macierzy w formularzu UI, API i Rust.

### 12.5 FM-MESH-005 — gate nie tworzy samowystarczalnego production receipt

- Priorytet: `P0`.
- Status: `BLOCKED_SOURCE_STATE`.
- Źródła: `scripts/verify_fem_meshing_production.py` + entry point;
  `docs/physics/0105-fem-meshing-production-acceptance.md` + macierz S1–S13.
- Objaw: częściowe wyniki i logi mogą przejść lokalne kroki, ale nie składają się w jeden
  atomowy, weryfikowalny receipt.
- Przyczyna: gate powstawał inkrementalnie i nie był jedynym właścicielem promocji.
- Naprawa: jeden orchestrator generuje snapshot before/after, runtime manifests, policy,
  topology, FMMQ, CPU/GPU, API i browser evidence, a następnie seal index.
- Testy: brak pliku, hash mismatch, source drift w trakcie, stale runtime, CPU fallback,
  zerwany browser proof, modyfikacja artefaktu po seal.
- Gate: niezależny verifier przechodzi na skopiowanym evidence bundle bez dostępu do cache.

### 12.6 FM-MESH-006 — niepełny cutover na kanoniczne policy IR

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `crates/fullmag-ir/src/mesh_policy.rs` + `FemMeshPolicyIR`;
  `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`.
- Stan istniejący: `FemMeshPolicyIR` i fingerprint już istnieją.
- Brak: pełne wyłączenie aktywnego legacy metadata i dowód, że każda opcja ma jednego
  konsumenta.
- Ryzyko: dwa równoległe źródła prawdy, różna normalizacja i cache key.
- Naprawa: inventory wszystkich czytników, telemetryczny licznik użycia adaptera legacy,
  etap deprecation, następnie fail-closed cutover.
- Testy: golden normalized IR, unknown-field rejection, legacy parity i test braku podwójnego
  zastosowania opcji.
- Gate: generator przyjmuje wyłącznie resolved plan wyprowadzony z jednego policy IR.

### 12.7 FM-MESH-007 — brak pełnych statystyk per family, region i scope

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Problem: globalne minimum i liczność nie mówią, czy naruszenie leży w filmie, transition
  shell, interface czy dalekim airboxie.
- Naprawa: każda metryka ma osie `family`, `material_region`, `mesh_role`, `zone` i opcjonalnie
  `interface_id`.
- Wymagany wynik: count, min, p01, p05, p50, p95, max, violation count i bounded worst list.
- Testy: ta sama zła komórka musi pojawić się w dokładnie jednym family/region/scope bucket.
- Gate: suma scoped counts zgadza się z liczbą elementów i nie ma nieprzypisanych elementów.
- Aktualizacja 2026-08-31: Python `build_typed_quality_summary` publikuje deterministyczne
  buckety `family|marker|role|zone`, count/min/percentyle/max oraz bounded worst ordinals.
  Brakuje jeszcze pełnego `interface_id`/zone taxonomy i niezależnego Rust/API receipt.

### 12.8 FM-MESH-008 — brak rodzinnych aspect/skew gates

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Problem: aspect ratio i skewness nie mają jednej uniwersalnej definicji dla wszystkich rodzin.
- Naprawa: zdefiniować family-specific metric IDs i progi w policy; nie mapować różnych proxy
  na jedną nazwę.
- Testy: element idealny, rozciągnięty, skręcony, odwrócony i blisko zera dla każdej rodziny.
- Gate: implementacja Python i Rust daje wynik w uzgodnionej tolerancji na golden fixtures.
- Stop condition: brak publikacji progu bez równania, jednostki `$1$` i domeny ważności.
- Aktualizacja 2026-08-31: Python quality engine ma jawne metric IDs
  `edge_aspect.<family>.v1` i `skewness.<family>.v1`, finite guards i threshold dispatch per
  family. Równania/progi nie są jeszcze wspólnym Python/Rust golden contractem, dlatego brak
  awansu do qualification.

### 12.9 FM-MESH-009 — FMMQ v1 nie niesie pełnej identity mixed topology

- Priorytet: `P1`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródła: `crates/fullmag-api/src/fem_cross_section.rs` +
  `per_element_quality_metric_from_fmmq`; `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`
  + `(fmmq-v2-contract)`.
- Objaw: aktywny reader wymaga wersji `1`; nagłówek nie wiąże pełnej family table, ordinals,
  policy fingerprint, topology fingerprint i mesh revision.
- Naprawa: dodać FMMQ v2 jako nowy format; v1 pozostawić tylko jako jawny legacy read path.
- Testy: byte-layout golden, endian, bounds, offset overlap, unknown metric, family mismatch,
  wrong fingerprint, stale revision i mutation/tamper.
- Gate: v2 verifier odrzuca payload poprawny strukturalnie, ale związany z inną siatką.
- Aktualizacja 2026-08-31: writer/parser v2 przenosi family table, ordinals, policy/topology
  fingerprint, mesh revision, per-channel checksum i whole-payload digest; API ma
  `validate_fmmq_v2_payload`. v1 pozostaje jawnie legacy, a brak aktualnego managed receipt
  utrzymuje status `IMPLEMENTED_UNQUALIFIED`.

### 12.10 FM-MESH-010 — cache istnieje, lecz nie ma pełnej kwalifikacji

- Priorytet: `P1`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródła: `packages/fullmag-py/src/fullmag/model/problem.py` + `_fem_mesh_cache_key`;
  `packages/fullmag-py/src/fullmag/meshing/persistence.py`.
- Stan istniejący: persistent mesh cache i trusted cached artifact fast path są zaimplementowane.
- Brak: kompletna macierz invalidacji, odporność na konkurencję, worktree isolation i dowód, że
  trusted reload nadal wykonuje native structural preflight.
- Naprawa: wersjonowany canonical cache key, atomic temp-to-final promotion, lock owner metadata,
  quarantine uszkodzonych wpisów i namespace source snapshotu.
- Testy: zmiana geometrii, import bytes, polityki, regionów, Gmsh version, certifier version,
  schema, source snapshotu; dwóch writerów i interrupted writer.
- Gate: żaden zmieniony składnik nie daje false hit, a warm hit zachowuje digest i preflight.

### 12.11 FM-MESH-011 — deterministyczność nie jest wykazana globalnie

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Stan istniejący: strict mixed ma fingerprint v3 i wybrane testy certifiera.
- Brak: macierz Gmsh/certifier/cache dla liczby wątków i powtórzeń.
- Naprawa: jawne sortowanie, stabilne ordinals, canonical float encoding i kontrola seedów/opcji
  generatora.
- Testy: Rayon `1/2/4/8`, dziesięć powtórzeń, cold/warm oraz dwa niezależne katalogi build.
- Gate: identyczne topology fingerprint, family counts, certificate digest i FMMQ digest.

### 12.12 FM-MESH-012 — słabszy native material-interface guard

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Problem: Python certificate sprawdza więcej semantyki owner/marker/interface niż minimalny
  native structural preflight.
- Ryzyko: artefakt może być strukturalnie poprawny, ale semantycznie połączyć zły materiał.
- Naprawa: przenieść jednoznaczne inwarianty marker-owner-interface do współdzielonego Rust
  certifiera i wywoływać je z native loadera.
- Testy: same-side owners, equal markers across material interface, missing role, wrong owner count.
- Gate: Python, Rust i native loader odrzucają te same uszkodzone fixtures.

Aktualizacja 2026-08-31: natywny MFEM builder odrzuca już material-interface facet
bez dokładnie dwóch ownerów oraz facet łączący dwa elementy z identycznym markerem
(w tym dwa elementy po obu stronach oznaczone jako ta sama domena). Dodano regresję
`malformed_face_ownership_and_marker_inputs_fail_closed` w
`backends/fem/tests/fem_mixed_p1_contract.cpp`. Pozostaje parity z Rust certifierem,
walidacja wszystkich wejść przez wspólny helper oraz managed CPU/GPU receipt; dlatego
status pozostaje `PARTIALLY_FIXED`, a nie `IMPLEMENTED_UNQUALIFIED`.

### 12.13 FM-MESH-013 — niepełna parytetowość thin-film w UI

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Problem: UI może prezentować część opcji thin-film/prism bez pełnego round-trip i statusu
  legalności backendu.
- Naprawa: UI edytuje typed requested policy, pokazuje resolved plan, nie ukrywa fallbacku i
  zachowuje sweep/layers/strategy w eksporcie skryptu.
- Testy: form -> JSON -> Python export -> IR -> form; unsupported combination i unknown enum.
- Gate: semantic diff round-trip jest pusty dla wszystkich kwalifikowanych pól.

### 12.14 FM-MESH-014 — rozproszona obserwowalność jakości

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Problem: raport build, certyfikat, FMMQ, API i Inspector mogą pokazywać różne wycinki danych.
- Naprawa: jeden immutable quality resource z identyfikatorem artefaktu; widoki API/UI są tylko
  projekcjami, nie ponownym liczeniem jakości.
- Testy: schema/OpenAPI/generated types, stale revision, missing artifact, range request i
  consistency między summary a payload.
- Gate: każda prezentowana liczba ma wskazanie metric ID, scope i digest źródłowego FMMQ.

### 12.15 FM-MESH-015 — drift dokumentacji i statusów

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Przykład: historyczne raporty deklarują S1–S12 jako produkcyjne, podczas gdy nowsze noty
  `0105`, `0106` i ADR 0027 wymagają dodatkowych gate'ów.
- Naprawa: oznaczyć stare raporty `HISTORICAL`, dodać supersession links i generować status
  capability z sealed receipt.
- Testy: link checker, status consistency checker i dokumentacyjny source-map validator.
- Gate: nie istnieją dwie aktualne strony z przeciwnym statusem tej samej lane.

### 12.16 FM-MESH-016 — zależna od geometrii semantyka prism

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Problem: `swept_prism` może znaczyć strict prism body dla Box, lecz inną lub niepełną ścieżkę
  dla innych geometrii.
- Naprawa: capability key musi obejmować geometry family, topology strategy, layer bounds i
  airbox mode; nazwa bez tej krotki nie promuje wsparcia.
- Testy: Box, Cylinder, flat ArchWaveguide, curved ArchWaveguide i imported geometry.
- Gate: każda nieobsługiwana geometria jest jawnie rejected lub degraded, nigdy cicho tetra.

### 12.17 FM-MESH-017 — błąd jakości redukowany do tekstu

- Priorytet: `P2`.
- Status: `PARTIALLY_FIXED`.
- Problem: tekstowy wyjątek nie daje UI ani CI stabilnego kodu, scope i worst elements.
- Naprawa: `MeshQualityFailureV2` z code, metric, threshold, observed, family, region, zone,
  element ordinals, policy/topology identity i evidence path.
- Testy: serializacja, OpenAPI, unknown code compatibility i redaction ścieżek hosta.
- Gate: każdy quality FAIL daje walidowalny JSON oraz czytelny komunikat człowiekowi.

Aktualizacja 2026-08-31: Python quality/extraction exceptions implementują
`to_dict()` w wersji `mesh_quality_failure.v2` dla threshold, non-finite,
adjacent-growth, physical-tag coverage i topology-mutation failures. Koperta
zawiera stabilny `code`, `pointer`, `metric_id`, comparator, observed/threshold,
bounded ordinals oraz details; threshold path przekazuje również policy/topology
fingerprint i evidence path. Pełna OpenAPI/UI projection oraz niezależny
managed receipt pozostają niezakwalifikowane.

### 12.18 FM-MESH-018 — niepełne gwarancje po fallbacku OCC/STL

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Problem: fallback może utracić component identity, dokładne interfejsy albo obietnicę swept
  topology.
- Naprawa: klasy `exact`, `degraded` i `unsupported`; każda ścieżka raportuje utracone gwarancje
  i nie dziedziczy statusu exact.
- Testy: broken OCC, single STL, concatenated STL, multiple components i marker preservation.
- Gate: receipt zawiera realization class, a `degraded` nie może promować strict S13.

### 12.19 FM-MESH-019 — akceptowany parametr może nie sterować gradingiem

- Priorytet: `P0`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Aktualizacja 2026-08-31: zadeklarowany `growth_rate` jest walidowany po
  generacji przez pełny face-neighbor scan i nie może zostać opublikowany jako
  sam hint Gmsh. Brak jeszcze wielokrotnego runtime proof dla fixture'ów S1–S13.
- Problem: `growth_rate <= 1` może zostać przyjęte, a grading wyłączony albo sprowadzony do
  niejawnego defaultu.
- Naprawa: domena publiczna musi być jednoznaczna: odrzucić wartość, aktywnie ją realizować albo
  zwrócić `degraded/not_qualified`.
- Testy: wartości poniżej, równe i powyżej `1`, granica tolerancji i round-trip.
- Gate: każda zaakceptowana wartość występuje w resolved plan, generator report i post-mesh gate.

### 12.20 FM-MESH-020 — bbox envelope na powierzchniach remisowych

- Priorytet: `P2`.
- Status: `NOT_VERIFIED`.
- Hipoteza: wybór najbliższej powierzchni bbox może być niegładki na miejscach równych
  odległości i zmieniać lokalne pole rozmiaru.
- Najpierw: stworzyć negatywny fixture i mapę pola; bez reprodukcji nie zmieniać algorytmu.
- Możliwa naprawa: jawny min-envelope wszystkich aktywnych powierzchni z deterministycznym tie
  handlingiem.
- Gate: ciągłość lub jawnie ograniczony skok, stabilny fingerprint i brak regresji czasu.

### 12.21 FM-MESH-021 — próg sliver tet Python/Rust

- Priorytet: `P0`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` + degeneracy/repair path;
  odpowiadający determinant floor w Rust.
- Stan istniejący: lokalna poprawka uwzględnia fizyczny floor `1e-30 / 6` i dodaje regresję dla
  slivera w skali SI.
- Ryzyko: poprawka jest w zmiennym, niezakwalifikowanym drzewie; brak pytest w hostowym Pythonie
  uniemożliwił pełne wykonanie testu.
- Naprawa: zachować jeden jawny wzór tolerancji, golden cases w kilku skalach i parity Python/Rust.
- Gate: targeted tests przechodzą w repo-owned environment, managed benchmark zachowuje jakość,
  a żadna poprawna mała komórka nie jest fałszywie naprawiana.

### 12.22 FM-MESH-022 — `swept_hex` deklarowany, lecz niewdrożony

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` +
  `SWEEP_STRATEGY_HEX` i jawny rejection explicit realization.
- Problem: enum/API sugeruje strategię, której body-only path nie realizuje.
- Decyzja wymagana: albo usunąć ją z publicznej capability, albo wdrożyć `hex8` end-to-end.
- Minimalna bezpieczna naprawa: fail-closed już w plannerze przed uruchomieniem Gmsh.
- Pełna naprawa: topology IR, extraction, quality metrics, certifier, MFEM CPU/GPU i UI.
- Gate: brak powierzchni, na której opcja wygląda na produkcyjnie dostępną bez receipt.
- Aktualizacja 2026-08-31: body-only generator odrzuca `swept_hex` jawnie przed Gmsh zamiast
  cicho emitować prism/tet. Implementacja `hex8` i osobny receipt pozostają otwarte.

### 12.23 FM-MESH-023 — `SharedMeshAssemblyPolicy` jako compatibility-only

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Źródło: `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` +
  `build_size_field_plan`, gdzie argument pozostaje dla kompatybilności API.
- Problem: typ publiczny może sugerować aktywną semantykę, mimo że resolved plan czerpie ją z
  innego źródła.
- Naprawa: udokumentować adapter, dodać telemetrykę użycia, deprecate i usunąć po jednym cyklu
  migracji albo przywrócić mu jednoznaczne typed lowering.
- Testy: legacy parity, warning contract i brak wpływu martwego argumentu na fingerprint.
- Gate: nie istnieje publiczny parametr, który wygląda na aktywny, ale jest ignorowany.

### 12.24 FM-MESH-024 — publiczne `MeshOperation` nie mają executora

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Źródła: `packages/fullmag-py/src/fullmag/model/discretization.py` + `MeshOperation`;
  `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` +
  `_validate_declared_mesh_operations`; `crates/fullmag-plan/src/validate.rs`.
- Objaw: DSL/UI może zapisać `refine`, `smooth`, `optimize` lub regionową politykę, ale
  shared-domain pipeline odrzuca operację dopiero przed generacją.
- Ryzyko: interfejs autoryzuje zamiar, którego planner/runtime nie potrafi wykonać.
- Naprawa: wdrożyć typed executor i receipt semantics albo usunąć/wyłączyć authoring dla
  niewspieranych operacji.
- Testy: każda operation kind ma planner capability PASS albo wczesny stable rejection.
- Gate: użytkownik nie może skonstruować planu oznaczonego legalnym, który później odpada tylko
  dlatego, że executor nie istnieje.

### 12.25 FM-MESH-025 — assembly policy jest walidowana, lecz nie steruje realizacją

- Priorytet: `P0/P1` zależnie od pola.
- Status: `CONFIRMED_OPEN`.
- Źródła: `packages/fullmag-py/src/fullmag/model/discretization.py` +
  `SharedMeshAssemblyPolicy`; `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`.
- Potwierdzone pola ryzyka: `interface_hmax_factor`, `airbox_hmax_factor`,
  `enforce_conforming`.
- Związek z FM-MESH-023: 023 opisuje mylący compatibility API; 025 opisuje semantyczny skutek
  zaakceptowania i walidowania pól bez konsumenta.
- Naprawa: każde pole musi wejść do effective target, field plan, policy fingerprint i receipt
  albo zostać odrzucone jako unsupported.
- Testy: zmiana każdego pola musi zmienić oczekiwany resolved plan; `enforce_conforming=false`
  nie może cicho użyć strict conforming.
- Gate: brak validated-but-unused fields w policy inventory.

### 12.26 FM-MESH-026 — non-finite i ciche numeric coercion

- Priorytet: `P0`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py`;
  `packages/fullmag-py/src/fullmag/model/discretization.py` + `SweepDistribution`;
  `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` + `MeshOptions/AirboxOptions`;
  `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`.
- Objawy: `NaN/Inf`, `int(3.9)`, `bool` jako liczba, niepełny point3 albo luźne `float()` mogą
  dostać inną interpretację w różnych miejscach.
- Związek z FM-MESH-004: 004 obejmuje cross-layer drift; 026 jest konkretnym corpus root cause.
- Naprawa: strict finite scalar/int/vector parsers z typed path error, bez truncation.
- Testy: `NaN`, `Inf`, `-Inf`, bool, fractional integer, puste/zbyt długie listy i złe enumy.
- Gate: każdy nieprawidłowy przypadek odpada przed Gmsh w każdej warstwie.
- Aktualizacja 2026-08-31: strict parsing obejmuje aliasy legacy i zero-preserving precedence
  (`_first_defined`), a testy pokrywają `NaN/Inf`, bool, fractional integer, wektory i enumy.
  Cross-layer UI/Rust corpus oraz pełne route coverage są jeszcze wymagane.

### 12.27 FM-MESH-027 — `sweep_source` i `sweep_destination` bez konsumenta

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` + `MeshOptions`;
  `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py`.
- Objaw: pola są deklarowane i parsowane, lecz generator nie wybiera na ich podstawie encji.
- Naprawa: typed face selectors związane z geometry identity albo usunięcie pól ze schematu.
- Testy: dwa różne selectors wybierają różne, oczekiwane source/destination faces; stale selector
  po zmianie geometrii jest odrzucany.
- Gate: pola wpływają na realization/fingerprint albo nie są publicznie dostępne.
- Aktualizacja 2026-08-31: named selectors są odrzucane fail-closed na granicy generatora z
  kodem wskazującym brak geometry-identity-aware consumer; `auto` pozostaje kompatybilne.
  Właściwy typed face-selector consumer i pozytywny selection receipt nie istnieją.

### 12.28 FM-MESH-028 — brak physical tag maskowany markerem `1`

- Priorytet: `P0`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródło: `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` +
  `_extract_element_markers_for_tags`.
- Root cause: fallback `tag_to_marker.get(tag, 1)` może przypisać nieoznaczony element do
  domyślnej domeny magnetycznej.
- Ryzyko: material ownership zostaje sfabrykowane zamiast fail-closed.
- Naprawa: wymagane pełne pokrycie wszystkich volume elements przez oczekiwane physical groups;
  marker `1` może pochodzić wyłącznie z jawnego mapowania.
- Testy: brak taga, obcy tag, duplicate mapping, partial coverage i poprawne multi-region.
- Gate: missing physical group zawsze kończy build structured failure.
- Aktualizacja 2026-08-31: extraction wymaga pełnego bijektywnego pokrycia tagów, odrzuca
  missing/extra/duplicate tags i zachowuje jawnie przypisany marker `1`; regresje są w
  `scripts/test_fem_quality_typed_dispatch.py`. Brak produkcyjnego Gmsh/managed receipt.

### 12.29 FM-MESH-029 — heurystyczna identity komponentów po fallbacku

- Priorytet: `P0`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py` + STL bbox mapping;
  `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` +
  `_match_geometry_bounds_to_source_markers` i point-containment fallback.
- Problem: nakładające się lub podobne bboxy mogą przypisać marker niewłaściwemu komponentowi.
- Naprawa: przenosić stabilne source-component IDs przez import/Gmsh; niejednoznaczność blokuje
  build lub daje jawny non-qualifying degraded result.
- Testy: dwa nachodzące komponenty, współliniowe, identyczne bboxy, contained component.
- Gate: nie istnieje heuristic winner bez raportu confidence/ambiguity; strict path nie używa
  heurystycznego przypisania.
- Aktualizacja 2026-08-31: bbox fallback odrzuca tie i brak pozytywnego overlapu jako
  `component_identity_ambiguous`, a component-aware path omija heurystykę. Nadal nie ma
  stabilnego source-component ID przez pełny STL/Gmsh fallback ani formalnego confidence
  payloadu; fallback pozostaje zdegradowany.

### 12.30 FM-MESH-030 — sphere airbox może zostać zastąpiony bboxem

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`;
  `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`.
- Stan istniejący: raport oznacza fallback jako `degraded`, co poprawia truthfulness.
- Luki: artifact nadal może być skonsumowany jak zwykły shared-domain mesh bez blokującej
  capability/receipt semantics.
- Naprawa: requested/effective airbox shape w fingerprint i receipt; degraded nie promuje
  sphere capability.
- Testy: forced sphere success, forced fallback, planner unsupported i UI status.
- Gate: sphere request kończy się sphere artifact albo jawnym niekwalifikowanym wynikiem.

### 12.31 FM-MESH-031 — mixed-periodic Python/native contract drift

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` + `MeshData.validate`;
  `backends/fem/core/fem_mesh.cpp` + periodic seam handling;
  `backends/fem/tests/fem_mixed_p1_contract.cpp`.
- Objaw: Python odrzuca mixed topology z periodic pairs, podczas gdy native ABI/test ma seam
  support.
- Decyzja: pełny mixed-periodic certificate end-to-end albo wczesny DSL/UI rejection.
- Testy: consistent supported/unsupported matrix, seam owner/marker mapping i CPU/GPU parity.
- Gate: nie ma kombinacji akceptowanej przez jedną warstwę i odrzucanej dopiero przez inną.

Aktualizacja 2026-08-31: publiczny Python generator ma wspólną bramkę
`validate_periodic_mesh_options`, a `MeshData.validate()` odrzuca mixed topology
z periodic boundary/node pairs, certyfikatem albo rolą `periodic_seam`; regresje
sprawdzają rejection przed importem Gmsh. Natywny builder zachowuje niskopoziomową
obsługę pojedynczej, już zweryfikowanej roli seam jako atrybutowanej granicy, ale
nie jest to jeszcze pełny mixed-periodic certificate z parowaniem węzłów i parity
CPU/GPU. Stan zmieniono z `CONFIRMED_OPEN` na `PARTIALLY_FIXED`: publiczna ścieżka
nie powinna już przyjąć żądania, którego później cicho nie realizuje, lecz pełne
end-to-end wsparcie pozostaje niezakwalifikowane.

### 12.32 FM-MESH-032 — legacy quality validator jest tet4-only

- Priorytet: `P1`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/quality.py` + `validate_mesh`;
  `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` + compatibility `.elements`.
- Objaw: publiczny/legacy validator może rzucić wyjątek na mixed mesh zamiast family report.
- Naprawa: typed cell-block dispatch albo jawne deprecated tet-only API z wczesnym rejection.
- Testy: tet-only, strict mixed i future unknown family.
- Gate: żaden aktywny publiczny endpoint nie kieruje mixed artifact do tet-only validatora.

### 12.33 FM-MESH-033 — cleanup tetów unieważnia per-domain quality

- Priorytet: `P1`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródło: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` +
  `_drop_degenerate_tetrahedra`.
- Objaw: po usunięciu komórek `per_domain_quality` jest zerowane albo wcześniejsze statystyki
  przestają odpowiadać connectivity.
- Naprawa: przeliczyć jakość po mutation albo zwrócić blocking `quality_unavailable` do czasu
  ponownej certyfikacji.
- Testy: jeden usunięty tet, wszystkie tety usunięte, scoped count reconciliation.
- Gate: żadna summary sprzed cleanup nie jest publikowana z nową topology revision.

### 12.34 FM-MESH-034 — brak length/finite guards dla Gmsh quality

- Priorytet: `P1`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródło: `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` +
  `_extract_quality_metrics`.
- Problem: wynik `getElementQualities()` może mieć złą długość albo wartości non-finite przed
  `min`, histogramem i percentylami.
- Naprawa: sprawdzić count, tag alignment, dtype i finiteness każdego kanału przed agregacją.
- Testy: empty, short, long, reordered, `NaN/Inf` mock responses.
- Gate: malformed Gmsh response daje structured extraction failure, nigdy fałszywe summary.

### 12.35 FM-MESH-035 — API FMMQ sprawdza magic, nie identity

- Priorytet: `P0`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródła: `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs` +
  `read_mesh_quality_data_artifact`; `crates/fullmag-api/src/fem_cross_section.rs` + parser.
- Objaw: loader może poprzestać na `starts_with("FMMQ")`; metadata defaults i ETag nie wiążą
  topology fingerprint, revision ani digest treści.
- Związek z FM-MESH-009: format v1 ma za mało identity; 035 dodatkowo pokazuje, że API nie
  wykonuje nawet pełnego parser/preflight dostępnego dla payloadu.
- Naprawa: parse-before-publish, content digest, required revision/topology/family identity.
- Testy: stale/tampered/malformed payload, wrong count i content changed with same path.
- Gate: API nigdy nie publikuje quality resource tylko na podstawie magic i ścieżki.

### 12.36 FM-MESH-036 — FMMQ writer nie publikuje atomowo

- Priorytet: `P2`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py` +
  `_write_quality_data_artifact_if_available`; wzorzec atomowy w `persistence.py`.
- Problem: interrupted writer może pozostawić orphan/partial artifact.
- Naprawa: unique temp, write, flush, optional fsync, close, verify, `os.replace`, cleanup.
- Testy: wyjątek w połowie zapisu, brak miejsca, destination exists, concurrent writers.
- Gate: reader widzi tylko kompletną poprzednią albo kompletną nową generation.

Aktualizacja 2026-08-31: writer v2 publikuje przez unique temp directory i
`os.replace`, a destination filename jest dodatkowo namespacowany skrótem
pełnej canonical identity.  Dwa równoległe remesh jobs o tym samym
`mesh_name`, lecz różnej topologii/policy/revision, nie współdzielą już punktu
podmiany.  Źródłowy test zachowuje oba pliki; pozostaje `IMPLEMENTED_UNQUALIFIED`,
bo nie ma jeszcze live managed receipt z aktualnego środowiska.

### 12.37 FM-MESH-037 — preview FEM ignoruje `study_universe`

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Źródło: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` +
  `realize_fem_mesh_asset`.
- Objaw: object preview nie uwzględnia airbox/shared domain, lecz nazwa może sugerować
  solver-ready mesh.
- Naprawa: odrębne typed `surface_preview` i `solver_mesh_asset` albo pełne użycie universe.
- Testy: preview nigdy nie przechodzi native solver preflight; solver asset wymaga universe.
- Gate: API/IR nie pozwala pomylić preview artifact z production solver mesh.

### 12.38 FM-MESH-038 — effective Gmsh algorithm może różnić się od requested

- Priorytet: `P1`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Źródła: `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py` + algorithm
  sanitization/retry; `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`.
- Przykłady: `FrontalQuads` może zostać zmieniony dla volume route, a Delaunay zastąpiony HXT w
  wybranym przypadku.
- Stan istniejący: fallback bywa raportowany; nie zawsze blokuje qualification.
- Naprawa: requested/effective algorithm, reason i fallback policy w policy fingerprint/receipt.
- Testy: explicit allow, explicit forbid, automatic mode i retry triggered by controlled error.
- Gate: zmiana algorytmu jest świadomie dozwolona przez policy albo kończy hard failure.

#### Aktualizacja statusów źródłowych — 2026-08-31

Poniższe punkty mają już implementację i testy źródłowe, ale nie są jeszcze kwalifikacją
produkcyjną: `FM-MESH-032` (typed dispatch zamiast tet4 coercion), `FM-MESH-033` (cleanup
quality mutation guard), `FM-MESH-034` (Gmsh quality length/finite guards), `FM-MESH-035`
(API FMMQ identity preflight), `FM-MESH-036` (atomowa publikacja FMMQ), `FM-MESH-038`
(requested/effective algorithm reporting). `FM-MESH-022` jest jawnie odrzucane przed Gmsh,
a `FM-MESH-037` jawnie odrzuca `study_universe` na trasie preview; oba pozostają tylko
częściowo zamknięte, dopóki nie ma pełnego capability/receipt.

Dowód źródłowy obejmuje:

- `scripts/test_fem_quality_typed_dispatch.py` — 28/28 PASS;
- `scripts/test_fmmq_v2.py` — 10/10 PASS;
- `packages/fullmag-py/tests/test_meshing.py` — 289 PASS, 31 skipped w środowisku hostowym;
- Rust API/FEM parser — kod i testy obecne, lecz kompilacja managed pozostaje `NOT VERIFIED`.

---

## 13. Szczegółowy rejestr problemów Windows, źródła i runtime

### 13.1 FM-OPS-001 — merge zamknięty, lecz worktree nadal dynamiczny

- Priorytet: `P0`.
- Status: `PARTIALLY_FIXED`.
- Dowód: podczas jednego audytu liczba konfliktowych ścieżek zmieniła się z wartości dodatniej
  do zera, podczas gdy `MERGE_HEAD` pozostał obecny.
- Aktualizacja: o 02:23 `MERGE_HEAD` i unmerged entries były już nieobecne, lecz liczba dirty
  status entries wzrosła podczas audytu do 93.
- Przyczyna: checkout jest współdzielony przez użytkownika, IDE, procesy budujące i agentów.
- Ryzyko: test zaczyna się na innych bajtach źródła niż się kończy; sam `HEAD` nie opisuje
  staged/unstaged content.
- Naprawa proceduralna: właściciel merge świadomie kończy operację; następnie wykonywany jest
  snapshot before, zero zmian w qualification input, snapshot after i porównanie.
- Gate: brak unmerged entries, brak `MERGE_HEAD`, brak `index.lock`, stabilny status w dwóch
  odczytach i zgodny source snapshot before/after.
- Zakaz: masterplan nie autoryzuje `reset --hard`, `checkout --`, stasha ani stage `-A`.

### 13.2 FM-OPS-002 — branch wyrównany, lecz bez clean release baseline

- Priorytet: `P0`.
- Status: `PARTIALLY_FIXED`.
- Stan początkowy: lokalny `master` był równocześnie ahead i behind względem `origin/master`.
- Aktualizacja: branch został wyrównany do `[ahead 0, behind 0]`; dirty runtime-affecting
  changes nadal blokują clean release baseline.
- Ryzyko: nie wiadomo, czy dowód dotyczy przyszłego merge result, starego lokalnego HEAD czy
  patchsetu, który nie trafi do repo.
- Naprawa: po zakończeniu merge wybrać jeden pełny commit SHA; dla dirty qualification dodatkowo
  zapisać canonical dirty patch digest.
- Gate: receipt zawiera `head_commit_full`, upstream base, worktree state i
  `source_snapshot_sha256`; każdy jest weryfikowalny.

### 13.3 FM-OPS-003 — source identity zależne od aktywnego drzewa

- Priorytet: `P0`.
- Status: `BLOCKED_SOURCE_STATE`.
- Źródło: `scripts/capture_source_snapshot_identity.py` + entry point;
  `scripts/windows/run_fullmag.ps1` i `scripts/windows/run_fullmag_fem.ps1` + source checks.
- Stan istniejący: launchery fail-closed porównują snapshot i manifest; jest to poprawny kierunek.
- Brak: jeden immutable qualification input set i post-run drift seal dla całej bramki.
- Naprawa: capture before/after obejmują wszystkie runtime-affecting files, recipe i fixture;
  non-runtime ignore list ma być jawna i testowana.
- Testy: modyfikacja pliku source, recipe, fixture, dokumentu nie-runtime i pliku generowanego.
- Gate: każda zmiana mająca wpływ na wynik zrywa run przed promocją.

### 13.4 FM-OPS-004 — brak aktualnego managed FEM manifestu

- Priorytet: `P0`.
- Status: `BLOCKED_INFRASTRUCTURE`.
- Oczekiwany artefakt: `.fullmag/runtimes/fem-gpu-host/manifest.json`.
- Stan obserwowany: manifest był brakujący albo runtime publication pozostawało w toku; starszy
  bundle pochodził z innego snapshotu.
- Naprawa: po stabilizacji źródła wykonać repo-owned `just rebuild-fem-runtime`, walidator bundle
  i atomową selekcję `.next -> active`.
- Testy: brak binarki, zły hash, niezgodny source snapshot, brak biblioteki, przerwany export,
  restore previous active.
- Gate: `validate_managed_fem_runtime_bundle.py` przechodzi, manifest jest zgodny z bieżącym
  snapshotem, a binarka odpowiada na `--help` w managed environment.

### 13.5 FM-OPS-005 — współdzielony cache między worktree

- Priorytet: `P0`.
- Status: `BLOCKED_INFRASTRUCTURE`.
- Dowód: manifest Windows GPU wskazywał obcy worktree, a kilka checkoutów używało wspólnego
  `C:\fullmag-cache\state`.
- Ryzyko: poprawny hash pliku nie dowodzi, że runtime został zbudowany dla aktywnego repo; dwa
  worktree mogą nadpisać wspólny manifest.
- Naprawa: namespace co najmniej `repo-id/worktree-id/source-snapshot/backend/device/precision`;
  active pointer musi należeć do wywołującego checkoutu.
- Testy: równoległy build dwóch worktree, różne snapshoty, stale pointer i cleanup bez usuwania
  aktywnego namespace.
- Gate: jeden worktree nie może odczytać ani promować manifestu drugiego bez jawnego importu.

### 13.6 FM-OPS-006 — długowieczne kontenery i niejasna własność

- Priorytet: `P1`.
- Status: `BLOCKED_INFRASTRUCTURE`.
- Stan audytu: obserwowano trzy kontenery FEM CPU działające około 13–14 godzin oraz aktywny
  managed export/buildx.
- Ryzyko: mutex, mount lub cache lock może wyglądać na stale, choć proces nadal wykonuje pracę.
- Naprawa: owner metadata zawiera PID/container ID, task/run ID, start/heartbeat, source snapshot,
  recipe i evidence root; status command rozróżnia active, orphaned i completed.
- Testy: żywy owner, martwy PID, stary heartbeat, przejęcie locka i równoległy nowy run.
- Gate: cleanup działa wyłącznie na potwierdzonym orphanie; active run nigdy nie jest ubijany
  przez automatyczny maintenance.

### 13.7 FM-OPS-007 — drift manifestów native Windows

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Źródło: `scripts/windows/run_fullmag.ps1` + `build-manifest.json` validation.
- Stan istniejący: launcher zapisuje i porównuje source snapshot, worktree state oraz hashes.
- Dowód luki: native FDM manifest miał hashe `fullmag.exe` i `fullmag-api.exe` niezgodne z
  aktywnymi plikami; `BuildMode=false` powinien poprawnie odmówić startu.
- Naprawa: atomowo stage'ować oba pliki i manifest; nie publikować częściowo przebudowanego
  runtime; osobny generation ID dla kompletu.
- Testy: podmiana jednej binarki, przerwany copy, manifest z obcego worktree i `BuildMode=false`.
- Gate: reuse przechodzi wyłącznie dla kompletnego generation set z jednym snapshotem.

### 13.8 FM-OPS-008 — sprzeczny kontrakt Nsight

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `docker/fem-gpu/Dockerfile` + instalacja Nsight;
  `scripts/test_windows_fullmag_launcher_contract.py` + test opcjonalności.
- Objaw: Dockerfile nadal zawiera twardą wersję `2024.1.1`, a test wymaga opcjonalnej,
  konfigurowalnej zależności.
- Wynik skoncentrowanego testu z audytu: `26 passed, 1 failed`.
- Naprawa: build arg z kontrolowanym defaultem albo osobny profiling image; runtime produkcyjny
  nie może zależeć od jednej zakodowanej wersji narzędzia diagnostycznego.
- Testy: default, explicit version, unavailable repository i build bez profilera.
- Gate: test kontraktu przechodzi, a brak Nsight daje `unavailable` tylko dla profiling gate,
  nie dla zwykłego runtime.
- Aktualizacja 2026-08-31: Dockerfile nie hardcoduje już jednej wersji Nsight jako wymagania
  zwykłego runtime; test kontraktu sprawdza optional/configurable behavior. Live build z
  profilerem i bez niego pozostaje `NOT VERIFIED` na tym hoście.

### 13.9 FM-OPS-009 — niepełne hostowe środowisko testowe

- Priorytet: `P1`.
- Status: `BLOCKED_INFRASTRUCTURE`.
- Dowód: hostowy Python nie zawierał `pytest`; wykonano jedynie `py_compile` wybranych modułów.
- Interpretacja: brak pytest nie dowodzi błędu kodu i nie jest powodem do omijania testu.
- Naprawa: używać repo-owned venv/uv albo managed container recipe; wersje Python i zależności
  zapisać w evidence.
- Testy: environment bootstrap from clean cache i offline reuse po pobraniu zależności.
- Gate: targeted test FM-MESH-021 oraz pełny meshing suite przechodzą w deklarowanym środowisku.

### 13.10 FM-OPS-010 — brak atomowej promocji runtime i evidence

- Priorytet: `P0`.
- Status: `CONFIRMED_OPEN`.
- Problem: poprawny runtime, manifest, mesh, FMMQ i receipt mogą być publikowane w różnych
  chwilach, umożliwiając mieszany generation set.
- Naprawa: wszystkie artefakty powstają w unikalnym staging root; verifier tworzy seal; dopiero
  potem jeden atomic rename/promote zmienia active pointer.
- Testy: przerwanie na każdym kroku, brak miejsca, verifier FAIL, source drift i restart.
- Gate: active generation jest zawsze kompletny i immutable; niekompletne staging roots nigdy
  nie są widoczne dla `BuildMode=false` ani UI.

### 13.11 FM-OPS-011 — zerwany łańcuch aliasów managed runtime

- Priorytet: `P0`.
- Status: `CONFIRMED_OPEN`.
- Obserwowany łańcuch: `.fullmag/runtimes/fem-gpu-host -> fem-gpu-variants/...`, a alias
  `fem-gpu-variants` wskazuje na nieistniejący worktree-specific katalog w storage WSL/ext4.
- Skutek: `.fullmag/runtimes/fem-gpu-host/manifest.json` jest faktycznie niedostępny zarówno z
  Windows, jak i po rozwiązaniu ścieżki w WSL.
- Źródła: `scripts/export_fem_gpu_runtime.sh`; `scripts/lib/managed_fem_runtime_storage.sh`;
  `scripts/restore_persistent_fem_runtime.sh`; `scripts/validate_managed_fem_runtime_bundle.py`;
  `justfile` + `ensure-managed-fem-runtime`.
- Naprawa: exporter tworzy generation i wszystkie aliasy w jednym staging root, weryfikuje
  target, a dopiero potem atomowo promuje; nie naprawiać ręcznym symlinkiem.
- Testy: missing first/second hop, foreign worktree target, interrupted restore i valid promote.
- Gate: alias resolver i bundle validator wskazują ten sam istniejący schema-3 runtime.

### 13.12 FM-OPS-012 — globalne Compose/state/build roots między worktree

- Priorytet: `P0`.
- Status: `CONFIRMED_OPEN`.
- Źródło: `scripts/windows/run_fullmag_fem.ps1` + environment/root setup;
  `compose.windows.yaml`.
- Potwierdzone globalne wartości: `COMPOSE_PROJECT_NAME=fullmag-windows-fem`, wspólne
  `C:\fullmag-build`, `C:\fullmag-cache`, state `fem-cpu/fem-gpu` i port `3100`.
- Ryzyko: kilka worktree współdzieli Cargo target, network, state, manifest i port; mutex
  launchera nie chroni ręcznego Compose ani dawnych kontenerów.
- Naprawa: deterministic namespace z repo/worktree ID dla project name, build root, state root,
  network i automatycznie przydzielanego portu.
- Testy: równoległy CPU/GPU build z dwóch worktree bez wspólnych writable mounts.
- Gate: inventory potwierdza zero cross-worktree writable ownership.

### 13.13 FM-OPS-013 — automatyczny prune bez obowiązkowego dry-run

- Priorytet: `P0`.
- Status: `PARTIALLY_FIXED`.
- Źródła: `justfile` + `ensure-managed-fem-runtime`; `scripts/prune_managed_fem_runtimes.sh`.
- Aktualizacja 2026-08-31: `ensure-managed-fem-runtime` nie uruchamia prune bez
  `FULLMAG_RUNTIME_PRUNE=1`, a osobny przepis `prune-managed-fem-runtimes` wykonuje
  najpierw dry-run i wymaga `apply=1` dla usuwania. Sam skrypt
  `scripts/prune_managed_fem_runtimes.sh` ma również teraz domyślnie
  `FULLMAG_RUNTIME_DRY_RUN=1`, więc bezpośrednie wywołanie nie jest destrukcyjne.
- Ryzyko: zwykłe zapewnienie runtime może usunąć cache/generation należące do innego aktywnego
  procesu.
- Pozostaje do dowodu: uruchomienie testów shellowych na rzeczywistym Linux runnerze oraz
  potwierdzenie, że każdy zewnętrzny maintenance caller przekazuje jawne `DRY_RUN=0` dopiero
  po inventory i autoryzacji.
- Naprawa: ensure jest read-only albo dry-run; osobny explicit cleanup wymaga inventory,
  autoryzacji i jawnego `DRY_RUN=0`.
- Testy: default nigdy nie usuwa; active owner chroniony; target containment; dry-run listing.
- Gate: żaden build/ensure/audit recipe nie wykonuje destrukcyjnego prune niejawnie.

### 13.14 FM-OPS-014 — root npm lockfile i niepełny Corepack provisioning

- Priorytet: `P1`.
- Status: `PARTIALLY_FIXED`.
- Aktualizacja 2026-08-31: usunięto śledzony root `package-lock.json`, dodano
  `/package-lock.json` do `.gitignore` oraz fail-closed check w
  `scripts/ci/contract_guard.sh`. Root pozostaje jednoznacznie pnpm-owned
  (`packageManager: pnpm@10.8.1`, `pnpm-lock.yaml`).
- Rozróżnienie: nested `external_solvers/amumax/frontend/package-lock.json` jest własnością
  odrębnego projektu i nie podlega automatycznemu usunięciu.
- Dodatkowa luka: setup sprawdza dowolny `pnpm`, lecz launcher oczekuje konkretnego
  `C:\fullmag-cache\corepack\pnpm\10.8.1\bin\pnpm.cjs`.
- Aktualizacja: `setup_fullmag.ps1 -InstallMissing` provisionuje teraz `COREPACK_HOME`
  i wymaga dokładnie `pnpm@10.8.1` w tym samym path, którego używa launcher.
- Pozostaje do dowodu: clean first run/offline reuse/wrong-version na prawdziwym
  Windows host oraz pełny CI bootstrap.
- Naprawa: utrzymać usunięcie root lockfile oraz testować bootstrap pinned Corepack;
  nie usuwać lockfile’a nested projektu.
- Testy: clean first run, offline reuse, wrong pnpm version i nested npm project preservation.
- Gate: VS Code nie zgłasza conflicting package-manager lockfiles w root, a launcher i setup
  uzgadniają ten sam pnpm binary.

### 13.15 FM-OPS-015 — Git ownership/safe.directory różni się między hostami

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Problem: Windows user, Codex sandbox i Linux container mogą widzieć różną własność checkoutu;
  Git wymaga czasem per-command safe-directory override.
- Naprawa: nie zmieniać globalnego Git config bez potrzeby; repo tooling używa minimalnego,
  jawnego per-command override wyłącznie w zaufanym workspace.
- Testy: Windows host, Codex sandbox, container read-only mount i obca ścieżka odrzucona.
- Gate: source identity działa bez globalnej mutacji konfiguracji i bez rozszerzenia trust na
  szerokie katalogi.

### 13.16 FM-OPS-016 — Control Room output zapisywany w checkoutcie

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Problem: statyczny output trafia do `apps/control-room/out`, zwiększając dirty status i ryzyko
  source drift podczas qualification.
- Naprawa: external build root albo ignored, generation-scoped staging; source tree jest tylko
  wejściem.
- Testy: frontend build nie zmienia `git status`; dwa worktree nie współdzielą outputu.
- Gate: qualification source snapshot before/after pozostaje stabilny podczas UI build.

### 13.17 FM-OPS-017 — brak mostu schema 2 Windows do schema 3 managed

- Priorytet: `P0`.
- Status: `CONFIRMED_OPEN`.
- Dwie lane: Windows FEM launcher publikuje lokalne manifesty schema 2 w
  `C:\fullmag-cache\state`; production managed runtime używa exporter/alias i manifest schema 3
  w `.fullmag/runtimes/fem-gpu-host`.
- Ryzyko: udany `just windows-build fem ...` może zostać błędnie uznany za managed qualification.
- Naprawa: jawny promotion/import contract albo całkowite rozdzielenie nazw/statusów; schema-2
  smoke nigdy nie zaspokaja schema-3 gate bez verified transform.
- Testy: foreign/stale schema 2, valid schema 2 but absent schema 3, controlled promotion.
- Gate: receipt wskazuje schema-3 managed manifest; UI/CLI nie nazywa schema-2 smoke produkcyjnym.

---

## 14. Szczegółowy rejestr problemów kwalifikacji

### 14.1 FM-QUAL-001 — brak kanonicznego evidence manifest v2

- Priorytet: `P0`.
- Status: `PARTIALLY_FIXED`.
- Wymagane pola: source snapshot, runtime generation, policy fingerprint, topology fingerprint,
  FMMQ digest, certifier, device, precision, fallback flags, scenario i result status.
- Stan bieżący: verifier v1 odrzuca artefakty wychodzące poza katalog manifestu (w tym przez
  `..` oraz symlink/junction) i może sprawdzać zadeklarowany SHA-256 pliku. Nie jest to jeszcze
  pełny manifest v2 z wymaganymi identity, schema i sealed receipt.
- Naprawa: dokończyć JSON Schema v2 oraz niezależny verifier; manifest ma indeksować immutable
  pliki, nie luźne ścieżki cache.
- Gate: schema, hash chain, path containment i tamper tests przechodzą.
- Aktualizacja 2026-08-31: v1 verifier ma już containment, symlink/junction escape rejection
  i opcjonalny SHA-256 artifact check; pełny manifest v2/seal nadal nie istnieje.

### 14.2 FM-QUAL-002 — brak aktualnej macierzy S1–S13

- Priorytet: `P0`.
- Status: `CONFIRMED_OPEN`.
- Źródło: `docs/physics/0105-fem-meshing-production-acceptance.md` + scenarios S1–S13.
- Problem: historyczne PASS nie odpowiadają obecnej definicji quality i identity.
- Naprawa: każdy scenariusz ma fixture version, expected lane, required metrics, managed paths i
  osobny receipt linked do suite index.
- Kolejność: najpierw pełny S13; pozostałe scenariusze nie blokują bounded S13 qualification,
  ale blokują twierdzenie o całym mesherze.
- Gate: suite index nie ma `unknown`; unsupported jest jawnie uzasadnione i testowane.

### 14.3 FM-QUAL-003 — brak wspólnego managed CPU/GPU proof

- Priorytet: `P0`.
- Status: `CONFIRMED_OPEN`.
- Problem: osobne przejścia CPU i GPU na różnych artefaktach nie dowodzą parity.
- Naprawa: jeden immutable mesh/FMMQ input, osobne execution receipts, wspólny comparison receipt.
- CPU gate: managed runtime, double precision, właściwy operator i brak niejawnego GPU.
- GPU gate: device identity, residency, brak CPU fallback i brak hot-loop transfers.
- Parity gate: ta sama policy/topology/quality identity oraz uzgodnione tolerancje obserwabli.

### 14.4 FM-QUAL-004 — brak rzeczywistego browser/WebGL proof

- Priorytet: `P0`.
- Status: `CONFIRMED_OPEN`.
- Problem: artefakt, API JSON albo test DOM nie dowodzą aktywnego renderowania WebGL.
- Naprawa: uruchomić real browser dla tej samej sesji/mesh revision i zapisać screenshot,
  DOM/resource assertions, canvas dimensions, drawing buffer, context status i console errors.
- Testy: context lost, zero-sized canvas, stale revision, missing quality payload i selection
  worst element.
- Gate: widoczny canvas, aktywny kontekst, niezerowy drawing buffer i ten sam receipt ID.

### 14.5 FM-QUAL-005 — brak FMMQ v2

- Priorytet: `P0`.
- Status: `IMPLEMENTED_UNQUALIFIED`.
- Rozróżnienie: FMMT v2 transportuje topologię; JSON mixed certificate potwierdza inwarianty;
  żaden z nich nie jest FMMQ v2.
- Naprawa: pełny producent, reader Rust, API resource, generated types, UI consumer i verifier.
- Gate: v1/JSON-only evidence jest jawnie odrzucone przez production qualification.
- Aktualizacja 2026-08-31: Python writer/parser i Rust API validator v2 są obecne, z canonical
  identity, family/ordinal coverage, channel checksums i whole-payload digest. UI/managed
  receipt oraz końcowy gate nadal nie zostały wykonane.

### 14.6 FM-QUAL-006 — brak pełnej parity policy/topology/quality

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Problem: porównanie liczby elementów albo magnetyzacji step-0 nie wiąże wszystkich tożsamości.
- Naprawa: comparison receipt wymaga equality dla policy fingerprint, topology fingerprint,
  metric schema, FMMQ digest i mesh revision; różnić się mogą tylko lane-specific execution data.
- Gate: kontrolowany mismatch dowolnej identity kończy się FAIL przed solver comparison.

### 14.7 FM-QUAL-007 — brak determinism matrix

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Zakres: Gmsh generation, repair, extraction, Rust certificate, serialization, reload i cache.
- Macierz: cold/warm, Rayon `1/2/4/8`, minimum dziesięć powtórzeń, dwa roots.
- Gate: identyczne counts/fingerprints/digests; timing może się różnić, semantyka nie.

### 14.8 FM-QUAL-008 — brak produkcyjnego cold/warm performance gate

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Stan istniejący: pojedynczy historyczny SP4 dał `21.189 s` względem `111.79 s`, czyli
  `5.2758x` i `81.045%` redukcji; to mocny, lecz niekońcowy dowód.
- Naprawa: minimum pięć cold i dziesięć warm prób, mediana/p95/max, stage timings, peak RSS,
  host/device/runtime/source identity.
- Gate planowany: warm p95 `<= 2 s`, cold p95 `<= 180 s`, cold median `<= 65%` baseline;
  progi muszą zostać zatwierdzone dla dokładnego fixture.
- Zakaz: dawne obserwowane „20 minut” nie jest numerycznym baseline'em bez artefaktu i scope.

### 14.9 FM-QUAL-009 — capability promotion nie jest związana z receiptem

- Priorytet: `P1`.
- Status: `CONFIRMED_OPEN`.
- Problem: `implemented` albo istniejący planner path może być odczytany jako `validated`.
- Naprawa: capability entry ma exact tuple i opcjonalny sealed receipt digest; brak digestu
  ogranicza status do source/contract.
- Gate: generator capability matrix odrzuca promocję bez ważnego, aktualnego receipt.

### 14.10 FM-QUAL-010 — brak clean-tree final qualification

- Priorytet: `P0`.
- Status: `CONFIRMED_OPEN`.
- Problem: obecne wyniki powstały na dirty albo zmieniających się snapshotach.
- Naprawa: po połączeniu poprawek uruchomić finalny suite na czystym, pełnym SHA; dirty run może
  służyć jako prequalification, nigdy jako release proof.
- Gate: `git status --porcelain` pusty przed i po, brak merge, source before/after zgodne,
  wszystkie manifests i receipts wskazują dokładnie ten SHA.

---

## 15. Docelowa architektura dowodu

### 15.1 Graf zależności

```text
stable source snapshot
        |
        v
canonical FemMeshPolicyIR ----> canonical validation/round-trip
        |                                  |
        +------------------+---------------+
                           v
                   resolved field plan
                           |
                           v
                  Gmsh/OCC realization
                           |
                           v
             typed topology + region/interface ABI
                           |
                           v
           family-aware quality + Rust certificate
                           |
                           v
                     FMMQ v2 carrier
                           |
            +--------------+--------------+
            |                             |
            v                             v
       managed FEM CPU               managed FEM GPU
            |                             |
            +--------------+--------------+
                           v
                     parity receipt
                           |
                           v
                  API quality resources
                           |
                           v
               Control Room + real WebGL
                           |
                           v
             sealed production receipt v2
                           |
                           v
              capability/docs promotion
```

Zależność jest fail-closed. Przykładowo brak FMMQ v2 blokuje produkcyjny browser proof, nawet
jeżeli siatkę da się narysować. Brak stabilnego snapshotu blokuje wszystkie dowody poniżej,
nawet jeżeli testy funkcjonalne przechodzą.

### 15.2 Macierz realizacji solver/backend

| Lane | Rola w tym masterplanie | Minimalny dowód | Status startowy |
|---|---|---|---|
| FDM CPU | kontrola, że wspólne authoring/IR nie regresuje FDM | source/round-trip + istniejący FDM smoke | niepromowany przez ten plan |
| FDM GPU | kontrola kontraktu Windows native i braku cross-lane drift | native manifest + focused smoke | poza FEM qualification |
| FEM CPU | obowiązkowa produkcyjna realizacja S13 | managed double, MFEM/hypre/libCEED, receipt | brak świeżego proof |
| FEM GPU | obowiązkowa produkcyjna realizacja S13 | forced GPU, residency, no fallback, receipt | brak świeżego proof |

Masterplan nie może oznaczyć FDM CPU/GPU jako `validated` na podstawie testów FEM. Z drugiej
strony zmiana wspólnego `ProblemIR` nie może zostać scalona bez testów, że FDM zachowuje swoje
dotychczasowe znaczenie.

### 15.3 Tożsamość końcowa

Końcowa jakość jest funkcją złożoną:

$$
I_{\mathrm{quality}} = H(
I_{\mathrm{source}},
I_{\mathrm{runtime}},
I_{\mathrm{policy}},
I_{\mathrm{topology}},
I_{\mathrm{revision}},
I_{\mathrm{metrics}},
I_{\mathrm{certifier}}
).
$$

Każdy symbol jest obowiązkowy:

| Symbol | Znaczenie | Jednostka |
|---|---|---|
| $I_{\mathrm{source}}$ | commit i canonical snapshot źródła | $1$ |
| $I_{\mathrm{runtime}}$ | build/runtime generation i biblioteki | $1$ |
| $I_{\mathrm{policy}}$ | requested i normalized mesh policy | $1$ |
| $I_{\mathrm{topology}}$ | typed connectivity, coordinates, markers i roles | $1$ |
| $I_{\mathrm{revision}}$ | immutable revision siatki w sesji | $1$ |
| $I_{\mathrm{metrics}}$ | schema i kanały metryk jakości | $1$ |
| $I_{\mathrm{certifier}}$ | wersja i build silnika certyfikującego | $1$ |

Nie istnieje „prawie zgodna” identity. Różnica dowolnego składnika wymaga nowego dowodu.

---

## 16. Masterplan wykonawczy

### 16.1 Faza 0 — ustabilizowanie źródła i katalogu projektu

#### Cel

Utworzyć niezmienny punkt wejścia, na którym można wiarygodnie budować i mierzyć.

#### Wejście

- bieżący współdzielony checkout;
- możliwy aktywny merge;
- task uruchomiony z katalogu o jeden poziom wyżej niż repo;
- historyczne artefakty o różnych source identities.

#### Zadania

1. Właściciel zmian kończy albo świadomie rozwiązuje merge.
2. Odczytać osobno staged, unstaged i untracked inventory.
3. Potwierdzić brak `MERGE_HEAD`, unmerged entries i stale `index.lock`.
4. Ustawić zapisany projekt Codex na `C:\git\fullmag\fullmag`, aby repo skills w
   `.agents/skills` były automatycznie wykrywane.
5. Otworzyć nową sesję po zmianie katalogu projektu, jeżeli bieżąca nie odświeży katalogu skilli.
6. Wybrać pełny commit SHA będący baseline'em.
7. Wygenerować `source-snapshot-before.v1.json` z kwalifikowanym fixture.
8. Zapisać toolchain inventory: Windows, Docker Desktop, GPU driver, Gmsh,
   Python, Rust, CMake, MFEM, hypre, libCEED i CUDA.
9. Utworzyć nowy, pusty evidence root poza aktywnymi cache.
10. Oznaczyć stare benchmarki i manifests jako `HISTORICAL`, nie usuwać ich.

#### Pliki i symbole

- `scripts/capture_source_snapshot_identity.py` + `main`;
- `scripts/windows/run_fullmag.ps1` + source identity validation;
- `scripts/windows/run_fullmag_fem.ps1` + source identity validation;
- `.agents/skills/scientific-documentation-contract/SKILL.md`;
- `.agents/skills/physics-publication/SKILL.md`.

#### Testy

- snapshot wykonany dwukrotnie bez zmian daje ten sam digest;
- zmiana fixture zmienia digest;
- zmiana tylko jawnie ignorowanego pliku nie-runtime zachowuje digest;
- nieznany albo niebezpieczny ignore pattern jest odrzucany;
- task uruchomiony z repo root widzi `scientific-documentation-contract`.

#### Artefakty wyjściowe

- `source-snapshot-before.v1.json`;
- `toolchain-inventory.v1.json`;
- `qualification-scope.v1.json`;
- `historical-evidence-index.md`.

#### Gate wyjścia

```text
merge_in_progress == false
unmerged_entry_count == 0
source_snapshot_before is stable
repo_root == C:\git\fullmag\fullmag
qualification_scope is immutable
```

#### Rollback i stop condition

Jeżeli checkout nadal się zmienia, wolno kontynuować analizę source-only, ale nie wolno budować
finalnego runtime ani liczyć finalnych timingów. Nie wymuszać czystości destrukcyjnymi poleceniami.

### 16.2 Faza 1 — domknięcie kanonicznego `FemMeshPolicyIR`

#### Cel

Jedno typed źródło requested intent, normalizacji i policy fingerprint dla wszystkich warstw.

#### Zadania

1. Sporządzić inventory wszystkich publicznych pól universe, per-object, interface, airbox,
   sweep, quality i cache.
2. Dla każdego pola wskazać dokładny Python qualified name, typ, default, jednostkę SI, domenę,
   IR destination i backend support.
3. Uzupełnić `FemMeshPolicyIR` tylko o brakujące semantyczne pola; nie kopiować runtime detail.
4. Oddzielić `requested` od `resolved`.
5. Zdefiniować canonical JSON i float normalization.
6. Powiązać policy fingerprint z pełnym normalized policy.
7. Zmienić legacy maps w jednokierunkowy adapter.
8. Dodać unknown-field rejection i conflict rejection.
9. Oznaczyć `SharedMeshAssemblyPolicy` jako aktywny kontrakt albo deprecate compatibility adapter.
10. Zapisać migration rule dla V03/V04 oraz zakaz partial writer cutover.

#### Pliki i symbole

- `crates/fullmag-ir/src/mesh_policy.rs` + `FemMeshPolicyIR`;
- `packages/fullmag-py/src/fullmag/model/discretization.py` + public mesh policy classes;
- `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` + policy lowering;
- `crates/fullmag-plan` + FEM mesh capability resolution;
- `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`.

#### Testy RED przed implementacją

- pole `sweep_direction` znika w lowering;
- malformed positive float przechodzi jako missing;
- konflikt legacy i typed policy ma nieokreślone pierwszeństwo;
- nieznane pole wpływające na mesh jest ignorowane;
- dead compatibility argument nie zmienia wyniku ani nie ostrzega.

#### Testy GREEN

- canonical policy golden fixtures dla S1, S8 i S13;
- serde/JSON/Python round-trip;
- fingerprint stability;
- unknown-field rejection;
- backend legality matrix;
- FDM non-regression dla wspólnych pól.

#### Artefakt

`resolved-mesh-policy.v1.json` zawierający:

```text
requested_policy
normalized_policy
resolved_policy
policy_fingerprint
normalizer_version
warnings
rejections
legacy_adapter_used
```

#### Gate wyjścia

Każde zaakceptowane pole jest zużyte dokładnie raz albo jawnie raportowane jako nieaktywne z
blokującym statusem. Żaden runtime consumer nie czyta luźnego metadata poza adapterem.

### 16.3 Faza 2 — wspólna walidacja i pełny round-trip

#### Cel

Usunąć różne znaczenia tego samego wejścia w UI, API, Python i Rust.

#### Zadania

1. Zbudować canonical validation cases data set.
2. Wygenerować lub współdzielić enumy `mesh_strategy`, `sweep_direction`, `airbox_mode` i quality
   metric IDs.
3. Zastąpić silent `_coerce_positive_float` structured validation result.
4. Zachować `sweep_direction` w `MeshOptions` albo usunąć ten pośredni, niepełny model.
5. Zdefiniować kolejność normalizacji długości do SI.
6. Dodać structured errors z JSON pointer i stable code.
7. Uzupełnić Script Builder export.
8. Zbudować semantic round-trip comparator ignorujący wyłącznie jawne presentation defaults.
9. Sprawdzić publiczny stage-first scenariusz `fm.study(...).stages`.
10. Nie dodawać publicznego `fm.Problem(...)` jako obejścia brakującego buildera.
11. Usunąć z authoring niewykonywalne `MeshOperation` albo dostarczyć typed executor.
12. Rozstrzygnąć i przetestować `sweep_source/sweep_destination`.
13. Rozdzielić typ preview od solver-ready mesh asset.
14. Związać requested/effective Gmsh algorithm z policy i receipt.

#### Macierz testowa

| Klasa | Przykłady | Oczekiwany wynik |
|---|---|---|
| missing | brak pola opcjonalnego | canonical default |
| null | jawne `null` | tylko gdy kontrakt dopuszcza |
| numeric boundary | `0`, `1`, epsilon, max | ten sam PASS/FAIL w każdej warstwie |
| non-finite | `NaN`, `Inf` | structured rejection |
| enum | known, unknown, case drift | exact enum albo rejection |
| conflict | typed + legacy różne | rejection, bez precedence guess |
| units | m, authored helper units | jeden wynik SI |
| unsupported | swept hex, zła geometria | planner rejection przed Gmsh |

#### Gate wyjścia

- UI -> API -> IR -> Python export -> IR ma pusty semantic diff;
- `x`, `y`, `z` i `auto` zachowują requested/resolved semantics;
- testy FDM CPU/GPU pokazują brak regresji wspólnego authoring;
- wszystkie błędy mają stable code i path.

### 16.4 Faza 3 — resolved Gmsh field plan i post-mesh grading

#### Cel

Każda authored polityka ma jawny plan realizacji i mierzalny wynik.

#### Zadania

1. Rozszerzyć resolved plan o listę aktywnych source fields i ich priorytet.
2. Rozdzielić body, material interface, edge/corner, transition shell i far airbox.
3. Zapisać algebraic composition: `Min`, `Max`, `Threshold`, `Distance`, curvature upper bound.
4. Dla każdego pola zapisać source entities, target size, distance band i reason.
5. Zdefiniować legalną domenę `growth_rate`; usunąć silent disable.
6. Utrzymać `Mesh.SmoothRatio` wyłącznie jako generator hint.
7. Po generacji obliczać rzeczywisty `adjacent_size_growth.v1`.
8. Raportować worst neighbor pairs ze współrzędnymi centroidów i scope.
9. Dodać sampled field diagnostics dla S1, S4, S8 i S13.
10. Profilować koszt adjacency bez ponownego budowania tych samych map.

#### Pliki i symbole

- `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` + `build_size_field_plan`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` + `apply_mesh_options`;
- `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`.

#### Testy

- growth PASS/FAIL synthetic pairs;
- p95 interface target dla S8;
- far/corner populations nie znikają;
- curvature i edge/corner mogą tylko zaostrzyć dozwolony rozmiar;
- żadne accepted field source nie ma `applied=false` bez blocking status;
- tie-surface bbox fixture dla FM-MESH-020.

#### Gate wyjścia

Resolved plan, Gmsh application report i post-mesh quality report mają zgodny policy fingerprint.
Wartość growth jest faktycznie zmierzona, a nie wywnioskowana z opcji Gmsh.

### 16.5 Faza 4 — topologia, regiony, interfejsy i repair

#### Cel

Utrzymać typed mixed topology i semantykę materiałów przed oraz po repair/extraction.

#### Zadania

1. Potwierdzić legalny bounded scope: Box, bbox airbox, `mixed_p1`, layers `1..3`.
2. Uzgodnić przykład `layers=4` w `0104` z ograniczeniem `1..3` w `0106`.
3. Oddzielić geometry component, material region, mesh role i boundary/interface marker.
4. Sprawdzić wspólne globalne węzły na conforming interface.
5. Zachować `prism6/pyramid5/tet4` przez extraction i persistence.
6. Utrzymać zakaz hidden `prism6 -> tet4`.
7. Dokończyć parity determinant/sliver threshold Python/Rust.
8. Reuse degeneracy report zamiast wielokrotnego pełnego skanu.
9. Rozszerzyć native preflight o marker-owner-interface invariants.
10. Każdy fallback OCC/STL oznaczyć klasą realizacji.
11. Usunąć domyślny marker dla elementów bez physical group.
12. Przenosić stabilne component IDs; nie rozstrzygać strict identity przez bbox overlap.
13. Uzgodnić Python/native mixed-periodic capability.
14. Po każdej mutation topology unieważnić i przeliczyć quality revision.

#### Inwarianty

```text
strict magnetic region cell families == {prism6}
transition/airbox families subset == {pyramid5, tet4}
requested_layers == realized_layers
non_manifold_faces == 0
same_side_two_owner_faces == 0
material_interface owner markers differ
all signed family Jacobians > family_floor
topology fingerprint unchanged across serialize/reload
```

#### Testy

- golden layers `1`, `2`, `3`;
- layers `0`, `4` i conflicting metadata rejected dla bounded lane;
- flipped prism, pyramid i tet;
- sliver w wielu skalach SI;
- interface owner corruption;
- hidden tetra substitution;
- corrupted cached connectivity;
- imported STL degraded status.

#### Gate wyjścia

Python, Rust certifier i native loader akceptują ten sam zestaw golden fixtures oraz odrzucają
ten sam zestaw negatywny. Każda różnica musi być udokumentowaną różnicą odpowiedzialności,
nie rozbieżnością naukową.

### 16.6 Faza 5 — family-aware quality engine i FMMQ v2

#### Cel

Zbudować jeden kanoniczny, element-wise nośnik jakości związany kryptograficznie z siatką.

#### Kanały obowiązkowe

| Metric ID | Zakres | Jednostka | Uwagi |
|---|---|---|---|
| `cell.max_edge.v1` | wszystkie rodziny | $\mathrm{m}$ | maksimum rzeczywistych krawędzi |
| `adjacent_size_growth.v1` | face-neighbor pairs | $1$ | scope obu ownerów |
| `signed_jacobian.<family>.v1` | per family | zależna od mapowania | jawna definicja |
| `scaled_jacobian.<family>.v1` | per family | $1$ | nie mieszać rodzin |
| `cell.volume.v1` | wszystkie rodziny | $\mathrm{m^3}$ | dodatnia i skończona |
| `edge_aspect.<family>.v1` | per family | $1$ | max/min edge albo jawna inna definicja |
| `skewness.<family>.v1` | per family | $1$ | family reference mapping |

#### Minimalny layout FMMQ v2

1. Stały nagłówek z magic, version, endian i header length.
2. Topology fingerprint v3.
3. Policy fingerprint.
4. Mesh revision i artifact ID.
5. Certifier build/version.
6. Family table z node arity, element count i ordinal ranges.
7. Scope/marker/region arrays.
8. Metric directory z ID, jednostką, dtype, count, offset i checksum.
9. Per-element albo per-pair ordinals.
10. Sampling metadata, jeśli kanał nie jest pełny.
11. Sidecar source/runtime identity.
12. Whole-payload digest.

#### Zadania

1. Zamrozić schema i byte layout przed implementacją writerów.
2. Dodać Rust types i independent verifier.
3. Dodać Python producer wywołujący ten sam Rust quality engine, nie drugi algorytm.
4. Dodać bounds/overflow checks przed alokacją.
5. Dodać monotonic ordinal i family-range checks.
6. Dodać topology/policy/revision mismatch rejection.
7. Dodać v2 resource w API bez usuwania v1 readera.
8. Oznaczyć v1 jako legacy/non-qualifying.
9. Dodać summary projection generowaną z v2.
10. Dodać bounded worst-element index bez duplikowania pełnych arrays w JSON.
11. Walidować długość, tag alignment i finiteness danych jakości zwracanych przez Gmsh.
12. API musi wykonać pełny parse/identity preflight przed publikacją resource.
13. Writer publikuje FMMQ wyłącznie przez atomic replace.
14. Legacy tet4-only validator musi mieć typed mixed dispatch albo wczesny rejection.

#### Testy RED/GREEN

- magic/version/endian;
- truncated header i payload;
- integer overflow w offset/count;
- overlapping channels;
- unknown required metric;
- non-finite value;
- wrong unit albo metric ID;
- wrong family count;
- topology fingerprint mismatch;
- policy fingerprint mismatch;
- stale mesh revision;
- zmiana jednego bajtu po seal;
- v1 odrzucony przez production gate, ale czytelny w legacy UI.

#### Gate wyjścia

Wszystkie quality summaries używane przez API i UI dają się odtworzyć wyłącznie z FMMQ v2 oraz
jego identity. JSON certificate nie udaje per-element quality carrier.

### 16.7 Faza 6 — jeden Rust certifier i native preflight

#### Cel

Usunąć koszt i ryzyko dwóch rozbieżnych implementacji certyfikacji.

#### Zadania

1. Spisać, które inwarianty są strukturalne, które family-quality, a które runtime-specific.
2. Ustalić Rust jako canonical engine dla deterministycznych inwariantów.
3. Python przekazuje typed arrays i odbiera certificate/quality result.
4. Native FEM loader wykonuje co najmniej structural preflight i identity check.
5. Trusted cache omija kosztowną rekonstrukcję, ale nigdy preflight.
6. Dodać certifier version/build identity.
7. Włączyć kontrolę liczby wątków Rayon.
8. Zapisać stage timing osobno dla transfer, certifier compute i serialization.
9. Ograniczyć peak memory przez borrowed/zero-copy arrays tam, gdzie bezpieczne.
10. Usunąć powtarzane pełne skany dopiero po parity proof.

#### Performance gate planowany

```text
native_certificate_p95 <= 5 s
native_certificate_median_speedup >= 7.5x versus frozen Python baseline
certificate_digest identical for Rayon 1/2/4/8
```

Progi są warunkami planu. Nie są aktualnym wynikiem.

#### Gate wyjścia

- jeden canonical certificate digest;
- parity na golden i corrupted fixtures;
- brak pominięcia preflight na reload;
- brak mutation po certificate;
- peak RSS w ustalonym limicie.

### 16.8 Faza 7 — persistence, cache, determinism i performance

#### Cel

Zamienić obecny szybki path w powtarzalny, bezpieczny mechanizm produkcyjny.

#### Canonical cache key

Cache key musi obejmować co najmniej:

```text
geometry canonical bytes or import digest
geometry transforms and units
material/region/interface assignment
normalized FemMeshPolicyIR
resolved mesher options affecting topology
Gmsh version and relevant plugins
topology schema and fingerprint version
quality schema and certifier version
source compatibility epoch
```

Nie musi obejmować solver settings, które nie wpływają na siatkę. Każde wyłączenie składnika
wymaga testu non-influence.

#### Zadania

1. Udokumentować key encoder i version.
2. Namespacować cache per repo/worktree/source compatibility.
3. Stosować atomic write do unikalnego temporary directory.
4. Fsync/close przed promote tam, gdzie system plików to wspiera.
5. Lock ma owner metadata i heartbeat.
6. Uszkodzony entry przechodzi do quarantine, nie jest nadpisywany po cichu.
7. Warm reload weryfikuje hashes i native preflight.
8. Cold path zawsze wykonuje pełną generację i certyfikację.
9. Zmierzyć stage timings i peak RSS.
10. Wykonać determinism matrix.

#### Plan pomiarów

| Seria | Liczba prób | Cache | Wątki | Cel |
|---|---:|---|---:|---|
| C1 | 5 | cold | default | mediana i p95 całego pipeline |
| C2 | 3 | cold | 1 | referencja deterministyczna |
| W1 | 10 | warm | default | reload p95/max |
| R1 | 10 na wariant | cold | 1/2/4/8 | fingerprint/digest parity |
| X1 | 2 równolegle | cold | default | writer concurrency |

#### Planowane bramki

- warm cache p95 `<= 2.0 s`, max `<= 2.5 s`;
- cold p95 `<= 180 s`;
- cold median `<= 65%` zamrożonego baseline;
- verify/deserialize `<= 1.5 s`;
- RSS `<= max(2 GiB, 1.1 * baseline)`;
- identyczne counts/fingerprints/digests we wszystkich próbach determinism.

#### Interpretacja istniejącego wyniku

Wynik `21.189 s` jest dowodem, że kierunek optymalizacji może dać realne przyspieszenie. Nie
jest jednak automatycznym PASS fazy 7, ponieważ pochodzi z jednego cold run, dirty snapshotu i
nie ma kompletnej macierzy determinism/cache.

### 16.9 Faza 8 — hardening Windows-first build i runtime publication

#### Cel

Windows pozostaje właścicielem checkoutu i interakcji użytkownika, a każda pomocnicza trasa ma
jawny kontrakt oraz odseparowany stan.

#### Docelowy routing

```text
just windows-build ... backend=fdm
    -> PowerShell
    -> native Windows CMake/Cargo/CUDA
    -> generation manifest

just windows-build ... backend=fem
    -> PowerShell `run_fullmag_fem.ps1`
    -> Docker/Linux managed FEM image/runtime
    -> Windows-visible immutable manifest/evidence
```

WSL nie jest potrzebny do tego routingu. Docker Desktop dostarcza izolowany Linux container,
ale Windows pozostaje jedynym właścicielem working tree, IDE i indeksu Git.

#### Granica CI

Lokalny build, uruchomienie i orkiestracja pozostają Windows-native: PowerShell
wywołuje Docker Desktop dla FEM oraz natywne narzędzia MSVC/CUDA dla FDM. Żaden
z tych przepływów nie wymaga interaktywnego WSL ani `wsl.exe`.

Obecny kontekst `frontend-3d-managed-fem / managed-fem-qualification` używa
etykiety `[self-hosted, linux, x64, fem-managed]`. Jest to runner Linux, nie
WSL. Wynika to z kontraktu aktualnego managed receipt: `ensure-managed-fem-runtime`
i powiązane helpery sprawdzają linuksowy `ext4`, loop-device, `findmnt` oraz
trwały mount dla bundla. To nie jest ograniczenie Windowsowego entry pointu, tylko
osobna granica dowodu kwalifikacyjnego.

`ext4` nie jest wymaganiem meshera ani solvera. Jest mechanizmem provenance dla
obecnego eksportera: odcina CIFS/niestabilny widok WSL, potwierdza backing image
przez loop-device i daje znaną semantykę zapisu/rename dla publikacji bundla.
Dlatego nie należy przenosić tego warunku do każdego środowiska ani wyłączać go
globalnie. Należy wprowadzić jawne profile storage/receipt:

```text
linux-ext4-loop-v1   = dedicated Linux runner, ext4 + loop + findmnt proof
windows-folder-v1    = Windows local NTFS/ReFS folder + volume/path proof
```

Profil `windows-folder-v1` może używać np. `C:\fullmag-managed` lub
`FULLMAG_WINDOWS_MANAGED_ROOT` i nie wymaga osobnego dysku. Musi jednak mieć
równoważny kontrakt: absolutny lokalny path poza checkoutem, odrzucenie
junction/symlink/UNC escape, namespace repo/worktree/runtime, write/free-space
probe, owner metadata, staging i atomową promocję w obrębie tego samego volume,
oraz `storage_profile` i volume/path identity w manifeście. Scratch kompilacji
może pozostać w dockerowym Linux volume, a Windowsowy folder przechowywać
immutable bundle/receipt/evidence. Sam bind mount i `docker info --format
'{{.OSType}}'` nie są jeszcze dowodem równoważności.

Nie wolno zastąpić etykiety `linux` przez `windows` bez jednoczesnego wdrożenia
i przetestowania adaptera storage/receipt dla Windows + Docker Desktop. Sama
zmiana etykiety dałaby pozornie zielony job, ale nie dostarczyłaby tego samego
dowodu. Docelowa migracja managed gate na Windows jest dopuszczalna, lecz wymaga
osobnego acceptance gate: Windows self-hosted runner, Docker Desktop Linux
engine, GPU (dla lane GPU), zewnętrzny writable root i pełna zgodność manifestu
oraz source identity.

#### Zadania

1. Utrzymać argument order i walidację `just windows-build` jednoznacznie udokumentowane.
2. Dodać preflight Docker engine/buildx z przechwyceniem stderr bez fałszywego
   `NativeCommandError`.
3. Zachować mutex tylko przez build/publication, zwolnić go przed długą symulacją.
4. Dodać owner metadata do mutex/export lock.
5. Namespacować `C:\fullmag-cache` per worktree/runtime generation.
6. Atomowo publikować native FDM binaries i manifest.
7. Atomowo publikować managed FEM bundle.
8. Naprawić kontrakt opcjonalnego Nsight.
9. Testować `BuildMode=true` i `BuildMode=false`.
10. Odrzucać stale/foreign manifest z czytelną komendą naprawczą.
11. Naprawić cały managed alias chain przez exporter i atomic promotion.
12. Namespacować Compose project, state, build, network i port per worktree.
13. Usunąć destrukcyjny prune z normalnego ensure; cleanup zaczyna się dry-runem.
14. Rozdzielić schema-2 Windows smoke od schema-3 managed qualification.
15. Uzgodnić root package manager i pinned Corepack provisioning.
16. Przenieść Control Room build output poza source checkout.
17. Utrzymać Git safe-directory jako minimalny per-command trust, bez globalnego wildcardu.
18. Dodać i zwalidować `windows-folder-v1` adapter managed storage/receipt; dopiero
    po jego acceptance gate rozważyć Windows self-hosted managed CI.

#### Testy kontraktowe

- Docker daemon unavailable;
- buildx brak/nieaktywny;
- stale mutex z martwym ownerem;
- żywy owner;
- build failure przed publication;
- source changes podczas build;
- obcy worktree manifest;
- mismatch jednej binarki;
- build-only i run modes;
- FEM CPU, FEM GPU, FDM CPU, FDM GPU routing;
- ścieżka ze spacją;
- brak Nsight w zwykłym runtime.
- Windows managed storage: path poza checkoutem, junction/UNC rejection, volume
  identity, staging/promotion po restarcie i równoległy build dwóch worktree.

#### Gate wyjścia

Focused Windows contract suite ma zero failures. Oba tryby startują lub odmawiają startu
zgodnie z manifestem. Żaden runtime nie jest współdzielony między worktree bez jawnej identity.

### 16.10 Faza 9 — managed FEM CPU i GPU qualification

#### Cel

Udowodnić rzeczywiste wykonanie tej samej certified mesh na obu produkcyjnych lane FEM.

#### CPU recipe

1. Zweryfikować managed runtime manifest.
2. Wymusić FEM CPU i double precision.
3. Załadować immutable FMMT/FMMQ pair.
4. Wykonać native preflight.
5. Wykonać step-0/operator smoke i krótki bounded stage.
6. Zapisać biblioteki, thread count, peak RSS i timing.
7. Zapisać absence of GPU requirement/fallback semantics.

#### GPU recipe

1. Zweryfikować ten sam source/policy/topology/quality input.
2. Wymusić FEM GPU i double precision.
3. Zapisać real device UUID/name/compute capability/driver.
4. Udowodnić GPU residency dla operatorów kwalifikowanych.
5. Udowodnić brak CPU fallback.
6. Udowodnić brak niedozwolonych H2D/D2H w hot loop.
7. Wykonać ten sam step-0/operator smoke i krótki bounded stage.

#### Parity

Porównywać należy:

- policy fingerprint;
- topology fingerprint;
- FMMQ digest;
- certificate digest;
- family/region counts;
- step-0 observables;
- krótki wynik stage w jawnej tolerancji;
- error/fallback flags.

Nie należy wymagać bitowej identyczności floating-point CPU/GPU, jeżeli algorytm i kolejność
redukcji są różne. Tolerancja musi być zdefiniowana przed wynikiem, nie po jego zobaczeniu.

#### Gate wyjścia

Istnieją `managed-fem-cpu-receipt.v2.json`, `managed-fem-gpu-receipt.v2.json` i
`cpu-gpu-parity-receipt.v2.json`, związane z jednym mesh artifact ID.

### 16.11 Faza 10 — API, Control Room i browser/WebGL

#### Cel

Pokazać dokładnie ten sam certified artifact użytkownikowi, bez rekonstruowania jakości w UI.

#### API

1. Dodać typed mesh identity resource.
2. Dodać FMMQ v2 metadata i ranged artifact endpoint.
3. Dodać scoped summaries i worst-element references.
4. Dodać structured quality failures.
5. Powiązać resource revision z session mesh revision.
6. Zaktualizować OpenAPI i generated clients.

#### Control Room

1. Inspector pokazuje family, region, role, metric ID, threshold i observed.
2. Histogram jest projekcją FMMQ, nie ponownym obliczeniem.
3. Worst element selection używa stable ordinal/revision.
4. Viewport rozróżnia `prism6`, `pyramid5` i `tet4`.
5. UI pokazuje `degraded`, `unqualified`, `stale` i `mismatch` bez zielonego PASS.
6. Context loss nie ukrywa się jako brak danych.

#### Real browser proof

- otworzyć rzeczywistą sesję;
- poczekać na API/session readiness;
- potwierdzić artifact/receipt ID w DOM/resource state;
- potwierdzić canvas visible;
- odczytać `clientWidth/clientHeight`;
- odczytać drawing buffer dimensions;
- potwierdzić aktywny WebGL context;
- sprawdzić console errors;
- wykonać selection worst element;
- zapisać screenshot i structured browser evidence.

#### Gate wyjścia

Browser evidence wskazuje ten sam receipt, policy, topology i quality digest co managed CPU/GPU.
Test DOM bez aktywnego WebGL nie wystarcza.

### 16.12 Faza 11 — macierz S1–S13

#### Strategia

S13 jest pierwszym pełnym qualification target. Po jego PASS kolejne scenariusze rozszerzają
zakres, ale nie zmieniają dowodu S13.

| Scenariusz | Główne ryzyko | Wymagany dodatkowy dowód |
|---|---|---|
| S1 Box thin film | local refinement i interfejs | scoped targets i material interface |
| S2 flat ArchWaveguide | sweep przez grubość | resolved axis/layers i airbox grading |
| S3 curved ArchWaveguide | body-only assumptions | curved geometry legality albo reject |
| S4 Cylinder | sidewall/top-bottom | curvature/edge zones i family quality |
| S5 multi-object | konflikt lokalnych polityk | finest-source resolution i region identity |
| S6 imported STL | utrata CAD semantics | component-aware degraded contract |
| S7 concatenated STL | przybliżona topologia | explicit approximation status |
| S8 coarse air/fine object | transition grading | adjacent growth i airbox bands |
| S9 sphere | radial geometry | radial strategy albo fail-closed reject |
| S10 swept/thin-film | proxy metric drift | truthful family metric IDs |
| S11 Control Room | projection drift | typed resource i worst selection |
| S12 public example | zasoby i runtime | bounded nodes/RAM/no silent coarsening |
| S13 native mixed Box | end-to-end identity | full CPU/GPU/API/browser receipt |

#### Gate per scenario

Każdy scenario receipt zawiera:

```text
fixture id/version
requested policy
resolved policy
legality decision
generator report
mesh artifact identity
family/region/scope counts
quality/FMMQ identity
managed lane receipts
browser receipt where required
performance/resource measurements
final qualified/unsupported/degraded status
```

Brak wsparcia jest dopuszczalnym wynikiem tylko wtedy, gdy planner odrzuca kombinację przed
kosztowną generacją i dokumentacja nie obiecuje jej jako wspieraną.

### 16.13 Faza 12 — sealed receipt, capability i dokumentacja

#### Cel

Zamknąć pracę jednym weryfikowalnym indeksem i zsynchronizować wszystkie publiczne deklaracje.

#### Zadania

1. Wykonać source snapshot after i porównać z before.
2. Zbudować `production-receipt.v2.json` z hash chain.
3. Uruchomić niezależny verifier na evidence bundle.
4. Skopiować bundle do nowego katalogu i powtórzyć verify bez cache.
5. Promować capability tylko dla dokładnych krotek z PASS receipt.
6. Zaktualizować `docs/specs/capability-matrix-v0.md`.
7. Zaktualizować noty `0105` i `0106` bez nadpisywania niezakwalifikowanych lane.
8. Oznaczyć stare raporty jako historical/superseded.
9. Dodać source maps dla zmienionych stron naukowych.
10. Uruchomić scientific docs validators, strict Sphinx i rendered HTML validation.
11. Uruchomić public example guard.
12. Zachować masterplan jako historię decyzji, a nie przepisać go na „wszystko zrobione”.

#### Gate wyjścia

```text
source_before == source_after
runtime manifests valid
FMMQ version == 2
CPU receipt == PASS
GPU receipt == PASS
CPU/GPU parity == PASS
API receipt == PASS
browser/WebGL receipt == PASS
production receipt verifier == PASS
capability entries exactly match receipt scope
documentation has no contradictory current status
```

#### Status po fazie

Nawet po pełnym S13 PASS poprawne sformułowanie brzmi:

```text
FEM mixed-P1 Box + bbox airbox + layers 1..3,
managed CPU/GPU double, exact receipt scope: QUALIFIED
```

Nie wolno skracać tego do „cały mesher Fullmag jest produkcyjny”, dopóki pozostałe S1–S12 i
inne capability tuples nie mają własnych dowodów.

---

## 17. Pakiety zmian i kolejność integracji

Duże atomowe przejście semantyczne nie oznacza jednego ogromnego commita. Poniższe pakiety mogą
być przeglądane osobno, ale żaden częściowy writer cutover nie może zostać wypuszczony jako
produkcyjny.

| WP | Zakres | Problemy | Zależność | Rozmiar |
|---|---|---|---|---|
| WP-00 | source freeze, repo root, evidence namespace | OPS-001..005 | brak | S |
| WP-01 | policy inventory i canonical fixtures | MESH-003/004/006/019/023 | WP-00 | M |
| WP-02 | typed IR i validation cutover | MESH-003/004/006 | WP-01 | L |
| WP-03 | UI/API/Python round-trip | MESH-003/004/013/017 | WP-02 | L |
| WP-04 | resolved field application report | MESH-001/019/020 | WP-02 | M |
| WP-05 | measured adjacency growth | MESH-001/007/014 | WP-04 | L |
| WP-06 | region/interface ABI hardening | MESH-012/016/018 | WP-02 | L |
| WP-07 | family metric definitions | MESH-002/007/008 | WP-06 | L |
| WP-08 | FMMQ v2 schema/verifier | MESH-009, QUAL-005/006 | WP-07 | XL |
| WP-09 | Rust certifier/native preflight parity | MESH-002/011/012/021 | WP-07 | L |
| WP-10 | cache/concurrency/determinism | MESH-010/011, OPS-005/006 | WP-09 | L |
| WP-11 | Windows publication hardening | OPS-004..010 | WP-00 | L |
| WP-12 | managed FEM CPU proof | QUAL-003/006/010 | WP-08/09/11 | L |
| WP-13 | managed FEM GPU proof | QUAL-003/006/010 | WP-08/09/11 | XL |
| WP-14 | API quality resource | MESH-014/017, QUAL-001 | WP-08 | L |
| WP-15 | Inspector/WebGL evidence | QUAL-004 | WP-14/12/13 | L |
| WP-16 | performance/determinism suite | QUAL-007/008 | WP-10/12/13 | L |
| WP-17 | sealed receipt and capability promotion | MESH-005/015, QUAL-001/002/009/010 | wszystkie | M |
| WP-18 | truthful public mesh operations/preview/sweep selectors | MESH-024/025/027/037/038 | WP-02/03 | L |
| WP-19 | physical tags i component identity | MESH-028/029/030 | WP-06 | L |
| WP-20 | mixed-periodic i legacy quality cleanup | MESH-031/032/033/034 | WP-07/09 | L |
| WP-21 | API/writer FMMQ hardening | MESH-035/036 | WP-08/14 | M |
| WP-22 | runtime aliases, namespace i safe prune | OPS-011/012/013/017 | WP-00/11 | L |
| WP-23 | package manager, Git ownership i external UI output | OPS-014/015/016 | WP-00/11 | M |

### 17.1 Zalecane granice review

1. Kontrakt i fixtures przed zmianą runtime.
2. Writer i reader FMMQ v2 w jednym merge window, za feature flagą do czasu consumer parity.
3. Quality math oddzielnie od UI presentation.
4. Windows launcher hardening oddzielnie od mesher numerics.
5. Performance optimization dopiero po correct/quality gates.
6. Capability/status/docs wyłącznie w ostatnim pakiecie z receipt.

### 17.2 Reguła feature flags

Feature flag może izolować niedokończony consumer, ale nie może:

- zmieniać wyniku bez wejścia do policy fingerprint;
- automatycznie fallbackować v2 do v1 w qualification;
- ukrywać unsupported lane;
- omijać native preflight;
- promować capability tylko dlatego, że flaga istnieje.

### 17.3 Krytyczna ścieżka

```text
WP-00 -> WP-01 -> WP-02 -> WP-06 -> WP-07 -> WP-08
                                             |       |
                                             v       v
                                           WP-09   WP-14
                                             |       |
                                             +---+---+
                                                 v
                                                WP-12
                                                WP-13
                                                  |
                                                  v
                                                WP-15
                                                  |
                                                  v
                                                WP-17
```

WP-11 można prowadzić równolegle po WP-00. WP-10 i WP-16 można rozpocząć wcześniej jako
instrumentację, ale finalne progi wymagają stabilnego formatu i runtime.

---

## 18. Strategia testów i polecenia kanoniczne

### 18.1 Zasada wyboru środowiska

- Source-only Rust/Python contract tests mogą działać na hostcie, jeżeli repo environment jest
  kompletny.
- Gmsh generation musi używać repo-owned środowiska z przypiętymi zależnościami.
- FEM/MFEM/hypre/libCEED CPU/GPU proof musi używać managed/container `just` recipe.
- Windows launcher tests muszą być uruchomione z Windows PowerShell.
- Browser proof musi używać rzeczywistej przeglądarki, nie wyłącznie mock/DOM.

### 18.2 Source i policy

Przykładowy zestaw focused tests po ustabilizowaniu środowiska:

```powershell
python -m pytest scripts/test_benchmark_fem_mixed_mesh_pipeline.py -q
python -m pytest scripts/test_qualify_fem_mixed_repair_policy.py -q
cargo test -p fullmag-ir mesh_policy
cargo test -p fullmag-ir mixed_certificate
cargo test -p fullmag-plan mixed
```

Dokładne filtry należy potwierdzić przez `--list`/test inventory. Brak testu pod danym filtrem ma
być FAIL konfiguracji, nie zielony wynik z `0 tests`.

### 18.3 Windows contract

```powershell
python -m pytest scripts/test_windows_fullmag_launcher_contract.py -q
just windows-doctor
just windows-build fdm cpu dev
just windows-build fem cpu dev
```

Argumenty recipe są pozycyjne w kolejności z `justfile`:

```text
windows-build backend device frontend
```

Scenariusz można przekazywać tylko przez recipe, które jawnie go deklaruje; nie należy zakładać,
że czwarty argument zostanie dowolnie zinterpretowany.

### 18.4 Managed FEM runtime

```powershell
just ensure-managed-fem-runtime
just rebuild-fem-runtime
just verify-fem-mixed-prism-airbox-runtime
just verify-fem-meshing-production
```

`rebuild-fem-runtime` jest droższe i powinno być wykonywane dopiero po stabilizacji źródła.
`ensure-managed-fem-runtime` może poprawnie odmówić reuse, jeżeli identity nie pasuje.

### 18.5 Benchmark

Benchmark ma zapisywać wynik do nowego evidence root, nie nadpisywać historycznego artefaktu.

```powershell
python scripts/benchmark_fem_mixed_mesh_pipeline.py --help
```

Po sprawdzeniu aktualnych argumentów uruchomić canonical fixture i zapisać:

- pełne argv;
- environment allowlist;
- source/runtime/policy identity;
- stage timings;
- counts/fingerprint/certificate;
- peak RSS;
- cold/warm classification;
- raw log i parsed result.

### 18.6 Scientific documentation gates

Dla zmian terminalnych stron naukowych obowiązują:

```powershell
python .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py `
  <page>.source-map.json --repo-root .
python -m unittest discover `
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
python scripts/check_public_doc_examples.py --root public_docs/site
```

Następnie changed-page gate, strict Sphinx i rendered HTML. Niniejszy plik jest wewnętrznym
planem w `docs/`, więc nie udaje terminalnej strony publicznej ani finalnego source-map receipt.

### 18.7 Negatywne testy są obowiązkowe

Każdy gate musi wykazać co najmniej jeden kontrolowany FAIL. W szczególności:

- wrong source snapshot;
- wrong runtime generation;
- policy fingerprint mismatch;
- topology mutation;
- FMMQ tamper;
- CPU fallback przy forced GPU;
- stale mesh revision w API;
- zero drawing buffer w browser;
- stale cache writer;
- nieaktywny authored parametr.

Gate, który nigdy nie został pokazany na negatywnym fixture, może być no-op i nie kwalifikuje
produkcji.

---

## 19. Struktura evidence bundle

### 19.1 Układ katalogu

```text
fem-meshing-production/<run-id>/
  qualification-scope.v1.json
  source-snapshot-before.v1.json
  source-snapshot-after.v1.json
  toolchain-inventory.v1.json
  policy/
    requested-policy.json
    normalized-policy.json
    resolved-policy.json
    application-report.json
  mesh/
    topology.fmmt
    topology-manifest.json
    mixed-certificate.json
    quality.fmmq
    quality-summary.json
  runtime/
    managed-fem-cpu-manifest.json
    managed-fem-gpu-manifest.json
    windows-launcher-contract.json
  execution/
    fem-cpu-receipt.json
    fem-gpu-receipt.json
    cpu-gpu-parity-receipt.json
  api/
    resource-contract.json
    openapi-digest.json
  browser/
    browser-evidence.json
    screenshot.png
    console.json
  performance/
    cold-runs.jsonl
    warm-runs.jsonl
    stage-summary.json
    resource-summary.json
  logs/
  hashes.sha256
  production-receipt.v2.json
```

### 19.2 Minimalny receipt v2

```json
{
  "schema_version": "fullmag.fem_meshing_production_receipt.v2",
  "status": "sealed",
  "scope": {
    "scenario": "S13",
    "geometry": "box",
    "airbox": "bbox",
    "strategy": "mixed_p1",
    "layers": [1, 2, 3],
    "precision": "double"
  },
  "identity": {
    "source_snapshot_sha256": "<sha256>",
    "runtime_cpu_generation": "<id>",
    "runtime_gpu_generation": "<id>",
    "policy_fingerprint": "<sha256>",
    "topology_fingerprint": "<sha256>",
    "quality_sha256": "<sha256>",
    "certificate_sha256": "<sha256>"
  },
  "gates": {
    "source_stable": "pass",
    "quality": "pass",
    "managed_cpu": "pass",
    "managed_gpu": "pass",
    "cpu_gpu_parity": "pass",
    "api": "pass",
    "browser_webgl": "pass",
    "performance": "pass"
  },
  "inputs_sha256": "<sha256>",
  "sealed_at": "<RFC3339>"
}
```

To jest planowany kontrakt ilustracyjny. Przed implementacją wymaga JSON Schema, ADR alignment i
testów. Placeholdery nie mogą trafić do prawdziwego receiptu.

### 19.3 Reguły ścieżek i hashy

- Ścieżki w receipt są względne do evidence root.
- Symlink/junction escape poza root jest odrzucany.
- Każdy plik wejściowy ma SHA-256 i rozmiar.
- Lista plików jest sortowana kanonicznie.
- Receipt nie hashuje samego siebie bez zdefiniowanej procedury seal.
- Timestamps nie wchodzą do naukowych fingerprintów.
- Host absolute paths mogą być diagnostyką, ale nie składnikiem portability identity.
- Sekrety i pełne środowisko procesu nie są zapisywane; tylko allowlist potrzebna do reprodukcji.

### 19.4 Statusy gate

Dozwolone wartości:

```text
pass
fail
unsupported
unavailable
not_run
```

`unsupported`, `unavailable` i `not_run` nigdy nie agregują się do produkcyjnego PASS. Pole
`warning` jest dodatkowe i nie zastępuje statusu.

---

## 20. Rejestr ryzyk i plan wycofania

| Ryzyko | Prawdopodobieństwo | Skutek | Mitigacja | Rollback |
|---|---|---|---|---|
| V04 cutover łamie stare scenariusze | średnie | wysokie | golden fixtures i staged readers | przywrócić reader, nie dwóch writerów |
| FMMQ v2 zwiększa pamięć | wysokie | średnie/wysokie | channels on demand, mmap, bounded summaries | pozostawić v1 legacy UI, bez qualification |
| Rust certifier zmienia wynik | średnie | wysokie | parity corpus przed cutover | utrzymać Python oracle diagnostycznie |
| adjacency scan spowalnia cold run | średnie | średnie | reuse face ownership, parallel reduce | gate za flagą engineering, bez promocji |
| cache daje false hit | niskie/średnie | krytyczne | exhaustive invalidation tests | disable cache, zachować cold path |
| dwa worktree publikują jeden runtime | wysokie obecnie | krytyczne | namespace + atomic generation | odmówić reuse i rebuild locally |
| GPU path fallbackuje na CPU | średnie | krytyczne | forced device + runtime telemetry | FAIL GPU lane |
| WebGL proof jest flaky | średnie | średnie | readiness gates, bounded retries, evidence | status unavailable, bez promocji |
| quality thresholds są zbyt ostre | średnie | wysokie | fixtures i naukowa kalibracja przed wynikiem | nie stroić po wyniku; wrócić do review |
| dokumentacja znów dryfuje | wysokie | średnie | receipt-linked capability + source maps | revert status promotion |
| aktywny proces zostanie uznany za stale | średnie | wysokie | owner/heartbeat inventory | brak auto-kill; ręczna decyzja |

### 20.1 Zasady rollbacku

1. Rollback ma przywracać ostatnią sealed generation, nie kopiować pojedynczych plików.
2. Uszkodzone evidence pozostaje w quarantine do analizy.
3. Nie cofać schema writer bez zachowania reader compatibility plan.
4. Nie przywracać silent fallback jako szybkiej naprawy.
5. Nie obniżać quality threshold bez nowej noty fizycznej i walidacji.
6. Wyłączenie cache jest bezpiecznym rollbackiem; wyłączenie preflight nie jest.
7. Wyłączenie GPU lane jest bezpieczniejsze niż CPU fallback pod etykietą GPU.

### 20.2 Stop conditions całego programu

Prace kwalifikacyjne zatrzymują się, gdy:

- source snapshot zmienił się w trakcie;
- nie można ustalić ownera aktywnego runtime/build;
- publiczny parametr nie ma jednoznacznego IR mapping;
- metryka nie ma równania/definicji/jednostki;
- CPU i GPU używają innego mesh artifact;
- FMMQ nie wiąże topology/policy/revision;
- test negatywny nie powoduje FAIL;
- browser resource nie wskazuje tego samego receipt;
- quality poprawia się tylko po osłabieniu progu bez naukowego uzasadnienia.

---

## 21. Definition of Done

### 21.1 DoD dla ograniczonego S13

- [ ] source tree jest czysty i stabilny;
- [ ] commit i source snapshot before/after są zgodne;
- [ ] `FemMeshPolicyIR` jest jedynym aktywnym źródłem mesh semantics;
- [ ] `sweep_direction` zachowuje requested/resolved round-trip;
- [ ] malformed values są odrzucane we wszystkich warstwach;
- [ ] `MeshOperation`, assembly fields i sweep selectors są wykonywane albo niedostępne;
- [ ] preview artifact nie może zostać użyty jako solver mesh;
- [ ] requested/effective Gmsh algorithm jest związany z policy;
- [ ] `growth_rate` jest realizowany i zmierzony albo odrzucony;
- [ ] strict magnetic region zawiera `prism6`, bez hidden tet conversion;
- [ ] transition/airbox zawiera legalne `pyramid5/tet4`;
- [ ] exact layers `1..3` są potwierdzone;
- [ ] owner/marker/interface ABI przechodzi;
- [ ] każdy element ma jawny physical tag, bez domyślnego markera;
- [ ] component identity nie zależy od niejednoznacznego bbox overlap;
- [ ] mixed-periodic ma spójny support/rejection w Python i native;
- [ ] family-aware Jacobian/volume/aspect/skew przechodzą;
- [ ] measured adjacent growth przechodzi;
- [ ] FMMQ v2 przechodzi structural, identity i tamper gates;
- [ ] Gmsh quality vectors przechodzą count/finite/tag alignment checks;
- [ ] FMMQ API wykonuje pełny parser i identity preflight;
- [ ] FMMQ writer publikuje atomowo;
- [ ] Rust certificate i native preflight są zgodne;
- [ ] cache invalidation/concurrency/determinism przechodzą;
- [ ] cold/warm performance gate przechodzi;
- [ ] managed FEM CPU double receipt przechodzi;
- [ ] managed FEM GPU double receipt przechodzi bez fallbacku;
- [ ] managed runtime alias chain jest kompletny i wskazuje aktywną generation;
- [ ] Compose/state/build/network/port są izolowane per worktree;
- [ ] ensure nie wykonuje destrukcyjnego prune;
- [ ] schema-2 Windows smoke nie jest mylony ze schema-3 managed proof;
- [ ] root package manager i pinned pnpm provisioning są spójne;
- [ ] frontend build nie modyfikuje source checkout;
- [ ] CPU/GPU parity receipt przechodzi;
- [ ] API resource używa tego samego mesh/quality identity;
- [ ] real browser/WebGL proof przechodzi;
- [ ] sealed production receipt przechodzi niezależny verify;
- [ ] capability matrix promuje wyłącznie exact S13 tuple;
- [ ] dokumentacja i source maps przechodzą wszystkie gate'y.

### 21.2 DoD dla całego meshera FEM

Pełny mesher można nazwać produkcyjnym dopiero po zamknięciu odpowiednich lane S1–S13, wszystkich
P0/P1 w tym dokumencie oraz capability tuples obiecanych publicznie. S13-only PASS nie wystarcza.

### 21.3 Minimalny status raportowy przed DoD

```text
bounded strict mixed-P1 Box: implemented, historically benchmarked
current checkout qualification: not complete
whole FEM meshing module: not production qualified
```

---

## 22. Indeks źródeł kodu i odpowiedzialności

| Odpowiedzialność | Ścieżka | Symbol/anchor | Lane |
|---|---|---|---|
| policy IR | `crates/fullmag-ir/src/mesh_policy.rs` | `FemMeshPolicyIR` | shared authoring |
| mixed certificate IR | `crates/fullmag-ir/src/mixed_certificate.rs` | certificate validation | FEM CPU/GPU |
| topology assets IR | `crates/fullmag-ir/src/mesh_assets.rs` | mixed topology asset types | FEM CPU/GPU |
| public policy models | `packages/fullmag-py/src/fullmag/model/discretization.py` | mesh recipe/policy classes | Python |
| public mesh operations | `packages/fullmag-py/src/fullmag/model/discretization.py` | `MeshOperation` | Python |
| numeric controls | `packages/fullmag-py/src/fullmag/meshing/mesh_controls.py` | scalar/vector validators | Python |
| problem cache key | `packages/fullmag-py/src/fullmag/model/problem.py` | `_fem_mesh_cache_key` | meshing |
| runtime lowering | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | `_mesh_options_from_runtime_metadata` | meshing |
| resolved field plan | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | `build_size_field_plan` | meshing |
| Gmsh options | `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `apply_mesh_options` | meshing |
| targets/coercion | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `_coerce_positive_float` | meshing |
| typed mesh options | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `MeshOptions` | meshing |
| mixed certificate Python | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `MixedLayerTopologyCertificate` | meshing |
| swept strategies | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `SWEEP_STRATEGY_HEX` | meshing |
| airbox realization | `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py` | mixed airbox build | meshing |
| Gmsh generation/fallback | `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py` | algorithm and STL mapping | meshing |
| extraction markers | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | `_extract_element_markers_for_tags` | meshing |
| extraction quality | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | `_extract_quality_metrics` | meshing |
| repair/extraction | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | shared-domain pipeline | meshing |
| degenerate cleanup | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `_drop_degenerate_tetrahedra` | meshing |
| preview realization | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `realize_fem_mesh_asset` | preview |
| legacy quality | `packages/fullmag-py/src/fullmag/meshing/quality.py` | `validate_mesh` | tet4 legacy |
| quality writer | `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py` | `_write_quality_data_artifact_if_available` | meshing |
| persistence | `packages/fullmag-py/src/fullmag/meshing/persistence.py` | cache serialization/reload | meshing |
| FMMQ v1 API reader | `crates/fullmag-api/src/fem_cross_section.rs` | `per_element_quality_metric_from_fmmq` | API |
| FMMQ API resource | `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs` | `read_mesh_quality_data_artifact` | API |
| Python/Rust bridge | `crates/fullmag-py-core/src/mixed_certificate.rs` | certificate bridge | FEM CPU/GPU |
| production verifier | `scripts/verify_fem_meshing_production.py` | `main` | qualification |
| mixed runtime verifier | `scripts/verify_fem_mixed_prism_airbox_runtime.py` | `main` | qualification |
| benchmark | `scripts/benchmark_fem_mixed_mesh_pipeline.py` | `main` | performance |
| source identity | `scripts/capture_source_snapshot_identity.py` | CLI entry point | provenance |
| Windows native launcher | `scripts/windows/run_fullmag.ps1` | build/reuse/run flow | FDM Windows |
| Windows FEM adapter | `scripts/windows/run_fullmag_fem.ps1` | build/reuse/run flow | FEM container |
| managed exporter | `scripts/export_fem_gpu_runtime.sh` | runtime export | FEM GPU |
| runtime storage | `scripts/lib/managed_fem_runtime_storage.sh` | alias/storage helpers | FEM managed |
| runtime restore | `scripts/restore_persistent_fem_runtime.sh` | persistent restore | FEM managed |
| runtime prune | `scripts/prune_managed_fem_runtimes.sh` | explicit cleanup | FEM managed |
| runtime bundle validator | `scripts/validate_managed_fem_runtime_bundle.py` | CLI entry point | FEM GPU |
| Windows image | `docker/fem-gpu/Dockerfile` | Nsight installation | tooling |
| orchestration | `justfile` | `verify-fem-meshing-production` | qualification |

Indeks jest listą stabilnych `path + symbol`, nie ręcznie utrzymywanymi numerami linii. Przy
publikacji immutable links należy wygenerować z pełnego commit SHA.

---

## 23. Decyzje zamrożone i pytania otwarte

### 23.1 Decyzje zamrożone

1. Windows jest głównym checkoutem i entry pointem.
2. FEM CPU/GPU używa managed Linux/container runtime.
3. WSL nie jest właścicielem checkoutu.
4. Strict mixed topology nie dopuszcza hidden prism-to-tet conversion.
5. FMMT v2 i FMMQ v2 są różnymi kontraktami.
6. `SmoothRatio` nie jest quality proof.
7. Liczba elementów nie jest samodzielnym celem optymalizacji.
8. Przyspieszenie nie może obniżać quality gate.
9. Source/runtime/policy/topology/quality identities muszą być wspólne.
10. Real browser/WebGL jest osobnym gate'em.

### 23.2 Pytania wymagające decyzji przed implementacją

1. Czy publiczna domena `growth_rate` ma być ściśle `> 1`, czy wspierać `1` jako uniform?
2. Czy bounded strict mixed pozostaje `layers <= 3`, czy planujemy osobną lane `layers >= 4`?
3. Czy `swept_hex` usuwamy z publicznej capability teraz, czy finansujemy pełne wdrożenie?
4. Jakie family-specific definicje skewness są kanoniczne dla prism/pyramid?
5. Jakie progi jakości są naukowo wymagane per scenario i family?
6. Czy FMMQ v2 przechowuje pełne arrays dla wszystkich metryk, czy część może być sampled?
7. Jaki jest maksymalny dopuszczalny rozmiar quality artifact?
8. Jaka tolerancja CPU/GPU obowiązuje dla step-0 i krótkiego stage?
9. Jaki jest okres kompatybilności v1 readera?
10. Jak identyfikujemy worktree w zewnętrznym Windows cache bez host-path dependence?

Brak decyzji w tych punktach nie upoważnia implementatora do zgadywania. Właściwa odpowiedź
powinna zostać zapisana w ADR/nocie fizycznej i w test fixtures przed zmianą kodu.

---

## 24. Konkluzja

Największe osiągnięcie dotychczasowej pracy to usunięcie rzeczywistych kosztów z głównej ścieżki
SP4 mixed-P1 bez widocznego pogorszenia zmierzonych podstawowych bramek jakości. Historyczny,
porównywalny przebieg skrócił się z `111.79 s` do `21.189 s`, czyli o `81.045%` i około
`5.276x`. Jest to realny wynik inżynierski.

Największa pozostała luka nie leży już wyłącznie w samym Gmsh. Leży w pełnym kontrakcie:

```text
authored policy
-> resolved policy
-> generated topology
-> family-aware quality
-> immutable carrier
-> native CPU/GPU execution
-> API resource
-> browser projection
-> sealed receipt
```

Dopóki ten łańcuch nie ma jednej tożsamości i wszystkich gate'ów, poprawny werdykt brzmi:

```text
Realne przyspieszenie ograniczonego przypadku: TAK
Ważne naprawy jakości/topologii:              TAK, częściowo
Pełna produkcyjność całego meshera:           NIE
Znana ścieżka domknięcia:                     TAK — fazy 0..12 tego dokumentu
```
