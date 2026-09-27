# P3/P5 — fail-closed budżet oferty solvera

Data checkpointu: 27.09.2026.

Implementacja: `07d2938891675f8bfb2d770672334c2cbda775d7`.

## Zakres

Centralna granica `claimed_task_resource_compatibility`, używana przez
scheduler oraz bezpośredni durable admission, waliduje teraz nie tylko klasę
CPU/GPU, lecz także kształt budżetu oferty. Przed utworzeniem attemptu i lease'u
wymagane są:

- dla CPU: dodatnie `cpu_millis`, `memory_bytes` i `storage_bytes` oraz zerowe
  `gpu_memory_bytes`,
- dla GPU: dodatnie `cpu_millis`, `memory_bytes`, `gpu_memory_bytes` i
  `storage_bytes`.

Odmowa zwraca dokładną przyczynę jako niezgodność oferty. Reguła pozostaje w
granicy solvera, ponieważ wspólny `ResourceBudget` legalnie opisuje również
zasoby Storage i Meshing.

## Dowody

Praca została wykonana test-first. Pierwszy przebieg odrzucił nowe oczekiwania:
3 testy przeszły, 2 nie przeszły, receipt
`22a25b308d5045d2af180be6b5023132`. Po implementacji końcowe źródło przeszło
`just verify-runtime-control`: **5/5 PASS**, receipt
`e1db7ebf48674bab877249d6761ae0e9`, content
`f5f644c92a85c557916fa62b97c373efb3bd69f587e5c56ef0175615bbb14a6a`,
`source_changed_during_run=false`. `rustfmt` zmienionego pliku oraz scoped
`git diff --check` również przeszły.

Istniejąca procesowa bramka statycznej puli nie jest stabilnym dowodem tego
checkpointu. Jedna próba przeszła (`b218c76cc7ae463ea0c8a0a8341bcfad`), lecz
kolejne na tej samej zmianie kończyły się kontencją `session store writer is
busy` albo brakiem overlapu w 10 sekund. Ostatni receipt:
`9f2c865e9bda429eacde8ab205ad6e00` — **FAIL**. Oferty w scenariuszu miały
poprawny budżet i oba taski przechodziły admission do `Preparing`/`Running`,
więc awaria nie wskazuje odrzucenia przez nowy guard. Stabilizacja współbieżnej
kontencji writera była osobnym zadaniem P5-B; została następnie zamknięta w
[`49-writer-retry-jitter.md`](49-writer-retry-jitter.md).

## Granica checkpointu

Checkpoint blokuje puste lub sprzeczne budżety ofert solvera. Nie wprowadza
kanonicznego minimalnego zapotrzebowania per task, agregacji wykorzystania
CPU/RAM/VRAM/storage, dynamicznej pojemności puli ani egzekwowania limitów na
hoście lub urządzeniu. Nie zamyka CAE-66 ani dowodu zwolnienia GPU. Dlatego
procenty pozostają bez zmian: **P3 83%, P5 60%, całość około 41%**.
