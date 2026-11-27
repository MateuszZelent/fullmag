/* One NVML sample of GPU 0 as a JSON line: device memory in use, GPU utilisation and the
 * cumulative PCIe byte counters (NVML field values 197 = TX, 198 = RX).
 * The PCIe counters count all traffic of the GPU, including other users such as the Windows
 * desktop, and may wrap; the caller sums wrapped differences.
 * Build: gcc -O2 -I$CUDA/include nvml_gpu_sample.c -lnvidia-ml -o nvml_gpu_sample */
#include <stdio.h>
#include <time.h>

#include <nvml.h>

static unsigned long long field_value(const nvmlFieldValue_t *value, int *bits) {
    switch (value->valueType) {
    case NVML_VALUE_TYPE_UNSIGNED_INT:
        *bits = 32;
        return value->value.uiVal;
    case NVML_VALUE_TYPE_UNSIGNED_LONG:
        *bits = 64;
        return value->value.ulVal;
    case NVML_VALUE_TYPE_UNSIGNED_LONG_LONG:
        *bits = 64;
        return value->value.ullVal;
    default:
        *bits = 0;
        return 0;
    }
}

int main(void) {
    struct timespec now;
    nvmlReturn_t rc = nvmlInit_v2();
    if (rc != NVML_SUCCESS) {
        printf("{\"error\": \"init %d\"}\n", (int)rc);
        return 1;
    }
    nvmlDevice_t device;
    rc = nvmlDeviceGetHandleByIndex_v2(0, &device);
    if (rc != NVML_SUCCESS) {
        printf("{\"error\": \"handle %d\"}\n", (int)rc);
        nvmlShutdown();
        return 1;
    }
    nvmlFieldValue_t values[2] = {0};
    values[0].fieldId = NVML_FI_DEV_PCIE_COUNT_TX_BYTES;
    values[1].fieldId = NVML_FI_DEV_PCIE_COUNT_RX_BYTES;
    const nvmlReturn_t field_rc = nvmlDeviceGetFieldValues(device, 2, values);
    nvmlMemory_t memory = {0};
    const nvmlReturn_t memory_rc = nvmlDeviceGetMemoryInfo(device, &memory);
    nvmlUtilization_t utilization = {0};
    const nvmlReturn_t util_rc = nvmlDeviceGetUtilizationRates(device, &utilization);
    clock_gettime(CLOCK_REALTIME, &now);
    int tx_bits = 0, rx_bits = 0;
    const unsigned long long tx = field_value(&values[0], &tx_bits);
    const unsigned long long rx = field_value(&values[1], &rx_bits);
    printf("{\"epoch_s\": %.3f, \"field_rc\": %d, \"tx_status\": %d, \"rx_status\": %d, "
           "\"tx_bytes\": %llu, \"rx_bytes\": %llu, \"tx_bits\": %d, \"rx_bits\": %d, "
           "\"memory_rc\": %d, \"memory_used_mib\": %.1f, \"memory_total_mib\": %.1f, "
           "\"util_rc\": %d, \"gpu_util_pct\": %u}\n",
           now.tv_sec + now.tv_nsec * 1e-9, (int)field_rc, (int)values[0].nvmlReturn,
           (int)values[1].nvmlReturn, tx, rx, tx_bits, rx_bits, (int)memory_rc,
           memory.used / 1048576.0, memory.total / 1048576.0, (int)util_rc, utilization.gpu);
    nvmlShutdown();
    return 0;
}
