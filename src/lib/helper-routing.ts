type RoutingRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;

/** Missing migration means the legacy installation; other failures fail closed. */
export async function helperOwnsChatGPT(rpc: RoutingRpc, ownerId: string | null): Promise<boolean> {
  if (!ownerId) return false;
  const { data, error } = await rpc("helper_chatgpt_owner", { p_owner: ownerId });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") return false;
    throw new Error("Could not confirm the ChatGPT responder. Retry after the connection recovers.");
  }
  if (typeof data !== "boolean") throw new Error("Unexpected ChatGPT routing response");
  return data;
}
