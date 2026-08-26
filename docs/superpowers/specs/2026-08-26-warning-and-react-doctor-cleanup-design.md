# Porządkowanie warningów i React Doctor — projekt

## Cel

Doprowadzić aktywne ścieżki Fullmag do kompilacji i kontroli jakości bez nieobsłużonych warningów oraz wyzerować diagnozy React Doctor w Control Room, zachowując istniejące kontrakty fizyczne, runtime, API, OpenAPI i wizualizację 3D.

## Stan wyjściowy

Świeży baseline z checkoutu `/home/kkingstoun/git/fullmag/fullmag` wykazał:

- `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/warnings-baseline CARGO_INCREMENTAL=0 just check` kończy się kodem 0, ale emituje 105 warningów: `fullmag-quantities` 1, `fullmag-engine` 1, `fullmag-runner` 32, `fullmag-api` 62 i `fullmag-cli` 9.
- `cargo +nightly check --workspace --exclude fullmag-desktop --all-targets` także kończy się kodem 0 i ujawnia dodatkowe ostrzeżenia targetów testowych.
- Wykaz z załącznika jest niepełny dla wcześniejszego builda feature’owego: nie zawiera wszystkich 77 warningów `fullmag-runner`. Feature’y CUDA/FEM muszą zostać zweryfikowane osobno przez recepty zarządzane w `justfile`.
- `pnpm --dir apps/control-room typecheck` i `pnpm --dir apps/control-room lint` kończą się kodem 0.
- `pnpm --dir apps/control-room test` ma 6 nieudanych plików, 3 nieudane testy oraz 3 nieudane suite’y; są to baseline failures, które muszą zostać rozdzielone od nowych regresji.
- React Doctor `0.9.12`, schema v3, wykazał 401 diagnoz w 134 plikach: 1 error i 400 warningów. Największe grupy to `only-export-components` (239), `js-combine-iterations` (29), `prefer-tag-over-role` (26) i `no-array-index-as-key` (24). Skan lokalny używał `--no-supply-chain`; ta część nie jest kwalifikowana jako wykonana.

## Ochrona istniejącego checkoutu

Zmiany już obecne w worktree nie należą do tego projektu i pozostają nietknięte, w szczególności:

- istniejące zmiany w `crates/fullmag-plan/*`, dokumentacji fizyki/specyfikacji i `packages/fullmag-py/*`;
- równoległe zmiany w `crates/fullmag-runner/src/lib.rs`;
- równoległe zmiany w `backends/fem/*`, `justfile`, `.orig` i testach Python;
- zmiana submodułu `external_solvers/3`.

Nie będzie resetowania, czyszczenia, stashowania, commitowania ani pushowania. Zmiany tej pracy pozostaną możliwe do odróżnienia od dirty tree przez osobne, małe diffy i ledger postępu.

## Podejście

Praca jest podzielona na trzy niezależne, testowalne fale:

1. Rust — warningi ścieżki domyślnej i targetów testowych.
2. C++/CUDA — warningi aktywnych źródeł native, z kompilacją przez zarządzane recepty `just`.
3. React Doctor — diagnozy Control Room, od błędów poprawności i dostępności do reguł wydajnościowych i utrzymaniowych.

Każdy warning zostanie przypisany do jednej kategorii:

- nieużywany lokalny symbol, import, binding lub `mut` — usunięcie albo poprawa nazwy;
- kod zależny od feature/testu — poprawienie granicy `cfg`, aby kod nie był kompilowany poza swoim właścicielem;
- kontrakt schema/OpenAPI/serde — zachowanie kontraktu z lokalnym, uzasadnionym `#[expect(..., reason = ...)]` tylko wtedy, gdy test potwierdzi refleksyjne lub dynamiczne użycie;
- realnie niepodłączona integracja — podłączenie do istniejącego właściciela albo usunięcie po potwierdzeniu braku publicznego kontraktu;
- błąd jakości lub lifecycle — naprawa przyczyny i regresja, bez wyłączenia reguły.

