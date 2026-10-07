# Katalogi i format danych projektu

Data: 04.10.2026. Kontrakt wspólny dla Control Room i publicznego Python DSL.
Stan dowodów: implementacja w toku; bramki wymienione poniżej muszą mieć aktualne wyniki.

## Ustawienia kanoniczne

`OutputStorage` jest polityką zapisu, a nie modułem fizyki. `study.storage(...)` zapisuje ją
w `SceneDocument.study.output_storage` oraz `ProblemIR.problem_meta.runtime_metadata.output_storage`.
Eksport skryptu i ponowny import zachowują wszystkie pola.

| Pole | Znaczenie | Domyślna wartość |
|---|---|---|
| `output_dir` | Katalog wyników, względny do skryptu albo absolutny | Obok skryptu: `skrypt.zarr` |
| `temp_dir` | Katalog nadrzędny prywatnych danych tymczasowych | `.fullmag-tmp` obok katalogu wyników |
| `data_format` | Format tablic pól i tabel etapów | `zarr`; `h5` normalizowane do `hdf5` |
| `cleanup` | Usuwanie prywatnego tmp po zakończonym wykonaniu | `on_success`; również `always`, `never` |
| `existing_output` | Reakcja na zajęty katalog konkretnego wykonania | `timestamp`; również `error` |

Ścieżki nie mogą być puste, zawierać NUL ani komponentu `..`. UI wymaga ścieżek absolutnych
na hoście backendu. Runtime dodatkowo odmawia dowiązań i Windows junction/reparse points
w ścieżkach objętych własnością i sprzątaniem. Wybrany przez użytkownika katalog nadrzędny
nigdy nie jest celem rekursywnego usunięcia.

## UI i baza ustawień

`GET /v2/platform/output-storage` zwraca `output_parent`, nullable `temp_parent`, format,
cleanup, collision policy oraz rzeczywiste `supported_formats` i przyczynę braku HDF5.
`PUT` zapisuje defaults w istniejącym SQLite workspace (`output_storage.defaults.v1`).
Brak wcześniejszego wpisu daje projekty pod skonfigurowanym storage hosta, a w instalacji
samodzielnej pod użytkownikowym katalogiem stanu Fullmag. Błąd lub read-only bazy jest
jawnym błędem; nie zastępuje się zapisu pamięcią procesu ani localStorage.

Nowa symulacja otrzymuje edytowalną nazwę, folder z nazwą i czasem utworzenia,
konkretny katalog wyników i temp. Podgląd pokazuje skuteczne ścieżki.
Formularz przekazuje politykę w `POST /v2/sessions`; opcjonalnie zapamiętuje defaults
po ACK. Błąd późniejszego zapisu defaults/archiwum nie uruchamia ponownego tworzenia sesji.
Zastąpienie aktywnej symulacji albo dirty dokumentu wymaga jawnego zaznaczenia potwierdzenia.
Natywny wybór katalogu jest osobnym adapterem desktopu; przeglądarka wpisuje ścieżkę hosta.

Dokument projektu `.fms` zachowuje scenę, skrypt i politykę, a nie zastępuje katalogu
wyników. Nowy dokument jest przygotowywany w pamięci po utworzeniu sesji; jego trwały Save
pozostaje osobną czynnością użytkownika.

## Python i CLI

```python
import fullmag as fm

study = fm.study()
study.storage(fm.OutputStorage(
    output_dir="wyniki.zarr",
    temp_dir="tmp",
    data_format="zarr",
    cleanup="on_success",
    existing_output="timestamp",
))
```

Zwykłe `fullmag skrypt.py` bez ustawień zapisuje pierwsze wykonanie do `skrypt.zarr`
w katalogu skryptu. Ponowne wykonanie nie kasuje poprzednich danych: wybiera świeżą nazwę
z identyfikatorem wykonania albo zatrzymuje się przy `existing_output="error"`.
Dla HDF5 bez jawnej ścieżki używa katalogu `skrypt.results`; faktyczne pliki etapów mają
rozszerzenie `.h5`. Flagi `--output-dir`, `--temp-dir`, `--data-format`, `--temp-cleanup`
i `--existing-output` mają pierwszeństwo przed polityką skryptu, a ta przed defaults.
W notebooku/REPL bez pliku źródłowego punktem odniesienia jest bieżący katalog.

Bezpośrednie obniżanie dokumentu sceny do ProblemIR nie ma oryginalnego pliku
źródłowego. Techniczny `scene_document.py` używany do odtworzenia DSL nie może
ustalać nazwy katalogu wyników. Ta trasa zachowuje `output_storage_source_dir`,
lecz pomija `output_storage_source_stem`; istniejący konsument Python-core
wybiera wtedy bezpieczny komponent z nazwy modelu przez `storage_slug`. Jawne
`output_storage.output_dir` zachowuje pierwszeństwo. Skrypt wczytany z pliku
nadal zachowuje własny basename. Kontrole porównujące fizyczne IR wyłączają
różnice źródłowego basename dopiero po osobnym sprawdzeniu tego kontraktu.

