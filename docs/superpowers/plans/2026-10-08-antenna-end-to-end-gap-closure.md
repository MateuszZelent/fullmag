# Anteny mikrofalowe — domknięcie przepływu od geometrii do pola

## Aktualizacja wykonawcza — 10.10.2026

Publiczny typed lead intent i round-trip są zapisane w `97b320d883b55c5df5daa44e5f70196114164c88`.
Kolejny przyrost podłączył preparację do pełnego eksportu: niezależna raw
`MeshData` z ordered Gmsh identity → source w execution IR → zgodny mirror
physics graph, z zachowaniem authored modelu i małego receipt. Regresje
interpretowane **5/5 PASS** obejmują rzeczywisty microstrip/taper i cache NPZ;
authoring **9/9 PASS**. CLI source-check passed/0:
`5b7533947875483a9840202720fa134f`. Scope i ograniczenia:
nota 0950, `DOC-ANCHOR:antenna-execution-lead-materialization`.

Nie trzeba włączać siatkowania w lekkim `export-scene-config`: aktualna
trasa scratch UI eksportuje skrypt i uruchamia ten sam CLI. Jego lekki
preflight odracza planowanie wymagające mesha, zachowując walidację root
i wszystkich stage IRs. Wykonanie tej nowej ścieżki w native runtime oraz
browser nadal NOT VERIFIED. Sampling target Object z shared airboxem
wymaga osobnego, zgodnego carrier; samo dodanie assetu anteny tego nie
zapewnia. Następnie: actual V/RT0/H, próbkowane J, API i viewport, dopiero
później qualified closure/basis, FFT i LLG. Historyczne checkpointy poniżej
nie zastępują tej aktualizacji ani nie zamykają T00–T18.

## Punkt wznowienia i zakres

To uzupełnienie istniejącego [planu T00–T18](2026-09-08-microwave-antenna-refactoring-plan.md)
i [audytu F01–F13](../../audits/2026-09-08-microwave-antenna-worktree-audit.md),
nie nowy konkurencyjny projekt. Stan sprawdzono 08.10.2026 na bazie
`f693a2f7f58be6516ce074c76abce2d18787c6e2`, następnie zapisano etap
Geometry/root jako `28c41969e77213afa01139bb8afecf3fe34e1542`.
Zlecenie użytkownika obejmuje implementację braków; niniejszy dokument
nie zamyka zadania przez samo przygotowanie planu.

Zachowujemy obecną scenę microstripu. Szeroka złota płyta jest fizycznym
przewodnikiem powrotnym. Nie zastępujemy jej CPW ani geometrią przykładową.
Model autorski, wynik obliczeń i kwalifikacja naukowa są oddzielnymi stanami.

## Czy braki były już zaplanowane?

Tak. W szczególności T04, T05, T06, T14 i T15 wymagają rzeczywistego producenta
prądu, wspólnego wyniku V/RT0/H oraz przepływu UI bez ręcznego wpisywania JSON.
T16–T18 obejmują dalsze backendy, odpowiedź częstotliwościową i kwalifikację.
Obecność definicji, endpointu lub formularza nie jest dowodem domknięcia zadania.

