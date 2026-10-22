import assert from "node:assert/strict";
import test from "node:test";
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
