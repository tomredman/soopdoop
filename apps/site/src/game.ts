// ABOUTME: The page's game rules, kept free of the DOM so they can be tested: the app's ranks, the quests that give a
// ABOUTME: visitor XP, and the canned Operator that routes a question to one of a made-up crew's agents.

export interface Rank {
  name: string;
  at: number;
}

const FIRST: Rank = { name: "n00b", at: 0 };

// The same ladder as the app (packages/convex/convex/play.ts).
export const RANKS: Rank[] = [
  FIRST,
  { name: "script kiddie", at: 20 },
  { name: "hacker", at: 100 },
  { name: "wizard", at: 400 },
  { name: "legend", at: 1000 },
];

export function rankFor(xp: number): { rank: Rank; next: Rank | null; progress: number } {
  let rank = FIRST;
  let next: Rank | null = null;
  for (const r of RANKS) {
    if (xp >= r.at) rank = r;
    else if (next === null) next = r;
  }
  const progress = next === null ? 1 : (xp - rank.at) / (next.at - rank.at);
  return { rank, next, progress: Math.max(0, Math.min(1, progress)) };
}

export interface Quest {
  key: string;
  label: string;
  // What the toast says when it is earned.
  said: string;
  xp: number;
  // Secret quests show as ??? until found.
  secret?: boolean;
}

export const QUESTS: Quest[] = [
  { key: "read:how", label: "Read how it works", said: "read how it works", xp: 2 },
  { key: "read:operator", label: "Meet the Operator", said: "met the Operator", xp: 2 },
  { key: "read:rules", label: "Read the fine print", said: "read the fine print", xp: 2 },
  { key: "read:ranks", label: "Study the ranks", said: "studied the ranks", xp: 2 },
  { key: "read:install", label: "Look at the install", said: "looked at the install", xp: 2 },
  { key: "read:faq", label: "Read the questions", said: "read the questions", xp: 2 },
  { key: "ask", label: "Ask the Operator", said: "asked the Operator", xp: 1 },
  { key: "knock", label: "Knock on yourself", said: "knocked on yourself", xp: 3 },
  { key: "opened", label: "Open a knock before it explodes", said: "opened it in time", xp: 2 },
  { key: "copy", label: "Copy the install line", said: "copied the install line. Basically an assist.", xp: 10 },
  { key: "poke", label: "Poke the logo in the eye", said: "ow. Right in the eye.", xp: 1, secret: true },
  { key: "sudo", label: "Type sudo", said: "nice try.", xp: 1, secret: true },
  { key: "konami", label: "Hack the planet", said: "HACK THE PLANET", xp: 100, secret: true },
];

export const ASK_LIMIT = 5;

export type Agent = "mira" | "zed" | "juno" | "kit";

export interface Answer {
  // The agent the Operator reads, or null when nobody's agent fits.
  agent: Agent | null;
  // Code in `backticks` is shown as code.
  text: string;
  from: string;
  tokens: number;
}

interface Route {
  words: string[];
  answer: Answer;
}

// The made-up crew of a made-up taco app. Ties go to the earlier route, so real answers come before jokes.
const ROUTES: Route[] = [
  {
    words: ["coupon", "discount", "checkout", "cart", "promo", "guac", "price", "pricing"],
    answer: {
      agent: "mira",
      text: "`src/checkout/coupons.ts` drops expired coupons, then picks the biggest discount. New kinds go in `COUPON_KINDS`.",
      from: "@mira’s checkout agent",
      tokens: 14200,
    },
  },
  {
    words: ["menu", "sync", "kitchen", "csv", "cron", "sku", "sold"],
    answer: {
      agent: "zed",
      text: "A cron in `convex/menu/sync.ts` pulls the kitchen’s CSV every 5 minutes and diffs it by SKU. Sold-out items are hidden, not deleted.",
      from: "@zed’s menu-sync agent",
      tokens: 9800,
    },
  },
  {
    words: ["session", "auth", "authent", "login", "logout", "token", "expire", "hour", "password", "oauth", "signin"],
    answer: {
      agent: "juno",
      text: "`src/auth/session.ts` rotates refresh tokens every 60 minutes. @juno’s agent cut it from 24 hours on Tuesday, after the audit.",
      from: "@juno’s auth agent",
      tokens: 11600,
    },
  },
  {
    words: ["staging", "broke", "broken", "blame", "outage", "down", "prod"],
    answer: {
      agent: "zed",
      text: "The Operator does not do blame. (A migration ran twice. @zed’s agent is already on it.)",
      from: "@zed’s menu-sync agent",
      tokens: 6100,
    },
  },
  {
    words: ["tabs", "spaces", "indent", "indentation"],
    answer: {
      agent: "mira",
      text: "@mira’s agent says tabs. @zed’s agent says spaces. The Operator has muted this thread.",
      from: "two agents, loudly",
      tokens: 2400,
    },
  },
  {
    words: ["meaning", "life", "universe", "everything"],
    answer: {
      agent: "juno",
      text: "42. @juno’s agent found it in a TODO from 2019.",
      from: "@juno’s auth agent",
      tokens: 4200,
    },
  },
  {
    words: ["vim", "emacs", "nano", "exit", "quit"],
    answer: {
      agent: null,
      text: "Nobody’s agent knows. Nobody has ever known.",
      from: "the Operator",
      tokens: 0,
    },
  },
  {
    words: ["replace", "job", "jobs", "fired", "unemployed"],
    answer: {
      agent: null,
      text: "No. It replaces you reading 40 files to find one function.",
      from: "the Operator",
      tokens: 0,
    },
  },
  {
    words: ["soopdoop", "pronounce", "name", "called"],
    answer: {
      agent: null,
      text: "soop-doop. Like super-duper, but multiplayer.",
      from: "the Operator",
      tokens: 0,
    },
  },
];

export const NOBODY: Answer = {
  agent: null,
  text: "No open agent in your crew has worked on that. Your agent will search on its own. Or knock @zed; he knows everybody.",
  from: "the Operator",
  tokens: 0,
};

function matches(word: string, key: string): boolean {
  // Short keys match the word or its plural ("cart", "carts", not "cartography"); longer ones also match other
  // endings ("coupons", "expired").
  return key.length <= 4 ? word === key || word === key + "s" : word.startsWith(key);
}

export function route(question: string): Answer {
  const words = question.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let best = NOBODY;
  let bestScore = 0;
  for (const r of ROUTES) {
    const score = r.words.filter(function (key) {
      return words.some(function (w) { return matches(w, key); });
    }).length;
    if (score > bestScore) {
      best = r.answer;
      bestScore = score;
    }
  }
  return best;
}

// "`code` and text" → parts, so the page can show code as code without building HTML from strings.
export function splitCode(text: string): { code: boolean; text: string }[] {
  return text.split("`").map(function (part, i) { return { code: i % 2 === 1, text: part }; }).filter(function (p) {
    return p.text !== "";
  });
}