| Oryginalny etap | Potwierdzony stan | Brak do odbioru |
|---|---|---|
| T04 — kompozycja i geometria | Rzeczywiste części microstrip/CPW, stacje, port, transport, solve stage | Automatyczne, jawnie autoryzowane przygotowanie fizycznych doprowadzeń i ich siatki |
| T05 — prąd | Natywny owner H1/material/RT0 i kontrakt wejścia external-lead | Mesh-owner vertex identity, przygotowanie source z terminal caps, faktyczne wykonanie sceny użytkownika |
| T06 — pole | Jeden accepted bundle V/RT0/H; osobny publisher inspekcji | Producent zakwalifikowanej bazy pełnego obwodu, zbieżność i wpływ pominiętego obwodu |
| T07–T13 — baza, projekcja, przebieg, FFT, provenance | Istnieją kontrakty i części implementacji; wcześniejsze checkpointy opisują ich indywidualne bramki | Wykonanie wspólnego, świeżego solve-to-drive workflow, nie tylko source checks |
| T14 — API | Zasoby inspekcji, pięć payloadów źródłowych, dodatkowe immutable XYZ/Tet4 i session/digest/ETag guards; production source-check PASS | Wykonanie nowych endpointów na rzeczywistym wyniku oraz publikacja próbkowanego RT0 J |
| T15 — Control Room | Węzły kompozycji, dedykowane panele, wspólny szablon wizualizacji | Działające authoring wszystkich węzłów, wspólny renderer rzeczywistych pól, standalone solve z UI |
| T16 — FEM-precompute → FDM | Nie jest odebrane end-to-end | Osobne FDM CPU i FDM GPU: transfer, jednostki, zegar, brak fallbacku |
| T17 — odpowiedź harmoniczna | Source FFT nie jest odpowiedzią spinową | Zakwalifikowana podatność/odpowiedź częstotliwościowa i interpretacja modów |
| T18 — kwalifikacja | Historyczne, ograniczone dowody oddzielnych fragmentów | Wszystkie wymagane scenariusze, zbieżność, backendy i końcowy audit |

## Trzy różne produkty danych

1. **Geometria autorska**: wymiary i podgląd przewodników. Nie zawiera obliczonego J.
2. **Inspekcja skończonej domeny**: raw V [V], RT0 moments [A], H [A/m],
   `inspection_only`, `external_electrode_truncation`, `NOT VERIFIED`.
3. **Zakwalifikowana baza i pobudzenie**: per-A V/J/H z poprawną normalizacją,
   pełnym źródłem i świeżymi pinami; dopiero ten produkt jest kandydatem do
   projekcji, source FFT i mnożenia przez prąd w LLG.

Nie zmieniamy statusu produktu 2 na produkt 3 przez zmianę nazwy quantity.
Bilans elektrod nie ogranicza pola od pominiętego generatora i dalszego powrotu.
Sam sweep długości prostych leadów nie zastępuje modelu pominiętej części.
Właścicielem równań pozostaje 0950, anchor
`antenna-accepted-external-electrode-truncation`.

## Sekwencja implementacyjna i kryteria

### A. Inspektory i brak fikcyjnej magnetyzacji

Etap Geometry/root zapisany w powyższym commicie. Root niemagnetycznego
przewodnika nie pobiera magnetic metrics. Geometry ma własny kind i panel.
Szczegółowy zakres każdego węzła jest w
[kontrakcie inspektorów](2026-10-08-antenna-inspectors-ui-contract.md).
HUD i dolna telemetria są osobnymi konsumentami; nadal wymagają zgodnego
katalogu i nie mogą pokazywać `m` ani obliczonych zer bez danych.

Odbiór: TypeScript, lint, Explorer→Geometry, Object/Airbox pending/ACK,
brak żądań metrics dla pustego niemagnetycznego modelu. Dowody zapisane
w kontrakcie inspektorów pozostają ważne dla niezmienionych źródeł.

### B. Rzeczywiste immutable display datasets

Inspektor korzysta z tego samego układu Display/Surface/Coloring/Vectors/
Clipping/Camera/Advanced co magnetyki. Dostępność kontrolek wynika z danych.
Nie aktywujemy przycisku, który nie ma konsumenta w viewportcie.

- V inspekcyjne: retained device IDs → retained XYZ → retained V i device Tet4.
- H inspekcyjne: retained sampling XYZ → raw H [A/m]; punkty/wektory,
  bez wymyślania powierzchni z samego topology digest.
- Bazy V/A, J/A, H/A: jawny wybór portu, dokładne pozycje i własne jednostki.
- J inspekcyjne: osobny evaluator owned RT0 w zadeklarowanych punktach/cells.
  Współczynniki strumienia [A] nie są wektorami gęstości [A/m²].

