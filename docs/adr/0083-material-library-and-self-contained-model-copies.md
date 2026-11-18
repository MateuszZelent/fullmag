# ADR 0083: Trwały katalog materiałów i samodzielne kopie w modelach

Status: decyzja zatwierdzona przez użytkownika 18.11.2026; implementacja i kwalifikacja w toku.

## Kontekst

Wbudowane parametry były pięcioma presetami we frontendzie. Modal zapisywał
materiały wyłącznie w aktywnej scenie, a Inspector nie oferował wyboru z trwałej
bazy. Użytkownik wymaga ponownego wykorzystania własnych materiałów między
projektami i rozróżnienia oryginałów od zmodyfikowanych kopii.

Zmiana wspólnego wpisu nie może po cichu zmieniać istniejących modeli. Sama
zgodność nazwy albo parametrów nie jest dowodem pochodzenia materiału.

Kontrakt materiałów i jawnych oddziaływań opisuje istniejąca nota
[0104](../physics/0104-material-regions-parameter-fields-and-interface-couplings.md).
Ten ADR określa politykę authoringu i provenance. Efektywne współczynniki trafiają
przez istniejący DSL do kanonicznego `ProblemIR`; dodatkowy snapshot jest
wersjonowanymi metadanymi istniejącej mapy `runtime_metadata`. Ocena wykonalności,
wybór backendu/urządzenia i jawny zestaw modułów pozostają w ich obecnych
kontraktach. Dowody roundtrip i tożsamości wejścia są wymagane osobno od solvera.

## Decyzja

1. Backend jest właścicielem katalogu. Pięć istniejących zestawów wartości SI
   przechodzi do wersjonowanej definicji backendowej. Są tylko do odczytu.
   Własny wariant ma własne ID, wersję i samodzielną kopię źródła.
2. Trwałe wpisy użytkownika są w osobnym `material-library.sqlite3`, obok
   `workspace.db` wyznaczonego przez `fullmag_workspace::default_database_path`.
   Nie zmieniamy pochodnej bazy workspace w magazyn treści modeli. Uszkodzona
   lub nieznana baza nie jest automatycznie zastępowana pustą.
3. Zakres katalogu to profil użytkownika aplikacji. Grupy Docker DEV nadal
   mają niezależne `/user-data` według ADR 0067. Nie wprowadzamy synchronizacji
   między komputerami ani grupami DEV.
4. Użycie wpisu tworzy nowy materiał sceny z efektywnymi parametrami,
   wszystkimi referencjami i opcjonalnym `source`. Przypisanie do wskazanego
   obiektu może nastąpić w tej samej transakcji authoringu. Aktualizacja lub
   usunięcie wpisu katalogu nie zmienia tej kopii.
5. `source` zawiera `catalog_id`, `catalog_revision`, `name`, `kind`,
   `properties` i `references`. `kind` ma wartości `builtin`, `custom`,
   `modified`. Dla starego materiału bez source pochodzenie pozostaje nieznane.
   Porównanie kopii uwzględnia liczby i wszystkie referencje. Zapis tekstowy
   `8e5` jest równoważny `800000`; zmiana nazwy nie jest zmianą parametrów.
6. Zmiana wspólnego materiału sceny nadal dotyczy wszystkich jego użytkowników.
   Inspector pokazuje użycia i umożliwia utworzenie niezależnej kopii dla
   wybranego obiektu. Zapis kopii do katalogu jest osobnym jawnym działaniem.
7. Efektywne parametry pozostają w modelu i w jednym publicznym Python DSL.
   Kanoniczny skrypt przenosi pełny inwentarz materiałów i pochodzenie przez
   wspierane `fm.runtime_metadata('material_assets', ...)`. Payload ma wersję
   `fullmag.material-assets.v1` i pola `materials`, `assignments`, `object_ids`.
   Nie wykonuje odczytów katalogu.
