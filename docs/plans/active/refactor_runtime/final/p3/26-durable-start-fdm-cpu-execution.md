# Durable Start do rzeczywistego przebiegu FDM CPU — 25.09.2026

## Zakres

Dodano w API wąski adapter `execute_accepted_worker_start`, który łączy
zaakceptowany krok study z istniejącym runnerem i fenced publikacją wyników.
Adapter:

- wiąże trwałą komendę `Start` z dokładnym claimem task/attempt/epoch;
- dopuszcza side effect tylko wtedy, gdy durable inbox zapisał tę komendę jako
  pending po zastosowanym `Prepare`;
- ponownie sprawdza claim, zaakceptowany snapshot i obsługiwany kontrakt wejścia;
- ogranicza ten slice do `Any`, FDM/CPU/double/strict, bez parametrów ani
  seedów wymagających dodatkowego rozwiązania, z aktywnym lease CPU oraz
  dodatnim, przypiętym horyzontem FDM;
- materializuje immutable wejście, rezerwuje prywatny katalog outputu attemptu,
  przekazuje jawne CPU/double do runnera, a potem publikuje wyłącznie wspierane
  typed payloady przez istniejącą ścieżkę CAS/manifestu.

Regresja accepted-run przechodzi od durable `Prepare` i `Start` do rzeczywistego,
krótkiego przebiegu solvera FDM CPU, publikuje stan i skalary przed terminalnym
`Completed(Unassessed)` oraz sprawdza provenance: requested i resolved device są
CPU, backend to FDM, precision to double, a fallback jest wyłączony. Następnie
odzyskuje inbox i potwierdza replay dokładnej komendy bez ponownego uruchomienia
closure side effectu.

## Weryfikacja

- `just verify-api-project-runs`: **6 passed, 0 failed, 2 ignored**, receipt
  `addbd9b004314543b6249e8f4ccb2ee9`; `source_changed_during_run=false`.
- `just check-api-source`: **PASS**, receipt
  `a9d5019ba6384defa35549774fdae645`; `source_changed_during_run=false`.
- `rustfmt --edition 2021 --check` dla nowego adaptera: **PASS**.

Rzeczywisty plik `m_final.json` miał 280 895 bajtów; testowy lease podniesiono
do 4 MiB, aby fixture obejmował poprawne opublikowanie wyniku. To nie dowodzi
limitu całego prywatnego katalogu attemptu: obecny collector ogranicza tylko
opublikowane, jawnie dopuszczone payloady.

## Granice dowodu i pozostała praca

To jest testowy call site, a nie produkcyjny supervisor ani uruchamialny
transport workerów. Nie potwierdza startu/restartu procesu, odzyskiwania po
crashu, scheduler admission, cancel/retry, zatrzymania starego workera,
zwolnienia VRAM, pełnego limitu przestrzeni dyskowej, GPU, innych backendów lub
precision ani walidacji naukowej. `Any` i krótki przebieg potwierdzają tylko
wykonanie tego fixture, nie zbieżność ani kwalifikację solvera.

Dlatego P3 pozostaje **50%**, a całość planu około **27%**. Następny wymagany
krok to przeniesienie tej granicy do produkcyjnego supervisor/worker lifecycle
z durable side-effect receipt i recovery; potem osobno kwalifikować pozostałe
lane'y wykonania.
