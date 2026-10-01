# Prompt dla ChatGPT PRO: niezależny audyt eigensolve Fullmag

Przeprowadź głęboki, niezależny audyt fizyczny, numeryczny i implementacyjny
solvera eigensolve Fullmag oraz jego ścieżki nonzero-k. Pracuj tylko do odczytu:
nie zmieniaj kodu, nie commituj, nie uruchamiaj produkcyjnych buildów. Odpowiedz
po polsku. Nie potwierdzaj wcześniejszych ustaleń bez sprawdzenia ich w źródłach.

## Najpierw ustal dokładny przedmiot audytu

Repozytorium: https://github.com/MateuszZelent/fullmag
Branch: `codex/eigensolve-dispersion-plan-20260912`.
Audytuj commit wskazany przez użytkownika; jeśli nie podał SHA, rozwiąż HEAD
tego brancha i zapisz pełny SHA w raporcie. Czytaj pliki z tego refa, a nie
z domyślnego mastera. Badaj aktualną implementację i historię zmian tego
brancha względem wspólnego przodka z masterem. Nie ograniczaj audytu do
ostatniego commita, który jest snapshotem wcześniejszych lokalnych zmian.
Kod i dokumentacja worktree zostały opublikowane na tym branchu na potrzeby
audytu. Lokalne ignorowane buildy, storage, dane hosta i logi nie są częścią
GitHuba. Jeżeli nie masz dostępu do plików repozytorium, powiedz to wprost;
nie wydawaj werdyktu o kodzie na podstawie samego promptu.

Celem jest realizacja całego planu:
`docs/superpowers/plans/2026-09-12-eigensolve-dispersion-implementation-status.md`.
Sprawdź również plan nonzero-k i DE minimal validation, wcześniejsze audyty,
`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` z source-map,
`docs/specs/frequency-domain-artifacts-v2.md`, ADR-y eigensolve oraz backend
masterplan. Dokumentację traktuj jako wymagania i deklaracje; zgodność musi
wynikać z kodu i odpowiednich dowodów wykonania.

## Prześledź pełny przepływ danych i operatorów

1. Publiczny Python w `packages/fullmag-py`, przykład
   `examples/fem_de_smoke_numeric.py`, lowering do ProblemIR, planner
   `crates/fullmag-plan/src/fem.rs`, runtime oraz ABI w `fullmag-fem-sys`.
2. `crates/fullmag-runner/src/fem/eigen_*.rs`, `fem_eigen.rs`, equilibrium
   identity/certificates, shared-domain geometry/reduction i native_fem.
3. Natywne MFEM/SLEPc w `backends/fem/cpu/frequency_domain/`, szczególnie
   `modal/floquet_modal_solver.cpp`, `floquet_airbox_operator.cpp`,
   `operators/poisson_airbox_shared_domain.cpp`,
   `poisson_airbox_schur_matshell.cpp`, `production_cpu_modal_eigen.cpp`;
   wspólne operatory, tangent frame i accepted equilibrium fields.
4. Wybór modów, normalizacja, MAC/consistent P1 mass, śledzenie gałęzi,
   degeneracje i subspaces w `crates/fullmag-runner/src/eigen/`.
5. Produkcja i walidacja CSV/JSON/binary modes oraz metadanych źródeł;
   `scripts/run_de_100nm_pilot.py`, `validate_de_smoke_rows.py`,
   `verify_fem_frequency_domain_eigen_artifacts.py`, kontroler signed-k,
   kolektory i narzędzia porównania/wykresów.
6. API wyników w fullmag-api i frontend Control Room: rzeczywisty wektor k,
   częstotliwości/jednostki, selekcja sample/mode/branch, wykresy,
   ukryte filtry i błędne etykiety świadczące o sukcesie.

## Audyt fizyczny i matematyczny

Wyprowadź niezależnie liniaryzację LLG wokół m0 oraz rzeczywistą postać
operatora/pencil stosowaną w kodzie. Sprawdź znak i, konwencję czasu, gamma0,
mu0, pola H versus B, rad/s versus Hz/GHz i czynniki 2π. Sprawdź równowagę,
normalizację m0, rzutowanie na tangent plane, transport lokalnych baz,
longitudinal static curvature i pochodne wszystkich deklarowanych interakcji.
Szczególnie Ku: signed/zero coefficients, normalizacja i u versus -u,
jednostki, Hessian, field decomposition, podwójne liczenie i przypadek
anisotropy-only. Oddziel zaimplementowane, legalnie dostępne i wykonane
interakcje; sprawdź także damping, DMI, przestrzenne materiały i wymagania
pełnego planu bez przyjmowania ich wsparcia na podstawie obecności parametrów.

Demag ma pozostać częścią problemu. Sprawdź słabą postać potencjału,
znaki divergence/gradient, powierzchnie/interface, gauge/nullspace,
magnetic versus scalar DOFs, consistent mass, Schur complement i jego
zgodność z pełnym descriptor systemem. Sprawdź, czy rekonstruowane phi oraz
H_demag spełniają oryginalne równania, a nie tylko zredukowany residual.

Dla Blocha/Floqueta zweryfikuj faktyczną konwencję
`exp_minus_i_k_dot_delta_r`, obie strony szwu, rogi, klasy przechodnie,
certyfikat v6, packing magnetic-prefix i sentinel powietrza. Sprawdź
niezależność numeracji od kierunku/kolejności par i spójność tej samej mapy
w assemblerze, certyfikacie i payloadzie natywnym. Nie traktuj k-samplingu
jako dowodu implementacji k-dependent dynamic demag.

