# Audyt przepływu materiałów: Python, Inspector, IR, planner i odczyt danych

Data: 2026-10-29. Baza: `/home/kkingstoun/git/fullmag/fullmag`, `e6a58cc7b12bc92b96c271cacb4cd1e19118659e`, współdzielony dirty checkout. Jest to wewnętrzny audyt implementacji, nie nowa kanoniczna dokumentacja fizyki ani kwalifikacja runtime. Numery linii odnoszą się do odczytanych źródeł; stabilnym odwołaniem jest również wskazany symbol.

## A1 — P1: edytor regionu zmienia poprawne zera materiałowe na wartości domyślne

**Status: potwierdzone w źródłach; arytmetyka odtworzona izolowanie. Browser/runtime: NOT VERIFIED.**

W `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts`, `resolveMaterialOverrideDrafts` (498–513), odczyt kończy się `value: value || defaultMaterialOverrideValue(...)`. Prawidłowe zero jest traktowane jako brak wartości. `defaultMaterialOverrideValue` (530–536) daje `alpha=0.1` oraz `Aex=1e-11 J/m`.

Wyzwalacz: region zapisany z `alpha=0` albo `Aex=0`; otwarcie Inspectora, następnie zmiana nazwy/geometrii lub inna edycja zakończona Apply. `buildObjectRegionPatch` (904–979) wysyła całą listę `material_overrides`, a `ObjectRegionsPanel.tsx::applyRegion` (453–492) wykonuje ten zapis. API `authoring.rs::apply_patch_object_region_transaction` (4345–4347) zastępuje listę.

Skutek: można wprowadzić tłumienie do modelu bez tłumienia albo przywrócić wymianę w obszarze, w którym jawnie ustawiono zero. Wpływ dotyczy wszystkich ścieżek, które później wykonują tak zmieniony model; nie jest błędem wyłącznie wizualnym. Zero jest legalne w IR: `crates/fullmag-ir/src/lib.rs::validate_material_parameter_number` (2092–2100) odrzuca dla Aex/Alpha dopiero wartości ujemne.

Naprawa: rozróżnić brak liczby od jej wartości, np. jawne sprawdzenie typu/`null`; nie używać truthiness. Regresja powinna przeprowadzić pełny round-trip istniejącego regionu z zerami przez odczyt draftu, zmianę samej nazwy i serializację patcha, sprawdzając identyczność fizyki.

## A2 — P1: edycja metadanych regionu może zniszczyć analityczne nadpisanie materiału

**Status: potwierdzony mechanizm w źródłach. Browser/runtime: NOT VERIFIED.**

Ten sam `resolveMaterialOverrideDrafts` obsługuje wartość tylko wtedy, gdy `kind == constant`; pozostałe rodzaje stają się zerem, a następnie często domyślną wartością. `buildObjectRegionPatch` zawsze tworzy `kind: "constant"` (943–950). `normalizeMaterialParameter` (441–447) mapuje wszystko poza Aex/Alpha/Ku1 na Ms, choć IR ma też Ku2, Kc1–3, osie i DMI.

Wyzwalacz: zapisane przez Python/API `region.material_overrides` z liniowym lub radialnym Ms/Aex/Alpha. Otworzyć region, zmienić nazwę i wykonać Apply. Wysyłany patch zastąpi funkcję stałą. Obsługa osobnej listy `material_parameter_fields` w `ObjectRegionMaterialFieldsModel.ts` nie chroni listy `material_overrides`; to dwie różne reprezentacje.

`canWriteRegion` w `ObjectRegionsPanel.tsx:308–309` sprawdza jedynie committed/authored region, a nie zgodność typu nadpisania z edytorem. Nie znaleziono na tej ścieżce zachowania nieobsługiwanego payloadu. Przykłady parametrów DMI/Kc mogą dodatkowo skończyć odrzuceniem jednostki lub wartości; pewny, wykonywalny przypadek dotyczy liniowego/radialnego Ms/Aex/Alpha, bez potrzeby zakładania działania regionalnego DMI.

