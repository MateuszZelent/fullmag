# Pełna przebudowa multilayer convolution FDM GPU — projekt wdrożenia

Data: 2026-10-25. Baza analizy: `28f4fcf5bba4387025944b8fb276c94b3eef5eb5`.
Status: **projekt zaakceptowany przez użytkownika 2026-10-25**.
[Szczegółowy plan wykonawczy](../plans/2026-10-25-fdm-gpu-multilayer-rebuild.md)
zapisano na osobne zlecenie; implementacja nie została rozpoczęta.
Powiązany [audyt FDM](../../audits/2026-10-25-fdm-gpu-multilayer-audit.md).
Dokument nie deklaruje wykonanej implementacji, parity ani kwalifikacji GPU.

## 1. Cel i decyzja użytkownika

Użytkownik wybrał „pełna implementacja” oraz „Pełna przebudowa operatora od
razu”. Oznacza to jeden docelowy operator GPU dla całego zdefiniowanego poniżej
zakresu, zamiast kończenia pracy na kwalifikacji obecnej wąskiej ścieżki D-07.
Przebudowa obejmuje descriptor, transfer, kernel pary, plan FFT, workspace,
ewaluację i połączenie z etapami integratora oraz dowodami wykonania.

Przedstawione podejścia:

| Podejście | Korzyść | Koszt / ograniczenie | Decyzja |
|---|---|---|---|
| Kwalifikacja obecnego FP64/Heun/three_d identity | Najmniejsza zmiana | Nie realizuje pełnych stosów cienkich i heterogenicznych | Odrzucone |
| Stopniowe poszerzanie obecnych ścieżek | Małe przyrosty funkcjonalności | Dłużej utrzymuje kilka sposobów wykonania i ich semantykę | Rekomendowane pierwotnie przez audytora, niewybrane |
| Pełna przebudowa operatora | Jeden kontrakt i właściciel dla pełnego zakresu | Większy zakres integracji i kwalifikacji | **Wybrane przez użytkownika** |

Pełna przebudowa nie oznacza pojedynczego ogromnego commita. Podział na
spójne, weryfikowalne fragmenty służy bezpieczeństwu integracji; żaden fragment
nie stanowi deklarowanego zakończenia zadania przed spełnieniem całego zakresu.

## 2. Zakres docelowy

Decyzje projektanta do sprawdzenia przy akceptacji:

- Oba istniejące tryby: `two_d_stack` i `three_d`, otwarte granice demag.
- Niezależne natywne rozdzielczości, extenty i grubości warstw, przesunięcia
  XYZ, nierówne odstępy; maski dla geometrii dopuszczanych przez aktualny
  planner i poprawny brak wkładu komórek nieaktywnych.
- Operator identity oraz overlap push/pull; objętościowa wzajemność i
  zachowanie momentu. Transform grid jest scratch, nie dodatkowym magnesem.
- Jednorodne i przestrzennie zmienne Ms/A/alpha, o ile wejście ma poprawny
  istniejący kontrakt materiałowy; plan nie kończy się pozostawieniem obecnej
  odmowy `ms_field` jako substytutu pełnej obsługi.
- FP64 jako pierwszy oracle GPU; następnie FP32 ze zdefiniowanymi redukcjami
  FP64, osobnym realization ID i osobną kwalifikacją.
- Rezydentna ewaluacja demag w każdym etapie fixed Heun/RK4/RK23.
  Włączenie pozostałych obecnie publicznych integratorów multilayer wymaga
  osobnych zadań transakcji/adaptacji/historii, uwzględnionych w docelowej
  macierzy zamiast cichego fallbacku; szczegóły w sekcji 7.
- Pola, energie, checkpoint, accepted state, materiały i Frozen Spins mają
  jednoznaczną tożsamość warstwy; istniejące outputy i Compute Fields działają
  dla nowego engine. Target-only Airbox pozostaje osobnym operatorem obserwacji.
