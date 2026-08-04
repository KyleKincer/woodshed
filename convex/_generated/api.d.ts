/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as jobs from "../jobs.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_dedupe from "../lib/dedupe.js";
import type * as lib_presets from "../lib/presets.js";
import type * as media from "../media.js";
import type * as migrate from "../migrate.js";
import type * as r2 from "../r2.js";
import type * as renditions from "../renditions.js";
import type * as settings from "../settings.js";
import type * as songs from "../songs.js";
import type * as songsInternal from "../songsInternal.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  http: typeof http;
  ingest: typeof ingest;
  jobs: typeof jobs;
  "lib/auth": typeof lib_auth;
  "lib/dedupe": typeof lib_dedupe;
  "lib/presets": typeof lib_presets;
  media: typeof media;
  migrate: typeof migrate;
  r2: typeof r2;
  renditions: typeof renditions;
  settings: typeof settings;
  songs: typeof songs;
  songsInternal: typeof songsInternal;
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

export declare const components: {
  r2: import("@convex-dev/r2/_generated/component.js").ComponentApi<"r2">;
};
