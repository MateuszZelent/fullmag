# P6-64c — komplet binariów trasy accepted w pakiecie managed

Data: 02.10.2026. Baza: `350c17085953f096d116d6c4b4779f99456f05ce`.
Status: poprawka źródłowa instalacji; nowy managed build **NOT VERIFIED**.

Build 192 zawierał solver, API oraz worker/supervisor accepted, lecz pomijał
pięć programów potrzebnych do publicznej ścieżki przygotowania i wykonania.
`cargo build -p fullmag-api --release` już buduje ich targety produkcyjne.
Błąd dotyczył listy kopiowania do `.fullmag/local/bin`, nie nowego profilu.

Do instalacji i `$ORIGIN/../lib` rpath dodano:

- `fullmag-api-accepted-scheduler`;
- `fullmag-api-resource-pool`;
- `fullmag-api-accepted-fem-preparer`;
- `fullmag-api-accepted-fem-preparation-scheduler`;
- `fullmag-api-preparation-resource-pool`.

Kopiowanie zachowuje wzorzec `.new` → docelowa nazwa. Każdy błąd kopiowania,
rename lub rpath kończy nową pętlę błędem, więc brakujący program nie zostaje
cicho pominięty. Nie zmieniano profili operatora, kontenerów ani cache.

Kontrola źródeł **PASS**: pięć nazw odpowiada targetom Cargo oraz
wymaganiom driverów preparation/execution; obie pętle mają ten sam zbiór
programów i odmowę kontynuacji po błędzie. `git diff --check` **PASS**. Odbiór wymaga nowego terminalnego managed builda, weryfikacji
artefaktów pięciu programów i ich rzeczywistego użycia w accepted flow.
Samo pakowanie nie implementuje accepted FEM execution i nie zamyka
P6-60/P6-61 ani kwalifikacji naukowej.
