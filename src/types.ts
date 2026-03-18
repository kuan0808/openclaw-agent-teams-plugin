/**
 * Core types for the Agent Teams plugin.
 */

import * as path from "node:path";

// ── Task State Machine ──────────────────────────────────────────────
// Inspired by A2A TaskState + BLOCKED extension
//
// BLOCKED → PENDING → WORKING → COMPLETED
//                   ↘           ↗
//               INPUT_REQUIRED
//                   ↘
//                 FAILED / CANCELED

export type TaskState =
  | "BLOCKED"
  | "PENDING"
  | "WORKING"
  | "INPUT_REQUIRED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "REVISION_REQUESTED";

export type RunStatus =
  | "WORKING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED";

export type CoordinationMode = "orchestrator" | "peer";

// ── Config Types ────────────────────────────────────────────────────

export type CliType = "claude" | "codex" | "gemini";

export interface CliOptions {
  cwd?: string;               // Working directory for CLI agent (only meaningful for CLI)
  thinking?: boolean;         // Enable extended thinking / ultrathink
  verbose?: boolean;          // Enable verbose output (CLI-specific)
  extra_args?: string[];      // Advanced: additional CLI flags (escape hatch)
}

export interface MemberConfig {
  role?: string;
  role_file?: string;
  model?: { primary: string };
  skills?: string[];
  tools?: {
    deny?: string[];
    allow?: string[];
  };
  cli?: CliType;              // Spawn as external CLI agent
  cli_options?: CliOptions;   // CLI-specific settings
}

export function isCliMember(config: MemberConfig): boolean {
  return !!config.cli;
}

export function getCliCwd(config: MemberConfig): string {
  return config.cli_options?.cwd
    ? path.resolve(process.cwd(), config.cli_options.cwd)
    : process.cwd();
}

export interface KvStoreConfig {
  max_entries?: number;
  ttl?: number;
}

export interface EventQueueConfig {
  max_backlog?: number;
}

export interface DocPoolConfig {
  max_size_mb?: number;
  allowed_types?: string[];
}

export interface SharedMemoryConfig {
  enabled?: boolean;
  stores?: {
    kv?: KvStoreConfig;
    events?: EventQueueConfig;
    docs?: DocPoolConfig;
  };
}

export interface GateConfig {
  require_deliverables?: boolean;
  require_result?: boolean;
  approver?: "orchestrator" | string;
  reviewer?: "orchestrator" | string;
}

export interface WorkflowStage {
  name: string;
  role?: string;
  skills?: string[];
}

export interface WorkflowTemplate {
  stages: WorkflowStage[];
  fail_handlers?: Record<string, string>;  // stage name -> revert-to stage name
}

export interface WorkflowConfig {
  max_rounds?: number;
  timeout?: number;
  gates?: Record<string, GateConfig>;        // status -> gate config
  template?: WorkflowTemplate;
}

export interface KnowledgeConfig {
  consolidation?: boolean;
  retention?: "current-run" | "across-runs";
  notify_leader?: boolean;
}

export interface TeamConfig {
  description: string;
  coordination: CoordinationMode;
  orchestrator?: string;
  shared_memory?: SharedMemoryConfig;
  members: Record<string, MemberConfig>;
  workflow?: WorkflowConfig;
  knowledge?: KnowledgeConfig;
}

export interface AgentTeamsConfig {
  teams: Record<string, TeamConfig>;
}

// ── Runtime State Types ─────────────────────────────────────────────

// ── Deliverable Entry ──────────────────────────────────────────────

export interface DeliverableEntry {
  type: "file" | "url" | "artifact" | "doc";
  path?: string;
  url?: string;
  doc_key?: string;
  description?: string;
  created_by: string;
  created_at: number;
}

export interface TeamTask {
  id: string;
  team: string;
  run_id: string;
  description: string;
  assigned_to?: string;
  status: TaskState;
  depends_on?: string[];
  result?: unknown;
  message?: string;
  revision_count?: number;
  revision_feedback?: string;
  routing_reason?: string;
  deliverables?: DeliverableEntry[];
  learning?: StructuredLearning;
  workflow_stage?: string;
  created_at: number;
  updated_at: number;
}

