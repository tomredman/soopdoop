// ABOUTME: Tests for putting a file on the crew's shelf from the rail: the bytes go to a stand-in upload server with the
// ABOUTME: file's type, the drop is saved with the storage id that server gave, and every failure stops before a save.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type FunctionReference, getFunctionName } from "convex/server";
import type { Id } from "@soopdoop/convex/convex/_generated/dataModel";
import { type DropsClient, uploadFile } from "./drops";

const PAGE = "<!doctype html><title>The quote page</title><h1>Before and after</h1>";
const DROP_URL = "https://made-up-deployment.convex.site/d/AbCdEfGhIjKlMnOpQrStUvWxYz012-_9";

let server: ReturnType<typeof Bun.serve>;
let dir = "";
let answer: () => Response = function () { return Response.json({ storageId: "kg2madeupstorage" }); };
const uploads: { method: string; path: string; type: string | null; body: Uint8Array }[] = [];

beforeAll(async function () {
  dir = await mkdtemp(path.join(tmpdir(), "soopdoop-drops-"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      uploads.push({ method: req.method, path: url.pathname, type: req.headers.get("content-type"), body: new Uint8Array(await req.arrayBuffer()) });
      return answer();
    },
  });
});

afterAll(async function () {
  void server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

beforeEach(function () {
  uploads.length = 0;
  answer = function () { return Response.json({ storageId: "kg2madeupstorage" }); };
});

type Call = { name: string; args: Record<string, unknown> };

// Stands in for the rail's Convex client: drops.uploadUrl answers the stand-in server's address (or `refuse`), and
// drops.save answers a made-up drop. Every call is kept.
function client(calls: Call[], refuse?: string): DropsClient {
  const fake = {
    async mutation(fn: FunctionReference<"mutation">, args: Record<string, unknown>) {
      const name = getFunctionName(fn);
      calls.push({ name, args });
      if (name === "drops:uploadUrl") {
        if (refuse !== undefined) throw new Error(refuse);
        return `http://127.0.0.1:${server.port}/api/storage/upload?token=made-up`;
      }
      if (name === "drops:save") return { dropId: "made-up-drop", url: DROP_URL };
      throw new Error(`Not expected: ${name}`);
    },
  };
  return fake as unknown as DropsClient;
}

async function fileNamed(name: string, body: string | Uint8Array): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, body);
  return file;
}

describe("uploadFile", function () {
  test("sends the page's bytes with its type to the upload link, then saves the drop with the storage id it got", async function () {
    const file = await fileNamed("walkthrough.html", PAGE);
    const size = new TextEncoder().encode(PAGE).length;
    const calls: Call[] = [];
    const ledgerId = "made-up-ledger-line" as Id<"ledger">;
    expect(await uploadFile(client(calls), file, "Walkthrough: the quote page", "walkthrough", ledgerId)).toEqual({ dropId: "made-up-drop" as Id<"drops">, url: DROP_URL });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ method: "POST", path: "/api/storage/upload", type: "text/html;charset=utf-8" });
    expect(new TextDecoder().decode(uploads[0]?.body)).toBe(PAGE);
    expect(calls).toEqual([
      { name: "drops:uploadUrl", args: { size, contentType: "text/html;charset=utf-8" } },
      { name: "drops:save", args: { storageId: "kg2madeupstorage", title: "Walkthrough: the quote page", kind: "walkthrough", contentType: "text/html;charset=utf-8", size, ledgerId } },
    ]);
  });

  test("a file sends its exact bytes, typed by its name, with no ledger line", async function () {
    const bytes = new Uint8Array(Array.from({ length: 256 }, function (_, i) { return i; }));
    const calls: Call[] = [];
    await uploadFile(client(calls), await fileNamed("before.png", bytes), "Before", "file");
    expect(uploads[0]?.type).toBe("image/png");
    expect(uploads[0]?.body).toEqual(bytes);
    expect(calls[1]?.args).toMatchObject({ kind: "file", contentType: "image/png", size: 256 });
    expect(calls[1]?.args.ledgerId).toBeUndefined();

    await uploadFile(client([]), await fileNamed("session.recording-made-up", bytes), "Session", "file");
    expect(uploads[1]?.type).toBe("application/octet-stream");
  });

  test("a failed upload, or one that names no storage id, stops before a save", async function () {
    const file = await fileNamed("page.html", PAGE);
    answer = function () { return new Response("upload link expired", { status: 400 }); };
    const failed: Call[] = [];
    await expect(uploadFile(client(failed), file, "Page", "page")).rejects.toThrow("The upload failed (400): upload link expired");
    expect(failed.map(function (c) { return c.name; })).toEqual(["drops:uploadUrl"]);

    answer = function () { return Response.json({ id: "something else" }); };
    const nameless: Call[] = [];
    await expect(uploadFile(client(nameless), file, "Page", "page")).rejects.toThrow("did not say where the file went");
    expect(nameless.map(function (c) { return c.name; })).toEqual(["drops:uploadUrl"]);

    answer = function () { return new Response("not json"); };
    await expect(uploadFile(client([]), file, "Page", "page")).rejects.toThrow("did not say where the file went");
  });

  test("the backend's refusal comes through, and nothing is uploaded", async function () {
    const calls: Call[] = [];
    const refusal = "Drops hosting is on the team plan; share a link instead.";
    await expect(uploadFile(client(calls, refusal), await fileNamed("page2.html", PAGE), "Page", "page")).rejects.toThrow(refusal);
    expect(uploads).toEqual([]);
    expect(calls.map(function (c) { return c.name; })).toEqual(["drops:uploadUrl"]);
  });

  test("a missing file never asks for an upload link", async function () {
    const calls: Call[] = [];
    await expect(uploadFile(client(calls), path.join(dir, "not-there.html"), "Page", "page")).rejects.toThrow("There is no file at");
    expect(calls).toEqual([]);
    expect(uploads).toEqual([]);
  });
});
