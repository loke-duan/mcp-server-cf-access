# 训记 MCP 服务

基于 **Cloudflare Workers** 托管、使用 **Cloudflare Access for SaaS（OIDC）** 认证的第三方训记远程 MCP 服务。让支持远程 MCP 的 AI 客户端通过工具读取训记数据，并在用户确认后写入身体指标或修改 Agent 训练模板。

本项目按截至 **2026-10-23** 整理的训记 Open API 文档，对接 **训练、饮食、身体数据、个人模板** 四个领域。各领域当前支持的操作见下表；这不代表已实现官方文档中的所有接口。

> 这是自行部署在 Cloudflare 上的第三方集成，不是训记官方运营的 MCP 服务。“Access for SaaS”指登录认证配置，运行实例及训记凭证由部署者管理。

## 已实现的功能

| 领域 | 当前能力 | MCP 工具 |
| --- | --- | --- |
| 训练 | 按日期读取训练；可包含 RPE、备注、未完成组、递减组及可导出的心率摘要 | `xunji_get_training` |
| 饮食 | 按日期读取饮食记录；默认包含食物、份量及接口提供的营养明细 | `xunji_get_food` |
| 身体数据 | 按日期范围和类型查询，支持分页；预检并确认后新增或更新身体指标 | `xunji_get_body`、`xunji_preview_body`、`xunji_commit_body` |
| 个人模板 | 同步 Agent 专属文件夹；预览并确认后新建、更新、删除其中的模板或修改文件夹显示名称 | `xunji_sync_templates`、`xunji_preview_templates`、`xunji_apply_templates` |

当前共有 **8 个训记业务工具**。原示例中的 `add` 加法工具仍保留；图像生成演示仅在满足代码中的邮箱条件时注册，均不属于训记功能。

当前尚未封装的接口包括：训练写回、官方训练计划查询、饮食写回、食物搜索、自定义食物及饮食模板操作。身体数据没有删除工具。

### 写入确认与限制

身体数据按 `日期 + 指标类型` 新增或覆盖。写入流程为：

1. 调用 `xunji_preview_body`，由训记接口执行 `dry_run`。
2. 向用户展示返回的 `res.summary`、日期、指标、数值和单位，等待明确确认。
3. 使用相同记录和 `client_request_id` 调用 `xunji_commit_body`。

体重单位为 kg、体脂率为 %、围度为 cm。腰围字段沿用官方接口的历史拼写 **`weist`**。

模板修改先同步最新状态，再检查范围、容量和版本。限制为 **1 个 Agent 专属文件夹、14 个有效模板、每模板 15 个动作、每动作 20 组**。最终提交前会再次检查；确认后的相同请求重试则复用原 `mutation_id`，交由训记服务端去重。

模板工具不修改 Agent 文件夹之外的模板，不移动、分享或删除文件夹，也不自动重建已删除的文件夹。文件夹改名需要最新版本号；文件夹和模板名称只允许中文、英文字母、数字及普通空格，文件夹名最多 32 个字符。

新建模板使用公开 `movements` 结构。编辑时可保留原生 `movement` 数组及 `rules`，但必须能明确校验每个动作的 `sets` 数组；无法识别的原生结构会被拒绝，不会猜测转换或静默截断。

身体及模板的确认提交均需 **15 分钟有效的预览令牌**，令牌绑定准确的内容和请求 ID。内容变化或令牌过期后，需要重新预览并取得确认。令牌校验用于防止预览与提交不一致；客户端仍须遵守“展示摘要并等待用户确认”的交互规则。

## 架构与认证

- **Cloudflare Workers**：托管 HTTP 服务，提供 `/mcp` Streamable HTTP 端点。
- **Cloudflare Access for SaaS**：作为上游 OIDC 身份提供方，完成登录和访问控制。
- **Workers OAuth Provider**：向 MCP 客户端提供 OAuth 授权、令牌及客户端注册端点。
- **训记 Open API**：使用保存在 Worker 运行时的独立 API Key，访问各领域官方接口。
- **Cloudflare KV（`OAUTH_KV`）**：保存 OAuth 状态及令牌相关数据，并保存模板请求的哈希指纹以辅助幂等重试。

MCP 服务与 skill 分工不同：**skill 提供操作说明，MCP 工具执行实际 API 请求**。仅安装 skill 不会自动提供工具或配置凭证。


### App 原始 skill 文档

