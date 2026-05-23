/*
 * device_info.cpp — Device info query for non-.cu compilation units.
 *
 * Needed only when other .cpp files want device_info without
 * pulling in cuda_runtime.h. Currently thin.
 */

#include "context.hpp"
