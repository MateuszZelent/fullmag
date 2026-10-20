# Idempotentny start Docker DEV

Cel: `just docker-dev` rozpoznaje istniejącą, należącą do wybranego checkoutu grupę. Przy zgodnych źródłach używa działającej aplikacji; zmiana źródeł uruchamia kontrolowany restart i istniejący przyrostowy build backendu. Zatrzymane usługi są wznawiane na podstawie przypiętej konfiguracji. Dane użytkownika i cache pozostają zachowane.

1. Rozpoznanie grupy: odczyt dokładnych etykiet, aktualnej próby, kanonicznego SHA Compose i kontenerów. Odmowa dla obcego checkoutu, zmiany portu/profilu lub niejednoznacznych dowodów. Bez automatycznego kasowania kontenerów ani znaczników blokad.
2. Decyzja: nowa grupa → istniejący start; działająca zgodna grupa → ponowne użycie; zmiana źródeł → istniejący restart z idle/drain; zatrzymana grupa → przypięte wznowienie. Backend przy starcie sam kwalifikuje istniejący pakiet i kompiluje tylko wymagane zmiany. Zmiany obrazu wymagają osobno kwalifikowanego odtworzenia; nie wolno uruchamiać starego helpera jako nowego.
3. Skrypt: po zdrowym starcie aktywacja istniejącą ścieżką z request fence. Nie ponawiać historycznego Solve. Nieznany wynik wcześniejszej aktywacji pozostaje blokadą wymagającą odzyskania.
4. Weryfikacja: interpretowane regresje decyzji lifecycle, stany running/stopped/busy/foreign, niezmienione i zmienione źródła, obsługa skryptu i blokady unknown. Bez kompilacji testów Rust/C++. Runtime oddzielnie: aktualna grupa master jest zatrzymana z nieznanym wynikiem historycznej aktywacji, więc nie stanowi dowodu poprawnego startu nowego launchera.
5. Dostarczenie: review, scoped commit, CI zgodne z uprawnieniami, PR/integracja, zachowanie lokalnej pracy głównego checkoutu i rejestr blokad.

Baza: c322c199c077e37d6cd18ebca39da55ff66b17c4. Worktree: docker-dev-up-20261020. Owner: codex-root.


Doprecyzowanie uzytkownika: domyslne wyniki .zarr/.h5 obok pliku wejsciowego.
Nalezy zachowac jawna OutputStorage, zadeklarowac osobny RW output bind bez
zmiany readonly source i bez przenoszenia build-data na hosta. Przeplyw
Python/IR/accepted worker oraz start i pozniejsza aktywacja skryptu wymagaja
wspolnej polityki. Istniejace sesje/wyniki nie sa migrowane ani nadpisywane.

Kolejne doprecyzowanie: wspolny zapis save/autosave/tableautosave oraz
domyslne `model.fms` obok `model.py`, z pierwszenstwem jawnego wyboru.
Weryfikacja obejmuje kanoniczny zapis sesji i zachowanie sciezek host/guest.


## Checkpoint 20.10.2026 — review i CI

- `063463ec83e0b6c68a4677756bd769cf64e3a82e`: osobny, jawny alias wyników; konfiguracja operatora; wyłączenie wygenerowanych wyników z tożsamości źródeł. Windows: 24 testy konfiguracji/mapowania/ownership, w tym jeden pominięty POSIX; Linux: 11 testów źródeł i granicy idle-stop/runtime-state, PASS.
- `156f2c91b91bdd3bbe175eff0217a2c802b4719e`: backendowy Save State `.fms` i osobny Export State. Review bez Required/Blocker, parser Rust PASS. Testy Rust i frontend oczekują na zatwierdzone CI; nie są dowodem lokalnego runtime.
- `d48aba9d4d77afa656a836677a29c5d7e7fe5f93`: binding wyników w runtime metadata przed materializacją accepted execution, bez modyfikacji SceneDocument. Review bez Required/Blocker, parser Rust PASS; testy wykonywalne oczekują na CI.
- Draft PR: https://github.com/MateuszZelent/fullmag/pull/204. CI/codegen są uruchomione. Wygenerowane artefakty API zostaną zapisane z rzeczywistego wyniku generatora.
- Zapis filesystem Docker Desktop w zatwierdzonym `examples`: write/fsync/atomic-no-replace PASS, receipt `docker-volume://fullmag-build-control-fullmag-master-a7f7e9b9a4026499/verification/script-output-filesystem-ab7d03a6de7c42ddb1e66cab8a9d8fa7.json`.
- Runtime `fullmag-master`: NOT VERIFIED. Wcześniejsza aktywacja `3806b5f55dc1406db941b6e0a142e962` zachowuje stan `outcome-unknown-resources-retained`; brak terminalnego dowodu. Nie usunięto blokady, kontenerów ani danych. Ta blokada nie jest błędem testu nowego kodu i wymaga odrębnego potwierdzonego recovery.
- Nie uruchomiono ciężkiego buildu i nie utworzono nowych technicznych danych builda. Lekka próba filesystem usunęła wyłącznie własny katalog tymczasowy. Brak skilla `fullmag-build-stage-cleanup`; nie kwalifikowano cudzych cache ani wolumenów do usunięcia.

- Etap lifecycle zapisany w `382855008` i sprawdzony na Windows (53/53). Po scaleniu aktualnego mastera `2201c95ae1822e30818a2f1a1c94c8b0e3820133` w commicie `5086b22ee`: 62/62 testy dotkniętych granic PASS, parser Rust PASS.
- Codegen CI run `39342087637`, job `118365816879`, artifact `12229971250` (`generated-api-contract-39342087637`) dostarczył rzeczywiste JSON/types/client z nowymi polami Save State. Zmieniły się wyłącznie JSON i typy; client pozostaje identyczny. Pierwsze czerwone frontend gates zgłosiły wyłącznie brak tych wygenerowanych pól; nie jest to wynik końcowych źródeł.
