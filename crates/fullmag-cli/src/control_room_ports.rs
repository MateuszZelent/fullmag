//! Own the listeners selected for one independent control plane.
use anyhow::{bail, Context, Result};
use std::net::{Ipv4Addr, TcpListener};
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};

struct ReservedPorts {
    api_port: u16,
    web_port: u16,
    preferred_web: u16,
    api: Option<TcpListener>,
    web: Option<TcpListener>,
    _allocation_lock: Option<std::fs::File>,
}

static RESERVED: OnceLock<Mutex<ReservedPorts>> = OnceLock::new();

fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))
}

fn reserve_pair(preferred_api: u16, preferred_web: u16) -> Result<ReservedPorts> {
    if preferred_api != 0 && preferred_web != 0 && preferred_api != preferred_web {
        if let Ok(api) = bind(preferred_api) {
            if let Ok(web) = bind(preferred_web) {
                return Ok(ReservedPorts {
                    api_port: preferred_api,
                    web_port: preferred_web,
                    preferred_web,
                    api: Some(api),
                    web: Some(web),
                    _allocation_lock: None,
                });
            }
        }
    }
    // A collision on either preferred listener moves both endpoints. Keep
    // the actual kernel listeners, rather than returning closed probes.
    for _ in 0..64 {
        let api = bind(0).context("failed to reserve API listener")?;
        let web = bind(0).context("failed to reserve frontend listener")?;
        let api_port = api.local_addr()?.port();
        let web_port = web.local_addr()?.port();
        if api_port != preferred_api && web_port != preferred_web {
            return Ok(ReservedPorts {
                api_port,
                web_port,
                preferred_web,
                api: Some(api),
                web: Some(web),
                _allocation_lock: None,
            });
        }
    }
    bail!("failed to reserve an independent API/frontend port pair")
}

pub(crate) struct PortAllocationGuard(bool);

impl PortAllocationGuard {
    pub(crate) fn attached() -> Self {
        Self(false)
    }
}

impl Drop for PortAllocationGuard {
    fn drop(&mut self) {
        if self.0 {
            finish_startup();
        }
    }
}

pub(crate) fn finish_startup() {
    if let Some(ports) = RESERVED.get() {
        let mut ports = ports.lock().expect("listener lock poisoned");
        ports.api.take();
        ports.web.take();
        ports._allocation_lock.take();
    }
}

pub(crate) fn initialize(
    preferred_api: u16,
    preferred_web: u16,
    allocation_root: &std::path::Path,
) -> Result<(u16, PortAllocationGuard)> {
    // Windows has no POSIX listener inheritance. Serialize Fullmag bootstrap
    // across worktrees until both owned services bind, not for the solver run.
    // The OS still owns port admission; an external race fails closed.
    #[cfg(windows)]
    let allocation_lock = {
        use std::fs::{OpenOptions, TryLockError};
        std::fs::create_dir_all(allocation_root)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(allocation_root.join("launcher-port-allocation.lock"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(50))
                }
                Err(TryLockError::WouldBlock) => {
                    bail!("another Fullmag instance is still bootstrapping its listeners")
                }
                Err(TryLockError::Error(error)) => return Err(error.into()),
            }
        }
        Some(lock)
    };
    #[cfg(not(windows))]
    let allocation_lock = {
        let _ = allocation_root;
        None
    };
    let mut pair = reserve_pair(preferred_api, preferred_web)?;
    pair._allocation_lock = allocation_lock;
    let port = pair.api_port;
    RESERVED
        .set(Mutex::new(pair))
        .map_err(|_| anyhow::anyhow!("control plane listeners already reserved"))?;
    Ok((port, PortAllocationGuard(true)))
}

pub(crate) fn web_port() -> Option<u16> {
    RESERVED
        .get()
        .map(|ports| ports.lock().expect("listener lock poisoned").web_port)
}

pub(crate) fn public_mapping_matches(listen_port: u16) -> bool {
    RESERVED.get().is_none_or(|ports| {
        let ports = ports.lock().expect("listener lock poisoned");
        ports.preferred_web == listen_port
    })
}



pub(crate) fn spawn(command: &mut Command, api: bool, inherit: bool) -> std::io::Result<Child> {
    let listener = RESERVED.get().and_then(|ports| {
        let mut ports = ports.lock().expect("listener lock poisoned");
        if api {
            ports.api.take()
        } else {
            ports.web.take()
        }
    });
    let key = if api {
        "FULLMAG_API_LISTENER_FD"
    } else {
        "FULLMAG_WEB_LISTENER_FD"
    };
    command.env_remove(key);
    #[cfg(unix)]
    if inherit {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        if let Some(listener) = listener {
            let fd = listener.as_raw_fd();
            command.env(key, fd.to_string());
            // Change flags only in the forked child. Parent reservations stay
            // close-on-exec so unrelated children cannot retain these sockets.
            unsafe {
                command.pre_exec(move || {
                    let flags = libc::fcntl(fd, libc::F_GETFD);
                    if flags == -1
                        || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let child = command.spawn();
            drop(listener);
            return child;
        }
        return command.spawn();
    }
    // Windows cannot consume POSIX descriptors.
    // Release only immediately before spawn; callers verify the child and its
    // instance identity and fail closed if an unrelated process wins the bind.
    let _ = inherit;
    drop(listener);
    command.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collision_on_web_moves_and_reserves_both_ports() {
        let occupied_web = bind(0).unwrap();
        let free_api = bind(0).unwrap();
        let preferred_api = free_api.local_addr().unwrap().port();
        let preferred_web = occupied_web.local_addr().unwrap().port();
        drop(free_api);
        let pair = reserve_pair(preferred_api, preferred_web).unwrap();
        assert_ne!(pair.api_port, preferred_api);
        assert_ne!(pair.web_port, preferred_web);
        assert!(bind(pair.api_port).is_err());
        assert!(bind(pair.web_port).is_err());
    }

    #[test]
    fn concurrent_starts_hold_disjoint_port_pairs() {
        let threads: Vec<_> = (0..10)
            .map(|_| std::thread::spawn(|| reserve_pair(0, 0).unwrap()))
            .collect();
        let pairs: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        let ports: std::collections::HashSet<_> = pairs
            .iter()
            .flat_map(|pair| [pair.api_port, pair.web_port])
            .collect();
        assert_eq!(ports.len(), 20);
    }
}
