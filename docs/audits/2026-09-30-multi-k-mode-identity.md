# Multi-k: walidacja tożsamości modu - 2026-09-30

## Ustalenie i poprawka

`eigen_path.rs` odczytywał `index` przez `as_u64().unwrap_or(0) as usize`
i `frequency_real_hz` przez `as_f64().unwrap_or(0.0)`. Ten sam domyślny
indeks był używany przy pobieraniu wektora trackingowego. Brak danych mógł
więc tworzyć fikcyjny indeks/częstotliwość zamiast odrzucić wynik.

Dodano `eigen_path_native_mode_identities`: przed agregacją/trackingiem
wymaga jawnego indeksu u64 z checked conversion do usize, unikalności
indeksów oraz jawnej skończonej częstotliwości. Zachowuje kolejność i
rzeczywiste indeksy; jawne 0 Hz pozostaje legalne. Odczyt modu i wektora
trackingowego korzystają z tego samego zweryfikowanego indeksu.
Nie zastąpiono ani nie utworzono certyfikatu residualu. Podpis punktu,
indeksu i częstotliwości nadal musi odpowiadać oryginalnemu certyfikatowi.

## Weryfikacja i granice

Regresja Rust obejmuje brak indeksu/częstotliwości, ujemny i ułamkowy
indeks, tekst zamiast liczby, null, duplikaty oraz jawne zero i kolejność.
Rustfmt/parsing i diff check PASS. Kompilacja i wykonanie regresji Rust:
NOT VERIFIED, zgodnie z obowiązującym zakazem kompilacji unit tests.
Notę 0831 i source-map uzupełniono przed wykonaniem kolejnego buildu.

Build #171 poprzedza tę poprawkę. Następny managed runtime musi
potwierdzić ścieżkę multi-k oraz niezmienione certyfikaty per-mode.
