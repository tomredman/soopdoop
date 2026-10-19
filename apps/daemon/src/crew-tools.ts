// ABOUTME: The crew's MCP tools beside ask_operator: crew_note proposes a crew note, crew_notes lists the live ones, and props sends
// ABOUTME: one line (props or a save from a customer) to the crew's wire. Each calls a public backend function with this Mac's token.
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { readConfig } from "./config";
import type { McpTool } from "./mcp";
import { noteLine, parseNotes } from "./notes-local";
import { redactSecrets } from "./redact";
import { isRecord } from "./state";

const NOT_PAIRED = "soopdoop is not set up on this machine: open the soopdoop app and sign in.";
const MAX_NOTE = 400;
const MAX_PROPS_LINE = 200;

// The backend, by public function name, with this Mac's token added to the arguments. Tests pass a stand-in.
export interface Backend {
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// The pairing is read at each call, so a Mac paired after the server started works at once.
export function pairedBackend(): Backend {
  async function client(): Promise<{ client: ConvexHttpClient; token: string }> {
    const config = await readConfig().catch(function () { return null; });
    if (config === null) throw new Error(NOT_PAIRED);
    return { client: new ConvexHttpClient(config.convexUrl), token: config.token };
  }
  return {
    async query(name, args) {
      const c = await client();
      return await c.client.query(makeFunctionReference<"query">(name), { ...args, token: c.token });
    },
    async mutation(name, args) {
      const c = await client();
      return await c.client.mutation(makeFunctionReference<"mutation">(name), { ...args, token: c.token });
    },
  };
}

function text(x: unknown): string | undefined {
  return typeof x === "string" && x.trim() !== "" ? x.trim() : undefined;
}

// "2026-11-01" as noon that day on this Mac. Undefined when none was given, null when it is not such a date.
export function confirmByMs(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return null;
  const ms = Date.parse(`${raw.trim()}T12:00:00`);
  return Number.isNaN(ms) ? null : ms;
}

export const CREW_NOTE_TOOL = {
  name: "crew_note",
  description:
    "Propose a crew note: a short rule or fact that every agent in your user's soopdoop crew should follow (a design rule, a " +
    "price, a decision, who owns what this week). Use it when your user states a rule the crew should keep. It waits for your " +
    "user to approve it in soopdoop before the crew sees it, unless their crew lets their agents post notes. One note, under " +
    "400 characters, plain words, no secrets.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The note, under 400 characters." },
      tags: { type: "array", items: { type: "string" }, description: "Optional: up to 5 tags, such as design, pricing, infra, process." },
      applies_when: {
        type: "string",
        description: "Optional: where it applies: a folder, a repository or a word (\"apps/web/quote\", \"vibes\", \"pricing\"). Left out, it applies everywhere.",
      },
      confirm_by: { type: "string", description: "Optional: a date (YYYY-MM-DD) by which someone should check the note is still true." },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

export const CREW_NOTES_TOOL = {
  name: "crew_notes",
  description:
    "List your user's soopdoop crew notes: the crew's live rules and facts (design rules, prices, decisions), newest first, with " +
    "who wrote each one and when. A crew note outranks what you remember about the same thing, and a note with a date is the current one.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const PROPS_TOOL = {
  name: "props",
  description:
    "Send one line to your user's soopdoop crew wire about a customer: kind \"props\" when a customer thanked the team or rated a " +
    "conversation well, kind \"save\" when a conversation turned from upset to happy. One plain line under 200 characters that " +
    "says what the team did. Never name the customer, their company or their email, and nothing else that tells who they are.",
  inputSchema: {
    type: "object",
    properties: {
      line: { type: "string", description: "What the team did for the customer, under 200 characters, with no customer's name." },
      kind: { type: "string", enum: ["props", "save"], description: "props for thanks or a good rating, save for a turnaround." },
    },
    required: ["line", "kind"],
    additionalProperties: false,
  },
};

// The three tools. `explain` turns a backend error into the words to show (mcp.ts's cleanError).
export function crewTools(backend: Backend, explain: (e: unknown) => string): McpTool[] {
  function failed(e: unknown): { text: string; isError: true } {
    return { text: e instanceof Error && e.message === NOT_PAIRED ? NOT_PAIRED : `soopdoop could not do that: ${explain(e)}`, isError: true };
  }

  const crewNote: McpTool = {
    definition: CREW_NOTE_TOOL,
    async call(args) {
      const note = text(args.text);
      if (note === undefined) return { text: "Give the note's text.", isError: true };
      if (note.length > MAX_NOTE) return { text: `Keep a crew note under ${MAX_NOTE} characters; this one has ${note.length}.`, isError: true };
      const confirmBy = confirmByMs(args.confirm_by);
      if (confirmBy === null) return { text: "confirm_by is a date like 2026-11-01.", isError: true };
      const tags = Array.isArray(args.tags) ? args.tags.filter(function (t): t is string { return typeof t === "string"; }) : undefined;
      const appliesWhen = text(args.applies_when);
      try {
        const out: unknown = await backend.mutation("notes:propose", {
          text: note,
          ...(tags === undefined ? {} : { tags }),
          ...(appliesWhen === undefined ? {} : { appliesWhen }),
          ...(confirmBy === undefined ? {} : { confirmBy }),
        });
        const live = isRecord(out) && out.status === "live";
        return {
          text: live
            ? "Posted: the note is live for your crew now. Their agents get it at their next prompt."
            : "Proposed: your user approves it in soopdoop (the HUD's crew notes) before the crew sees it. Tell your user it is waiting there.",
        };
      } catch (e) {
        return failed(e);
      }
    },
  };

  const crewNotes: McpTool = {
    definition: CREW_NOTES_TOOL,
    async call() {
      try {
        const now = parseNotes(await backend.query("notes:forDaemon", {}));
        if (now === null) return { text: "soopdoop sent back notes this tool cannot read.", isError: true };
        if (now.notes.length === 0) return { text: "Your crew has no live notes yet." };
        const lines = now.notes.map(function (n) { return `${noteLine(n)}${n.appliesWhen === undefined ? "" : ` (applies when: ${n.appliesWhen})`}`; });
        return { text: [`Your crew's live notes, newest first (${now.notes.length}):`, ...lines].join("\n") };
      } catch (e) {
        return failed(e);
      }
    },
  };

  const props: McpTool = {
    definition: PROPS_TOOL,
    async call(args) {
      const kind = args.kind === "props" || args.kind === "save" ? args.kind : null;
      if (kind === null) return { text: "kind is props or save.", isError: true };
      const raw = text(args.line);
      if (raw === undefined) return { text: "Give the one line.", isError: true };
      const line = redactSecrets(raw.replace(/\s+/g, " ")).slice(0, MAX_PROPS_LINE);
      try {
        await backend.mutation("feed:fromScout", { kind, line });
        return { text: kind === "props" ? "Sent to your crew's wire as props from a customer." : "Sent to your crew's wire as a save." };
      } catch (e) {
        return failed(e);
      }
    },
  };

  return [crewNote, crewNotes, props];
}
