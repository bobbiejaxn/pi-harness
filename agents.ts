/**
 * Agent discovery shim — re-exports from the canonical location.
 *
 * This file exists at the extension root for backward compatibility.
 * External extensions (e.g., ceo) import from `../subagent/agents.js`.
 */
export { discoverAgents, type AgentConfig, type AgentDiscoveryResult, type AgentScope, formatAgentList } from "./src/agents/agents.ts";
