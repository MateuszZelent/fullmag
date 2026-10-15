use std::process::Command;

/// Capability used by the local desktop operator to edit host compute policy.
pub const LOCAL_COMPUTE_OPERATOR_TOKEN_ENV: &str = "FULLMAG_LOCAL_COMPUTE_OPERATOR_TOKEN";

/// Prevent process-local operator authority from crossing a child-process
/// boundary, especially into interpreters or user-authored solver code.
pub fn remove_local_compute_operator_token(command: &mut Command) {
    command.env_remove(LOCAL_COMPUTE_OPERATOR_TOKEN_ENV);
}

#[cfg(test)]
mod tests {
    use super::{remove_local_compute_operator_token, LOCAL_COMPUTE_OPERATOR_TOKEN_ENV};
    use std::{ffi::OsStr, process::Command};

    #[test]
    fn child_commands_do_not_inherit_the_local_operator_capability() {
        let mut command = Command::new("worker");
        command.env(LOCAL_COMPUTE_OPERATOR_TOKEN_ENV, "secret");

        remove_local_compute_operator_token(&mut command);

        assert!(command.get_envs().any(|(key, value)| {
            key == OsStr::new(LOCAL_COMPUTE_OPERATOR_TOKEN_ENV) && value.is_none()
        }));
    }
}
