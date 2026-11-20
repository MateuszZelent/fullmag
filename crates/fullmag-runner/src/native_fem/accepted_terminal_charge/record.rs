//! Runner compatibility facade for the backend-neutral charge artifact codec.

pub(crate) use fullmag_antenna_artifacts::charge::AcceptedTerminalChargeRecord;

pub(crate) fn decode_accepted_terminal_charge_record(
    payload: Vec<u8>,
    expected_sha256: &str,
) -> Result<AcceptedTerminalChargeRecord, crate::types::RunError> {
    fullmag_antenna_artifacts::charge::decode_accepted_terminal_charge_record(
        payload,
        expected_sha256,
    )
    .map_err(Into::into)
}
