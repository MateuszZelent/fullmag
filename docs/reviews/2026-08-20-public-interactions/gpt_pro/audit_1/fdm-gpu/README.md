# Plany naprawcze — FDM GPU

Liczba ustaleń: **12**.

| ID | Priorytet | Klasa | Tytuł |
|---|---|---|---|
| `FDM-GPU-ABI-001` | **P0** | `architecture` | [Usunięcie driftu `fullmag_fdm_plan_desc` i obowiązkowy build feature CUDA](FDM-GPU-ABI-001.md) |
| `FDM-GPU-ARCH-001` | **P0** | `architecture` | [Strict device-resident LLG i zakaz niejawnego fallbacku](FDM-GPU-ARCH-001.md) |
| `FDM-GPU-NUM-003` | **P0** | `numerics` | [Wyłączenie FSAL dla termiki i niezgodnych źródeł zależnych od czasu](FDM-GPU-NUM-003.md) |
| `FDM-GPU-NUM-001` | **P1** | `numerics` | [Kanoniczna norma błędu adaptacyjnego na GPU](FDM-GPU-NUM-001.md) |
| `FDM-GPU-NUM-002` | **P1** | `numerics` | [Polityka precyzji dla stanu, pól, FFT i redukcji](FDM-GPU-NUM-002.md) |
| `FDM-GPU-PERF-001` | **P1** | `performance` | [Usunięcie hostowej synchronizacji z decyzji adaptacyjnej](FDM-GPU-PERF-001.md) |
| `FDM-GPU-PERF-002` | **P1** | `performance` | [Oddzielenie statystyk kontrolnych od pełnego odświeżania obserwabli](FDM-GPU-PERF-002.md) |
| `FDM-GPU-PERF-003` | **P1** | `performance` | [Fuzja kerneli lokalnych i ograniczenie launch overhead](FDM-GPU-PERF-003.md) |
| `FDM-GPU-PERF-004` | **P1** | `performance` | [Trwałe bufory, plany FFT i wersjonowane deskryptory urządzeniowe](FDM-GPU-PERF-004.md) |
| `FDM-GPU-PHY-001` | **P1** | `physics` | [Pełne spięcie pól materiałowych i warunków DMI w CUDA](FDM-GPU-PHY-001.md) |
| `FDM-GPU-QUAL-001` | **P1** | `qualification` | [Sprzętowe CI, Compute Sanitizer i time-to-accuracy gate](FDM-GPU-QUAL-001.md) |
| `FDM-GPU-TRX-001` | **P1** | `transactionality` | [Retry-safe termika, cache i checkpoint urządzeniowy](FDM-GPU-TRX-001.md) |

Powrót do [indeksu głównego](../README.md).
