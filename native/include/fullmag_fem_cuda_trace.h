#ifndef FULLMAG_FEM_CUDA_TRACE_H
#define FULLMAG_FEM_CUDA_TRACE_H

#include "fullmag_fem.h"

#ifdef __cplusplus
extern "C" {
#endif

#define FULLMAG_FEM_CUDA_TRACE_SCHEMA_VERSION 1u
#define FULLMAG_FEM_CUDA_TRACE_MIN_BYTES 4096u
#define FULLMAG_FEM_CUDA_TRACE_MAX_BYTES 536870912u
#define FULLMAG_FEM_CUDA_TRACE_MIN_DURATION_MS 1u
#define FULLMAG_FEM_CUDA_TRACE_MAX_DURATION_MS 120000u
#define FULLMAG_FEM_CUDA_TRACE_LIMIT_BYTES 1u
#define FULLMAG_FEM_CUDA_TRACE_LIMIT_DURATION 2u

typedef struct fullmag_fem_cuda_trace_stats_v1 {
    uint64_t schema_version;
    uint64_t cupti_version;
    uint64_t start_timestamp_ns;
    uint64_t end_timestamp_ns;
    uint64_t records_written;
    uint64_t bytes_written;
    uint64_t dropped_records;
    uint64_t buffer_starvations;
    uint64_t unknown_records;
    uint64_t truncated_names;
    uint64_t incomplete_records;
    uint64_t api_errors;
    uint64_t io_errors;
    uint64_t limit_flags;
} fullmag_fem_cuda_trace_stats_v1;

FULLMAG_FEM_API int fullmag_fem_cuda_trace_available_v1(void);
FULLMAG_FEM_API int fullmag_fem_cuda_trace_start_v1(
    int fd,
    uint64_t max_bytes,
    uint32_t max_duration_ms,
    uint64_t *token);
FULLMAG_FEM_API int fullmag_fem_cuda_trace_stop_v1(
    uint64_t token,
    fullmag_fem_cuda_trace_stats_v1 *stats);

#ifdef __cplusplus
}

static_assert(sizeof(fullmag_fem_cuda_trace_stats_v1) == 112,
              "fullmag_fem_cuda_trace_stats_v1 ABI must remain 112 bytes");
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(fullmag_fem_cuda_trace_stats_v1) == 112,
               "fullmag_fem_cuda_trace_stats_v1 ABI must remain 112 bytes");
#endif

#endif
