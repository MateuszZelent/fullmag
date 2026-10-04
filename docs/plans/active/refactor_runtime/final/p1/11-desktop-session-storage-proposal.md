# Propozycja: trwały magazyn sesji Docker Desktop

Status: SUPERSEDED jako rekomendacja produktu — niczego nie provisionowano.
Data: 02.10.2026.

Operator doprecyzował, że produkt Windows ma działać całkowicie niezależnie
od Linuxa, WSL i Dockera. Poniższy wolumen dotyczyłby wyłącznie środowiska
testowego Linux/Docker i nie zamyka Windows packaging ani persistence.
Nie oczekujemy zgody na niego jako rozwiązanie produkcyjne. Zachowujemy
opis jako historyczne rozpoznanie problemu 9p; kierunek produktu określa
P8-C w planie głównym. Natywny zapis Windows wymaga osobnej weryfikacji.

## Problem

Linuxowy backend działa w Docker Desktop. Katalog projektu Windows jest
widoczny jako 9p (0x1021997), odrzucany przez writer SessionStore. Zwykły
katalog zamiast symlinka usuwa błąd containment, ale nie dowodzi trwałości.
Nie rozszerzamy allowlisty filesystemów i nie wyłączamy guardów.

## Proponowany wyjątek

Jeden jawny, trwały named volume Docker dla prywatnego runtime przeglądarki,
zarejestrowany w kanonicznym storage jako adapter, z jednoznacznym właścicielem,
pełnym container ID, volume name, inspect i hashami pakietu. Fizyczne dane
znajdowałyby się w dysku Linux Docker Desktop. Eksporty i receipty pozostają
pod resolverowym storage projektu. To zmiana obecnej polityki fizycznej
lokalizacji danych, dlatego nie wynika automatycznie ze zgody na build.

Wolumen nie jest cache. Nie usuwa go down -v, prune ani cleanup buildu.
Reset/usunięcie dysku Docker Desktop może utracić dane bez aktualnego eksportu.
Nie przyjmujemy nazwy ext4 jako kwalifikacji po utracie zasilania.

## Zakres przygotowania

1. Przed provisionowaniem odczytać decyzję operatora. Użyć świeżego volume name
   przypisanego do UUID runtime; nie przejmować istniejących wolumenów.
2. Zweryfikować rzeczywisty typ filesystemu przez nieuprzywilejowany kontener
   diagnostyczny oraz zgodność mountu i właściciela. Inicjalizacja uprawnień
   dotyczy wyłącznie nowego prywatnego katalogu; aplikacja zachowuje UID 65532,
   read-only rootfs, cap_drop ALL i brak socketu Docker.
3. Oddzielić volume stanu od bindów source/package read-only i evidence.
   Repozytorium sesji pozostaje zwykłym katalogiem pod prywatnym workspace.
4. Utworzyć kandydacki runtime na oddzielnym porcie. Przetestować checkpoint
   list/create oraz odtworzenie po restarcie dokładnie jego kontenera.
5. Wykonać eksport prywatnych danych SessionStore do świeżego katalogu pod
   storage i sprawdzić odtworzenie z eksportu. Nie podążać za linkami do źródeł.
6. Zachować bieżącą scenę 3104, sprawdzić aktualną rewizję i niezastosowane
   drafty. Nie zastępować aktywnej sesji, zanim kandydat i odtworzenie przejdą.
7. Przełączyć port 3104 dopiero po dowodach. Stary kontener i dane zachować
   zatrzymane jako rollback; nie usuwać bez odrębnej zgody.

## Dowody i ograniczenia

Build nowego frontendu: job 200, `7295501a0e4847039a7ae806f780dcdc`,
commit `18e816e7a0e4020c260730db0affc20c3db19312`, w trakcie.
Storage / checkpoint / restart / restore powyżej: NOT VERIFIED.
Nie zmienia się DSL, ProblemIR, requested/resolved CPU, solver ani fizyka.
Alternatywa: pozostawić obowiązujący storage i przygotować kwalifikowany
adapter Windows/Linux lub zewnętrzny istniejący mount — bez cichego fallbacku.

## Precyzja bramki checkpointów

GET list musi zwrócić 200 na pustej sesji. POST capture bez magnetyzacji
ma dokumentowane 400 i nie może być przepisywany na PASS capture/restore.
Rzeczywisty checkpoint wymaga oddzielnego małego scenariusza z dostępnymi
wektorami, nie tylko utworzenia pustego FEM. Zapis/odtworzenie definicji
projektu, restart kontenera i restore checkpointu to osobne dowody.

Wolumen external w Compose zachowuje niezależny cykl życia; eksport/restore
jest obowiązkiem adaptera, a nie skutkiem restartu kontenera.
Źródło mechanizmu: [Docker — Volumes](https://docs.docker.com/engine/storage/volumes/).

## Wynik niezależnego przeglądu — wymagania przed wdrożeniem

- Wolumen musi być montowany dokładnie pod /state. SessionStore nadal
  wyprowadza root z repo_root/.fullmag/local-live/session-store; samo
  FULLMAG_STATE_ROOT nie przekierowuje wszystkich konsumentów.
- Świeży wolumen wymaga ograniczonego bootstrapu własności UID/GID 65532
  bez privileged, sieci i socketu Docker. Nie chownować żadnych istniejących
  cache lub cudzych danych. Zachować pełny inspect/bootstrap receipt.
- current_live_state jest w pamięci i startuje puste. Restart nie jest
  automatyczną rehydratacją. Odtworzenie definicji przez API, skryptu,
  identity i ewentualnych checkpointów musi być jawnie sprawdzone.
- Nie kopiować aktywnego SessionStore przez surowy tar. Preferować kanoniczny
  eksport FMS przez API; surowy eksport wymaga zatrzymanego właściciela,
  bez aktywnych writerów i dopuszczonego, spójnego snapshotu repozytorium.
- Restore wykonać do świeżego prywatnego wolumenu, sprawdzić scenę, IDs,
  skrypt i właściwą klasę restore. Kopia samego model/scene nie zachowuje
  wyników obliczeń ani wszystkich stanów runtime.

Przegląd nie zmienia PROPOSED na ACCEPTED i nie udziela zgody na provisioning.