Globalne `allow(dead_code)`, wyciszenie całych plików, obniżenie progów testów i dopisywanie wyjątków React Doctor bez dowodu nie są akceptowanymi rozwiązaniami.

## Projekt fali Rust

### Zakres

Pierwsza fala obejmuje ostrzeżenia z:

- `crates/fullmag-quantities/src/step_data.rs`;
- `crates/fullmag-engine/src/fdm/cpu/fields.rs`;
- `crates/fullmag-runner/src/dispatch.rs`, `artifact_pipeline.rs`, `constraints/activation.rs`, `interactive_runtime.rs`, `relaxation.rs`, `relaxation/provenance.rs`, `time_events.rs`, `fdm/cpu/*`, `fdm/gpu/cuda/*`, `solvers/fdm/execute.rs`;
- `crates/fullmag-api/src/analysis/skyrmion_trajectory.rs` i `schemas/*`;
- `crates/fullmag-cli/src/step_utils.rs`, `interactive_runtime_host.rs`, `live_workspace.rs`, `types.rs`.

### Zasady zmian

- Importy, nieużywane argumenty i zbędne `mut` zostaną usunięte lub poprawione na poziomie właściciela.
- Helpery testowe i alternatywne realizacje zostaną objęte właściwym `cfg(test)` lub istniejącym feature’em, nie nowym ukrytym fallbackiem.
- Schematy OpenAPI frozen-spins/session oraz decimal serde zostaną sprawdzone przeciwko generatorowi OpenAPI i deserializacji; ostrzeżenie może pozostać tylko jako lokalne oczekiwanie z opisem kontraktu.
- `analysis/skyrmion_trajectory.rs`, publikacja transportu GPU i rollback FEM zostaną potraktowane jako potencjalnie nieukończone integracje. Nie zostanie dopisana arbitralna semantyka fizyczna. Dla każdego przypadku musi powstać dowód: aktywny caller, test kontraktowy, istniejący publiczny kontrakt albo bezpieczne usunięcie kodu.
- Nie będzie przenoszenia fizyki do `dispatch.rs`, `Context`, `mfem_bridge.cpp`, generycznego `execute.rs` ani generycznego `mod.rs`.

### Testy i bramy

Każda grupa zmian zaczyna się od testu lub istniejącej reprodukcji warninga, a kończy focused checkiem. Po fali:

- `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/warnings-final CARGO_INCREMENTAL=0 just check`;
- rozszerzony check `--all-targets`;
- odpowiednie testy pakietów i `cargo fmt --check` dla dotkniętych plików;
- brak warningów w aktywnym lane Rust, z `-D warnings` uruchamianym dopiero po usunięciu i sklasyfikowaniu baseline’u.

## Projekt fali C++/CUDA

Najpierw zostanie odczytany aktualny `justfile`, a następnie uruchomiona zostanie właściwa recepta zarządzanego runtime’u. Nie będzie hostowego builda FEM jako dowodu.

Weryfikacja obejmie źródła projektu, z rozdzieleniem od MFEM, hypre, libCEED, CUDA i innych zależności zewnętrznych. Dla aktywnych targetów zostaną ustalone faktyczne flagi kompilatora i naprawione tylko warningi należące do kodu Fullmag. Warningi third-party nie będą ukrywane przez globalne zmiany flag.

Po zmianach użyte zostaną, zależnie od wykrytego lane’u, `just rebuild-fem-runtime`, `just ensure-managed-fem-runtime`, `just fem-gpu-headless`, `just verify-fem-time-domain-native-contract` oraz istniejące recepty kwalifikacyjne. Sam sukces kompilacji nie będzie przedstawiany jako dowód poprawności fizyki ani runtime GPU.

## Projekt fali React Doctor

### Stabilny skan

