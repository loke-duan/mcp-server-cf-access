import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { getTraining, registerXunjiTools } from "../src/xunji.ts";

const bindings = { XUNJI_TRAIN_API_KEY: "test-only-training-secret" };
const input = { datestr: "2026-10-22" };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

test("reads the exact date using a secret header, accepting res without success", async () => {
	let calls = 0;
	const result = await getTraining(bindings, input, async (url, options) => {
		calls++;
		assert.equal(url, "https://trains.xunjiapp.cn/api_trains_for_llm_v2");
		assert.equal(options.headers.Authorization, `Bearer ${bindings.XUNJI_TRAIN_API_KEY}`);
		assert.equal(options.method, "POST");
		assert.equal(options.redirect, "error");
		assert.deepEqual(JSON.parse(options.body), { schema_version: "train_open_api_v2", datestr: input.datestr, include_full_data: false });
		return json({ res: { trains: [{ title: "腿部训练", localid: 1 }] } });
	});
	assert.equal(calls, 1);
	assert.equal(result.isError, undefined);
	assert.equal(JSON.parse(result.content[0].text).res.trains[0].title, "腿部训练");
	assert.ok(!JSON.stringify(result).includes(bindings.XUNJI_TRAIN_API_KEY));
});

test("full-data requests and empty days are valid", async () => {
	const result = await getTraining(bindings, { ...input, include_full_data: true }, async (_, options) => {
		assert.equal(JSON.parse(options.body).include_full_data, true);
		return json({ res: { trains: [] } });
	});
	assert.deepEqual(JSON.parse(result.content[0].text).res.trains, []);
});

test("invalid calendar dates and missing keys do not issue requests", async () => {
	const never = () => { assert.fail("must not fetch"); };
	assert.equal((await getTraining(bindings, { datestr: "2026-02-30" }, never)).isError, true);
	assert.equal((await getTraining({}, input, never)).isError, true);
});

test("upstream HTTP and application errors stay errors and never expose secrets", async () => {
	for (const response of [
		json({ error: bindings.XUNJI_TRAIN_API_KEY }, 401),
		json({ success: false, message: "apikey invalid", key: bindings.XUNJI_TRAIN_API_KEY }),
		json({ success: false, message: "too frequent", retry_after_ms: 30000 }),
		json({ success: true }),
		new Response("not json"),
	]) {
		const result = await getTraining(bindings, input, async () => response);
		assert.equal(result.isError, true);
		assert.ok(!JSON.stringify(result).includes(bindings.XUNJI_TRAIN_API_KEY));
	}
});

test("rate-limit retry timing is returned without automatic retries", async () => {
	let calls = 0;
	const result = await getTraining(bindings, input, async () => {
		calls++;
		return json({}, 429, { "Retry-After": "30" });
	});
	assert.equal(calls, 1);
	assert.match(result.content[0].text, /30 seconds/);
});

test("network errors and echoed secrets are redacted", async () => {
	const failed = await getTraining(bindings, input, async () => { throw new Error(bindings.XUNJI_TRAIN_API_KEY); });
	assert.equal(failed.isError, true);
	assert.ok(!JSON.stringify(failed).includes(bindings.XUNJI_TRAIN_API_KEY));
	const echoed = await getTraining(bindings, input, async () => json({ res: { trains: [{ note: bindings.XUNJI_TRAIN_API_KEY }] } }));
	assert.ok(!JSON.stringify(echoed).includes(bindings.XUNJI_TRAIN_API_KEY));
});

test("tool registration is read-only and refuses unauthenticated calls", async () => {
	let registered;
	registerXunjiTools({ registerTool: (...args) => { registered = args; } }, bindings, false);
	assert.equal(registered[0], "xunji_get_training");
	assert.equal(registered[1].annotations.readOnlyHint, true);
	assert.equal(registered[1].inputSchema.safeParse(input).success, true);
	const result = await registered[2](input);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Sign in/);
});

test("decodes gzip bytes even without a Content-Encoding header", async () => {
	const result = await getTraining(bindings, input, async () => new Response(
		gzipSync(JSON.stringify({ res: { trains: [{ title: "compressed" }] } })),
	));
	assert.equal(result.isError, undefined);
	assert.equal(JSON.parse(result.content[0].text).res.trains[0].title, "compressed");
});

test("diagnostics distinguish request, timeout, body, gzip and JSON failures", async () => {
	const cases = [
		[async () => { throw new TypeError("secret detail"); }, "XUNJI_NETWORK"],
		[async () => { throw new DOMException("secret detail", "TimeoutError"); }, "XUNJI_TIMEOUT"],
		[async () => ({ ok: true, arrayBuffer: async () => { throw new Error("secret detail"); } }), "XUNJI_BODY"],
		[async () => new Response(new Uint8Array([0x1f, 0x8b, 0])), "XUNJI_GZIP"],
		[async () => new Response("<html>secret detail</html>"), "XUNJI_JSON"],
	];
	for (const [fetcher, code] of cases) {
		const result = await getTraining(bindings, input, fetcher);
		assert.equal(result.isError, true);
		assert.ok(result.content[0].text.startsWith(code));
		assert.ok(!result.content[0].text.includes("secret detail"));
	}
});

test("invalid header credentials fail locally without disclosing values", async () => {
	const result = await getTraining({ XUNJI_TRAIN_API_KEY: "中文占位符" }, input, () => assert.fail("must not fetch"));
	assert.match(result.content[0].text, /^XUNJI_KEY_FORMAT/);
	assert.ok(!result.content[0].text.includes("中文占位符"));
});