- Brak hostowych FFT i transferów całego m/H wewnątrz nieobserwowanego kroku.
  Inicjalizacja i jawne snapshoty wyjściowe mogą wykonywać transfery.

Granice tej przebudowy: nie dodaje nowej fizyki PBC/Floquet, inter-body
exchange/RKKY, transportu, termiki, nowych modeli DMI ani nowych typów
geometrii. Ich istniejące legalne kombinacje muszą zostać zachowane, a
nielegalne jawnie odrzucone. Nowe wsparcie tych zjawisk wymaga osobnego
kontraktu naukowego; słowo „pełna” dotyczy operatora multilayer w powyższym
zakresie, nie całego katalogu przyszłej fizyki FDM. FEM nie jest przebudowywany.

## 3. Niezmienne kontrakty

Kanoniczna nota `docs/physics/0421-fdm-multilayer-convolution-demag.md`
pozostaje właścicielem równań i jednostek. Przed implementacją należy ją
uzgodnić z finalnym descriptorem, zaktualizować source-map i bramki naukowe.
Nie kopiować niekwalifikowanego transferu CUDA ani tworzyć drugiej definicji
fizyki w runnerze.

Operator musi zachować:

1. Kierunek pary target-minus-source, sześć składowych tensora i objętościową
   wzajemność dla różnych rozmiarów komórek.
2. M = Ms razy m, lokalne Ms, jawne jednostki A/m i energie w J.
3. Push normalizowany pełną objętością scratch, pull jako objętościowy adjoint
   tych samych nakładek, maski oraz konwersję gęstości scratch → kernel-cell.
4. W `two_d_stack` jedna próbka transformacji Z nie zeruje fizycznej grubości.
5. Energię i pole pochodzące z tego samego dyskretnego operatora; niezależny
   test pochodnej energii i brak nieuzasadnionego podwójnego liczenia par.
6. Requested strategy/device/precision zachowane obok resolved i executed;
   forced GPU bez ukrytego CPU lub single-grid fallbacku.
7. Pełną walidację deskryptorów, rozmiarów, skończoności i budżetu przed
   alokacją oraz brak akceptacji niefinitywnego kroku.

## 4. Docelowa architektura i własność

| Właściciel | Odpowiedzialność | Istniejący punkt zaczepienia |
|---|---|---|
| Python/IR | Requested intent i round-trip, bez publicznej nowej równoległej DSL | `packages/fullmag-py/src/fullmag/model/discretization.py`, `fullmag-ir` |
| Planner | Jeden wynik wyboru realizacji, certyfikat, descriptor warstw/transferu/par i admission pamięci | `crates/fullmag-plan/src/fdm.rs` |
| Referencja CPU | Sprawdzenie operatora i niezależne porównania, nie hot loop produkcji GPU | `fullmag-fdm-demag/src/{descriptors,transfer,shifted_kernel}.rs`, `fullmag-engine` |
| Native ABI | Wersjonowany immutable plan, zgodność layoutu i provenance; walidacja rozmiarów | `backends/fdm/api/plan_ingestion_v2.cpp`, istniejące nagłówki ABI, `fullmag-fdm-sys` |
| Native GPU demag | Plan/workspace, transfer, FFT, akumulacja par i H_demag | `backends/fdm/gpu/cuda/demag/` |
| Native integratory | Wywołanie tego operatora na poprawnym stanie/etapie/czasie, rollback | `backends/fdm/gpu/cuda/integrators/`, istniejący kontroler transakcji |
| Runner | Orkiestracja, ABI, snapshoty i artefakty, bez własnej fizyki/FFT | `crates/fullmag-runner/src/fdm/gpu/cuda/` |
| Resource/observation | Rewizje, accepted-state identity, binary data plane i per-layer output | Obecni konsumenci FDM i target-only Airbox |

Nazwy nowych typów robocze: `MultilayerDemagPlan`, `MultilayerDemagWorkspace`,
`LayerTransferMap`, `PairKernelCatalog`. Można je dostosować do istniejącego
stylu; odpowiedzialności są wiążące. `Context` przechowuje uchwyt/własność,
nie staje się miejscem algorytmu. Nie dokładać kolejnego wielkiego pliku
wykonawczego obok obecnego `multilayer.rs`.

