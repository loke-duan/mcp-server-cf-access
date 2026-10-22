import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { getFood, registerXunjiTools } from "../src/xunji.ts";

const env = { XUNJI_FOOD_API_KEY: "synthetic-food-key", XUNJI_TRAIN_API_KEY: "different-training-key" };
const input = { datestr: "2026-10-22" };

test("food query uses only the food key, exact requested day and detailed gzip records", async () => {
	const result = await getFood(env, input, async (url, options) => {
		assert.equal(url, "https://eatings.xunjiapp.cn/open/food/query_gzip");
		assert.equal(options.headers.Authorization, "Bearer synthetic-food-key");
		assert.equal(options.redirect, "manual");
		assert.equal(options.method, "POST");
		assert.deepEqual(JSON.parse(options.body), { start_date: input.datestr, end_date: input.datestr, include_detail: true });
		return new Response(gzipSync(JSON.stringify({ success: true, res: { foods: [{ name: "鸡蛋", amount: 100 }] } })));
	});
	assert.equal(result.isError, undefined);
	assert.equal(JSON.parse(result.content[0].text).res.foods[0].name, "鸡蛋");
});

test("food missing key and invalid date do not send a request or reuse the training key", async () => {
	const never = () => assert.fail("must not fetch");
	assert.equal((await getFood({ XUNJI_TRAIN_API_KEY: "train-key" }, input, never)).isError, true);
	assert.equal((await getFood(env, { datestr: "2026-02-30" }, never)).isError, true);
});

test("food empty data is valid; upstream errors, bad JSON and redirects are not", async () => {
	const empty = await getFood(env, input, async () => Response.json({ success: true, res: [] }));
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
		const result = await getFood(env, input, async () => { calls++; return response; });
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
