import { describe, expect, test } from "bun:test";
import { hasInvite, inviteMessage, stashInvite, takeInvite } from "./invite";

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

  test("the message installs soopdoop and opens the invite in one line", function () {
    const lines = inviteMessage(CODE, "tom").split("\n");
    expect(lines[0]).toBe("@tom invited you to soopdoop. Paste this into Terminal:");
    expect(lines).toContain(`curl -fsSL https://raw.githubusercontent.com/tomredman/soopdoop/main/install.sh | bash -s -- --invite ${CODE}`);
    expect(lines).toContain(`Already running soopdoop? Open http://127.0.0.1:47312/?invite=${CODE}`);
  });
});
