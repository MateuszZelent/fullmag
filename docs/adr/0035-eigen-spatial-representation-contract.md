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

## Nierozstrzygnięte szczegóły przed kodem publicznym

1. Format importu/obiektów przekroju musi współdzielić istniejące semantyki mesh asset i object_id; brak automatycznej redukcji 3D w pierwszym providerze.
2. Konkretny format ramy oraz numeryczne tolerancje jednostkowości/ortogonalności/collinearity wymagają jednej implementacji i regresji; nie ustalać trzech prywatnych epsilonów w Python/Rust/UI.
3. Polityka brzegu przekroju jest jawna: pierwszy wariant finite air cross-section wymaga osobnej zbieżności. Nie obiecywać dokładnego open exterior przez stały Robin beta ani używać providera Fredkin–Koehler 3D jako 2D.

Szczegóły te nie zmieniają zatwierdzonej fizyki dwóch reprezentacji, ale muszą być domknięte przed wystawieniem działającego API. Dokument stanowi konkretny przedmiot review S01/S02, nie zamknięcie S09 ani dowód wyników.

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

## Rozstrzygnięcia review przed typed descriptor S09

Rama `origin_m/e_u/e_v/axis_unit` jest ramą GEOMETRII przekroju. Nie jest nodalną bazą tangentową magnetyzacji `T_i` z kanonicznych not0830/0831. Ta druga jest niezależnie wyprowadzana lub walidowana względem zaakceptowanego `m0_i`; musi spełniać ortonormalność kolumn i ich prostopadłość do `m0_i`, z osobnym binding equilibrium/mesh. Użycie `e_u/e_v` jako domyślnego `T_i` jest niedozwolone: poprawna baza tangentowa może zawierać składową wzdłuż osi falowodu.

Wszystkie trzy geometryczne osie są wymagane. Wejściowe długości muszą mieścić się w1e-12 od1; dopiero wtedy każdą oś dzieli się przez jej dodatnią długość. Nie akceptować dowolnie przeskalowanej osi, nie wyprowadzać pominiętej osi i nie dokonywać Gram–Schmidta. Requested global KPoint/KPath jest jedynym authoringiem k; signed scalar jest resolved wynikiem, nie drugim niezależnym wejściem.

Provider ma jedną resolved konwencję fazy, istniejący `PhaseConventionIR::ExpMinusIKDotDeltaR`. Nie dodawać drugiego edytowalnego źródła konwencji w reprezentacji. Rekonstrukcja osiowego pola `+ik*phi` wynika z tego samego kontraktu. Nowy request, sample, operator i artifact muszą wiązać tę konwencję; sprzeczne lub nieobsługiwane żądanie jest błędem przed solverem.

Nullspace przy Γ należy kontrolować dla CAŁEGO konformnego scalar mesh (magnetic+air), nie osobno dla każdej wyspy powietrza. Zamknięte powietrze wewnątrz magnetyku pozostaje połączone z domeną skalarną przez ciągły interfejs P1. Nie nakładać na takim interfejsie dodatkowego Dirichleta i nie odrzucać wyspy tylko dlatego, że nie dotyka zewnętrznego air boundary. Dla pierwszego finite-air Dirichlet providera każda geometryczna składowa całej domeny skalarnej musi mieć poprawnie oznaczony zewnętrzny brzeg powietrza z Dirichletem; nie podmieniać tej kontroli na test składowych regionu air. Point-contact, niekonformność i nie-manifold wymagają osobnego odrzucenia, a poprawne współdzielone interface mają dwie przeciwne incydencje.

Przed implementacją typed mesha pozostają wymagane: kompletny wire triangle/edge/half-edge incidence i zamkniętych konturów względem właściciela; jawne mapowanie region/object/material i pokrycie wszystkich elementów; zamknięta strukturalna reprezentacja wszystkich pól i interakcji; osobny wersjonowany fingerprint całego descriptoru2D oraz ramy; geometryczne finite/representability guards. Obecny fingerprint3D i DomainFrameIR nie są zamiennikami.


## Podstawa ramy w źródłach

Przyrost `crates/fullmag-ir/src/waveguide_frame.rs` implementuje wyłącznie raw/validated geometry frame i signed-k helper. [Kontrakt helpera](../guides/eigensolve-waveguide-frame-source-contract.md) opisuje jednostki, rzeczywiste metryki i source-only dowody. Publiczny writer0.3, typed StudyIRV04, migration/admission, pełny descriptor i provider nie są przez to włączane. Regresje Rust pozostają niekompilowane; geometria źródłowa nie jest certyfikatem physics/runtime.
