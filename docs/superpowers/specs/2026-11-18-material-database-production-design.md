# Wspólna baza materiałów — diagnoza i projekt wdrożenia

Data: 2026-11-18. Stan: projekt zatwierdzony przez użytkownika; implementacja w toku.

## Cel i decyzje użytkownika

Użytkownik chce przeglądać wbudowane parametry materiałowe w dedykowanym modalu,
dodawać własne materiały i wybierać je w Model Builderze, zachowując ręczną edycję.
Własna baza ma służyć kolejnym projektom. Oryginały i materiały zmodyfikowane
muszą być jednoznacznie oznaczone. Poniższe szczegóły realizacji są propozycją
implementera, a nie dodatkowymi decyzjami użytkownika.

## Diagnoza stanu obecnego

Baza diagnozy: lokalny `master`, commit
`ce81f95e191bff51922f3f0f8911694accd7404d`, oraz przeglądarka pod
`http://localhost:3197/session/fem-two-spheres-mesh-test`.

| Obszar | Istnieje | Brak lub problem |
| --- | --- | --- |
| Modal | Tools → Material Library; lista sceny, edytor, presety | Nie jest trwałym katalogiem między projektami; brak wyszukiwania i oznaczeń pochodzenia |
| Presety | Permalloy Ni80Fe20, CoFeB, YIG, Ni, Fe, podstawowe parametry i odnośniki DOI | Katalog zaszyty w frontendzie; obecność DOI nie dowodzi udokumentowania każdej liczby |
| Materiały sceny | Tworzenie, patch, usuwanie przez transakcje i historię authoringu | Brak związku z wersją wpisu katalogu i zachowanej podstawy porównania |
| Inspector | Przypisanie materiału ze sceny, ręczne parametry, Create and assign | Brak bezpośredniego wyboru wpisu wspólnej bazy |
| Ochrona zapisu | Backend odrzuca duplicate create, chroni usuwanie przypisanego materiału | Modal wybiera patch według samego ID; nowy wpis z kolidującym ID może zmienić istniejący materiał |
| Formularz | Liczby SI i jedno źródło literaturowe | Pusta alpha przechodzi przez Number("") jako 0; zakresy nie są spójne; edycja zachowuje tylko pierwszą referencję |
| Jednostki | Inspector pokazuje Dbulk w J/m² | Modal pokazuje J/m³, sprzecznie z aktualnym kontraktem Fullmaga |
| Cykl UI | Modal korzysta z centralnego klienta i resource hooks | Brak lokalnych testów DOM modalu; późny ACK, zmiana sesji, dirty draft i konflikt wymagają sprawdzenia |

W przeglądarce potwierdzono otwarcie modalu, wybór presetu i odczyt materiału
`Test Permalloy` (`mat:test-permalloy`). Ma on puste Ms i Aex. Workspace
zgłasza brak Aex dla Sphere A jako blokadę Compute. Podczas diagnozy nie zapisano
materiału, nie zmieniono przypisań i nie uruchomiono Solve.

### Źródła diagnozy

- `apps/control-room/src/kernel/layout/MaterialLibraryDialog.tsx`:
  `MaterialLibraryDialog`, `saveDraft`, `requiredNumber`, `draftFromSceneMaterial`.
- `apps/control-room/src/shared/domain/material/materialLibrary.ts`:
  `MATERIAL_LIBRARY_PRESETS`, `materialNameToId`.
- `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanel.tsx`:
  `useObjectMaterialPanelState`, sekcje Assignment i Create and Assign Material.
- `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`:
  `apply_create_material_transaction`, `apply_patch_material_transaction`,
  `apply_delete_material_transaction`.
- `crates/fullmag-authoring/src/scene.rs`: `SceneMaterialAsset`.
- `crates/fullmag-workspace/src/lib.rs`: baza workspace przechowuje stan pochodny,
  nie treści modeli ani jedynej kopii materiałów.
- `scripts/fullmag_docker_runtime.py`: `_workspace_user_data_root`;
  `compose.dev.yaml`: trwały bind `/user-data`, izolowany per grupa DEV.
- `docs/physics/0405-bulk-dmi.md`, rozdział 6: aktualny publiczny ABI Dbulk
  używa J/m². Ta zmiana UI nie zmienia definicji współczynnika ani solverów.

## Rozważone podejścia

1. Biblioteka wyłącznie w scenie: najmniej pracy, ale nie spełnia wybranego przez
   użytkownika ponownego użycia między projektami.
2. Wspólny katalog z automatycznie aktualizowanymi referencjami w modelach:
   łatwe centralne zmiany, lecz edycja wpisu zmieniałaby istniejące modele
   i utrudniałaby odtwarzanie wyników.
