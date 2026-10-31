# Jeden prywatny wolumen DEV i odpięcie storage hosta — implementacja

Stan: kod i testy źródeł zweryfikowane 31.10.2026. Rzeczywisty build, mounty
Docker, restart i migracja istniejących grup: **NOT VERIFIED**. Nie wykonano
nowego buildu, restartu usług ani usuwania dotychczasowych wolumenów w ramach
tej zmiany; nie deklarujemy odzyskania kolejnych GB.

## Zmiana zachowania

Nowy render zapisuje `private_group_storage=group-volume-v1` przed alokacją.
Wykorzystuje istniejący `BuildControl.volume` grupy dla backendu, frontendu,
control i ledgeru. Osobne aliasy Compose wskazują ten sam named volume;
mounty prywatnego stanu ograniczają się do odpowiednich subpathów. Tożsamość
wolumenu oraz `groups/<unit_key>` pakietów nie zależy od toolchainu, profilu,
commit SHA ani próby; zmienne fingerprinty nadal walidują zgodność pakietów.

Przed rzeczywistą kompilacją backendu i po udanej publikacji oraz ponownej
walidacji pakietu czyszczone jest wyłącznie `.fullmag-build`. Cleanup działa
pod istniejącą blokadą buildu i sprawdza markery właściciela. Cache-hit nie
czyści i nie kompiluje; błąd zachowuje jedną generację compiler outputs w
stałej ścieżce. Oznacza to koszt pełnej kompilacji po zmianie źródeł. Pakiet
current, jeden bezpośredni rollback, źródła, logi, control, ledger oraz dane
użytkownika mają osobną retencję i pozostają chronione.

Retirement rozpoznaje nowy rejestr i namespace pakietów, lecz nie usuwa wspólnego
prywatnego wolumenu control. Czyści wyłącznie wymienione compiler/dependency
leaves; nieznane pliki zachowuje i raportuje. Recovery odczytuje stare układy,
a przerwana operacja i frontend refresh zachowują przypięty tryb storage.
Istniejący bootstrap z samymi kanonicznymi etykietami shared jest obsługiwany;
obecne dodatkowe etykiety nie mogą wskazywać obcej grupy.

## Zależność od hosta

Build samych obrazów potrzebuje Git, wybranego checkoutu i Dockera. Usunięto
wywołanie hostowego resolvera storage dla samej Compose identity oraz wybór
źródeł z hostowego indeksu runtime w direct bootstrap. Nowe API
`compose_source_identity` zachowuje dotychczasowe nazwy grup i sprawdza rejestr
worktree w Git. Plan cache nowej grupy nie korzysta z hostowego runroot.

Uruchomienie API nadal potrzebuje miejsca na sesje, projekty, wyniki i ustawienia.
Te mounty nie są danymi kompilacji. Szczegóły tras:
[osobny audyt host storage](2026-10-31-docker-host-storage-dependencies.md).

## Dowody

- Linux: 530 testów, zero błędów. Zestawy Python/Linux obejmują adapter grupy, cache, ledger, retirement,
  bootstrap, admission, konteksty obrazów, backend/frontend i recovery.
  Osobny nowy zestaw CI działa na Windows i Ubuntu, bez kompilacji unit tests.
- Windows: 84 testy, zero błędów, 9 pominiętych przypadków wymagających POSIX.
  Odpowiedniki POSIX i rzeczywisty kod guest helperów sprawdzono w WSL.
- `contract_guard.sh --strict`: exit code 0. Kontrola 164 manifestów dokumentacji
  naukowej względem źródeł: exit code 0. Nie jest to kwalifikacja fizyki.
- Zmodyfikowane Python parsują się; kontrola whitespace i lokalnych linków przeszła.
- Inicjalizator uruchomiony w izolowanym katalogu Linux: init/reopen stabilnego
  ownera, zachowanie nieznanych wyników i odmowa obcego markera przeszły.
  [Receipt](single-group-volume-guest-smoke-20261031.json) nie jest receiptem Dockera.

Pełne lokalne logi i zbiorcze wyniki są zachowane w katalogu zadania
`Documents/ChatGPT/Fullmag/single-volume-verification-20261031` użytkownika hosta.

## Instrukcje i pozostały zakres

Zmieniono AGENTS, instrukcje backend/frontend, skill `fullmag-docker-build`, jego
referencje, pięć przewodników storage i dodano [ADR 0076](../adr/0076-single-private-volume-per-dev-group.md).
Zaktualizowano także osobisty skill `fullmag-build-stage-cleanup` na tym hoście.
[Audyt instrukcji](2026-10-31-storage-instructions-review.md) wskazuje rozstrzygnięte
sprzeczności oraz źródła oficjalnej dokumentacji Docker.

Stare grupy nie migrują automatycznie. Weryfikacja nowej grupy na Docker i
migracja zatrzymanych, rozpoznanych grup pozostają kolejnym zakresem operacyjnym;
nie należy restartować aktywnych cudzych grup ani usuwać ich danych na podstawie
samego merge tego kodu. Pełny rozmiar Dockera, warstwy BuildKit i shared store
wymagają dalszego pomiaru i osobnej retencji; jeden wolumen nie stanowi quota.
