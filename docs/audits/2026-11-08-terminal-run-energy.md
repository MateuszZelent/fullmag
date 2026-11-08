# P22 — energia końcowa Study i odtworzenie obserwacji

**Odbiór tego fragmentu: PASS.** Po zarządzanej przebudowie przywrócono dokładnie
pierwotny ukończony run. Wszystkie siedem energii w podsumowaniu API zgadza się
ze skalarem i oryginalnym CAS. Przeglądarka pokazuje końcową energię również po
`page.reload`. Nie uruchomiono ponownie Solve. Pełny plan P01–P22 pozostaje otwarty.

## Potwierdzona diagnoza

Na binarce DEV `1dd24b9d7f154589bcfbce453fe16b66`, w runie
`run-live-80341a3d441dbbd46cc6e5b7ea93ab3186d3620fbc60e8cf4c8472af0aad911f`,
wszystkie trzy etapy Relax mają status Completed. Katalog publikuje po jednym
`accepted_terminal_scalar_stats` i stanie końcowym dla każdego etapu. Nie ma
osobnych autorskich artefaktów typu `scalar` / `E_total`.

| Etap | Algorytm | Krok | Czas (s) | Energia (J) |
| --- | --- | --- | --- | --- |
| A | llg_overdamped | 10 | 1e-12 | -3.8091117500317753e-23 |
| B | projected_gradient_bb | 1 | 0 | -4.441013650519438e-22 |
| C | nonlinear_cg | 1 | 0 | -8.45818845777564e-22 |

Hashe CAS wszystkich trzech rekordów statystyk oraz ich stanów są zgodne.
Katalog tasku przypina właściwy artefakt, próbę i epokę. Bieżąca seria skalarów
wskazuje C i tę samą energię, ale `simulation/runs/current` pomija energię końcową.
Zapisane publiczne zasoby i piny są w [JSON](2026-11-08-terminal-run-energy.json).

`live_accepted_projection::load_durable_projection_with_journal` odzyskuje
kwalifikowane `terminal_stats`, lecz `apply_projection` zapisuje energię do
RunManifest wyłącznie z opcjonalnego `latest_total_energy`. To rozdzielenie
pozostawia podsumowanie niepełne, mimo poprawnej publikacji statystyk.

Przejście od 10 / 1 ps do 1 / 0 w tym konkretnym Study wynika z przejścia z A
do C. Nie stanowi dowodu błędu zegara LLG. Nie wolno zastępować końcowego zegara
maksimum liczników lub czasu wszystkich etapów.

## Kontrakt poprawki i odbioru

Podsumowanie końcowe ma czerpać energię całkowitą i jej składowe z tego samego
kwalifikowanego rekordu, z którego projektowana jest końcowa seria skalarów.
Źródłem pozostaje najpóźniejszy etap w kolejności Study. Walidacja tasku,
próby, epoki, stanu i zegara nie może zostać osłabiona. Starsze/obce/niejednoznaczne
piny nie mogą udawać bieżącej energii. Ścieżka historycznych autorskich skalarów
pozostaje obsługiwana w jej dotychczasowym legalnym zakresie.

Wymagane: regresja przed poprawką, testy projektora i API, zarządzany build,
porównanie bieżącego runu ze skalarem i CAS oraz odbiór telemetrii po reloadzie.
Stan testów źródeł i odbioru runtime rozdziela checkpoint poniżej. Ten raport nie
zamyka pozostałej macierzy S01–S46, FEM, FDM GPU ani multilayer.

## Checkpoint testów i rzeczywistego odtworzenia