3. **Rekomendowane: wspólny trwały katalog i samodzielne kopie w modelach.**
   Wpis katalogu ma wersję, a model zapisuje wartości i ich pochodzenie.
   Późniejsze zmiany katalogu wymagają świadomego ponownego wyboru przez użytkownika.

Wymóg wspólnej bazy został wybrany przez użytkownika. Wersjonowanie i kopiowanie
do sceny są proponowanym sposobem ochrony odtwarzalności, do zatwierdzenia.

## Zachowanie i oznaczenia

### Katalog

- **Built-in / Wbudowany**: wpis dostarczony z aplikacją, tylko do odczytu.
  Akcja edycji tworzy własny wariant; nie nadpisuje oryginału.
- **Modified / Zmodyfikowany**: własny wariant pochodzący od wskazanego wpisu.
  Szczegóły pokazują nazwę i wersję źródła oraz różnice wartości SI i referencji.
- **Custom / Własny**: wpis utworzony od zera, bez deklarowanego źródła.
- Zmiana nazwy nie zmienia pochodzenia i nie udaje zmiany parametrów.
  Różnice obliczamy z wartości liczbowych, a nie zapisu tekstowego (800000 = 8e5).
- Wariant zachowuje kopię źródłowych parametrów i referencji. Usunięcie lub
  aktualizacja źródła nie niszczy możliwości porównania.
- ID jest trwałą tożsamością, niezależną od nazwy. Create i update są odrębnymi
  operacjami; kolizja tworzenia nie przechodzi automatycznie w update.
- Usunięcie własnego wpisu katalogu nie usuwa jego kopii z modeli. Oryginały
  wbudowane nie mają operacji usuwania.
- Zapis wpisu katalogu nie modyfikuje aktywnej sceny. Zapis materiału w modelu
  nie zapisuje automatycznie zmian do wspólnej bazy.

### Model i Inspector

- Przy Material Assignment dostępna jest akcja **Choose from database**.
  Otwiera ten sam modal w trybie wyboru, z wyszukiwaniem, filtrami pochodzenia,
  podglądem parametrów SI i literatury.
- **Use in model** tworzy samodzielny materiał sceny z przypiętą wersją źródła
  i przypisuje go do wskazanego obiektu przez authoring transaction.
  Model nie wykonuje przyszłych odczytów katalogu w celu rozwiązania fizyki.
- Ponowny wybór tego samego źródła nie nadpisuje automatycznie wcześniej
  zmodyfikowanej kopii. Nowa kopia dostaje nowe ID.
- Ręczna edycja materiału nadal działa. Panel pokazuje pochodzenie oraz
  **Unmodified copy / Kopia bez zmian** lub **Modified in model / Zmieniony w modelu**
  względem przypiętej wersji katalogu. Dla dawnego materiału bez metadanych
  pokazuje **Model material / Materiał modelu — źródło nieznane**.
- Jeżeli jeden materiał sceny jest przypisany do kilku obiektów, edycja jego
  parametrów nadal dotyczy tych obiektów. Panel jawnie pokazuje użycia oraz
  pozwala utworzyć kopię dla wybranego obiektu przed niezależną edycją.
- Własną kopię modelu można świadomie zapisać do bazy jako nowy wpis/wariant.
- Ku1 i oś anizotropii pozostają jawnymi parametrami oddziaływania; wybór
  materiału nie włącza anizotropii ani innych modułów przez nazwę lub etykietę.

### Formularz i błędy

- Wspólne reguły liczb dla modalu i Inspectora: skończone wartości, jawne
  rozróżnienie pustego pola, null i zera; alpha nie może być pusta ani ujemna.
  DMI może mieć dowolny znak. Zakresy Ms/Aex wynikają z istniejącego kontraktu
  authoringu; nie wprowadza się nowej fizyki ani cichego uzupełniania wartości.
- Katalog może przechować niekompletny własny wpis, ale pokazuje brakujące
  parametry. Użycie takiego wpisu nie obchodzi bramki gotowości modelu.
- Edycja zachowuje wszystkie referencje. URL jest walidowany w API.
- Zapis i przypisanie pokazują oddzielnie pending, sukces i błąd. Konflikt
  wersji nie usuwa draftu i wymaga świadomego odświeżenia przed ponowieniem.
- Zmiana sesji/unmount unieważnia skutki spóźnionych odpowiedzi dla nowego UI.
  Podwójne kliknięcie nie tworzy dwóch wpisów ani dwóch przypisań.
- Zamknięcie, zmiana wpisu i przełączenie trybu z brudnym draftem oferują
  zachowanie zmian albo ich świadome odrzucenie; nie gubią ich po cichu.
- Modal używa wspólnego prymitywu Dialog zgodnie z regułami repo. Sprawdzamy
  nazwę, fokus, Esc, powrót do wywołującego, jawne etykiety i ogłaszanie błędów.
  Modern Web Guidance nie jest powodem do wymiany całego systemu prymitywów.

