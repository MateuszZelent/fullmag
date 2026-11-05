# Naprawa worktree-finish — plan implementacji

> **For agentic workers:** wykonanie zadań według tego planu; niezależny worker odpowiada za recorded consumer identity, root za finisher, integrację i operacje usuwania.

**Cel:** zakończyć bezpieczny lifecycle zbędnych, scalonych worktree bez uzależnienia od dostępności źródeł innych grup i bez wymagania historycznego Compose w źródłowym checkoutcie.

**Architecture:** tożsamość wybranego targetu i wszystkie blokady pozostają w istniejącym `BuildControl`/`docker_cache_retirement`. Odtwarzanie identity innego konsumenta jest czystą funkcją hashującą zapisany kanoniczny string. Dla legacy źródeł operator może jawnie wskazać zainstalowany immutable obraz technicznego helpera zamiast renderowania brakującego Compose.

**Tech Stack:** standardowa biblioteka Python, unittest, istniejące managed helpery Docker.

**Spec:** ograniczenia poniżej oraz `docs/guides/fullmag-build-storage-governance.md`, sekcja zakończenia worktree.

**Baza:** `e8e92c82c49d919300c6cf2153e73ce18f1e452b`, branch `codex/worktree-finish-repair-20261105`.

## Ograniczenia

- Zachować Zarr, wyniki, niezintegrowaną pracę, aktywne i nierozstrzygnięte środowiska oraz control/ledger/provenance.
- Tylko exact task/owner może zakończyć wybrany zarejestrowany worktree. Główny checkout jest chroniony.
- Brak dostępnego checkoutu innego konsumenta nie może blokować niepowiązanego namespace, jeżeli zapisane identity, hashe i mounty dowodzą jego odrębności.
- Nie wolno pominąć blokad kontenera korzystającego z docelowego namespace, bind aliases, nieznanej tożsamości ani aktywnego lease.
- Bez globalnego prune, force, startów aplikacji i buildów backendu. Lekkie testy Python i istniejące managed helpery retencji.

## Kroki

- [x] Odtworzyć błąd brakujących/cross-host źródeł innych konsumentów testem regresji.
- [x] Oddzielić weryfikację zapisanej tożsamości konsumenta od sprawdzania żywego katalogu źródłowego; zachować wszystkie kontrole hashy, mountów i namespace.
- [x] Ustalić i wdrożyć obsługiwaną ścieżkę finishera dla historycznych źródeł bez Compose, z przypiętym helperem i pełnym inventory.
- [x] Przetestować niezgodną tożsamość, własny namespace, nieznanego konsumenta, owner i drift oraz zachowanie chronionych danych. Blokady lease pozostają w niezmienionym BuildControl.
- [ ] Review, commity etapów, CI/PR do mastera i integracja zgodnie z governance.
- [ ] Ponownie kwalifikować każdy cel z audytu, wykonać worktree-finish, niezależny inventory i pojedyncze usunięcia Git bez force. Zapisać receipty i rzeczywiste pomiary.

## Pliki i weryfikacja

- Recorded identity: `scripts/docker_cache_retirement.py`, regresje w `scripts/test_docker_cache_retirement.py`; RED dla brakującego source obu profili, GREEN i negatywne testy drift/namespace/path.
- Jawny obraz kontrolny: `scripts/docker_worktree_finish.py`, `scripts/fullmag_storage.py`, testy w `scripts/test_docker_worktree_finish.py`; RED nieobsługiwanego wejścia, GREEN bez Compose, odmowa tagu/niezainstalowanego obrazu, ownera i niepoprawnej akcji CLI.
- Dokumentacja lifecycle: `docs/guides/fullmag-build-storage-governance.md`.
- Regresje zależności: `test_fullmag_storage.py`, `test_docker_backend_volume_cache.py`, `test_docker_group_backend_cache.py`, `test_docker_shared_build_storage.py` i `test_docker_build_control_cache_admission.py`.
- Operacyjne receipty, końcowe ścieżki i pomiary pozostają w audycie poza kodem; nie są artefaktami builda.

## Dowody operacyjne

Etap 1: commit `c19c9baa0ff855407f0b22396af8eecfd74bed49`, recorded consumer identity. RED: dwa scenariusze missing-source obu profili. GREEN: 45 testów `test_docker_cache_retirement.py`.

Etap 2: RED dla nowego wejścia finishera; GREEN: 10 testów `test_docker_worktree_finish.py` i 54 testy `test_fullmag_storage.py` (1 platformowy skip). Wybór helper image jest świadomym pinem operatora z istniejącej kwalifikowanej konfiguracji/receiptu, zapisywanym w operacyjnym planie cleanupu.

Audyt wejściowy: `/mnt/c/Users/Mateusz/Documents/ChatGPT/Fullmag/storage-audit-20261105-0742`. Pierwszy failed-confirmed finisher PR373: attempt `08cd49abb8b94934adc3482ba49366b5`, bez usunięcia źródeł. Nie ponawiać operacji o nieznanym wyniku.
