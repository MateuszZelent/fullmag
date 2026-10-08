# T04: walidacja i bounds CPW w authoringu Rust

## Wdrożony przyrost

Właściciel `crates/fullmag-authoring/src/geometry.rs`:

- `geometry_capabilities`: CPW jako Preview, z takim samym rozdzieleniem
  możliwości jak istniejący microstrip; nie Production.
- `validate_geometry_node`: rozpoznaje `CPWAntennaLayout`, odrzuca FDM,
  przekazuje parametry do `parse_cpw_layout`; błędy blokują realization,
  mesh i solve tak jak dla microstrip.
- `parse_cpw_layout`: skończone dodatnie długość, grubość, przewodność,
  signal width, obie szczeliny i obie ground widths; co najmniej dwie stacje,
  pozycje w [0,1], ścisły porządek, końce 0 i 1.
- `parse_antenna_layout_transform`: istniejąca walidacja microstrip została
  wydzielona bez zmiany reguł i współdzielona z CPW. Macierz 3×3 musi być
  prawoskrętną rotacją; translacja skończonym wektorem.
- `cpw_layout_bounds` i `derive_geometry_bounds`: uwzględniają wszystkie
  trzy przewodniki każdej stacji i lokalny rigid transform. Nie korzystają
  ze starych stored bounds. Istniejący `derive_object_bounds` nadal stosuje
  osobną transformację obiektu sceny.

Nie zmieniono równań fizycznych, solvera, schematu JSON, API route ani
publicznego writer version. Type nie aktywuje nowej fizyki. Nie dodano
magnetyzacji ani materiału magnetycznego do przewodnika.

## Weryfikacja

`just check-api-source`: **passed**, exit 0.
Receipt `d5f801a5207a45548d323a9f7ead9b02` w
`storage/builds/<worktree-id>/windows-api-source-check/api-source-check/`.
Jest to zarządzany produkcyjny `cargo check --locked -p fullmag-api --bin fullmag-api`,
nie testy Rust/C++, nie linkowanie kwalifikowanego pakietu FEM i nie solver.

Source content przed i po identyczny:
`1258abd8972ba60e42fcea32ae7df48571bd82ec546fda5ecbd9c4e85ceb73ed`.
Sprawdzony hash `geometry.rs` zgadza się z rzeczywistym plikiem:
`db7f1c1c01b6baace1416cefbc1b3e8a274b37671a0167becb0e9a7993961269`.
120 ostrzeżeń API pozostawiono bez niezwiązanych poprawek.

Dwie nowe regresje Rust zapisane, **nie kompilowane i nie wykonane**:
`cpw_scene_uses_all_station_bounds_and_rejects_fdm` oraz
`cpw_layout_rejects_invalid_stations_and_transforms`. Obejmują asymetryczne
gaps/grounds, maksimum szerokości wewnętrznej stacji, pominięcie stale
stored bounds, rotation/translation, brak i zero wymiarów, niepoprawne
pozycje stacji, reflection i nonrigid transform. Scena testowa anteny nie
ma magnetic refs. Source-check nie typecheckuje kodu pod `cfg(test)`.

Próba opcjonalnego interpretera składni tree-sitter nie została wykonana:
moduł nie jest zainstalowany w wybranym Pythonie; niczego nie instalowano.
Nie jest to błąd parsera Rust. Produkcyjny source-check dostarcza mocniejszy
dowód parsowania i typów kodu produkcyjnego, ale nie wykonania regresji.

## Otwarte bramki

UI/browser i native runtime CPW **NOT VERIFIED**. Aktywnej sesji nie
restartowano. Build 38 nadal pracuje na wcześniejszym immutable commicie
`86810f37e21e95b3f8e24d967fdb2bad9511eff1`; nie zawiera tej zmiany.
FDM CPU/GPU: CPW authoring jawnie odrzucony. FEM CPU: production source-check,
bez runtime; FEM GPU: bez nowej kwalifikacji.

Nadal wymagane: zgodność inventory/public writer, własny Inspector i kreator,
pełna identyfikacja conductor/terminal refs poza samym kształtem, independent
source mesh obok airbox, wykonanie current→field, reusable basis, FFT/LLG
i wszystkie bramki T00–T18. Nie zamknięto T04 ani całego modułu.
