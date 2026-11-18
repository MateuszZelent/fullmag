# Plan wdrożenia wersji materiałów

Projekt zatwierdzony 18.11.2026. Pojedynczy checkout zadania zawiera wspólny kontrakt przechowywania, API, UI i Pythona. Wdrożenie nie zmienia solvera ani parametrów wzorcowych materiałów.

## Kontrakt danych i API

- [ ] Rozszerzyć opcjonalne `SceneMaterialSource` o `version` z polami `family`, `version` i opcjonalnym `source_project`. Rodzina i wersja to identyfikatory ASCII o długości do 48 znaków, zaczynające się małą literą, z dalszymi małymi literami, cyframi i podkreśleniem. Zastrzec słowa kluczowe Pythona, początkowe podkreślenie i prefiks syntetycznych identyfikatorów wpisów `custom:published:`.
- [ ] Przenieść odpowiedzialność za otwarcie i migrację osobnego pliku katalogu do `fullmag-workspace::material_catalog`. Zachować istniejący path resolver, SQLite application ID i dane v1. W v2 dodać tabelę publikacji z unikalnym kluczem `(family, version)`. Użyć współdzielonego typowanego odczytu w API i CLI.
- [ ] Zwracać `versions` wraz z istniejącymi `entries` i `revision` z jednego snapshotu. Publiczny `PublishedMaterialVersion` ma `source` (zamrożony `SceneMaterialSource` z pełnym kluczem, nazwą z chwili publikacji, wartościami i referencjami), opcjonalny `original` (zamrożony oryginalny snapshot do różnic), `display_name`, `archived` i `revision`. Przechowywać oryginał rodziny także dla wariantu skopiowanego z dawnego projektu, gdy istnieje wbudowany oryginał. Kopia z innej rodziny pozostaje jawna w źródle.
- [ ] `POST /v2/workspace/material-library/versions` przyjmuje `material_id`, `base_revision`, `family`, `version`, `display_name` i opcjonalne `source_project`. `PATCH /v2/workspace/material-library/versions/{family}/{version}` przyjmuje `base_revision`, `display_name` i `archived`. Obie mutacje zwracają `catalog_revision` i `published`. Publikacja i mutacja metadanych używają jednego zegara katalogu. Odbiorca może odczytać zarchiwizowaną wersję w tym samym zasobie.
- [ ] Testy migracji, CAS, duplikatu, niezmienności po edycji i usunięciu roboczego wpisu, archiwizacji, nazwy wyświetlanej i błędów niepełnych danych. Odświeżyć wygenerowane kontrakty obu klientów w zarządzanej ścieżce.

## Python i odtwarzanie

- [ ] Wprowadzić publiczny obiekt tylko do odczytu pod `fm.materials` i przypisanie do `MagnetHandle.material`. Walidacja i round trip rozpoznają `SceneMaterialSource.version`. Zachować stan DMI, efektywne nadpisania i niezmienność źródła. Bazować na obecnych metadanych `material_assets` i eksporcie wartości DSL.
- [ ] API i CLI dostarczają typowany, ograniczony rozmiarem odczyt katalogu do przechwytywacza, z użyciem istniejącej granicy przed uruchomieniem kodu użytkownika. Przechwytywacz nie daje skryptowi dostępu do pliku SQLite ani podlegającego mu transportu. Obsłużyć pełny klucz w przypadku braku materiału.
- [ ] Umożliwić jawne wiązanie widoku katalogu w samodzielnym Pythonie przez istniejącego `Client`. Wyeksportowany skrypt i archiwum odtwarzają przypięte wartości niezależnie od dostępności katalogu. Testy obejmują przechwytywanie, przypisanie, odczyt archiwalnej wersji, odtwarzanie offline, błędy i zachowanie DMI.

## Przeglądanie i wybór

- [ ] Grupować oryginały i wersje za pomocą stabilnych kluczy w istniejącym modalu. Wyświetlać alias, pochodzenie, różnice i referencje. Oznaczać wersje archiwalne i pozostawić możliwość ich administracji. Robocze wpisy nadal się edytują i można je publikować.
- [ ] Z istniejącego przepływu `Save copy to database` przejść do publikacji. Wybór wersji kopiuje parametry do bieżącego obiektu z dotychczasową atomową mutacją sceny. Inwalidacja pozostaje w warstwie resource hooks.
- [ ] Sprawdzić klawiaturę, wyszukiwanie, wygodny wybór w Model Builderze, stabilność Inspectora, ponowne otwarcie projektu i uruchomienie skryptu z zarchiwizowanym kluczem.

## Integracja

- [ ] Wykonać skupione bramki projektu i przegląd całej zmiany. Weryfikować zarządzany DEV na jednej potwierdzonej architekturze CUDA hosta. Jeśli środowisko DEV ma aktywną blokadę, wykonać niezależne bramki CI i wskazać brakujący dowód runtime.
- [ ] Ukończyć integrację przez PR, aktualizację głównego checkoutu, weryfikację oraz zweryfikowane wycofanie grupy i worktree tego zadania.
