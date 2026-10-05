import { describe, expect, test } from "bun:test";
import { acceptUrl, installLine, inviteCode } from "./invite";

const CODE = "0123456789abcdef0123456789abcdef";

describe("the invite page", function () {
  test("reads the code from the link's fragment, and nothing that is not one", function () {
    expect(inviteCode(`#${CODE}`)).toBe(CODE);
    expect(inviteCode(`#${CODE.toUpperCase()}`)).toBe(CODE);
    expect(inviteCode("")).toBeNull();
    expect(inviteCode("#<script>")).toBeNull();
    expect(inviteCode(`#${CODE}x`)).toBeNull();
  });

  test("fills in the install line with the invite, and the link for someone who already runs soopdoop", function () {
    expect(installLine(CODE)).toBe(`curl -fsSL https://soopdoop.com/install | bash -s -- --invite ${CODE}`);
    expect(acceptUrl(CODE)).toBe(`http://127.0.0.1:47312/?invite=${CODE}`);
  });
});
