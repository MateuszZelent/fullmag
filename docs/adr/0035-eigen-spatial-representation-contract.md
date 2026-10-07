# ADR-0035: kontrakt reprezentacji przestrzennej eigensolve

- Status: proponowany kontrakt implementacyjny; wymaga review przed podłączeniem publicznego authoringu.
- Data: 2026-10-03.
- Zakres: S01/S02/S09 planu nonzero-k; nie jest deklaracją dostępności runtime.
- Fizyka: [0828](../physics/0828-fem-frequency-domain-floquet-demag.md), [0831](../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md), [0832](../physics/0832-fem-waveguide-nodal-ms-quadrature.md).
- Decyzja nadrzędna: [ADR-0031](0031-fem-nonzero-k-dispersion-representations.md).

## Problem i stan źródeł

Obecny authoring Eigenmodes i FemEigenPlanIR nie rozróżniają reprezentacji pełnego pola 3D od obwiedni falowodu. FloquetAirboxCpuSchurSlepc oznacza pełną domenę 3D. Bounded FloquetWaveguideCrossSectionProblem jest referencją elementową 2D P1 i nie ma produkcyjnego właściciela MFEM. Zmiana znaczenia istniejącego tokenu byłaby błędną migracją: warunki C(k) i pochodna D(k) nie są wymienne.

## Proponowana decyzja

Wprowadzić jawny, tagged kontrakt `spatial_representation` z wariantami `full_3d` oraz `waveguide_2p5d`. Nazwa `full_3d` obejmuje również izolowane k=0: słowo periodic nie może być domyślną deklaracją periodyczności. Legalność k i warunków brzegowych pozostaje osobną kontrolą. Brak pola w danych historycznych zachowuje istniejącą ścieżkę pełną 3D; nie uruchamia falowodu ani dodatkowej fizyki.

Waveguide wymaga osi, przekroju i jednowymiarowego sampling. Pierwszy dedykowany provider korzysta z jawnie wskazanej trójkątnej siatki przekroju 2D (P1), a nie z automatycznego obcięcia dowolnej domeny 3D. Źródłowy mesh i mapping obiektów magnetycznych/powietrza są częścią geometrycznego authoringu. Nie wolno podstawiać unity-thickness tetrahedron ani tworzyć longitudinal seam pairs.

Axis zachowuje kierunek użytkownika. Canonical IR wymaga skończonego niezerowego wektora jednostkowego; tolerancja i ewentualna normalizacja muszą być wspólne dla Python i Rust. Nie wybierać automatycznie dodatniego dominującego składnika, bo zmieniłoby to znaczenie signed k. Rama przekroju jest jawna, prawoskrętna i ortonormalna, a origin ma jednostki m. Nie wolno utożsamiać lokalnych współrzędnych przekroju z globalnym XY dla dowolnej osi.

Reużyć istniejący KPoint/KPath: dla waveguide każdy globalny wektor musi być równoległy do osi. Podpisany skalar k jest projekcją na tę oś w rad/m; składowa poprzeczna jest błędem, a nie wartością odrzucaną przez adapter. Znaki ±k nie mogą być usuwane przez normę wektora. Powtórzone punkty lub zamknięcie ścieżki nie zastępują kontroli collinearity i nie tworzą strefy Brillouina dla nieperiodycznego falowodu; nie wprowadzać arbitralnego zakazu powtórzeń.

Certyfikat niezmienniczości i owner/native mesh są resolved plan/provenance, nie dowolnymi booleanami authoringu. Certyfikat producenta wiąże geometrię, materiał, równowagę, ramę przekroju i ich identyfikatory/hash. Niezmienniczość dotyczy także pól i orientacji interakcji; sama geometria ekstrudowana nie jest dowodem. Zmiana któregokolwiek wejścia unieważnia certyfikat.

## Granica wdrożenia

Kontrakt nie aktywuje publicznego parametru przed implementacją spójnego round-trip i jawnego guardu dostępności. W stanie obecnym waveguide pozostaje unavailable, a full_3d zachowuje dotychczasową semantykę. Brak ownera 2D nie powoduje fallbacku do Blocha 3D, bounded oracle ani GPU. Requested intent musi przetrwać komunikat odrzucenia i provenance.