Nowy read-only zasób display jest oddzielony od manifest-only GET inspekcji.
Zachowuje runtime stage, run, session epochs, record i bundle digest,
qualification i jawne capabilities. Ciężkie XYZ/connectivity/values są binarne.
V nie jest kolorowany na primitive ani na siatce pobranej z bieżącej sceny.

Odbiór: OpenAPI → generated client → facade → scoped resource hooks → adapter
→ jeden viewport. Pełna kontrola rozmiaru, cardinality, endian/layout, finite
values, ownera, digestu i ETag; błędne/stale dane odmawiają. Browser: widoczny
canvas, nieutracony kontekst, niezerowy drawing buffer, rzeczywiste glyphs/
scalar samples, brak recompute przy quantity switch, brak pracy idle.
Fixture renderera nie jest wykonaniem solvera.

### C. Przygotowanie źródła z faktycznej siatki

Pierwszy przyrost zachowuje rzeczywiste ordered Gmsh node tags, wcześniej gubione
przy ekstrakcji i niektórych rekonstrukcjach MeshData. Retencja jest opcjonalna;
mesh bez metadanych tożsamości nie otrzyma zastępczych `index+1` IDs.
Transformacja geometrii, oriented copy oraz save/load nie mogą przestawiać
vertex identity niezależnie od kolejności nodes.

Ten przyrost jest już zaimplementowany w ekstrakcji, rekonstrukcjach i asset
pipeline. Interpretowane sprawdzenie `verify_antenna_mesh_vertex_identity.py
--with-gmsh`: **5/5 PASS**, łącznie z rzeczywistym Gmsh microstrip.
Nie zmienia MeshIR i nie jest jeszcze automatycznym przygotowaniem source.
Kolejna regresja wykazała utratę ID w `_drop_degenerate_tetrahedra`. Po poprawce
interpretowany check ma **6/6 PASS** z `--with-gmsh`: zachowane sparse ID,
brak syntetycznego fallbacku, unchanged nodes z orphan node, markers/facets,
no-op i odmowa nieaktualnego quality. Przed poprawką dokładnie jeden failure
z sześciu checks. Polityka tolerancji i orientacji nie zmieniła się.
Ponowna kontrola konsumenta przygotowania doprowadzeń: **11/11 PASS** z Gmsh.
Jawny kontrakt znajduje się w 0950, anchor
`antenna-straight-lead-preparation`. Prywatny helper jest już zaimplementowany:
`prepare_antenna_external_lead_source` generuje rzeczywiste Tet4 leads i strict
source MeshIR bez rozszerzania lub wyłączania input validatora.
Interpretowana regresja z `--with-gmsh`: **11/11 PASS**, w tym actual microstrip
prosty/taperowany, sparse/permutowane IDs, positive Tet4, exact interface
lineage/volume, odwrócenie/skala/zero current, per-component balance,
round-trip i odmowy unsafe input. Następne bramki to podłączenie do authoringu,
dedicated stage i wykonanie native; prywatny helper nie oznacza ich zaliczenia.

Następny owner preparation używa markerowanych terminal caps oraz jawnych
długości i przewodności osobnych doprowadzeń. Generuje rzeczywiste lead Tet4,
nowe owner-issued IDs, dokładne pary interface vertices/faces i role wszystkich
ścian zewnętrznych. Bez nearest-neighbour weld, nazw zastępujących markery
lub caller-authored solved digest. Polityka izolowanych gałęzi nie obsługuje
milcząco wspólnego feed ani dowolnego naturalnego splitu prądu CPW.

Wejście current source pozostaje jawnie autorskie. Legacy terminal BC wymagają
określonej migracji, nie automatycznej reinterpretacji jako obserwacji portu.
Prepared source nie oznacza accepted result; materializer i natywny owner
nadal sprawdzają mesh-exact, signed H1/RT0, rank, current i field gates.
Przygotowanie nie zmienia sceny użytkownika bez transakcji authoring.

Odbiór: sparse i niesortowane rzeczywiste node tags, permutacje i remesh,
brak/duplikaty/foreign IDs, positive Tet4, conforming prism subdivision,
exact cap coverage, każdy komponent/terminal osobno, signed reversal/scaling,
taper i niezależna zbieżność siatki oraz kwadratury.