## Audyt numeryczny

Sprawdź SLEPc EPS, shift-invert, KSP/preconditioner, skalowanie bloków,
condition numbers, normy/units residuali, zewnętrzne versus wewnętrzne
kryteria zbieżności, deflation, duplikaty, spurious/negative-frequency modes,
niekompletne okna oraz certyfikację każdego przyjętego wektora. Oceniaj
zasadność progu1e-8 w oryginalnych blokach, zamiast automatycznie uznawać go
za właściwy lub proponować jego rozluźnienie. Zgodność wartości własnej
z dense oracle nie dowodzi poprawności wektora. Dense nie może stać się
ukrytym produkcyjnym fallbackiem. Oceń zbieżność siatki, liczby warstw,
airboxu, liczby modów, dokładności solve i identyfikacji tej samej gałęzi.

Sprawdź hardkodowane wartości, ścieżki, klucze schematów, próg f/k,
wybór mode_0000, sztuczne odbicia/uzupełnienia punktów, fallbacki CPU/GPU,
stale caches i nieadekwatne testy. Testy źródeł, runtime, fizyka i browser
muszą mieć odrębne statusy. Testy natywne są obecnie objęte zakazem kompilacji
w AGENTS.md; nie obchodź tego zakazu. Jeżeli masz narzędzia, dopuszczalne są
lekkie kontrole Python i niezależne małe rachunki analityczne/diagnostyczne.

## Szczególne przypadki i znane obszary do niezależnego sprawdzenia

- Film40×40×10nm, M0 i B0 w osi x; Ms800kA/m, A13pJ/m,
  B0=0.1T, gamma0=221100m/(A s), demag, periodyczność x/y,
  air padding2µm na stronę. DE: k w osi y, BV: k w osi x.
- Nowa seria: 0,±2,±5,±10,±15,±20,±25rad/µm dla obu geometrii,
  osobne rzeczywiste runy L2/t3, oraz4kontrole k25 na6/9warstwach.
  Sprawdź nie tylko f(+k) versus f(-k), ale profil i branch identification.
  Symetrię wolno przewidywać dla tego symetrycznego modelu bez DMI;
  nie wolno wymuszać jej przez odbicie częstotliwości lub uogólniać na inne modele.
- Referencje P00 i coupled cosine-Galerkin N32 są oddzielnymi oracle;
  sprawdź ich równania, założenia, stabilność i zbieżność. Nie traktuj
  approximacji P00 jako dokładnej referencji dla każdej geometrii.
- Archiwalne punkty pochodzą z różnych źródeł/siatek i nie certyfikują
  obecnego snapshotu. Job187 build succeeded, lecz Gamma pilot zawiódł
  przed częstotliwościami z producer_reduction_map_not_canonical.
  Nowy managed runtime-v2 job188 zakończył build sukcesem; kontroler
  rozpoczął gamma-t3. W chwili checkpointu opisanego w dokumentacji brak nowej częstotliwości
  z tej serii. Sam succeeded joba nie dowodzi poprawności solve ani fizyki.
- Minimum-root map fix, Ku field certificatesv2 i canonical versus raw
  material identity wymagają niezależnej oceny. Planowana migracja
  equilibrium_artifact.v8 / LinearizationState.v7 i poprawny brak-H_eff
  z niezerową krzywizną pozostają do sprawdzenia, nie zakładaj ich ukończenia.
- Po capture188 zmieniono lokalne kolektory/provenance; branch zawiera
  te aktualne poprawki w historii brancha. Porównaj źródła buildu188 z audytowanym commitem,
  zanim przypiszesz wynik wykonania do aktualnych plików.

## Oczekiwany wynik

A. Krótki werdykt: czy obecna implementacja może policzyć wiarygodną
   dyspersję DE/BV z demagiem, w jakim zakresie i czego nie dowiedziono.
B. Tabela findings P0/P1/P2/P3: konkretna ścieżka+symbol+linia w audytowanym commicie,
   warunek reprodukcji, błędne zachowanie/równanie, wpływ fizyczny lub
   numeryczny, zalecana poprawka oraz regresja/eksperyment, który ją dowiedzie.
   Oddziel potwierdzone błędy, hipotezy i brakujące dowody; nie wymyślaj błędów
   dla kompletności. Istotne twierdzenia oprzyj na kodzie lub pierwotnych źródłach.
C. Macierz S00–S12 wobec planu: implemented/source-tested/runtime-verified/
   scientifically-qualified/browser-verified/not-verified, z dowodami
   i konkretnymi brakami. Nie zastępuj jej arbitralnym procentem.
D. Lista długu technicznego i hardkodowań, w kolejności ryzyka.
E. Minimalny plan napraw i eksperymentów: najpierw poprawnyGamma,
   potem rzeczywiste±k DE/BV, kontrola residuali/profili/seam/phi/H_demag,
   zbieżność, porównanie z analityką i COMSOL A1, pełny zakres interakcji,
   GPU/frontend oraz integracja. Zachowaj pełny cel; nie zawężaj do
   najłatwiejszego działającego przypadku.
F. Wskaż pliki i dowody, których nie otrzymałeś. Nie deklaruj zgodności
   z COMSOL, fizycznej kwalifikacji lub poprawności GPU bez odpowiednich danych.

Zapisz raport jako Markdown. Zwróć również pełny raport w odpowiedzi. Nie implementuj poprawek w ramach audytu.