Nowy owner MFEM 2D musi wykonać modified Helmholtz, źródło i feedback zgodnie z 0828/0832 oraz exchange k². Rozdzielić operator magnetyczny, scalar potential i solver modalny. ABI rozszerzyć append-only z negocjacją struct_size/version wszystkich producentów i odbiorników; numer ustalić przy implementacji względem aktualnego ABI, nie rezerwować go w tym dokumencie.

Normy przekroju są liczone na jednostkę długości. Nie zmieniać po cichu istniejącego `unit_l2` w normę 3D. Artefakt musi określać podstawę miary (dA dla przekroju), jednostki pól, ramę i reprezentację. Długość porównawczej ekstrudowanej komórki 3D jest metadanymi adaptera porównania, nie ukrytym mnożnikiem macierzy 2D.

## Mapa implementacji i dowodów

| Warstwa | Wymagany przyrost | Dowód przed promocją |
|---|---|---|
| Python/scene export | typed authoring reprezentacji/ramy/przekroju, wspólna walidacja k | canonical round-trip, historyczne skrypty |
| ProblemIR/FemEigenPlanIR | physical intent oddzielony od resolved certyfikatu/mesha | serializacja, migration, odrzucanie invalid axis/transverse k |
| Planner/capabilities | osobny engine i unavailable do czasu provider 2D | brak fallbacku/oracle w production, zachowany requested intent |
| Runner/native ABI | jawny typ przekroju, rama, mapping, certificate i owner | pinned producer/consumer, append-only size/version, brak podłużnego C(k) |
| MFEM CPU | rzeczywisty mesh 2D i operator z wymianą/demag | managed assembly i pełny descriptor residual po rekonstrukcji phi |
| Artefakty/API | representation, scalar signed k, frame, per-length norm i source identities | independently replayed matrices/fields, eksport OpenAPI |
| Control Room | wspólny workspace i jawnie pokazana reprezentacja/dostępność | script round-trip, rzeczywisty browser/WebGL, poprawne jednostki |
| Nauka | przekrój, exterior/k→0, TetraX oraz extruded 3D | serie zbieżności; bez zastępowania tych bramek testem oracle |

## Uszczegółowione decyzje przed kodem publicznym

[Specyfikacja v1](../specs/fem-waveguide-spatial-representation-v1.md) definiuje nowy triangle/edge descriptor 2D ze stabilnym object_id, stabilnymi region_id/boundary_component_id, kompletną incidence krawędzi i ramą; nie reinterpretować 3D FemConnectivityIR. Wspólna dimensionless geometry tolerance wynosi 1e-12 i jest publikowana w resolved provenance. Jawne skalowanie długości osi nie zmienia kierunku ani nie wprowadza Gram–Schmidta. Pierwszy provider używa finite-air cross-section z Dirichlet phi=0 na outer boundary i osobną zbieżnością; nie jest dokładnym infinite exterior.

Normy, jednostki normalized shape/amplitude/energii i mapowanie dotychczasowych unit_l2/unit_max_amplitude opisuje proponowana [nota 0833](../physics/0833-fem-waveguide-25d-normalization.md); jej wdrożenie wymaga typed kontraktu i osobnych bramek. Kontrakt pozostaje proposed: publiczna implementacja, certyfikaty i provider nie istnieją. Zatwierdzenie tekstu nie będzie dowodem runtime ani ukończeniem S09.

## Migracja, rollback i wskazane źródła

Jeden publiczny DSL i jeden ProblemIR pozostają kanoniczne; UI eksportuje ten sam edytowalny skrypt, a nie osobny model 2D. Nie dodawać odrębnego endpointu/tree viewportu dla FEM waveguide. Zmiana authoringu i wersji kontraktu musi obejmować importer FMS/scene oraz wygenerowane OpenAPI/types. Requested spatial intent i resolved owner muszą być oddzielne; historycznych artefaktów nie przepisywać na nową reprezentację.

