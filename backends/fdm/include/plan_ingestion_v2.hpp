#pragma once

#include "fullmag_fdm.h"

struct fullmag_fdm_plan_ingestion_v2 {
    fullmag_fdm_plan_desc_v2 descriptor{};
};

namespace fullmag::fdm {

const fullmag_fdm_plan_desc_v2 &plan_ingestion_descriptor(
    const fullmag_fdm_plan_ingestion_v2 &ingestion);

} // namespace fullmag::fdm
