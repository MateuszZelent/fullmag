# P4 — producer natywnego FEM mesh/space

Status: **źródłowa implementacja producer'a oraz integracji kroków 1–4 jest dodana; kompilacja i dowody wykonania pozostają NOT VERIFIED**.

## Stan potwierdzony w kodzie

Rustowy `FemMeshPayload` przekazuje do native FEM kanoniczne węzły, komórki,
markery, fasety i pary okresowe. `build_mfem_mesh()` w
`backends/fem/cpu/mfem/runtime/mfem_mesh_builder.cpp` tłumaczy ten payload na
`mfem::Mesh` i waliduje topologię. Następnie
`context_initialize_mfem()` w `mfem_context.cpp` wybiera/skonfigurowuje
urządzenie, tworzy `H1_FECollection` i `FiniteElementSpace`, i sprawdza, że
`GetNDofs()` odpowiada liczbie węzłów. W tej samej funkcji powstają pola
magnetyzacji i materiałów oraz operator wymiany. Ten lifecycle nie jest więc
samodzielnym producer'em przygotowania i nie może być wywołany przez API
przygotowania jako skrót do natywnego dowodu.

`PreparationProducer::from_fem_mesh_certificate()` nadal opakowuje wyłącznie
`PeriodicMeshCertificateV6IR`; ten certyfikat sam nie dowodzi zbudowania
ogólnego `mfem::Mesh` ani `FiniteElementSpace`. Dodany, osobny producer
`fullmag_fem_prepare_mesh_space_v1` importuje descriptor bez `Context`, buduje
`mfem::Mesh` i H1 P1 `FiniteElementSpace`, sprawdza wymiary, markery, DOF oraz
próbki dodatnich Jacobianów. Oddzielny ABI v1 nie zmienia istniejącego layoutu
descriptora. Rust porównuje topologię i marker map z niezależnie zakodowanym
payloadem `MeshIR`, a plan/application wiążą dowód z pięcioma certyfikatami
preparation. Live API wybiera tę ścieżkę wyłącznie dla planu czasowego FEM i
feature `fem-native`; bez feature'a odrzuca żądanie jawnie. Ta implementacja
jest źródłem do kwalifikacji, nie dowodem kompilacji ani wykonania.

### Powiązanie provenance i granica dowodu jakości

Statyczny audyt 24.09.2026 potwierdza, że ABI v1 przyjmuje `MeshIR` i `fe_order`,
a zwracany `quality_fingerprint` opisuje próbki dodatnich Jacobianów order-two
z faktycznie utworzonego `mfem::Mesh`. Ten certyfikat wiąże się z fingerprintem
topologii. Nowa ścieżka Rust dodaje osobny, wersjonowany
`fem_mesh_source_evidence.v1`: zawiera fingerprint kanonicznego wejścia,
topologii MFEM, digest build reportu (albo jawny brak) i digest
`per_domain_quality` wraz z mapą markerów/liczb komórek. Digest source evidence
jest wejściem producenta `mesh`, a jego digest topologii musi być równy
wyjściu tego producenta. Native Jacobian fingerprint pozostaje osobnym polem.
Raport `degraded=true`, niespójne/niefinite podsumowanie, niezgodne markery
albo liczby komórek są odrzucane. Starsze receipts pozostają odczytywalne, ale
nowe FEM receipts wymagają tego powiązania.

To domyka wyłącznie lineage źródła. Brak build reportu lub pusty
`per_domain_quality` pozostaje jawnie stanem braku danych i nie jest
akceptacją jakości. Nadal potrzebne są topology-aware kryteria jakości dla
wszystkich obsługiwanych rodzin elementów, przejście normatywnych progów
z noty 0105 i dowody działania. `ProblemIR` fingerprint nie zastępuje tych
kontroli ani raportu przypiętego do tej samej topologii.

## Wymagany producer

Wyodrębnić w native FEM niezależny, bezstanowy producer z wejściem opartym na
kanonicznym mesh payloadzie i żądanym FE order. Producer buduje i waliduje
`mfem::Mesh`, tworzy wymaganą rodzinę/order `FiniteElementSpace` i zwraca
wersjonowane dowody rzeczywistych obiektów. Jego wywołanie nie może tworzyć
`Context`, wybierać ani konfigurować urządzenia, alokować CUDA streamów, tworzyć
pól solvera ani inicjalizować exchange, demag czy operatora.

