# Runner: synchronizacja override zamiast odczytu zainstalowanych toolchainów

## Przyczyna i dowody

#185 i #186 są terminalne failed/exit2 przed kompilacją: rustup toolchain list przekroczył 30 s. Nie restartowano tych jobów; dane, kapsuły i receipty zachowane.

Sam odczyt poza checkoutem przechodził w około 0.03 s. Odczyt z kapsuły zawierającej rust-toolchain.toml (stable, clippy i rustfmt) dodatkowo wypisał `info: syncing channel updates for stable-x86_64-unknown-linux-gnu`. To niewłaściwy efekt uboczny kontroli dostępności nightly, wymaganej już przez wszystkie zarządzane profile. Offline próba nie odtwarza długiego oczekiwania sieciowego, ale dowodzi uruchamiania synchronizacji projektu.

Po jawnym RUSTUP_TOOLCHAIN=nightly i RUSTUP_AUTO_INSTALL=0 synchronizacja znika. Ten sam obraz workera sha256:f12e618dce9e212fc7f1be5947fa1e92acbb9736d4820eca892b5b7dbc2eebcc, użytkownik65532, ta sama kapsuła i cache read-only, brak sieci: poprawiony preflight runtime-v2 PASS w 0.02253 s, rustc -Vv exit0, nightly1.100.0 commit cea272fa356e94bd2ee2cadf376630aa0683867a. To preflight, nie build ani kwalifikacja solvera.

Oficjalne zasady: https://rust-lang.github.io/rustup/overrides.html oraz https://rust-lang.github.io/rustup/environment-variables.html. Zmienna RUSTUP_TOOLCHAIN ma priorytet nad plikiem projektu, RUSTUP_AUTO_INSTALL=0 wyłącza automatyczne instalowanie brakującego toolchainu.

## Poprawka i sprawdzenie

scripts/local_runner/build_entrypoint.py jawnie wybiera istniejący nightly i wyłącza autoinstalację w inventory, version probes i właściwym build environment. Limitu30 s nie zwiększono; brak nightly nadal kończy preflight błędem. Nie ma pobierania narzędzi ani zmiany profili, requested device czy precyzji.

RED: dwie nowe regresje wykazały brak obu zmiennych. GREEN: cały zestaw31 lekkich testów Python entrypointu PASS. Wykonano prawdziwy preflight offline w przypiętym obrazie, bez kompilowania testów natywnych.

Następnie: zbudować wyłącznie obraz koordynatora zatwierdzoną receptą just, przy potwierdzonej pauzie i pustej kolejce wymienić dokładny kontener, zachować wszystkie profile, cache i dane, potwierdzić health oraz hash trusted entrypointu. Dopiero wtedy nowy snapshot i Γ+DE/BV. Nie uznawać samego wdrożenia runnera za nowe częstotliwości.