### D. Qualified basis → FFT/LLG

Osobny etap po C. Wymaga rzeczywistego modelu domknięcia lub niezależnie
ograniczonego wpływu pominiętego obwodu na wszystkie targets. Dopiero potem
podpisana normalizacja na amper, published asset, projections i drives.
Sinus nie wymaga nowego Poisson/Biot–Savart na każdym kroku: zgodna baza jest
mnożona przez waveform w chwilach ocen integratora. Zmiana waveform nie
unieważnia spatial solve; geometria/materiał/source/siatka — tak.

Odbiór: solve bez Relax/Run, V/J/H, source FFT z rzeczywistym k i jednostkami,
Run i jawna aktywacja w Relax, zegary i reuse, eksport/reload oraz odmowa stale
wyniku. Osobne dowody dla FEM CPU, FEM GPU, FDM CPU i FDM GPU; brak silent fallback.

## Stan weryfikacji przy otwarciu tego checkpointu

Przyrost 08.10: API production source-check
`8a26e8a183144a93a4b9b33def841cbd` PASS; actual OpenAPI codegen
`b023efbaa07c4425b259525c1ddf2f1b` PASS i client generation
`34415ab16dee46cba77d60afea555264` PASS. Wygenerowano nowy zasób display
z binarnymi device XYZ/Tet4. Pierwsze żądanie native workspace build zostało
zatrzymane przed kompilacją przez `assert_frozen_dependencies`. Następny
odczyt hosta potwierdził brak wszystkich czterech procesów zapisanych w owner
record oraz brak listenerów 3197/8081. Zarządzane
`just windows-runtime-recover 3197` zakończyło się `recovered`, zachowując
oryginalny record jako
`native-runtime-prior-93fd080c9d2d41bdbd8e03add4400391.json`
(SHA-256 `cdd0a16ccdc4472e4b85658745eca77df0aace9fad12cdefe4830d5723352011`).
Agent nie zatrzymywał procesów ani nie usuwał modelu. To odzyskanie martwego
właściciela, nie dowód nowego buildu, działającego endpointu lub odtworzenia sesji.

Historyczny review regularnej publikacji z bazy `202bbed4fff8c72099ef17489134bb1df911c090`
wykazywał utratę per-target diagnostyki v3 w małym legacy ABI JSON.
**Nie jest to opis bieżących źródeł:** aktualny checkout zawiera append-only
`fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1`, retained
snapshot i moduł `antenna_field_solution/direct_quadrature.rs`, a Python
`read_solution_checked` sprawdza v3. Weryfikacja bieżących konsumentów trwa;
obecność tych zmian nie zastępuje runtime i naukowych bramek T06/T09/T12.
Nie duplikujemy już istniejących ownerów na podstawie starego raportu.

**Potwierdzony bieżący blocker T06:**
`native_fem/charge_transport.rs::execute_native_fem_charge_transport` nadal
wykonuje osobny charge solve oraz RT0/Oersted solve. Regularny publisher
otrzymuje V, nodalne J i prąd normalizacji z pierwszego wyniku, a H oraz
retained quadrature evidence z drugiego. Kontrola v3 wiąże raw H z jego skalą,
lecz nie dowodzi wspólnego ownera V/J/H ani pochodzenia przekazanego prądu.
Nie wolno domknąć tej luki przez porównanie dwóch solve'ów, zachowanie legacy J
lub zmianę digestu źródła. Current-driven inspection korzysta z istniejącego
single accepted external-lead bundle. Dalsza publikacja J wymaga nazwanego
samplingu/projekcji owned RT0; qualified basis wymaga odrębnych bramek closure,
normalizacji, carrieru i provenance. Pełne mapowanie implementacji v3:
`fullmag_fem.h::fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1`,
`steady_transport/direct_oersted_snapshot.rs::SnapshotBuffer::finish`,
`antenna_field_solution/direct_quadrature.rs::DirectQuadratureEvidence`,
`tests/antenna/verify_field_convergence.py::read_solution_checked`.

