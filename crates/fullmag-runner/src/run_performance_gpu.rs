//! Best-effort, read-only NVML observations. Never creates a CUDA context.
//! Values describe the whole selected physical GPU, not process occupancy.

pub(crate) struct GpuSampler {
    #[cfg(unix)]
    reader: Option<unix::Reader>,
    reason: Option<String>,
}

impl GpuSampler {
    pub(crate) fn new(realization: &str) -> Self {
        if realization.ends_with("_cpu") {
            return Self {
                #[cfg(unix)]
                reader: None,
                reason: Some(if realization.ends_with("_cpu") { "not_applicable_cpu_realization" } else { "gpu_realization_not_bound" }.into()),
            };
        }
        #[cfg(unix)]
        {
            match unix::Reader::open() {
                Ok(reader) => Self { reader: Some(reader), reason: None },
                Err(reason) => Self { reader: None, reason: Some(reason) },
            }
        }
        #[cfg(not(unix))]
        Self { reason: Some("nvml_sampler_platform_unavailable".into()) }
    }

    pub(crate) fn sample(&mut self) -> serde_json::Value {
        #[cfg(unix)]
        if let Some(reader) = &self.reader {
            return reader.sample();
        }
        serde_json::json!({
            "scope": "whole_device", "state": "unavailable",
            "reason": self.reason, "utilization_percent": null,
            "memory_utilization_percent": null, "memory_used_bytes": null,
            "memory_total_bytes": null, "power_watts": null, "temperature_c": null,
        })
    }
}

#[cfg(unix)]
mod unix {
    use std::ffi::{c_char, c_void, CStr, CString};

    type Status = u32;
    type Device = *mut c_void;
    type Init = unsafe extern "C" fn() -> Status;
    type ByUuid = unsafe extern "C" fn(*const c_char, *mut Device) -> Status;
    type UtilizationFn = unsafe extern "C" fn(Device, *mut Utilization) -> Status;
    type MemoryFn = unsafe extern "C" fn(Device, *mut Memory) -> Status;
    type UintFn = unsafe extern "C" fn(Device, *mut u32) -> Status;
    type TemperatureFn = unsafe extern "C" fn(Device, u32, *mut u32) -> Status;

    // NVML legacy memory-info ABI, deliberately not the versioned v2 struct.
    #[repr(C)]
    #[derive(Default)]
    struct Memory { total: u64, free: u64, used: u64 }
    #[repr(C)]
    #[derive(Default)]
    struct Utilization { gpu: u32, memory: u32 }