Brak nowego pola w starym wejściu oznacza legacy pełne 3D, ale nie jest nowym certyfikatem periodyczności ani invariance. Zasoby etapów nadal wymagają session_id/session_epoch/run_id; nowa reprezentacja nie znosi istniejącego scope guardu UI. Wariant waveguide musi zostać odrzucony przed budową niewłaściwej siatki i przed wyborem silnika pełnej domeny. Rollback wyłącza admission nowej realizacji, zachowując jej requested intent, mesh assets, certyfikaty i wyniki; nie konwertuje jej w działające full_3d.

Dokładne punkty wdrożenia do review:

- `packages/fullmag-py/src/fullmag/model/study.py`: Eigenmodes i canonical serialization; także scene/script export w runtime.
- `crates/fullmag-ir/src/study.rs` oraz `plan.rs`: physical intent i oddzielny resolved descriptor/certificate.
- `crates/fullmag-plan/src/fem.rs`: jawna legalność, engine owner i unavailable gate.
- `crates/fullmag-runner/src/fem/eigen_execution_resolution.rs` oraz `native_fem/frequency_domain.rs`: osobny resolved target/provider i payload.
- `native/include/fullmag_fem.h` oraz `backends/fem/include/frequency_domain/modal_eigen_request.hpp`: append-only ABI i negocjacja typów/size/version.
- Nowy owner przekroju w `backends/fem/cpu/frequency_domain/`: rzeczywisty MFEM 2D; istniejące `floquet_waveguide_cross_section.*` i `floquet_waveguide_demag_k.*` pozostają ograniczonym oracle'em.
- `crates/fullmag-api/src/schemas/authoring.rs`, generowany `apps/control-room/src/kernel/api/generated/openapi-v2.json` i jego types: faktyczny eksport z nowego managed API, bez ręcznych zmian generated.
- Wspólny Study Inspector, study resource hooks i viewport field adapters: representation-aware units/projection, bez osobnego transportu dla 2D.

Status rollback/ryzyka: obecnie tylko dokument proposed; nie zmienia IR/ABI, legalności, runtime ani artefaktów. Publiczny kontrakt i owner nie są zaimplementowane. Źródłowe wprowadzenie selektora może nastąpić dopiero razem z walidacją i prawdziwym guardem unavailable; promocja do supported wymaga produkcyjnego providera i opisanych bramek. Bounded oracle nigdy nie zastępuje tej promocji.

## Uszczegółowienie po review

[Specyfikacja v1](../specs/fem-waveguide-spatial-representation-v1.md) wybiera pierwszy finite-air Dirichlet provider, oddziela spin_wave_bc i interfejsy, zamraża migrację trzech przypadków Γ oraz opisuje structural_2d certificate, nowy descriptor trójkątnego mesha i serializację axis/k/frame. Sam kontrakt pozostaje proposed; schema/provider/normalizacja nie zostały jeszcze zaimplementowane. Osobna [nota normalizacji 0833](../physics/0833-fem-waveguide-25d-normalization.md) i niezależne kontrole algebraiczne są przygotowane; nie dowodzą providera 2D.


## Wersjonowanie: istniejący V04, bez konkurencyjnego wire

Przegląd aktualnych źródeł wykazał, że `crates/fullmag-ir/src/physics_object.rs`
już zawiera osobny `ProblemIRV04`, `ProblemIRV04Wire` oraz atomowy migrator
`migrate_v0_3_problem_ir_to_v0_4`. Oba warianty V04 nadal używają starego `StudyIR`.
Nie wprowadzać konkurencyjnej wersji 0.4/0.5 dla falowodu. Proponowane
`waveguide_2p5d` należy do istniejącego przyszłego cutoveru V04; obecny writer
Python i publiczny `ProblemIR` pozostają 0.3 do pełnej migracji wszystkich konsumentów.

Nie wolno publikować reprezentacji w ignorowanym polu wire 0.3. Guard obecności
`/study/spatial_representation` jest przygotowany w źródłach publicznego readera
0.3/0.2, jawnego łańcucha historycznego oraz staging V04 i jego migratora; obejmuje
również null. Wskazuje wymagany typed StudyIRV04 przed możliwym zgubieniem intencji.
Odmowa migracji następuje przed zmianą danych. Brak pola zachowuje historyczne
pełne 3D. Source review i parser PASS; kompilacja/regresje/runtime pozostają OPEN.
Nie oznacza to wdrożonej odmowy w starszych działających instancjach API.