Wynik musi wiązać co najmniej:

- fingerprint wejściowej kanonicznej topologii i marker mapy z faktycznie
  zaimportowanym mesh;
- wymiar mesh, liczbę węzłów i komórek oraz potwierdzenie zgodności z wejściem;
- Jacobian evidence oraz liczbę komórek rzeczywistego MFEM mesh, związane z
  canonical topology fingerprint;
- odrębny fingerprint zaakceptowanego meshera i jego `per_domain_quality`,
  jawnie związany z tą samą siatką; próbki MFEM nie zastępują build acceptance;
- rodzinę i order elementu, liczbę lokalnych/true DOF oraz fingerprint
  utworzonej przestrzeni;
- wersję schematu i producer'a, aby zmiana realizacji unieważniała reuse.

Nie wyprowadzać `space` z periodic certificate, rozmiaru siatki ani requested
FE order. Jeżeli native producer nie zwróci zgodnego dowodu, FEM preparation
ma zakończyć się błędem bez częściowego receipt'u. Pole `grid` planu FEM musi
otrzymać własną, jawnie zdefiniowaną semantykę/provenance; nie wolno wypełniać
go FDM certificate ani przedstawiać go jako siatki obliczeniowej FEM.

## Kolejność integracji i odbiór

1. Producer, kontrakt C++ i bezstanowy import są zaimplementowane w źródłach;
   wymagają kompilacji i wykonania kontraktu przez zatwierdzoną trasę.
2. Addytywne C ABI v1, walidacja wersji/rozmiaru i Rustowy wrapper są dodane;
   runtime ABI oraz kontrola błędnych odpowiedzi pozostają niezweryfikowane.
3. Plan/application tworzą komplet certyfikatów z fingerprintami i odrzucają
   niezgodne wejścia. Source-level testy planera oraz application przeszły z
   syntetycznym native evidence; nie weryfikują jeszcze rzeczywistego ABI.
4. Live API używa osobnej ścieżki FEM i zachowuje dotychczasowy fence oraz
   kontrolę przed publikacją. Trasa HTTP nie została jeszcze zweryfikowana.
5. Source-level caller Control Room jest podłączony: zakończony Build Mesh i
   zmiany authoringu unieważniają zasób Preparation; komendy FEM Compute
   wymagają aktualnej rewizji sceny i wspólnej siatki, materializują receipt
   przed wysłaniem solver command, a wspólna komenda Prepare korzysta z tego
   samego helpera. UI pokazuje identity-only provenance zaakceptowanego
   receipt'u (run, schema, plan i payload digest). Suite'y helpera i komend
   przechodzą **89/89**; obejmują zgodność rewizji siatki/sceny, kolejność
   materializacji przed Compute oraz anulowanie bez Compute i invalidacji
   lokalnego receipt'u po zmianie sesji w trakcie żądania. Jest to dowód
   source-level, nie browser/Live runtime.

Pozostała weryfikacja musi objąć native C++ contract i ABI z prawdziwą
odpowiedzią producenta, HTTP/OpenAPI oraz browser/runtime caller Control Room.
Source-level testy `fullmag-plan` i `fullmag-application` przechodzą, ale ich
wejście native jest syntetyczne. Dodana recepta
`just verify-fem-mesh-space-preparation-contract` uruchamia kontrakt C++ oraz
test Runnera przez FFI; jej wykonanie pozostaje niezweryfikowane. Dla
zmienionego native FEM używać zatwierdzonej trasy
kontenerowej/runnera z `justfile`; brak zdrowego runnera oznacza
`NOT VERIFIED`, bez kompilowania FEM na hoście. Managed runtime, browser/WebGL,
testy fizyczne i kwalifikacja wydania pozostają osobnymi bramkami.

## Kontrola końcowego meshu — 24.09.2026