- Wspólny szablon inspektora: managed TypeScript i lint PASS, browser fixture
  `d2a0bfbff23f4860ad0b97f04484afd4` PASS. Ten wynik dotyczy jeszcze bounded
  preview oraz prawidłowo zablokowanych niedziałających kontrolek.
- Ostatnia odczytana sesja testowa: `session-18dc9068d6ca81a80000a9c4`, scene rev 1,
  zachowany microstrip i falowód. Field metadata/catalog/payload GET zwracają
  404 — w tej sesji nie opublikowano jeszcze rozwiązania. Stale scope zwraca 409.
- Koordynator buildów: odczyt poza sandboxem potwierdził `accepting_jobs=true`,
  `worker_alive=true`, brak aktywnego joba i błędu. Nie jest to nowy build.
- Zakaz kompilowania testów jednostkowych pozostaje w mocy. Build produkcyjny,
  wykonywane regresje interpretowane, browser i fizyka są oddzielnymi bramkami.

### Wykonane bramki przyrostu retained display i przygotowania leadów

08.10.2026 wykonano kolejne zarządzane kontrole bez kompilacji unit tests:

| Bramka | Receipt / wynik | Granica dowodu |
|---|---|---|
| TypeScript production sources | `46e0225c953b4287a0fcd6d894ab7cd3`, PASS | Przed późniejszą poprawką zależności memoizowanego koloru wireframe; nie dowód HTTP |
| ESLint | `1379a488f5ea4a93aecad631da174c50`, PASS | Po poprawce memoizacji; bez wyłączania reguły React Compiler |
| API hygiene | `07047a00c08f497ba934e63a17f255d1`, PASS | Kanoniczna fasada/resource hooks; nie wykonanie endpointu |
| Browser / WebGL | `cda2a5f86e754004967d0dff61988693`, PASS, 13 grup kontroli | Produkcyjny Inspector, hooks i renderer przy kontrolowanym transporcie; nie solver |
| Przygotowanie leadów | `verify_antenna_external_lead_preparation.py --with-gmsh`, 11/11 PASS | Rzeczywiste Gmsh microstrip/taper oraz strict source MeshIR; bez native solve |

Lint i browser mają identyczny source digest przed/po:
`fdf9dd222a30f3c1e13fe986720124ee60900011158b71693d72d37472a24855`.
Browser zachował widoczny canvas, nieutracony WebGL oraz niezerowy drawing
buffer. Renderował wszystkie 10 próbek, raw H [A/m] i raw V [V] na rzeczywistej
zachowanej topologii fixture: 12 trójkątów powierzchni i 18 krawędzi.
Sprawdzono Shaded/Wireframe/Points, wyłączenie glyphs dla skalara, jawny port,
usunięcie overlay przy zmianie ownera, brak żądań idle oraz odmowy błędnych
digestów/ETagów/rozmiarów/non-finite/topologii. Zrzuty 09/10 obejrzano.
Test nie obejmuje pełnego workspace HUD ani odpowiedzi prawdziwego solvera.
Receipts i zrzuty znajdują się w resolverowym
`storage/builds/<worktree-id>/windows-control-room-{source-check,browser-fixture}/`.

Przyrost zapisano jako `8f603397eb4bb44ee900c13910e7c76bc703d5ad`.
Changed-page scientific validator dla bazy `f693a2f7f58be6516ce074c76abce2d18787c6e2`
i tego HEAD przeszedł. Zarządzany `just windows-backend-dev 3197` zakończył się
08.10.2026 o 21:31:59 UTC: `completed`, exit 0. Zbudowano CLI/API/desktop,
bez kompilacji unit tests. Manifest SHA-256:
`4dacac2a718cc5a5f1ab5b2c968ba3c2dee23f132b10d8e7dc6835371c25094e`;
native source snapshot:
`50edf403750c0e95d1eac05d9c9bad5ccaefee20ea448598e2db45f62be64a11`.
To natywny workspace Windows, **nie** wykonanie solvera FEM ani kwalifikacja
four-lane. Log: `windows-native-fdm-cpu-dev/logs/native-build-e690072b2ebf46b999e4bb011aca3a7c.log`.