Jawny łańcuch historyczny `0.1→0.2→0.3` pozostaje zachowany. Oddzielne
`0.3→0.4` wykorzystuje istniejący migrator V04, wstawiając dla historycznego
braku tylko `full_3d` i provenance migracji. Nie tworzy periodyczności,
invariance ani certyfikatu waveguide. Publiczne wersje root `ir_version`,
`problem_meta.script_api_version` i `serializer_version` przełączają się razem
przy atomowym cutoverze; obecna bezpośrednia polityka odczytu 0.3/0.2 nie zmienia
się w tym dokumencie. Przyszły cutover wymaga osobnej jawnej macierzy readerów.

V04 wymaga typed study i typed wariantów reprezentacji z lokalnym
`deny_unknown_fields`. Nie stosować globalnego zakazu na cały `ProblemIRV04`,
ponieważ jego `legacy_extensions` są celowym kontraktem. Spatial representation
ani jej BC nie mogą być schowane w tych rozszerzeniach. Migracja historyczna
musi zbadać obecność BC przed deserializacją starego `StudyIR`, którego
`serde(default)` zamienia brak w open.

| Przypadek | Wymagana interpretacja |
|---|---|
| Legacy 0.3 bez reprezentacji i bez BC | full_3d, historyczny default open, odnotowany w provenance |
| Legacy BC jawne null | błąd typu; null nie jest brakiem |
| V04 full_3d | jawne BC pełnej domeny; nie otrzymuje certyfikatu waveguide |
| V04 waveguide_2p5d | wymagane nie-null tagged BC wewnątrz wariantu; legacy top-level BC całkowicie nieobecne, również jako null |

Wymagane źródłowe bramki: test odrzucenia reprezentacji w 0.3, zachowanie
historycznych testów migracji, V04 round-trip i missing/null matrix oraz
unavailable gate przed wyborem 3D/Bloch. Guard ma source review/parser PASS i sześć przygotowanych regresji Rust; ich wykonanie pozostaje OPEN zgodnie z zakazem kompilacji unit tests. Pozostałe nowe bramki są OPEN.
Ta sekcja jest proposed i nie zmienia publicznego writer/reader/ABI.

### Admission przyszłego V04 i zakres pierwszego cutoveru

Istniejący V04 jest staging wire, a nie wejściem obecnego produkcyjnego planera. Samo `serde_json::from_value::<ProblemIRV04>` nie uruchamia pełnego `validate()` i nie stanowi admission. Przyszły wspólny admission path ma przed planowaniem sprawdzić root `ir_version`, `problem_meta.script_api_version` oraz `serializer_version`, wykonać pełne `validate()`, a następnie przekazać typed study do właściwego planera. Ten path nie jest jeszcze zaimplementowany.

Pierwszy cutover reprezentacji falowodu obejmuje tylko Eigenmodes. FrequencyResponse i pozostałe study kinds mają jawnie odrzucać `waveguide_2p5d` jako unsupported do własnej implementacji i kwalifikacji; nie dziedziczą legalności Eigenmodes. Provenance historycznego brakującego BC ma zawierać `defaulted_from_missing`; jawne null pozostaje błędem. Te reguły są częścią proposed contract, bez zmiany obecnej ścieżki 0.3.

## Rozstrzygnięcia review przed typed descriptor S09

Rama `origin_m/e_u/e_v/axis_unit` jest ramą GEOMETRII przekroju. Nie jest nodalną bazą tangentową magnetyzacji `T_i` z kanonicznych not0830/0831. Ta druga jest niezależnie wyprowadzana lub walidowana względem zaakceptowanego `m0_i`; musi spełniać ortonormalność kolumn i ich prostopadłość do `m0_i`, z osobnym binding equilibrium/mesh. Użycie `e_u/e_v` jako domyślnego `T_i` jest niedozwolone: poprawna baza tangentowa może zawierać składową wzdłuż osi falowodu.

