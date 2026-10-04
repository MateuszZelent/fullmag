# P3/P5 — jawny timeout procesu accepted worker

Data checkpointu: 26.09.2026. Baza źródeł przed zmianą:
`c0f2c1de150cb579875f725abce066c56aec6520` na `master`.

## Zakres przyrostu

Supervisor accepted workera wymaga teraz dodatniego
`--worker-timeout-seconds`. Deadline jest mierzony zegarem monotonicznym.
Supervisor odprowadza `stdout` i `stderr` równolegle, aby pełne potoki nie
zablokowały procesu. Po przekroczeniu deadline wysyła żądanie zakończenia,
czeka na potwierdzony exit i dopiero potem rekoncyliuje journal, inbox,
completion barrier oraz lease.

Jeżeli proces zdąży zakończyć się pomiędzy `try_wait` i próbą zakończenia,
supervisor ponownie odczytuje status i traktuje wynik jako zwykły exit. Nie
oznacza takiego przypadku jako timeoutu.

Timeout przed wejściem w trwały side effect zapisuje retryable failure i
zwalnia dokładny lease. Niejednoznaczny pending effect nadal zachowuje lease do
osobnej rekoncyliacji. Trwały sukces może zostać odzyskany nawet wtedy, gdy
proces przekroczył deadline podczas końcowej odpowiedzi.

## Dowód TDD i zarządzana weryfikacja

Regresja została dodana przed implementacją. Pierwszy zarządzany przebieg był
czerwony, ponieważ brakowało obserwatora potomka z deadline:

`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-api-source-check\api-accepted-supervisor-tests\b4845d4ec82247a8b0513fd8c7480ccb\receipt.json`

Końcowy przebieg po obsłudze wyścigu zakończenia procesu:

`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-api-source-check\api-accepted-supervisor-tests\c5ffb7ab7d474215b81bf6d40021e1b2\receipt.json`

Wynik: **PASS, 6/6**, `source_changed_during_run=false`. Test timeoutu
uruchamia rzeczywisty proces potomny, wymusza deadline 100 ms, potwierdza
niezerowy status i zakończenie przed pięcioma sekundami.

Dodatkowa kontrola `just check-api-source`: **PASS**, receipt
`e34ddbc71cdd4a89b79abf6d54e7d018`, `source_changed_during_run=false`.

## Granica dowodu

Checkpoint dowodzi kontroli czasu życia rzeczywistego procesu przez testowy
supervisor oraz utrzymuje wcześniejsze regresje trwałej rekoncyliacji. Nie jest
jeszcze pełnym E2E dwóch zbudowanych binariów nad accepted store. Nie dowodzi
heartbeatów, operator cancel, retry orchestration, orphan recovery, zwolnienia
VRAM ani kwalifikacji FDM/FEM CPU/GPU.
