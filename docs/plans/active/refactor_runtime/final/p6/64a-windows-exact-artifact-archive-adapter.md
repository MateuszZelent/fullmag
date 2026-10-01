# P6-64a — adapter archiwum dla dokładnego artefaktu Linux na Windows

Data: 01.10.2026. Baza: `36cfab887c3d7c03d314d41f5e2cdb30ecd39f43`.
Status: implementacja i 31 testów Python PASS; ponowny niezależny review
bez otwartych P0/P1. Weryfikacja źródeł nie zamyka bramki runtime.
Wykonanie kontenera i archive roundtrip **NOT VERIFIED**.
Read-only `docker image inspect` potwierdził lokalną dostępność dokładnego
obrazu buildu 192; nie jest to dowód wykonania programu.

Driver P6-61 wybierał poprawny Linux ELF z receiptu buildu, ale próbował
uruchomić go bezpośrednio przez Windows Popen. Dodano adapter istniejącej
usługi Compose FEM CPU. Linux zachowuje dotychczasową ścieżkę.

Obraz jest wybierany po dokładnym immutable digest z managed receipt.
Binary i jego biblioteki są montowane z artefaktów read-only, repozytorium
również read-only, a wszystkie nowe mounty zapisu są prywatnymi katalogami
próby pod kanonicznym storage. Ścieżki poleceń są mapowane wyłącznie z runu.
CPU intent jest jawny; managed GPU fallback jest wyłączony.

Adapter wymusza `network_mode: none`, wyłącza odziedziczone profile Compose
i sprawdza wszystkie mounty względem prywatnej mapy. Akceptuje rzeczywisty
wpis Docker Desktop `Networks={"none": {...}}` tylko z pustymi adresami
i gatewayami. Odrzuca obce sieci i mounty oraz obsługuje oba warianty
ścieżek Docker Desktop. Odczyt istniejącego kontenera potwierdził format
metadanych; nie uruchamiano ani nie zmieniano tego kontenera.

Receipt zapisuje container ID, image, mounty i wynik wykonania. Timeout oraz
niejednoznaczna obserwacja zachowują kontener i dowody jako
`observation_pending`. Brakujące lub niekodowalne logi nie uruchamiają
cleanupu. Rozdzielono logi launchera i polecenia wewnątrz kontenera. Usunięcie dotyczy
wyłącznie terminalnego kontenera utworzonego dla konkretnej komendy;
nie usuwa źródłowego store, cache, runów ani innych kontenerów.

Dodano regresje containment, dokładnego readonly mountu, CPU/fallback flags,
odrzucania mutable image i obcego image ID. Razem 31 testów Python PASS;
Rust/C++ unit tests nie były kompilowane. Próba rzeczywista nadal wymaga
zaakceptowanego, zimnego FEM store z przypiętym snapshotem i spełnienia
bramek zasobów. Kwalifikacja naukowa pozostaje **NOT VERIFIED**.

P6-64 transport zapisano i wysłano na master:
`36cfab887c3d7c03d314d41f5e2cdb30ecd39f43`.
Hook React Doctor wykazał dwie uwagi await-in-loop w istniejących funkcjach
bounded Range readera. Obie pętle istnieją w rodzicu commita; zachowują
sekwencyjny budżet i weryfikację zakresów. Nie zmieniano ich w tym etapie.

Pełny plan P0–P8 pozostaje aktywny: około 49%, P6 około 52%.
Transport HTTP, przestrzenny viewport, pomiar pamięci, runtime, nauka i release
pozostają oddzielnymi bramkami.
