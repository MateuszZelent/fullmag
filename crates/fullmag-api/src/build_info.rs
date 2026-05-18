pub(crate) fn backend_build_date() -> &'static str {
    option_env!("FULLMAG_BACKEND_BUILD_DATE").unwrap_or("unknown-build-date")
}

#[cfg(test)]
mod tests {
    use super::backend_build_date;

    #[test]
    fn backend_build_date_has_iso_calendar_shape() {
        let date = backend_build_date();

        assert_eq!(date.len(), 10);
        assert_eq!(&date[4..5], "-");
        assert_eq!(&date[7..8], "-");
        assert!(date
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit()));
    }
}
