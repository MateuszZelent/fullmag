#pragma once

// HYPRE v3.1.0 relies on transitive Thrust declarations that CUDA 13.3's
// CCCL no longer guarantees. This header is pre-included for the HYPRE CUDA
// target only; pinned HYPRE sources remain unchanged.
//
// pair.h                 -> thrust::pair
// tuple.h                -> thrust::tuple, make_tuple, get
// iterator/reverse_iterator.h -> thrust::make_reverse_iterator
#include <thrust/pair.h>
#include <thrust/tuple.h>
#include <thrust/iterator/reverse_iterator.h>
