import { describe, expect, spyOn, test } from "bun:test";
import { authFailureReason, railLogger } from "./convex-logger";

const REASON = "No auth provider found matching the given token (no providers configured). Check convex/auth.config.ts.";

describe("convex logger", function () {
  test("finds the reason in both lines the Convex client writes", function () {
    expect(authFailureReason(`Failed to authenticate: "${REASON}", check your server auth config`)).toBe(REASON);
    expect(authFailureReason(`attempting to reauthenticate: ${REASON}`)).toBe(REASON);
    expect(authFailureReason("server confirmed auth token is valid")).toBeNull();
    expect(authFailureReason("")).toBeNull();
  });

  test("reports the reason, keeps verbose lines off the console, forwards errors", function () {
    const reasons: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(function () {});
    const debugSpy = spyOn(console, "debug").mockImplementation(function () {});
    const logSpy = spyOn(console, "log").mockImplementation(function () {});
    try {
      const logger = railLogger(function (r) { reasons.push(r); });
      logger.logVerbose('setting auth state to {"state":"waitingForServerConfirmationOfFreshToken","token":"...abc1234"}');
      logger.logVerbose(`attempting to reauthenticate: ${REASON}`);
      logger.error(`Failed to authenticate: "${REASON}", check your server auth config`);
      logger.error({ not: "a string" });
      expect(reasons).toEqual([REASON, REASON]);
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      debugSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
