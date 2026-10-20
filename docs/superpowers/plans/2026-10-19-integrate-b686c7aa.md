# Integracja wskazanego commita b686c7aa — checkpoint

## Cel i korekta zakresu

Użytkownik wskazał jako właściwy cel commit
`b686c7aa84fbc296d0752e64bbfdc2342ad2189a`
(Support Linux and WSL Docker development builds and runtime).
Poprzedni cel, Kelvas888/fullmag PR #1, został zastąpiony. Nasz draft PR #201
zamknięto bez merge; jego branch i commit
`fa8d6c514dc3f33f884a6b4996bed405b64e58ec` zachowano. Nie przenosimy jego kodu.

Docelowy commit zawiera aktualny volume DEV Linux/WSL, mapowanie WSL bindów,
ledger i scoped ACL operatora/runtime UID 65532, a także jawne ustawienia
MFEM CUDA i wyłączenie kompilacji testów CPython. Zachowujemy ten kontrakt.
Nie zastępujemy go wcześniejszym adapterem docker_platform/caller UID.

## Tożsamość i izolacja

- Rodzic wskazanego commita: `6d3fcc08285e075cab0019cb235f21c7a2a9841f`.
- Baza integracji origin/master: `c9258ce6b1524eb3851010a556155a9fb9a2da69`.
- Branch: `codex/integrate-b686c7aa-20261019`.
- Worktree: `C:/git/fullmag/worktrees/integrate-kelvas-pr1-20261019`.
- Owner: `codex-current-chat`. Użyto ponownie naszego czystego worktree;
  jego nazwa i worktree_id pozostają historyczne.
- Rejestr: `storage/index/integrate-kelvas-pr1-20261019-3c3f086c71561a43.json`.
- Główny checkout ma niezależne staged/dirty zmiany. Nie zmieniamy ich,
  nie resetujemy i nie stashujemy podczas integracji.

## Wykonanie i weryfikacja

1. Merge dokładnego SHA do bazy c9258ce6; jedyny konflikt tekstowy:
   `scripts/docker_volume_dev.py`. Zachować nowe guardy cancellation,
   drain, successor recovery oraz obserwację postępu z bieżącego mastera.
2. Worker launchera rozwiązuje konflikt i właściwe regresje. Drugi worker
   sprawdza auto-merge guest/control/activation i jego konsumentów.
3. Niezależne review host adapters, ACL, WSL bind proof, ledger i Rust admission
   zakończone bez potwierdzonych defektów wymagających poprawki. To review
   źródeł; nie wykonano uprzywilejowanych probe ani kompilacji.
4. Testy dobieramy do źródeł i przecięć merge. Wyłącznie interpretowane
   regresje oraz kontrola parserów/linków/diff. Testy MFEM flag i zakazu
   kompilacji testów CPython używają atrap narzędzi, nie kompilatorów.
5. Commit integracji ma użyć `[skip ci]`, aby otwarcie/push PR nie powtórzyły
   automatycznej kompilacji testów jednostkowych przy obowiązującym zakazie.
   Pominięcie workflow nie oznacza jego zaliczenia. Odczyt API GitHub wykazał
   brak branch protection, brak wymaganych status checks oraz pustą listę
   rules dla mastera. Nadal wymagane są adekwatne testy i review źródeł.
6. Następnie push, nowy PR do mastera, merge po odbiorze, sprawdzenie że b686c7aa
   jest przodkiem wynikowego mastera, lokalny ff i zweryfikowany cleanup.
   Cudzy dirty checkout może zablokować lokalny ff; nie wolno go nadpisać.

## Granice dowodów runtime

`docs/plans/active/docker-dev-wsl-20261019.md` pochodzi ze wskazanego commita
oraz opisuje build/restart i receipty na hoście autora. To historyczny kontekst,
nie dowód wykonania na tym komputerze ani na połączonej wersji c9258ce6.
Niniejszy etap integruje kod; nie kwalifikuje naukowo solvera ani nowego hosta.
Nie kopiujemy lokalnego .env, ścieżek, ustawień GPU lub decyzji operatora autora.

Aktualna kontrola lokalna: Docker z Ubuntu2 odpowiada (server 29.9.1).
Właściwy istniejący clone Linux jest w `/home/kkingstoun/git/fullmag/fullmag`,
czysty przy HEAD `93f11dbc564c00b725d174ccb2fd0ff9a96493c9`; nie modyfikowano go.
Nie uruchomiono nowego buildu, usług, restartu ani uprzywilejowanego probe.

## Odbiór źródeł przed integracją

- Rozwiązany jedyny konflikt launchera został sprawdzony względem obu rodziców;
  niezależne review nie wykazało actionable findings. Zachowano nowsze recovery,
  anulowanie i drain oraz Linux/WSL admission ze wskazanego commita.
- Worker launchera: 11 interpretowanych suites, 122 przypadki, OK.
- Worker auto-merge: główny zestaw 290 przypadków, 3 skip, OK; po dodaniu aliasu
  skryptu receiptu zestaw runtime-state ponownie 7/7 OK.
- Dodatkowe źródłowe kontrole host/probe/WSL/ledger: 68 przypadków, 2 skip, OK.
  Zestawy częściowo się pokrywają; liczby nie są sumą unikalnych przypadków.
- AST, brak markerów konfliktu oraz staged/unstaged diff check: OK.
- Nie kompilowano testów ani aplikacji i nie uruchamiano usług. Runtime tej
  połączonej wersji na obecnym hoście pozostaje NOT VERIFIED.
