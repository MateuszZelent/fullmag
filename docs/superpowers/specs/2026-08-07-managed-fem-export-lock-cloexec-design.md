# Projekt higieny deskryptora blokady eksportu FEM

**Data:** 2026-08-07

## Problem

`scripts/export_fem_gpu_runtime.sh` otwiera `.fem-gpu-host.export.lock` jako deskryptor 9 i utrzymuje go podczas uruchamiania wielu programów potomnych. Proces `readlink`, który od 2026-08-05 pozostaje w stanie `D`, odziedziczył ten deskryptor. Mimo że pierwotny eksport już nie działa, proces potomny nadal utrzymuje blokadę i uniemożliwia świeży managed build FEM.

## Zaakceptowane rozwiązanie

Pierwsze uruchomienie skryptu zastępuje się procesem `flock --close <lock> bash <script>`. Proces `flock` pozostaje właścicielem blokady aż do zakończenia skryptu, natomiast `--close` nie udostępnia deskryptora uruchamianemu skryptowi ani jego potomkom. Zmienna środowiskowa `FULLMAG_RUNTIME_EXPORT_LOCK_HELD=1` zapobiega ponownemu opakowaniu skryptu po przejściu do immutable source snapshot.

Skrypt zachowuje komunikat o oczekiwaniu: najpierw wykonuje bezblokujący probe. Jeśli blokada jest zajęta, publikuje komunikat, a następnie czeka przez zewnętrzny `flock`.

Ponieważ legacy inode pozostaje bezterminowo utrzymywany przez osierocony proces `readlink` w stanie `D`, publikacja przechodzi na nową generację `.fem-gpu-host.export.v2.lock`. Migracja została jawnie zaakceptowana 2026-08-07. Przed zmianą potwierdzono brak aktywnego procesu eksportu starej wersji; legacy deskryptor należy wyłącznie do zakleszczonego procesu niebędącego eksporterem.

## Odrzucone warianty

- Pomocniczy program Python z `O_CLOEXEC`: poprawny, ale dodaje nową warstwę procesu i kod tylko do obsługi jednego locka.
- Ręczne zamykanie fd 9 przed każdym poleceniem zewnętrznym: nie utrzymuje blokady albo wymaga stale aktualizowanej listy wyjątków i ponownie może przeciekać.
- Zabicie procesu w stanie `D` lub restart WSL: destrukcyjne, nie gwarantuje natychmiastowego zakończenia procesu i nie usuwa przyczyny źródłowej.

## Kontrakt weryfikacji

1. Test źródłowy wymaga `flock --close`, zmiennej strażniczej i braku `exec 9>`.
2. Test wykonawczy uruchamia minimalny skrypt potomny i potwierdza, że żaden jego deskryptor nie wskazuje pliku locka, podczas gdy konkurencyjny probe nadal nie może przejąć blokady.
3. Istniejące testy helperów eksportu pozostają zielone.
4. Po wdrożeniu managed rebuild może nadal czekać na stary, już wyciekły deskryptor. Nowa implementacja zapobiega kolejnym wyciekom, ale nie usuwa istniejącego procesu `D`.

## Granica

Zmiana dotyczy wyłącznie serializacji publikacji managed FEM runtime. Nie zmienia obrazu kontenera, solvera, bundle identity ani semantyki pól.
