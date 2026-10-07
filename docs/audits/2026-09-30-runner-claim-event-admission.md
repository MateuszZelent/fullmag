# Runner — zdarzenie przejęcia przed bramką admission

## Potwierdzony błąd

Application._execute_next emitował job_claimed z komunikatem rozpoczęcia
kompilacji na podstawie next_queued, jeszcze przed execute_build. Przy braku
miejsca wykonawca zwracał waiting_for_disk bez przejęcia lease. Każda kolejna
iteracja powtarzała więc pozorny start. Zaobserwowano to dla #179, zanim
użytkownik zwolnił miejsce. Sam log job_claimed nie dowodził kompilacji.

## Poprawka

Wykonawca wywołuje opcjonalny on_claim dopiero po udanym queue.claim.
Callback otrzymuje wyłącznie job_id i profile; nie otrzymuje lease_token ani
payloadu. Koordynator zapisuje przejęcie do przygotowania, nie rozpoczęcie
kompilatora. expected_job_id wiąże wybór w koordynatorze z faktycznym claim.
Bramki miejsca, istniejących kontenerów, blokady i FIFO pozostają zachowane.

## Dowody

Dwie regresje koordynatora wykazały przed poprawką: fałszywe zdarzenie podczas
waiting_for_disk oraz brak callbacku rzeczywistego claim. Po poprawce pełne
25 testów container_main i 17 testów build_executor PASS (42 razem).
Regresja wykonawcy potwierdza kolejność claim przed powiadomieniem, ograniczony
payload callbacku i zachowanie blocked przy błędzie przygotowania.
To lekkie testy Python; nie kompilowano testów jednostkowych Rust ani FEM.
Scoped diff check exit0; przegląd diff objął oba właściciele i regresje.

## Runtime i brakujące bramki

Poprawka nie została wdrożona do aktywnego koordynatora. #179 zachowuje swój
snapshot i obraz; worker został potwierdzony przez Docker ps/top, nadal pracuje.
Wymiana koordynatora jest dozwolona wyłącznie po spełnieniu procedury pustego
aktywnego slotu; dowód produkcyjnych zdarzeń po wdrożeniu pozostaje NOT VERIFIED.
Nie zmieniano kolejki, jobów, cache ani wyników. Brak nowych wyników solvera.
