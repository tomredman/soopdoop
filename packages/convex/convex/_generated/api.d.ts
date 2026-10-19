/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crews from "../crews.js";
import type * as crons from "../crons.js";
import type * as digests from "../digests.js";
import type * as feed from "../feed.js";
import type * as flicks from "../flicks.js";
import type * as friends from "../friends.js";
import type * as hackers from "../hackers.js";
import type * as http from "../http.js";
import type * as intercom from "../intercom.js";
import type * as knocks from "../knocks.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_claude from "../lib/claude.js";
import type * as lib_crew from "../lib/crew.js";
import type * as lib_digest from "../lib/digest.js";
import type * as lib_friendships from "../lib/friendships.js";
import type * as lib_localTime from "../lib/localTime.js";
import type * as lib_numbers from "../lib/numbers.js";
import type * as lib_plan from "../lib/plan.js";
import type * as lib_summaries from "../lib/summaries.js";
import type * as lib_supersetProfile from "../lib/supersetProfile.js";
import type * as notes from "../notes.js";
import type * as operator from "../operator.js";
import type * as play from "../play.js";
import type * as routing from "../routing.js";
import type * as slack from "../slack.js";
import type * as subsets from "../subsets.js";
import type * as superset from "../superset.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crews: typeof crews;
  crons: typeof crons;
  digests: typeof digests;
  feed: typeof feed;
  flicks: typeof flicks;
  friends: typeof friends;
  hackers: typeof hackers;
  http: typeof http;
  intercom: typeof intercom;
  knocks: typeof knocks;
  "lib/auth": typeof lib_auth;
  "lib/claude": typeof lib_claude;
  "lib/crew": typeof lib_crew;
  "lib/digest": typeof lib_digest;
  "lib/friendships": typeof lib_friendships;
  "lib/localTime": typeof lib_localTime;
  "lib/numbers": typeof lib_numbers;
  "lib/plan": typeof lib_plan;
  "lib/summaries": typeof lib_summaries;
  "lib/supersetProfile": typeof lib_supersetProfile;
  notes: typeof notes;
  operator: typeof operator;
  play: typeof play;
  routing: typeof routing;
  slack: typeof slack;
  subsets: typeof subsets;
  superset: typeof superset;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
