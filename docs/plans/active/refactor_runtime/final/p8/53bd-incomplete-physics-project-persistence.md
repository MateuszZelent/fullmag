# P8-53BD — zapis projektu przed dodaniem fizyki

Status: **CLOSED — SOURCE/API/BROWSER PASS**, 07.10.2026. Prerequisite dla Compute po odtworzeniu
workspace; nie zamyka całego P8-53.

## Odtworzony problem

Zarządzana próba `verify-windows-development-workspace-browser`, receipt
`4fdceee25bce4579b3170add9c957a82`, używała manifestu
`44a976d76203ce65d8cdb36a447ec62cd09c32c0b757bb181d76827ee896d549`.
W rzeczywistym UI utworzono FDM CPU, cienką warstwę, region, materiał
i jednorodną magnetyzację. Nie dodano oddziaływań ani anizotropii.
Przy `Setup draft` zapis SceneDocument przez projektowy endpoint wywołał
renderowanie skryptu; Python odrzucił model komunikatem
`Problem requires at least one interaction or material anisotropy`.

Próba ma wynik **FAILED**, exit 1; nie potwierdza Compute ani hydration
projektu. Restart został wywołany po nieudanym capture i nie może być
zaliczony jako pozytywny dowód ciągłości. API wymieniono, ale fixture nie
miała poprawnego baseline'u. Natywny wynik zawiera terminalne kody obu API
i helperów. Port użytkownika 3197 nie był restartowany.

## Przyczyna i zakres poprawki

`projects.rs::authoring_update_blocking` rozpoznaje kompletność
sceny przez walidator Rust, który dopuszcza ten stan. Renderer Python
materializuje wykonawczy Problem i wymaga fizyki. Niezgodność tych granic
powoduje błąd zapisu projektu, choć dokument autorski jest poprawny.

Poprawka rozróżnia wewnętrzny, typowany brak fizyki od innych błędów
renderowania. Tylko zapis projektu korzysta z opcjonalnego renderowania:
zachowuje SceneDocument, parametry, assety i historię wcześniejszego źródła,
a bieżące źródło wykonawcze usuwa tak jak dla innych niekompletnych
projektów. Nie dodaje zastępczej fizyki ani skryptu. Synchronizacja do
runtime i zwykły renderer zachowują dotychczasową odmowę. Nie zmienia się
OpenAPI, Solver/ProblemIR ani macierz dopuszczalnych lane'ów.

## Bramka odbioru

1. Interpretowana regresja: opcjonalny render nie nadpisuje istniejącego
   pliku przy braku fizyki; strict nadal odmawia; nieznany błąd nie jest
   przechwytywany; model z fizyką nadal daje źródło.
2. Produkcyjny natywny build przez istniejący profil backend-dev.
3. Managed projekt: zapis bez fizyki, zachowanie raw scene/assets/history,
   usunięcie nieaktualnego current source, noop i ponowne otwarcie bez
   zmian bajtów; ponowne dodanie fizyki odtwarza dokładne źródło.
4. Obecne fault gates renderera nadal odrzucają deadline i nadmierny log.
5. Browser: Setup draft niekompletnego projektu i odtworzenie dokumentu.
   To osobny dowód od rzeczywistego Compute po odtworzeniu kompletnego
   modelu; oba wyniki raportować oddzielnie.

Nie kompilować Rust testów jednostkowych. Nie zaliczać pozytywnego ACK
komendy jako wykonanego solvera. Pełny plan pozostaje aktywny.

## Końcowe dowody źródeł i API

- Managed regresje: `just verify-windows-development-handoff`, receipt
  `0f5be07d23d84aea8f5a4527c680508d`: **140/140 PASS**, bez skipów,
  exit 0. Obejmuje cztery nowe przypadki; hash źródeł przed i po jest
  identyczny: `e674567141e66221427f32b6fa88ae6cdb7c5f07cf7cfab47d0b38e020311ba5`.
- Produkcyjny pakiet: manifest
  `4546a80021efcc6c9b8a1b5e1a8725a3a9b538f2222832ef70bc0f277087ecee`;
  native build receipt `completed`, exit 0, log
  `native-build-22187ff0a34b428ca94fda7ecd97d40c.log`.
  Wykonano zarządzany build produkcyjny CLI/API oraz desktopu. Bajty pięciu zmienionych
  plików produkcyjnych w utrwalonym snapshotcie
  `f73ae533f6e2c822528f3cd099f6059d9997adbff7c21552632bf22a63c94073`
  są identyczne z poprawką w checkoutcie. Końcowa poprawka zachowuje
  atomowe zastępowanie docelowej ścieżki helpera; resolve dotyczy tylko
  raportowanej ścieżki w JSON, nie celu zapisu.
- Managed API: `just verify-windows-project-document`, receipt
  `261180dbb23242f4a906d267bafdc7a2`: **28 kontroli PASS**, exit 0,
  wszystkie 5 własnych procesów odebrane. Projekt
  `project-370583bb488f40bb929125272e22d646` bez fizyki ma revision 3,
  Source=None, zachowaną scenę, assety i historię. Noop i reopen zachowują
  bajty archiwum; ponowne dodanie fizyki daje revision 4 i identyczne
  źródło o SHA-256
  `9daba900ab2bb5ac8c436303a57acec36b1fb0dde780618a863d0f15efcd0690`.
  Deadline helpera nadal daje 500 po 30.922 s, log overflow po 0.422 s;
  dokładne uchwyty obu helperów potwierdzają wyjście.

