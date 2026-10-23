import { gunzipSync } from "node:zlib";

export type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
export const apiTargets = {
 bodyQuery: "https://api.xunjiapp.cn/open/body/query_gzip",
} as const;

export function toolError(text: string) {
 return { isError: true as const, content: [{ type: "text" as const, text }] };
}
export function toolData(data: unknown, key: string) {
 return { content: [{ type: "text" as const, text: JSON.stringify(data).split(key).join("[REDACTED]") }] };
}

export async function postXunji(target: keyof typeof apiTargets, key: string | undefined, body: unknown, fetcher: typeof fetch = fetch): Promise<ApiResult> {
 if (!key?.trim()) return { ok: false, error: "XUNJI_CONFIG: Missing XUNJI_BODY_API_KEY Worker runtime secret." };
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
  if (data.success !== true || data.res === undefined || data.res === null) {
   const text = JSON.stringify(data);
   const known = ["apikey missing", "apikey invalid", "仅VIP可用"];
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