## Własność danych i kontrakty techniczne

- Backend jest właścicielem katalogu i walidacji. Pięć istniejących presetów
  przechodzi do jednej wersjonowanej definicji backendowej; frontend otrzymuje
  je tym samym kontraktem co wpisy użytkownika. Nie dodajemy niezweryfikowanych
  nowych stałych ani twierdzenia, że obecne DOI dokumentują wszystkie wartości.
- Osobny `material-library.sqlite3` obok trwałego `workspace.db`, poza danymi
  buildu. Nie zmieniamy kontraktu workspace.db na magazyn treści naukowych.
  Katalog przeżywa restart backendu, nową sesję i zmianę projektu.
- W DEV trwałość obejmuje profil użytkownika danej grupy Compose; grupy nadal
  mają niezależne dane zgodnie z ADR 0067. Automatyczne współdzielenie zapisów
  między różnymi grupami DEV lub komputerami jest poza tym zakresem.
- Jeden zasób katalogu w istniejącej rodzinie API v2 workspace, z osobnymi
  create/update/delete, wersją/revision i kontrolą konfliktu. Ostateczne nazwy
  DTO i podział modułów rozstrzyga implementer według wzorców repo.
- OpenAPI jest źródłem typów; centralny klient i resource hooks obsługują
  odczyty, mutacje, cache i invalidację. Komponenty nie tworzą endpointów.
- Pochodzenie jest opcjonalną, zgodną wstecznie metadaną materiału sceny,
  niesłużącą do wyboru solvera. Zawiera tożsamość i wersję katalogu oraz
  samodzielny baseline wartości/referencji. Zapis/odczyt projektu zachowuje je.
- Kanoniczny eksport Python zapisuje efektywne wartości bez konieczności
  dostępu do bazy. Pochodzenie zachowujemy istniejącym wspieranym mechanizmem
  metadanych; jeśli brak takiej ścieżki, jej jawne dodanie i test round-trip są
  częścią implementacji, a nie powodem do cichej utraty etykiety.
- Nie zmieniamy ProblemIR, algorytmów FDM/FEM, wyboru CPU/GPU ani parametrów
  solverów. Wszystkie cztery realizacje używają dotychczasowych wartości modelu.

## Weryfikacja i kryteria ukończenia

1. Store/API: trwałość po ponownym otwarciu, niezmienność presetów, CRUD,
   unique create, optimistic conflict, walidacja, zachowanie pochodzenia
   i baseline po usunięciu/aktualizacji źródła.
2. Authoring: import/przypisanie, undo/redo, model niezależny od bazy,
   brak nadpisania istniejącego ID, stabilne odczyty po ACK, użycia współdzielonego
   materiału i niezależna kopia dla jednego obiektu.
3. Model/eksport: zachowanie wartości i pochodzenia w save/reload oraz
   kanonicznym Python round-trip; legacy bez metadanych nie jest uznawane
   za oryginał na podstawie nazwy lub przypadkowej zgodności liczb.
4. Frontend: testy domeny, hooks i DOM modalu; typecheck, lint bez ostrzeżeń,
   wymagany zestaw testów Control Room i check API hygiene.
5. Browser: otwarcie z Tools i Inspectora, wyszukiwanie, wybór oryginału,
   wariant zmodyfikowany, własny wpis, restart/nowy projekt, ręczna edycja,
   porównanie zmian, konflikt i ochrona draftu, obsługa klawiatury.
6. Browser Inspector Object/Airbox: trwała tożsamość korzenia, brak wyłączania
   obcych pól i animacji opacity, zachowany scroll/fokus przez pending/ACK,
   ograniczona liczba renderów i żądań. Airbox tam, gdzie panel ma zastosowanie.
7. Build/runtime wyłącznie w grupie Compose izolowanego checkoutu, z receiptami.
   Diagnozowana sesja użytkownika nie służy do testów mutujących.
8. Review, commity etapów, push, PR do master, wymagane kontrole, merge,
   lokalny fast-forward, weryfikacja integracji oraz kwalifikowany cleanup
   zgodnie z AGENTS.md. Brakujące bramki pozostają NOT VERIFIED.

## Poza zakresem

Katalog usług chmurowych, synchronizacja między użytkownikami/komputerami,
masowy import formatów zewnętrznych, automatyczna propagacja zmian do modeli,
rozszerzanie fizyki i pozorne certyfikowanie liczb z istniejących presetów.

## Stan prac

Diagnoza kodu i odczyt UI wykonane. Przegląd builder-check zakończył się bez
istotnych otwartych pytań. Użytkownik zatwierdził projekt 2026-11-18.
Żaden wynik testów implementacji, buildu ani kwalifikacji produkcyjnej nie
jest na tym etapie deklarowany.
