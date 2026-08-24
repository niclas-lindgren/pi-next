/**
 * Repository-wide deterministic checks required before a candidate or exact
 * integrated main revision can be treated as mechanically verified.
 *
 * Kept in coordination (rather than bootstrap) so production lifecycle
 * recovery and bootstrap adapters share the same command list.
 */
export const REQUIRED_CHECKS = ["npm run typecheck", "npm test"] as const;