## 5. Descriptor i pamięć

Descriptor warstwy zawiera stabilne object/layer ID, native shape/origin/cell,
scratch shape/origin/cell, maskę, mapę materiałową, transfer i fizyczny rozmiar
komórki kernela. Katalog par zawiera obie tożsamości, offset XYZ, rozmiary
źródła/celu, tryb, granice, precision, layout/padding/normalizację FFT oraz
wersję algorytmu. Cache nie może być kluczowany tylko dystansem Z.

Host może przygotować i zweryfikować niezmienne kernele przy aktywacji,
przesłać je raz; to decyzja projektanta, nie wymóg generowania kerneli w
hot loop GPU. Nie wolno wyliczać ich ponownie w każdym RHS. Szablony
kompresji/symetrii dopiero po dowodzie zgodności full-complex.

Admission liczy łącznie: wszystkie warstwy i materiały, mapy overlap,
widma źródeł/celów, unikalne kernele, bufor FFT, workspace integratora,
rollback/accepted state i dopuszczone snapshoty. Używa checked arithmetic
i tego samego deskryptora co alokator. Raportuje przewidywane i rzeczywiste
peak bytes. Brak pamięci daje jawny błąd przed częściową aktywacją.

Pełna tablica wszystkich par może mieć koszt kwadratowy w liczbie warstw.
W ramach budżetu używać katalogu unikalnych kerneli i porcjowania par na
urządzeniu. Bez cichego streamowania kerneli z hosta w każdym kroku. Gdy
wybranego planu nie da się utrzymać w budżecie, zwracać odmowę z estymacją,
nie zmieniać fizyki lub precision.

## 6. Przepływ obliczeń

Aktywacja: validate → admission → przygotowanie katalogu/map → alokacja →
upload → plan FFT → sanity checks → publikacja gotowego uchwytu. Przy błędzie
zachować stary zaakceptowany stan i zwolnić tylko zasoby tej nieudanej próby.

Każdy refresh: utworzyć M na scratch przez właściwy push → forward FFT
każdej warstwy źródłowej → wyzerować widma celów → akumulować tensor razy M
dla wszystkich wymaganych par → inverse FFT celów → normalizacja i crop →
adjoint pull → zapis H_demag na gridach natywnych.

Dla jednej zgodnej rodziny transformacji celem jest L forward i L inverse,
a nie FFT dla każdej z L² par. Gdy konieczne są różne rodziny layoutów,
plan jawnie podaje liczbę unikalnych transformacji; nie wpisywać stałych
liczników L/L do telemetryki i nie uznawać ich za wykonane pomiary.
Kryterium optymalizacji: ponowne użycie każdego zgodnego widma źródła i
akumulacja przed inverse, z osobnym kosztem każdej rodziny transformacji.

Koszt zmiany siatki/położenia/maski/materialu rozlicza invalidation zależności:
geometria zmienia kernel/mapę, materiał Ms zmienia źródło, m zmienia źródło
każdego etapu; nie każda zmiana wymaga przebudowy całego katalogu.

## 7. Integratory i zgodność zachowania

Operator jest niezależny od integratora. W każdym etapie otrzymuje bieżący
stan warstw i strumień; nie odczytuje przypadkowo ostatniego accepted state.
Naprawy A04/A05 są warunkiem integracji. Finite check precedes commit; failed
trial nie zmienia stanu zaakceptowanego, czasu, historii ani outputów.

Docelowa macierz integratorów:

| Rodzina | Wymagane prace | Warunek zakończenia |
|---|---|---|
| Fixed Heun/RK4/RK23 | Wpięcie jednego rezydentnego operatora do wszystkich etapów | Parity RHS/stage/step i zbieżność dt |
| Fixed RK45/ABM3 wystawione w CPU multilayer | Native pełny etap/historia bez assisted hot loop | Osobne testy historii, restartu i zbieżności |
| Adaptive RK23/RK45 | Jawny accepted/trial state, retry i dt-min failure, unieważnienie FSAL | Reject/retry/rollback parity; bez rozszerzania thermal SDE |
| Frozen Spins | Mask/reference w descriptorze i egzekwowanie w każdym etapie | Niezmienność zadanych spinów i poprawne pola na pozostałych |

