# Checkpoint wdrożenia korekt U01–U12

Zlecenie użytkownika: realizacja wszystkich korekt z `audit-and-correction-plan.md`. Audyt i `source-identity.json` zachowują historyczny stan HEAD `f2eb8f100e706343fe379e9928c589530529bd94`; ten plik opisuje późniejszą implementację.

Worktree: `simulation-mode-consistency-20261013`, branch `codex/simulation-mode-consistency-20261013`, PR #155. Główny dirty checkout pozostaje chroniony.

## Decyzje i zakres etapów

- U01/U02: authored method z zaakceptowanej sceny; resolved execution i operation capabilities niezależne. Brak capabilities nie blokuje edycji modelu. Jawny brak/conflict nie korzysta z zachowanej siatki. Source pointer w statusie jest zgodny ze źródłem.
- U05/U08/U09: serwerowa lista readiness poszerzona o method/domain/execution oraz target pierwszego obiektu z brakującym przypisaniem. Manual bounds blokują build/run, dopuszczając naprawę modelu. Efektywna polityka `study.universe_mesh` ma pierwszeństwo. ADR 0053 zapisuje decyzję.
- U03/U04/U06/U07/U10/U12: przewodnik i ustawienia domeny wdrażane w istniejących modułach, przez resource hooks, selection guards i Apply/Revert.
- U11: nowe regresje źródłowe i browser fixture będą wykonane w CI. Realny backend oraz osobne FEM/FDM CPU/GPU receipts wymagają aktualnych źródeł i managed execution; obecnie **NOT VERIFIED**.

## Dotychczasowa kontrola nowych zmian

- `git diff --check`: PASS.
- `node scripts/check-api-hygiene.mjs` i `node scripts/check-architecture-hygiene.mjs` uruchomione z `apps/control-room`: PASS.
- `python scripts/check_repo_consistency.py`: PASS.
- Niezależny source review ROOT: comparator absent authored → authored null wymagał korekty; naprawiony i objęty regresjami. Manual Universe dociera do backendowych bramek admission.
- Nowe unit/DOM/Rust testy: przygotowane; lokalnie nieuruchamiane zgodnie z zakazem kompilacji testów. Wynik poprzedniego HEAD nie obejmuje nowych zmian.

## Wykonanie i retencja

Read-only `local_runner_cli.py container-status`: exit 1, `Container profile allow-list mismatch`. Nie zmieniono konfiguracji runnera ani profilu i nie zastosowano zastępczej trasy FEM. Ocena przed buildem: dla tego nowego etapu brak zakończonych execution/staging/runtime do usunięcia. Zachowane wcześniejsze evidence `storage/evidence/simulation-mode-consistency-20261013/f2eb8f100`, cache przyrostowy i runtime użytkownika. Storage rozwiązuje resolver do `C:/git/fullmag/storage`; na 2026-10-13 dostępne około 25 GB. Retencja globalna nie jest obsługiwana jako scoped plan tego etapu, zatem nie wykonano kasowania.

## Pozostałe kroki

Dokończenie i review UI, nowy CI, browser proof, próba realnego authoring z zarządzanego Windows workspace oraz osobna ocena managed FEM, integracja PR, fast-forward chronionego mastera i cleanup dokładnego worktree. Całe R0/R1 D07 i kwalifikacja wydania nie są zamknięte.

## Etap P0 zapisany i CI

Commit `3d8a1b1ac2290ebe9f39ee8cd05521e0be5971e0`: authored method, readiness, manual admission i ADR 0053. GitHub Actions run `38424872870`, attempt 2: wszystkie osiem bramek SUCCESS, w tym Rust i browser. Cztery nowe API regresje były zielone już w attempt 1; niezmieniony `session_recovery_is_scoped_to_current_session` zwrócił 500 zamiast 200. Powtórzono wyłącznie tę bramkę bez osłabienia asercji. Nie ustalono przyczyny pierwotnego 500. React Doctor run `38424872996`: SUCCESS; wynik advisory nie dowodzi braku całego istniejącego długu.

Nowe UI obejmuje przewodnik, wspólny trwały host NewProblemDialog, potwierdzenie session collection przed nawigacją, Universe i SI. Review wykrył rozjazd SI JSON i wybranej jednostki nm; poprawka i regresja są częścią następnego etapu. Browser fixture prowadzi do Material Assignment i Universe oraz zapisuje WebGL proof. CI rozszerzono o wykonanie `fullmag-authoring manual_universe`, ponieważ wcześniejszy filtr rotated nie wykonywał tych nowych testów.

### Runner i retencja przed buildem

Rozwiązano blokadę klienta: konfiguracja hosta zawiera zatwierdzony profil runtime-v2, którego stary klient zadania nie rozpoznaje. Zweryfikowany istniejący klient `fem-script-launch-20261013` (HEAD `e0d64ca97af68e7c125fa79aaf5c3014b63a0c8d`, pliki klienta czyste) z jawnym `--worktree` tego zadania zwrócił health.ok=true, worker_alive=true, accepting_jobs=true, pustą kolejkę i brak aktywnych jobów. Konfiguracji ani źródeł obcego zadania nie zmieniono.

