# ADR 0048 — magazyn runów zainstalowanego produktu Windows

Status: accepted; implementacja źródłowa, runtime Windows NOT VERIFIED.
Data: 02.10.2026.

## Kontekst i decyzja

Instalacja Fullmaga nie jest checkoutem źródeł. Nie posiada identyfikatora
worktree ani markera magazynu developerskiego. Dotychczas API bez tych
danych nie udostępniało trwałego Submit, mimo wybranego katalogu stanu użytkownika.

Faktyczny executable API w natywnym pakiecie Windows wybiera magazyn
`<runtime_state_root>/runs/session-store`, jeżeli wszystkie zmienne
`FULLMAG_PROJECT_STORAGE_ROOT`, `FULLMAG_RUNS_ROOT`, `FULLMAG_WORKTREE_ID`
są nieobecne. Katalog stanu jest zamrożony przy starcie zgodnie z ADR 0047:
domyślnie dane użytkownika Fullmaga, albo jawne absolutne `FULLMAG_STATE_ROOT`.
Sam `FULLMAG_REPO_ROOT` ani marker w dowolnym katalogu nie ustanawia tej trasy.

Choćby jedna ustawiona zmienna magazynu developerskiego wybiera wyłącznie
dotychczasową walidację resolvera. Niepełna, pusta lub niepoprawna konfiguracja
nie przełącza zapisu do danych użytkownika. Checkout i Linux bez konfiguracji
nie uzyskują nowego fallbacku.

## Granice i konsekwencje

Ta decyzja rozszerza ADR 0030 tylko o magazyn runów zainstalowanego produktu.
Buildy, cache i developerski runtime nadal korzystają z resolvera projektowego.
Nie zmieniamy jego fizycznego rootu ani nie tworzymy fikcyjnego worktree.
Magazyn runów pozostaje oddzielny od `local-live/session-store` i przenośnego `.fms`.

Ścieżka magazynu produktu musi być absolutna, poza katalogiem instalacji,
bez `..` oraz istniejących symlinków/reparse points w przodkach i katalogach
runów. Sam wybór nie tworzy katalogów. `SessionStore` nadal wymusza lokalny
filesystem, integralność CAS i lease pojedynczego writera; wybór ścieżki nie
kwalifikuje durability ani nie omija odmowy nieobsługiwanego filesystemu.
Istniejący model zakłada zaufanych lokalnych właścicieli katalogów; walidacja
przed otwarciem nie ustanawia izolacji przed złośliwym równoległym procesem.

Nie zmieniamy Python DSL, ProblemIR, fizyki, OpenAPI, wyboru CPU/GPU ani
provenance runów. Scheduler i workery otrzymują ten sam przypięty store root.

## Weryfikacja i rollback

Zmiany: `run_intent_persistence.rs` i inicjalizacja `AppState` w `main.rs`.
Regresje obejmują nowy katalog bez efektów ubocznych, brak tożsamości pakietu,
niepełne środowisko, rozbieżność instalacji, overlap i link w katalogu runów.
Kompilacja testów jednostkowych pozostaje wyłączona na polecenie operatora.
Parser/formatowanie/review są kontrolą źródeł, nie dowodem uruchomienia.

Wymagane pozostają: natywny build Windows, clean install, Submit, rzeczywisty
run, ponowny start i odczyt tych samych tożsamości oraz fault/recovery na
obsługiwanym lokalnym filesystemie, bez Docker/WSL/Linux. Rollback wyłącza
admission tej trasy, zachowując istniejące dane; nie przenosi i nie usuwa runów.