Wersja zostanie przypięta do lockfile (`react-doctor 0.9.12`) i będzie używana identycznie dla baseline’u, skanu pośredniego i końcowego. Pełny lokalny skan Control Room musi mieć schema v3 i obejmować projekt `apps/control-room`. Supply-chain scan pozostaje osobno oznaczony jako pominięty, dopóki nie ma zgody na wysłanie metadanych do usługi zewnętrznej.

Istniejące wyjątki w `apps/control-room/doctor.config.json` nie będą rozszerzane. Po naprawie każdej grupy zostanie sprawdzone, czy wyjątek nadal jest potrzebny; usunięcie wyjątku wymaga przejścia tej reguły bez konfiguracji wyjątku i regresji testowej.

### Kolejność napraw

1. `no-ref-current-in-render`, dangerous sinks, błędy hooków oraz problemy accessibility.
2. Problemy semantyki interakcji: nested interactive, label/control, role zamiast elementu HTML.
3. Stabilność renderu i lifecycle: `only-export-components`, kontekst, refs, R3F object construction i `useEffectEvent`.
4. Klucze list, mapy, cache property access i łączenie iteracji — tylko gdy zachowują kolejność, identyfikatory i semantics danych naukowych.
5. Reguły organizacji modułów, importów, URL lifecycle i pozostałe utrzymaniowe diagnozy.

Dla `only-export-components` preferowanym rozwiązaniem będzie przeniesienie funkcji, stałych i typów do modułów `.ts`, pozostawiając w `.tsx` wyłącznie eksporty komponentów oraz wymagane przez framework entrypoints. Dla tablic zostaną użyte stabilne identyfikatory domenowe; indeks tablicy nie będzie zastępowany przypadkowym stringiem.

Zmiany w viewportach 3D zachowają istniejącą jakość renderowania, lifecycle WebGL i semantykę zasobów. Każda dotknięta ścieżka R3F/WebGL będzie miała browser smoke z widocznym canvasem, nieutraconym kontekstem i niezerowym drawing bufferem.

### Testy i bramy

Po każdej grupie:

- focused Vitest lub test kontraktowy reprodukujący diagnozę;
- `pnpm --dir apps/control-room typecheck`;
- `pnpm --dir apps/control-room lint` z `--max-warnings=0`;
- odpowiedni browser smoke dla zmian viewportu;
- pinned React Doctor scan `--scope changed`, a po zakończeniu pełny scan `--scope full`.

Baseline failures testów zostaną naprawione tylko w ich rzeczywistym właścicielu i z osobną reprodukcją. Nie będzie zmieniania asercji wyłącznie po to, aby zamaskować zmianę zachowania.

## Kryteria akceptacji

Projekt jest zakończony dopiero, gdy:

1. aktywne default/all-target Rust lanes nie emitują warningów, a test targets mają jawnie sprawdzony wynik;
2. aktywne C++/CUDA source lanes przechodzą właściwą managed receptę bez warningów należących do Fullmag;
3. React Doctor `0.9.12` nie zwraca nieobsłużonych diagnoz w bieżącej polityce konfiguracji;
4. typecheck i ESLint Control Room przechodzą z zerową liczbą warningów;
5. baseline failures testów są naprawione albo jawnie zakwalifikowane jako zewnętrzny blocker z dowodem;
6. dotknięte zmiany mają focused testy, a końcowe testy nie wprowadzają regresji w API, OpenAPI, runtime ani viewportach;
7. końcowy raport rozróżnia source proof, test proof, managed native proof, browser proof i ewentualnie pominięty supply-chain scan.

## Poza zakresem tej specyfikacji

Nie obejmuje ona pełnego wdrożenia mypy, clang-tidy, cppcheck, rust quality policy ani kolejnej fali formatowania Python/C++/Rust. Te narzędzia mogą zostać dodane po wyzerowaniu warningów i React Doctor, ale nie będą wprowadzane jako niepowiązane refaktoryzacje.
