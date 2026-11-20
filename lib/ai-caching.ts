import type { ProviderOptions } from "@ai-sdk/workflow";

/**
 * Prompt caching for every model call, through the Vercel AI Gateway's
 * automatic mode: the Gateway adds Anthropic's `cache_control` breakpoints
 * itself (other providers cache repeated prefixes on their own). A repeated
 * prefix (the agent's tool definitions, instructions and the thread so far;
 * a check's standing rules) is read from the cache at about a tenth of the
 * input price for 5 minutes, which covers the steps of an agent turn and
 * most turns in a session. Cache reads show in the Gateway's usage as
 * cached input tokens.
 */
export const GATEWAY_CACHING: ProviderOptions = { gateway: { caching: "auto" } };