Naprawa: zachowywać oryginalne warianty IR i wysyłać tylko zmieniane pola; dla nieobsługiwanego wariantu pozostawić go bez zmian i pokazać ograniczenie edycji. Test: zapis liniowego Ms, zmiana nazwy, odczyt ponowny i porównanie całego pola z gradientem, jednostką oraz frame.

## A3 — P1: szerokość przejścia materiałowego zależy od najmniejszej różnicy współrzędnych, nie od lokalnej siatki

**Status: potwierdzone w źródłach i izolowanej arytmetyce. Dotyczy wspólnego resolvera FDM/FEM; największe ryzyko w nieuporządkowanej siatce FEM.**

`crates/fullmag-plan/src/material.rs::characteristic_point_spacing` (107–121) sortuje osobno wszystkie współrzędne x/y/z i bierze najmniejszą dodatnią różnicę. Nie korzysta z krawędzi, elementów, sąsiedztwa ani lokalizacji granicy. `resolve_spatial_parameter_excluding_regions` (334–361) oblicza jedną wartość dla całego przekazanego zbioru; `transition_weight` (127–169) mnoży ją przez `cells`.

Wystarczy tetraedr o wierzchołkach `(0,0,0)`, `(10 nm,0,0)`, `(0,10 nm,0)`, `(10^-6 nm,0,10 nm)`: najkrótsza odległość między węzłami to 10 nm, ale wyliczone h to `1e-15 m`. Domyślne trzy h dają przejście `3e-15 m`, czyli niemal skok. Zdalny punkt albo obrót siatki może zmienić wynik bez fizycznej zmiany lokalnego materiału. Na anizotropowej siatce FDM minimalny krok osiowy nie jest automatycznie krokiem w kierunku normalnej do interfejsu.

To jest rozbieżność z `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`, sekcja 2.4: kontrakt mówi o lokalnej skali `h_local(x)`. Samo **domyślne wygładzanie** nie jest nieudokumentowanym błędem: `material_transition.rs::resolved_region_transition` (19–50) jawnie wybiera dla Ms/Aex trzy komórki, a publiczne `spatial-parameter-fields.md` to opisuje. Błędem jest sposób wyznaczania skali; brak widoczności tej decyzji w Inspectorze jest osobną luką UX.

Naprawa: przekazać do resolvera lokalny rozmiar z rzeczywistej topologii albo jawny metryczny tensor/krok zgodny z kontraktem. Dla reprodukowalnego profilu fizycznego udostępnić metryczną szerokość, zapisać jej realizację i profil w provenance. Regresje: obrót siatki, dodanie dalekiego węzła, lokalne zagęszczenie, anizotropowa siatka FDM; zmiany poza otoczeniem granicy nie mogą zmieniać lokalnego profilu.

## A4 — P2: zasób danych pola materiałowego może przypisać globalne próbki konkretnemu obiektowi i regionowi

**Status: potwierdzone w ścieżce fallbacku; nie dowodzi błędnego RHS solvera.**

`crates/fullmag-api/src/router_v2/handlers/data/material_fields.rs::material_field_data_resource` (158–200) w braku pasującego assetu pobiera `latest_material_field_values(snapshot, parameter)`. Helper (333–347) wybiera dane wyłącznie po nazwie wielkości, np. `mat_ms`. Argument `_object` nie jest używany; nie ma cięcia po membership/owner/region ani dopasowania assignment ID. Odpowiedź otrzymuje jednak `owner_object_id`, `source_region_id` i status `realized` danego assignmentu. Analogiczne zawyżenie liczby próbek/statusu występuje w `material_field_data_summaries` (117–154).

