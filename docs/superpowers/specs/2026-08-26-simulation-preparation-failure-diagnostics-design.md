# Modal diagnostyczny błędu przygotowania symulacji

## Cel

Control Room ma po błędzie przygotowania symulacji natychmiast wyjaśnić użytkownikowi, co się stało i co może zrobić, a jednocześnie udostępnić kompletny, bezpieczny pakiet diagnostyczny do skopiowania i przekazania dalej.

## Wybrany wariant

Rozwijamy istniejący `SimulationPreparationFailureDialog`, zamiast tworzyć drugi globalny system błędów lub przenosić odpowiedzialność do Diagnostic Recorder. Dialog pozostaje automatycznie otwierany raz dla nowej tożsamości błędu i można go ponownie otworzyć z ekranu przygotowania.

Modal ma trzy warstwy:

1. **Podsumowanie użytkowe** — etap, krótkie podsumowanie oraz surowy detail pokazany jako dokładny komunikat runtime.
2. **Rozpoznane przyczyny** — każdy `failed_predicates=[...]` otrzymuje nazwę, zalecane działanie i zachowany identyfikator techniczny. Nieznane predykaty pozostają widoczne z bezpiecznym fallbackiem. Parser ma twarde limity liczby i długości pozycji.
3. **Pełne dane techniczne** — zwijana sekcja zawiera bezpieczną projekcję JSON: identyfikator przygotowania i rewizję, kod błędu, correlation ID, requested/resolved execution, wszystkie etapy z czasami i postępem oraz maksymalnie 200 ostatnich wpisów logu.

Przycisk `Copy full diagnostic report` kopiuje zawsze cały JSON, niezależnie od tego, czy sekcja techniczna jest rozwinięta. Sukces i porażka kopiowania są ogłaszane przez dostępny status i kopiowanie można ponowić.

## Przepływ danych

Źródłem prawdy pozostaje zasób HTTP v2 `simulation/preparation`. Realtime jedynie unieważnia zasób. Model prezentacyjny interpretuje predykaty, serializer tworzy ograniczoną bezpieczną projekcję, a komponent wyłącznie renderuje model i wywołuje przekazaną akcję kopiowania. Nie dodajemy endpointu, bezpośredniego `fetch()` ani alternatywnego formatu backendu.

## Prywatność i ograniczenia

Serializer stosuje allowlistę pól i nie kopiuje nieznanych właściwości odpowiedzi, ścieżek hosta ani sekretów. Surowy `failure.detail` i wpisy logu są zachowane, ponieważ są częścią jawnego kontraktu diagnostycznego runtime. Lista logów i lista interpretowanych predykatów pozostają ograniczone.

## Weryfikacja

- test modelu: znane, wielokrotne, nieznane i ograniczone predykaty;
- test montowanego modala: automatyczne otwarcie, dokładna przyczyna, zalecane działanie, kontekst wykonania, pełny raport i ponowne otwarcie;
- test kopiowania: pełny JSON, correlation ID, etapy i log tail, bez pól spoza allowlisty;
- test błędu schowka i ponowienia;
- focused Vitest, typecheck, React Doctor dla zmienionych plików oraz wizualny smoke w przeglądarce.

## Poza zakresem

Modal nie zastępuje pełnego Diagnostic Recorder, nie pobiera nowych zasobów i nie próbuje tłumaczyć dowolnych wyjątków runtime. Nowe predykaty mogą otrzymywać kolejne mapowania bez zmiany kontraktu API.
