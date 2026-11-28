// How much host CPU does waiting for a 2 s GPU kernel cost under each CUDA wait mode?
// Usage: wait_mode_probe <default|spin|yield|blocking> <device|stream|event|blocking_event>
// Prints CPU seconds (user+sys) and voluntary/involuntary context switches during the wait.
#include <cstdio>
#include <cstring>
#include <sys/resource.h>
#include <time.h>

#include <cuda_runtime.h>

__global__ void spin_kernel(long long cycles) {
    const long long start = clock64();
    while (clock64() - start < cycles) {
    }
}

static double now_s() {
    timespec t{};
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec * 1e-9;
}

int main(int argc, char **argv) {
    if (argc < 3) return 2;
    unsigned int schedule = 0;
    if (!std::strcmp(argv[1], "spin")) schedule = cudaDeviceScheduleSpin;
    if (!std::strcmp(argv[1], "yield")) schedule = cudaDeviceScheduleYield;
    if (!std::strcmp(argv[1], "blocking")) schedule = cudaDeviceScheduleBlockingSync;
    if (schedule != 0 && cudaSetDeviceFlags(schedule) != cudaSuccess) return 3;
    cudaFree(nullptr);
    int clock_khz = 0;
    cudaDeviceGetAttribute(&clock_khz, cudaDevAttrClockRate, 0);
    const long long cycles = static_cast<long long>(clock_khz) * 1000LL * 2;  // about 2 s
    cudaStream_t stream;
    cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking);
    cudaEvent_t event;
    const bool blocking_event = !std::strcmp(argv[2], "blocking_event");
    cudaEventCreateWithFlags(&event, blocking_event ? (cudaEventBlockingSync | cudaEventDisableTiming)
                                                    : cudaEventDisableTiming);
    spin_kernel<<<1, 1, 0, stream>>>(cycles / 100);  // warm-up
    cudaStreamSynchronize(stream);

    rusage before{}, after{};
    getrusage(RUSAGE_SELF, &before);
    const double t0 = now_s();
    spin_kernel<<<1, 1, 0, stream>>>(cycles);
    if (!std::strcmp(argv[2], "device")) {
        cudaDeviceSynchronize();
    } else if (!std::strcmp(argv[2], "stream")) {
        cudaStreamSynchronize(stream);
    } else {
        cudaEventRecord(event, stream);
        cudaEventSynchronize(event);
    }
    const double wall = now_s() - t0;
    getrusage(RUSAGE_SELF, &after);
    const double cpu = (after.ru_utime.tv_sec - before.ru_utime.tv_sec) +
                       (after.ru_utime.tv_usec - before.ru_utime.tv_usec) * 1e-6 +
                       (after.ru_stime.tv_sec - before.ru_stime.tv_sec) +
                       (after.ru_stime.tv_usec - before.ru_stime.tv_usec) * 1e-6;
    unsigned int flags = 0;
    cudaGetDeviceFlags(&flags);
    std::printf("mode=%-8s wait=%-14s flags=0x%x wall=%.2fs cpu=%.2fs vol_sw=%ld invol_sw=%ld\n", argv[1],
                argv[2], flags & cudaDeviceScheduleMask, wall, cpu, after.ru_nvcsw - before.ru_nvcsw,
                after.ru_nivcsw - before.ru_nivcsw);
    return 0;
}