Na odczycie preflight dostępne 23 258 718 208 bajtów. Nie ma zakończonych danych nowego etapu wykazanych jako zbędne; cache przyrostowy, runtime użytkownika, logi i evidence pozostają zachowane. Zarządzany fem-cpu-release buduje target native `fullmag_fem`, nie targety testowe, i produkcyjny CLI/API oraz static web; lokalny zakaz kompilowania testów pozostaje w mocy. Build i realny happy path nadal NOT VERIFIED do terminalnego receiptu i obserwacji.

Finalny source review UI: brak kolejnych konkretnych P1/P2; poprawiono JSON SI → aktualna jednostka kontrolki i dodano nm round-trip regression. Odczyt runnera `/storage` zwrócił magic `1021997` (9p), poza allowlistą session persistence w managed-browser launcherze. Dlatego realna trwała sesja FEM na tej bind-mounted trasie pozostaje blokowana; nie obniżono allowlisty. Listing własnych jobów zwrócił HTTP 500; przed zleceniem builda należy ponownie sprawdzić zdrowie koordynatora.

## Odbiór UI i końcowe regresje

Etap przewodnika/domeny zapisano w `7d18c30790c9806c04fe0a6578eaee1d73bbadee`; poprawki stabilnych kluczy React, typecheck i lint w `3937ae0dbf6ed5cee5de20ae075d50240400d192`, `36f0a690c6cb1be65934a0ab9bf5e86dfcaf5276`, `eb7555520f9a2b9dcd0fbeddfda678a2a9c686b0`. Browser helper klika rzeczywisty chevron i sprawdza zwijanie przewodnika (`7ff1e394329082b8cb07eaf7e722baf67debdd12`).

Browser proof run `38428397920`, kod `36f0a690c6cb1be65934a0ab9bf5e86dfcaf5276`: Material → Material Assignment, Configure domain → Universe; revision 12, wszystkie dziewięć kroków widoczne, WebGL 703×230/context not lost. Artifact `storage/evidence/simulation-mode-consistency-20261013/36f0a690c/browser/inspector/first-run-guide-proof.json` i screenshot obok. Mock API, bez realnego backendu. Cały browser job był czerwony w dalszej sekcji; nie przedstawiać częściowego proof jako PASS całej bramki.

Po lint testy zgłosiły 15 błędów: zbiorczy target interactions błędnie rozpoznany jako object ID (poprawka produkcyjnego routingu), brak aktualnych hook/status mocks, stare etykiety i niekompletne manual fixtures oraz dokładne porównanie float. Zachowano blokady produkcyjne, uzasadnione asercje scope/ACK i regressions; nanometry są porównywane względnie. Commit `89d11672b7389555ec7a8475da1d6bf52bc185bd` zachowuje wymagany próg gestu 3 px, wydłużając rzeczywisty drag na potrzeby nowej geometrii viewportu. Finalny CI: `38430861417` (wynik do odczytu). Rust w run `38429018574` SUCCESS, obejmuje nowy jawny filtr manual_universe.

## Blokada U11 i retencja po buildzie

Zarządzane `just windows-workspace-build dev dev 3209 auto` zakończyło się exit 1, terminalny `build-status.json` state=failed (2026-10-13T16:20:18Z). CLI i API linker zwróciły LNK1104; wskazany plik `.../fallible-streaming-iterator/12026fce9666caa9/out/libfallible_streaming_iterator-12026fce9666caa9.rlib` istnieje, pełna ścieżka ma 262 znaki. Długość jest przesłanką diagnozy, nie potwierdzeniem jedynej przyczyny. Nie opublikowano runtime ani nie uruchomiono workspace na 3209. Log: `storage/builds/simulation-mode-consistency-2026-52b125f7e5d57a8c/windows-native-fdm-cpu-dev/logs/native-build-cc7cfd0a1c4a4d7da86d59ae14e76443.log`. Wrapper zapisał startowy HEAD 7d18/dirty; zamrożony snapshot 877f8e65fd8b629cd747c4f3c5f8a842e125a0320dadcaa955eb9e91f8d2cb8d zawiera tożsamość g3937 i jest granicą tej nieudanej próby.

Ocena retencji zakończonego etapu: około 17 GB wolne. Zachowano compiler/cache do diagnozy i poprawionej próby, dokładną kopię źródeł, log i terminalny status. Brak wykazanej zbędności artefaktów referencjonowanych przez ten raport; niczego nie skasowano. Ponowna ocena po naprawie ścieżki managed build i uzyskaniu zweryfikowanego pakietu.

U01–U10/U12: korekty kodu i dokumentacji wykonane; finalne źródłowe/DOM/browser bramki wymagają zielonego CI najnowszego kodu. U11: **BLOCKED / NOT VERIFIED**, brak realnego happy path oraz czterech odrębnych receipts FEM/FDM CPU/GPU. Local managed persistence 9p i failed Windows build nie upoważniają do zmiany konfiguracji hosta, obniżenia guards ani podstawienia mocka. PR #155, integracja i usunięcie worktree pozostają wstrzymane do wymaganego odbioru.

## Pokrycie audytu

