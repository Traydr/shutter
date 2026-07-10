export const PROTOCOL_VERSION = "v1" as const;

export const SHUTTER_WIDTHS = [
  320, 640, 750, 828, 960, 1080, 1280, 1668, 1920, 2048, 2560, 3200, 3840,
] as const;

export const SHUTTER_PLACEHOLDER_WIDTH = 24 as const;
export const SHUTTER_FORMAT = "webp" as const;
export const MASTER_PREVIEW_QUALITY = 90 as const;
export const MASTER_PREVIEW_MAX_DIMENSION = 1920 as const;

export const CAPABILITY_MAX_BYTES = 8 * 1024;
export const CAPABILITY_KEY_BYTES = 32;
export const CAPABILITY_IV_BYTES = 12;
export const CAPABILITY_TAG_BITS = 128;
export const CAPABILITY_MAX_LIFETIME_SECONDS = 24 * 60 * 60;
export const SOURCE_ID_MAX_BYTES = 512;
export const SOURCE_LOCATOR_MAX_BYTES = 4 * 1024;

export const PUBLIC_BROWSER_MAX_AGE_SECONDS = 24 * 60 * 60;
export const PUBLIC_EDGE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const PRIVATE_EDGE_MAX_AGE_SECONDS = 24 * 60 * 60;
export const R2_CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
