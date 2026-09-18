/** Types for the Diffalo state command, so frontend/src/app/diffalo.test.ts
 *  can assert its result shape under `tsc --noEmit`. */

export type StateResult = {
  route: string;
  ready?: { testId: string };
};

export declare const PREFERRED_SLUG: string;
export declare function parseTime(s: string): number | null;
export declare function slugToUrlId(uniqueSlug: string): string;
export declare function slugToPathname(uniqueSlug: string): string;
export declare function assembleResult(
  name: string,
  route: string,
  args: Record<string, unknown>,
): StateResult;
