# P8-24 — tożsamość procesu API i odmowa starego pin

API emituje jeden UUID procesu w `x-fullmag-api-instance`. Opcjonalny pin
żądania jest sprawdzany przed handlerem; mismatch i wielokrotne wartości
dają 409 `API_INSTANCE_MISMATCH`. Nagłówek odpowiedzi jest dostępny przez CORS.
Launcher wymaga kanonicznego niezerowego UUID i odmawia attach, gdy proces
zmienił się między kontrolami przed i po starcie usługi. Nie restartuje usługi.

Dodano regresje Rust: licznik dispatch potwierdza brak wykonania handlera
dla starego i podwójnego pin; parser obejmuje brak, duplikat, nil, niekanoniczny
i niepoprawny UUID. Regresje **NOT RUN / NOT COMPILED** zgodnie z aktualnym
zakazem kompilowania testów jednostkowych. Parser rustfmt i przegląd źródeł
nie zastępują testu ani produkcyjnego typecheck/runtime.

To pierwszy krok ochrony instancji, nie ukończony attach UI. Klient HTTP,
realtime, przekazanie pin przez CLI/desktop i zachowanie reconnect pozostają
otwarte. Odmowa reuse API w CLI zostaje. Sesja testowa na 3104 jest zachowana.
Pełny build aktualnych źródeł, Windows i kwalifikacja wydania: **NOT VERIFIED**.
