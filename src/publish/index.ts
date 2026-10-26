/**
 * The folder publisher as a library: `forumulate publish` / `forumulate sync`
 * on the command line, and the API's git sync job (`packages/content-sync`
 * compiles this folder for the server). Nothing here imports beyond Node and
 * `yaml` — see `client.ts`.
 */
export { runPublish } from './command';
export type { PublishDeps, PublishOptions, PublishReport } from './command';
export type { ApiClient } from './client';
export type { PlanLine, Verb } from './types';
export { MANIFEST_NAMES, PAPERWORK, RESERVED_FOLDERS, reservedReason } from './reserved';
