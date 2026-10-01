# Kolejka runnera — naprawa response_too_large (2026-09-30)

## Przyczyna

Widok kolejki żądał 200 rekordów historii, a następnie filtrował je w przeglądarce.
Endpoint paginated_jobs zwracał pełny payload każdego zadania, w tym duże
native_source_identity kapsuł. Przekroczenie limitu serializacji dawało HTTP 500
response_too_large. Błąd potwierdzono w przeglądarce na /ui/#queue.

## Zmiana

- Listy API v1 zwracają jawny zestaw pól tabeli; SQL nie pobiera payload.
- Pełne metadane źródła pozostają w zasobie pojedynczego zadania i bazie.
- status=queue filtruje running/queued/cancel_requested przed stronicowaniem.
- Widok pobiera kolejne strony z sort=oldest; nie pomija oczekujących zadań
  z powodu dużej historii. Niekompletna odpowiedź daje jawny błąd.
- Zachowano limit wielkości odpowiedzi i autoryzację.

## Dowody

23 interpretowane testy container_main PASS, w tym 205 dużych kapsuł,
przekroczenie granicy strony, FIFO, SQL/fallback i zachowanie pełnych metadanych.
13 interpretowanych testów container_api PASS. Suite runner-console PASS,
w tym nowa wykonywalna regresja dwóch stron FIFO i błędu niekompletności.
Przyrost zapisany i wysłany jako 9cd5d99392cba422cb7d88144e216f21eae4253f.
Obraz koordynatora: sha256:b8b00a8ef4df8de107c4bd7e0b3faba2d0ff4288f4023d72756399d72b3d653a.

## Wdrożenie — potwierdzone

Po zakończeniu aktywnego wykonania #173 i zatrzymaniu workera koordynator
został zastąpiony obrazem wskazanym wyżej. Helper zakończył się kodem 0.
Potwierdzono zdrowy API, worker_alive=true, accepting_jobs=true,
worker_error=null oraz zachowanie wszystkich siedmiu profili.
Oczekujący job #174 innego wątku został zachowany i rozpoczął wykonanie.

Weryfikacja przeglądarkowa po przeładowaniu i ponownym uwierzytelnieniu:
/ui/#queue pokazuje tabelę i aktywny job 7953ba4088a142c889c5ed9c12be7332,
profil fem-cpu-release, bez błędu response_too_large.
Dowód: C:/Users/Mateusz/.codex/visualizations/2026/09/14/01a09ee1-29e6-7d51-98f0-082c5539a0d6/de-bv-ten-20260930/runner-queue-fixed.png.
Receipt wdrożenia: deploy_queue_summary_fix.json w tym samym katalogu.
Widoczny osobny banner progu dyskowego nie jest przedmiotem tej poprawki.
Weryfikacja panelu nie stanowi walidacji wyników fizycznych buildu #173.
