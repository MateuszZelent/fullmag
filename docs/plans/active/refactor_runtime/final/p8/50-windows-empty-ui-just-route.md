# P8-50 — pusty workspace Windows przez just

03.10.2026. Użytkownik chce testować launcher i tworzenie symulacji w UI:
geometrię, regiony i parametry materiałowe, bez wejściowego skryptu.

`just windows-ui` uruchamia natywną trasę `windows-native-fdm-cpu` z
frontendem `dev`, portem `3197` i `build=auto`. Automatyczna decyzja buduje
brakujący lub nieaktualny pakiet, a następnie zwalnia natywny heavy lock przed
uruchomieniem UI. Użytkownik może też jawnie podać `false` (użyj istniejącego
pakietu) albo `true` (wymuś budowę), np.:

```powershell
just windows-ui
just windows-ui dev 3197 auto
just windows-ui static 3197 false
just windows-ui dev 3197 true
```

Tryb `dev` dostaje izolowany workspace w kanonicznym storage: katalogi
`src`, `app`, `public` i `scripts` są zwykłymi plikami synchronizowanymi z
checkoutem. Watcher startuje przed Next i przekazuje także atomowe zapisy,
nowe pliki oraz usunięcia. Cache frontendu jest osobny. Zmiany React/CSS są
widoczne bez unieważniania backendu. Zmiany konfiguracji lub zależności
wymagają ponownego przygotowania workspace. Tryb `static` kopiuje źródła przed
budową statycznego eksportu. Launcher nie przyjmuje backendu, urządzenia ani
skryptu wejściowego; te decyzje pozostają w UI. Git Bash jest wyłącznie
adapterem `just`, bez WSL i Dockera.

Resolver używa zamkniętej trasy `run-windows-workspace` oraz oddzielnego
`nativeWindowsHeavyLock`. Ogólna polityka Linuxowego runnera i kolejki/job 219
pozostaje bez zmian. Każda faza zachowuje storage preflight, per-worktree
lock, manifest/hashy i terminalny receipt; budowa na żądanie nie omija tych
bramek.

Wrapper dopuszcza tylko stały launcher, frontend `static|dev`, build
`auto|true|false` i canonical port 1–65535. Klasyfikacja poprzedza ogólną
diagnostykę i przygotowanie kompatybilnych ścieżek, więc niepowiązany legacy
profile nie inicjalizuje się przed właściwym launcherem.

## Dowody

- Zbiorcza kontrola skryptów storage, pustego workspace, stagingu,
  tożsamości i wersji: **88 PASS, 2 skipped, 13 subtests**, bez kompilacji testów.
- Synchronizacja źródeł: **3/3 Node PASS**, w tym atomic-save, dodanie/usunięcie
  trasy, race startowy i odmowa symlinków.
- Regresje sprawdzają argumenty static/dev, `auto|false|true`, odmowę portów
  0/65536/wiodącego zera, frontend spoza listy, dodatkową komendę i marker
  diagnostyczny. PowerShell jest stubem; test nie uruchamia UI.
- `just --show windows-ui` i kontrola zakresu diffu: PASS.

## Natywny pakiet i przeglądarka

Pierwszy build (sesja 86774) wytworzył natywne CLI/API/UI; obie fazy Cargo
release zakończyły się kodem 0. Next uruchomił się, lecz `/workspace` zwracało
404: route discovery nie widziało katalogu `app` wystawionego przez junction.
Własny proces testowy zatrzymano po tej diagnozie. Poprawka używa zwykłych
plików z synchronizacją zamiast junctions źródeł. Kolejny build (sesja 29651)
wytworzył wersjonowane EXE CLI/API/UI; obie fazy release zakończyły się kodem 0.
Po zamknięciu własnego okna testowego wrapper zakończył cały przebieg kodem 0.

Browser `/workspace` na 3197: PASS. Utworzono pustą sesję
`session-18daff56b8f163e400036d24`, bez blokującego modalu budowy siatki,
a następnie box i cylinder (scene revision 2). Zapis zmienionego szkicu
po poprawce [P6-78](../p6/78-primitive-ack-selection.md) wybrał nowy obiekt
bez modalu niezapisanych zmian i ponownego submitu. Poprawka React została
przekazana przez działający dev mirror bez nowego buildu Rust.

Automatyczny skan Tailwind obejmował wcześniej zewnętrzny cache i powodował
pętlę HMR/reload. `source(none)` oraz jawne źródła `app` i `src` usunęły tę
przyczynę. Rzeczywista interpretowana regresja PostCSS/Tailwind PASS: klasy
aplikacji są generowane, klasa dodana w zewnętrznym cache nie zmienia CSS;
kontrola negatywna potwierdza błąd starego importu.
Zasada źródeł jest opisana w
[oficjalnej dokumentacji Tailwind](https://tailwindcss.com/docs/detecting-classes-in-source-files).

Widoczny canvas: 361 × 465, `contextLost=false`, drawing buffer 361 × 465.
Screenshot zachowano w artefaktach zadania. Produkcyjny source check po
poprawce Inspectora: PASS (receipt `8d6b8943460d4337a20668dd34ebcdcb`).
Nie kompilowano testów jednostkowych.

Ponowny `just windows-ui dev 3197` po commitach Inspectora i launchera:
automatyczna decyzja `false`, hash-verified pakiet użyty bez kompilacji Cargo.
Browser pokazał pusty ekran Create a simulation. Bieżący frontend i backend
pozostawiono uruchomione do testów użytkownika; jego receipt pozostaje
`running` do zamknięcia. Poprzedni terminalny receipt exit 0 zachowano jako
`windows-runtime/workspace-browser-check-20261003.json` w profilu.
Poprzednia sesja testowa była niezapisana; ten przebieg nie dowodzi odtworzenia
projektu lub sesji po restarcie.

Pełny authoring regionów/materiałów, Save/restart, inne porty, instalator,
natywny FEM Windows i kwalifikacja wydania pozostają **NOT VERIFIED**.
Zmiana portu istniejącego pakietu dev wymaga przygotowania linku cache dla
nowego portu; dotychczas sprawdzono 3197. Pakiet Linux CPU z buildu 218 nie
stanowi dowodu natywnego EXE Windows.