Warunek: brak odpowiadającego `material_field_asset`, ale obecne kwalifikowane globalne `mat_ms/mat_aex/mat_alpha`; dwa assignmenty tego samego parametru mogą wtedy dostać tę samą pełną tablicę i globalne statystyki. `latest_field_source_is_qualified` kontroluje aktualność źródła pola, co jest potrzebne, ale nie nadaje mu przestrzennego zakresu assignmentu. Nie zgłaszam tu obejścia tej kontroli aktualności.

Istniejący test `crates/fullmag-api/src/router_v2/tests.rs::material_field_data_resource_returns_realized_samples` (21221) sprawdza jeden assignment i cztery globalne próbki. Nie dowodzi izolacji dwóch obiektów/regionów. Preferowana ścieżka assetu dopasowuje owner i region (`matching_material_field_asset`, 269–288); wymaga dodatkowej weryfikacji dla kilku assignmentów jednego parametru na tym samym support, ponieważ nie rozróżnia ich ID.

Naprawa: bez dokładnego assetu zwrócić stan niezweryfikowanej realizacji albo jawne pole globalne; jeśli API ma zwracać zakres assignmentu, filtrować według certyfikowanego membership i zwracać indeksy/lokalizację. Regresja: dwa rozłączne obiekty z odmiennym Ms, dwa regiony i dwa priorytety; porównać wartości, liczbę próbek, owner, mesh revision i coefficient revision.

## A5 — P2: Python MagnetHandle przyjmuje nieobsługiwane atrybuty materiałowe, które nie trafiają do IR

**Status: potwierdzona luka authoringu; nie jest twierdzeniem, że te atrybuty są udokumentowanym API MagnetHandle.**

`packages/fullmag-py/src/fullmag/world.py::MagnetHandle.__setattr__` (602–608) sprawdza kontekst, ale pozwala dodać dowolny publiczny atrybut. `_to_ferromagnet` (674–696) przekazuje do `Material` tylko Ms/A/alpha/Ku1/anisU/Kc1/Dind/Dbulk. Przykładowe `body.Ku2`, `body.Kc2`, `body.anisC1` lub `body.Ms_field` pozostają zwykłymi atrybutami Pythona i nie są przekazywane dalej. Typ `Material` w `model/structure.py:16–134` ma odpowiednie bogatsze pola i jawnie je serializuje, więc obie powierzchnie API mają różny zakres.

Skutek: użytkownik posługujący się analogią do `body.Ku1` może bez błędu opisać parametr, który nie wpłynie na wynik. Naprawa: uzupełnić jawne wspierane właściwości albo odrzucać nieznane nazwy; nie przedstawiać rozszerzenia zakresu jako samej walidacji. Regresja: authoring każdego wspieranego parametru → `Material.to_ir()` → planner oraz jawny błąd dla nieobsługiwanych nazw.

## A6 — luki funkcjonalne i UX, których nie należy mylić z cichą utratą parametrów