Ten pakiet przeszedł także zarządzaną bramkę
`verify-windows-frozen-development-backend-api`: **296 kontroli**, `completed`,
exit 0, receipt `e703ddc7212e463fb74cad230acb88c5`. Sprawdzono rzeczywiste
procesy CLI/API, admission guards, przekazanie właściciela, kontrolowany restart
i zachowanie modelu w fixture. Nie jest to browser test ani wykonanie anteny.
Receipt znajduje się w
`storage/builds/<worktree-id>/development-backend-api-checks/checks/<receipt>/receipt.json`.

Następnie `just windows-ui dev 3197 false dev` uruchomił istniejący, zgodny
pakiet bez ponownego buildu. Read-only
`smoke_antenna_inspection_display.py --origin http://127.0.0.1:8081 --route-only`
przeszedł na żywym API tego HEAD: OpenAPI zawiera zasób i obowiązkowy digest,
brak/błędny query jest odrzucany, router rozpoznaje nowe binarne XYZ/Tet4,
a nieistniejący stage nie otrzymuje fikcyjnych danych. To dowód rzeczywistej
obsługi tras i query guards, **nie** pozytywnego transportu opublikowanego
wyniku. Pełny tryb `--stage-id` nadal wymaga świeżego, faktycznie obliczonego
i zarejestrowanego bundle; nie podstawiamy historycznego fixture.

### Potwierdzone granice następnego przyrostu authoring-to-solve

Odczyt przed przyrostem z 09.10 ujawnił dwie luki, których nie naprawia samo wywołanie
prywatnego preparera:

1. `model/problem.py::Problem.to_ir` emituje root `physics_objects`, lecz
   aktywne `fullmag-ir/src/lib.rs::ProblemIR` i `ProblemIRWire` 0.3 go nie
   deklarują. Przy typed deserialization pole jest ignorowane. Przetrwały
   nośnik tożsamości to istniejące `physics_graph.objects` emitowane przez
   `model/physics_scope.py::build_physics_graph`. Zarówno
   `fullmag-ir/src/antenna.rs::validate_antenna_composition_v03`, jak i
   `fullmag-plan/src/antenna_field_solve.rs::geometry_name_for_object` wówczas
   opierały się na magnetach/nazwach zamiast tej mapie. Naprawa musi objąć
   wspólną walidację i resolver immutable `object_id → geometry_id`, zgodny
   z Rust authoring normalizerem; nie tylko lookup ani nowy równoległy registry.
   Jawnie błędny binding nie może uruchomić name fallback. V04 ma osobne
   `objects` i opt-in migration; nie przełączamy wersji IR po cichu.
2. `runtime/scene_document_ir.py::scene_document_to_problem_ir` oraz
   `scene_document_to_execution_config` celowo używają
   `include_geometry_assets=False`. Rustowy materializer etapu od razu
   przekazuje taki IR plannerowi. Potrzebny jest jawny execution-only krok
   materializacji kanonicznego Python producera z retained antenna MeshData
   albo typed preparation intent zachowany do tego kroku. Lightweight
   preview/GET nie powinien uruchamiać meshingu ani emitować fake source.

Następny odbiór obejmuje antenę, której nazwa różni się od ID, rename bez
zmiany ownera, odmowy duplikatów/brakujących geometrii/konfliktów, niezależną
siatkę anteny obok domeny magnetycznej oraz rzeczywisty scheduled standalone
stage. Publiczne typed preparation, jego scene/script round-trip i podłączenie
do run admission nadal **nie są zaimplementowane**. Nie wystarczy zmienić
domyślnych terminali UI z legacy na nowe etykiety.

Cały moduł i T00–T18 pozostają **nieukończone**. Źródła B/C przeszły powyższe
bramki; live HTTP route guards przeszły, lecz pozytywny transport rzeczywistego
wyniku, authoring-to-solve i kwalifikacja pozostają otwarte.
D nie wolno oznaczyć jako gotowe na podstawie danych inspekcyjnych.

