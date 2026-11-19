# Checkpoint: shared build storage, 2026-10-27

- Worktree: `/home/kkingstoun/git/fullmag/worktrees/shared-build-storage-20261027`.
- Branch: `codex/shared-build-storage-20261027`.
- Base: `38ffb49bf4f8dabfdf2b4921903c88183bb9f84e`.
- Registry worktree ID: `shared-build-storage-20261027-254985687c4b4591`.
- Owner: `codex-01a17d5e-2692-7540-95ab-b5ff7a441faf`.

## Commity etapów

1. `98cf116532f6e4ab16d32e9ddc673a89b9c0a9cb` — shared pnpm store, prywatne
   node_modules i Next, blokada instalacji powiązana z proofem końca procesów.
   Weryfikacja: 60 interpreted frontend tests; review diffu i lifecycle.
2. `d63759018d84430c3be971de5ac1d316825f2dc2` — współdzielone pakiety backendu,
   transport named volumes, Cargo cache, bezpieczna publikacja/recovery i jawna retencja.
3. `1ef18597014637a2124993e91d8c9fcfb18bb80a` — automatyczna retencja po starcie
   oraz kwalifikowane sprzątanie przy `worktree-finish completed`.

## Dowody przed integracją

- 247 tests w szerszej bramce kontraktowej: PASS, 2 platform-dependent skips.
- 88 interpreted backend tests: PASS po ostatnim marker-last cleanup.
- 19 shared store/integration/recovery tests: PASS, w tym single publisher,
  GC zachowujący current/rollback, przerwanie restore/cleanup/GC,
  recovery ready publisher/cache-hit bez fikcyjnego Make attempt.
- Root initializer: 8 tests, 1 UID65532 probe skipped na hoście nie-root.
- Zarządzane obrazy helperów: build PASS, backend image
  `sha256:5b537e4445291e8e505f98ac424b4a8f61bb76f913b2b7742a35f647fcd7c7c5`.
- Niezależne review wykryło ctime/link races i recovery building/ready/cleanup;
  poprawki i regresje dodane. Sam review nie jest qualification runtime.
- Docker UID/mount/concurrent helper proof: PASS. Dwóch publisherów tego samego
  klucza dało publisher + reuse; GC usunął cache, zachowując oba grupowe hardlinki.
  7 kontenerów i 3 syntetyczne wolumeny zostały usunięte po ponownej kontroli.
- Końcowe interpreted contracts w izolowanym Docker helperze: 371 tests PASS,
  2 platform-dependent skips; hashe źródeł przed/po niezmienne.
- W tym: 14 incremental cache tests, 11 host retirement, 7 guest retirement,
  5 finish/maintenance tests. Review source: PASS po poprawkach wyścigu plan/lease,
  Labels:null, błędnej nazwy volume i markerów archive/live.
- Pełny build/start backend+frontend na finalnym źródle: NOT VERIFIED.
- FDM/FEM CPU/GPU scientific qualification: poza zakresem tej zmiany.

## Kontrakt i ograniczenia

Zobacz [shared build storage](../guides/shared-build-storage.md). Nowe grupy
używają współdzielonych cache; zachowane stare grupy nie są samoczynnie migrowane.
Retencja pakietów i incremental działa automatycznie po gotowości zarządzanej
grupy. `finish completed` usuwa zweryfikowany prywatny cache po drain i usunięciu
kontenerów. Nie ma globalnego quota Docker ani zbiorczego usuwania danych
nieznanych/starych grup. Limit incremental nie ogranicza całego target. Zachować cudze dirty
submodules w głównym checkoutcie. PR, merge, fast-forward i cleanup własnego
worktree pozostają wymaganymi krokami domknięcia.

## CI i integracja

PR: https://github.com/MateuszZelent/fullmag/pull/285. Pierwsze CI wykryło stare
fixture cache oraz certyfikatu offline; uzupełniono wymagane pola, bez zmiany
walidatorów. Lokalnie przeszło wszystkich 59 skryptów bramki Docker storage
z workflow (łącznie z poprawionymi fixture). Końcowe kontrole PR pozostają w toku.

Końcowa bramka Python przeszła testy storage, ale wykryła brak mirroru nowego
skilla `design-taste-frontend`, dodanego równolegle do mastera w
`cc91b2550767e73f3b059ff94fdff466a77e46ef`. Zsynchronizowano branch i dodano
wejście `.github/skills` wskazujące kanoniczną implementację, bez duplikacji
zasobów lub osłabiania kontroli.

PR #285 scalono jako `bc96b8395cbacdcc148a4ef4b05893ea3e13755b`; master
zaktualizowano fast-forward. Rzeczywisty cleanup bezpiecznie zatrzymał się
przed planem/usuwaniem na natywnych ścieżkach Windows obcych kontenerów.
Poprawka używa istniejącego klasyfikatora ścieżek, nadal odrzuca UNC i aliasy
POSIX. 14 retirement + 21 adapter + 5 finish tests: PASS. Odczytowy probe
68 kontenerów, w tym 37 bindów Windows: PASS; niezależny bounded review: PASS.
Poprawka wymaga osobnego follow-up PR przed końcowym cleanupem worktree.
