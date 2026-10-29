# Naprawy materiałów i granic — 2026-10-29

Baza: e6a58cc7b12bc92b96c271cacb4cd1e19118659e. Branch codex/material-boundaries-p1-20261029, owner 01a18732-767d-7431-b30e-337c3f4310a8. Cudze niezacommitowane zmiany głównego checkoutu pozostają nietknięte. Baza integracji: master `82a43e62041c1e7f2a1e6bf311aaae7449240931`; merge `49654b8e2410be8dbc31eadd57daca479177efae`. Odziedziczona lokalna zmiana build-control została wyłączona z diffu PR, bez edycji głównego checkoutu.

## Kontrakt przed implementacją

Właścicielem fizyki pozostaje docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md. To wewnętrzna nota poprawki, nie terminalna strona naukowa ani nowy model fizyczny.

- A1/A2: draft Inspectora zachowuje zera i nieedytowalne profile/parametry w oryginalnej postaci. Zmiana nazwy nie zmienia fizyki. Dane należą do draftu, bez nowej persistencji/store.
- A3: h w metrach pochodzi z geometrii próbkowania. FDM: najmniejszy fizyczny wymiar komórki, także osi z jednym elementem. FEM: najmniejsza dodatnia odległość euklidesowa do innego węzła współdzielonego elementu. Przy granicy to minimum otoczenia elementowego. Skala jest lokalna, niezmiennicza względem obrotu/translacji, niezależna od niepołączonych węzłów. Szerokość nadal cells*h; smoothstep/scope bez zmian. Brak skończonego dodatniego h dla mesh_relative daje jawny błąd, bez zamiany na sharp. Sharp/metric nie wymagają h.
- A4: globalne latest_fields bez provenance assignmentu nie są realizacją lokalnego pola. Bez scoped assetu API zwraca pending i puste próbki. Sampled asset musi pasować do owner, region, parametru i żądanego ID.
- A5: MagnetHandle odrzuca nieobsługiwane publiczne atrybuty zamiast je milcząco pomijać. Nie rozszerza to capability solverów.

## Dowody

Regresje: UI zero/linear/radial/unknown; lokalna skala rotacja/refinement/disconnected/invalid; API owner/asset/pending; Python unknown attr i zachowanie wspieranych parametrów. Osobne noty [FDM](material-boundaries-fdm-20261029.md) i [FEM](material-boundaries-fem-20261029.md) dokumentują pozostałe wyzwalacze audytu. Są wewnętrznym zapisem implementacji i testów, nie nowymi kanonicznymi publikacjami naukowymi.

Stan bieżący w tabelach poniżej. Użytkownik jawnie zezwolił na kompilowanie i uruchamianie testów tego zadania; wcześniejszy repozytoryjny zakaz nie blokuje tej weryfikacji.

## Checkpoint 1 — authoring Python

Commit `7c0f11db366dafb4d2098157179790cf70a00f64`: odrzucanie nieeksportowanych atrybutów MagnetHandle. RED: sześć podprzypadków nie zgłaszało AttributeError. GREEN: 2 testy unittest oraz 12 istniejących testów execution_context/region_material_transition. Polecenia użyły Python -B, bez kompilacji solvera.

Grupa weryfikacyjna: `fullmag-worktree-fullmag-033f6660666cdc47`, frontend port 3356. Kontenery innych zadań pozostały nietknięte.

## Zakres zamkniętych wyzwalaczy audytu

| ID | Priorytet | Naprawa i granica kontraktu |
|---|---|---|
| A1 | P1 | Nullish fallback zachowuje Aex=0 i alpha=0; ujemne Ku1 pozostaje dozwolone. |
| A2 | P1 | Linear/radial, nieobsługiwane parametry/polityki i nieskalarne wartości pozostają w drafcie i PATCH bez spłaszczenia; UI oznacza je readonly. |
| A3 | P1 | Lokalna fizyczna skala próbkowania FDM/FEM zastępuje globalną najmniejszą różnicę współrzędnych; brak poprawnego h daje błąd mesh_relative. |
| D1 | P1 | Redukcja Aex do stałej stosuje tolerancję względną 64 epsilon, zachowując zmiany poniżej 1e-12 J/m. |
| D2 | P1 | Resolver otrzymuje translację właściciela. Testy sprawdzają pola Object/World, radial i nadpisanie regionu po translacji. |
| D3 | P1 | DMI lokalne dla ciała blokuje scaloną siatkę CUDA na styku X/Y. Planner i runner zgodnie wybierają istniejącą ścieżkę assisted oraz jej budżet pamięci. |
| F1 | P1 | Aktywne ramy kubiczne wchodzą do porównania materiałów, także przy kc*_field. Jedna aktywna rama może zostać promowana; odmienne aktywne ramy są odrzucane z powodu ograniczenia ABI. |
| F2 | P1 | Kanoniczne ID ma pierwszeństwo przed nazwą; niejednoznaczne aliasy i próba użycia nieaktywnego ID są odrzucane. Ten sam resolver obsługuje klasyfikację i DG0. |
| F3 | P2 | Wspólna ściana różnych obiektów magnetycznych jest odrzucana przed błędnym pakowaniem faset. Magnet–powietrze oraz regiony jednego obiektu pozostają dozwolone. To nie implementacja nowego kontraktu kontaktu. |
| A4 | P2 | API nie etykietuje globalnych próbek jako lokalnego assignmentu. Wymaga jawnego sampled asset oraz zgodności owner/region/parameter/ID; w przeciwnym razie pending. |
| A5 | P2 | Python odrzuca nieeksportowane publiczne atrybuty MagnetHandle zamiast cicho ignorować zmianę. Nie dodaje nowych capabilities materiałowych. |

