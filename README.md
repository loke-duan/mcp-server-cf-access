# 训记只读 MCP 服务

这是一个部署在 **Cloudflare Workers**、使用 **Cloudflare Access for SaaS（OIDC）** 认证的第三方训记远程 MCP 服务。它只读取训练、饮食和身体数据，不提供任何写入、同步或模板功能。

> 本项目不是训记官方运营的 MCP 服务。部署者需自行负责 Cloudflare 配置、训记 API Key 和访问策略。

## 功能范围

服务只注册以下三个业务工具：

| 领域 | MCP 工具 | 能力 |
| --- | --- | --- |
| 训练 | `xunji_get_training` | 按指定日期读取训练；可选完整数据，包括 RPE、备注、未完成组、递减组及心率摘要 |
| 饮食 | `xunji_get_food` | 按明确日期范围读取食物、份量和接口提供的营养明细 |
| 身体数据 | `xunji_get_body` | 按日期范围和指标类型读取身体数据，支持分页 |

三个工具均声明为只读、非破坏性、幂等操作。

明确不支持：

- 训练、饮食或身体数据的新增、更新、删除和写回
- 个人训练模板读取、同步或修改
- 官方训练计划查询
- 食物搜索、自定义食物和饮食模板
- 写入预览、确认令牌、mutation 或自动同步

## 数据接口

### 训练

`xunji_get_training` 调用训记训练读取接口，输入：

```json
{
  "datestr": "2026-10-22",
  "include_full_data": false
}
```

`datestr` 必须是 `YYYY-MM-DD`。需要 RPE、备注、未完成组、递减组或心率摘要时，将 `include_full_data` 设为 `true`。

### 饮食

`xunji_get_food` 输入：

```json
{
  "start_date": "2026-10-20",
  "end_date": "2026-10-22",
  "include_detail": true
}
```

开始日期不能晚于结束日期。查询范围限制为调用当日之前一年到之后三个月；单日查询时传入相同的开始和结束日期。

### 身体数据

`xunji_get_body` 输入：

```json
{
  "start_date": "2026-10-01",
  "end_date": "2026-10-22",
  "types": ["weight", "bodyfat"],
  "include_latest": true,
  "include_records": true,
  "limit": 500,
  "offset": 0
}
```

省略 `types` 时读取全部指标。`records` 按日期倒序返回；`latest` 是各类型最新记录；`by_type` 按类型归组。体重单位为 kg，体脂率为 %，围度为 cm。腰围字段沿用官方历史拼写 `weist`。

身体指标属于个人健康数据，调用方应谨慎描述趋势，不应据此进行医疗诊断。

## 架构与认证

- **Cloudflare Workers** 托管 `/mcp` Streamable HTTP 端点。
- **Cloudflare Access for SaaS** 提供 OIDC 登录和访问控制。
- **Workers OAuth Provider** 向 MCP 客户端提供授权、令牌和客户端注册端点。
- **Cloudflare KV（`OAUTH_KV`）** 保存 OAuth 状态和令牌数据。
- 三个独立的训记 Worker Secret 分别访问固定的官方读取接口。

当前是单个训记账号的个人实例：同一 Worker 配置一组个人训记 Key，所有被 Access 策略放行的用户共用这组凭证。因此只应允许本人或明确受信任的用户登录。

## API 文档快照

[xunji-all-skills_20261023.md](./xunji-all-skills_20261023.md) 是从训记 App 导出的完整 skill／Open API 说明快照，包含本项目没有实现的写入和模板接口。保留该文件只为核对官方接口，不表示这些能力已被实现或授权。

本项目只需要：

| Secret | 用途 |
| --- | --- |
| `XUNJI_TRAIN_API_KEY` | 训练记录查询 |
| `XUNJI_FOOD_API_KEY` | 饮食记录查询 |
| `XUNJI_BODY_API_KEY` | 身体数据查询 |

不需要模板 Key 或食物搜索 Key。

## 部署配置

### Cloudflare 资源

将仓库导入 Cloudflare Workers，或使用 Wrangler 部署。部署前检查 `wrangler.jsonc`：

- Worker 名称与实际项目一致。
- 创建自己的 KV namespace，并将其绑定为 `OAUTH_KV`。
- 不要复用仓库示例中的 KV namespace ID。

在 Cloudflare Access 中配置 Access for SaaS OIDC 应用和登录策略。生产回调地址为：

```text
https://<worker-name>.<subdomain>.workers.dev/callback
```

本地开发可使用 `http://localhost:8788/callback`。

### Worker Secrets

认证配置：

| Secret | 内容 |
| --- | --- |
| `ACCESS_CLIENT_ID` | Access for SaaS Client ID |
| `ACCESS_CLIENT_SECRET` | Access for SaaS Client secret |
| `ACCESS_TOKEN_URL` | OIDC Token endpoint |
| `ACCESS_AUTHORIZATION_URL` | OIDC Authorization endpoint |
| `ACCESS_JWKS_URL` | OIDC JWKS endpoint |
| `COOKIE_ENCRYPTION_KEY` | 高强度随机密钥 |

训记配置：

```text
XUNJI_TRAIN_API_KEY
XUNJI_FOOD_API_KEY
XUNJI_BODY_API_KEY
```

Key 只填写原始值，不添加 `Bearer ` 前缀，不要写入仓库、聊天、工具参数或 `wrangler.jsonc`。

### 部署

```sh
npm install
npm run deploy
```

MCP 地址：

```text
https://<worker-name>.<subdomain>.workers.dev/mcp
```

连接并完成 Cloudflare Access 登录后，工具列表中应当只出现三个训记工具。

## 本地开发与验证

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

验证：

```sh
npm test
npm run type-check
npx wrangler deploy --dry-run
```

测试使用合成数据，不读取或修改真实训记记录。

## 安全和错误处理

- API Key 只从 Worker Secret 获取并通过 `Authorization: Bearer` 请求头发送。
- 请求只发送至代码中固定的训记 HTTPS 读取接口。
- 使用手动重定向模式并拒绝上游重定向，避免转发凭证。
- 支持 JSON 和 gzip 响应，包括缺少压缩响应头的 gzip 数据。
- 设置请求超时和 10 MiB 解压上限。
- 不输出 API Key、上游原始异常或私人错误正文。
- 不自动重试失败请求；遇到限频时遵守接口返回的等待时间。
- 查询结果会进入调用方 AI 客户端的会话上下文，后续保存与处理受该客户端的数据政策约束。

## 开发与致谢

本仓库基于 Cloudflare 官方示例项目开发，实现了部分训记（Xunji）MCP 服务能力。

- 感谢 Cloudflare 提供基础设施和示例项目。
- 感谢训记提供 API 接口和原始 skill 文档。
- 感谢 G老师（ChatGPT）提供技术支持；本仓库代码均由 G老师根据项目维护者提出的需求编写，项目维护者负责配置、部署和实际使用验证。

## 参考资料

- [Cloudflare：Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [训记 App skill／Open API 说明（2026-10-23）](./xunji-all-skills_20261023.md)
