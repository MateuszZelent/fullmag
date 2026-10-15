(mesh-bound-nodal-material-arrays)=
# ADR 0059 — wiązanie publicznych tablic materiałowych z siatką FEM

Status: accepted dla decyzji semantycznej użytkownika; implementacja i kwalifikacja NOT VERIFIED.

Data: 15.10.2026. Źródło bazowe: `MateuszZelent/fullmag@91c4bd8618079b4a72af6994a8b1267352a87c3a`. Decyzja użytkownika: zachować publiczne tablice nodalne, wiązać je z siatką i kolejnością węzłów, uwzględniać w planowaniu. Dokument jest kontraktem do implementacji, nie dowodem jej ukończenia.

## Rozstrzygnięcie

Zachowujemy `Material.Ms_field`, `A_field`, `alpha_field`, `Ku_field`, `Ku2_field`, `Kc1_field`, `Kc2_field`, `Kc3_field`, `Dind_field`, `Dbulk_field` jako wejście autorskie. Poprawiamy sprzeczne zdania noty 0104, które uznawały je wyłącznie za wynik materializacji. Nodalna tablica jest bazowym profilem danego parametru zamiast jego skalaru; aktywne regiony i jawne przypisania następnie stosują istniejącą politykę priorytetów, konfliktów i mieszania.

## Konkretny kontrakt danych

Publiczny `MaterialNodalFieldBinding` i odpowiadający `MaterialNodalFieldBindingIR` zawierają `canonical_mesh_fingerprint: str` oraz `node_count: int`. `Material.nodal_field_binding` / `MaterialIR.nodal_field_binding` jest wspólnym, opcjonalnym bindingiem wszystkich obecnych tablic. Lokalizacja jest z definicji **Node**, liczba składowych wynosi 1; jednostki wynikają z nazwy parametru: Ms A/m, A J/m, alpha 1, Ku/Kc J/m³, Dind/Dbulk J/m². Nie przyjmujemy swobodnej metadanej pozwalającej zadeklarować inną jednostkę lub lokalizację dla tych nazw.

Fingerprint pochodzi z `MeshIR::topology_fingerprint_v6()` dla dokładnego końcowego mesha planu, po pakowaniu i remapowaniu. Wektor ma długość wszystkich węzłów tego snapshotu, z indeksowaniem globalnym; indeks `i` odnosi się dokładnie do `mesh.nodes[i]`. Wybór węzłów należących do obiektu następuje przez istniejące `FemMeshPartIR.node_indices`, nie przez dopasowanie współrzędnych, nazw materiału ani domniemany przedział.

Nie tworzymy bindingu automatycznie dopiero przy planowaniu: to nadałoby starej tablicy fałszywą tożsamość nowej siatki. Użytkownik przygotowuje wartości na podstawie wcześniej zmaterializowanego, certyfikowanego snapshotu. Remeshing lub przepakowanie zmieniające fingerprint wymaga jawnego transferu w osobnym kontrakcie; pierwsze wdrożenie odmawia transferu. Równa długość nie uprawnia do użycia.

Binding bez żadnej tablicy jest błędem authoringu. Obecność dowolnej tablicy bez bindingu pozostaje czytelna jako historyczne wejście, lecz planowanie nowego FEM kończy się jawnym błędem migracji przed ABI. Każda tablica musi być niepusta, mieć `node_count` elementów, zawierać skończone liczby rzeczywiste (bez bool); Ms > 0, A >= 0, alpha >= 0. Pozostałe parametry mogą być ujemne. Tożsamość mesha i długość sprawdza Rust względem rzeczywistego planowanego mesha, niezależnie od walidacji Pythona.

## Jeden resolver i dwie ścieżki FEM

`fullmag-plan::material` otrzymuje jeden wspólny rdzeń rozwiązywania parametrów z bazą skalarną albo już zweryfikowaną bazą nodalną. Istniejące wejścia skalarne/FDM delegują do tego rdzenia. Nowa baza nie jest konkurencyjnym przypisaniem o arbitralnym priorytecie: jest podstawą używaną w `base + weight * (override - base)`. Zachowujemy istniejący resolver konfliktów regionów. Sampled assets pozostają osobną, jawnie nieobsługiwaną ścieżką do czasu dokończenia ich rejestru i lookup; ten krok nie udaje implementacji `MaterialParameterFieldIR::Sampled`.