1. **Regionalne Ku/DMI/osi/Kc:** `crates/fullmag-plan/src/validate.rs::validate_region_owned_planning` (74–131) dopuszcza spośród nowych override/assignment wyłącznie Ms, Aex, Alpha. Inne parametry są jawnie odrzucane we wszystkich lane. To nie dowodzi braku jednorodnej ani per-object anizotropii/DMI; te mają odrębne ścieżki materiałowe.
2. **Regionalne Ms/Aex/Alpha na FDM GPU:** ten sam validator (133–230) jawnie blokuje wymuszony CUDA, także z osobnym komunikatem multilayer. Odrzucenie jest poprawną ochroną przed obliczeniem innego modelu, ale pozostaje znaczącą luką możliwości.
3. **UI oferuje niewykonywalne parametry:** `ObjectRegionMagneticParametersPanel.tsx:38–42,521–525` oferuje Ku1; `ObjectRegionMaterialFieldsModel.ts::MATERIAL_FIELD_PARAMETERS` (51–59) także Ku2/Dind/Dbulk. Komunikat dla FDM przy override (470–478) mówi o braku zastosowania diagnostyki FEM, a nie pokazuje macierzy CPU/GPU dla wybranego parametru. Możliwość zapisania intencji trzeba wyraźnie odróżnić od wykonania.
4. **UI ukrywa przejście materiałowe:** `buildObjectRegionPatch` nie udostępnia `material_transition`; wygładzanie Ms/Aex jest domyślne. API zachowuje istniejący transition, gdy patch go nie zawiera (`authoring.rs:4351–4353`), więc nie stwierdzono jego kasowania przez Apply. Problemem jest brak kontroli i prezentacji tej ważnej decyzji.
5. **Odczyt dziedziczonego Ku1:** `ObjectRegionMagneticParametersPanel.tsx::getParentParamInfo` (91–141) szuka wartości w material properties. `ScriptBuilderMaterialState` (`crates/fullmag-authoring/src/builder.rs:487–499`) nie ma Ku1; w scenie anizotropia jest częścią `physics_stack`. Bez odpowiadającego pola ta ścieżka pokaże domyślne zero zamiast parametru oddziaływania rodzica. Jest to błąd prezentacji, nie samodzielny dowód zmiany solvera.
6. **Ujemne Ku1:** `validateObjectRegionDraft` (894–899) odrzuca ujemne Ku1, podczas gdy `Material` dopuszcza easy-plane Ku1<0 i IR nie zabrania znaku Ku. Wykonanie regionalnego Ku jest obecnie blokowane wcześniej; niespójność authoringu pozostaje do naprawy wraz z rozszerzeniem capability.
7. **Jednostki:** dla analitycznych pól `unit` jest metadanymi; `evaluate_parameter_field` (`material.rs:176–237`) nie przelicza wartości, a walidatory IR/scene nie wymagają zgodności jednostki dla constant/linear/radial. UI ma edytowalne pole Unit. Należy blokować niekanoniczną jednostkę albo jawnie przeliczać przed IR; wpisanie np. `pJ/m` nie może sugerować automatycznej konwersji. Nie wykonano testu przeglądarkowego tego przypadku.

## Zweryfikowane elementy przepływu

- Scena rozwiązuje `object.material_ref` do konkretnego assetu przed budowaniem skryptu: `crates/fullmag-authoring/src/adapters.rs::scene_document_to_script_builder`, 157–178. Nie znaleziono na tym etapie globalnego zastąpienia wszystkich obiektów jednym materiałem.
- `Material.to_ir` zachowuje skalary i tablice materiałowe, a `Problem._validate_material_consistency` odróżnia konflikt definicji o tej samej nazwie. Deduplikacji `_collect_materials` nie należy zgłaszać bez uwzględnienia tej walidacji.
- IR sprawdza owner regionu i assignmentu, unikalność region ID oraz konflikt assignmentów na tym samym support. Szczególna luka ID/name w plannerze FEM jest opisana w aneksie FEM.
- Resolver wybiera parametry po owner, parameter i aktywnym regionie; wyłączony region nie jest z zasady dodatkową domeną fizyczną. Konflikty równych priorytetów są odrzucane przez `region_conflict.rs::resolve_region_conflict`.
- Materiał przypisany do kilku obiektów jest wspólnym assetem. Edycja jego DMI synchronizuje wszystkie referencje (`authoring.rs::sync_interfacial_dmi_for_material`, 5230; `sync_bulk_dmi_for_material`, 5256). To zamierzona semantyka wspólnego assetu; UI powinien ujawniać listę konsumentów i oferować lokalną kopię przy edycji tylko jednego obiektu.

## Dowody i ograniczenia

Przeprowadzono statyczne śledzenie producentów, walidatorów, plannerów i konsumentów, przegląd istniejących testów oraz małą izolowaną reprodukcję arytmetyki. Dane w `isolated-evidence.json` **nie pochodzą z uruchomienia Fullmaga**. Nie uruchomiono testów projektu, buildów, solverów, kontenerów ani przeglądarki. Źródłowe testy są wskazówką pokrycia, nie zielonym wynikiem tej sesji. Nie zmieniono implementacji.
