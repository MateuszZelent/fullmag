//! Typed OpenAPI schemas for immutable execution-profile resources.
//!
//! Runtime profile requests still deserialize into `ExecutionProfileIR`.
//! These DTOs describe that exact sparse JSON shape to OpenAPI without adding
//! a second runtime representation or an opaque JSON catch-all.

use fullmag_ir::ExecutionProfileIR;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionProfileSchemaVersion {
    #[serde(rename = "execution_profile.v1")]
    V1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionBackendSchema {
    Auto,
    Fdm,
    Fem,
    Hybrid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionDeviceSchema {
    Auto,
    Cpu,
    Gpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPrecisionSchema {
    Single,
    Double,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionModeSchema {
    Strict,
    Extended,
    Hybrid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CpuCorePolicySchema {
    PhysicalFirst,
    Logical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CpuAffinitySchema {
    Auto,
    Compact,
    Spread,
    Numa,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GpuSelectorSchema {
    AnyCompatible,
    AllowList,
    Required,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ComputePlacementSchema {
    Balanced,
    Throughput,
    Pinned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadAutoSchema {
    Auto,
}

/// `RequestedThreads` is an untagged union of the string `"auto"` and a
/// positive u32 count. It is intentionally represented as an OpenAPI `oneOf`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum RequestedThreadsSchema {
    Auto(ThreadAutoSchema),
    Count(PositiveThreadCountSchema),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PositiveThreadCountSchema(pub u32);

impl utoipa::PartialSchema for PositiveThreadCountSchema {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        utoipa::openapi::schema::Object::builder()
            .schema_type(utoipa::openapi::schema::Type::Integer)
            .minimum(Some(1_u64))
            .maximum(Some(u32::MAX as u64))
            .into()
    }
}

impl ToSchema for PositiveThreadCountSchema {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComputeTargetSchema {
    Local {},
    Node {
        #[schema(min_length = 1, max_length = 256)]
        id: String,
    },
    Pool {
        #[schema(min_length = 1, max_length = 256)]
        id: String,
    },
}

/// One sparse CPU patch. Missing fields inherit; nullable fields accept JSON
/// null as an explicit reset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct CpuResourcePatchSchema {
    #[schema(nullable = false)]
    pub threads: Option<RequestedThreadsSchema>,
    #[schema(nullable = true)]
    pub core_policy: Option<CpuCorePolicySchema>,
    #[schema(nullable = false)]
    pub affinity: Option<CpuAffinitySchema>,
    #[schema(nullable = true, required = false, value_type = u64, minimum = 0, maximum = 4294967295_u64)]
    pub numa_node: Option<u32>,
    #[schema(nullable = false)]
    pub native_threads: Option<RequestedThreadsSchema>,
    #[schema(nullable = false)]
    pub blas_threads: Option<RequestedThreadsSchema>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct MemoryResourcePatchSchema {
    #[schema(nullable = true, minimum = 1)]
    pub reservation_bytes: Option<u64>,
}

/// Full GPU value accepted when the sparse `gpu` property is present. The
/// containing property is separately nullable to represent an explicit reset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct GpuResourcesSchema {
    #[schema(nullable = false)]
    pub selector: Option<GpuSelectorSchema>,
    #[schema(nullable = false)]
    pub device_uuids: Option<Vec<String>>,
    #[schema(nullable = false, required = false, value_type = u64, minimum = 1, maximum = 4294967295_u64)]
    pub devices_per_task: Option<u32>,
    #[schema(nullable = true, minimum = 1)]
    pub vram_per_device_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComputeParallelismSchema {
    SingleProcess {},
    Distributed {
        #[schema(value_type = u64, minimum = 1, maximum = 4294967295_u64)]
        ranks: u32,
        #[schema(value_type = u64, minimum = 1, maximum = 4294967295_u64)]
        threads_per_rank: u32,
        #[schema(value_type = u64, minimum = 1, maximum = 4294967295_u64)]
        ranks_per_node: u32,
        #[schema(value_type = u64, minimum = 0, maximum = 4294967295_u64)]
        gpus_per_rank: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ComputeResourcePatchSchema {
    #[schema(nullable = false)]
    pub target: Option<ComputeTargetSchema>,
    #[schema(nullable = false)]
    pub cpu: Option<CpuResourcePatchSchema>,
    #[schema(nullable = true)]
    pub gpu: Option<GpuResourcesSchema>,
    #[schema(nullable = false)]
    pub ram: Option<MemoryResourcePatchSchema>,
    #[schema(nullable = false)]
    pub scratch: Option<MemoryResourcePatchSchema>,
    #[schema(nullable = false)]
    pub parallelism: Option<ComputeParallelismSchema>,
    #[schema(nullable = false)]
    pub placement: Option<ComputePlacementSchema>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRequestPatchSchema {
    #[schema(nullable = false)]
    pub backend: Option<ExecutionBackendSchema>,
    #[schema(nullable = false)]
    pub device: Option<ExecutionDeviceSchema>,
    #[schema(nullable = false)]
    pub precision: Option<ExecutionPrecisionSchema>,
    #[schema(nullable = false)]
    pub mode: Option<ExecutionModeSchema>,
    #[schema(nullable = false)]
    pub resources: Option<ComputeResourcePatchSchema>,
}

/// Serialized profile resource returned by catalog and publish operations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ExecutionProfileSchema {
    pub schema_version: ExecutionProfileSchemaVersion,
    #[schema(min_length = 1, max_length = 256)]
    pub profile_id: String,
    #[schema(min_length = 1, max_length = 256)]
    pub version: String,
    #[schema(max_length = 4096)]
    pub description: String,
    pub defaults: ExecutionRequestPatchSchema,
}

/// Accepted profile input. `description` and `defaults` may be omitted because
/// `ExecutionProfileIR` supplies defaults for them during deserialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ExecutionProfileInputSchema {
    pub schema_version: ExecutionProfileSchemaVersion,
    #[schema(min_length = 1, max_length = 256)]
    pub profile_id: String,
    #[schema(min_length = 1, max_length = 256)]
    pub version: String,
    #[schema(nullable = false, max_length = 4096)]
    pub description: Option<String>,
    #[schema(nullable = false)]
    pub defaults: Option<ExecutionRequestPatchSchema>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishExecutionProfileRequest {
    #[schema(minimum = 0)]
    pub expected_revision: u64,
    #[schema(min_length = 1, max_length = 200)]
    pub client_intent_id: String,
    #[schema(value_type = ExecutionProfileInputSchema)]
    pub profile: ExecutionProfileIR,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ExecutionProfileVersionResource {
    #[schema(value_type = ExecutionProfileSchema)]
    pub profile: ExecutionProfileIR,
    #[schema(min_length = 64, max_length = 64)]
    pub profile_sha256: String,
    #[schema(min_length = 1, max_length = 200)]
    pub client_intent_id: String,
    pub published_at: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ExecutionProfileCatalogResource {
    pub schema_version: String,
    pub revision: u64,
    pub total: u32,
    pub offset: u32,
    #[schema(nullable = true, minimum = 0, maximum = 4294967295_u64)]
    pub next_offset: Option<u32>,
    pub entries: Vec<ExecutionProfileVersionResource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProfilePublicationDispositionSchema {
    Published,
    Existing,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PublishExecutionProfileResource {
    pub disposition: ProfilePublicationDispositionSchema,
    pub revision: u64,
    pub entry: ExecutionProfileVersionResource,
}

/// Filter and pagination query for the immutable execution-profile catalog.
/// Defaults for omitted pagination/revision parameters are owned by the
/// catalog handler.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct ProfileCatalogQuery {
    pub profile_id: Option<String>,
    pub version: Option<String>,
    pub client_intent_id: Option<String>,
    #[param(minimum = 0, maximum = 4294967295_u64)]
    pub offset: Option<u32>,
    #[param(minimum = 1, maximum = 100)]
    pub limit: Option<u32>,
    #[param(minimum = 0)]
    pub revision: Option<u64>,
}
