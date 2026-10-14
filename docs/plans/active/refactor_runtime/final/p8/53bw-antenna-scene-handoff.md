# P8-53BW — typowane pola antenowe w handoff sceny

Data: 14.10.2026. Baza `c87661353420085013956f1b39d78d87c6b97312`.
Status: **SOURCE CHECKS PASS; runtime NOT VERIFIED**. Zakres to walidacja kształtu sceny i ownership assetów,
bez zmiany fizyki, lowering, solvera ani publicznej dostępności restartu.

## Przyczyna i zmiana

Receipt handoff `c0981454e6f14d51963be88fc3f228b8` odrzucał scenę eksportowaną
przez aktualny Python: collector nie znał pięciu nowych kolekcji SceneDocument.
Kontrakt źródłowy: `fullmag-authoring/src/scene.rs::SceneDocument`, typy
`AntennaPortModeIR`, `AntennaFieldSolveStageIR`, `AntennaTargetProjectionRefIR`,
`SolvedAntennaDriveIR`, `AntennaSpectrumRequestIR` w `fullmag-ir/src/antenna.rs`.

Collector rozpoznaje teraz wszystkie pięć kolekcji i deleguje walidację do
prywatnego `scripts/windows/development_antenna_scene_assets.py`. Walidator
sprawdza wymagane/default/Option pola, typy, zagnieżdżone rekordy oraz znane
warianty targetów, waveformów, aktywacji i solution refs. Nie dopuszcza
nieznanych pól, np. zagnieżdżonego `source_path`. Nie wymusza ponownie
semantyki fizycznej, positivity, uniqueness ani zgodności referencji między
rekordami — to granica walidatora IR, a nie inwentaryzacji plików.

`solution.asset_id` i `content_digest` odnoszą się do wyniku; nie są ścieżkami
lokalnych źródeł ani RFC 6901 pointerami collectora. Nie są dopisywane do
manifestu plików i nie są rebazowane. Przenoszenie rzeczywistych bajtów wyników
antenowych wymaga odrębnego powiązania z ich zweryfikowanym rejestrem.
Nieznany owner `analysis/settings` nadal kończy się fail-closed.

Nowe interpretowane regresje obejmują pełne rekordy wszystkich kolekcji,
warianty referencji i waveformów, puste eksportowane listy, brak mutacji,
brak sztucznych assetów plikowych, złe typy i ukryte pola ścieżek. Fingerprint
managed checks obejmuje helper, regresje i kontrakty Rust `antenna.rs/study.rs`.

## Weryfikacja i zasoby

Pierwszy start managed handoff checks po poprawce został odrzucony przed
testami: `Storage is busy`. Właścicielem aktualnej pracy jest uruchomiony
przez root build z handle 98534, log
`native-build-1c8373aae883439b8a2f06e7ed0ddee2.log`. Nie uruchamiano
alternatywnego targetu ani duplikatu. Po terminalnym wyniku tego buildu trzeba
wykonać managed checks i zachować ich fingerprint/receipt. Nowy walidator
nie jest objęty już utrwalonym snapshotem tego buildu.

Sam build przeszedł instalację pnpm po naprawie logowania i kompiluje źródła
produkcyjne; nie jest to jeszcze końcowy PASS. Scope Rust unit targets lokalnie
pozostaje zabroniony. Review antenowego walidatora: brak P0/P1/P2.

## Integracja

