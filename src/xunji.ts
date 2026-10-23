import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { gunzipSync } from "node:zlib";

export interface XunjiEnv {
	XUNJI_TRAIN_API_KEY?: string;
	XUNJI_FOOD_API_KEY?: string;
}

export const trainingInput = z.object({
	datestr: z.iso.date().describe("Training date in the user's timezone, YYYY-MM-DD."),
	include_full_data: z.boolean().default(false).describe(
		"Include RPE, notes, unfinished sets, drop sets and heart-rate summaries.",
	),
});

const TRAINING_URL = "https://trains.xunjiapp.cn/api_trains_for_llm_v2";

export const foodInput = z.object({
	start_date: z.iso.date().describe("First requested food-record date in the user's timezone, YYYY-MM-DD."),
	end_date: z.iso.date().describe("Last requested food-record date in the user's timezone, YYYY-MM-DD."),
	include_detail: z.boolean().default(true).describe("Include individual foods, quantities and nutrition details."),
}).refine(value => value.start_date <= value.end_date, "start_date must not exceed end_date");

function isoDateOffset(now: Date, years: number, months: number) {
	const targetMonth = now.getUTCMonth() + months;
	const targetYear = now.getUTCFullYear() + years + Math.floor(targetMonth / 12);
	const normalizedMonth = ((targetMonth % 12) + 12) % 12;
	const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
	const date = new Date(Date.UTC(targetYear, normalizedMonth, Math.min(now.getUTCDate(), lastDay)));
	return date.toISOString().slice(0, 10);
}

export async function getFood(
	bindings: XunjiEnv,
	input: z.input<typeof foodInput>,
	fetcher: typeof fetch = fetch,
	now: Date = new Date(),
) {
	const parsed = foodInput.safeParse(input);
	if (!parsed.success) return failure("Invalid food date range or options. Use YYYY-MM-DD and ensure start_date does not exceed end_date.");
	const earliest = isoDateOffset(now, -1, 0);
	const latest = isoDateOffset(now, 0, 3);
	if (parsed.data.start_date < earliest || parsed.data.end_date > latest) {
		return failure(`XUNJI_FOOD_RANGE: Query dates must be between ${earliest} and ${latest}.`);
	}
	const key = bindings.XUNJI_FOOD_API_KEY?.trim();
	if (!key) return failure("Configure the XUNJI_FOOD_API_KEY Worker secret before querying food records.");
	if (!/^[\x21-\x7e]+$/.test(key)) return failure("XUNJI_FOOD_KEY_FORMAT: Store only the raw food API key without spaces, control characters or non-ASCII characters.");
	let stage = "request";
	try {
		const response = await fetcher("https://eatings.xunjiapp.cn/open/food/query_gzip", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify(parsed.data),
			redirect: "manual", signal: AbortSignal.timeout(20_000),
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) return failure(`XUNJI_FOOD_REDIRECT: HTTP ${response.status}; redirect was not followed.`);
		if (!response.ok) {
			const retry = response.headers.get("Retry-After");
			return failure(`XUNJI_FOOD_HTTP: HTTP ${response.status}.${response.status === 429 && retry && /^\d+$/.test(retry) ? ` Retry after ${retry} seconds.` : ""}`);
		}
		stage = "response-body";
		const bytes = new Uint8Array(await response.arrayBuffer());
		stage = "gzip-decode";
		const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 10 * 1024 * 1024 }) : bytes;
		stage = "json-parse";
		const data: unknown = JSON.parse(new TextDecoder().decode(decoded).replace(/^\uFEFF/, ""));
		if (!data || typeof data !== "object") return failure("XUNJI_FOOD_RESPONSE: Invalid API response.");
		const result = data as Record<string, unknown>;
		if (result.success !== true || result.res === undefined || result.res === null) {
			const message = JSON.stringify(result);
			if (/apikey (missing|invalid)/i.test(message)) return failure("XUNJI_FOOD_AUTH: Xunji rejected the food key. Update the Worker secret from the Xunji app.");
			if (/too frequent/i.test(message)) return failure(`XUNJI_FOOD_RATE_LIMIT: Wait before retrying.${typeof result.retry_after_ms === "number" ? ` Retry after ${result.retry_after_ms} ms.` : ""}`);
			if (/仅VIP可用/.test(message)) return failure("XUNJI_FOOD_VIP: This API requires VIP membership.");
			return failure("XUNJI_FOOD_RESPONSE: Expected success:true and res from the food API.");
		}
		const text = JSON.stringify({ start_date: parsed.data.start_date, end_date: parsed.data.end_date, res: result.res }).split(key).join("[REDACTED]");
		return { content: [{ type: "text" as const, text }] };
	} catch (error) {
		const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
		return failure(`XUNJI_FOOD_${timeout ? "TIMEOUT" : "FAILURE"}: Failed during ${stage}. No changes were made.`);
	}
}

