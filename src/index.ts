import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";
import { registerXunjiTools } from "./xunji";
import { registerBodyTools } from "./xunji-body";

function createServer() {
	const server = new McpServer({
		name: "Xunji Read-Only MCP",
		version: "1.0.0",
	});
	const props = getMcpAuthContext()?.props as Props | undefined;
	registerXunjiTools(server, env as Env, Boolean(props?.email));
	registerBodyTools(server, env as Env, Boolean(props?.email));

	return server;
}

const mcpHandler = createMcpHandler(createServer);
const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider({
	allowPlainPKCE: false,
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: { fetch: handleAccessRequest as any },
	tokenEndpoint: "/token",
});
