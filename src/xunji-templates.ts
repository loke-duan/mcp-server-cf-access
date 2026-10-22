import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { postXunji, previewToken, verifyPreview, toolData, toolError } from "./xunji-api.ts";
export interface TemplatesEnv {
 XUNJI_TEMPLATE_API_KEY?: string;
 OAUTH_KV?: Pick<KVNamespace, "get" | "put">;
}
const version = z.number().int().nonnegative();
const name = z.string().trim().min(1).regex(/^[\p{Script=Han}A-Za-z0-9 ]+$/u, "Only Chinese, English, digits and ordinary spaces");
const set = z.record(z.string(), z.unknown());
const progression = z.object({ start_reps: z.number().positive(), reps_increment: z.number().positive(), target_reps: z.number().positive(), weight_increment: z.number().positive(), reset_reps: z.number().positive() }).strict().refine(p => p.target_reps >= p.start_reps && p.reset_reps <= p.target_reps, "Invalid double progression");
const move = z.object({ name: z.string().min(1), sets: z.array(set).min(1).max(20), progression: progression.optional(), restTime: z.number().int().min(0).max(86400).optional(), warn_restTime: z.number().int().min(0).max(86400).optional() }).strict();
const upsert = z.object({
 template_id: z.string().min(1).optional(), base_version: version.optional(), client_id: z.string().min(1).optional(),
 name, color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
 movements: z.array(move).min(1).max(15).optional(),
 movement: z.array(z.record(z.string(), z.unknown())).min(1).max(15).optional(), rules: z.unknown().optional(),
}).strict().refine(v => v.template_id ? v.base_version !== undefined : !!v.client_id, "Updates need template_id/base_version; new templates need client_id")
 .refine(v => Number(!!v.movements) + Number(!!v.movement) === 1, "Use exactly one public movements or native movement array")
 .refine(v => !v.movement || v.movement.every(m => Array.isArray(m.sets) && m.sets.length >= 1 && m.sets.length <= 20), "Native movements must have verifiable sets arrays of 1–20 entries");
export const templatesSyncInput = z.object({ template_versions: z.record(z.string(), version).optional() }).strict();
export const mutationInput = z.object({
 mutation_id: z.string().min(1).max(128),
 folder_update: z.object({ name: name.max(32), base_version: version }).strict().optional(),
 upserts: z.array(upsert).max(14).default([]),
 deletes: z.array(z.object({ template_id: z.string().min(1), base_version: version }).strict()).max(14).default([]),
}).strict().refine(v => !!v.folder_update || v.upserts.length > 0 || v.deletes.length > 0, "Empty mutation");
export const templatesApplyInput = z.object({ mutation: mutationInput, preview_token: z.string().min(1), confirmed: z.literal(true) }).strict();

