# Odbiór rozliczenia GSG i aktualizacji grupy 3203

Data: 07.11.2026. Zakres zatwierdzony przez użytkownika: jedno rozliczenie
zakończonego zadania przez istniejącego nadzorcę oraz zarządzana aktualizacja.
Bez nowych Prepare, meshowania, Submit/Solve, H-only lub LLG.

## Wynik

| Bramka | Stan i dowód |
|---|---|
| Nadzorca istniejącego udanego zadania | PASS: jedno wywołanie, exit 0, recovered_terminal_completion=true, retry_scheduled=false |
| Rezerwacje | PASS: lokalna i hostowa Released; status zadania nadal Succeeded |
| Aktualizacja Compose | PASS: iteration 8857232e70bc47aca8dea77ad9da0f86, exit 0 |
| API i CLI | PASS: zgodna wersja i snapshot, działający proces API zgodny z hashem pakietu |
| Odtworzenie sceny | PASS: otwarcie istniejącego projektu, pusta sesja authoringu i replace_scene przez publiczne API; odczytana scena równa zapisanej |
| Zachowane tensory | PASS: 34 odczyty GET; H275 oraz V/J/H 100/75/50 nm zgodne bajt w bajt z przypiętymi wynikami |
| Stan usług | PASS: backend i frontend running/healthy; native service ready |
| Retencja pakietów | PASS: automatyczny receipt succeeded, current i direct-rollback zachowane |
| Odbiór wizualny po aktualizacji | NOT VERIFIED: stara karta stała się stroną błędu data:, odczyt zablokowany; oczekujemy świeżej karty użytkownika |
| Nowa dokładność fizyczna / zgodność z publikacją | NOT VERIFIED: nie wykonano nowego obliczenia |

## Przebieg operacji

Istniejący opublikowany fullmag-api-accepted-supervisor rozliczył wyłącznie
run-40c6990b8231f8fd7194d8b634e780aab9af3a559dbd21b27f8b7bcb8425be5e,
task-902544fbad21c9da53757ca22786517f6866733c15a4e24dd380524b0c4cd859.
Proces PID 282798 zakończył się kodem 0. Nie uruchomiono workera ani ponowienia.
Z 455 przypiętych małych dokumentów 454 pozostały identyczne; zmienił się
wyłącznie lokalny lease. Scheduler zwolnił powiązany przydział hosta przez
istniejącą rekoncyliację. Dziennik, inbox i artefakty naukowe pozostały zachowane.

Zwykła recepta idle odmówiła przed zatrzymaniem backendu:
iteration 2f282c149d774f4b82f5fe2d90e10881, failed-confirmed,
„Current activation is not a failed accepted-then-cancelled terminal”.
API miało sesję authoringu bez runu, a nie przygotowany run oczekujący na Solve.
Zastosowano więc istniejącą receptę docker-dev-restart-saved-authoring,
z identycznym zabezpieczonym FMS i jawnym katalogiem zachowanego udanego runu.
Nie rozszerzano kontraktu recovery ani warunków odmowy.

Pierwsze zgłoszenie tej recepty nie utworzyło procesu: automatyczna kontrola
uprawnień przekroczyła termin i jawnie dopuściła ponowienie. Kolejne zgłoszenie
uruchomiło jedną rzeczywistą aktualizację 8857232e70bc47aca8dea77ad9da0f86.
Natywny drain i wszystkie bramki saved-authoring przeszły.
Oba container ID zostały zachowane:
backend 05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced,
frontend 271d8c4d455871a1b7b4b2fc34c55b9a122a3df305e0cd0c3382f072ac6779c4.

Cały build odbył się w stałym backendzie właściwej grupy Compose, przez just.
Make zakończył się kodem 0 po około 23 min 45 s; cała operacja trwała około
28 min 52 s. Nie kompilowano lokalnych testów jednostkowych Rust.
Pakiet miał cache miss, ale wykorzystano istniejące zarządzane wolumeny.
Nie zmieniano limitów CPU/RAM ani wspólnego .env.

## Tożsamość pakietu i odtworzenie authoringu

- HEAD źródeł: 3f57151a9c1a25d9c3fb64d57dd7fdbbbfe20945.
- Snapshot: 08b4e431e3fefee766ff997dc73ca65de7ed9f1dbd945bf2b7524dcd6bab810c.
- Wersja API/CLI: 0.1.0-dev.20261107.g3f57151a9c1a.dirty.s08b4e431e3fe+9807.
- Pakiet: 571513d2972cab78f3e355d0171fde51f3915b2955d875ed6c5664108b7f7578.
- Działający API PID 20139, hash binarium zgodny z artefaktem:
  60ebd18c4c767a748dd4f4f06e4f0a1845b8bf8479e1872e53089670405fd807.
