type RoutingRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
type Assistant = "chatgpt" | "claude";
const LABEL: Record<Assistant, string> = { chatgpt: "ChatGPT", claude: "Claude" };
const MISSING_FUNCTION = (code?: string) => code === "PGRST202" || code === "42883";

/**
 * Whether the paired Windows helper answers for this assistant. A missing
 * migration means the legacy installation; other failures fail closed rather
 * than handing work to two responders.
 */
export async function helperOwnsAssistant(rpc: RoutingRpc, ownerId: string | null, assistant: Assistant): Promise<boolean> {
  if (!ownerId) return false;
  const { data, error } = await rpc("helper_assistant_owner", { p_owner: ownerId, p_assistant: assistant });
  if (error) {
    if (MISSING_FUNCTION(error.code)) {
      // Before Claude support the database knew only the ChatGPT ownership function.
      if (assistant !== "chatgpt") return false;
      const legacy = await rpc("helper_chatgpt_owner", { p_owner: ownerId });
      if (legacy.error) {
        if (MISSING_FUNCTION(legacy.error.code)) return false;
        throw new Error("Could not confirm the ChatGPT responder. Retry after the connection recovers.");
      }
      if (typeof legacy.data !== "boolean") throw new Error("Unexpected ChatGPT routing response");
      return legacy.data;
    }
    throw new Error(`Could not confirm the ${LABEL[assistant]} responder. Retry after the connection recovers.`);
  }
  if (typeof data !== "boolean") throw new Error(`Unexpected ${LABEL[assistant]} routing response`);
  return data;
}

export function helperOwnsChatGPT(rpc: RoutingRpc, ownerId: string | null): Promise<boolean> {
  return helperOwnsAssistant(rpc, ownerId, "chatgpt");
}
