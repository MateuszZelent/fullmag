# T10 — czas źródła Gamma po wznowieniu

## Zakres i przyczyna

`crates/fullmag-runner/src/spin_wave_response.rs::append_requested_spin_wave_artifacts`
odejmował dla StageLocal `time_stage.start_time_s`, czyli początek aktualnego
segmentu wykonania. Runtime zachowuje osobno pierwotny początek przebiegu.
Wznowienie mogło więc odwrócić fazę sinusa lub ponownie uruchomić impuls.

Jedna linia używa teraz kanonicznej metody
`crates/fullmag-ir/src/plan.rs::TimeStageContextIR::waveform_origin_time_s`.
Metoda zachowuje fallback historycznych planów: brak osobnego origin oznacza
`start_time_s`. Gałąź Absolute nie uległa zmianie. Nie zmieniono publicznego
schematu, osi FFT, normalization, kierunku źródła ani wykonania solvera.

## Dowody i granice

- `scripts/test_gamma_waveform_origin_source.py::GammaWaveformOriginSourceTests`
  wydobywa konkretne gałęzie czasu z funkcji produkcyjnej i interpretuje
  ograniczony zestaw ich wyrażeń arytmetycznych. To nie interpreter Rust.
- Przed poprawką: 2 PASS / 2 FAIL (wznowiony sinus i impuls).
- Po poprawce: 4/4 PASS, exit 0. Przypadki dodatkowe: legacy i Absolute.
- Niezależny review rzeczywistych konsumentów i zegarów runtime: brak
  Blocker/Required. Collector jest wywoływany przez runner przed zapisem
  artefaktów zarówno w ścieżkach FDM, jak i FEM.
- Scoped `git diff --check` PASS.
- Produkcyjny `just check-cli-source` zakończony PASS/exit 0, receipt
  `0ced69f6aa4846e6911b546165fabb5f` w resolverowym profilu
  `windows-api-source-check/cli-source-check`; sesja `91708` terminalna.
  Kontrola typów produkcyjnego CLI i runnera nie wykonuje collectora ani FFT.

Nie kompilowano testów jednostkowych Rust. Nie wykonano solvera, nowego
LLG/Relax, wznowionego run ani kwalifikacji FFT/CPU/GPU. Nie restartowano
workspace użytkownika. Niedomknięte pozostają kierunek źródła, ogólna
podatność, równowaga/osiowość Gamma, pełna nota/mapa 0920 i T00–T18.
Zależny WIP 0920/checkpointu CI nie należy do tego osobnego przyrostu.
