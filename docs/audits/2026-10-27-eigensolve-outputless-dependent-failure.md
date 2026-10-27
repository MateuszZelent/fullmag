# Zapis wyników i projekcja awarii przed solverem

## Dowód runtime

Run `run-live-d09922a123c1f1747cf50f28727abad89e0c16e9dc371e7511a091d57f9e9268` zakończył worker kodem 1: przygotowanie storage zwróciło Permission denied; solver nie wystartował. Katalog runu ma rewizję 13: relax=failed, eigenmodes=accepted/blocked awaiting dependency resolution and runtime admission, bez attempt ani artefaktów. API nadal pokazywało running/rev6. Projekcja odrzucała brak katalogu artefaktów.

## Przyczyna i poprawka

Katalog examples ma uid/gid 1000 i tryb 0755. Worker uid65532 należy do grupy1000. Starszy signed15.zarr miał 0770, nowy katalog signed14 nie istniał. Utworzono wyłącznie dwa nowe katalogi signed14_nonzero.zarr i gamma_selected.zarr z trybem0770; nie zmieniono istniejących katalogów ani źródeł. Zapis/fsync jako rzeczywisty użytkownik kontenera przeszedł dla obu.

Ponowna aktywacja a102337352c148f1b951c80aaa2b55da została odrzucona przed mutacją przez live_retirement_busy. Nie uruchomiono nowego solvera.

Poprawka projekcji dopuszcza brak katalogu artefaktów po failed/cancelled/interrupted, gdy pozostałe zadania są wyłącznie nieuruchomione, accepted i zablokowane dokładnym kontraktem zależności. Aktywne, zakończone sukcesem, posiadające attempt albo artefakty pozostają odrzucone. Zniknięcie wcześniej obserwowanego katalogu nadal jest błędem.

## Weryfikacja i dalsza praca

Dodano regresję pozytywną oraz negatywne przypadki etapów aktywnych, sukcesu, gotowości, attempt i artefaktów. diff --check PASS. Testy Rust wymagają GitHub Actions; lokalnie ich nie kompilowano. Poprawka nie została jeszcze zbudowana w runtime. Potrzebne: CI, zarządzany build, potwierdzenie projekcji failed oraz wznowienie signed14 i osobnego Gamma. Automatyczny preflight zapisu nowych katalogów pozostaje do uzupełnienia.