To szerszy cel niż sam demag kernel, potrzebny, aby „pełna implementacja”
nie pozostała ograniczona do obecnego Heuna. Jeśli użytkownik zatwierdzi
zakres mniejszy, macierz musi zostać jawnie zmieniona przed planem wykonawczym.

## 8. Weryfikacja i warunki odbioru

Najpierw naprawić verifier (A01/A02) i skalarne CPU energy (A03); referencja
nie może być jedynym dowodem — wymagany także niezależny oracle bez produkcyjnego
buildera kerneli/transferu. Nie łagodzić progów, aby uzyskać PASS.

Macierz obejmuje L=1/2/3 i większe L do benchmarku, oba tryby, dodatnie i
ujemne offsety XYZ, równe i różne hz/dx/dy, niecałkowite stosunki rozdzielczości,
częściowe pokrycie, maski, różne materiały, każdy integrator oraz FP64/FP32.
Case'y graniczne: jedna komórka w osi, warstwa bez aktywnych komórek
(jawna odmowa przed alokacją, zgodnie z obecną walidacją planera), odległe warstwy, styk/overlap według planera,
niepoprawne descriptor sizes, overflow i odmowa pamięci.

| Brama | Wymagany dowód |
|---|---|
| G0: kontrakt | Zaktualizowana nota 0421/source-map, Python→IR→descriptor, capability per tuple; żadnego claimed production |
| G1: wejścia i bezpieczeństwo | A04/A05, checked sizes, błąd dt/plan/OOM przed mutacją, rollback i retry |
| G2: operator CPU/oracle | Self trace, offset signs, weighted reciprocity, moment, adjoint, energia i jej pochodna |
| G3: GPU FP64 | Każda wspierana klasa pola i energii względem CPU oraz niezależnego oracle |
| G4: czas | Parity RHS/stage/step, normy, energie i zbieżność dt; długie trajektorie i restart, osobno każdy integrator |
| G5: FP32 | Własna tożsamość realizacji, redukcje, błąd względem FP64, time-to-accuracy; brak automatycznej promocji z FP64 |
| G6: wydajność | Zmierzone liczby FFT, alokacji i transferów, peak VRAM, cold/warm time; nie tylko deklarowane telemetry counts |
| G7: produkt | Export/reimport, per-layer pola, accepted-state/Compute Fields, target-only Airbox; widoczny canvas, żywy WebGL, niezerowy buffer |
| G8: integracja | Source-bound receipt, wymagane kontrole/review, merge i bezpieczny cleanup według AGENTS |

Istniejące progi startowe: `thresholds.v1.json` w
`tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/`:
CUDA FP64 pole `atol=1e-4 A/m`, `rtol=1e-8`; FP32 względem FP64
RMS `2e-4`, component Linf `5e-4`. Rozszerzenie na heterogeniczne siatki
wymaga poprawnej definicji wag i mianownika oraz osobnych tolerance studies;
nie stosować ślepo obecnego niezważonego RMS. Dla energii/transferu zachować
odrębne progi i jednostki z tego pliku. SP4-derived nie jest kwalifikacją
kanonicznego µMAG SP4. Prędkości nie obiecywać przed pomiarem.

## 9. Kolejność prac do rozwinięcia w planie wykonawczym

