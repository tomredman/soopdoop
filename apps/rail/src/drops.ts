// ABOUTME: Puts a file from this Mac on the crew's shelf as a drop: asks the backend for an upload link, sends the bytes
// ABOUTME: there with the file's content type, and saves the drop. Hosting is on the team plan; a free crew shares links.
import type { ConvexClient } from "convex/browser";
import { api } from "@soopdoop/convex/convex/_generated/api";
import type { Id } from "@soopdoop/convex/convex/_generated/dataModel";

export type DropKind = "walkthrough" | "page" | "file";

// The one part of the rail's Convex client this needs, so a test can stand in for it.
export type DropsClient = Pick<ConvexClient, "mutation">;

export interface Dropped {
  dropId: Id<"drops">;
  // The drop's link, https://<deployment>.convex.site/d/<token>.
  url: string;
}

function isStorageId(value: unknown): value is Id<"_storage"> {
  return typeof value === "string" && value !== "";
}

// What Convex's upload link answers: { "storageId": "…" }.
function storageIdOf(body: unknown): Id<"_storage"> | null {
  if (typeof body !== "object" || body === null || !("storageId" in body)) return null;
  const id = body.storageId;
  return isStorageId(id) ? id : null;
}

// Uploads the file at `path` and puts it on the shelf with `title`. The content type comes from the file's name (Bun's
// guess: "text/html;charset=utf-8" for a walkthrough page). The backend checks the plan and the crew's room before the
// upload, and the size again after it. A walkthrough with a ledger line also goes on that line and on the wire.
export async function uploadFile(client: DropsClient, path: string, title: string, kind: DropKind, ledgerId?: Id<"ledger">): Promise<Dropped> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`There is no file at ${path}.`);
  const size = file.size;
  const contentType = file.type;
  const uploadUrl = await client.mutation(api.drops.uploadUrl, { size, contentType });
  const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": contentType }, body: file });
  if (!res.ok) throw new Error(`The upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const storageId = storageIdOf(await res.json().catch(function () { return null; }));
  if (storageId === null) throw new Error("The upload did not say where the file went.");
  return await client.mutation(api.drops.save, { storageId, title, kind, contentType, size, ledgerId });
}
