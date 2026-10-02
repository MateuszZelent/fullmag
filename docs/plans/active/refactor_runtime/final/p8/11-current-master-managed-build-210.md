# P8-C / P6 — managed build bieżącego mastera, zadanie 210

Data: 02.10.2026. Stan: **QUEUED**, nie PASS. Pełny cel P0–P8 aktywny.

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
| Ostatni odczyt | `queued`, exit code null |

Dirty zmiany głównego checkoutu nie są wejściem tego buildu. Receipt
produkcyjnego buildu i artefakty jeszcze nie istnieją jako terminalny dowód.
Nie kompilujemy testów jednostkowych: profil wykonuje produkcyjne
`make install-cli-dev`, instalację zależności frontendu i `make web-build-static`.

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
