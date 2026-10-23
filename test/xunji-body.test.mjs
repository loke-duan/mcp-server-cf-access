import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { queryBody, registerBodyTools } from "../src/xunji-body.ts";

const env = { XUNJI_BODY_API_KEY: "test-body-secret" };
const input = {
	start_date: "2026-10-01",
	end_date: "2026-10-22",
	types: ["weight", "weist"],
	offset: 10,
};

const value = result => JSON.parse(result.content[0].text);

test("body query preserves range, types and pagination and uses only the body key", async () => {
	const result = await queryBody(env, input, async (url, init) => {
		assert.equal(url, "https://api.xunjiapp.cn/open/body/query_gzip");
		assert.equal(init.headers.Authorization, "Bearer test-body-secret");
		assert.equal(init.redirect, "manual");
		assert.deepEqual(JSON.parse(init.body), {
			...input,
			include_latest: true,
			include_records: true,
			limit: 500,
		});
		return new Response(gzipSync(JSON.stringify({ success: true, res: { records: [], latest: {} } })));
	});
	assert.deepEqual(value(result).res.records, []);
});

test("body query rejects invalid ranges, types and pagination before requesting", async () => {
	const never = () => assert.fail("must not fetch");
	for (const invalid of [
		{ start_date: "2026-10-22", end_date: "2026-10-01" },
		{ start_date: "2026-10-01", end_date: "2026-10-22", types: ["waist"] },
		{ start_date: "2026-10-01", end_date: "2026-10-22", limit: 501 },
		{ start_date: "2026-10-01", end_date: "2026-10-22", offset: -1 },
	]) {
		assert.equal((await queryBody(env, invalid, never)).isError, true);
	}
});

test("body query handles missing credentials and safe upstream failures", async () => {
	assert.equal((await queryBody({}, input, () => assert.fail("must not fetch"))).isError, true);
	for (const response of [
		Response.json({ success: false, message: "apikey invalid", detail: env.XUNJI_BODY_API_KEY }),
		Response.json({ success: false, message: "too frequent", retry_after_ms: 15000 }),
		new Response(null, { status: 302, headers: { Location: "https://other.invalid" } }),
		new Response("private body", { status: 500 }),
	]) {
		const result = await queryBody(env, input, async () => response);
		assert.equal(result.isError, true);
		assert.ok(!JSON.stringify(result).includes(env.XUNJI_BODY_API_KEY));
		assert.ok(!JSON.stringify(result).includes("private body"));
	}
});

test("body registers exactly one authenticated, read-only tool", async () => {
	const registered = {};
	registerBodyTools({ registerTool: (name, config, callback) => { registered[name] = { config, callback }; } }, env, false);
	assert.deepEqual(Object.keys(registered), ["xunji_get_body"]);
	assert.equal(registered.xunji_get_body.config.annotations.readOnlyHint, true);
	assert.equal(registered.xunji_get_body.config.annotations.destructiveHint, false);
	assert.equal((await registered.xunji_get_body.callback(input)).isError, true);
});
