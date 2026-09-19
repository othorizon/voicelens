/**
 * Shared runtime configuration for server-side code and the analysis worker.
 * Values are read lazily so a missing key never breaks module import.
 */
export const AI = {
  get baseUrl(): string {
    return process.env.AI_BASE_URL ?? "";
  },
  get apiKey(): string {
    return process.env.AI_API_KEY ?? "";
  },
  get model(): string {
    return process.env.AI_MODEL ?? "qwen3.8-omni-flash";
  },
};

export const SERVICE_ACCOUNT = {
  get email(): string {
    return process.env.SUPABASE_SERVICE_EMAIL ?? "agent@voice-insight.local";
  },
  get password(): string {
    return process.env.SUPABASE_SERVICE_PASSWORD ?? "";
  },
};

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "audio";

export function requireAiConfig() {
  if (!AI.baseUrl || !AI.apiKey) {
    throw new Error("AI_BASE_URL / AI_API_KEY are not configured");
  }
}
