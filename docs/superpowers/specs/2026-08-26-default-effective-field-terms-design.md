# Domyślne termy pola efektywnego i jawne wyłączanie — projekt

## Cel

Exchange i demagnetyzacja pozostają domyślnymi składnikami pola efektywnego. Użytkownik nie zapisuje redundantnych wywołań włączających. Jawny opt-out otrzymuje czytelne API `disable_exchange()` i `disable_demag()`.

## Potwierdzony stan wyjściowy

- `_WorldState` inicjalizuje `_exchange_enabled=True` i `_demag_enabled=True`.
- Lowering dodaje `Exchange()` i `Demag()` do `ProblemIR.energy_terms`, jeśli odpowiadająca flaga nie została jawnie wyłączona.
- `Aex` jest parametrem materiałowym używanym przez aktywny term exchange; samo przypisanie `Aex` nie jest osobnym przełącznikiem termu.
- `study.demag(realization=...)` konfiguruje aktywny domyślnie term demag.
- Obecny eksporter zapisuje redundantne `study.exchange(enabled=True)` i `study.demag(enabled=True, ...)`.

## Zatwierdzony kontrakt

1. `exchange` i `demag` są aktywne domyślnie.
2. Brak `study.exchange()` nigdy nie oznacza wyłączenia exchange.
3. `study.disable_exchange()` i `fm.disable_exchange()` jawnie usuwają exchange z `ProblemIR.energy_terms`.
4. `study.disable_demag()` i `fm.disable_demag()` jawnie usuwają demag z `ProblemIR.energy_terms`.
5. `study.exchange(enabled=False)` i `study.demag(enabled=False)` pozostają kompatybilne.
6. `study.demag(realization=...)` pozostaje konfiguracją realizacji aktywnego termu.
7. Eksport pomija domyślne włączenie. Dla wyłączenia emituje `study.disable_*()`. Jeśli wyłączony demag ma zachowaną konfigurację realizacji, eksporter najpierw zapisuje konfigurację, a następnie jawne wyłączenie.

## Granice architektoniczne

`ProblemIR` i planner pozostają term-based: aktywny term jest obecny w `energy_terms`, wyłączony jest nieobecny. SceneDocument zachowuje istniejące booleany `exchange_enabled` i `demag_enabled`, dlatego OpenAPI, capability vocabulary i backendy nie wymagają migracji.

## Weryfikacja

- test domyślnego `exchange + demag` bez wywołań włączających;
- test nowych metod flat/study i nieobecności termów po wyłączeniu;
- test eksportu: pominięte domyślne enable, `disable_*()` dla false, zachowana realizacja demag;
- test przykładu bimeronu: brak jawnego `study.exchange()`, obecne `Aex`, aktywne termy po materializacji;
- walidacja kanonicznej noty fizycznej i jej source map.

