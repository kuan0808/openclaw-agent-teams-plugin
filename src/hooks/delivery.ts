/**
 * message_sending hook — placeholder for delivery control.
 *
 * NOTE: The SDK's message_sending hook context (PluginHookMessageContext)
 * does not include agentId, so we cannot identify which agent is sending.
 * For v1, delivery control relies on subagent_delivery_target instead.
 *
 * This hook is kept as a placeholder for future enhancement when
 * the SDK provides agent identity in the message sending context.
 */

export function createDeliveryHook(): (
  event: { to: string; content: string; metadata?: Record<string, unknown> },
  ctx: { channelId: string; accountId?: string; conversationId?: string },
) => Promise<{ cancel?: boolean; content?: string } | void> {
  return async (_event, _ctx) => {
    // v1: No-op — delivery control handled by subagent_delivery_target hook.
    // Team member results are redirected to the orchestrator before they
    // reach the message_sending stage.
    return;
  };
}
