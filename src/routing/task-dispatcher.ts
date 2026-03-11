/**
 * Three-layer task routing with load-balancing.
 *
 * Routing priority:
 * 1. Direct assignment (explicit assignTo)
 * 2. Skill-based matching (exact → best-fit, then load-balanced)
 * 3. Fallback (orchestrator or caller)
 */

import type { TeamConfig, MemberConfig } from "../types.js";

export interface RoutingResult {
  assigned_to: string;
  routing_reason: string;
}

/**
 * Route a task to the best-fit team member.
 *
 * @param teamConfig      - Team configuration with member definitions
 * @param description     - Task description (for future LLM-based routing)
 * @param assignTo        - Explicit member key to assign to
 * @param requiredSkills  - Skills required for the task
 * @param callerMember    - The member creating the task (used for peer fallback)
 * @param existingTasks   - Current task board for load balancing
 */
export function routeTask(
  teamConfig: TeamConfig,
  description: string,
  assignTo?: string,
  requiredSkills?: string[],
  callerMember?: string,
  existingTasks?: Array<{ assigned_to?: string; status: string }>,
): RoutingResult {
  // ── Layer 1: Direct assignment ──────────────────────────────────────
  if (assignTo) {
    return { assigned_to: assignTo, routing_reason: "direct_assign" };
  }

  // ── Layer 2: Skill-based matching ───────────────────────────────────
  if (requiredSkills && requiredSkills.length > 0) {
    const candidates = findSkillCandidates(teamConfig.members, requiredSkills);

    if (candidates.exact.length > 0) {
      const best = loadBalance(candidates.exact, existingTasks);
      return { assigned_to: best, routing_reason: "skill_exact_match" };
    }

    if (candidates.partial.length > 0) {
      // Sort by overlap descending, then load-balance among the top tier
      const maxOverlap = candidates.partial[0]!.overlap;
      const topTier = candidates.partial
        .filter((c) => c.overlap === maxOverlap)
        .map((c) => c.member);
      const best = loadBalance(topTier, existingTasks);
      return { assigned_to: best, routing_reason: "skill_best_fit" };
    }
  }

  // ── Layer 3: Fallback ───────────────────────────────────────────────
  if (teamConfig.coordination === "orchestrator" && teamConfig.orchestrator) {
    return {
      assigned_to: teamConfig.orchestrator,
      routing_reason: "fallback_to_orchestrator",
    };
  }

  if (callerMember) {
    return {
      assigned_to: callerMember,
      routing_reason: "peer_auto_assign",
    };
  }

  // Last resort: pick the first member
  const firstMember = Object.keys(teamConfig.members)[0];
  return {
    assigned_to: firstMember ?? "unknown",
    routing_reason: "fallback_first_member",
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────

interface SkillCandidates {
  exact: string[];
  partial: Array<{ member: string; overlap: number }>;
}

function findSkillCandidates(
  members: Record<string, MemberConfig>,
  requiredSkills: string[],
): SkillCandidates {
  const requiredSet = new Set(requiredSkills);
  const exact: string[] = [];
  const partial: Array<{ member: string; overlap: number }> = [];

  for (const [key, config] of Object.entries(members)) {
    const memberSkills = config.skills ?? [];
    if (memberSkills.length === 0) continue;

    const memberSet = new Set(memberSkills);
    const overlap = requiredSkills.filter((s) => memberSet.has(s)).length;

    if (overlap === 0) continue;

    // Exact: member has all required skills
    if (overlap === requiredSet.size) {
      exact.push(key);
    } else {
      partial.push({ member: key, overlap });
    }
  }

  // Sort partial by overlap descending
  partial.sort((a, b) => b.overlap - a.overlap);

  return { exact, partial };
}

/**
 * Among a list of candidate members, pick the one with the fewest
 * active tasks (PENDING or WORKING).
 */
function loadBalance(
  candidates: string[],
  existingTasks?: Array<{ assigned_to?: string; status: string }>,
): string {
  if (candidates.length === 1 || !existingTasks || existingTasks.length === 0) {
    return candidates[0]!;
  }

  const activeCounts = new Map<string, number>();
  for (const task of existingTasks) {
    if (
      task.assigned_to &&
      (task.status === "PENDING" || task.status === "WORKING")
    ) {
      activeCounts.set(
        task.assigned_to,
        (activeCounts.get(task.assigned_to) ?? 0) + 1,
      );
    }
  }

  let best = candidates[0]!;
  let bestCount = activeCounts.get(best) ?? 0;

  for (let i = 1; i < candidates.length; i++) {
    const count = activeCounts.get(candidates[i]!) ?? 0;
    if (count < bestCount) {
      best = candidates[i]!;
      bestCount = count;
    }
  }

  return best;
}
