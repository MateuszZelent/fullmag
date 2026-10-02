# P6-71 — rzeczywista tożsamość wdrożonego runnera

Odczyt tylko do odczytu z 02.10.2026, po commicie źródłowym
`71b558ff4b68b2b817bd14cfa0edba208d31e0c6`. Nie wykonywano buildu, deployu,
zmian konfiguracji ani kasowania danych.

## Wynik

Wdrożony `Fullmag_build_runner` nadal używa wcześniejszej kontroli pięciu
bazowych outputów. Zmiany P6-68–70 są na remote, lecz nie są wdrożonym kodem
koordynatora. Jednocześnie wdrożony entrypoint ma rozszerzone profile, których
nie ma w źródłowym entrypointcie trzech profili release.

| Element | Bieżący `master` | Wdrożony kontener |
|---|---|---|
| Wymagane release outputs | 14, w tym 9 accepted binaries | 5 bazowych |
| Profile entrypointu | `fdm-cpu-release`, `fem-cpu-release`, `fem-gpu-release` | te trzy oraz current-contracts CPU/GPU, SLEPc modal i runtime v1/v2 |
| SHA-256 `build_entrypoint.py` | `51c1b62e511552f22f091aff8637298c19d04368f14d376e3a3bb303a84a3f9c` | `86cac6a10e93c21d439d1643128740c5460f3b5a7a1df94444ea23d8bc325c9c` |
| SHA-256 `build_executor.py` | `22e78300784f929caf4c515ff6ccbd88b4722dc87f1af042497168996b6074a6` | `21d82abefe736f3e90829e9f831343c904d8c3650683538c9c7508bd5df2d91c` |

Odczyt health potwierdził `worker_alive=true`, `accepting_jobs=true`, brak
aktywnych jobs i `last_result.state=waiting_for_disk`. Wolne miejsce wynosiło
**88 084 480 B, około 84 MiB**, poniżej minimum 8 GiB.
Koordynator ma obraz
`sha256:7753401fbbf748625b8ec2fda0fc244b07e8ef492426102102dd88bd22c6f901`.

Operatorowy health dopuszcza siedem profili:

- `fdm-cpu-release`
- `fem-cpu-release`
- `fem-gpu-release`
- `fem-cpu-current-contracts-v1`
- `fem-gpu-current-contracts-v1`
- `fem-cpu-slepc-modal-v1`
- `fem-cpu-slepc-runtime-v2`

Obecność runtime v1 w kodzie entrypointu nie oznacza dopuszczenia go przez
bieżącą politykę operatora. Nie należy zmieniać allow-listy na podstawie tej
inwentaryzacji.

## Pochodzenie kodu — dalszy odczyt

Checkout używanego klienta `eigensolve-dispersion-plan-20260912` wskazuje
`8bb6cb7fc64e481ffd7d8daee9462796edf6a395`. Odczyt statusu nie wykazał
lokalnych zmian w dwóch porównywanych skryptach. SHA-256 jego executora
jest identyczny z wdrożonym: `21d82abefe736f3e90829e9f831343c904d8c3650683538c9c7508bd5df2d91c`.
EntryPoint klienta ma jednak SHA-256
`ebafba6a095e9523797eef378e6dae8360858fbe7de19ceb671081922d5ff0c6`,
różny od obrazu. Nie można utożsamiać całego checkoutu klienta z wdrożeniem.

Najnowsza zmiana tego pliku jest w
`a4a0f6d02640f8f55741cebe1607032b248eecc2` i dotyczy attestation wersji
zainstalowanego oraz załadowanego MFEM. Żaden z sześciu sprawdzonych blobów
historii pliku nie odpowiadał byte-for-byte wdrożonemu entrypointowi.
To ograniczony odczyt historii, a nie dowód braku takiego commita w całym Git.
Aktywny plik ma 1605 linii i dodatkowe ścieżki kontraktowe/headless/SLEPc.
Integracja nie może sprowadzać się do podmiany tego pliku wariantem `mastera`
ani do cofnięcia nowszej kontroli MFEM w checkoutcie klienta.

Ponowny health: `storage_free_bytes=92 803 072` (około 88,5 MiB),
`waiting_for_disk`, brak aktywnych jobs; obraz i instance ID nie zmieniły się.
Nie wykonywano zapisów w checkoutcie klienta, zmian globalnego `safe.directory`
ani aktualizacji runnera.

## Konsekwencja dla następnego kroku

1. Zwolnienie miejsca wymaga oczekującej zgody na dokładny manifest P6-67
   albo niezależnego zwiększenia pojemności. Nie rozpoczęto kolejnego buildu
   natywnego ani fixture frontendu.
2. Przed aktualizacją koordynatora ustalić źródło jego rozszerzonej wersji
   oraz zintegrować zmiany kontroli pakietu z zachowaniem siedmiu dopuszczonych
   profili i istniejącej kolejki. Samo zastąpienie kodu źródłowym entrypointem
   trzech profili oznaczałoby regresję; nie wykonano takiej operacji.
3. Nowy receipt native buildu sprawdzić również źródłowym konsumentem P6-70:
   wymagane 14 plików, niezerowe rozmiary, hashe, source identity i trusted
   hashes. Poprawne hashe wdrożonych starych skryptów nie oznaczają wdrożenia
   nowej kontroli ani wykonania runtime.
4. Dopiero terminalny pakiet jest wejściem do accepted FEM CPU, pinów,
   SolutionSet, HTTP oraz archiwum z P6-60/P6-61. Science, parytet czterech lane,
   clean install i kwalifikacja wydania pozostają oddzielne.

## Odbiór

Nowym dowodem jest bezpośredni odczyt stałych i hashy kodu w aktywnym kontenerze,
porównany z plikami lokalnego `mastera`, oraz health runnera. Nie jest to dowód
kompletności produkcyjnej. P6 i pełny plan pozostają otwarte; procentów nie
podniesiono. Weryfikacja runtime i aktualizacja wdrożenia są **NOT VERIFIED**.
