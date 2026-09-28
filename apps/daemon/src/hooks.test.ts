import { describe, expect, test } from "bun:test";
import { CLAUDE_EVENTS, withoutSoopdoopHooks, withSoopdoopHooks } from "./hooks";

describe("claude hooks", function () {
  test("adds one soopdoop hook per event and keeps Superset's hooks", function () {
    const before = {
      hooks: {
        Stop: [{ hooks: [{ type: "command" as const, command: "superset-hooks stop" }] }],
      },
      other: 1,
    };
    const after = withSoopdoopHooks(before, "soopdoop");
    expect(after.other).toBe(1);
    for (const ev of CLAUDE_EVENTS) {
      const cmds = (after.hooks?.[ev] ?? []).flatMap(function (g) { return g.hooks.map(function (h) { return h.command; }); });
      expect(cmds.filter(function (c) { return c === `soopdoop hook ${ev}`; })).toHaveLength(1);
    }
    expect(after.hooks?.Stop?.[0]?.hooks[0]?.command).toBe("superset-hooks stop");
    // Installing twice does not duplicate.
    const twice = withSoopdoopHooks(after, "soopdoop");
    expect(JSON.stringify(twice)).toBe(JSON.stringify(after));
  });

  test("uninstall removes only ours", function () {
    const installed = withSoopdoopHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "superset-hooks stop" }] }] } }, "soopdoop");
    const clean = withoutSoopdoopHooks(installed);
    expect(clean.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "superset-hooks stop" }] }] });
  });
});
