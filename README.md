## Xunji training tool

This server exposes the read-only `xunji_get_training` MCP tool. Arguments:
`datestr` (a real `YYYY-MM-DD` date in the user's timezone) and
`include_full_data` (default `false`; enable for RPE, notes, unfinished sets,
drop sets and heart-rate summaries).

Configure the encrypted secret on the **same Worker** as this repository, then deploy:

```sh
npx wrangler secret put XUNJI_TRAIN_API_KEY
npm run deploy
```

If the key is already set in Cloudflare, retain it. Do not put keys in GitHub,
ChatGPT, tool arguments or `wrangler.jsonc`. This tool stays listed when a key is
missing and returns a clear configuration error.

The existing Cloudflare Access OAuth flow protects this tool. It uses a single
personal Xunji key: **every user admitted by the Access policy can read that
account's training data**. Restrict the Access application to the owner or trusted
users. This is not multi-user Xunji account mapping.

After deploying, refresh the custom MCP app's tools in ChatGPT (reconnect if
needed). Verify that `xunji_get_training` is listed. The skill-only `训记助手`
plugin provides instructions; this Worker provides the actual tool. Example:

```json
{ "datestr": "2026-10-22", "include_full_data": true }
```

Training results use `res.trains` and need not contain `success: true`. Errors,
including rate limits, are returned as tool errors without exposing upstream
bodies or exceptions. Credentials go only to the fixed official HTTPS training
endpoint, and redirects are refused. Workers fetch handles compressed responses.
The tool does not retry automatically. Respect the 15-second lightweight /
30-second full-data read limits and reuse results within a task when appropriate.
This change does not add Xunji write tools.

Run `npm test` with Node 22.18+ or Node 24+, `npm run type-check`, and
`npx wrangler deploy --dry-run` for verification. Tests use synthetic records and
mocked requests. Deployment alone does not verify the live key or refresh
ChatGPT's cached tool list.

---

# Model Context Protocol (MCP) Server + Access OAuth

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server that supports remote MCP connections, with Access OAuth built-in.

You can deploy it to your own Cloudflare account, and after you create your own Access for SaaS OIDC app, you'll have a fully functional remote MCP server that you can build off. Users will be able to connect to your MCP server by signing in with your connected Access Identity Provider.

