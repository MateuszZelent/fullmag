# P8-28 — wspólny natywny odczyt zasobów hosta

## Cel i zakres

Czysta instalacja Windows nadal nie uruchamia usługi accepted execution bez
`FULLMAG_RUNTIME_SERVICE_CONFIG`. Generator tej konfiguracji potrzebuje
prawdziwych danych hosta. Dotychczasowe odczyty CPU/RAM/storage były prywatne
w programie publishera `resource_pool_main.rs`, niedostępne dla launchera.

Wydzielono `fullmag_runtime_control::local_resources::LocalCpuCapacity`:

- CPU: `available_parallelism`, pojemność w cpu_millis;
- Windows RAM: `GlobalMemoryStatusEx`, dostępne bajty fizycznej pamięci;
- Windows storage: `GetDiskFreeSpaceExW`, bajty dostępne dla użytkownika;
- Linux RAM: `MemAvailable` z `/proc/meminfo`, przeliczenie KiB na bajty;
- Unix storage: `statvfs`, pojemność dostępna dla użytkownika.

Odczyt jest snapshotem obserwacji, nie rezerwacją ani obietnicą przyszłej
dostępności. Błędy pozostają błędami; nie generuje się zastępczej pojemności.
Publisher korzysta z tego samego helpera. Algorytm podziału zasobów, jawne
rezerwy, discovery NVIDIA, resource IDs, requested/resolved device i publikacja
puli pozostają bez zmiany. Nie zmieniono fizyki, DSL, ProblemIR ani OpenAPI.

## Weryfikacja i ochrona checkoutu

- Treść wydzielonych funkcji OS porównana z committed HEAD: identyczna.
- `rustfmt --check` nowego modułu i publishera: PASS; parser crate root z
  `skip_children=true`: PASS, bez przeformatowania cudzych zmian.
- `cargo metadata --locked --offline --no-deps`: PASS, bez kompilacji.
  Windows używa już obecnego w lockfile `windows-sys 0.61.2`, z potrzebnymi
  features; Unix zachowuje istniejące libc.
- Cudze zmiany formatowania `fullmag-runtime-control/src/lib.rs` pozostają
  unstaged; do fragmentu należy wyłącznie deklaracja nowego modułu.
- Niezależne bounded source review: PASS, bez P0/P1. Potwierdzono niezmienioną
  semantykę odczytów, prawidłowe targetowe zależności i podział budżetów publishera.
- Typecheck/build/runtime Windows/Linux: NOT VERIFIED. Nie kompilowano testów
  jednostkowych. Zgodność treści odczytów nie zastępuje wykonania nowego modułu.

## Następny zależny krok

Generator default konfiguracji musi stosować canonical accepted-store resolver,
budżety obu pul bez podwójnej rezerwacji RAM/storage/CPU oraz istniejący
handshake API przed zapisami. Start/attach wymaga stabilnej konfiguracji po
ponownym otwarciu aplikacji; zmienny snapshot wolnej pamięci nie może zmienić
konfiguracji już działającej usługi. GPU wymaga powiązania z rzeczywistym
urządzeniem i backendem; obecność sterownika nie dowodzi realizacji FEM GPU.

Helper nie uruchamia jeszcze automatycznej usługi. Pełny P0–P8, dystrybucja
Windows bez Docker/WSL, cutover i kwalifikacja wydania pozostają otwarte.
Nie zmieniono sesji 3104 ani aktywnych zasobów.
