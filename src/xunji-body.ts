import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { postXunji, toolData, toolError } from "./xunji-api.ts";

export interface BodyEnv { XUNJI_BODY_API_KEY?: string }
export const bodyType = z.enum(["weight", "bodyfat", "neck", "chest", "weist", "shoulder", "bot", "arm_left", "arm_right", "forearm_left", "forearm_right", "leg_left", "leg_right", "cav_left", "cav_right"]);
export const bodyQueryInput = z.object({
 start_date: z.iso.date(), end_date: z.iso.date(), types: z.array(bodyType).optional(),
 include_latest: z.boolean().default(true), include_records: z.boolean().default(true),
 limit: z.number().int().min(1).max(500).default(500), offset: z.number().int().min(0).default(0),
}).refine(v => v.start_date <= v.end_date, "start_date must not exceed end_date");
export async function queryBody(env: BodyEnv, input: z.input<typeof bodyQueryInput>, fetcher: typeof fetch = fetch) {
 const parsed = bodyQueryInput.safeParse(input);
 if (!parsed.success) return toolError("XUNJI_BODY_INPUT: Invalid date range, measurement type or pagination.");
 const r = await postXunji("bodyQuery", env.XUNJI_BODY_API_KEY, parsed.data, fetcher);
 return r.ok ? toolData(r.data, env.XUNJI_BODY_API_KEY!) : toolError(r.error);
}
export function registerBodyTools(server: McpServer, env: BodyEnv, authenticated: boolean) {
 server.registerTool("xunji_get_body", {
  description: "Read explicitly requested Xunji body measurements by date range and type with pagination. Units: weight kg, bodyfat %, dimensions cm; waist is spelled weist. Personal health data; do not diagnose.", inputSchema: bodyQueryInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
 }, async input => authenticated ? queryBody(env, input) : toolError("Sign in before reading body data."));
}