The MCP server (powered by [Cloudflare Workers](https://developers.cloudflare.com/workers/)):

- Acts as OAuth _Server_ to your MCP clients
- Acts as OAuth _Client_ to your _real_ OAuth server (in this case, Access)

## Getting Started

Clone the repo & install dependencies: `npm install`

### For Production

Create a new [Access for SaaS OIDC App](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/saas-apps/generic-oidc-saas/):

- For the Authorization callback URL, specify `https://mcp-access-oauth.<your-subdomain>.workers.dev/callback` and `http://localhost:8788/callback` if you are developing locally.
- Note your Client ID and Client secret.
- Set secrets via Wrangler

```bash
wrangler secret put ACCESS_CLIENT_ID
wrangler secret put ACCESS_CLIENT_SECRET
wrangler secret put ACCESS_TOKEN_URL
wrangler secret put ACCESS_AUTHORIZATION_URL
wrangler secret put ACCESS_JWKS_URL
wrangler secret put COOKIE_ENCRYPTION_KEY # add any random string here e.g. openssl rand -hex 32
```

#### Set up a KV namespace

- Create the KV namespace:
  `wrangler kv:namespace create "OAUTH_KV"`
- Update the Wrangler file with the KV ID

#### Deploy & Test

Deploy the MCP server to make it available on your workers.dev domain
` wrangler deploy`

Test the remote server using [Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```
npx @modelcontextprotocol/inspector@latest
```

Enter `https://mcp-access-oauth.<your-subdomain>.workers.dev/mcp` and hit connect. Once you go through the authentication flow, you'll see the Tools working:

<img width="640" alt="image" src="https://github.com/user-attachments/assets/7973f392-0a9d-4712-b679-6dd23f824287" />

You now have a remote MCP server deployed!

### Access Control

This MCP server uses Access for authentication. All authenticated Access users can access basic tools like "add".

The "generateImage" tool is restricted to specific Access users listed in the `ALLOWED_EMAILS` configuration:

```typescript
// Add user emails for image generation access
const ALLOWED_EMAILS = new Set(["employee1@mycompany.com", "teammate1@mycompany.com"]);
```

### Access the remote MCP server from Claude Desktop

Open Claude Desktop and navigate to Settings -> Developer -> Edit Config. This opens the configuration file that controls which MCP servers Claude can access.

Replace the content with the following configuration. Once you restart Claude Desktop, a browser window will open showing your OAuth login page. Complete the authentication flow to grant Claude access to your MCP server. After you grant access, the tools will become available for you to use.

```
{
  "mcpServers": {
    "math": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp-access-oauth.<your-subdomain>.workers.dev/mcp"
      ]
    }
  }
}
```

Once the Tools (under 🔨) show up in the interface, you can ask Claude to use them. For example: "Could you use the math tool to add 23 and 19?". Claude should invoke the tool and show the result generated by the MCP server.

### For Local Development

If you'd like to iterate and test your MCP server, you can do so in local development.

- For the Homepage URL, specify `http://localhost:8788`
- For the Authorization callback URL, specify `http://localhost:8788/callback`
- Note your Client ID and generate a Client secret.
- Create a `.dev.vars` file in your project root with:

```
ACCESS_CLIENT_ID=<your client id>
ACCESS_CLIENT_SECRET=<your client secret>
ACCESS_TOKEN_URL=<your Access for SaaS token url>
ACCESS_AUTHORIZATION_URL=<your Access for SaaS authorization url>
ACCESS_JWKS_URL=<your Access for SaaS JWKS url>
COOKIE_ENCRYPTION_KEY=COOKIE_ENCRYPTION_KEY
```

#### Develop & Test

Run the server locally to make it available at `http://localhost:8788`
`wrangler dev`

To test the local server, enter `http://localhost:8788/mcp` into Inspector and hit connect. Once you follow the prompts, you'll be able to "List Tools".

#### Using Claude and other MCP Clients

When using Claude to connect to your remote MCP server, you may see some error messages. This is because Claude Desktop doesn't yet support remote MCP servers, so it sometimes gets confused. To verify whether the MCP server is connected, hover over the 🔨 icon in the bottom right corner of Claude's interface. You should see your tools available there.

#### Using Cursor and other MCP Clients

To connect Cursor with your MCP server, choose `Type`: "Command" and in the `Command` field, combine the command and args fields into one (e.g. `npx mcp-remote https://<your-worker-name>.<your-subdomain>.workers.dev/mcp`).

If your MCP client cannot complete OAuth for a remote server directly, use `mcp-remote` as a local STDIO adapter.

You can connect your MCP server to other MCP clients like Windsurf by opening the client's configuration file, adding the same JSON that was used for the Claude setup, and restarting the MCP client.

## How does it work?

#### OAuth Provider

The OAuth Provider library serves as a complete OAuth 2.1 server implementation for Cloudflare Workers. It handles the complexities of the OAuth flow, including token issuance, validation, and management. In this project, it plays the dual role of:

- Authenticating MCP clients that connect to your server
- Managing the connection to Access's OAuth services
- Securely storing tokens and authentication state in KV storage

#### Stateless MCP

The MCP SDK v2 server uses a stateless Streamable HTTP handler, providing:

- A fresh MCP server instance for each request
- Access to authenticated user information via `getMcpAuthContext()`
- Support for conditional tool availability based on user identity

#### MCP Remote

For clients that do not support remote MCP servers or OAuth directly, `mcp-remote` runs as a local STDIO adapter. It:

- Bridges local STDIO clients to the remote Streamable HTTP endpoint
- Opens the browser-based OAuth flow
- Forwards MCP requests and responses between the client and server
