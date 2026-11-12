/** Shared interleaved transform-feedback ABI; integer identity retains all 32 bits. */
export const GPU_STATE_STRIDE_BYTES = 64;
export const GPU_MOTION_OFFSET_BYTES = 0;
export const GPU_LIFETIME_OFFSET_BYTES = 16;
export const GPU_SPAWN_OFFSET_BYTES = 32;
export const GPU_IDENTITY_OFFSET_BYTES = 48;
export const GPU_FEEDBACK_VARYINGS = ["v_motion", "v_lifetime", "v_spawn", "v_identity"] as const;
