# Audyt terminalnych katalogów execution — propozycja P8-44

Status: **read-only audit, proposal only, bez zgody na usunięcie**. Raport został wykonany 3 października 2026 r. dla siedmiu zakończonych prób `fem-cpu-release` w `C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f`. Pełne dane maszynowe są w [44-execution-cleanup-proposal.json](C:/git/fullmag/fullmag/docs/plans/active/refactor_runtime/final/p8/44-execution-cleanup-proposal.json).

## Wynik decyzji

Nie ma obecnie bezpiecznej ścieżki do usunięcia żadnego z siedmiu katalogów. Wszystkie mają poprawne, terminalne receipts i w pięciu przypadkach zatrzymany kontener został potwierdzony przez dokładne filtry mountów. Jednocześnie każdy katalog zawiera 2666 punktów reparse, więc istniejąca bramka `scripts/local_runner/retention.py::_safe_execution_bytes` celowo odrzuca go jako `unsafe_execution_tree`. Sama walidacja celów linków nie może tej bramki obchodzić.

Pełna walidacja każdego punktu reparse wykazała 18 662 sprawdzone wpisy: nie znaleziono celu zewnętrznego, brakującego, cyklu ani celu w `.fullmag-build`, `.fullmag-cargo` lub `.fullmag-rustup`. To jest dowód containmentu celów, a nie zgoda na usunięcie. Dwa najstarsze wpisy mają zaginione obiekty kontenerów, dlatego ich zatrzymanie nie może być wywnioskowane wyłącznie z braku obiektu Docker.

Odtwarzalny verifier znajduje się w [scripts/windows/audit_runner_execution_links.py](C:/git/fullmag/fullmag/scripts/windows/audit_runner_execution_links.py). Działa wyłącznie read-only, nie używa Dockera i nie zawiera ścieżki usuwania. Przykładowe wywołanie dla przyszłego świeżego dowodu (nowy plik wyjściowy, bez zastępowania tego raportu):

```text
python scripts/windows/audit_runner_execution_links.py `
  --execution C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\04112e6cb0fd42058b952f5e284d6fb6\execution `
  --execution C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\ffb5dd9294b24b6ab869266b99d95b49\execution `
  --output C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\audit-reparse-<new-id>.json
