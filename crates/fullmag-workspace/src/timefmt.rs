//! RFC 3339 UTC timestamps without a date-time dependency.
//!
//! Every timestamp the database writes has the fixed form
//! `YYYY-MM-DDTHH:MM:SS.mmmZ`, so lexicographic order equals chronological
//! order. Foreign timestamps (the legacy recent index writes whole seconds, a
//! hand-edited file may carry an offset) are normalised on import.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Format `time` as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn rfc3339_millis(time: SystemTime) -> String {
    let (seconds, millis) = match time.duration_since(UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as i64, d.subsec_millis()),
        Err(_) => (0, 0),
    };
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// The current time in the database timestamp form.
pub fn now_rfc3339() -> String {
    rfc3339_millis(SystemTime::now())
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.fraction](Z|+HH:MM|-HH:MM)`; `None` when the
/// text is not RFC 3339 or predates the Unix epoch.
pub fn parse_rfc3339(text: &str) -> Option<SystemTime> {
    let text = text.trim();
    let bytes = text.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let slice = bytes.get(range)?;
        if slice.iter().all(u8::is_ascii_digit) {
            std::str::from_utf8(slice).ok()?.parse().ok()
        } else {
            None
        }
    };
    if bytes[4] != b'-' || bytes[7] != b'-' || !matches!(bytes[10], b'T' | b't') {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut index = 19;
    let mut millis = 0_i64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
        let head: String = text[start..index].chars().take(3).collect();
        millis = head.parse::<i64>().ok()? * 10_i64.pow(3 - head.len() as u32);
    }
    let offset_seconds = match *bytes.get(index)? {
        b'Z' | b'z' if index + 1 == bytes.len() => 0,
        sign @ (b'+' | b'-') if index + 6 == bytes.len() && bytes[index + 3] == b':' => {
            let hours = num(index + 1..index + 3)?;
            let minutes = num(index + 4..index + 6)?;
            let total = hours * 3600 + minutes * 60;
            if sign == b'+' {
                total
            } else {
                -total
            }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month as u32, day as u32);
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_seconds;
    if seconds < 0 {
        return None;
    }
    Some(UNIX_EPOCH + Duration::from_secs(seconds as u64) + Duration::from_millis(millis as u64))
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64, millis: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds) + Duration::from_millis(millis)
    }

    #[test]
    fn formats_with_milliseconds() {
        assert_eq!(rfc3339_millis(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            rfc3339_millis(at(1_791_030_896, 42)),
            "2026-10-03T12:34:56.042Z"
        );
        assert_eq!(
            rfc3339_millis(at(1_709_208_000, 0)),
            "2024-02-29T12:00:00.000Z"
        );
    }

    #[test]
    fn parses_what_it_formats_and_foreign_forms() {
        let t = at(1_791_030_896, 42);
        assert_eq!(parse_rfc3339(&rfc3339_millis(t)), Some(t));
        assert_eq!(
            parse_rfc3339("2026-10-03T12:34:56Z"),
            Some(at(1_791_030_896, 0))
        );
        assert_eq!(
            parse_rfc3339("2026-10-03T14:34:56+02:00"),
            Some(at(1_791_030_896, 0))
        );
        assert_eq!(
            parse_rfc3339("2026-10-03T12:34:56.5Z"),
            Some(at(1_791_030_896, 500))
        );
        assert_eq!(parse_rfc3339("not a date"), None);
        assert_eq!(parse_rfc3339("2026-13-03T12:34:56Z"), None);
        assert_eq!(parse_rfc3339("2026-10-03 12:34:56Z"), None);
    }
}