8. Przy reimporcie jawne współczynniki DSL mają pierwszeństwo przed metadanymi.
   Zmiana jednego użytkownika współdzielonego materiału tworzy deterministyczną
   niezależną kopię z zachowanym źródłem. Nieprzypisane materiały pozostają
   częścią modelu. Nowa geometria nie dziedziczy źródła przez podobną nazwę.
9. Przypisanie i edycja kopii zachowują stan oddziaływań DMI. Gdy zmiana
   współczynnika zmieniłaby dawną, domyślną aktywność DMI, model zapisuje
   dotychczasowy stan jawnie. Skrypt zapisuje jawnie wyłączone współczynniki
   jako edytorskie metadane `inactive_dmi`, przypisane do ID obiektu i pola
   `Dind` lub `Dbulk`. Przy reimporcie jawny DSL ma pierwszeństwo. Dla
   pominiętego pola bez tej informacji metadane zachowują wyłącznie
   nieaktywne zero. `active_dmi_without_coefficient` oznacza aktywne
   oddziaływanie emitowane jako zero przy pustym polu materiału. Niezerowa
   edycja DSL nadal zmienia współczynnik. Pochodzenie katalogowe nie
   uzupełnia parametrów wykonania.
10. Pochodzenie i referencje nie są wejściami wykonania w
    `scene_execution_input_view`. Zmiana samych metadanych przechodzi istniejącą
    bramkę `metadata_only`. Hash archiwizowanego całego ProblemIR może się
    zmienić, ponieważ opisuje także zachowaną provenance.

## Kontrakty zasobów

Katalog jest zasobem `/v2/workspace/material-library`, dostępnym bez aktywnej
sesji. GET zwraca rewizję katalogu oraz wpisy; POST tworzy wpis. Osobna ścieżka
`/{id}` obsługuje PUT i DELETE z wymaganą `base_revision` wpisu. Nie ma upsertu:
kolizja tworzenia i nieaktualna rewizja zwracają konflikt. POST i PUT zwracają
płaski wpis wraz z `catalog_revision` pobraną w tej samej transakcji co zapis;
DELETE zwraca nową rewizję katalogu. PUT zachowuje pochodzenie, również
gdy żądanie pomija `source`, a próbę podmiany snapshotu odrzuca.
Frontend unieważnia globalny zasób tym
zegarem także wtedy, gdy odpowiedź przychodzi po zmianie widoku. Rewizja wpisu
nie zastępuje rewizji katalogu. Błędy walidacji mają 400, brak wpisu 404, konflikt 409,
a błąd magazynu 500. Wbudowane ID są chronione przed zmianą i usunięciem. Przy
utworzeniu wpis dostaje rewizję z nowego zegara katalogu; aktualizacja zwiększa
rewizję wpisu. Ponowne użycie usuniętego ID nie może zaakceptować starego tokena
edycji lub usunięcia.

Scenowa transakcja `create_material` otrzymuje zgodne wstecznie opcjonalne
`source` i `assign_to_object_id`. Brak celu lub nieprawidłowe dane nie mogą
zostawić częściowo utworzonego materiału. Transakcja zachowuje historię undo/redo.
CRUD katalogu nie jest wpisem historii authoringu aktywnej sceny.

OpenAPI pozostaje źródłem typów i ścieżek. Control Room używa centralnej fasady
`ControlRoomApi.workspace` oraz `useMaterialLibraryResource`. Modal jest wspólny
dla Tools i Inspectora. Nie tworzy własnych endpointów ani osobnego magazynu
katalogu w Zustand. Ponowne otwarcie odświeża katalog; konflikt zachowuje draft
przed jawnym przeładowaniem. Spóźniony ACK nie zmienia draftu nowej sesji.

## Opublikowane wersje

Kopia materiału z dowolnego projektu może zostać opublikowana z kluczem
`rodzina.wersja`. Oba człony są stabilnymi identyfikatorami Pythona. Publikacja
przypina efektywne wartości SI, referencje, dostępne pochodzenie i oryginał
rodziny do porównania. Zmiana próbki używa nowego klucza. Zmiana nazwy i archiwizacja
obejmują wyłącznie metadane publikacji. Archiwalny klucz nadal działa w skryptach
i jest ukryty w domyślnym wyborze w UI.

