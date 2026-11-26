# Pomiar STT i SHE w FDM CUDA FP64

Pomiar A/B wykonano na RTX 4080 SUPER 16 GiB (SM 8.9), w jednym
izolowanym kontenerze Fullmag Docker DEV, z identycznymi wejściami,
tolerancjami i zapisem wyników. Bazą był `0a607c0ffb23bcd10c3e9ccbcb4448557a81216b`.
Do pakietu porównawczego weszły wyłącznie dwie opisane tutaj poprawki.
Oba pakiety zmierzono przed scaleniem PR #561.

## Wyniki

| Przypadek | Siatka | Czas CLI przed → po | Mediana etapu spinowego przed → po |
|---|---:|---:|---:|
| Pełne SHE M1, prąd dodatni, 13 kroków RK4 | 32 × 16 × 7 | 177,58 → 3,86 s | 2675,63 → 14,27 ms |
| Pełne SHE M1, prąd odwrócony, 9 kroków RK4 | 32 × 16 × 7 | 123,72 → 3,56 s | 2678,85 → 14,76 ms |
| Pełne SHE M1, 4 kroki RK4 | 128 × 64 × 7 | 19,22 → 18,53 s | 63,19 → 34,65 ms |
| Slonczewski STT, impuls czasowy, RK45 | 512 × 256 × 1 | 18,19 → 18,41 s | |
| Uproszczone SHE, zadany impuls SOT, RK45 | 512 × 256 × 1 | 48,30 → 48,57 s | |

Czas CLI liczono od otwarcia pliku wyjścia procesu do jego ostatniego zapisu.
Próbnik sprawdzał zakończenie co 5 s, co zawyżało raportowany przez niego czas.
Każdy przypadek wykonano raz na pakiet. Pełne SHE wykorzystuje warstwy,
parametry materiałowe, gęstość prądu i krok 20 fs z przypadku β-W/CoFeB.
Skrócono rozmiar boczny i czas obliczeń oraz użyto jednorodnego stanu
początkowego. Wyniki dotyczą tych krótkich przebiegów.

W pięciu parach wszystkie wartości końcowego `m` były identyczne.
W trzech parach M1 identyczne były też wszystkie zapisane wartości
`V_electric`, `J_charge`, `spin_potential`, `spin_current_tensor` i `torque_stt`.
Receipty potwierdziły realizację wymaganych operatorów na GPU, zero fallbacków
i zero transferów pełnego wektora między CPU i GPU w pętli. Odczyty skalarnej
kontroli i zapis wyników nadal występują.

Dla STT licznik etapów z osobnym kernelem RHS spadł z 2569 do zera.
Dla aktywnej części uproszczonego SHE spadł z 1463 do zera. Czas tych
krótkich symulacji nie wykazał przyspieszenia. W małym M1 mediana odtworzenia
pól i diagnostyki spadła z 2662,54 do 1,41 ms, a GMRES zajmował około 11,1 ms
w obu wersjach. W większym M1 wyszukiwanie ścian i interfejsów przyspieszyło
składanie, którego mediana z haszowaniem spadła z 18,60 do 0,63 ms. Po zmianie
odtworzenie pól z diagnostyką zajmowało 11,12 ms, a GMRES 17,47 ms.

Pakiet bazowy `libfullmag_fdm.so` ma SHA-256
`18042bedf90b79b40f1a9b62b8a1ef0b3735dba2bf4cf8490b411e53ecbcab97`.
Pakiet porównawczy z próby Docker DEV `47e39ec846e748a0a37e7185566f918b`
ma SHA-256 `6171eac02fd8666d324ee333de44398c494ec352a6efc2fd8626b6af9948968c`.
Wyniki zapisano w katalogu danych tej grupy
`fdm-stt-she-perf-20261126/{baseline,candidate}`.
Porównanie wykorzystuje pliki `m_final.json`, `fields/*/step_*.json`
oraz linie `spin_solve_phase` z `stderr.txt`.

## Częstotliwość obliczeń i zapis pól

W ścisłym modelu M1 każdy etap prawej strony LLG potrzebuje stanu spinowego
i momentu zgodnego z bieżącym `m_stage`. Dla RK4 cztery takie obliczenia
wpływają na dynamikę. Piąte odświeża spin na magnetyzacji powstałej po
końcowej kombinacji RK4 i służy do zatwierdzenia obserwabli oraz checkpointu.
W Heunie analogicznie występują dwa etapy RHS i jedno odświeżenie końcowe.
Ładunek w M1 zależy od źródła i własnych warunków brzegowych. Jeśli źródło i
układ ładunkowy zachowują tę samą rewizję, rozwiązanie można współdzielić
między etapami.

Następną oszczędność o tej samej semantyce da rozdzielenie obliczeń
potrzebnych LLG od pełnego odtworzenia obserwabli. Każdy etap RHS może
zachować rozwiązanie spinowe, moment i wymagane redukcje błędu na GPU.
Odtworzenie tablic strumieni, pełnych reakcji i uporządkowanych obserwacji
interfejsów wystarczy wykonać dla stanu zaakceptowanego, a dalej przy
obserwacji lub checkpoincie po zachowaniu jego dokładnej tożsamości.
Dla metod adaptacyjnych komplet pól powstaje z rozwiązania kandydata dopiero
po decyzji o przyjęciu. Odrzucona próba nie może zmieniać publicznych pól
ani checkpointu. Obliczanie samego momentu raz na zaakceptowany krok jest
osobnym przybliżeniem `accepted_step_approx` i wymaga weryfikacji zbieżności
w kroku czasowym oraz jawnego oznaczenia w wyniku.
[Kontrakt kadencji transportu](../specs/spin-transport-runtime-contract-v1.md#6-stage-cadence-and-coupled-evaluation)

## Gdzie mierzyć cuDSS

PR #561 udostępnia cuDSS dla ładunkowego Poissona. W pomiarze
`U_128x64x8` na rozgrzanym układzie nowy AMG-PCG uzyskał 65,87 ms, a cuDSS
66,88 ms. Dzielony między wiele RHS stały operator daje większą szansę na
zamortyzowanie kosztu faktoryzacji, jak w Poissonie FEM.
[Audyt ładunku](2026-11-25-fdm-gpu-acceleration-pgbb-r2c-charge.md)
[PR #550](https://github.com/MateuszZelent/fullmag/pull/550)

Operator spinowy M1 jest ogólnie niesymetryczny ze względu na precesję i
zespoloną konduktancję mieszania. Jego wartości zależą od magnetyzacji etapu.
Kwalifikacja cuDSS powinna zatem użyć rozkładu ogólnego oraz zmierzyć
osobno analizę wspólnego wzorca CSR, koszt ponownej faktoryzacji
numerycznej, rozwiązywanie na GPU, szczyt VRAM i niezależne residuum
fizycznego operatora. Dla 128 × 64 × 7 GMRES zajął 17,47 ms z 34,65 ms
całego etapu, co wyznacza skalę potencjalnego zysku przed uwzględnieniem
kosztu faktoryzacji. Zadany STT i SOT obliczają moment lokalnie i nie
mają układu transportowego do przekazania cuDSS.
[Etapy wykonania cuDSS 0.8](https://docs.nvidia.com/cuda/cudss/0.8.0/types.html)