### Przyrost 09.10 — immutable owner w Rust 0.3 i przebudowany workspace

Zaimplementowano wspólny walidator i resolver
`fullmag-ir/src/object_binding.rs::physics_object_geometry_bindings_v03`
oraz `geometry_name_for_physics_object_v03`. Walidator kompozycji i dedykowany
planner anteny korzystają teraz z istniejącego `physics_graph.objects`;
etykieta anteny nie zastępuje jej ID. Błędna lub jawnie pusta tabela nie
uruchamia fallbacku nazw. Nie dodano drugiego registry ani cichej migracji IR.
Rozszerzenie enumu prezentacji o `Electrode` zachowuje istniejący Python
vocabulary, nie aktywuje solvera. Legacy kolejność rozwiązywania geometrii
została zachowana po uwadze review; jej runtime w dedykowanym plannerze
pozostaje osobną niewykonaną bramką.

Interpretowany driver `verify_antenna_object_binding.py` wykonał prawdziwe
`Problem.to_ir` i produkcyjne `validate-json`: **24/24 PASS**, exit 0.
Obejmuje dwie anteny o ID innych niż nazwy, magnetyk, elektrodę, rename,
deklaracje port/solve oraz odmowy konfliktów i wadliwych danych. Wcześniejszy
pakiet: 18 niespełnionych oczekiwań / 24; duplikat wpisu geometrii odrzucał
już istniejący decoder. Fixture nie wykonuje nierozwiązanej referencji RT0.
Pełny log JSON:
`D:/git/fullmag/storage/runs/antenna-frontend/2026-10-09-object-binding-final.json`.

Po jawnej zgodzie użytkownika zamknięto wyłącznie własne okno testowego
workspace; launcher i watcher zakończyły się kontrolowanie z exit 0.
Nie kasowano cache, wyników ani worktree. Finalny
`just windows-backend-dev 3197`: `completed`, exit 0, 22:31:04 UTC 08.10
(09.10 lokalnie), log `native-build-aa8faf53bbc3486988401b8f20d35e93.log`.
Snapshot `666da4e1d6a58635da8254c062d6edb34fc2d8bdaf9fba209bc854dc1108968d`,
manifest SHA-256 `601d67a0885a1fe7ad076bbfc7dd5f21322f45efd370b43307fec1927df6a664`,
CLI SHA-256 `9cf578bbe450675914c231ab5cc4f986776315479bfa1513349be84c17d02071`.
Produkcyjny CLI/API/desktop zbudowano bez kompilowania unit tests.
Pośredni build `91a62d67facc45d4b23eb1745a65b3fd` był sprzed poprawki
legacy priorytetu — nie jest finalnym dowodem tego przyrostu.

`just windows-ui dev 3197 false dev` uruchomił finalny zgodny pakiet;
sealed runtime copy ma powyższy digest CLI. `GET /workspace` na 3197 zwraca
200, a read-only `--route-only` przeszło na API 8081 z tym snapshotem.
Nie odtworzono automatycznie zapisanej sceny ani historii Undo. Próba
wizualnej kontroli karty nie wykonała się: narzędzie przeglądarki zgłosiło
`windows sandbox failed: helper_unknown_error: setup refresh had errors`.
HTTP 200 nie jest nowym dowodem WebGL; wcześniejszy fixture UI pozostaje
ważny tylko dla niezmienionych źródeł renderera.

Otwarte po tym przyroście: Rust authoring normalizer oraz publikacja owner
inventory przez API, execution-only materializacja siatki i typed lead intent,
publiczny/scene/script round-trip przygotowania, scheduled standalone solve,
pozytywne endpointy prawdziwego V/RT0/H i próbkowanego J, qualified basis,
FFT/LLG i T00–T18. Punkt 1 powyżej jest naprawiony w warstwie walidacji/lookup,
nie w całym authoring-to-run przepływie; punkt 2 pozostaje otwarty.