- CLI fullmag-bin --version zakończyło się kodem 0; wersja zgodna z
  runtime_bundle_version publicznego statusu API.
- Sesja odtworzonego authoringu: session-18e5e104d696c55200004eab,
  scene revision 1, solver awaiting_command, run=null.

Projekt gsg-authoring-five-readruns-prebuild-273097a79355802f.fms ma 13796 B,
SHA256 273097a79355802f6cc6f75b5ff79ca72dd41cf349e81d75ba383bef3efd9306.
Sprawdzono manifest/project.json przed użyciem projects/open.
Nie importowano tego archiwum jako sesji ani nie wykonywano skryptu.
Odtworzona scena jest równa authoring_scene_document z publicznego otwarcia
archiwum. Samo odtworzenie authoringu nie oznacza podłączenia kontrolera
projektu w przeglądarce; odbiór UI pozostaje osobną bramką.

Diagnostyczne użycie fullmag-api --version było nieprawidłowe: ten program
nie obsługuje tej flagi i próbował wystartować drugi listener, który odmówił
z Address already in use (exit 101). Nie powtarzano tego wywołania.
Po nim potwierdzono dokładnie jeden działający proces API, zgodny z pakietem,
ready service i zdrowe usługi. Wersję API potwierdzono publicznym statusem,
a tożsamość procesu przez /proc/PID/exe, nie tą nieudaną diagnostyką.

## Dowody w prywatnym control volume

Wspólny prefiks:
verification/gsg-corner-refinement-20261107/runtime-upgrade-audit-v1/
standalone-supervisor-proposal-v1/approved-execution-v1/.

| Dokument | SHA256 |
|---|---|
| reconciliation-result.json | ae41950d0660b44ffb312f1631620e40e7c2fd3d1b8d90913fb610f526d0cc6a |
| saved-authoring-checkpoint.json | 8fca256f3c948dfcc316680079ff07b7a80f399f199d1f60930bcbf7033f7048 |
| post-update-archived-readback.json | 34be43aa15cb5e21840f9dc23fd5df5504edca601ee8d0a427da1f2cf4cc2f7b |
| post-update-runtime-readback.json | d950ba502ac77e5d42f5467aed9f4fe8149b7e185b4e835265723c77d82ebf00 |

Proof zwolnienia hosta:
4e1e3ce1dfa7c8f6ea29a4b1daf66f7fa62af852bf9d06676b8399d28642356a,
w /host-ledger/ledger/proofs/<SHA256>.json.

Końcowy receipt iteration/attempts/8857232e70bc47aca8dea77ad9da0f86/receipt.json:
ff17d84792d0c27c8497e07bd26d55460b65ffe7dbaea23e94f0c91b95d500e3.
Saved-authoring restart result w tym samym katalogu:
6f3f99bf227435cdb18b329215eefdf3f50675f42eb2b6db459d930f8241804a.

## Retencja i granice kwalifikacji

Automatyczna konserwacja e91bd8be70184b229a416b8a01f50ca2 zakończyła się
succeeded/exit 0 i wskazuje dokładnie bieżący receipt pakietu.
Zachowała current oraz direct-rollback; usunęła jedną kwalifikowaną dawną
generację wspólnego pakietu e01061a0b39661bc6005edaddc98705d73638f3a25044988958b967227d6113d.
Nie wykonywano ręcznego prune ani kasowania wolumenów, wyników lub cache
zależności. Receipt compiler_cache raportuje missing/0 B, nie wykonane
czyszczenie cache kompilatora. build_data_qualification nadal ma wartość
NOT VERIFIED; sukces aktualizacji nie zastępuje całościowej kwalifikacji storage.

H275 zachowuje historyczny status failed przy czytelnym tensorze H.
Trzy stare pełne wyniki zachowują succeeded. Odczyt obejmuje dokładne hashe,
jednostki SI, właścicieli, liczby elementów i geometrię H, w tym antenę źródłową
dla H275. To test odczytu wyników, a nie nowa kwalifikacja źródła pola.

Następny krok naukowy pozostaje odrębny: doprowadzić przygotowanie corner25
do gotowego requestu, a dopiero w osobno uzgodnionym zakresie wykonać kontrolę
zbieżności transportu/pola. Sam build nie daje nowej wartości błędu, podstawy
do LLG ani zgodności z wykresami publikacji.
