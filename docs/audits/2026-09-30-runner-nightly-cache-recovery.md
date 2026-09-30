# S12 — odtworzenie nightly po terminalnym #184

## Wynik diagnozy

Job #184 / 5718d8d81e25496b966dd77c4d0ae1b0 zakończył się failed/exit2 przed kompilacją. Receipt i worker.log: required Rust nightly toolchain is not installed. Nie ma nowych wyników FEM. Kontroler 18780 zakończył się exit1 po odczycie terminalnego failed; nie jest już aktywny.

Kapsuła przeszła pełny verify_source i miała 0 .pyc. Koordynator poprawnie utworzył katalog wykonania. Worker przeszedł weryfikację/materializację źródeł i zatrzymał się na preflight narzędzi; poprzednie dwie naprawy infrastruktury pozostają potwierdzone w swoim zakresie.

Runtime-v2 używa image sha256:f12e618dce9e212fc7f1be5947fa1e92acbb9736d4820eca892b5b7dbc2eebcc. Obraz zawiera nightly w /root/.rustup, ale worker dostaje RUSTUP_HOME=/workspace/.fullmag-rustup i montowany cache lane FEM CPU. Cache był pusty; obecność nightly w obrazie nie gwarantowała obecności w wybranej lokalizacji runtime. Nie ustalono przyczyny opróżnienia cache.

## Naprawa i dowody

- Koordynator idle, active_jobs=[]; brak aktywnego workera używającego cache. Około 34.6 GB wolnego przed odtworzeniem.
- Zweryfikowano dokładną kanoniczną ścieżkę cache i jego pustą zawartość. Skopiowano istniejące /root/.rustup z zachowanego, zakończonego workera #184 do pustego cache FEM CPU. Nie pobierano toolchainu, nie nadpisano danych ani nie zmieniono istniejących uprawnień/cache innych lane.
- Diagnostyczny kontener tego samego immutable image: użytkownik 65532:65532, network none, read-only filesystem i cache. rustup run nightly rustc -Vv exit0: 1.100.0-nightly, commit cea272fa356e94bd2ee2cadf376630aa0683867a, host x86_64-unknown-linux-gnu, LLVM 23.1.1.
- Ta kontrola potwierdza dostępność narzędzia; nie jest managed buildem, solverem ani kwalifikacją fizyki. Wszystkie dane #184 zachowano.

## Następny krok

Nowy job runtime-v2 przez tę samą kolejkę z nową kapsułą, zawierającą poprawiony odbiór kompletności modów oraz wymagany tracking_mass.rs. Jeden obserwator poza katalogiem koordynatora. Po sukcesie: Γ L2/t3 oraz DE/BV k25 L2/t3/t6/t9, kontrola residuali i artefaktów, zbieżność i porównanie. Pełny zakres S00–S12 pozostaje otwarty.
