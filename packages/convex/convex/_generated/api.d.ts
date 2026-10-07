/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as flicks from "../flicks.js";
import type * as friends from "../friends.js";
import type * as hackers from "../hackers.js";
import type * as http from "../http.js";
import type * as knocks from "../knocks.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_claude from "../lib/claude.js";
import type * as lib_friendships from "../lib/friendships.js";
import type * as lib_summaries from "../lib/summaries.js";
import type * as lib_supersetProfile from "../lib/supersetProfile.js";
import type * as operator from "../operator.js";
import type * as play from "../play.js";
import type * as routing from "../routing.js";
import type * as subsets from "../subsets.js";
import type * as superset from "../superset.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  flicks: typeof flicks;
  friends: typeof friends;
  hackers: typeof hackers;
  http: typeof http;
  knocks: typeof knocks;
  "lib/auth": typeof lib_auth;
  "lib/claude": typeof lib_claude;
  "lib/friendships": typeof lib_friendships;
  "lib/summaries": typeof lib_summaries;
  "lib/supersetProfile": typeof lib_supersetProfile;
  operator: typeof operator;
  play: typeof play;
  routing: typeof routing;
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