Wszystkie trzy geometryczne osie są wymagane. Wejściowe długości muszą mieścić się w1e-12 od1; dopiero wtedy każdą oś dzieli się przez jej dodatnią długość. Nie akceptować dowolnie przeskalowanej osi, nie wyprowadzać pominiętej osi i nie dokonywać Gram–Schmidta. Requested global KPoint/KPath jest jedynym authoringiem k; signed scalar jest resolved wynikiem, nie drugim niezależnym wejściem.

Provider ma jedną resolved konwencję fazy, istniejący `PhaseConventionIR::ExpMinusIKDotDeltaR`. Nie dodawać drugiego edytowalnego źródła konwencji w reprezentacji. Rekonstrukcja osiowego pola `+ik*phi` wynika z tego samego kontraktu. Nowy request, sample, operator i artifact muszą wiązać tę konwencję; sprzeczne lub nieobsługiwane żądanie jest błędem przed solverem.

Nullspace przy Γ należy kontrolować dla CAŁEGO konformnego scalar mesh (magnetic+air), nie osobno dla każdej wyspy powietrza. Zamknięte powietrze wewnątrz magnetyku pozostaje połączone z domeną skalarną przez ciągły interfejs P1. Nie nakładać na takim interfejsie dodatkowego Dirichleta i nie odrzucać wyspy tylko dlatego, że nie dotyka zewnętrznego air boundary. Dla pierwszego finite-air Dirichlet providera każda geometryczna składowa całej domeny skalarnej musi mieć poprawnie oznaczony zewnętrzny brzeg powietrza z Dirichletem; nie podmieniać tej kontroli na test składowych regionu air. Point-contact, niekonformność i nie-manifold wymagają osobnego odrzucenia, a poprawne współdzielone interface mają dwie przeciwne incydencje.

Przed implementacją typed mesha pozostają wymagane: kompletny wire triangle/edge/half-edge incidence i zamkniętych konturów względem właściciela; jawne mapowanie region/object/material i pokrycie wszystkich elementów; zamknięta strukturalna reprezentacja wszystkich pól i interakcji; osobny wersjonowany fingerprint całego descriptoru2D oraz ramy; geometryczne finite/representability guards. Obecny fingerprint3D i DomainFrameIR nie są zamiennikami.


## Podstawa ramy w źródłach

Przyrost `crates/fullmag-ir/src/waveguide_frame.rs` implementuje wyłącznie raw/validated geometry frame i signed-k helper. [Kontrakt helpera](../guides/eigensolve-waveguide-frame-source-contract.md) opisuje jednostki, rzeczywiste metryki i source-only dowody. Publiczny writer0.3, typed StudyIRV04, migration/admission, pełny descriptor i provider nie są przez to włączane. Regresje Rust pozostają niekompilowane; geometria źródłowa nie jest certyfikatem physics/runtime.


### Typed staging V04: jawne region targets i BC presence

Implementowany prerequisite StudyIRV04 używa istniejącego opt-in ProblemIRV04.
Przed zamrożeniem wariantu waveguide review wykazało konieczność required typed
region_targets: BTreeMap<String, RegionRefIR> obok frame/cross_section_mesh/BC.
Raw mesh region ID nie jest canonical ObjectRegionIR ID; object name/type nie
rozstrzyga whole-object vs regional target. Mapping zachowuje requested intent,
wchodzi do exact geometry identity i wymaga pełnych registry bindings.

Tagged finite-air BC ma boundary_component_ids. V04 full_3d spectral study ma
jawne nie-null legacy BC; waveguide wymaga jego całkowitego braku. Migracja
historycznego braku zapisuje Open/full_3d z rzeczywistą provenance, a null jest
atomową odmową. Local deny_unknown_fields nie usuwa root legacy_extensions.

Model validation nie jest provider admission. Osobny unavailable guard blokuje
wykonanie waveguide przed 3D/Bloch; nie ma lossy konwersji do full_3d. Publiczne
Python/IR0.3, OpenAPI, capability i działające instancje pozostają bez cutoveru.
MFEM owner, complete structural/equilibrium proof i qualification nadal OPEN.