## Wykonana weryfikacja źródeł i regresji

- Python: 2 nowe testy (6 przypadków nieobsługiwanych atrybutów) oraz 12 dotychczasowych testów execution context / region transition PASS. Dla nowego guardu zarejestrowano rzeczywiste RED przed zmianą i GREEN po niej.
- Planner: `cargo test --locked -p fullmag-plan --lib` — **609 PASS**, w tym 15 nowych regresji materiałów/granic. Na dokładnej bazie `e6a58cc7b12bc92b96c271cacb4cd1e19118659e` odtworzono **583 PASS / 11 FAIL**. Przyczyną starych błędów były fixture anten bez wymaganych target_refs i oczekiwania na dwie elektrody przy czterech zdefiniowanych. Naprawy testów zachowują pełne asercje i są osobnym commitem `5f3af3a2553c93a188f97805bb96cbb08764bc6d`.
- CUDA runner: `cargo test --locked -p fullmag-runner --no-default-features --features cuda --lib cuda_interfacial_dmi_xy_body_contact -- --nocapture` — **2 PASS**. Urządzenie RTX 4080 SUPER; wykonano oba kierunki styku, nie skip. Zakres FP64/RK4, lokalne DMI bez demagnetyzacji i wymiany, existing assisted lane. Nie kwalifikuje pełnego natywnego DMI ani FEM GPU.
- API: `cargo test --locked -p fullmag-api --no-default-features --features cuda --bin fullmag-api material_field -- --nocapture` — **7 PASS**, w tym pozytywne assety pamięciowe/plikowe i odrzucenie przypisania globalnych próbek regionowi.
- UI po integracji master: pełny suite **9273 PASS**, typecheck PASS i lint PASS. Ustawiono `FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source`, aby testy kontraktów między aplikacjami mogły czytać właściwe źródła. Wcześniej focused model/DOM: **27 PASS**.
- Przeglądarka: focused fixture scenario materiałów oraz istniejące kontrole Object/Airbox — PASS; szczegółowy zakres, źródła i ograniczenia w [raporcie przeglądarkowym](material-boundaries-browser-20261029.md). Pełny smoke przeglądarkowy pozostaje NOT VERIFIED.
- React Doctor 0.9.12: aktualne cztery pliki względem `5f3af3a2553c93a188f97805bb96cbb08764bc6d`, complete, **newCount=0**. Dwa istniejące ostrzeżenia pozostają poza zakresem; nie dodano tłumień. Root hook nie wykrywał aplikacji Next; skan wykonano ponownie we właściwym zakresie przez przypięte narzędzie w Docker.
- `scripts/ci/contract_guard.sh --strict` oraz `git diff --check`: PASS.
- CI ujawniło brak `namespace_registry` w makiecie `_Control` testu retained pre-admission. Test i jego kod produkcyjny były identyczne z bazą master; odtworzono 5 błędów w 13 testach. Dodanie pola `None` zgodnego z rzeczywistym kontraktem makiety dało 13 PASS bez zmiany asercji ani kodu produkcyjnego. Druga zastana makieta preflight frontendu nie zawierała `files` i używała starego klucza cache. Uzupełniono wejście, klucz i etykiety według obecnego kontraktu, zachowując test odrzucenia driftu: 31 PASS. Dalsze 20 skryptów tego samego kroku CI: 399 testów PASS.

Kompilacja i testy Rust/TypeScript odbyły się w kontenerach własnej grupy. Po integracji powtórzono planner 609, CUDA 2, API 7 oraz Python 14 testów / 6 subtests; wszystkie PASS. Target i pełne logi pozostają w wolumenach Docker: `/build/material-audit-target`, `/build/material-audit-plan.log`, `/build/material-audit-plan-baseline.log`, `/build/material-audit-cuda.log`, `/build/material-audit-api.log` oraz odpowiadające im pliki `*-integrated.log`. Pełny log UI: `/state/development/material-audit-vitest-integrated.log`. Dane innych grup, sesji i dirty main checkout nie były zmieniane.

## Integracja i pozostałe granice dowodu

Stan PR, wynikowy commit oraz ewentualną blokadę aktualizacji lokalnego master zapisuje rejestr worktree zadania. Ten raport opisuje zweryfikowane źródła, a nie wdrożenie końcowego pakietu API.

Naukowa zbieżność wszystkich oddziaływań, wykonanie FEM CPU/GPU, pełny zakres precyzji/integratorów i produkcyjna kwalifikacja pozostają **NOT VERIFIED**. Ograniczenia ABI i strażniki capability opisane powyżej są jawne; nie zastąpiono ich przybliżeniem lub cichym fallbackiem.
