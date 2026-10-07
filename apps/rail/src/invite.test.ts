import { describe, expect, test } from "bun:test";
import { hasInvite, inviteLink, inviteMessage, stashInvite, takeInvite } from "./invite";

const CODE = "0123456789abcdef0123456789abcdef";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  const storage = {
    getItem: function (k: string) { return map.get(k) ?? null; },
    setItem: function (k: string, v: string) { map.set(k, v); },
    removeItem: function (k: string) { map.delete(k); },
  };
  return storage as unknown as Storage;
}

describe("invites", function () {
  test("an invite code waits in storage through sign-in, and is handed over once", function () {
    const storage = memoryStorage();
    expect(stashInvite(`http://127.0.0.1:47312/?invite=${CODE}&x=1`, storage)).toBe("http://127.0.0.1:47312/?x=1");
    expect(hasInvite(storage)).toBe(true);
    expect(takeInvite(storage)).toBe(CODE);
    expect(takeInvite(storage)).toBeNull();
    expect(hasInvite(storage)).toBe(false);
  });

  test("a page without an invite is left alone, and a malformed code is dropped from the URL but not kept", function () {
    const storage = memoryStorage();
    expect(stashInvite("http://127.0.0.1:47312/?code=abc", storage)).toBeNull();
    expect(stashInvite("http://127.0.0.1:47312/?invite=<script>", storage)).toBe("http://127.0.0.1:47312/");
    expect(hasInvite(storage)).toBe(false);
  });

  test("the message is the link and one more sentence, greeting them by their Superset name when there is one", function () {
    expect(inviteLink(CODE)).toBe(`https://soopdoop.com/invite#${CODE}`);
    expect(inviteMessage(CODE, "tom").split("\n")).toEqual([
      `@tom invited you to soopdoop, so your coding agents can help each other: https://soopdoop.com/invite#${CODE}`,
      "The link works once, for 7 days.",
    ]);
    expect(inviteMessage(CODE, "tom", "Hedy Lamarr").startsWith("Hedy, @tom invited you")).toBe(true);
    expect(inviteMessage(CODE, "tom", "  ").startsWith("@tom invited you")).toBe(true);
  });
});