## Historyczne próby browser

Receipt `df1199d544d341a48f42a8bf095239ff`: **FAILED**, exit 1,
wszystkie 8 własnych procesów odebrane. Pierwsze API pochodziło z
historycznego owner bundle `4dcf797a42e64d3e91bb82d7da3f57f5`, które nie
przekazuje `--allow-incomplete`. Nowy pakiet był kandydatem, a nie tym API.
Dlatego Setup draft nadal odmówił przed restartem; to nie jest regresja
przetestowanego nowego API ani dowód browser PASS. Nie wykonano replacement.

Poniższy końcowy przebieg zastępuje tę otwartą bramkę. Compute po
odtworzeniu wymaga osobnego kompletnego modelu i rzeczywistego solvera;
nie zamknięto P8-53 ani całego planu.

## Historyczny checkpoint oczekiwania na zasoby

Źródłowe review niezależnego agenta: bez actionable findings. Parser AST
sześciu zmienionych plików Python PASS; `git diff --check` PASS. Regresja
Python wykonała 4/4 kontroli przed przeniesieniem pod nazwę obsługiwaną przez
zarządzany handoff runner. Finalna ścieżka testu korzysta z jego TEMP/TMP,
bez nadpisywania tempfile rootem checkoutu. Dodatkowa próba review 3/4
zatrzymała zapis kompletnego źródła na sandboxowym WinError 5; nie jest
wynikiem managed ani dowodem defektu poprawki.

`just verify-windows-development-handoff` odmówiło startu z powodu zajętej
blokady worktree. `just windows-backend-dev 3197` odczekało zarządzane
120 sekund i również nie rozpoczęło kompilacji (exit 2 wrappera).
Potwierdzony żywy owner: PID 103136, proces `fullmag_storage.py
run-windows-workspace-build`, start 07.10.2026 07:04:30 UTC. Nie przypisujemy
mu właściciela rozmowy na podstawie ścieżki ani go nie zatrzymujemy.
Blokada została następnie zwolniona; powyższe dowody zastępują ten etap
oczekiwania. Własne próby API/browser są terminalne, ich dane i logi
zachowano w profilach development-handoff-checks oraz
development-backend-api-checks. Workspace użytkownika 3197 nie był
restartowany. Pozostałe bramki opisano powyżej.

## Kolejna próba browser B → C

Receipt `cf236548ab684868bb8dae30a066f943` zakończył się FAILED.
Poprawione początkowe API zapisało projekt bez fizyki, a replacement
odtworzył scenę i dirty document o identycznych hashach. Ostateczny
Finish proof nie został przyjęty przed wygaśnięciem 600-sekundowego
budżetu fixture; nie jest to terminalny PASS. Wszystkie 13 procesów
natywnych i frontend zostały odebrane. Kolejna próba używa tej samej
sprawdzonej pary pakietów, bez ponownej kompilacji.

## Zamknięcie P8-53BD

Receipt `782a66b4710b494d820f07ee2978b06d`: **completed, exit 0,
7/7 kontroli PASS**. Początkowy poprawiony pakiet B pochodził z owner bundle
`7a7d45b7033840b39a5dc02cf4bebf1d`, replacement C z manifestu
`4546a80021efcc6c9b8a1b5e1a8725a3a9b538f2222832ef70bc0f277087ecee`.
Nie zmieniano sztucznie tożsamości pakietów.

W rzeczywistym UI utworzono jeden obiekt Box, region `No physics region`,
materiał Ms=8e5 A/m, A=1.3e-11 J/m, alpha=0.01 i jednorodną magnetyzację.
W utrwalonym baseline exchange_enabled=false, demag_enabled=false,
physics_stack=[], brak Ku1; nie dodano zastępczych oddziaływań.
Setup draft zapisał projekt bez błędu renderera.

Po restarcie API zmieniło się z `94a8fdd4-5e65-4eb3-981c-536a1a0b0c31`
na `b9390ca5-2297-4139-b3ab-d7c755be7f4f`, sesja i scope były świeże,
generacja kernela zmieniła się 0 → 1. Projekt
`project-f531de07b5284a6da55f732f40f5b3d3` zachował revision=2, dirty=true,
scenę revision=6, obiekt, region, materiał i magnetization_ref.
Hash archiwum Base64 przed i po:
`a829896e58148d59bcc54d600faf7f832adb035072afefd76416d442a98861fb`.
Hash sceny i dokumentu przed i po:
`6c62614052eca2900a1b69c6e1d9857e41d17252df3e5084e18669861173f10e`.
Canvas widoczny, context_lost=false, drawing buffer 519 × 297; noEmit i lint PASS.
Finish proof został przyjęty, natywny CLI zwrócił passed i exit 0.
Wszystkie 13 procesów w receipt oraz frontend mają terminalny wait.
Replacement API zakończono w kontrolowanym cleanup fixture z exit 1;
nie jest to kod wyniku testu, który wynosi 0.

Zamknięto wyłącznie zapis i odtworzenie projektu przed dodaniem fizyki.
Strict renderer/runtime nadal odrzuca taki model wykonawczy.
Nie uruchomiono solvera ani siatki. Compute po restore, publiczny restart,
pozostałe P8 i pełny plan pozostają otwarte. Workspace użytkownika 3197
nie był restartowany; test miał osobny frontend 3258 i własne API.
