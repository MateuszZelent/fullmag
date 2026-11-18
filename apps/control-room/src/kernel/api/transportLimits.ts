/** Match the admitted API JSON body budget, including base64 transport overhead. */
export const CONTROL_ROOM_JSON_BODY_LIMIT_BYTES = 128 * 1024 * 1024;
export const JSON_UPLOAD_ENVELOPE_RESERVE_BYTES = 16 * 1024;
export const STL_UPLOAD_MAX_BYTES = Math.floor(
  (CONTROL_ROOM_JSON_BODY_LIMIT_BYTES - JSON_UPLOAD_ENVELOPE_RESERVE_BYTES) * 3 / 4,
);
