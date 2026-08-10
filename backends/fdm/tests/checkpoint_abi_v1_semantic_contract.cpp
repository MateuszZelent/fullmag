#include "fullmag/fdm/transport/gpu_abi_v1.h"

#include <openssl/sha.h>

#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

#ifndef FULLMAG_SOURCE_ROOT
#error "FULLMAG_SOURCE_ROOT must point at the repository root"
#endif

namespace {
void check(bool condition, const char *message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        std::exit(1);
    }
}

uint16_t u16(const uint8_t *p) {
    return uint16_t(p[0]) | (uint16_t(p[1]) << 8);
}

uint32_t u32(const uint8_t *p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) |
           (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

uint64_t u64(const uint8_t *p) {
    uint64_t value = 0;
    for (size_t i = 0; i < 8; ++i) value |= uint64_t(p[i]) << (8 * i);
    return value;
}

void put_u32(uint8_t *p, uint32_t value) {
    for (size_t i = 0; i < 4; ++i) p[i] = uint8_t(value >> (8 * i));
}

void put_u64(uint8_t *p, uint64_t value) {
    for (size_t i = 0; i < 8; ++i) p[i] = uint8_t(value >> (8 * i));
}

void digest(const uint8_t *data, size_t size, uint8_t *out) {
    SHA256(data, size, out);
}

std::vector<uint8_t> frozen_hex(const char *begin_marker, const char *end_marker) {
    std::ifstream input(std::string(FULLMAG_SOURCE_ROOT) +
                        "/docs/specs/spin-transport-runtime-contract-v1.md");
    check(input.good(), "frozen runtime specification must be readable");
    const std::string text((std::istreambuf_iterator<char>(input)), {});
    const size_t begin = text.find(begin_marker);
    const size_t end = text.find(end_marker, begin);
    check(begin != std::string::npos && end != std::string::npos,
          "checkpoint golden markers must exist");
    std::vector<uint8_t> bytes;
    int high = -1;
    for (size_t i = begin + std::strlen(begin_marker); i < end; ++i) {
        const char c = text[i];
        const int digit = c >= '0' && c <= '9' ? c - '0' :
                          c >= 'a' && c <= 'f' ? c - 'a' + 10 :
                          c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (digit < 0) continue;
        if (high < 0) high = digit;
        else {
            bytes.push_back(uint8_t((high << 4) | digit));
            high = -1;
        }
    }
    check(high < 0, "golden hex must contain complete bytes");
    return bytes;
}

void rehash(std::vector<uint8_t> &bytes) {
    const uint32_t count = u32(bytes.data() + 24);
    std::vector<uint8_t> ordered;
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t *descriptor = bytes.data() + 320 + 96 * i;
        const uint64_t offset = u64(descriptor + 24);
        const uint64_t length = u64(descriptor + 32);
        digest(bytes.data() + offset, size_t(length), descriptor + 48);
        ordered.insert(ordered.end(), bytes.begin() + offset,
                       bytes.begin() + offset + length);
    }
    digest(bytes.data() + 320, size_t(count) * 96, bytes.data() + 208);
    digest(ordered.data(), ordered.size(), bytes.data() + 240);
    std::memset(bytes.data() + 272, 0, 32);
    digest(bytes.data(), bytes.size(), bytes.data() + 272);
}

uint8_t *section(std::vector<uint8_t> &bytes, uint32_t id) {
    const uint32_t count = u32(bytes.data() + 24);
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t *descriptor = bytes.data() + 320 + 96 * i;
        if (u32(descriptor) == id) return bytes.data() + u64(descriptor + 24);
    }
    return nullptr;
}

uint8_t *descriptor(std::vector<uint8_t> &bytes, uint32_t id) {
    const uint32_t count = u32(bytes.data() + 24);
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t *candidate = bytes.data() + 320 + 96 * i;
        if (u32(candidate) == id) return candidate;
    }
    return nullptr;
}

uint8_t *field_data(uint8_t *record, uint16_t field_id) {
    const uint32_t count = u32(record + 4);
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t *field = record + 16 + 32 * i;
        if (u16(field) == field_id) return record + u64(field + 16);
    }
    return nullptr;
}

uint32_t validate(std::vector<uint8_t> &bytes, uint32_t *kind) {
    return fullmag_fdm_gpu_transport_checkpoint_validate_v1(
        bytes.data(), bytes.size(), kind);
}
}  // namespace

int main() {
    auto codec = frozen_hex("FMGPUTR1_GOLDEN_HEX_BEGIN", "FMGPUTR1_GOLDEN_HEX_END");
    auto restore = frozen_hex("FMGPUTR1_RESTORE_GOLDEN_HEX_BEGIN",
                              "FMGPUTR1_RESTORE_GOLDEN_HEX_END");
    uint32_t kind = 0;

    check(validate(codec, &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_CODEC_VALID,
          "published codec golden remains the byte oracle");
    check(validate(restore, &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE,
          "published restore golden remains the byte oracle");
    for (auto *golden : {&codec, &restore}) {
        for (size_t i = 0; i < golden->size(); ++i) {
            (*golden)[i] ^= 1;
            check(validate(*golden, &kind) ==
                      FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
                  "one-bit golden mutations must still fail closed");
            (*golden)[i] ^= 1;
        }
    }

    put_u64(codec.data() + 72, UINT64_C(42));
    rehash(codec);
    check(validate(codec, &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_CODEC_VALID,
          "a canonical non-golden checkpoint must validate semantically");

    auto exhausted_sequence = codec;
    put_u64(exhausted_sequence.data() + 72, UINT64_MAX);
    rehash(exhausted_sequence);
    check(validate(exhausted_sequence, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "accepted snapshot sequence must never wrap through UINT64_MAX");

    auto wrong_section_type = codec;
    put_u32(descriptor(wrong_section_type, 2) + 8,
            FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U64);
    rehash(wrong_section_type);
    check(validate(wrong_section_type, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "section registry must reject the wrong known-section element type");

    auto unknown_convergence_reason = codec;
    put_u32(field_data(section(unknown_convergence_reason, 1), 18), 99);
    rehash(unknown_convergence_reason);
    check(validate(unknown_convergence_reason, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "closed convergence registry must reject an unknown value");

    auto missing_charge_warm_start = restore;
    put_u32(descriptor(missing_charge_warm_start, 18), 19);
    rehash(missing_charge_warm_start);
    check(validate(missing_charge_warm_start, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "charge restore dependencies must require charge warm-start state");

    std::cout << "checkpoint semantic validator contract passed\n";
    return 0;
}
