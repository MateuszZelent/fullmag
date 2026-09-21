# FDM CUDA — audyt zegara czasowego napędu antenowego (2026-09-21)

## Zakres

Ten raport dokumentuje korektę zgodności czasu w ścieżce `FDM CUDA` dla
rozwiązanej bazy pola anteny oraz regionalnego pola napędzającego. Nie jest to
raport kwalifikacji GPU ani dowód poprawności całego LLG.

## Kontrakt fizyczny

Natywny backend FDM rozpoczyna każdą egzekucję z `t_solver = 0`. Kanoniczny
czas fizyczny sceny jest więc

\[
t_{abs}=t_{solver}+t_{stage,start}.
\]

Dla napędu o originie `stage_local` argument waveformu wynosi

\[
\tau=t_{solver},
\]

a dla `absolute`

\[
\tau=t_{abs}=t_{solver}+t_{stage,start}.
\]

Przed poprawką Rust przekazywał `stage_start_time_s` do natywnego pola jako
przesunięcie również dla `stage_local`, mimo że zegar CUDA był już lokalny.
Przy niezerowym początku etapu dawało to złą fazę sinusoidy oraz błędne
położenie czasowe impulsu/sinc.

## Zmienione właścicielstwa

| Warstwa | Zmiana |
|---|---|
| `crates/fullmag-runner/src/fdm/gpu/cuda/mod.rs` | Jedno mapowanie `t_solver → t_abs` i `t_solver → τ` dla Rust-side obserwabli i energii. |
| `.../cuda/artifacts.rs` | Snapshot i preview `H_ant` rekonstruują pole z czasu fizycznego, nie z surowego zegara native. |
| `.../cuda/execute.rs` | Rekonstrukcja energii napędu używa identycznego `τ` jak RHS. |
| `backends/fdm/gpu/cuda/runtime/context.cu` | Native upload koduje `time_offset_s=0` dla `stage_local` oraz `-stage_start_time_s` dla `absolute`; kernel nadal liczy `t_solver-time_offset_s`. |
| `backends/fdm/include/context.hpp` | Komentarz storage opisuje lokalny zegar native i kanoniczne mapowanie. |

## Regresje źródłowe

Dodano testy dla:

- mapowania `stage_local` i `absolute` przy `stage_start_time_s = 10 s`,
- snapshotu sinusoidalnego `H_ant` po restarcie etapu (`t_solver=0.25` i
  `0.75 s`), który musi odpowiadać odpowiednio fazie `0.25` i `0.75 s` czasu
  fizycznego.

## Weryfikacja wykonana w tej sesji

- odczyt diffu i inspekcja wszystkich miejsc użycia zegara CUDA — OK;
- parser/rustfmt dla zmienionych plików Rust — do wykonania po finalnym patchu;
- kompilacja testów Rust/CUDA, kontenerowy build i test GPU — celowo
  niewykonane: bieżące zasady repo zabraniają kompilowania testów jednostkowych,
  a ta sesja nie ma skonfigurowanego `Fullmag_build_runner`.

Brak kwalifikacji GPU pozostaje jawny. Następna bramka to kontenerowy test
double-precision: identyczny resolved basis, sinus z fazą i niezerowym
`stage_start_time_s`, porównanie RHS/energii/snapshotu `H_ant` między CPU
reference i CUDA oraz osobna kontrola wszystkich wspieranych integratorów.

## Granice nieciągłych waveformów

Ten sam patch dodaje do CUDA harmonogram granic `pulse` i PWL. Obejmuje on
zarówno `field_drives`, jak i aktywne rozwiązane napędy antenowe. Krok stały
oraz cel adaptacyjnego batcha są przycinane w fizycznym czasie przed
przekazaniem do native integratora; sinusoidy i sinc nie generują sztucznych
zdarzeń. Test helpera sprawdza wspólne granice regionalnego napędu i
rozwiązanego napędu antenowego. To nadal test kontraktu źródłowego, a nie wynik
uruchomienia CUDA.