export interface TeamRun {
  id: string;
  team: string;
  goal: string;
  status: RunStatus;
  orchestrator?: string;
  requester_session?: string;
  tasks: TeamTask[];
  started_at: number;
  updated_at: number;
  completed_at?: number;
  result?: string;
  cancel_reason?: string;
  round_count?: number;
  all_terminal_at?: number;  // epoch ms when all tasks first reached terminal state
}

export interface KvEntry {
  key: string;
  value: unknown;
  written_by: string;
  created_at: number;
  updated_at: number;
  ttl?: number;        // seconds
  expires_at?: number;  // epoch ms
}

export interface EventEntry {
  id: string;
  topic: string;
  from: string;
  message: string;
  data?: unknown;
  timestamp: number;
}

export interface DocEntry {
  key: string;
  content_type: string;
  size_bytes: number;
  written_by: string;
  created_at: number;
  updated_at: number;
}

export interface MessageEntry {
  from: string;
  to: string;
  message: string;
  timestamp: number;
  acked: boolean;
}

// ── Structured Learning ────────────────────────────────────────────

export type LearningCategory = "failure" | "pattern" | "fix" | "insight";

export interface StructuredLearning {
  content: string;
  confidence: number;       // 0.0 – 1.0
  category: LearningCategory;
  task_id?: string;
  timestamp: number;
}

// ── Activity Log Entry ────────────────────────────────────────────

export type ActivityType =
  | "task_created"
  | "task_updated"
  | "task_completed"
  | "task_failed"
  | "task_canceled"
  | "run_started"
  | "run_completed"
  | "run_canceled"
  | "run_timeout"
  | "run_max_rounds_exceeded"
  | "message_sent"
  | "memory_updated"
  | "deliverable_added"
  | "dependency_resolved"
  | "dependency_blocked"
  | "dependency_cascaded"
  | "learning_captured"
  | "workflow_stage_advanced"
  | "workflow_fail_loopback"
  | "task_revision_requested"
  | "task_revision_restarted"
  | "requester_notified";

export interface ActivityEntry {
  id: string;
  timestamp: number;
  team: string;
  agent: string;
  type: ActivityType;
  target_id?: string;
  description: string;
  metadata?: Record<string, unknown>;
}

// ── Broadcast Event ──────────────────────────────────────────────

export interface BroadcastEvent {
  id: string;
  type: ActivityType;
  team: string;
  agent: string;
  data: Record<string, unknown>;
  ts: number;
}

// ── Per-Run Session Types ───────────────────────────────────────────

export interface RunSession {
  sessionKey: string;   // agent:<agentId>:run:<runId>
  runId: string;
  createdAt: number;
}

/**
 * Parsed result from a run session key.
 * Session keys follow the pattern: agent:<agentId>:run:<runId>
 */
export interface ParsedRunSessionKey {
  agentId: string;
  runId: string;
}

/**
 * Build a deterministic run session key from agentId and runId.
 */
export function makeRunSessionKey(agentId: string, runId: string): string {
  return `agent:${agentId}:run:${runId}`;
}

/**
 * Parse a run session key back into its components.
 * Returns null if the key doesn't match the expected pattern.
 */
export function parseRunSessionKey(sessionKey: string): ParsedRunSessionKey | null {
  const match = sessionKey.match(/^agent:(.+):run:([^:]+)$/);
  if (!match) return null;
  return { agentId: match[1]!, runId: match[2]! };
}

// ── Agent ID Convention ─────────────────────────────────────────────

export const AGENT_ID_PREFIX = "at--";

export function makeAgentId(team: string, member: string): string {
  return `${AGENT_ID_PREFIX}${team}--${member}`;
}

export function parseAgentId(agentId: string): { team: string; member: string } | null {
  if (!agentId.startsWith(AGENT_ID_PREFIX)) return null;
  const rest = agentId.slice(AGENT_ID_PREFIX.length);
  const idx = rest.indexOf("--");
  if (idx === -1) return null;
  return { team: rest.slice(0, idx), member: rest.slice(idx + 2) };
}

export function isTeamAgent(agentId?: string): boolean {
  return !!agentId && agentId.startsWith(AGENT_ID_PREFIX);
}
