use std::sync::Arc;
use tokio::sync::Semaphore;

use crate::error::ApiError;
use super::{
    sample_resolved_target, PlanarSampleResult, ResolvedPlanarSampleRequest, ResolvedSpatialTarget,
};

pub const DEFAULT_MAX_INTERACTIVE_CONCURRENCY: usize = 2;
pub const DEFAULT_MAX_EXPORT_CONCURRENCY: usize = 1;

/// Bounded execution service managing CPU and memory concurrency for planar sampling.
///
/// Prevents unbound `spawn_blocking` calls from overwhelming Tokio thread pools
/// or starving solver and heartbeat/status tasks.
#[derive(Debug, Clone)]
pub struct PlanarExecutionService {
    interactive_semaphore: Arc<Semaphore>,
    export_semaphore: Arc<Semaphore>,
}

impl Default for PlanarExecutionService {
    fn default() -> Self {
        Self::new(
            DEFAULT_MAX_INTERACTIVE_CONCURRENCY,
            DEFAULT_MAX_EXPORT_CONCURRENCY,
        )
    }
}

impl PlanarExecutionService {
    pub fn new(max_interactive: usize, max_export: usize) -> Self {
        Self {
            interactive_semaphore: Arc::new(Semaphore::new(max_interactive.max(1))),
            export_semaphore: Arc::new(Semaphore::new(max_export.max(1))),
        }
    }

    pub fn interactive_available_permits(&self) -> usize {
        self.interactive_semaphore.available_permits()
    }

    pub fn export_available_permits(&self) -> usize {
        self.export_semaphore.available_permits()
    }

    /// Execute sampling outside the async event loop under bounded concurrency.
    pub async fn execute_sample(
        &self,
        target: Arc<ResolvedSpatialTarget>,
        request: ResolvedPlanarSampleRequest,
        is_export: bool,
    ) -> Result<Arc<PlanarSampleResult>, ApiError> {
        let semaphore = if is_export {
            Arc::clone(&self.export_semaphore)
        } else {
            Arc::clone(&self.interactive_semaphore)
        };

        let permit = semaphore
            .acquire_owned()
            .await
            .map_err(|_| ApiError::internal("planar execution semaphore closed"))?;

        let sample_result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            sample_resolved_target(&target, &request)
        })
        .await
        .map_err(|join_err| ApiError::internal(format!("planar sampling worker failed: {join_err}")))?;

        Ok(Arc::new(sample_result?))
    }
}
