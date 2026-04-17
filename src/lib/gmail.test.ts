import { describe, it, expect } from "vitest";
import { isNoGmailMailboxError, describeGoogleApiError } from "./gmail";

describe("isNoGmailMailboxError", () => {
  it("returns true for structured failedPrecondition with code 400 (number)", () => {
    expect(isNoGmailMailboxError({ code: 400, errors: [{ reason: "failedPrecondition" }] })).toBe(true);
  });

  it("returns true for structured failedPrecondition with code 400 (string)", () => {
    expect(isNoGmailMailboxError({ code: "400", errors: [{ reason: "failedPrecondition" }] })).toBe(true);
  });

  it("returns true for message-text fallback: 'Precondition check failed.'", () => {
    expect(isNoGmailMailboxError({ code: 400, message: "Precondition check failed." })).toBe(true);
  });

  it("returns true for message-text fallback: 'Mail service not enabled' (case-insensitive)", () => {
    expect(isNoGmailMailboxError({ code: 400, message: "Mail Service Not Enabled" })).toBe(true);
  });

  it("returns false when failedPrecondition is on a non-400 code", () => {
    expect(isNoGmailMailboxError({ code: 403, errors: [{ reason: "failedPrecondition" }] })).toBe(false);
  });

  it("returns false for an unrelated 400 reason and message", () => {
    expect(isNoGmailMailboxError({ code: 400, errors: [{ reason: "invalid" }], message: "Invalid query" })).toBe(false);
  });

  it("returns false for non-400 codes with no matching message", () => {
    expect(isNoGmailMailboxError({ code: 404 })).toBe(false);
    expect(isNoGmailMailboxError({ code: 500 })).toBe(false);
  });

  it("returns false for nullish, primitives, and bare strings", () => {
    expect(isNoGmailMailboxError(null)).toBe(false);
    expect(isNoGmailMailboxError(undefined)).toBe(false);
    expect(isNoGmailMailboxError("Precondition check failed.")).toBe(false);
    expect(isNoGmailMailboxError(400)).toBe(false);
  });

  it("returns false for empty error object", () => {
    expect(isNoGmailMailboxError({})).toBe(false);
  });
});

describe("describeGoogleApiError", () => {
  it("pulls reason and message from top-level errors[0]", () => {
    const result = describeGoogleApiError({
      code: 400,
      message: "Precondition check failed.",
      errors: [{ reason: "failedPrecondition", message: "Mail service not enabled.", domain: "global" }],
    });
    expect(result).toContain("reason=failedPrecondition");
    expect(result).toContain('message="Mail service not enabled."');
  });

  it("falls back to response.data.error.errors[0] when top-level errors missing", () => {
    const result = describeGoogleApiError({
      code: 400,
      response: {
        data: {
          error: {
            status: "FAILED_PRECONDITION",
            errors: [{ reason: "failedPrecondition", message: "Mail service not enabled." }],
          },
        },
      },
    });
    expect(result).toContain("reason=failedPrecondition");
    expect(result).toContain('message="Mail service not enabled."');
    expect(result).toContain("status=FAILED_PRECONDITION");
  });

  it("falls back to response.data.error.message when no structured errors are present", () => {
    const result = describeGoogleApiError({
      response: { data: { error: { message: "Top-level error message", status: "FAILED_PRECONDITION" } } },
    });
    expect(result).toContain('message="Top-level error message"');
    expect(result).toContain("status=FAILED_PRECONDITION");
  });

  it("falls back to err.message when no nested fields exist", () => {
    expect(describeGoogleApiError({ message: "Bare message" })).toBe('message="Bare message"');
  });

  it("returns String(err) for non-objects", () => {
    expect(describeGoogleApiError("plain string")).toBe("plain string");
    expect(describeGoogleApiError(42)).toBe("42");
    expect(describeGoogleApiError(null)).toBe("null");
    expect(describeGoogleApiError(undefined)).toBe("undefined");
  });

  it("returns String(err) when object has no extractable diagnostic fields", () => {
    expect(describeGoogleApiError({})).toBe("[object Object]");
  });
});
