# P3-B/P5-B — accepted FDM GPU z dokładnym przypisaniem urządzenia

Data: 27.09.2026
Implementacja: `bafd999e43f471a39062d8275f512e189aaa6d6b`
(`feat(runtime): execute accepted FDM GPU tasks`)

## Problem

Procesowy accepted runtime był dotychczas potwierdzony wyłącznie dla FDM
CPU/double/strict. Oferta GPU niosła trwały budżet VRAM, lecz worker nie
wiązał procesu potomnego z fizycznym UUID urządzenia i odrzucał każdy request
GPU. Brakowało też jednej zarządzanej bramki obejmującej publiczny Submit,
scheduler, supervisor, worker, natywny runner CUDA, provenance i zwolnienie
dzierżawy.

## Zaimplementowany kontrakt

- Accepted worker obsługuje FDM CPU albo GPU wyłącznie dla `double/strict`.
  Rodzaj lease i budżet VRAM muszą odpowiadać żądanemu urządzeniu.
- Supervisor wyprowadza UUID NVIDIA z trwałego identyfikatora lokalnie
  odkrytego zasobu `.gpu.<uuid>`. GPU lease bez takiego wiązania jest
  odrzucany przed spawnem.
- Proces workera dostaje `CUDA_VISIBLE_DEVICES=<uuid>` oraz
  `FULLMAG_FDM_GPU_INDEX=0`, więc ordinal zero oznacza dokładnie urządzenie
  objęte lease.
- Request GPU jest przenoszony do `runtime_selection`; sprzeczny
  `FULLMAG_FDM_EXECUTION` kończy wykonanie fail-closed. Forced GPU nie ma
  fallbacku CPU.
- Wstępny kosztorys multilayer v2 nie odczytuje nieistniejącego pola rDMI z
  zamrożonego 160-bajtowego ABI. Opcjonalny workspace rDMI nadal przydziela i
  rozlicza osobny wersjonowany setter.
- Dedykowana recepta `verify-api-accepted-fdm-gpu-runtime` buduje produkcyjne
  binaria Windows/CUDA, publikuje lokalną ofertę GPU, wykonuje publiczny
  immutable RunSpec i sprawdza dokładny lease, heartbeat ACK, runner metadata
  oraz publiczny readback.
- Izolowany build-only może pominąć legacy compatibility links. Przełącznik
  jest dozwolony wyłącznie z `BuildOnly`, więc nie zmienia zwykłego startu
  aplikacji ani istniejącego katalogu `.fullmag`.

## Dowody

| Bramka | Wynik | Receipt |
|---|---|---|
| Source check API/runtime | **PASS** | `5dd42bd76a5b4a938543ab9dd3432fdc` |
| Produkcyjny process E2E FDM GPU | **PASS** | `3eea662894de4721819fcd6cf1bfd59c` |
| Parser końcowego runner metadata | **PASS** | `cuda_fdm`, `fdm/gpu/double/strict`, exact, fallback `false` |

Końcowy receipt ma `source_changed_during_run=false`. Scheduler wykonał jeden
task na
`fdm-gpu-3eea662894de4721819f.gpu.GPU-fcb9fbf1-8284-37c7-af5b-76bcbf2d2937`.
Worker zakończył dziewięć kroków, opublikował `HeartbeatAck`, publiczny task ma
`succeeded`, a dokładna dzierżawa GPU ma `released` i `released_at`.
`execution_engine` wynosi `cuda_fdm`; authored, effective i resolved request
pozostają `fdm/gpu/double/strict`, `resolution_mode=exact`, bez fallbacku.

Testy jednostkowe Rust pozostają **NOT RUN** zgodnie z aktywnym zakazem
kompilowania targetów testowych. Produkcyjny build oraz process E2E nie są
przedstawiane jako ich zamiennik.

## Granica kwalifikacji

Dowód obejmuje lokalny accepted runtime FDM GPU/double/strict na jednym
fizycznym GPU. Nie kwalifikuje FEM CPU, FEM GPU, transportu cross-host,
steeringu, parytetu naukowego CPU/GPU ani wydania. P3 wzrasta do **93%**, P5 do
**87%**, a cały plan do około **49%**.