function failure(message: string) {
	return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export async function getTraining(
	bindings: XunjiEnv,
	input: z.input<typeof trainingInput>,
	fetcher: typeof fetch = fetch,
) {
	const parsed = trainingInput.safeParse(input);
	if (!parsed.success) return failure("Invalid training date or options. Use YYYY-MM-DD.");
	const key = bindings.XUNJI_TRAIN_API_KEY?.trim();
	if (!key) return failure("Configure the XUNJI_TRAIN_API_KEY Worker secret before querying training.");
	if (!/^[\x21-\x7e]+$/.test(key)) {
		return failure("XUNJI_KEY_FORMAT: The Worker secret contains spaces, control characters or non-ASCII characters. Store only the raw Xunji API key, without a Bearer prefix.");
	}

	let stage = "request";
	try {
		const response = await fetcher(TRAINING_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ schema_version: "train_open_api_v2", ...parsed.data }),
			// workerd supports manual/follow, but rejects redirect:"error" before I/O.
			redirect: "manual",
			signal: AbortSignal.timeout(20_000),
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			return failure(`XUNJI_REDIRECT: The training endpoint returned HTTP ${response.status}. Redirect was not followed; credentials were not forwarded.`);
		}
		if (!response.ok) {
			// Do not expose upstream response bodies, headers or exception messages.
			const retry = response.headers.get("Retry-After");
			const hint = response.status === 429 && retry && /^\d+$/.test(retry)
				? ` Retry after ${retry} seconds.` : "";
			return failure(`Xunji training API returned HTTP ${response.status}.${hint}`);
		}
		stage = "response-body";
		const bytes = new Uint8Array(await response.arrayBuffer());
		stage = "gzip-decode";
		// Some API responses contain gzip bytes without Content-Encoding. Sniff the
		// bytes so already-decoded fetch responses are never decompressed twice.
		const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b
			? gunzipSync(bytes, { maxOutputLength: 10 * 1024 * 1024 }) : bytes;
		stage = "json-parse";
		const data: unknown = JSON.parse(new TextDecoder().decode(decoded).replace(/^\uFEFF/, ""));
		if (!data || typeof data !== "object") return failure("Xunji returned an invalid response.");
		const result = data as Record<string, unknown>;
		// Training responses need not contain success:true; res.trains is authoritative.
		if (result.success === false || !result.res || typeof result.res !== "object"
			|| !Array.isArray((result.res as Record<string, unknown>).trains)) {
			const errorText = JSON.stringify(result);
			if (/too frequent/i.test(errorText)) {
				const delay = typeof result.retry_after_ms === "number" ? result.retry_after_ms : undefined;
				return failure(`Xunji rate limit reached.${delay !== undefined ? ` Retry after ${delay} ms.` : " Wait before retrying."}`);
			}
			if (/apikey (missing|invalid)/i.test(errorText)) {
				return failure("Xunji rejected the training key. Update the Worker secret from the Xunji app.");
			}
			if (/仅VIP可用/.test(errorText)) return failure("Xunji requires VIP membership for this API.");
			return failure("Xunji did not return res.trains. Check the training key and API access.");
		}
		// Return only API data, never request credentials. Redact even if an upstream field echoes the key.
		const text = JSON.stringify({ datestr: parsed.data.datestr, res: result.res })
			.split(key).join("[REDACTED]");
		return { content: [{ type: "text" as const, text }] };
	} catch (error) {
		// Report only fixed categories, never the exception message (it may contain
		// a header value), raw response, request headers, or personal records.
		const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
		if (timeout) return failure(`XUNJI_TIMEOUT: Timed out during ${stage}. No changes were made.`);
		if (stage === "request") return failure("XUNJI_NETWORK: Request failed before receiving an HTTP response. Check Worker outbound connectivity and the upstream TLS/DNS service. No changes were made.");
		if (stage === "response-body") return failure("XUNJI_BODY: Received HTTP success but could not read the response body. No changes were made.");
		if (stage === "gzip-decode") return failure("XUNJI_GZIP: Received gzip bytes but decompression failed or exceeded the 10 MiB limit. No changes were made.");
		return failure("XUNJI_JSON: Received HTTP success but the body was not valid JSON after decompression. No changes were made.");
	}
}

export function registerXunjiTools(server: McpServer, bindings: XunjiEnv, authenticated: boolean) {
	server.registerTool("xunji_get_food", {
		description: "Read Xunji food and nutrition records for an explicitly requested date range within the past year and next three months. Uses the separate food Worker secret and returns individual foods and totals where provided. Read-only; no food search, creation, template operations or writes.",
		inputSchema: foodInput,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, async (input) => {
		if (!authenticated) return failure("Sign in through Cloudflare Access before reading Xunji food data.");
		return getFood(bindings, input);
	});
	server.registerTool("xunji_get_training", {
		description: "Read Xunji training logs for a specified date. Only call when the user requests their training data. Read-only; use include_full_data for RPE, notes and heart rate. Credentials stay in Worker secrets.",
		inputSchema: trainingInput,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, async (input) => {
		if (!authenticated) return failure("Sign in through Cloudflare Access before reading Xunji data.");
		return getTraining(bindings, input);
	});
}