`build_region_material_fields` korzysta ze wspólnego resolvera dla wszystkich dziesięciu parametrów, z prawidłowym mapowaniem globalny indeks → punkt obiektu. Wartości anizotropii i DMI nie mogą pozostać kopiowaniem samych skalarów. Wynikowe tablice planu mają binding końcowej siatki; tablice skalarnie stałe mogą nadal zostać zredukowane do skalaru, ale zachowane authored intent i provenance muszą wykazać ich źródło.

Zarówno `FemPlanIR`, jak i `FemEigenPlanIR` muszą używać tego samego kroku po finalnym wyborze mesha i map obiektów. Nie wolno dopuścić niezależnego przekazania surowego `material` w eigensolve. Nodal P1 i conformal element-DG0 dla Ms/A pozostają rozłączne; istniejący konflikt ma blokować planowanie. Reguły periodycznych pól i native walidacja kształtu/wartości pozostają bez osłabienia.

FDM używa pól komórkowych i innego porządku. Binding nodalny FEM w żądaniu FDM należy jawnie odrzucić, nie ignorować ani interpretować jako flattening komórek. Implementacja komórkowego bindingu FDM nie jest domyślnym skutkiem tej decyzji.

## Warstwy i zgodność

- IR: typowany companion binding, serde default dla historycznego braku; aktualizacja jawnych konstruktorów Rust bez zmiany historycznych artefaktów.
- Python: konstrukcja, walidacja, `to_ir()`, eksport z namespace; bez backendowego resolvera w Pythonie.
- UI/API: zachowanie bindingu i wartości przy imporcie/eksporcie skryptu i dokumentu; żaden własny endpoint ani osobne drzewo FEM. Brak kontrolki edycji wielkich tablic nie uprawnia do ich utraty.
- Planner/runtime: walidacja dokładnej siatki przed materializacją, wspólny resolver obu ścieżek, finalny binding i provenance. Natywne ABI nie potrzebuje nowego layoutu wskaźników; kontrola tożsamości należy przed ABI i przy przyjęciu zserializowanego planu.
- Stare artefakty: nie dopisujemy im retroaktywnie bindingu. Czytelność historycznych wyników pozostaje; ponowne obliczenie wymaga jawnego, poprawnie związanego wejścia.

## Kryteria odbioru i weryfikacja

1. Python → IR → kanoniczny eksport zachowuje wszystkie 10 tablic i binding; błędne wartości, bool, pusta tablica, brak bindingu i błędny node_count są rozróżnione.
2. Dwie siatki o tej samej liczbie węzłów i innych numeracjach: pierwsza przyjmuje związane pole, druga odmawia; podobnie zmiana konektywności/mesha.
3. Transient/eigen dla tego samego mesha, materiałów i regionów produkują identyczne tablice. Test wartości celowo różnych od skalarów wykrywa utratę wejścia.
4. Nieciągły owner map z airboxem nie przejmuje wartości drugiego obiektu; konflikt nodal Ms/A z DG0 i niezgodność periodyczna nadal odrzucane.
5. Region override jest liczony względem lokalnej wartości nodalnej, z niezmienionymi priorytetami/polityką. Alpha zachowuje nakładanie absorbing boundary.
6. FDM odmawia bindingu Node. Stare wyniki pozostają czytelne. Nowy niespójny plan nie może ominąć kontroli przez bezpośrednią deserializację.
7. Testy projektu wyłącznie w GitHub Actions. Source/serde/planner checks nie dowodzą runtime MFEM/GPU ani poprawnej dyspersji; kwalifikacja fizyczna pozostaje oddzielna.

## Stan

Decyzja semantyczna **zaakceptowana**. Kontrakt zapisany; implementacja bindingu, wspólnego resolvera oraz wymienione bramki są **TODO / NOT VERIFIED**. Nie zmieniono chronionego worktree ani danych storage.
