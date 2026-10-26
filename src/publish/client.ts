/**
 * The one call the publisher makes of an API client.
 *
 * Structurally `ForumulateClient.request` from `@forumulate/sdk`, which the CLI
 * passes in — but declared here rather than imported, so this folder depends
 * on nothing but Node and `yaml`. That is what lets the API run the very same
 * planner as a background job (`packages/content-sync` compiles this folder
 * for it) without pulling the generated SDK into the server's build: one
 * folder sync, two front doors, no second copy of its rules.
 */
export interface ApiClient {
  request<T>(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      raw?: boolean;
      headers?: Record<string, string>;
    },
  ): Promise<T>;
}
