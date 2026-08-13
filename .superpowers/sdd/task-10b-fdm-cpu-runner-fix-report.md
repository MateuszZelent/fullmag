# Raport poprawki review A2: FDM CPU multilayer runner

**Data:** 2026-08-13

**Commit bazowy review:** `0f14dd0d383e98ba168745175c875c3534ca408c`

**Lane:** FDM CPU reference

**Zakres kodu:** wyłącznie `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs`

## Naprawione findings

1. Składowe `mx`, `my`, `mz` publikowane dla każdego obiektu są teraz średnią
   ważoną momentem komórki `Ms(cell) * Vcell` po aktywnych komórkach. Globalne
   `StepStats` nadal korzysta z istniejącego `m_weight`, więc agregacja nie traci
   przestrzennie zmiennego `Ms` przed złożeniem wyników obiektów.
2. Guard wejścia `execute_reference_fdm_multilayer` odrzuca
   `transfer_kind='unsupported'` przed walidacją budżetu, aby własny komunikat
   fail-closed nie był przesłonięty. Komunikat zawiera `layer_id` i
   `magnet_name`.
3. Guard `build_multilayer_demag_runtime` również zawiera `layer_id` i
   `magnet_name` przed alokacją kerneli.

Nie zmieniono ścieżki GPU ani buforowania/reuse hot loopów wskazanego jako minor
finding.

## TDD RED -> GREEN

RED:

- `multilayer_final_step_stats_use_ms_weighted_object_means` failował na
  per-object `mx`: zwykła średnia dawała `0.5` zamiast oczekiwanego `0.25` dla
  dwóch grup komórek o różnych `Ms_i` i różnych `m_i`;
- `multilayer_runtime_rejects_unsupported_transfer_before_allocation` failował
  na braku `layer_id='layer:free'`;
- `multilayer_demag_runtime_rejects_unsupported_transfer_with_layer_identity`
  failował na braku `layer_id='layer:ref'`.

GREEN:

```text
env CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/task10b-fdm-cpu-runner-fix \
  CARGO_INCREMENTAL=0 \
  cargo test -q -p fullmag-runner --lib \
  fdm::cpu::multilayer_reference::tests::multilayer_ -- --nocapture

running 14 tests
..............
test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 829 filtered out
```

Kompilacja zgłosiła istniejące ostrzeżenia w nietkniętych plikach
`fullmag-engine`, `dispatch.rs`, `lib.rs`, `artifact_pipeline.rs` i
`charge_transport.rs`; nie były częścią tej poprawki.

## Kwalifikacja i ograniczenia

To jest skupiony dowód kontraktu Rust dla CPU reference runnera. Nie jest to
świeża kwalifikacja natywnego CUDA ani produkcyjna walidacja fizyki. Build użył
kanonicznego zewnętrznego Cargo targetu na
`/tmp/fullmag-zfn2-build`; nie usuwano żadnych danych mimo 100% zajętości
filesystemu workspace.
