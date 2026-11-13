# P22 — blokada materializacji katalogu przez odczyt, 2026-11-13

Rzeczywisty test materiału zapisał Ms=600000 A/m, Aex=1e-11 J/m, alpha=0.5 i kliknął PPM → Run This Stage dla A dokładnie raz. Browser QA `c42c0b5935ff4311aee1147339a61c4d` nie otrzymał odpowiedzi w 20 s. Nie ponowiono Compute.

## Dowód runtime

- Nowy RunIntent: `run-live-6b6552a649f3cd4a87309ab4b48a1f0c83c0a884636a180dea580f83e0bf8cd0`, raw SHA-256 `dddf6f4c67202a38f43dd0aa8ae9492866b142b452afa138b10a2891e554e62d`.
- Klient: `study:relax:1794584570782:eddae8c0-f2ae-46fe-9f57-d676e0eba121`; command ID `fm-5886f18f-96bd-481b-a064-726f49b22d07` jest zapisany w request receipt intentu. Publiczny command detail zwracał 404; journal revision=0.
- Log API z 15:43:31.891824 UTC: accepted RunIntent survived derived preparation failure; przyczyną było `publish run catalog: session store writer is busy`. Zapis katalogu już miał 30-sekundowe ponawianie.
- 16:03:50 UTC: kernel wykazał `FLOCK ADVISORY READ`, PID 19170 (`fullmag-api`), FD18, dev08:50/inode3446098 dla właściwego WRITER.lock. Nie stwierdzono wtedy blokady WRITE. Diagnostyczny rekord ostatniego writera nie wskazuje właściciela aktualnej shared blokady.
- Jednorazowy POST istniejącego endpointu materialization dla tego samego project/run zwrócił HTTP409 `run_store_busy` po 34.016 s. RunIntent zachował hash. Nadal nie było katalogu ani start_release; ta operacja nie uruchamia Compute.

## Przyczyna i zmiana

`SessionStore::read_run_catalog` czeka do 2 s na katalog, jeżeli RunIntent już istnieje. Projekcja live oraz loader performance wywoływały tę metodę po nabyciu shared ReadTransaction. Logi pokazywały około 2004 ms w core_snapshot i performance_load. Katalog nie może zostać zapisany przez prawidłowego writera, dopóki taki shared snapshot istnieje. Powtarzane odczyty mogą więc zagłodzić publikację, na którą same czekają.

Nowe `read_run_catalog_in_transaction` wiąże guard z tym samym rootem, waliduje identyfikator i wykonuje istniejący jednorazowy odczyt katalogu. Brak katalogu zwraca natychmiast dla tego snapshotu; kolejne odświeżenie może przeczytać wynik po zwolnieniu guarda. Zwykłe, niezafencowane `read_run_catalog` zachowuje ponawianie. Zmieniono cztery ścieżki: live projection, performance, saved inspection i historical export.

Regresje obejmują brak katalogu przy trwałym intencie, późniejszą publikację po dropie guarda, foreign-store guard, uszkodzony/obcy katalog oraz odroczenie projekcji z poprawnym zwolnieniem shared fence. Testy nie polegają na krótkiej ściennej granicy czasu. CI jawnie uruchamia dwa testy fenced catalog read, a istniejący filtr modułu projekcji obejmuje trzeci test.

## Stan w chwili zapisu

Diff i parser Rust przeszły. Kompilacja/testy nowej poprawki oraz odbiór zmienionej binarki pozostają **NOT VERIFIED** do zakończenia zarządzanych bramek. Bieżąca binarka runtime to `9f146c29bb682a465bb8bf6e0c672efa4d84b7c6`; zmiana źródłowa nie została do niej dołączona.

Naprawa źródła nie stanowi jeszcze recovery zachowanego intentu. Normalny managed stop/recreate nie kwalifikuje obecnego waiting_for_compute z brakiem katalogu; dalsza ścieżka musi zachować request receipt, sesję, scenę, intent i brak start_release. Nie wolno uznać braku command detail za dowód, że żadna trwała mutacja nie zaszła, ani tworzyć drugiego Study w celu ukrycia tej operacji. Pełny odbiór materiał → ponowienie A, pozostałe scenariusze UI i S46 nadal są otwarte.
