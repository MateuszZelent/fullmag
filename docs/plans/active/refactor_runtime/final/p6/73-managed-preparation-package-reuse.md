# P6 / P4 — przygotowanie FEM z gotowego pakietu managed

Data: 02.10.2026. Status: implementacja źródłowa, runtime **NOT VERIFIED**.
Pełny cel P0–P8 pozostaje aktywny; nie zwiększono procentów.

`verify_accepted_fem_preparation_runtime.py` ma dodatkowy tryb
`--managed-build-run-root`, wzajemnie wykluczający się z legacy `--build-root`.
Nowy tryb nie wykonuje CMake ani Cargo. Wymaga storage root, pełnego commita
i native source snapshot SHA-256. Windows odrzuca bezpośrednie uruchomienie
linuxowego pakietu; nie uruchamia WSL ani nie podstawia lokalnego binarium.

Wspólny konsument `managed_fem_runtime_package.py` kontroluje:

- terminalny coordinator receipt, state succeeded, integer exit code 0,
  profil `fem-cpu-release` i zgodność job/source/image z trusted context;
- dokładny zestaw hashów trusted documents, clean native snapshot zgodny
  z oczekiwanym commitem i digestem;
- pełny kontrakt artefaktów przez istniejący `validate_build_receipt`,
  w tym wymagane accepted-runtime binaries, rozmiary i hashe;
- właściwy alias CLI `fullmag-bin`, wymagane executables przygotowania
  i kanoniczną grupę `libfullmag_fem.so`, `.so.0`, `.so.0.1.0`, zgodną
  z CMake VERSION/SOVERSION i zawierającą te same zahashowane bajty;
- niezmienność dokumentów podczas kontroli, a po scenariuszu ponownie
  wszystkie artefakty i tożsamość pierwotnego pakietu.

Prywatny output znajduje się pod zadeklarowanym storage i nie może nachodzić
na katalog pakietu. Stan/logi powstają w nowym invocation root; trwały store
w `storage_root/runs/accepted-fem-preparation-<UUID>/session-store`, zgodnie
z kontraktem `configured_submit_store_root`. Sprawdzany jest marker storage,
jego project root, położenie checkoutu i rozdzielenie storage od checkoutu.
FULLMAG_PROJECT_STORAGE_ROOT oraz FULLMAG_REPO_ROOT są jawne.
Provenance buildu pozostaje oddzielne od fingerprintu źródeł drivera;
nie przypisujemy gotowemu binarium późniejszego HEAD repozytorium.
Środowisko nowej trasy wymusza zadane FEM CPU i wyłącza managed GPU runtime.
Powstaje od zera: stały PATH, locale i prywatny HOME; nie dziedziczy
LD_PRELOAD, LD_AUDIT, LD_LIBRARY_PATH ani hostowych FULLMAG overrides.
LD_LIBRARY_PATH wskazuje wyłącznie sprawdzony katalog bibliotek pakietu.

Scenariusz nadal wykonuje publiczne Submit/materialization, preparation pool,
preparation scheduler, native preparer, durable lease/launch/exit i publiczną
projekcję gotowości. Kończy się na dependency resolution. **Nie jest jeszcze
pełnym accepted FEM solver driverem ani dowodem snapshot/pin/archive.**

## Dowody

23 interpretowane testy nowego konsumenta/trasy i 32 dotychczasowe regresje
archive drivera: **55 PASS**, exit 0 (aktualny moduł: 23 PASS; niezmienione
regresje archive: 32 PASS). Nowe fixtures sprawdzają pełny receipt
contract, odrzucenie queued/failed, boolean exit, obcego profilu/źródeł,
zmienionych hashów i wymaganych plików, brak digestów źródeł/obrazu mimo
zgodności rekordów, brak native library, błędne nazwy
executables oraz zmianę dokumentu w trakcie kontroli. Odrębny przypadek
zatrzymuje scenariusz przed pierwszym procesem i potwierdza brak kompilacji
oraz jawne środowisko CPU bez obcych loader paths. Fixture executables nigdy nie są wykonywane.
Regresja granicy startu procesu sprawdza też canonical runs root i jawne
storage/repo env; błędny marker/project/worktree jest odrzucany bez zapisu runów.
CLI parser/help i scoped diff checks PASS; testów Rust nie kompilowano.

Job 210 (`c4311c015f624b7087dea436064d8a99`) pozostaje osobnym wejściem;
bieżący odczyt wskazuje RUNNING, exit code null. Nie użyto niegotowego
pakietu ani nie utworzono zastępczego wyniku. Sesja 3104 zachowana.

## Następne bramki

Po terminalnym odbiorze pakietu: zarządzana trasa Linux z właściwym obrazem,
preflightem storage i końcowym receiptem tego scenariusza. Nowy tryb CLI nie
jest jeszcze podłączony do dedykowanego managed runtime wrappera; ta bramka
pozostaje **NOT VERIFIED**. Istniejąca recepta legacy z lokalnym buildem nie
stanowi zezwolenia na obejście kolejki na obecnym hoście.
Wrapper musi sprawdzić rzeczywisty image digest z inspekcji kontenera względem
receiptu buildu; sam hash biblioteki Fullmag nie kwalifikuje systemowych
zależności MFEM/HYPRE/MPI ani ABI runtime.

Następnie pełny solverowy CPU pool i accepted scheduler/worker, ścisłe
execution provenance, native snapshot/local node map/geometry, typed outputs,
SolutionSet i pin. Dopiero rzeczywisty accepted wynik jest wejściem P6-60/P6-61.
HTTP/CAS, archive roundtrip, browser z realnym backendem, nauka, pozostałe lane
i wydanie Windows pozostają otwarte.
