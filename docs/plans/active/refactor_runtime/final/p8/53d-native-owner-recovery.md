# P8-53D — odzyskanie porzuconego rekordu właściciela Windows

Data: 03.10.2026. Status: implementacja i rzeczywisty recovery zweryfikowane;
kontrolowany restart z odtworzeniem modelu pozostaje w P8-53.

## Problem i zachowanie

Poprzedni launcher zakończył się bez terminalnego receiptu. Późniejszy build
poprawnie odmawiał użycia profilu mimo braku procesów. Recepta
`just windows-runtime-recover 3197` zamyka tę lukę przez jawny recovery.
Nie zatrzymuje procesów i nie kasuje danych.

Helper używa resolvera i aktywnego/wip wpisu właściciela dokładnego checkoutu,
blokad runtime → build oraz powtórnej kontroli niezmienności rejestru/statusu.
Sprawdza pełną obserwację Windows CIM i TCP: zapisane PID, rodzime EXE,
watcher z tego checkoutu, wybrany port oraz niezależny runtime service.
Obecność procesu, ponownie użyty PID, nieczytelna tożsamość, niepełna
obserwacja, obcy owner, unsafe/reparse path lub zmiana rekordu blokują recovery.

Oryginalne bajty statusu są archiwizowane bez nadpisania. Nowy receipt
`fullmag.native-runtime-recovery.v1` zawiera hash archiwum, tożsamość ownera
i dowody nieobecności procesów. Istniejący validator lease sprawdza receipt
przed i po atomowej publikacji. Closed dispatch w `just_storage_shell.sh`
dopuszcza wyłącznie stały helper oraz port 1–65535, bez dowolnego shell payload.

## Dowody

- `just verify-windows-development-handoff`: exit 0, **40 interpretowanych
  regresji**, 0 skipów, bez kompilacji unit tests. Receipt
  `40402970c09e4400b4d55f431c827e4e`; hash źródeł przed/po
  `dde712e9e9ff18d1da20e58cad140d9d9bb86ba0e9fed19b486b23c15a70cea3`.
  W tym 13 nowych regresji recovery: zachowanie oryginału, owner/PID,
  rodzime procesy/watcher, port, unknown, niezależny service, race i reparse.
  Po rozszerzeniu dispatchu o lokalny React Doctor ponowiono tę samą trasę:
  40/40, exit 0, receipt `6d826d0b84c14258b6bfb9d7289c9752`, hash przed/po
  `faeaaa53e1b999eed1b9eeb173449f11ae04b14ed57c68ac69bb1f3ff826a7ad`.
- Rzeczywisty `just windows-runtime-recover 3197`: exit 0. Manager 234328,
  launcher 233128, watcher 233948, API 227912 i frontend 217692 były nieobecne;
  port 3197 zamknięty. Obcy listener 3104/PID 40908 pozostał bez zmian.
- Dokładne archiwum: `native-runtime-prior-89661856a9d747ca98f0d014cbdf2f59.json`
  w runtime root `fullmag-0950f4dca4ffe38f`. SHA-256:
  `d0b644cb9d5f56b40da2f21e6e59400fbbf6f4b2a3b5105e0e3c8b9f55215bec`.
  Receipt opublikowano 2026-10-03T16:13:27.551272+00:00.
- Po recovery produkcyjny build natywny zakończył się exit 0, a
  `just windows-ui dev` uruchomił nowy własny workspace 3197 z HMR i watcherem.
  Brakujący build nie był już blokowany przez porzucony rekord.

To recovery rekordu lifecycle, nie modelu ani checkpointu solvera. Żywa
sesja nadal blokuje recovery. Dalszy owner może zmienić bieżący status;
historyczne archiwum i jego hash pozostają dowodem tego przebiegu.
