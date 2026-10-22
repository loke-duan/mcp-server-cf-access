import { gunzipSync } from "node:zlib";

export type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
export const apiTargets = {
 bodyQuery: "https://api.xunjiapp.cn/open/body/query_gzip",
 bodyUpsert: "https://api.xunjiapp.cn/open/body/upsert_gzip",
 templatesSync: "https://trains.xunjiapp.cn/api_agent_templates_sync_for_llm_v2",
 templatesMutate: "https://trains.xunjiapp.cn/api_agent_templates_mutate_for_llm_v1",
} as const;

export function toolError(text: string) {
 return { isError: true as const, content: [{ type: "text" as const, text }] };
}
export function toolData(data: unknown, key: string) {
 return { content: [{ type: "text" as const, text: JSON.stringify(data).split(key).join("[REDACTED]") }] };
}

export async function postXunji(target: keyof typeof apiTargets, key: string | undefined, body: unknown, fetcher: typeof fetch = fetch): Promise<ApiResult> {
 if (!key?.trim()) return { ok: false, error: `XUNJI_CONFIG: Missing ${target.startsWith("body") ? "XUNJI_BODY_API_KEY" : "XUNJI_TEMPLATE_API_KEY"} Worker runtime secret.` };
 if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, error: "XUNJI_KEY_FORMAT: Store only the raw API key, without spaces or non-ASCII characters." };
 let stage = "request";
 try {
  const response = await fetcher(apiTargets[target], {
   method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
   body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(20_000),
  });
  if ([301,302,303,307,308].includes(response.status)) return { ok: false, error: `XUNJI_REDIRECT: HTTP ${response.status}. Redirect was not followed.` };
  if (!response.ok) {
   const retry = response.headers.get("Retry-After");
   return { ok: false, error: `XUNJI_HTTP: HTTP ${response.status}.${response.status === 429 && retry && /^\d+$/.test(retry) ? ` Retry after ${retry} seconds.` : ""}` };
  }
  stage = "response-body";
  const bytes = new Uint8Array(await response.arrayBuffer());
  stage = "gzip-decode";
  const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 10*1024*1024 }) : bytes;
  stage = "json-parse";
  const raw: unknown = JSON.parse(new TextDecoder().decode(decoded).replace(/^\uFEFF/, ""));
  if (!raw || typeof raw !== "object") return { ok: false, error: "XUNJI_RESPONSE: Invalid response shape." };
  const data = raw as Record<string, unknown>;
  if (data.success === false || data.res === undefined || data.res === null || (target.startsWith("body") && data.success !== true)) {
   const text = JSON.stringify(data);
   const known = ["apikey missing", "apikey invalid", "仅VIP可用", "user confirmation required", "version conflict", "folder_deleted", "template limit exceeded", "movements invalid", "sets invalid", "folder_name invalid", "folder_base_version invalid", "folder_name special characters not allowed", "name special characters not allowed", "content safety rejected"];
   const matched = known.find(s => text.toLowerCase().includes(s.toLowerCase()));
   if (/too frequent/i.test(text)) return { ok: false, error: `XUNJI_RATE_LIMIT: Wait before retrying.${typeof data.retry_after_ms === "number" ? ` Retry after ${data.retry_after_ms} ms.` : ""}` };
   return { ok: false, error: `XUNJI_API: ${matched ?? "Missing successful res response"}.` };
  }
  return { ok: true, data };
 } catch (e) {
  const timeout = e instanceof Error && ["TimeoutError", "AbortError"].includes(e.name);
  return { ok: false, error: `XUNJI_${timeout ? "TIMEOUT" : "FAILURE"}: Failed during ${stage}. No automatic retry was made.` };
 }
}

// Stateless, expiring confirmation tokens bind exactly the reviewed payload.
// HMAC verification uses the corresponding secret, without storing health data.
const encoder = new TextEncoder();
async function signingKey(secret: string) {
 return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function signedContent(kind: string, expires: number, payload: unknown) {
 return encoder.encode(JSON.stringify({ kind, expires, payload }));
}
export async function previewToken(kind: string, key: string, payload: unknown, now = Date.now()) {
 const expires = now + 15 * 60_000;
 const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(key), signedContent(kind, expires, payload)));
 return `${expires}.${Buffer.from(signature).toString("base64url")}`;
}
export async function verifyPreview(token: string, kind: string, key: string, payload: unknown, now = Date.now()) {
 const match = /^(\d+)\.([A-Za-z0-9_-]{43})$/.exec(token);
 if (!match) return false;
 const expires = Number(match[1]);
 if (expires <= now || expires > now + 15 * 60_000) return false;
 return crypto.subtle.verify("HMAC", await signingKey(key), Buffer.from(match[2], "base64url"), signedContent(kind, expires, payload));
}
