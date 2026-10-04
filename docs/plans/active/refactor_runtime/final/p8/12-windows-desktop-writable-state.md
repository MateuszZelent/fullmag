# P8-C / P1-D — zapis samodzielnego desktopu Windows

Data: 02.10.2026. Status: IMPLEMENTED SOURCE; runtime i wydanie NOT VERIFIED.

## Usunięte przyczyny błędu

Bez `FULLMAG_UI_URL` desktop uruchamia własne API. Dotychczas tworzył log
w `install-root/.fullmag/logs`; instalacja w Program Files mogła odmówić
zapisu jeszcze przed uruchomieniem API. Sidecar korzysta teraz ze wspólnego
`fullmag-runtime-control::python_runtime::packaged_windows_state_root`,
czyli katalogu Fullmag pod LOCALAPPDATA (lub AppData/Local pod USERPROFILE).
Jawny FULLMAG_STATE_ROOT ma pierwszeństwo, musi być absolutny i trafia również
do procesu API. Brak konfiguracji danych użytkownika w pakiecie oznacza błąd,
bez awaryjnego zapisu do instalacji lub katalogu tymczasowego.

Pakiet Windows wyprowadza lokalizację zasobów z własnego executable przed
odziedziczonym FULLMAG_REPO_ROOT. Checkout developerski zachowuje dotychczasową
lokalizację. Nie wprowadzamy Docker, Linux ani WSL jako wymagań desktopu.

Drugi błąd był w `session_persistence::session_store_root`: checkpointy,
eksport i import nadal używały repo_root/.fullmag/local-live/session-store,
mimo że start API rozwiązywał osobny writable state. Teraz używają tego samego
zamrożonego rootu co dziennik poleceń (`current_command_journal_store_root`).
Dotychczasowy fallback pozostaje dla stanu bez skonfigurowanego dziennika,
w tym istniejących izolowanych fixtures. Ścieżka nie jest ponownie odczytywana
ze zmiennego środowiska przy każdym żądaniu. Nie zmieniamy HTTP/OpenAPI,
formatu FMS, DSL, IR, fizyki ani requested/resolved execution.

## Weryfikacja

- Desktop: rustfmt --check PASS; lockfile: cargo metadata --locked --offline
  --no-deps PASS, bez kompilacji.
- Session persistence: parser rustfmt --emit stdout PASS; pełny check formatowania
  zgłasza istniejące różnice poza poprawką, których nie zmieniano.
- Scoped git diff --check PASS.
- 13 testów kontraktu wydania oraz 7 subtests PASS. To kontrola źródłowa,
  nie wykonanie desktopu ani zapis checkpointu.
- Dodano pięć regresji Rust dla explicit/relative/development state i wspólnego
  checkpoint store. NOT RUN: obowiązuje zakaz kompilowania unit tests.
- Niezależne review sidecara i routingu checkpointów: brak P0/P1.
  Namespaces journal/run/import pozostają odrębne, a writer lease nadal
  serializuje zapisy. Review nie uruchamiało runtime ani testów.

## Stan środowiska i dalsza bramka

Build 210 (`c4311c015f624b7087dea436064d8a99`) ma production native-build
exit 0; cały job nadal RUNNING, ostatnio frontend-dependencies. Ten build
pochodzi z 8beacd295cb295d2460e55606dabff39f4aa7f77 i nie zawiera tej poprawki.
Nie jest dowodem aktualnego desktopu Windows ani zakończonego pakietu.

Rzeczywisty odczyt mountów jego kontenera db5743b6a4c1 wykazał /workspace i
/artifacts jako v9fs, magic 0x1021997. Ten filesystem nie przechodzi guardu
SessionStore. Nie rozszerzano allowlisty i nie provisionowano named volume.
3104 pozostaje starą, zachowaną instancją; nie została zaktualizowana.

Resolver profilu windows-native-fdm-cpu nie znalazł fullmag-api.exe w swoim
kanonicznym cargo target. Nadal potrzebne są zarządzany natywny build Windows
i rzeczywisty pakiet: uruchomienie bez praw administratora, pusty projekt
New/Save/Open, lista checkpointów HTTP 200, checkpoint z magnetyzacją,
restart i jawne odtworzenie, clean install/upgrade/rollback. Sama poprawka
rootu nie migruje dawnych danych ani nie odtwarza sesji z pamięci.

P0–P8 pozostaje otwarte; procentów runtime lub wydania nie podnosimy na
podstawie tych kontroli źródłowych.