PR #160 został zdalnie scalony 14.10.2026; wynik potwierdzono przez REST API.
Naprawa storage/logowania `c87661353420085013956f1b39d78d87c6b97312` została
wysłana zwykłym fast-forward na istniejący branch. Odrębny PR
[162](https://github.com/MateuszZelent/fullmag/pull/162) ma bazę
`e116a156e1a094c0fe300ac94d26fb8bb9c44f23`; CI napraw jest autoryzowane.
Aktualne błędy CI obejmują m.in. niepełny adaptive match antenowego backendu,
duplikaty deklaracji Field Map i nieaktualny fixture bez `entrypoint_kind`.
Nie zaliczono integracji ani runtime na podstawie samego push lub uruchomienia CI.

## Terminalne wyniki i następny krok

Build z handle 98534 zakończył się failed: managed exit 1, Cargo exit 101,
E0004 w `fullmag-runner/src/lib.rs::validate_parallel_execution_workflow`.
Snapshot `eacf35af6de62962de8f5fc2d88e53dc7ef58c980c0040a62e799de5c5fab896`
nie zawierał poprawki adaptive. pnpm ukończył instalację 741 zależności;
logowanie Unicode nie przerwało już buildu. Nie jest to jeszcze build PASS.
W checkoutcie scoped worker dodał jawne odrzucenie adaptive dla external-lead
inspection i usunął dwie redundant deklaracje Field Map. Root uzupełnił
fixture relax o wymagany `entrypoint_kind=flat_relax`; nie dodał defaultu
do produkcyjnego kontraktu. Testy kompilowane lokalnie nie były uruchamiane.

Receipt `3370e42ad4e94aa892fd0e51d8550f4e`: failed, 217 testów, zero skips,
source before=after `a99ee95324a41c6a6215e5bb5328f7d43b1fba505b807c0382d783dd26b4743d`.
Regresje antenowe przeszły. Pozostał eigenmodes subcase z trzema nowymi
scalar polami i dwa shell subcases wybierające System32 bash/WSL (exit 127),
który nie odczytał natywnej ścieżki, zamiast wykonywać guard.

Collector rozpoznaje `eigen_solver_rtol`, `eigen_solver_max_outer_iterations`,
`eigen_solver_max_linear_iterations` zgodnie z eksporterem Python. Zachowuje
wartości bez mutacji; nie interpretuje ich jako źródeł plików. Poza eigenmodes
dopuszcza brak/null/pusty tekst. Nowe regresje sprawdzają rebase istniejącego
equilibrium artifact przy niezmienionych scalar polach i fail-closed dla
ukrytego `source_path`. Test shell guarda na Windows wybiera natywny Git Bash
z instalacji Git. Read-only odtworzenie odmowy niepoprawnej recepty: exit 2.

Pełny managed handoff check `a285101ea4204d809b4e780dda14a40e`:
**completed, exit 0, 222 testy PASS, zero skips**. Source before=after:
`97578add9cc13dd9cab9d61ae1ff59e256c31db41aaa4f75a11c2bf1306ffcad`.
AST sześciu scoped Python plików i scoped diff check PASS. Wynik obejmuje
prymitywy inwentaryzacji, transportu i walidacji; nie dowodzi nowego runtime
restore, przeniesienia rzeczywistych wyników antenowych ani A→B→C.

## Poboczny formatter — oczekująca autoryzacja

Root uruchomił rustfmt na lib.rs bez skip_children; formatter objął 69 plików
runnera. Tego rozszerzenia nie należy dołączać do naprawy integracji.
Read-only kontrola (handle 11757, exit 0) potwierdziła dokładną równoważność
każdego pliku z rustfmt(HEAD + własny adaptive arm). Niczego nie zapisywała.
Automatyczna kontrola uprawnień dwukrotnie odrzuciła cofnięcie formattera,
także po tym dowodzie: zakres mutacji współdzielonego checkoutu wymaga
dokładnej autoryzacji. Nie obchodzono odmowy. Pytanie do użytkownika o
usunięcie wyłącznie własnego formatowania pozostaje oczekujące.
Zmian formattera nie stage'owano ani nie opublikowano. Są obecne w bieżącym
dirty source scope powyższego receiptu, więc nie należy utożsamiać jego
fingerprintu z samym przyszłym commitem przyrostu Python.
## Ostateczny odbiór tego przyrostu

Review zgłosiło P1: brak historycznego `eigen_solver_residual_tolerance`, który
eksporter nadal obsługuje. Dodano alias i regresję canonical precedence:
niepusty `eigen_solver_rtol` wygrywa, brak/null/pusty canonical korzysta z
aliasu. Aktywna wartość podlega tej samej walidacji; nie mutuje się sceny.
Ponowne bounded review: P1 rozwiązany, brak nowych P0/P1/P2.

Końcowy receipt `e71168c9d20647a88e42178e67f9ac96`:
**completed, exit 0, 224 testy PASS, zero skips**. Source before=after:
`88267bc63a0fff20798e2c84484f080b4dda2a2db4495ebe6cfb6f14de1d997d`.
To obowiązujący odbiór źródłowy tego przyrostu; wcześniejszy PASS222 nie
obejmował poprawki aliasu. Runtime, nowy build produkcyjny i integracja
pozostają otwarte. Staged zakres obejmuje wyłącznie pliki Python i ten
checkpoint, bez niezweryfikowanej poprawki adaptive i bez formattera.

Po PASS224 usunięto wyłącznie nadmiarową pustą linię EOF helpera; porównanie
AST przed/po jest identyczne. Testowany raw SHA-256 helpera:
`f9ef553a1d7e27258951d5e3ddc4f5484315803415e272cbe575ebcabfba7a30`;
końcowy raw SHA-256:
`c19b096eb7df401d931ea4a977fbe092e07d5cfce5242edfe0d32bf7e3a09362`.
Nie utożsamia się końcowego raw fingerprintu z testowanym, mimo niezmienionego AST.

Aktualizacja: użytkownik zatwierdził usunięcie wyłącznie własnego formattera.
Operacja jest zakończona i potwierdzona w
[53BY](53by-ci-harness-and-quota-types.md); wcześniejsze oczekiwanie powyżej
jest zapisem historycznej blokady, nie aktualnym stanem.