```

Verifier wymaga absolutnych ścieżek, odrzuca reparse w przodkach, nie schodzi za reparse directory, dekoduje tagi `0xa0000003`, `0xa000000c` i wersję 2 `0xa000001d`, rozwiązuje łańcuchy z limitem głębokości i sprawdza containment każdego pośredniego komponentu. Opcjonalne `--source-capsule` należy podać dokładnie raz dla każdego `--execution`; porównuje wtedy każdy wpis pliku z manifestem po rozmiarze i SHA-256, a także niezależnie sprawdza całe `source/tree` wobec tego manifestu. Nieznane dodatkowe wpisy (również zagnieżdżone) blokują wynik; wyjątki obejmują wyłącznie jawne prefiksy wygenerowane: `.fullmag`, `.fullmag-build`, `.fullmag-cargo`, `.fullmag-rustup`, `node_modules`, `apps/control-room/.next`, `apps/control-room/node_modules` i `apps/control-room/out`. `--output` tworzy wyłącznie nowy plik poza execution i kapsułami źródłowymi; narzędzie nie ma trybu zastępowania istniejącego dowodu.

Bieżący JSON przechowuje zwarte metadane map: 2666 rekordów na execution i wspólny canonical SHA-256 `b5f241cf8cfeaba07dbffb1956b74eb26ad416d4bfc9b8ebb0d3d320b4713900`. Świeży kompletny raport po ostatniej poprawce obejmuje siedem map oraz pięć pełnych kontroli kapsuł i zagnieżdżonych dodatków: `C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\audit-execution-full-d6dfba736d684181af2d2d0deba7033c.json` (61 843 324 B, SHA-256 `a54f00d328e311431ceef7c6c16cb25fe7a34675c16f777b0be38d9e855827d5`). Pełne rekordy pozostają poza Git; JSON wersjonowany ma około 40 KiB i wskazuje dokładny dowód oraz hash audytora.

Regresje `python -B scripts/test_runner_execution_links.py` zakończyły się wynikiem **18 PASS**, exit 0. Końcowy niezależny review: **PASS, bez pozostałych P0/P1 w tym zakresie**. Obejmują odmowę przed otwarciem pliku przez reparse ancestor/leaf, zamaskowanie zewnętrznego komponentu dalszym suffixem, zagnieżdżone nieznane dodatki, integralność kapsuły i ochronę pliku dowodowego. [Pełny zakres i ograniczenia P8-46](46-read-only-execution-verifier.md).

## Tożsamość kapsuł źródłowych

Dla pięciu kandydatów z potwierdzonym zatrzymanym kontenerem wykonano pełne, read-only porównanie manifestu z odpowiednim `source/tree` oraz execution. Każda zachowana kapsuła przechodzi własną kontrolę: 32 827 plików i 1 452 899 683 B łącznie, zero braków, mismatchów, reparse i dodatkowych wpisów. Po stronie execution sprawdzono 32 827 plików i 1 452 839 663 B. Dodatkowe katalogi najwyższego poziomu execution (`.fullmag`, `.fullmag-build`, `.fullmag-cargo`, `.fullmag-rustup`, `node_modules`) oraz znane zagnieżdżone katalogi generowane zostały jawnie odnotowane; nieznane zagnieżdżone wpisy blokują bramkę. Bramka nie przechodzi, ponieważ każdy z pięciu execution ma te same dwa różniące się pliki:

- `apps\control-room\next-env.d.ts`: manifest 257 B / `083e23c4…e86d6fd`, execution 253 B / `4e4da12a…9632ac`;
- `pnpm-lock.yaml`: manifest 473 543 B / `d0596adb…cdfee0`, execution 461 543 B / `10b6c7ea…004e32`.

`next-env.d.ts` może pochodzić z generowania, ale nie jest automatycznie pomijany; różnica `pnpm-lock.yaml` jest surową różnicą źródła. Dlatego `unique_worktree_guard.status=blocked_source_identity_mismatch`, a żaden z pięciu kandydatów nie jest obecnie kwalifikowany do przyszłego usunięcia. Po wyjaśnieniu różnic trzeba powtórzyć tę bramkę tuż przed osobno zatwierdzoną operacją.

Niezależny dowód zachowania wszystkich dziesięciu kopii mismatchów znajduje się w `C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\execution-source-preservation-e748d66bf7e54e3da22f644fd3d33bad\proof.json` (2 308 980 B, SHA-256 `8318d1315a1d17ebba660f4e6fbda52c32255a53b513d8bdc6eb7684c1056c25`). Jest to dowód zachowania bajtów do dalszego rozliczenia, a nie kwalifikacja do usunięcia.

| Job | Stan | Execution | Pliki | Kontener | Source digest |
|---|---:|---:|---:|---|---|
| `04112e6cb0fd42058b952f5e284d6fb6` | succeeded / 0 | 2 594 122 924 B | 60 658 | exited, pełny ID dostępny | `17ad3d671d289309c7cd69afba0faa415472bf51dfa574f5586aaef9968fee76` |
| `ffb5dd9294b24b6ab869266b99d95b49` | succeeded / 0 | 2 594 158 014 B | 60 656 | exited, pełny ID dostępny | `2da071ea51285731216842f033d6d79351da01f5fc31e0840be8cffc396c7604` |
| `bdd65936cfcc45b58a07879dd2e7ae3a` | succeeded / 0 | 2 593 823 752 B | 60 653 | exited, pełny ID dostępny | `c85581ae8b5037b5b7e8f254c888333ece5029862c67dbf55a114a6bc7dc1d7f` |
| `9eb85e72e82048f2b7e0558b86d66014` | succeeded / 0 | 2 593 793 132 B | 60 654 | exited, pełny ID dostępny | `68964b72f39216f17e624dc674f9ab311dfddfc0cba5bfdcb80f046cd04e6286` |
| `7953ba4088a142c889c5ed9c12be7332` | succeeded / 0 | 2 593 867 747 B | 60 656 | exited, pełny ID dostępny | `a7aba8c96b183250025a8bc44dacc7dcff45a7d4fb5b84039ecb26d8ad2d1417` |
| `1109693f411b4720b87690caa37cb880` | succeeded / 0 | 2 506 590 252 B | 61 329 | brak obiektu Docker | `c94f76352a051c62f618de8dd386d507418363ce8c9246e4947055bedd755859` |
| `c53a4a51da2149a6a91ef7fb3796f88c` | failed / 2 | 2 614 655 537 B | 61 090 | brak obiektu Docker | `2cd5741a89440a45a79a3add119299b7369c4f02e3da1bd1a5248d47d6626221` |

Łączny rozmiar logiczny execution wynosi **18 091 011 358 B** (około 16,85 GiB). Jest to suma rozmiarów plików, a nie obietnica odzyskania takiej ilości miejsca na współdzielonym storage.

## Pełna walidacja reparse

Enumeracja użyła atrybutu Windows `FILE_ATTRIBUTE_REPARSE_POINT`, a następnie `FSCTL_GET_REPARSE_POINT` z otwarciem `FILE_FLAG_OPEN_REPARSE_POINT`. Dla każdego wpisu zapisano względną ścieżkę, tag, bezpośredni target, końcową ścieżkę po łańcuchu i status. Łańcuchy normalizowano case-insensitive z zachowaniem granicy dokładnego katalogu execution; pośredni target wychodzący poza tę granicę byłby odrzucony.

Każdy z siedmiu katalogów ma identyczny rozkład:

- 1905 wpisów z tagiem `0xa000001d` i 761 wpisów z tagiem `0xa000000c`;
- 2 linki natywnych bibliotek FEM, 52 linki `apps/control-room/node_modules` i 2612 linków głównego `node_modules`;
- 2666/2666 targetów rozwiązanych, zero błędów I/O i dekodowania, maksymalna głębokość łańcucha 2;
- zero targetów zewnętrznych, brakujących, cyklicznych, prowadzących do współdzielonego mountu lub kończących się poza execution.

Rozróżnienie linków jest istotne dla późniejszej kontroli:

- `0xa000000c` to Windowsowe linki symboliczne pnpm: 709 w głównym `node_modules` i 52 w `apps/control-room/node_modules`;
- `0xa000001d` to plikowe linki WSL/LX: 1903 linki pnpm oraz dwa natywne aliasy FEM;
- aliasy FEM rozwiązują się jako `.fullmag/local/lib/libfullmag_fem.so -> libfullmag_fem.so.0 -> libfullmag_fem.so.0.1.0` oraz `.so.0 -> .so.0.1.0`, w obrębie tego samego execution.

Canonicalne SHA-256 map targetów oraz pełne rekordy znajdują się w JSON. Digest obejmuje kompletny rekord, w tym tag, rodzaj, bezpośredni target, łańcuch, końcowy target i status; nie jest to skrót samej listy ścieżek.

## Mounty, kontenery i dowody własności

Receipt każdego kandydata wskazuje te same kontraktowe mounty: `execution -> /workspace` rw, `artifacts -> /artifacts` rw, `trusted -> /runner` ro, source capsule -> `/source` ro oraz kontrolowane build/cache pod `.fullmag-build`, `.fullmag-cargo`, `.fullmag-rustup` i `/pnpm/store`. Dla pięciu pierwszych prób dokładne filtry po każdym z trzech katalogów joba wskazały wyłącznie właściwy zatrzymany worker z kodem 0. Dla `110969...` i `c53...` obiekt kontenera z receiptu nie istnieje już w Dockerze, a filtry zwróciły `no_match`; jest to brak dowodu bieżącego mountu, nie dowód, że można bezpiecznie kasować.

Source capsules są osobnymi katalogami i muszą pozostać. Ich `source_digest` zgadza się z receiptami; surowe SHA-256 plików manifestu source capsule oraz wynik bramki tożsamości są zapisane per kandydat w JSON. Receipts, `coordinator.json`, logi, `artifacts` i `trusted` są częścią dowodu i nie należą do proponowanego zakresu usunięcia.

## Ocena `Remove-Item`

Host używa PowerShell 7.6.6. Bieżący cmdlet `Remove-Item` ma `-Recurse` i `-Force`, ale nie ma jawnego trybu `-FollowSymlink:$false` ani kontraktu no-follow dla wszystkich Windows reparse tags. W repozytorium nie ma zatwierdzonej procedury usuwania tych execution przez `Remove-Item`; istniejąca retencja stosuje `lstat`/`follow_symlinks=False` i przy dowolnym reparse kończy się `unsafe_execution_tree`. Nie można więc uznać `Remove-Item -Recurse` za bezpieczną procedurę na podstawie samego containmentu targetów.

W szczególności nie użyto `Remove-Item`, `cmd /c rmdir`, `rmdir`, `shutil.rmtree` ani żadnej procedury kasującej. Nie zmieniono kolejki, kontenerów, cache, worktree ani artefaktów. Nie ma zgody użytkownika na te siedem dokładnych celów.

## Warunek ewentualnego przyszłego wykonania

Jeżeli użytkownik osobno zatwierdzi dokładne katalogi, przed każdą operacją trzeba ponowić dla konkretnego joba kontrolę receipt/coordinator, właściciela, procesu i mountów, containment, wszystkich reparse targetów oraz stanu Docker. Wykonanie musi użyć zweryfikowanej procedury usuwającej same wpisy linków bez podążania za reparse i musi zachować receipts, coordinator, logi, `artifacts`, `trusted`, source capsule oraz współdzielone build/cache. Zmiana stanu któregokolwiek joba unieważnia tę propozycję.