    struct Library(*mut c_void);
    impl Library {
        fn open() -> Result<Self, String> {
            // SAFETY: static NUL-terminated name, local symbol visibility.
            let handle = unsafe { libc::dlopen(c"libnvidia-ml.so.1".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
            if handle.is_null() { Err("nvml_library_unavailable".into()) } else { Ok(Self(handle)) }
        }

        fn symbol(&self, name: &CStr) -> Result<*mut c_void, String> {
            // SAFETY: live dlopen handle and a NUL-terminated symbol name.
            let value = unsafe { libc::dlsym(self.0, name.as_ptr()) };
            if value.is_null() {
                Err(format!("nvml_symbol_unavailable:{}", name.to_string_lossy()))
            } else { Ok(value) }
        }
    }
    impl Drop for Library {
        fn drop(&mut self) {
            // SAFETY: this is the unique owner of the successful dlopen handle.
            unsafe { libc::dlclose(self.0); }
        }
    }

    pub(super) struct Reader {
        _library: Library,
        shutdown: Init,
        device: Device,
        uuid: String,
        utilization: UtilizationFn,
        memory: MemoryFn,
        power: UintFn,
        temperature: TemperatureFn,
    }

    impl Reader {
        pub(super) fn open() -> Result<Self, String> {
            // The accepted worker is pinned to a physical UUID before launch.
            // Never interpret an NVML ordinal as a CUDA-visible ordinal.
            let uuid = std::env::var("CUDA_VISIBLE_DEVICES")
                .map_err(|_| "gpu_uuid_binding_unavailable".to_owned())?;
            if !uuid.starts_with("GPU-") || uuid.len() != 40
                || !uuid[4..].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
                return Err("gpu_uuid_binding_ambiguous_or_partitioned".into());
            }
            let library = Library::open()?;
            // SAFETY: each symbol's signature matches the named NVML C ABI.
            let (init, shutdown, by_uuid, utilization, memory, power, temperature) = unsafe {
                (
                    std::mem::transmute::<*mut c_void, Init>(library.symbol(c"nvmlInit_v2")?),
                    std::mem::transmute::<*mut c_void, Init>(library.symbol(c"nvmlShutdown")?),
                    std::mem::transmute::<*mut c_void, ByUuid>(library.symbol(c"nvmlDeviceGetHandleByUUID")?),
                    std::mem::transmute::<*mut c_void, UtilizationFn>(library.symbol(c"nvmlDeviceGetUtilizationRates")?),
                    std::mem::transmute::<*mut c_void, MemoryFn>(library.symbol(c"nvmlDeviceGetMemoryInfo")?),
                    std::mem::transmute::<*mut c_void, UintFn>(library.symbol(c"nvmlDeviceGetPowerUsage")?),
                    std::mem::transmute::<*mut c_void, TemperatureFn>(library.symbol(c"nvmlDeviceGetTemperature")?),
                )
            };
            let uuid_c = CString::new(uuid.as_str()).map_err(|_| "invalid_gpu_uuid".to_owned())?;
            // SAFETY: valid function pointer, no input pointers.
            let status = unsafe { init() };
            if status != 0 { return Err(format!("nvml_init_status_{status}")); }
            let mut device = std::ptr::null_mut();
            // SAFETY: valid string and writable output pointer.
            let status = unsafe { by_uuid(uuid_c.as_ptr(), &mut device) };
            if status != 0 || device.is_null() {
                // SAFETY: balances this instance's successful init.
                unsafe { shutdown(); }
                return Err(format!("nvml_uuid_lookup_status_{status}"));
            }
            Ok(Self { _library: library, shutdown, device, uuid, utilization, memory, power, temperature })
        }

        pub(super) fn sample(&self) -> serde_json::Value {
            let mut util = Utilization::default();
            let mut memory = Memory::default();
            let mut power = 0;
            let mut temperature = 0;
            // SAFETY: device belongs to this live NVML instance; all outputs
            // have the exact C layouts and live until each synchronous call ends.
            let (u, m, p, t) = unsafe {
                ((self.utilization)(self.device, &mut util),
                 (self.memory)(self.device, &mut memory),
                 (self.power)(self.device, &mut power),
                 (self.temperature)(self.device, 0, &mut temperature))
            };
            let mut errors = serde_json::Map::new();
            for (name, status) in [("utilization", u), ("memory", m), ("power", p), ("temperature", t)] {
                if status != 0 { errors.insert(name.into(), serde_json::json!(format!("nvml_status_{status}"))); }
            }
            serde_json::json!({
                "uuid": self.uuid, "scope": "whole_device",
                "state": if errors.is_empty() { "available" } else { "partial_or_unavailable" },
                "utilization_percent": (u == 0).then_some(util.gpu),
                "memory_utilization_percent": (u == 0).then_some(util.memory),
                "memory_used_bytes": (m == 0).then_some(memory.used),
                "memory_total_bytes": (m == 0).then_some(memory.total),
                "power_watts": (p == 0).then_some(f64::from(power) / 1000.0),
                "temperature_c": (t == 0).then_some(temperature), "errors": errors,
            })
        }
    }
    impl Drop for Reader {
        fn drop(&mut self) {
            // SAFETY: balances init while the library is still loaded.
            unsafe { (self.shutdown)(); }
        }
    }
}
