# Audyt powtórnej normalizacji dodatnich markerów regionów native FEM

Data: 2026-10-01
Zakres: P6, follow-up po przyroście 47
Status: audyt źródłowy i propozycja granicy kontraktu; bez implementacji
Bazowy snapshot audytu: `a8b9e5a30a7e83c3eb65349991e131f5e911e6d0`
Stan własnych zmian: przyrost 47 WIP; ten dokument nie rości sobie aktualnego SHA commita

## Wniosek

Nie wolno zmienić globalnie istniejącego `normalized_runtime_element_markers` na funkcję zachowującą wszystkie dodatnie ID. Wspólna ścieżka obejmuje także payloady publiczne, certyfikaty modalne i część frequency-domain, gdzie marker jest jawnie binarny i `marker == 1` ma znaczenie kontraktowe.

Można zachować dodatnie, autorskie ID regionów bez zmiany ABI przez rozdzielenie dwóch wewnętrznych widoków:

- **raw region IDs** — dla native FEM time-domain, MFEM, mapowania materiałów i regional drives;
- **binary magnetic mask** — dla artefaktów/supportu, payloadów publicznych, frequency-domain/shared-domain i certyfikatów modalnych.

Walidacja deklaracji regionów musi pozostać wspólna i fail-closed. Nie wolno usuwać drugiej walidacji ani oznaczać planu jako „już znormalizowanego”, ponieważ ukryłoby to niespójność targetów regionalnych.

## Potwierdzona ścieżka błędu

1. `crates/fullmag-runner/src/dispatch.rs:437–523`, symbol `normalized_runtime_element_markers`, zamienia dodatnie markery na projekcję binarną. Przykład `[42, 0]` staje się `[1, 0]`.
2. `dispatch.rs:529–534`, symbol `normalized_fem_plan_for_runtime`, wpisuje tę projekcję do kopii planu, pozostawiając deklarację `region_materials=[42]`.
3. `crates/fullmag-runner/src/native_fem.rs:780–861`, symbol `normalized_native_runtime_element_markers`, waliduje plan ponownie. Marker `1` nie jest zadeklarowany jako `42`, więc poprawny pierwotny region może zostać odrzucony przed utworzeniem backendu.
4. `native_fem.rs:2348–2368`, symbol `create_with_initial_effective_field`, wywołuje tę natywną normalizację przed dalszym przekazaniem planu.
5. Samo pominięcie walidacji nie rozwiązuje problemu targetów: `native_fem.rs:987–1058` zachowuje `ElementMarkerSet` z konkretnymi ID, a `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp:478–484` porównuje target z rzeczywistym `cell_markers[element]`.

Wniosek z tej ścieżki jest ograniczony: obecna normalizacja może odrzucić plan przed alokacją. Nie jest to samodzielny dowód błędnych wyników naukowych. Jest natomiast wystarczającym dowodem niespójności kontraktu markerów i wysokiego ryzyka błędnego wyboru regionalnego pola po prostym pominięciu walidacji.

## Dowody, że raw IDs są obsługiwane przez native FEM time-domain

- `native/include/fullmag_fem.h:436–437`, pole `fullmag_fem_mesh_desc.cell_markers`, ma typ `uint32_t`; zachowanie ID nie wymaga zmiany ABI.
- `backends/fem/core/fem_mesh.cpp:694–702`, symbol `initialize_magnetic_masks`, wyprowadza maskę przez `cell_markers[i] != 0u`.
- `backends/fem/cpu/mfem/runtime/mfem_mesh_builder.cpp:283–319`, symbol `volume_attributes`, zachowuje dodatnie markery jako atrybuty MFEM; zero dostaje osobny atrybut powietrza.
- `backends/fem/src/mesh_space_preparation.cpp:144–204`, mapowanie i fingerprint opierają się na rzeczywistych markerach.
- `backends/fem/gpu/cuda/demag_poisson/operators.cpp:442–497`, symbol `validate_mesh`/budowa atrybutów, porównuje raw marker z atrybutem MFEM; `operators.cpp:569–590` haszuje raw markery i pochodną maskę.
- `native_fem.rs:2389–2415`, budowa `Dg0EnergyProjection`, używa `marker != 0` do listy elementów magnetycznych.
- `native_fem.rs:447–474`, symbol `PackedNativeMesh::new`, kopiuje `mesh.element_markers` do istniejącego pola ABI.

Te miejsca wspierają model: dodatnie ID są tożsamością regionu, a maska magnetyczna jest pochodną. Nie stanowią kwalifikacji solvera ani dowodu parytetu CPU/GPU.

## Granice, których nie wolno naruszyć

### Frequency-domain i modal

`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp:775–787, 935–968, 2412–2430`:

- odrzuca marker większy niż `1`;
- uznaje tylko `marker == 1` za element magnetyczny;
- używa tej wartości przy budowie węzłów oraz domeny wspólnej.

Raw ID nie może trafić do tej granicy bez jawnej binarnej projekcji albo odrzucenia. Nie należy zmieniać tego kontraktu w ramach poprawki native time-domain.

Dodatkowe kontrakty binarne/sekwencyjne:

- `crates/fullmag-runner/src/types.rs:2397–2417`, symbol `normalized_payload_element_markers`, tworzy binarny payload publiczny;
- `crates/fullmag-runner/src/fem/eigen_certificate.rs:1049–1064`, wymaga markerów modalnych w kolejności `1..N`.
- `crates/fullmag-ir/src/mixed_certificate.rs:493,777`, wymaga zbioru `{0,1}`.
- druga kopia normalizacji istnieje w `crates/fullmag-runner/src/solvers/fem/plan.rs:79–170`; nie wolno pozostawić jej z inną semantyką niż aktywna ścieżka.

