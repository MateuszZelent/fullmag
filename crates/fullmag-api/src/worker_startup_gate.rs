//! Startup ordering for a supervisor-owned Windows process tree.
use std::io::{self, Read};

pub const STARTUP_GATE_FLAG: &str = "--startup-gate";
pub const STARTUP_GATE_VERSION: &str = "stdin-v1";
pub const STARTUP_GATE_RELEASE: u8 = 1;

pub fn wait_for_release(mut input: impl Read) -> io::Result<()> {
    let mut token = [0];
    input.read_exact(&mut token)?;
    if token[0] != STARTUP_GATE_RELEASE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid worker startup release",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_release_is_required_before_worker_initialization() {
        assert!(wait_for_release(&[STARTUP_GATE_RELEASE][..]).is_ok());
        assert_eq!(
            wait_for_release(&[][..]).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(
            wait_for_release(&[0][..]).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
