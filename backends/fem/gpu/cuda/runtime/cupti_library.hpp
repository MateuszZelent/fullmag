#pragma once

#include <cupti_activity.h>
#include <cupti_callbacks.h>
#include <cupti_version.h>
#include <cstdio>
#include <dlfcn.h>

static_assert(CUPTI_API_VERSION == 28, "The bounded trace collector requires CUPTI API 28");

namespace fullmag::fem {

// Load only the image-pinned profiler, and only after explicit capture opt-in.
// CUDA 12.6 and CUPTI 12.9 share SONAME libcupti.so.12: an ordinary link/RUNPATH
// could resolve the old profiler before the private prefix. Keep the handle
// for process lifetime so callbacks and borrowed activity names remain valid.
struct CuptiLibrary {
    decltype(&::cuptiGetVersion) cuptiGetVersion = nullptr;
    decltype(&::cuptiGetTimestamp) cuptiGetTimestamp = nullptr;
    decltype(&::cuptiActivityEnable) cuptiActivityEnable = nullptr;
    decltype(&::cuptiActivityDisable) cuptiActivityDisable = nullptr;
    decltype(&::cuptiActivityFlushAll) cuptiActivityFlushAll = nullptr;
    decltype(&::cuptiActivityRegisterCallbacks) cuptiActivityRegisterCallbacks = nullptr;
    decltype(&::cuptiActivityGetNextRecord) cuptiActivityGetNextRecord = nullptr;
    decltype(&::cuptiActivityGetNumDroppedRecords) cuptiActivityGetNumDroppedRecords = nullptr;
    decltype(&::cuptiGetCallbackName) cuptiGetCallbackName = nullptr;
    uint32_t version = 0;

    bool load() {
        if (attempted_) return version == CUPTI_API_VERSION;
        attempted_ = true;
        handle_ = dlopen(FULLMAG_FEM_CUPTI_LIBRARY_PATH, RTLD_NOW | RTLD_LOCAL);
        if (!handle_) {
            const char *error = dlerror();
            std::fprintf(stderr, "cuda_activity_trace: pinned CUPTI load failed: %.240s\n",
                         error ? error : "unknown loader error");
            return false;
        }
#define FULLMAG_LOAD_CUPTI(name) \
        name = reinterpret_cast<decltype(name)>(dlsym(handle_, #name)); \
        if (!name) { \
            std::fprintf(stderr, "cuda_activity_trace: pinned CUPTI lacks %s\n", #name); \
            return false; \
        }
        FULLMAG_LOAD_CUPTI(cuptiGetVersion)
        FULLMAG_LOAD_CUPTI(cuptiGetTimestamp)
        FULLMAG_LOAD_CUPTI(cuptiActivityEnable)
        FULLMAG_LOAD_CUPTI(cuptiActivityDisable)
        FULLMAG_LOAD_CUPTI(cuptiActivityFlushAll)
        FULLMAG_LOAD_CUPTI(cuptiActivityRegisterCallbacks)
        FULLMAG_LOAD_CUPTI(cuptiActivityGetNextRecord)
        FULLMAG_LOAD_CUPTI(cuptiActivityGetNumDroppedRecords)
        FULLMAG_LOAD_CUPTI(cuptiGetCallbackName)
#undef FULLMAG_LOAD_CUPTI
        uint32_t observed = 0;
        if (cuptiGetVersion(&observed) != CUPTI_SUCCESS || observed != CUPTI_API_VERSION) {
            std::fprintf(stderr, "cuda_activity_trace: CUPTI ABI mismatch: expected=%u observed=%u\n",
                         CUPTI_API_VERSION, observed);
            return false;
        }
        version = observed;
        return true;
    }

private:
    bool attempted_ = false;
    void *handle_ = nullptr;
};

} // namespace fullmag::fem
