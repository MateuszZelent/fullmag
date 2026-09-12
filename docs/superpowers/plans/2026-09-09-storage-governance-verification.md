# Weryfikacja storage Windows/Linux

Status: implementacja źródłowa gotowa do review; kwalifikacja runtime pozostaje
warstwowo ograniczona. Zmiany znajdują się w izolowanym worktree
`C:\git\fullmag\worktrees\storage-governance-20260909`, na branchu
`codex/storage-governance-20260909`. Główny checkout nie został zintegrowany.

## Zakres

Wspólny resolver ścieżek, marker projektu, blokady worktree, rejestr zasobów,
adaptery Windows, wejścia just/Make, Linux ext4, mounty Compose oraz wyjścia
frontendu. Centralne zasady opisuje
[`fullmag-build-storage-governance.md`](../../guides/fullmag-build-storage-governance.md).

## Dowody

| Sprawdzenie | Wynik |
| --- | --- |
| Core storage, Windows | 23 testy: 21 PASS, 2 Linux-only SKIP; po końcowych zmianach |
| Core storage, Ubuntu2 | 18 PASS; przed końcową korektą przełączania profili |
| `just storage-info`, Windows | PASS, exit 0; project root i storage wyznaczone poprawnie z zagnieżdżonego worktree |
| Rzeczywisty managed run, Windows | PASS, exit 0; `build-status.json=completed`, lock owner `released`, źródło dirty zapisane jawnie |
| Podstawowe compatibility links | PASS; `.fullmag` i `target` są junctionami do profilu tego worktree pod `C:\git\fullmag\storage` |
| Pełny frontend preflight | Oczekiwana odmowa przed zmianą: istniejący realny `apps/control-room/.artifacts` wymaga osobnej inventory/migracji |
| Windows launcher contract | 41/41 PASS |
| Rzeczywisty PowerShell refusal-before-write | 1/1 PASS |
| Parser PowerShell | 7 zmienionych skryptów PASS |
| Parser bash | 8 zmienionych skryptów/helperów PASS |
| `compose.yaml config` | PASS z resolverowym environment; Docker daemon/runtime `NOT VERIFIED` |
| Make | `NOT VERIFIED`: GNU Make nie jest zainstalowany na tym hoście; źródło i helper przeszły review/bash parser |
| Cleanup frontendu, Node stdlib | 2/2 PASS |
| Nowy test managed static export Next | 1/1 PASS z rzeczywistym Vitest; zależności udostępnił istniejący główny checkout |
| Cały plik next.config.test.ts | 11/12 PASS; istniejąca rozbieżność next-env.d.ts także w HEAD; dodano regresję zgodności legacy static export |
| Testy kontraktu release workflow | 11/11 PASS; nie jest to wykonanie wydania |
| CI | Dodano job Ubuntu/Windows do istniejącego contract-guard; wykonanie zdalnego CI NOT VERIFIED |
| Pełny build Rust/CUDA/Next | NOT VERIFIED |
| Release workflow i samodzielny Windows MSI packager | Nieobjęte kwalifikacją storage; zachowanie zgodności static export wymaga oddzielnego testu |
| Managed FEM CPU/GPU i walidacja fizyki | NOT VERIFIED; test storage nie jest wykonaniem solvera |

## Istotne granice

- Nie usunięto ani nie zmigrowano istniejących katalogów legacy i worktree.
- Istniejący prawdziwy katalog w miejscu wymaganego compatibility linku wymaga
  osobnej inwentaryzacji; mechanizm nie usuwa go automatycznie.
- W tym worktree takim katalogiem jest `apps/control-room/.artifacts` z
  podkatalogami `chart-performance` i `viewport-3d-browser-audit`. Nie został
  usunięty ani przeniesiony. Z tego powodu pełne linki frontendu i rzeczywisty
  build Next pozostają `NOT VERIFIED` mimo przejścia testów konfiguracji.
- Próby testów bash wywoływanych z Windowsowego Pythona trafiają na systemowy
  `C:\Windows\System32\bash.exe`; uruchomienie WSL zostało odrzucone przez host
  (`E_ACCESSDENIED`). Nie klasyfikujemy tego jako błąd testowanych helperów ani
  jako zielony dowód Linux runtime.
- Ochrona wrapperów nie zastępuje sandboxa systemowego. Nie zmieniono uprawnień hosta.
- Profile są jawne; resolver nie wylicza automatycznie kompletnego fingerprintu ABI.
- Rejestracja właściciela zadania jest obowiązkiem workflow agenta. Ręczne polecenie
  użytkownika nie wymaga utworzenia fikcyjnego zadania Codex.

## Stan zasobów

Worktree zachowuje niezacommitowane zmiany do review i integracji. Podstawowe
junctiony wskazują kanoniczny storage, a katalog `.artifacts` pozostaje jako
zachowany, niesklasyfikowany output wymagający osobnej decyzji migracyjnej. Nie
wykonano fetch, push ani merge. Po zatwierdzeniu użytkownika zmiany zapisano w
czterech logicznych commitach. Rejestr worktree zostaje zamknięty ze
stanem `review` i następnym krokiem: review/integracja bez cleanupu legacy.