Regresja na `e289f234…` dała oczekiwany RED: 49 testów projektora PASS,
1 FAIL (brak końcowego czasu). Poprawka `72cdcff7…` publikuje czas i siedem
energii z kwalifikowanych `terminal_stats`, zachowując dotychczasowy fallback
skalara. [Całe CI po poprawce](https://github.com/MateuszZelent/fullmag/actions/runs/42523229951)
przeszło. Odczytany log indywidualnie potwierdza obie nowe regresje energii,
regresję IR S46 oraz dodatnie regresje P10/P11. Test S46 nie zastępuje
odbioru resetu regionu w UI ani trwałego eksportu/importu.

Zarządzany stop `081b3bfe…` zachował oryginalny terminalny run i wykonał drain.
Próba odtworzenia `f1cdcd2…` skompilowała backend, ale odczytała domyślny
budżet 64 GiB zamiast pierwotnych 32 GiB, przez co native runtime poprawnie
odrzucił niezgodną politykę. Nie zmieniono ledgeru. Istniejący wariant
`cold-memory-increase-restore-stored-budget` przeszedł preview i apply:
`a7315ac2…`, pierwotne 8 CPU / 32 GiB, zero aktywnych rezerwacji.
Diagnostyczny backend został poprawnie zatrzymany.

Brakującą kompozycję dodano w `a9a74ad4…`: istniejący typowany journal
cold-budget jest ponownie uwierzytelniany, a oryginalny dowód obserwacji zostaje
powiązany z dokładnym parentem, grupą, obrazem, historycznym drainem i pinami runu.
Historyczny config dowodu pozostaje odrębny od bieżącego configu Compose.
Nie powstaje uprawnienie do Start ani zmiana polityki ledgeru.
[CI tej zmiany](https://github.com/MateuszZelent/fullmag/actions/runs/42528065717)
przeszło; logi potwierdzają testy Rust oraz 108 testów fixture recovery.

Próba recreate `121c7ce7…`, z jawnym budżetem backendu 8 CPU / 32 GiB i frontendu
2 CPU / 8 GiB, zakończyła się sukcesem. DEV `1c4f1dba…` działa na kodzie
`a9a74ad4…` na porcie 3243. Odczyt Docker inspect potwierdził budżety kontenerów.
Nie zmieniono oryginalnych plików run_intent/run_catalog ani sześciu blobów CAS.
W magazynie nadal są trzy receipty wyjścia workerów, po jednym na etap.

| Dowód | Wynik |
| --- | --- |
| API: siedem energii vs oryginalne statystyki CAS | PASS, końcowe E = -8.45818845777564e-22 J |
| Zgodność task / attempt / epoch / stage C i zegara | PASS, krok 1, czas 0 s |
| Bieżący run i trzy ukończone etapy po odtworzeniu | PASS, oryginalny run i sesja |
| Przeglądarka przed i po `page.reload` | PASS, API/run/scalar/summary zgodne, footer `-8.458188e-22 J` |
| Canvas po reloadzie | PASS, WebGL2, kontekst zachowany, drawing buffer 617 × 495 |
| Błędy konsoli, strony, HTTP i transportu | 0 |
| Niedozwolone mutacje podczas odbioru | Brak; sześć GET i jeden niemutujący client ACK |

Odbiór przeglądarki ma receipt `d7adaac858a74c77b1dcee59b6e302a6`.
Wcześniejszy `dbff0ae6…` zachowano jako failed-confirmed: sonda loopback wygasła
przed uruchomieniem przeglądarki podczas zimnej kompilacji frontendu. Po rozgrzaniu
frontendu świeża próba przeszła bez restartu i bez zmiany limitów. Szczegółowe
odczyty przed/po reloadzie zapisano w JSON obok raportu.

## Poprawka po review i granice dowodów

Review wykryło, że cold revalidation nie odczytuje ponownie oryginalnego pliku
`terminal-session-preflight.json`. Test przechodzący przez `revalidate_context`
potwierdził RED dla zmiany i usunięcia pliku. Dodano sprawdzenie surowego hasha
z proof i kanonicznego hasha z oryginalnego stopu. Cztery suite'y fixture mają
teraz 109 PASS. Historyczny plik rzeczywistej grupy odczytano ponownie i oba piny
są zgodne. Moduł cold-budget oraz jego uwierzytelniany hash pozostały bez zmian.
Ten dodatkowy guard działa w launcherze hosta; nie wymaga zmiany binarki native.
Powyższy odbiór runtime/przeglądarki dotyczy jawnie kodu `a9a74ad4…`.

Chroniona sesja użytkownika na 3242 pozostaje dostępna; nie wykonywano w niej
Solve, Stop ani restartu. Odbiór używa FDM CPU/double i programowego WebGL2
SwiftShader. Etapy mają `converged=false`, kończą się limitem kroków. Nie jest to
kwalifikacja naukowa ani dowód działania FDM GPU, FEM CPU/GPU lub multilayer.
S46 nadal wymaga rzeczywistego resetu regionu, disable/enable i eksportu/importu
w UI. Ten raport nie zamyka macierzy S01–S46 ani całego P22.