| Pakiet | Właściciel zmian | Zależności | Rezultat odbioru |
|---|---|---|---|
| R0: zabezpieczenia i dowody | verifier, CPU energy, native step transaction | Audyt A01–A05 | Negatywne case'y odrzucane, energia PBC spójna |
| R1: nauka i descriptor | nota/source-map, IR/planner, ABI | R0 oraz akceptacja tego projektu | Jeden kontrakt i admission wspólne dla CPU/GPU |
| R2: kompletny operator GPU | dedykowane pliki `gpu/cuda/demag/`, mapy/workspace | R1 | FP64 two_d_stack/three_d, pełne heterogeniczne pary i transfer; A06 usunięty |
| R3: integratory i stan | native integratory, Frozen Spins, transakcja/checkpoint | R2 | Cała macierz sekcji 7 bez assisted hot loop |
| R4: FP32 i zasoby | native precision, redukcje, workspace/cache | R2/R3 | Oddzielna kwalifikacja i pomiary |
| R5: konsument i provenance | runner/accepted state, resource hooks według potrzeby | R1–R4 | Zgodność requested/resolved/executed i per-layer output |
| R6: kwalifikacja i zastąpienie starej ścieżki | scenariusze, verifiery, dokumentacja, usunięcie martwych ścieżek | R0–R5, G0–G7 | G8 i jeden produkcyjny właściciel multilayer GPU |

Stare ścieżki służą przejściowo do porównań; nie są długoterminowym fallbackiem
nowego engine. Przełączenie dispatchu następuje dopiero po przejściu macierzy.
Usuwanie kodu wymaga sprawdzenia wszystkich konsumentów i zgodności ABI;
stare artefakty mają pozostać odczytywalne. Rollback wdrożenia wraca do
poprzedniej jawnie ograniczonej realizacji, bez reinterpretacji nowych runów.

## 10. Realizacja organizacyjna i otwarte ograniczenia

To duży projekt, nie lokalna poprawka. Szczegółowy plan po akceptacji opisze
spójne commity, dokładne pliki, testy regresyjne, ownership i warunki przejścia
każdej bramki. Nie podano fikcyjnej estymaty dni ani przyspieszenia.

Implementacja wymaga worktree i rejestru zgodnie z governance. Wszystkie
buildy DEV w grupie Compose tego checkoutu, dane techniczne w named volumes.
Recepty historyczne z planu sierpniowego trzeba ocenić względem bieżącej
polityki przed uruchomieniem; nie kopiować hostowych poleceń Cargo.
Aktualny zakaz kompilacji testów jednostkowych pozostaje w mocy: wolno
przygotować kod regresji i wykonywać dozwolone lekkie kontrole, lecz bramki
wymagające kompilacji pozostają **NOT VERIFIED**, aż użytkownik odwoła zakaz.
Brak tej zgody nie blokuje sporządzenia projektu i planu.

Do decyzji wykonawcy pozostają: dokładne nazwy plików/typów, kernel launch
geometry, wybór układu FFT zgodnego z powyższym kontraktem, porcjowanie par
i wielkości benchmarków dostosowane do dostępnego GPU. Każdy wybór wpływający
na semantykę, precision lub zakres wymaga aktualizacji kontraktu.

## 11. Wynik niezależnego builder check

Projekt przeczytał osobny recenzent bez historii rozmowy. Wskazał jedną
istotną niejasność: dopuszczenie pustej warstwy. Rozstrzygnięcie projektanta
zachowuje istniejące zachowanie planera: warstwa bez aktywnych komórek
jest błędem wejścia przed alokacją. Nie wymaga nowej semantyki warstw zerowych.
Nie wskazano innych decyzji koniecznych do rozpoczęcia szczegółowego planowania.

## 12. Referencje

- [Lepadatu, J. Appl. Phys. 126, 103903 (2019)](https://doi.org/10.1063/1.5116754):
  podstawa metody multilayered convolution dla różnych grubości, odległości
  i położeń; nie jest dowodem działania Fullmaga.
- Kanoniczne równania, odstępstwa transferu i source index: nota 0421.
- Właściciele bieżącej implementacji i findingi: powiązany audyt z 2026-10-25.
- `docs/physics/0300-gpu-fdm-precision-and-calibration.md`: odrębność realizacji precyzji.
- `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`:
  kontrakt kroku, kandydata i kwalifikacji czasu.