| Punkt | Realizacja | Główne źródło / dowód | Granica odbioru |
|---|---|---|---|
| U01 | Authored FEM/FDM z zaakceptowanej sceny oddzielone od resolved execution. | status.rs, sessionDiscretization.ts, API create/partial-readback regressions | Nie udaje uruchomionego engine ani capabilities. |
| U02 | Loading/missing/conflict oraz diagnostyka i przejście do Study/New Problem; edycja znanej metody bez engine. | AirboxInspectorLanePanel, UniverseRootInspectorPanel, geometryLifecycleCommandContributions | Brak capabilities nadal blokuje zależne wykonanie. |
| U03 | Configure now/later po utworzeniu obu metod, nawigacja po potwierdzonym session collection scope. | NewProblemDialog, AppMenuBar; opóźniony readback DOM regression | Zachowuje ACK i chronione szkice. |
| U04 | Domyślnie rozwinięte Next steps, revision i przycisk Check readiness. | ScratchAuthoringGuide, RibbonModule | Serwer wylicza legalność; klient nie replikuje plannera. |
| U05 | Dziewięć uporządkowanych kroków z method/domain/execution i kanonicznymi blockerami. | model/readiness.rs, router_v2 API tests | Automatic przed geometrią nie otrzymuje fikcyjnych zer. |
| U06 | Akcje otwierają istniejące Inspectory/komendy; dodatkowe blockers prowadzą do diagnostics. | scratchAuthoringGuideModel i testy | Nieznany/global target pozostaje widoczny, bez fikcyjnego object ID. |
| U07 | Universe policy odróżniona od realized mesh, automatic/manual/stale/provenance. | domainPresentation, AirboxOverviewPanel | Airbox zależy od demag/plannera; FEM nie oznacza zawsze tej samej kostki. |
| U08 | Ręczne granice i ich poprawa: backend blokuje build/run dla invalid bounds/outside; model pozostaje edytowalny. | geometry.rs manual_universe, API admission regression; Airbox geometry diagnostics | Bez nowej tolerancji ani wartości naukowych. |
| U09 | Pierwszy brakujący solve object dla materiału, namagnesowania i interakcji. | readiness targets + selection routes | Nazwa/type nie włącza fizyki. |
| U10 | New simulation opisuje profil przygotowania; CPU/GPU/auto pozostają wyborem run/stage, requested vs resolved oddzielnie. | NewProblemDialog, Study execution, status bar i istniejące runtime regressions | Dwa realne przebiegi CPU→GPU nadal NOT VERIFIED. |
| U11 | API/unit/DOM i produkcyjny workspace z mockiem; podjęto managed Windows build. | CI i browser proof wskazane wyżej | **BLOCKED**: real empty FEM/FDM→mesh→solver i osobne CPU/GPU receipts. |
| U12 | Przyciski policy/mesh build/quality/visualization przez wspólną selekcję. | airboxNavigation, AirboxOverviewPanel i tests | Istniejący edit-session guard zachowany. |

Integracja: PR #155 pozostaje otwarty. Nie wykonano merge, fast-forward głównego dirty checkoutu ani cleanup worktree. Obowiązkowa managed-fem-qualification oczekuje na `[self-hosted,linux,x64,fem-managed]`; świeży odczyt GitHub repo runners total_count=0. Ten raport nie zastępuje naukowej kwalifikacji solvera.

Control Room dla kodu `89d11672b7389555ec7a8475da1d6bf52bc185bd`, run `38430861417`: SUCCESS (typecheck/lint/test/build), wszystkie 15 regresji naprawione. React Doctor advisory run `38430861391`: SUCCESS, score78; nie deklaruje 0 istniejących ostrzeżeń. Browser przeszedł nowe routes/collapse i gest3D, lecz dotychczasowa physics-scope asercja policzyła asynchroniczny `POST visualization/client-acks` jako mutację modelu. Doprecyzowano obie asercje physics guard: wyłączają tylko dokładny endpoint ACK obserwacji viewportu, nadal odrzucają wszystkie pozostałe mutacje i osobno sprawdzają niezmienioną scenę. To nie jest osłabienie guardu backendu.


Końcowy kod `6851e028a2c5bba67cc702a2dff231054baae799`: run `38432105173` — siedem bramek bootstrap SUCCESS; browser-fixture-smoke FAILURE po nowych routes, gesture i obu physics guards, przy rozwijaniu `model:object:film:magnetic-parameters`. Proof dziewięciu kroków/revision12/WebGL703×230 jest zapisany w `storage/evidence/simulation-mode-consistency-20261013/6851e028a/browser/inspector/first-run-guide-proof.json`, mock API. Nie jest to PASS całego smoke. Helper używa teraz idempotentnego produkcyjnego `ArrowRight` zamiast bezwarunkowego toggle SVG; asercja expanded pozostaje, a timeout zawiera ID i stan węzła. Odczyt źródeł nie potwierdził persistence/hydration expansion; niezmienna produkcyjna obsługa klawiatury otwiera tylko collapsed row. Nie wprowadzono hipotetycznej zmiany aplikacji jako diagnozy tego timeoutu.
