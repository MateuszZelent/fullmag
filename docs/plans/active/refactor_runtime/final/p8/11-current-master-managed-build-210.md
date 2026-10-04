# P8-C / P6 — managed build bieżącego mastera, zadanie 210

Data: 02.10.2026. Stan: **SUCCEEDED / exit 0 — build PASS**.
Pełny cel P0–P8 aktywny. Master oznacza wersję przypiętą przy zgłoszeniu,
nie późniejsze commity drivera ani poprawki katalogu danych Windows.

Zlecono istniejącemu Fullmag_build_runner produkcyjny build profilu
`fem-cpu-release` z niezmiennego commita:

| Tożsamość | Wartość |
|---|---|
| Source commit | `8beacd295cb295d2460e55606dabff39f4aa7f77` |
| Sequence / job | `210` / `c4311c015f624b7087dea436064d8a99` |
| Request key | `6f4b401d5b054905a3a7283da8dd548b` |
| Capture | `6c90a7bd7ef34c09bad97cab5fabf206` |
| Capsule source digest | `a707355d44dce76c97ca8f2ea7eca5620c66b040fa35a7b78abc50b6871ce92e` |
| Native source snapshot SHA-256 | `98bf2ebd06d26cb6d9bb22e6d288e8d41c4a5b88491bd18d3ccc628f29abdaa2` |
| Snapshot | `source_snapshot_dirty=false`, brak dirty paths |
| Ostatni odczyt | `succeeded`, exit code 0 |

Dirty zmiany głównego checkoutu nie są wejściem tego buildu. Terminalny
receipt i artefakty odebrano bez restartu lub ponownego zgłoszenia zadania.
Nie kompilujemy testów jednostkowych: profil wykonuje produkcyjne
`make install-cli-dev`, instalację zależności frontendu i `make web-build-static`.

## Terminalny odbiór

Kontener db5743b6a4c1 zakończył się z ExitCode=0, OOMKilled=false,
FinishedAt=2026-10-02T20:55:18.94153597Z. Kolejka przez krótki czas nadal
pokazywała RUNNING podczas końcowej walidacji; nie traktowano tego jako
powodu restartu. Koordynator następnie opublikował terminalny receipt.

| Dowód | Wynik |
|---|---|
| native-build | exit 0 |
| frontend-dependencies | exit 0 |
| frontend-build, TypeScript i static export | exit 0 |
| validate_build_receipt | 122 artefakty, 291 682 519 B, wszystkie rozmiary/hashe PASS |
| verify_source | niezmienna kapsuła commit/source digest PASS |
| managed_fem_runtime_package.load_package | terminalny receipt, trusted hashes, dokładny commit/snapshot, 8 wymaganych binariów i 3 aliasy biblioteki FEM PASS |
| build-receipt SHA-256 | `73f5d210bb43a0bf535b890a002ddf2a7498bccbd7ab81a2aa60053c80057231` |
| coordinator receipt SHA-256 | `38d716f91b01caeb98024b35d4889b4ea6cb004069ebd5832c841382780862ec` |
| pinned image | `sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d` |

Zweryfikowane binaria: fullmag-api, fullmag-api-preparation-resource-pool,
fullmag-api-accepted-fem-preparer, fullmag-api-accepted-fem-preparation-scheduler,
fullmag-bin, fullmag-api-resource-pool, fullmag-api-accepted-scheduler
i fullmag-api-accepted-worker. Receipt jest w kanonicznym storage pod
runs/fullmag-0950f4dca4ffe38f/c4311c015f624b7087dea436064d8a99.

To dowód produkcyjnego buildu Linux FEM CPU i gotowego wejścia drivera.
Nie uruchamia solvera, nie kwalifikuje fizyki ani Windows. Wykryte wcześniej
v9fs na hostowym bindzie nadal blokuje writer SessionStore; nie provisionowano
wolumenu i nie omijano guardu. Runtime wrapper oraz rzeczywisty solver/pin/archive
pozostają otwarte. Sesja 3104 zachowana.

## Klient i stan wspólnej kolejki

Klient z mastera odrzuca bieżącą konfigurację jako `Container profile
allow-list mismatch`: konfiguracja zawiera także `fem-cpu-slepc-runtime-v2`.
Nie zmieniono ani nie zmniejszono allow-listy.

Zgodnie z dopuszczoną trasą istniejącego klienta użyto skryptu z
zarejestrowanego worktree `eigensolve-dispersion-plan-20260912`, HEAD
`5fa251fb184f31ac39144afda082af5b0fddcbef`. Dwa pliki klienta nie miały
lokalnych zmian; rejestr potwierdził właściciela i aktywne zadanie.
Źródła buildu wskazano osobno jako główny checkout i powyższy pełny SHA.
Nie zmieniano globalnego safe.directory ani checkoutu tego klienta.

Health odczytany tym klientem: worker żywy, accepting_jobs=true,
worker_error=null, około 23,96 GB wolnego storage. Zadanie 209
`21f2ba8564ce47f4a1a167f374948113` innej pracy było running i pozostało
bez zmian. Nie tworzono koordynatora, nie wymieniano obrazu i nie zatrzymano
sesji 3104. Historyczny błąd capsule membership w health nie został
przedstawiony jako terminalny wynik bieżącego zadania.

## Odbiór po terminalnym wyniku

1. Sprawdzić stan terminalny 210, exit code, receipt, source identity,
   pełną listę niepustych wymaganych plików oraz hashe artefaktów. Uwzględnić
   źródłowego konsumenta kontraktu pakietu P6-68–70; nie utożsamiać starszego
   wdrożonego entrypointu z aktualnym masterem.
2. Przy sukcesie wykonać istniejące bramki accepted FEM CPU preparation/run
   i publikacji SolutionSet na rzeczywistym runtime, bez kompilacji unit tests.
   Wybrać dokładną tożsamość pakietu i prywatny store przez resolver;
   nie podmieniać sesji 3104 ani jej danych.
3. Zweryfikować materialized dataset, geometry/support, binarny odczyt HTTP
   oraz archiwum według P6-60/P6-61. Nie tworzyć syntetycznego wyniku zamiast
   brakującego accepted FEM producer. Oryginalny store pozostaje chroniony.
4. Przeprowadzić odbiór viewportu z rzeczywistym zapisanym źródłem.
   Dotychczasowe page.route fixtures nie są dowodem backend HTTP/CAS.

P6-51–65a już obejmują źródłową implementację bezsesyjnego Saved Results,
bounded wartości i jednego viewportu; nie powtarzamy tych zmian. Ich
receipty zachowują własną tożsamość i zakres.

Ten job kwalifikuje wyłącznie trasę Linux FEM CPU. Nie zastępuje natywnego
Windows, GPU, parytetu, nauki ani wydania. Native Windows executor/SDK,
aktualny uv lock/export, rzeczywisty embeddable CPython i MSI clean
install/upgrade/rollback nadal pozostają otwarte. Brak profilu Windows w
odczytanym katalogu blokuje tę trasę, bez hostowego ciężkiego fallbacku.
Procentów pełnego planu nie podniesiono na podstawie zgłoszenia do kolejki.
