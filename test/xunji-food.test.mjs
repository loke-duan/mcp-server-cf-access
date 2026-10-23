import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { getFood, registerXunjiTools } from "../src/xunji.ts";

const env = { XUNJI_FOOD_API_KEY: "synthetic-food-key", XUNJI_TRAIN_API_KEY: "different-training-key" };
const input = { start_date: "2026-10-20", end_date: "2026-10-22" };
const now = new Date("2026-10-23T00:00:00Z");

test("food query uses only the food key, exact requested range and detailed gzip records", async () => {
	const result = await getFood(env, input, async (url, options) => {
		assert.equal(url, "https://eatings.xunjiapp.cn/open/food/query_gzip");
		assert.equal(options.headers.Authorization, "Bearer synthetic-food-key");
		assert.equal(options.redirect, "manual");
		assert.equal(options.method, "POST");
		assert.deepEqual(JSON.parse(options.body), { ...input, include_detail: true });
		return new Response(gzipSync(JSON.stringify({ success: true, res: { foods: [{ name: "鸡蛋", amount: 100 }] } })));
	}, now);
	assert.equal(result.isError, undefined);
	assert.equal(JSON.parse(result.content[0].text).res.foods[0].name, "鸡蛋");
});

test("food missing key and invalid date do not send a request or reuse the training key", async () => {
	const never = () => assert.fail("must not fetch");
	assert.equal((await getFood({ XUNJI_TRAIN_API_KEY: "train-key" }, input, never, now)).isError, true);
	assert.equal((await getFood(env, { start_date: "2026-02-30", end_date: "2026-03-01" }, never, now)).isError, true);
	assert.equal((await getFood(env, { start_date: "2026-10-22", end_date: "2026-10-01" }, never, now)).isError, true);
	assert.equal((await getFood(env, { start_date: "2025-10-22", end_date: "2026-01-01" }, never, now)).isError, true);
	assert.equal((await getFood(env, { start_date: "2027-01-01", end_date: "2027-01-24" }, never, now)).isError, true);
});

test("food range clamps calendar-month boundaries", async () => {
	const monthEnd = new Date("2026-01-31T00:00:00Z");
	const valid = await getFood(env, { start_date: "2026-04-30", end_date: "2026-04-30" }, async () => Response.json({ success: true, res: [] }), monthEnd);
	assert.equal(valid.isError, undefined);
	assert.equal((await getFood(env, { start_date: "2026-05-01", end_date: "2026-05-01" }, () => assert.fail("must not fetch"), monthEnd)).isError, true);
});

test("food empty data is valid; upstream errors, bad JSON and redirects are not", async () => {
	const empty = await getFood(env, input, async () => Response.json({ success: true, res: [] }), now);
	assert.deepEqual(JSON.parse(empty.content[0].text).res, []);
	for (const response of [
		Response.json({ res: [] }),
		Response.json({ success: false, message: "apikey invalid", key: env.XUNJI_FOOD_API_KEY }),
		Response.json({ success: false, message: "too frequent", retry_after_ms: 15000 }),
		new Response(null, { status: 302, headers: { Location: "https://other.invalid" } }),
		new Response("<html>upstream error</html>"),
		new Response("private body", { status: 500 }),
	]) {
		let calls = 0;
		const result = await getFood(env, input, async () => { calls++; return response; }, now);
		assert.equal(calls, 1);
		assert.equal(result.isError, true);
		assert.ok(!JSON.stringify(result).includes(env.XUNJI_FOOD_API_KEY));
		assert.ok(!JSON.stringify(result).includes("private body"));
	}
});

test("food tool requires OAuth and is read-only", async () => {
	const registered = {};
	registerXunjiTools({ registerTool: (name, config, callback) => { registered[name] = { config, callback }; } }, env, false);
	assert.equal(registered.xunji_get_food.config.annotations.readOnlyHint, true);
	assert.equal((await registered.xunji_get_food.callback(input)).isError, true);
});