GET katalogu zwraca `versions` w tym samym snapshocie co `entries` i `revision`.
POST `/versions` sprawdza rewizję kopiowanego wpisu. PATCH
`/versions/{family}/{version}` sprawdza rewizję publikacji. Mutacje przesuwają
wspólny zegar katalogu. SQLite migruje do schematu 2 w jednej transakcji.
Tabela publikacji ma unikalny klucz `(family, version)`. Limit odczytu dla
skryptu wynosi 8 MiB i jest egzekwowany przy zapisie, by stare klucze pozostały
dostępne.

Zarządzane API i CLI czytają katalog przez `fullmag-workspace` przed uruchomieniem
skryptu. Katalog trafia do kontekstu autora przez ograniczone wejście pomocnika.
`fm.materials.yig.kuswik` zwraca przypięty zestaw z tego kontekstu. Samodzielny
Python może użyć `Client.bind_material_catalog()` dla wybranej instancji.
Przypisanie na uchwycie zachowuje jawny stan oddziaływań. Eksport DSL zapisuje
efektywne wartości oraz opcjonalną tożsamość wersji w istniejących metadanych
materiału. Takie źródło i kopia w archiwum projektu odtwarzają model także
bez połączenia z katalogiem.

## Walidacja i prezentacja

Wartości muszą być skończone; podane Ms jest dodatnie, Aex i alpha są nieujemne.
Alpha jest wymagana. Puste opcjonalne pole oznacza null, a nie zero; oba DMI
mogą mieć dowolny znak. Niekompletny wpis nie omija gotowości modelu. Ku1 i oś
anizotropii pozostają parametrami jawnego oddziaływania. Dbulk i Dind w tym
kontrakcie mają J/m². Dotychczasowe DOI są referencjami presetów i nie oznaczają
kwalifikacji każdej liczby dla konkretnej próbki.

## Migracja i wycofanie

Dawne sceny nie wymagają migracji: `source` jest opcjonalne. Nie dopisujemy go
heurystycznie. Istniejących materiałów sceny nie kopiujemy automatycznie do bazy.
Frontendowa tablica presetów jest przejściową kompatybilnością podczas wdrożenia;
po przełączeniu modalu ma zostać usunięta, razem z jej wyłącznymi konsumentami.

Wycofanie UI nie usuwa katalogu ani snapshotów w plikach użytkownika. Starszy kod
może nie zachować nowych metadanych przy ponownym zapisie; przed takim zapisem
należy zachować oryginalny projekt/skrypt. Nie obniżamy wersji ani nie resetujemy
bazy jako sposobu wycofania.

## Obowiązki implementacji i weryfikacji

- Store: trwałość, oddzielne create/update, niezmienność builtinów, konflikty,
  komplet referencji, zachowany baseline po usunięciu źródła i ochrona uszkodzonej bazy.
- API i authoring: błędy DTO, brak sesji dla katalogu, atomowe copy/assign,
  legacy create, undo/redo i zachowanie source w scenie i pojedynczym zasobie.
- Python/Rust: save/reload, współdzielenie, indywidualna edycja, nieprzypisane
  materiały, 0/null DMI, source-only execution identity i odrzucanie złych metadanych.
- Frontend: walidacja SI, źródło i różnice, resource lifecycle, DOM modalu,
  typecheck, lint, API/architecture hygiene oraz wymagany zestaw testów Control Room.
- Browser: Tools i Inspector, wszystkie tryby katalogu, trwałość między
  projektami i restartem, fokus/Esc/dirty guard, konflikty i stabilność Object/Airbox.

Decyzja opisuje kontrakt. Testy źródeł, build, runtime, browser i kwalifikacja
wydania są oddzielnymi dowodami; nie potwierdzają automatycznie pozostałych warstw.

Projekt i szczegóły diagnozy: [zatwierdzony projekt](../superpowers/specs/2026-11-18-material-database-production-design.md).
