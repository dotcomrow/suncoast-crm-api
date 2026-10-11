import { config } from "./config.js";

export async function summarize(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = config();
  if (!cfg.OLLAMA_ENABLED) throw new Error("Ollama integration is disabled");
  const response = await fetch(`${cfg.OLLAMA_BASE_URL}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.OLLAMA_MODEL, stream: false, messages: [
      { role: "system", content: "Summarize this CRM record for a business user. Do not invent facts. Return concise plain text." },
      { role: "user", content: JSON.stringify(payload) }
    ] })
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const body = await response.json() as { message?: { content?: string } };
  return { summary: body.message?.content ?? "", model: cfg.OLLAMA_MODEL };
}
