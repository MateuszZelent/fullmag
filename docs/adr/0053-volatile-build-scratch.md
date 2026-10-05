# ADR 0053 — ulotny scratch buildów poza trwałym storage

Data: 2026-10-05. Decyzja zlecona przez użytkownika; wdrożenie i kwalifikacja
pozostają otwarte w planie ramdisku. Dotyczy lokalizacji danych, bez zmiany
fizyki, publicznego DSL/ProblemIR ani wyboru CPU/GPU.

## Kontekst

Operator udostępnił RAM-dysk dla jednorazowych danych kompilacji. Przeniesienie
całego storage do RAM utraciłoby źródła, wyniki i dowody; obecna reguła jednego
roota blokuje również prawidłowe wydzielenie prywatnego scratchu.

## Decyzja

- `FULLMAG_PROJECT_STORAGE_ROOT` pozostaje trwałym rootem. Kapsuły/CAS,
  kolejka, logi, receipty, artefakty, promowane runtime i pobrane zależności
  pozostają tam. Działające UI korzysta z trwałego pakietu.
- Opcjonalny `FULLMAG_PROJECT_SCRATCH_ROOT` wskazuje jawnie zarejestrowany
  root dla danych odtwarzalnych. Brak ustawienia zachowuje stare zachowanie.
  Namespace jest izolowany według projektu, worktree, profilu i joba.
- Marker scratchu wiąże trwały marker projektu, identyfikator rejestracji
  i generację ulotnej zawartości. Rejestr i historia pozostają na trwałym dysku.
  Root nie może zawierać checkoutów, pokrywać trwałego storage, być rootem
  filesystemu ani przechodzić przez symlink/junction.
- Windows kieruje tam jednorazowe tymczasowe pliki kompilacji. Przyrostowe
  cache Cargo i domyślne intermediate directory pozostają trwałe. Końcowy
  pakiet, środowisko Python i zależności działającego frontendu pozostają trwałe.
  Odtwarzalne cache kompilacji w RAM mogą działać do utraty zawartości; nie
  mają być mylone z trwałymi wynikami ani instalowanymi zależnościami.
- Runner przyjmuje root wyłącznie z konfiguracji operatora, z dokładnym
  dodatkowym mountem. Payload joba nie wybiera ścieżek. Kapsuła i publikacja
  artefaktów są trwałe; zapisywalny workspace oraz scratch kompilatora są ulotne.
- Brak dysku lub obcy marker kończy preflight. Nie ma cichego fallbacku.
  Jawne `prepare-scratch` odtwarza pusty zarejestrowany namespace
  z nową generacją wyłącznie bez aktywnego użytkownika wspólnej bramki;
  stare aktywne wykonania wymagają sprawdzenia kontenera/lease i terminalnego
  rozstrzygnięcia, nie wznowienia na podstawie samej ścieżki.
- Usuwanie scratchu dotyczy wyłącznie własnego zasobu po utrwaleniu artefaktów
  i sprawdzeniu rzeczywistych użytkowników. Cache profilu ma odrębny lifecycle
  od prywatnego execution; nie usuwamy go jako skutku cleanupu innego joba.

## Obowiązki implementacji

Resolver i adapter Windows muszą walidować oba role rootów. Runner musi
zachować zamknięty kontrakt payloadu, atestację mountów, trwały journal oraz
rozpoznawanie utraty generacji. Retencja nie może używać arbitralnych ścieżek.
Konfiguracja hosta jest lokalna; repozytorium dokumentuje klucze i role.

NTFS/RAM nie dowodzi widoczności w Dockerze, zapisu UID65532 ani semantyki
narzędzi. Osobna sonda Desktop musi poprzedzić build w nowym scratchu.
Nie zmienia to guardów ext4/loop istniejącej trasy Linux ani kwalifikacji FEM.

## Rollback i weryfikacja

Wyłączenie konfiguracji dotyczy przyszłych buildów; istniejące joby i UI
zachowują swoją tożsamość i ścieżki. Nie przenosimy ani nie kasujemy ich danych.
Wymagane: regresje izolacji/markerów, pustego resetu RAM i utraty generacji,
sonda rzeczywistego mountu, pełny zarządzany build z publikacją/hashem trwałego
pakietu oraz kontrola istniejących profili. Sukces storage/builda nie dowodzi
obliczeń solvera ani kwalifikacji naukowej.
