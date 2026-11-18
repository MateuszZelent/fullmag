# Poprawki regionalnej fizyki — stan 2026-11-06

Baza: `914c04ac93b64d16268c62978b44b155c0609f10`, branch
`codex/regional-physics-fixes-20261106`. Ponowne pobranie `origin/master`
6 listopada potwierdziło tę samą bazę. Integracja obejmuje commit, PR i merge
po przejściu wymaganych kontroli; status wykonania podano poniżej.
Commit implementacji: `9afb8ef25ae241c221bdb7e04d328b6cf5f71589`.
PR: [#415](https://github.com/MateuszZelent/fullmag/pull/415).
Ten zapis dokumentuje stan przed otrzymaniem wyników CI; bieżący wynik
integracji i kontrole konkretnego HEAD są w PR oraz rejestrze zadania.
Poprzedni worktree `fdm-unbounded-regions-20261101` został usunięty; jego poprawki
są na `master` przez PR #376 i #379. Ten raport rozróżnia istniejące poprawki
od nowej zmiany oraz kontrolę źródeł od wykonania solvera.

## Siedem ustaleń poprzedniego review

| Punkt | Bieżący stan kodu |
|---|---|
| FDM CPU: pole magnetoelastyczne używało bazowego `Ms` | Poprawione wcześniej: `h_mel_single_with_ms`, ścieżki AoS/SoA używają lokalnego `Ms`. Istnieją testy ilorazu pól i gradientu energii. |
| CUDA: brak energii magnetoelastycznej | Poprawione wcześniej: redukcja, `E_total` wszystkich pięciu integratorów w fp32/fp64 i `eden_total`. Poprawiono też czynnik 2 dla odkształcenia ścinającego. |
| FEM: DG0 `Ms` + SOT używało skalaru | Planer i native jawnie odrzucają tę kombinację. Nie jest to implementacja SOT z DG0. |
| FEM: transport ignorował przestrzenne `Ms` | Planer, preflight runnera i natywny callback odrzucają niewspierane `Ms`; stałe pole równe skalarowi pozostaje dopuszczone. |
| FDM: globalne `mx/my/mz` bez wag `Ms` | Poprawione wcześniej: CPU i CUDA używają wag `Ms_i V`; przypadek 400/800 kA/m i przeciwnych `m` daje -1/3. |
| FEM: średnia obiektu ignorowała DG0 `Ms` | Wcześniej dodano właściwe wagi. W tej zmianie redukcja obiektu wybiera dokładne elementy, bez wnioskowania o własności z węzłów. |
| C ABI CUDA: późny bind transportu omijał bramkę `alpha` | Poprawione wcześniej w publicznym wrapperze `fullmag_fdm_context_bind_gpu_transport_v1`, przed wywołaniem wewnętrznego bindera. |

## Nowa zmiana

Dodano `fullmag_fem_backend_average_m_for_elements_f64` i odpowiadającą deklarację
Rust FFI. Redukcja korzysta z tego samego wzoru P1/DG0 co średnia globalna.
Duplikaty indeksów mają semantykę zbioru; nieaktywne elementy nie wnoszą wkładu.
Błędne indeksy i puste wejście ABI są odrzucane, a zerowy moment wybranego
nieaktywnego zbioru daje wektor zerowy. ABI wymaga DG0 `Ms`.

Runner rozwiązuje selektory markerów i zakresów elementów przed normalizacją
markerów do atrybutów native. Scala części jednego obiektu i odrzuca brakujące
markery zamiast liczyć średnią dla niepełnego obiektu. Wyszukiwanie markerów
korzysta z indeksu zbudowanego raz. Natywna redukcja odwiedza wybrane elementy:
sortowanie/deduplikacja O(K log K), a sprawdzanie aktywności w uporządkowanej
liście runtime O(K log A), gdzie K to rozmiar wyboru, A — liczba aktywnych
elementów. Ogólny nieuporządkowany adapter zachowuje poprawną ścieżkę liniowego
wyszukiwania. Brak zmiany gorących pętli pola i integratorów.

Zwykły planer rozdziela węzły między obiektami. Nie wykazano błędnej średniej
w standardowej ścieżce publicznego DSL po poprzedniej poprawce; pozostała luka
dotyczyła ogólnego kontraktu native/planu ze wspólnymi węzłami.

Nowy test natywny zawiera centralny tetraedr i cztery otaczające tetraedry.
Oczekiwana średnia dla czterech wybranych elementów to 0,5; domknięcie po ich
węzłach obejmuje również obcy centralny element i daje 9/14. Jeden zewnętrzny
element ma dwukrotną objętość, więc test wykrywa również brak wagi objętościowej.
Testy obejmują też duplikaty, nieaktywne elementy i walidację wejścia. Pięć testów selektorów Rust
uruchamia krok CI `Check FEM CPU runner contracts`.
Ten krok sprawdza też kompilację ścieżki Rust z `fem-native`. Istniejąca recepta
GitHub Actions `run_modal_cabi_contract.py` buduje i uruchamia teraz kontrakty
`fem_element_quadrature_material_contract` oraz `fem_element_dg0_average_contract`.
Drugi uruchamia binarium workflow z `--object-averages-only`; pełny test dynamiki
DG0 nadal wymaga MFEM i pozostaje osobną, niezmienioną bramką.
Jest to jawna bramka ABI/CPU bez MFEM/CUDA, nie kwalifikacja produkcyjnego
runtime ani parytetu urządzenia.

Nowa kontrola kompilacji `fem-native --tests` ujawniła niepełne warunki
kompilacji wariantu CPU. Wspólny kod zapisu pól i harmonogramów, provenance
relaksacji/transportu oraz rozdzielenia energii DMI udostępniono również dla
`fem-native`. Odtworzono brakujące importy i pomocniczą geometrię testów po
wcześniejszym wydzieleniu kodeka artefaktów. Nie zmieniono bramek dostępności
CUDA/MFEM ani nie dodano cichego fallbacku CPU.

## Weryfikacja i blokada

- 20 testów Python narzędzia parytetu: PASS na bieżącej bazie.
- 41 testów walidatora dokumentacji: PASS.
- Walidacja source-map noty 0104, format nowego modułu Rust i `git diff --check`: PASS.
- Review źródeł: poprawiono znalezione milczące pomijanie brakujących markerów
  oraz rozdzielono test średnich ABI od pełnego testu dynamiki wymagającego MFEM.
- Niezależny rachunek geometrii: dodatnie wyznaczniki 1, 2, 1, 1, 1;
  średnie 1/2 i 9/14: PASS.
- Pierwszy przebieg CI skompilował i zlinkował bibliotekę oraz testy natywne.
  Test ABI wykrył, że import planu bez MFEM pomijał `use_consistent_mass`.
  Poprawiono import samej polityki i dodano regresję potwierdzającą dalsze
  odrzucanie kroków czasowych bez MFEM oraz planów DG0 z lumped mass.
  Ponowny przebieg na `8738a43e2c39d7084768a8c6ce6cd3b557b3f496`:
  osiem kontraktów natywnych oraz pięć testów selektorów Rust PASS.
  Kontrola `fem-native --tests` wykryła opisane wyżej braki warunków kompilacji;
  wynik kolejnego CI po ich poprawce: **NOT VERIFIED**.
- Nie uruchamiano `cargo test`, `just test` ani kompilacji na hoście.

Zarządzany launcher uruchomiono dla grupy
`fullmag-worktree-fullmag-eacd36ead0850e14`, z dostępem CPU i bez uruchamiania
symulacji. Przygotowanie toolchaina i obrazów development zakończyło się
sukcesem. Próba development `21294d69464d4230a09574eb9ea79649` zakończyła się
stanem `outcome-unknown-resources-retained`: Docker odmówił utworzenia sieci,
ponieważ `all predefined address pools have been fully subnetted`.
Backend aplikacji nie wystartował; lokalna kompilacja aplikacji i runtime pozostają
**NOT VERIFIED**. Nie wolno utożsamiać budowy obrazów z kompilacją aplikacji.

Zachowano wolumen operacyjny
`fullmag-build-control-fullmag-worktree-fullmag-eacd36ead0850e14-d1d0af56f6a4b3d0`
oraz przygotowane obrazy do ponowienia próby. Odczyt wolumenu przed kontrolą
uzgodnienia stanu wyniósł 748 206 bajtów. Nie powstał pakiet aplikacji ani
wynik symulacji wymagający retencji. Nie usuwano cudzych sieci ani wolumenów.

Kontrola bez zapisu przez `docker_volume_network_failure_reconcile.py`,
z przypiętymi skrótami receipt/compose i identyfikatorem silnika, zakończyła się
odmową: `Foreign container changed during initial Desktop bind isolation`.
Pierwsza kontrola nie wykonywała `--apply`. Wznowiona próba z `--apply`
powtórzyła tę samą odmowę przed publikacją terminalnego receiptu.
Zachowano oryginalny helper
`fullmag-control-21294d69464d4230a09574eb9ea79649`, jego blokadę i stan
`outcome-unknown-resources-retained`; nie wymuszano zwolnienia blokady.
Rejestr worktree `fullmag-eacd36ead0850e14` po pierwszym etapie oznaczono
`blocked`, a następnie wznowiono dla autoryzowanej integracji przez PR.
Lokalny runtime i cleanup nadal wymagają rozwiązania opisanej blokady.

Następny krok: rozwiązać brak puli podsieci Dockera, uzgodnić stan zachowanej
próby narzędziem projektu przy stabilnym stanie współdzielonych zasobów
i wykonać build oraz analityczne sprawdzenie FEM CPU. Pełna kwalifikacja
wszystkich oddziaływań CPU/GPU nadal wymaga odrębnych dowodów wykonania;
ten zestaw poprawek jej nie zastępuje.
