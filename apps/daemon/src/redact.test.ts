// ABOUTME: Tests the daemon's copy of the secret patterns, and that it takes out exactly what the backend's copy does, so a
// ABOUTME: line the daemon cleaned never differs from what the backend would have kept.
import { describe, expect, test } from "bun:test";
import { redactSecrets as backend } from "../../../packages/convex/convex/lib/summaries";
import { redactSecrets } from "./redact";

const SAMPLES = [
  "fixed the build with key sk-ant-api03-abcdefghijklmnopqrstuvwx in the env",
  "stripe sk_live_abcdefghij1234 and pk_test_ZYXWVUTSRQ0987",
  "token ghp_abcdefghijklmnopqrstuvwxyz0123 and github_pat_11ABCDEFG0123456789_abcdefghij",
  "slack xoxb-1234567890-abcdefghij and AWS AKIAABCDEFGHIJKLMNOP",
  "google AIzaSyA1234567890abcdefghijklmnopqrstu",
  "soopdoop sd_0123456789abcdef0123456789abcdef paired",
  "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "hash 0123456789abcdef0123456789abcdef01234567 and Xy7Qp2Lm9Rt4Vw8Zk3Nb6Hc1Df5G",
  "fixed delivery counts double-counting bounces in packages/email",
];

describe("redactSecrets", function () {
  test("takes out keys and tokens, and leaves plain words alone", function () {
    expect(redactSecrets("key sk-ant-api03-abcdefghijklmnopqrstuvwx here")).toBe("key [secret] here");
    expect(redactSecrets("fixed delivery counts double-counting bounces")).toBe("fixed delivery counts double-counting bounces");
  });

  test("matches the backend's copy on every sample", function () {
    for (const s of SAMPLES) expect(redactSecrets(s)).toBe(backend(s));
  });
});
