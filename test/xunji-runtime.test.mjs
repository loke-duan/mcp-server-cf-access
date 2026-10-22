import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("real Workers runtime can send training and food requests without redirect-mode errors", async () => {
	const bundled = await build({
		stdin: {
			contents: `import { getTraining, getFood } from './src/xunji.ts';
				export default { async fetch(request) {
					if (new URL(request.url).pathname === '/food') return Response.json(await getFood(
						{ XUNJI_FOOD_API_KEY: 'synthetic-food-key' }, { datestr: '2026-10-22' }
					));
					return Response.json(await getTraining(
						{ XUNJI_TRAIN_API_KEY: 'synthetic-runtime-key' },
						{ datestr: '2026-10-22', include_full_data: true }
					));
				} };`,
			resolveDir: process.cwd(),
		},
		bundle: true, write: false, format: "esm", platform: "neutral",
		external: ["node:zlib"],
	});
	let outboundCalls = 0;
	const mf = new Miniflare(convertV4MiniflareOptions({
		modules: true, script: bundled.outputFiles[0].text,
		compatibilityDate: "2026-03-10", compatibilityFlags: ["nodejs_compat"],
		outboundService: async (request) => {
			outboundCalls++;
			if (request.url === "https://eatings.xunjiapp.cn/open/food/query_gzip") {
				assert.equal(request.headers.get("Authorization"), "Bearer synthetic-food-key");
				assert.deepEqual(await request.json(), { start_date: "2026-10-22", end_date: "2026-10-22", include_detail: true });
				return Response.json({ success: true, res: { foods: [{ name: "food-runtime-test" }] } });
			}
			assert.equal(request.url, "https://trains.xunjiapp.cn/api_trains_for_llm_v2");
			assert.equal(request.headers.get("Authorization"), "Bearer synthetic-runtime-key");
			assert.deepEqual(await request.json(), {
				schema_version: "train_open_api_v2", datestr: "2026-10-22", include_full_data: true,
			});
			return Response.json({ res: { trains: [{ title: "Runtime test" }] } });
		},
	}));
	try {
		const result = await (await mf.dispatchFetch("https://test.invalid")).json();
		assert.equal(result.isError, undefined, JSON.stringify(result));
		assert.equal(outboundCalls, 1);
		assert.equal(JSON.parse(result.content[0].text).res.trains[0].title, "Runtime test");
		const food = await (await mf.dispatchFetch("https://test.invalid/food")).json();
		assert.equal(food.isError, undefined, JSON.stringify(food));
		assert.equal(outboundCalls, 2);
		assert.equal(JSON.parse(food.content[0].text).res.foods[0].name, "food-runtime-test");
	} finally {
		await mf.dispose();
	}
});