### Producent artefaktów

`crates/fullmag-runner/src/artifacts.rs:1687–1701`, symbol `fem_p1_magnetization_field_semantics`, korzysta z `normalized_runtime_element_markers` i przekazuje wynik do `preview::mesh_quantity_active_mask_with_element_markers`. Ten konsument potrzebuje maski supportu, nie raw tożsamości regionu. Powinien otrzymać jawny widok binarny, zachowując fingerprint zaakceptowanej topologii.

## Minimalny kandydat implementacyjny

Kolejny przyrost powinien wprowadzić wspólny walidator oraz jawny typ wewnętrzny, na przykład strukturę mapy markerów z polami:

- `raw_region_ids: Vec<u32>`;
- `magnetic_mask: Vec<bool>`;
- informacja o źródle/trybie projekcji, jeśli jest konieczna do ochrony granic.

Nazwy są propozycją zakresu, nie zatwierdzonym API.

Walidator powinien:

1. sprawdzić długość markerów względem liczby elementów;
2. sprawdzić, że każdy dodatni marker występuje w dozwolonej deklaracji regionów lub w jednoznacznym mapowaniu segmentów;
3. zachować dodatnie ID bez zamiany `42 -> 1` dla widoku native time-domain;
4. wyprowadzić maskę przez `marker != 0` dla istniejącego native core;
5. nadal odrzucać nieznane ID, marker zero w deklaracji regionu oraz niejednoznaczne wielomarkerowe plany;
6. przekazywać raw ID do `PackedNativeMesh`, MFEM i regional drives;
7. przekazywać widok binarny do artifacts/supportu, public payloadów i frequency/modal;
8. scentralizować obecne duplikaty w `dispatch.rs` i `solvers/fem/plan.rs`, albo zapewnić wspólny helper bez rozbieżnych zasad.

Nie proponuje się nowego publicznego pola ABI. Istniejące `cell_markers` ma wystarczający typ; zmiana dotyczy właściciela i semantyki widoku po stronie Rust/native, a nie układu C ABI.

## Wymagane regresje przed uznaniem przyrostu za gotowy

| Zakres | Oczekiwany dowód |
|---|---|
| Native time-domain | Plan `[42,0]` z `region_materials=[42]` przechodzi walidację i zachowuje raw `[42,0]`. |
| Maska | Native core wyprowadza `[true,false]` z `marker != 0`. |
| Regional drive | `ElementMarkerSet([42])` wybiera element oznaczony `42`; należy sprawdzić także `ElementRange` i fallback segmentów. |
| DG0 | `ms_element_field` i `a_element_field` zachowują długość oraz ordinal elementów. |
| Guard | Nieznane ID, marker zero w deklaracji i niejednoznaczne dodatnie ID kończą się błędem. |
| Frequency/modal | `[1,0]` pozostaje poprawne; raw `[42,0]` jest odrzucone lub jawnie zrzutowane przed shared-domain. |
| Public payload | `FemMeshPayload` nadal emituje binarne `[1,0]`, a jego identity pozostaje zgodne z dotychczasowym kontraktem. |
| Artefakty | Support producenta korzysta z binarnej maski, ale fingerprint topologii i provenance nie są budowane z destrukcyjnie zmienionego raw mesha. |

Powyższe regresje są **NOT RUN** i **NOT COMPILED** w tym audycie. Managed runtime, wykonanie geometrii, parytet urządzeń, peak RAM i kwalifikacja fizyczna pozostają **NOT VERIFIED**.

## Prerekwizyty dokumentacyjne przed implementacją

Przed wprowadzeniem raw-view/binary-view trzeba rozstrzygnąć i zmapować następujące dokumenty:

- `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md` — sekcja strict conformal runtime powinna jasno oddzielać autorskie dodatnie ID regionów od pochodnej maski oraz od per-element `M_s/A`.
- `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md` — reguła „marker 1” musi pozostać oznaczona jako bootstrap, a nie jako ogólna semantyka wszystkich regionów.
- `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md` — fixture z markerem 2 należy powiązać z kontraktem dodatnich magnetycznych regionów.
- `docs/specs/native-fem-backend-architecture-v1.md` — trzeba nazwać rozdział między `MeshAndRegions`, raw IDs i derived magnetic mask.
- `docs/specs/pinned-solution-tensor-v1.md` — producent może publikować binarną maskę supportu, ale dokument nie powinien sugerować, że raw marker siatki został bezpowrotnie zmieniony.

Aktualizacja tych dokumentów nie może być przedstawiona jako kwalifikacja numeryczna. Dla każdego twierdzenia naukowego należy zachować równania/jednostki, mapę źródeł i osobne statusy executable/source/runtime/validated.

## Status dowodów

- Source review: ustalenia i miejsca źródłowe zapisane; **source evidence NOT COMPLETED** dla nowej implementacji, ponieważ implementacja nie została wykonana.
- Build/compile/test: **NOT RUN**.
- Managed runtime: **NOT VERIFIED**.
- Scientific qualification: **NOT CLAIMED**.
- Zakres następnego backendowego przyrostu: raw view dla native FEM time-domain oraz binary view dla frequency/modal/artifacts; bez globalnej zmiany markerów i bez obejścia istniejących guardów.