仓库中的 [xunji_skill.md](./xunji_skill.md) 保存了从训记 App 导出的原始 skill／Open API 说明，合并包含训练、饮食、身体和 Agent 个人模板四个部分，作为本项目实现和后续维护的接口参考。文档保留了原有说明结构，密钥值已替换为环境变量引用：

| 变量名 | 对应凭证 |
| --- | --- |
| `XUNJI_TRAIN_API_KEY` | 训练数据 Key |
| `XUNJI_FOOD_API_KEY` | 饮食数据 Key |
| `XUNJI_BODY_API_KEY` | 身体数据 Key |
| `XUNJI_TEMPLATE_API_KEY` | Agent 个人模板 Key |
| `XUNJI_FOOD_SEARCH_API_KEY` | 食物搜索的独立 Key；用于文档中的搜索接口示例 |

`${XUNJI_…_API_KEY}` 表示需要由安全运行环境提供的值，不是可直接使用的密钥，也不会因文档被加载就自动注入。使用本 MCP 服务时，将已实现功能所需的 Key 配置到 Worker 运行时 Secrets。

原始 skill 描述的官方接口范围比当前 MCP 工具更广；例如食物搜索已有文档，但尚未实现对应工具，因此现在无需为本服务配置食物搜索 Key。该文档中的操作指引也不代表用户已授权读取或写入数据，执行时仍须遵守实际工具和确认流程。

### 适用范围

当前是 **单个训记账号的个人实例**：同一 Worker 中配置一组个人训记 Key，所有被 Cloudflare Access 策略放行的用户共用这组凭证。因此应仅允许本人或明确受信任的用户登录。本项目没有实现“每个登录用户绑定各自训记账号”的多租户凭证管理。

## 部署与配置

### 1. 准备 Cloudflare 资源

将仓库导入 Cloudflare Workers，或克隆后使用 Wrangler 部署。部署到自己的账号时，应检查 `wrangler.jsonc`：

- Worker 名称与实际项目一致。
- 创建自己的 KV namespace，并将其 ID 绑定为 **`OAUTH_KV`**；不要直接复用仓库中的实例 ID。
- 保留所需的运行时兼容配置。仓库中的 `AI` 绑定用于遗留图像演示，训记工具本身不调用图像模型。

在 Cloudflare Access 中配置 **Access for SaaS OIDC 应用**及登录策略。生产环境回调 URL 为：

```text
https://<worker-name>.<subdomain>.workers.dev/callback
```

本地开发时可另配 `http://localhost:8788/callback`。

### 2. 配置 Worker 运行时 Secrets

在 Cloudflare 控制台进入：

**Workers & Pages → 对应 Worker → Settings → Variables and Secrets**

类型选择 **Secret**，保存后点击 **Deploy／部署**。这里是 Worker 的运行时配置，**不是 Builds 区块中的 Variables and secrets**；构建密钥不会自动提供给正在运行的 API 工具。

认证所需配置：

| Secret | 内容 |
| --- | --- |
| `ACCESS_CLIENT_ID` | Access for SaaS 的 Client ID |
| `ACCESS_CLIENT_SECRET` | Access for SaaS 的 Client secret |
| `ACCESS_TOKEN_URL` | OIDC Token endpoint |
| `ACCESS_AUTHORIZATION_URL` | OIDC Authorization endpoint |
| `ACCESS_JWKS_URL` | OIDC JWKS／公钥地址 |
| `COOKIE_ENCRYPTION_KEY` | 自行生成的高强度随机密钥，用于 Cookie 与授权状态保护 |

训记业务凭证分别在训记 App 中申请：

| Secret | 用途 |
| --- | --- |
| `XUNJI_TRAIN_API_KEY` | 训练记录查询 |
| `XUNJI_FOOD_API_KEY` | 饮食记录查询 |
| `XUNJI_BODY_API_KEY` | 身体数据查询及写入 |
| `XUNJI_TEMPLATE_API_KEY` | Agent 个人模板同步及修改 |

可以只配置需要使用的领域；缺少对应 Key 时，该工具会返回配置错误。Key 的值只填原始密钥，不要额外添加 `Bearer ` 前缀，不要写入仓库、聊天消息、工具参数或 `wrangler.jsonc`。

也可以通过命令行交互式设置，例如：

```sh
npx wrangler secret put XUNJI_TRAIN_API_KEY
```

网页配置与命令行配置任选其一，不要求同时操作。

### 3. 部署代码

Cloudflare Workers Builds 可以连接此 GitHub 仓库，提交代码后自动构建部署；也可以本地执行：

```sh
npm install
npm run deploy
```

