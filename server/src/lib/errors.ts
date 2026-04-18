import type { Context } from "hono";

// Machine-readable error codes for the API envelope. Routes use the
// `apiError` helper so every error response has a uniform shape:
//   { error: "<human message>", code: "<MACHINE_CODE>" }
//
// New codes should be added here, not invented inline. Clients can branch
// on `code` without string-matching the human message.

export const ErrorCode = {
  // Auth (401)
  MISSING_AUTH_HEADER: "MISSING_AUTH_HEADER",
  MALFORMED_AUTH_HEADER: "MALFORMED_AUTH_HEADER",
  EMPTY_BEARER_TOKEN: "EMPTY_BEARER_TOKEN",
  INVALID_API_KEY: "INVALID_API_KEY",

  // Videos (404)
  VIDEO_NOT_FOUND: "VIDEO_NOT_FOUND",

  // Videos (400)
  INVALID_SEGMENT_FILENAME: "INVALID_SEGMENT_FILENAME",

  // Videos (409) — added in 6.8
  VIDEO_ALREADY_COMPLETE: "VIDEO_ALREADY_COMPLETE",

  // Validation (400) — added in 6.13
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export function apiError(c: Context, status: number, message: string, code: ErrorCodeValue) {
  return c.json({ error: message, code }, status as Parameters<typeof c.json>[1]);
}
