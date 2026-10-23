pub use fullmag_runtime_control::process_environment::{
    LOCAL_COMPUTE_OPERATOR_TOKEN_ENV, remove_local_compute_operator_token,
};

#[cfg(test)]
mod tests {
    use super::{LOCAL_COMPUTE_OPERATOR_TOKEN_ENV, remove_local_compute_operator_token};
    use std::{ffi::OsStr, process::Command};

    #[test]
    fn child_commands_cannot_inherit_the_local_operator_capability() {
        let mut command = Command::new("worker");
        command.env(LOCAL_COMPUTE_OPERATOR_TOKEN_ENV, "secret");

        remove_local_compute_operator_token(&mut command);

        assert!(command.get_envs().any(|(key, value)| {
            key == OsStr::new(LOCAL_COMPUTE_OPERATOR_TOKEN_ENV) && value.is_none()
        }));
    }
}