Requested policy pozostaje niezmieniona w `output_storage`. `resolved_output_storage`
rejestruje pełne skuteczne ścieżki, prywatny tmp, format i identyfikator wykonania;
`output_storage_source_dir` wyjaśnia bazę ścieżek względnych. Nie używa się zmiany globalnych
zmiennych `TMPDIR`/`TEMP` do sterowania równoległymi wykonaniami w procesie Pythona.

## Format i próbkowanie

Wybrany format steruje istniejącymi writerami `StageAutosaveIR`: Zarr zapisuje tablice
Zarr v2, HDF5 zapisuje rzeczywiste datasety HDF5. HDF5 wymaga skompilowanej możliwości
`stage-autosave-hdf5`; backend bez tej funkcji odmawia przed wykonaniem, a UI wyłącza opcję.
Nie interpretuje się rozszerzenia katalogu jako dowodu formatu danych.

Jawna polityka autosave zachowuje schemat, cadence i target. Konflikt jej formatu
z formatem projektu jest błędem. Dla nowych polityk etapów time evolution/relaxation
powstaje primary writer przed planowaniem. Istniejące cadence pól i tabel są zachowane;
bez cadence time evolution zapisuje pole magnetyzacji na początku i na końcu, a relaksacja
stosuje przyjęte stany co 100 kroków oraz istniejący zapis stanu końcowego. Nie zmienia to
kroku integratora, warunku stop ani jednostek obserwabli. Domyślny format danych nie
ustanawia nowego zegara próbkowania dla eigensolve, frequency response ani hysteresis;
pozostają ich odrębne kontrakty. Metadane, logi i zgodnościowe JSON/CSV nadal mogą
współistnieć z tablicami naukowymi.

## Worker, publikacja i sprzątanie

CLI/Python rezerwuje nowy katalog wyników atomowo. Worker zaakceptowanego badania UI
zachowuje prywatny katalog attempt, immutable receipts i CAS jako źródło prawdy.
W wybranym katalogu projektu grupuje wyniki według `run_id` i etapu/ownership epoch.
Writer zapisuje do prywatnego tmp; po zakończeniu i dołączeniu writerów publikuje
finalne pliki przez create-new i sync, przed trwałym potwierdzeniem ukończenia workera.
Odłożone lub utracone potwierdzenie nie upoważnia do ponownego uruchomienia solvera. Błąd przygotowania storage po rezerwacji prywatnej próby zapisuje immutable `worker_prelaunch_failed.v1.json` z dokładną identity; recovery rozpoznaje go jako znany błąd przed uruchomieniem solvera.

Prywatny tmp ma nieprzewidywalny token, marker własności i ograniczony dostęp: Unix mode `0700`, a na Windows chroniony DACL dla właściciela oraz SYSTEM. Preflight nie tworzy katalogów i porównuje ścieżki po normalizacji komponentów oraz istniejących prefiksów. Sprzątanie sprawdza pełną
kanoniczną ścieżkę, bezpośredniego parenta, run ID, marker, active reservation oraz brak
reparse points w całym drzewie. `on_success` zachowuje tmp po błędzie/anulowaniu;
`always` usuwa go po obserwowanym zakończeniu również z błędem; `never` zachowuje.
Przerwany lub niejednoznaczny proces pozostawia tmp do rozpoznania, także przy `always`.
Wyniki, logi, CAS i katalog nadrzędny nigdy nie są usuwane przez cleanup tmp.

## Mapa implementacji i bramki

- `packages/fullmag-py/src/fullmag/model/output_storage.py`, `world.py` oraz runtime
  projection: publiczny model, skrypt i Python/SceneDocument/IR round-trip.
- `crates/fullmag-ir/src/output_storage.rs` i `fullmag-authoring`: typowana polityka i walidacja.
- `crates/fullmag-runner/src/project_storage.rs`: rezerwacja, resolved receipt, lifecycle tmp,
  format i publikacja. `fullmag-cli` i `fullmag-py-core`: właściciele wykonania.
- `crates/fullmag-api/src/router_v2/handlers/platform/output_storage.rs`: SQLite defaults;
  `accepted_project_storage.rs`: wyjście workera z zachowaniem immutable attempt.
- `apps/control-room/src/kernel/layout/NewProblemDialog.tsx`, typed facade i resource hook:
  formularz, podgląd i stany ACK/błędów. `apps/desktop`: picker katalogu.

Wymagane dowody: interpreted Python contract round-trip, produkcyjna kontrola typów
bez testów jednostkowych, lint, produkcyjna fixture przeglądarkowa (motywy, wąskie okno,
klawiatura, ścieżki, defaults i pojedyncze tworzenie po ACK), managed Rust source/codegen
oraz bezpieczna próba runtime zapisu/sprzątania. Nie kwalifikuje to fizyki, GPU, natywnego
FEM ani wydania HDF5. Kompilowanie testów jednostkowych pozostaje zabronione przez użytkownika.
