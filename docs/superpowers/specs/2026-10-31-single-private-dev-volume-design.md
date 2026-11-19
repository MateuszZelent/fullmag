# Jeden prywatny wolumen Docker DEV na worktree

Decyzja użytkownika 31.10.2026: stały jeden prywatny wolumen grupy, ponowne użycie podczas przebudowy i usuwanie zastąpionych danych. Zachowujemy globalne współdzielone zależności oraz dane użytkownika. Nowe żądanie obejmuje również sprawdzenie zbędnych zależności kompilacji od storage hosta.

Używamy kanonicznego BuildControl.volume (już stabilnego dla grupy). Istniejący root control, operation.lock, active i namespace registry pozostają na miejscu. Oddzielne mounty volume-subpath: private/backend, private/frontend i private/ledger. Frontend nie dostaje rootu control. Nowe grupy nie tworzą dawnych backend-build/frontend/group-ledger named volumes.

Wolumen i unit pakietów są niezależne od toolchainu/profilu/input digest. Zmienna tożsamość ABI nadal określa zgodność cache i pakietów. Przed faktyczną kompilacją czyścimy wyłącznie znane compiler outputs; package cache hit nie kompiluje i nie czyści. Publikacja jest transakcyjna, zachowuje current i jeden bezpośredni rollback. Nie kasujemy ostatniego dobrego pakietu przed sukcesem następcy. Po atomowej publikacji i ponownej walidacji samowystarczalnego pakietu usuwamy te same compiler outputs pod tą samą blokadą; błąd pozostawia jedną generację do diagnozy, do następnego prebuild.

Stare receipt/mounty pozostają czytelne w recovery. Nowe rendery wybierają jawnie group-volume-v1. Wycofanie usuwa zakwalifikowane compiler/dependency cache oraz namespace pakietów; zachowuje control, ledger, źródła i logi w tym samym wolumenie. Nie usuwa całego wolumenu grupy. Migracje wymagają zatrzymanej, rozpoznanej grupy i dowodów braku konsumentów. Ta zmiana nie przenosi automatycznie obcych środowisk.

Kompilacja obrazów zależy od Git/source i Docker, nie od markerów filesystemu storage hosta. Uruchomienie API nadal wymaga jawnej lokalizacji sesji, projektów i wyników. Rozróżniamy weryfikację źródeł, guest helperów Linux oraz rzeczywistego Docker/runtime; brak runtime receipt to NOT VERIFIED.
