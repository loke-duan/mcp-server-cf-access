import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("body read runs inside Workers with a synthetic API", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: process.cwd(),
			contents: `
				import { queryBody } from './src/xunji-body.ts';
				export default { async fetch() {
					return Response.json(await queryBody(
						{ XUNJI_BODY_API_KEY: 'runtime-body' },
						{ start_date: '2026-10-01', end_date: '2026-10-22', types: ['weight'] }
					));
				} };
			`,
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		external: ["node:zlib"],
	});
	let calls = 0;
	const mf = new Miniflare(convertV4MiniflareOptions({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2026-03-10",
		compatibilityFlags: ["nodejs_compat"],
		outboundService: async request => {
			calls++;
			assert.equal(request.url, "https://api.xunjiapp.cn/open/body/query_gzip");
			assert.equal(request.headers.get("Authorization"), "Bearer runtime-body");
			assert.deepEqual(await request.json(), {
				start_date: "2026-10-01",
				end_date: "2026-10-22",
				types: ["weight"],
				include_latest: true,
				include_records: true,
				limit: 500,
				offset: 0,
			});
			return Response.json({ success: true, res: { records: [] } });
		},
	}));
	try {
		const result = await (await mf.dispatchFetch("https://runtime.invalid")).json();
		assert.equal(result.isError, undefined, JSON.stringify(result));
		assert.equal(calls, 1);
	} finally {
		await mf.dispose();
	}
});
