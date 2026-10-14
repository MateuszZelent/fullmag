# Naprawa integracji remote — 14 października 2026

## Cel i granice

Naprawić potwierdzone błędy po merge PR, zachować lokalną dokumentację i cudze niezapisane zmiany, zintegrować poprawki przez PR, następnie pobrać wynikowy master.

- Worktree: `C:/git/fullmag/worktrees/remote-merge-repair-20261014`.
- Branch: `codex/remote-merge-repair-20261014`; owner `codex-root`.
- Worktree ID: `remote-merge-repair-20261014-fae09a15050e2c69`.
- Bazowy lokalny master: `e1ff1a7af12b7077bc6f5f6043fc061ceab4ce35`.
- Pobrany master: `e40295e419aaf212fb69885c573ac6d6e60c9e69`.
- Izolowany merge zachowujący oba ancestry: `14061a0a4115fd2c557c36528b02cab621fd3b3b`.
- Rejestr: `storage/index/remote-merge-repair-20261014-fae09a15050e2c69.json`.

## Wdrożone fragmenty

1. Backend: jawnie odrzuca adaptacyjne wykonanie dedykowanej inspekcji anteny przez wczesny `return Err(...)`; brak wildcard i fallbacku. Commit `704d3cbb0e071a0805235bad60c871172179d332`.
2. Kontrakt workflow: wymaga resolvera przed Rust gate, dopuszcza legalne kroki pośrednie, sprawdza wszystkie setup-node i poprzedzające konfiguracje pnpm. Commit `5c822a286c6a4720d3bd183b17d58b40cb834f8f`.
3. Storage: projekt jest rodzicem głównego checkoutu na każdym OS; przywrócono sibling storage i pełną ochronę przed storage wewnątrz checkoutu. Marker i `.env` pozostały bez zmian. Commit `91fef27da9da588c8b79f3095567ac18d316ab9c`.
4. Frontend zapisany w commicie `b3ebfeda07591926c0cc917f2332598908761717`. FieldMap: usunięto duplikaty deklaracji `monitorId` i `newName`, zachowując walidację wejścia.
5. CLI typecheck: rozwiązuje deklarowany `bin.tsc` względem eksportowalnego package.json; fixture uruchamia rzeczywisty skrypt z ograniczonymi eksportami pakietu. Fixture jest częścią istniejącej bramki CI przed rzeczywistym typecheckiem.
6. Zależności: Vite wyrównany do jawnego override 8.0.16; przywrócono wcześniejsze TypeScript 5.8.3, ESLint 9.39.4, Three ^0.183.2 po wykazaniu niezgodnych peer dependencies aktualizacji. Lockfile odświeżono pnpm 10.8.1, wyłącznie lockfile, bez skryptów instalacyjnych.

## Dowody

- Backend source contract: 2 testy interpretowane OK; dodatkowe review poprawiło typ ramienia matcha na wczesny return.
- Workflow: pełny interpretowany skrypt na Windows, 15 testów OK, bez kompilacji Rust/C++.
- Storage: natywny Windows resolver target worktree exit 0; project_root `C:/git/fullmag`, storage_root `C:/git/fullmag/storage`.
- Storage: Windows 46 testów OK (2 pominięte); Linux według wykonawcy 46 passed / 1 skipped.
- CLI fixture: baseline 4 błędy z ERR_PACKAGE_PATH_NOT_EXPORTED, po poprawce 4/4 OK na natywnym Node 24.19.0; kolejność narzędzi, argumenty, błędy i odtworzenie next-env sprawdzone.
- FieldMap: dokładny fragment baseline daje SyntaxError powtórnego monitorId; fragment poprawiony i pełny poprawiony plik przechodzą check Node. Pełny baseline TypeScript w tym trybie Node nie wykrywał duplikatu, więc nie jest dowodem negatywnym.
- Bash parser bramki CI: exit 0.
- pnpm 10.8.1: lockfile-only + ignore-scripts + strict-peer-dependencies exit 0 bez peer warnings; następnie frozen-lockfile + strict-peer-dependencies exit 0, bez instalacji/kompilacji.
- [Oficjalny zakres wsparcia typescript-eslint](https://typescript-eslint.io/users/dependency-versions/) obejmuje >=4.8.4 <6.1.0; przywrócone przypięcia pochodzą z wersjonowanego manifestu sprzed PR #72/#68/#101.
- Niezależne review storage i CLI: brak blockerów w źródłach; dodatkowe ryzyko peer dependencies jest objęte przywróceniem wcześniejszych wersji.

## Pozostałe bramki

Build, rzeczywisty typecheck/lint, browser/WebGL, runtime i kwalifikacja physics: **NOT VERIFIED**. Nie kompilowano testów jednostkowych. Pre-commit React Doctor przy pierwszych trzech commitach odmówił skanowania z powodu unstaged package.json; exit hooka 0 nie jest dowodem skanu.

Użytkownik zezwolił na wymagane CI tej naprawy kompilujące testy Rust/C++. Zgoda dotyczy CI, nie znosi ogólnego zakazu lokalnej kompilacji testów. Zezwolił również na scoped stash kolidujących lokalnych zmian i ich odtworzenie po fast-forward, po kontroli stabilności plików. Repo uruchamia CI również po push na codex/**.

Aktualizacja głównego checkoutu wymaga zachowania kolidujących lokalnych zmian. W audycie było 59 zmienionych śledzonych plików, 17 pokrywało się z remote; stan trzeba odczytać ponownie przed synchronizacją. Użytkownik wcześniej wymagał utrzymania równoległej pracy. Nie wykonano reset, stash ani podmiany cudzych plików.

Następny krok: push/PR, zielone wymagane kontrole, merge, fast-forward main, weryfikacja i bezpieczny cleanup wyłącznie worktree tego zadania.

## Retencja

Nie uruchomiono ciężkiego builda i nie utworzono pakietu runtime. Interpretowane fixtures usuwają wyłącznie własne katalogi tymczasowe. Cache pnpm i metadane zależności zachowano. Worktree pozostaje do CI/integracji; brak podstaw do usunięcia przed merge. Skill fullmag-build-stage-cleanup nie jest dostępny w katalogu tej sesji; stosowano reguły retencji governance.