function obj(value: unknown): Record<string, unknown> | undefined {
 return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export async function syncTemplates(env: TemplatesEnv, input: z.input<typeof templatesSyncInput>, fetcher: typeof fetch = fetch) {
 const parsed = templatesSyncInput.safeParse(input);
 if (!parsed.success) return toolError("XUNJI_TEMPLATE_INPUT: Invalid template versions. Omit versions unless full cached content is available.");
 const r = await postXunji("templatesSync", env.XUNJI_TEMPLATE_API_KEY, parsed.data, fetcher);
 return r.ok ? toolData(r.data, env.XUNJI_TEMPLATE_API_KEY!) : toolError(r.error);
}
async function checkCurrent(env: TemplatesEnv, mutation: z.output<typeof mutationInput>, fetcher: typeof fetch): Promise<string | null> {
 const r = await postXunji("templatesSync", env.XUNJI_TEMPLATE_API_KEY, {}, fetcher);
 if (!r.ok) return r.error;
 const res = obj(r.data.res);
 if (!res) return "XUNJI_TEMPLATE_STATE: Missing sync state.";
 if (res.folder_deleted === true || res.folder === null) return "XUNJI_TEMPLATE_FOLDER_DELETED: The Agent folder is absent/deleted. Do not recreate it automatically; ask the user about explicitly creating a new Agent folder.";
 const folder = obj(res.folder);
 const versions = obj(res.template_versions);
 if (!folder || !versions) return "XUNJI_TEMPLATE_STATE: Sync must return the Agent folder and complete template_versions before editing.";
 const current = new Set(Object.keys(versions));
 const usedIds = new Set<string>();
 const clients = new Set<string>();
 for (const item of [...mutation.deletes, ...mutation.upserts]) {
  if (item.template_id) {
   if (usedIds.has(item.template_id)) return "XUNJI_TEMPLATE_INPUT: A template cannot be updated/deleted twice in one mutation.";
   usedIds.add(item.template_id);
   if (!current.has(item.template_id)) return "XUNJI_TEMPLATE_SCOPE: Target is not in the current Agent folder. No mutation sent.";
   if (versions[item.template_id] !== item.base_version) return "XUNJI_TEMPLATE_CONFLICT: Version conflict. Sync, show changes, then obtain a new confirmation.";
  } else if ("client_id" in item && item.client_id) {
   if (clients.has(item.client_id)) return "XUNJI_TEMPLATE_INPUT: Duplicate new-template client_id.";
   clients.add(item.client_id);
  }
 }
 if (mutation.folder_update && folder.version !== mutation.folder_update.base_version) return "XUNJI_TEMPLATE_CONFLICT: Folder version conflict. Sync and obtain confirmation again.";
 if (current.size - mutation.deletes.length + mutation.upserts.filter(t => !t.template_id).length > 14) return "XUNJI_TEMPLATE_LIMIT: More than 14 active templates. Ask which to replace or remove; do not truncate.";
 return null;
}
export async function previewTemplates(env: TemplatesEnv, input: z.input<typeof mutationInput>, fetcher: typeof fetch = fetch) {
 const parsed = mutationInput.safeParse(input);
 if (!parsed.success) return toolError("XUNJI_TEMPLATE_INPUT: Check names, identifiers, versions, one Agent folder, at most 14 upserts/deletes, 15 movements and 20 sets. Do not truncate. Native movement input needs explicit sets arrays.");
 const error = await checkCurrent(env, parsed.data, fetcher);
 if (error) return toolError(error);
 return toolData({ review: parsed.data, preview_token: await previewToken("templates", env.XUNJI_TEMPLATE_API_KEY!, parsed.data), expires_in_seconds: 900, next_step: "Show exact folder rename, template names, movements, sets, progression and deletions. Wait for explicit user confirmation, then apply this same mutation and token. This preview has not sent a mutation." }, env.XUNJI_TEMPLATE_API_KEY!);
}
export async function applyTemplates(env: TemplatesEnv, input: z.input<typeof templatesApplyInput>, fetcher: typeof fetch = fetch) {
 const parsed = templatesApplyInput.safeParse(input);
 if (!parsed.success) return toolError("XUNJI_TEMPLATE_CONFIRMATION: Matching reviewed mutation, preview_token and confirmed:true are required.");
 const { mutation, preview_token } = parsed.data;
 if (!env.XUNJI_TEMPLATE_API_KEY || !await verifyPreview(preview_token, "templates", env.XUNJI_TEMPLATE_API_KEY, mutation)) return toolError("XUNJI_TEMPLATE_PREVIEW: Expired or changed preview. Preview again and obtain confirmation.");
 if (!env.OAUTH_KV) return toolError("XUNJI_TEMPLATE_CONFIG: OAUTH_KV is required for safe mutation retries.");
 const digest = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
 const markerKey = `xunji-template-dispatch:${await digest(JSON.stringify([env.XUNJI_TEMPLATE_API_KEY, mutation.mutation_id]))}`;
 const fingerprint = await digest(JSON.stringify(mutation));
 const previous = await env.OAUTH_KV.get(markerKey);
 if (previous && previous !== fingerprint) return toolError("XUNJI_TEMPLATE_ID_REUSED: This mutation_id was already dispatched with different content. Use a new ID and obtain a new preview.");
 if (!previous) {
  const error = await checkCurrent(env, mutation, fetcher);
  if (error) return toolError(error);
  // Store only hashes, never templates, health records or credentials. On an
  // uncertain retry, the backend must see the same ID to return its saved result.
  await env.OAUTH_KV.put(markerKey, fingerprint, { expirationTtl: 24 * 60 * 60 });
 }
 const r = await postXunji("templatesMutate", env.XUNJI_TEMPLATE_API_KEY, { ...mutation, confirmed: true }, fetcher);
 return r.ok ? toolData(r.data, env.XUNJI_TEMPLATE_API_KEY) : toolError(r.error);
}
export function registerTemplateTools(server: McpServer, env: TemplatesEnv, authenticated: boolean) {
 server.registerTool("xunji_sync_templates", {
  description: "Sync only the dedicated Xunji Agent template folder. Send {} for complete state; only send template_versions for fully cached templates. Respect folder_deleted and clear only this folder's cache. Read or edit templates only after a fresh sync.", inputSchema: templatesSyncInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
 }, async input => authenticated ? syncTemplates(env, input) : toolError("Sign in before reading templates."));
 server.registerTool("xunji_preview_templates", {
  description: "Read latest Agent folder state and preview a proposed template mutation without writing. Check folder scope, capacity (14 templates, 15 movements, 20 sets), names and base versions. Use official Chinese movement names; preserve synced fields when editing. Show exact review and wait for explicit confirmation. Keep mutation_id/client_id stable. Native movement arrays require visible sets arrays; unsupported native shapes must be converted with user review, never guessed or truncated.", inputSchema: mutationInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
 }, async input => authenticated ? previewTemplates(env, input) : toolError("Sign in before previewing templates."));
 server.registerTool("xunji_apply_templates", {
  description: "Apply the exact previewed Agent folder mutation ONLY after explicit user confirmation. Requires token and confirmed:true. Rechecks current scope, limits and versions. On version conflict sync, show conflict and obtain new confirmation. Reuse mutation_id on uncertain retries; never auto retry or delete/move/share the Agent folder.", inputSchema: templatesApplyInput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
 }, async input => authenticated ? applyTemplates(env, input) : toolError("Sign in before modifying templates."));
}