确认最新构建成功，且对应版本已部署到生产环境。仅创建或保存版本，并不等于该版本已经承接线上请求。

## 连接 MCP 客户端

使用支持远程 MCP 与 OAuth 的客户端，添加服务器地址：

```text
https://<worker-name>.<subdomain>.workers.dev/mcp
```

注意带上 **`/mcp`**。服务根路径不是 MCP 端点。按客户端流程完成 Cloudflare Access 登录和授权，然后确认工具列表中出现上文的 8 个训记工具。

服务端新增工具后，客户端可能需要刷新工具列表、重新连接或新建会话。只有应用名称出现在会话里，并不代表工具已完成加载；客户端连接成功与训记 API Key 有效也是两项独立检查。

可用于测试的自然语言请求：

- “读取我 2026 年 10 月 22 日的训练记录，包括备注和 RPE。”
- “查看我 2026 年 10 月 22 日的饮食明细。”
- “查询我 2026 年 10 月 1 日到 22 日的体重和腰围。”
- “查看我的 Agent 个人训练模板。”

写入请求应先得到预览，再由用户确认。排查连接问题时，优先使用只读查询，不要用真实数据写入测试连接。

## 本地开发与验证

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

仅在本地 `.dev.vars` 中填写开发凭证，勿提交到 Git。仓库已声明 `secrets.required`：本地调试某个训记领域时，还需将相应 Secret **名称**加入该列表，以便 Wrangler 加载本地变量；列表中不要填写密钥值。生产实例是否已配置 Key，以 Worker 运行时 Secrets 为准。

验证命令：

```sh
npm test
npm run type-check
npx wrangler deploy --dry-run
```

测试需要 Node.js **22.18+ 或 24+**。截至 2026-10-23，项目包含 **27 项通过的测试**，覆盖训练、饮食、身体及模板操作，并包含真实 Workers／workerd 运行时下的模拟接口测试。测试使用合成数据，不读取或修改真实训记记录。构建与测试通过，不等于所有线上凭证、API 权限及客户端连接均已验证。

## 数据处理与错误处理

- API Key 使用各自的 Worker Secret，只通过请求头发送给代码中固定的对应训记 HTTPS 接口。
- 请求使用 Workers 支持的 `redirect: "manual"`，显式拒绝重定向，避免凭证被转发。
- 支持 JSON 与 gzip 响应，包括压缩响应头缺失时按 gzip 字节特征解压。
- 工具不输出请求密钥、原始异常详情或上游错误响应正文，返回分阶段错误提示。
- 身体及模板的预览内容不持久化到服务器；预览令牌为 HMAC 签名。`OAUTH_KV` 中额外保存的模板派发指纹为哈希值，保留 24 小时，不包含模板内容、身体记录或 Key 原文。OAuth 自身仍使用该 KV 保存认证状态及令牌相关数据。
- 查询结果会进入调用方 AI 客户端的会话上下文；后续保存及处理受该客户端的数据政策影响。
- 不自动重试失败请求。训练轻量读取通常间隔 15 秒、完整读取 30 秒；饮食及身体相关读取按接口限频执行，遇限频优先遵守返回的等待时间。模板操作同样遵守服务端限频。
- 饮食查询范围按接口文档限制在过去一年至未来三个月；当前饮食工具一次读取一天。
- 模板版本冲突时先同步最新状态，展示差异并重新取得确认；写入结果不明时保留原请求 ID，不要用新 ID 盲目重试。

### 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 缺少 `XUNJI_*_API_KEY` | 是否配置在正确 Worker 的运行时 Secrets、名称是否正确、是否已经 Deploy |
| 只有 `add`，没有训记工具 | 生产版本是否最新、客户端是否刷新工具列表、是否连到了正确实例的 `/mcp` |
| 添加应用或 OAuth 登录失败 | 服务器地址、Access 应用及策略、回调 URL、OIDC 端点配置；当前实现不能保证所有客户端均能连接 |
| API Key 无效或需要会员 | 在训记 App 核对对应领域 Key 和账号 API／VIP 权限 |
| 网络、解压或 JSON 错误 | 按错误中的请求阶段排查 Worker 出站连接和上游响应，不要反复修改无关密钥 |
| 预览令牌过期或内容不一致 | 重新预览相同目标，并再次获得用户确认 |

## 项目来源

本项目由 Cloudflare Access OAuth MCP 示例改造而来，新增训记工具、写入确认、错误处理和测试。保留原有 OAuth 登录架构；README 已围绕训记用途整理，遗留演示代码仍以仓库实际实现为准。
