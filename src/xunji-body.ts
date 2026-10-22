import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { postXunji, previewToken, verifyPreview, toolData, toolError } from "./xunji-api.ts";

export interface BodyEnv { XUNJI_BODY_API_KEY?: string }
export const bodyType = z.enum(["weight", "bodyfat", "neck", "chest", "weist", "shoulder", "bot", "arm_left", "arm_right", "forearm_left", "forearm_right", "leg_left", "leg_right", "cav_left", "cav_right"]);
export const bodyQueryInput = z.object({
 start_date: z.iso.date(), end_date: z.iso.date(), types: z.array(bodyType).optional(),
 include_latest: z.boolean().default(true), include_records: z.boolean().default(true),
 limit: z.number().int().min(1).max(500).default(500), offset: z.number().int().min(0).default(0),
}).refine(v => v.start_date <= v.end_date, "start_date must not exceed end_date");
const record = z.object({ datestr: z.iso.date(), type: bodyType, value: z.number().finite().nonnegative() }).strict().refine(v => v.type !== "bodyfat" || v.value <= 100, "bodyfat must be 0–100 percent");
export const bodyPreviewInput = z.object({
 client_request_id: z.string().min(1).max(128), records: z.array(record).min(1),
}).strict().refine(v => new Set(v.records.map(r => `${r.datestr}:${r.type}`)).size === v.records.length, "Duplicate date and type");
export const bodyCommitInput = z.object({
 client_request_id: z.string().min(1).max(128), records: z.array(record).min(1),
 preview_token: z.string().min(1), confirmed: z.literal(true),
}).strict();

export async function queryBody(env: BodyEnv, input: z.input<typeof bodyQueryInput>, fetcher: typeof fetch = fetch) {
 const parsed = bodyQueryInput.safeParse(input);
 if (!parsed.success) return toolError("XUNJI_BODY_INPUT: Invalid date range, measurement type or pagination.");
 const r = await postXunji("bodyQuery", env.XUNJI_BODY_API_KEY, parsed.data, fetcher);
 return r.ok ? toolData(r.data, env.XUNJI_BODY_API_KEY!) : toolError(r.error);
}
export async function previewBody(env: BodyEnv, input: z.input<typeof bodyPreviewInput>, fetcher: typeof fetch = fetch) {
 const parsed = bodyPreviewInput.safeParse(input);
 if (!parsed.success) return toolError("XUNJI_BODY_INPUT: Check dates, types, values and duplicate date/type records. Waist uses weist.");
 const payload = parsed.data;
 const r = await postXunji("bodyUpsert", env.XUNJI_BODY_API_KEY, { schema_version: "body_open_api_v1", ...payload, dry_run: true }, fetcher);
 if (!r.ok) return toolError(r.error);
 const res = r.data.res as Record<string, unknown> | null;
 if (!res || typeof res !== "object" || res.summary === undefined) return toolError("XUNJI_BODY_PREVIEW: The dry-run response lacks res.summary. Do not commit without a valid preview.");
 return toolData({ ...r.data, review: payload, units: { weight: "kg", bodyfat: "%", other: "cm" }, preview_token: await previewToken("body", env.XUNJI_BODY_API_KEY!, payload), expires_in_seconds: 900, next_step: "Show res.summary and the exact records with units. Wait for explicit user confirmation, then commit these same records and client_request_id." }, env.XUNJI_BODY_API_KEY!);
}
export async function commitBody(env: BodyEnv, input: z.input<typeof bodyCommitInput>, fetcher: typeof fetch = fetch) {
 const parsed = bodyCommitInput.safeParse(input);
 if (!parsed.success) return toolError("XUNJI_BODY_CONFIRMATION: A matching preview token and confirmed:true after user confirmation are required.");
 const { preview_token, confirmed, ...payload } = parsed.data;
 if (!env.XUNJI_BODY_API_KEY || !await verifyPreview(preview_token, "body", env.XUNJI_BODY_API_KEY, payload)) return toolError("XUNJI_BODY_PREVIEW: Preview expired or payload changed. Preview again and obtain confirmation.");
 const r = await postXunji("bodyUpsert", env.XUNJI_BODY_API_KEY, { schema_version: "body_open_api_v1", ...payload, dry_run: false, confirmed }, fetcher);
 return r.ok ? toolData(r.data, env.XUNJI_BODY_API_KEY) : toolError(r.error);
}
export function registerBodyTools(server: McpServer, env: BodyEnv, authenticated: boolean) {
 server.registerTool("xunji_get_body", {
  description: "Read explicitly requested Xunji body measurements by date range and type with pagination. Units: weight kg, bodyfat %, dimensions cm; waist is spelled weist. Personal health data; do not diagnose.", inputSchema: bodyQueryInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
 }, async input => authenticated ? queryBody(env, input) : toolError("Sign in before reading body data."));
 server.registerTool("xunji_preview_body", {
  description: "Dry-run proposed body measurements; does not persist records. Show returned res.summary, dates, values and units, then wait for explicit user confirmation. Keep the returned token and exact payload for commit; tokens expire in 15 minutes.", inputSchema: bodyPreviewInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
 }, async input => authenticated ? previewBody(env, input) : toolError("Sign in before previewing body changes."));
 server.registerTool("xunji_commit_body", {
  description: "Persist exactly the previewed body records ONLY AFTER the user explicitly confirms that preview. Requires matching preview_token, records, client_request_id and confirmed:true. Same date/type overwrites existing values. Reuse the same ID and payload on retries; never auto retry an uncertain write.", inputSchema: bodyCommitInput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
 }, async input => authenticated ? commitBody(env, input) : toolError("Sign in before writing body data."));
}