Walidacja po `FinalizeTopology()` i `Finalize()` porównuje teraz rzeczywiste
współrzędne wierzchołków MFEM z kanonicznym wejściem oraz dopasowuje każdy
oczekiwany element brzegowy jeden-do-jednego po geometrii, markerze i
uporządkowanej łączności odziedziczonej od właściciela komórkowego. Weryfikacja
odrzuca również brakujące lub dodatkowe elementy przez istniejący warunek
zgodności liczności przed indeksowaniem. Kontrakt C++ rozszerzono o regresje
współrzędnych dla rodzin elementów oraz obecność jawnych faset zewnętrznych i
okresowych z oczekiwanym markerem.

To zamyka lukę w dowodzie źródłowym: poprzedni digest topologii opisywał
kanoniczny payload, a nie samą końcową strukturę granicy w MFEM. Test
`verify-fem-mixed-p1-native-contract` nie został uruchomiony, ponieważ managed
runner zgłosił `Docker Desktop coordinator request failed`; zmiana pozostaje
`NOT VERIFIED`, bez zwiększenia procentu P4. Nie wykonano hostowej kompilacji
FEM.

## Źródła audytu

- `crates/fullmag-runner/src/types.rs` — kanoniczny `FemMeshPayload` i jego
  stabilna tożsamość generacji.
- `crates/fullmag-runner/src/native_fem.rs` — pakowanie payloadu i wywołanie
  `fullmag_fem_backend_create_v3`.
- `backends/fem/cpu/mfem/runtime/mfem_mesh_builder.cpp` — import i walidacja
  kanonicznej topologii.
- `backends/fem/cpu/mfem/runtime/mfem_context.cpp` — obecny lifecycle
  MFEM mesh/FES połączony z inicjalizacją runtime.
- `crates/fullmag-plan/src/preparation.rs` oraz
  `crates/fullmag-api/src/live_scene_preparation.rs` — producer evidence,
  walidacja, materializacja FEM oraz fail-closed przy buildzie API bez
  `fem-native`.
- `justfile` — dedykowana
  `verify-fem-mesh-space-preparation-contract` buduje i uruchamia C++ contract
  oraz testuje wrapper FFI w zatwierdzonym kontenerze CPU; trasa musi być użyta
  zgodnie z polityką runnera/storage.

## Testy źródłowe materializacji — 24.09.2026

`cargo test --locked -p fullmag-plan --lib preparation::tests`: **15/15 PASS**.
Testy potwierdzają pięć certyfikatów z H1 P1 evidence, wiązanie receipt'u ze
źródłowym fingerprintem meshu oraz odrzucenie innego meshu i nieobsługiwanego
H1 P2.

`cargo test --locked -p fullmag-application --lib preparation::tests`:
**7/7 PASS**. Testy przechodzą od FEM `ProblemIR` przez planner do walidowanego
application receipt'u, sprawdzają digest source evidence i odrzucają rebinding.
Fixture przekazuje syntetyczne native evidence. Regresja jawnie potwierdza, że
brak build reportu i pusta mapa per-domain quality nie stają się metryką
`min_quality`/`max_aspect_ratio`; osobne Jacobian evidence pozostaje widoczne.
Wynik potwierdza kontrakt Rust, a nie wykonanie MFEM ani poprawność ABI.
`rustfmt --check` dla obu zmienionych modułów **PASS**.

Dodano też test `fullmag-runner`, który wywołuje rzeczywisty ABI dla Tet4 H1 P1,
sprawdza kardynalności/DOF/fingerprinty oraz odrzucenie P2. Dedykowana recepta
`just verify-fem-mesh-space-preparation-contract` buduje target
`fem_mesh_space_preparation_contract`, uruchamia go przez CTest i następnie
test Runnera. `just --dry-run verify-fem-mesh-space-preparation-contract`
**PASS**. Próba wykonania zatrzymała się przed Compose na storage preflight:
`.fullmag` jest istniejącym katalogiem z `local`, `local-live` i `reports`, a
resolver wymaga zinwentaryzowanej migracji zamiast automatycznego zastąpienia
ścieżki. `just storage-info` i `just storage-inventory` działały tylko
odczytowo; niczego nie przeniesiono ani nie usunięto. `just runner-container-status`
również zgłasza `Docker Desktop coordinator request failed`.

Native C++/ABI contract, managed Live/API, browser/WebGL, runtime i walidacja
fizyczna pozostają **NOT VERIFIED**. P4 (**50%**) i całość (~**27%**) bez zmian.
