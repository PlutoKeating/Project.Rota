# 上手与部署

## 环境与本地运行

Node.js 24+、Corepack、项目固定版本 pnpm；Python 仅用于 LinkML 生成。

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
cp .dev.vars.example .dev.vars
pnpm data:dev   # 第一个终端：SQLite / 设置 / 文件
pnpm dev        # 第二个终端：http://localhost:5173
```

本地 `.dev.vars` 同时设置 `APP_ENV=development` 与 `AUTH_DEV_BYPASS=true` 才使用本地管理员。生产不允许绕过。两个文件中的数据服务凭据须一致；真实环境文件与 `.data/` 均不提交。生产数据库与原件全部在 ECS，不依赖 D1、KV 或 R2。

## 验证

`pnpm check` 执行类型检查、业务/认证集成测试与独立数据服务测试；`pnpm build` 构建 Worker 与前端。

## 新部署

1. 按 [数据服务部署](../storage/docs/QUICK_START.md) 创建独立容器、持久目录、HTTPS 入口和备份。启动自动运行 SQLite 迁移。
2. 核对 `wrangler.jsonc` 的账户和 Worker 名称；唯一生产域名为 `rota.plutokeating.beer`，`APP_ORIGIN` 固定为 `https://rota.plutokeating.beer`。配置通过 `routes` 的 `custom_domain: true` 绑定该域名，并通过 `workers_dev: false`、`preview_urls: false` 关闭临时入口与版本预览 URL。保留 Workers AI 绑定（用于默认截图模型），不创建 D1/KV/R2。
3. 向 `https://id.plutokeating.beer/` 登记授权码 + PKCE 客户端 `project-rota`；登录/注册完成后的授权回调仅保留 `https://rota.plutokeating.beer/api/auth/callback`，删除旧临时域名回调。若客户端配置应用主页或允许来源，统一为 `https://rota.plutokeating.beer`。issuer 保留末尾 `/`。公共客户端无需密码；机密客户端可设置 `OIDC_CLIENT_SECRET`。
4. 通过私有操作核验 OIDC subject，插入 `admin_user` 为启用 owner。不要把真实身份或账号清单提交仓库。
5. 设置 Worker Secrets 并部署：

```bash
pnpm exec wrangler secret put DATA_SERVICE_URL
pnpm exec wrangler secret put DATA_SERVICE_AUTHORIZATION
pnpm deploy
```

DATA_SERVICE_URL 是私有 HTTPS 基础 URL；DATA_SERVICE_AUTHORIZATION 是完整 Authorization 头，必须与容器 DATA_AUTHORIZATION 一致。凭据仅供 Worker 到数据服务，不能发送浏览器。`pnpm deploy` 执行检查、构建和发布；数据库迁移由数据服务启动执行。

域名切换必须同步更新身份服务客户端的登记配置；仓库部署不会自动修改身份服务。发布前确认自定义域名的 DNS/TLS 已就绪，发布后核对 `/api/auth/login` 的 `redirect_uri` 并完成一次真实登录/注册返回流程。旧域名 Cookie 不会迁移，用户需要在新域名重新登录。本次无需依赖、Secret 或数据库迁移变更。

## 自动部署

Cloudflare Worker → Settings → Builds → Connect，连接 GitHub main。构建命令 `pnpm run check && pnpm run build`，部署命令 `pnpm exec wrangler deploy`，Node 24；安装命令 `corepack enable && pnpm install --frozen-lockfile`。构建令牌仅需 Worker 发布权限，不需要 D1。Wrangler OAuth 不一定允许配置 Builds；此时需控制台连接。不要复制 OAuth token 到 CI。

GitHub Validate 检查与构建通过后，可通过受限 SSH 部署数据容器：设置仓库变量 `ECS_DEPLOY_ENABLED=true`，以及 Secrets `ECS_HOST`、`ECS_PORT`、`ECS_USER`、`ECS_DEPLOY_KEY`、`ECS_KNOWN_HOSTS`。服务器上的专用公钥必须配置 forced command 和 restrict；流水线通过 SSH 标准输入传送完整 Git bundle，服务器验证 bundle 与 40 位提交 SHA 一致，不依赖 ECS 直连 GitHub 拉取；只部署通过该次检查的版本，执行备份、构建、镜像预检、启动及健康检查。私有脚本与实际主机信息不提交。PR 不运行部署。部署服务和 Worker 的协议/迁移须向后兼容，避免两个流水线先后顺序造成中断。

推送后分别核对 GitHub 与 Cloudflare Builds 成功记录，再验证健康、匿名 401、登录及业务操作。手动部署成功不等于自动部署已验证。

## 业务与回滚

登录后创建学期、人员和组织成员、课程、任务/班次，再试排与确认，查看公平账本、导出 CSV。导入课表先人工确认再应用。截图识别需启用视觉模型。

Worker 可回滚版本；数据容器可回滚镜像，但迁移不会自动撤销。重大迁移前保存 SQLite 在线快照及原件，并测试恢复。实际操作与凭据留在私有记录。

## 模型生成

```bash
python3 -m venv .venv
.venv/bin/pip install linkml
LINKML_BIN=.venv/bin/linkml bash scripts/gen.sh
```

已部署迁移不得改写，领域变更另建增量迁移，认证运行时表与约束不能由生成器覆盖。

## 模型密钥与浏览器验证

粘贴模型密钥前，给 Worker 配置 `PROVIDER_ENCRYPTION_KEY` Secret，值为密码学随机生成的 32 字节 base64 字符串。通过安全标准输入传给 `wrangler secret put PROVIDER_ENCRYPTION_KEY`，不要把值放入命令参数或仓库。此密钥必须保存在私有备份中；已有密文时不可直接更换，否则需要先解密重加密或重新录入所有模型密钥。缺少该 Secret 时加密写入返回明确错误，旧 Worker Secret 名称配置仍可使用。

模型密钥配置本身不需要数据库迁移（Agent 导入升级见下文）。models.dev 目录由 Worker 请求固定 HTTPS 地址；离线时保留上次成功缓存，已有模型不依赖目录可用性。

`pnpm exec playwright install chromium` 安装测试浏览器。在隔离本地数据服务和 `pnpm dev` 已启动时，`pnpm test:browser` 检查创建工作、分配、嵌套焦点、模型配置和响应式布局。该命令会写入测试数据，不要将测试 baseURL 指向生产。


### 模型配置草稿与排序

模型草稿版本引入 @dnd-kit/core、sortable、utilities（锁文件已更新），安装后按现有检查/构建/发布流程部署 Worker。数据服务已存在 app_kv，无需新迁移、Secret 或部署参数。浏览器测试新增草稿无写入、拖动/键盘排序、保存失败恢复和整页保存验证。

模型诊断更新无需新增依赖、Secret 或迁移，继续使用 `pnpm check && pnpm build` 和现有部署流程。首次加载会重建 v2 模型目录缓存，并校验 OpenCode Go 官方型号；供应商目录不可达时界面会说明回退状态。

## 浏览器 Agent 导入升级

先备份并更新数据服务，使 `0005_browser_agent_import.sql` 应用，再构建/发布 Worker 和前端。没有新增 ECS 计算服务、容器或密钥配置；模型仍在管理后台配置，浏览器不接收密钥。WASM、PDF Worker 和格式读取库由 Vite 打包，同源加载，不依赖公共 CDN。

本地专项浏览器验证：`pnpm test:agent-browser` 自动启动独立的 5178 静态服务，拦截全部 API，仅使用合成测试资料，不连接生产数据。普通业务浏览器测试仍按原流程启动隔离数据服务。

`pnpm gen` 输出当前领域参考 DDL 至 `schema/rota.current.sql`，不会覆盖 `migrations/0001_init.sql`；增量迁移需单独维护。运行时批次/锁表由增量 SQL 维护，与既有认证表策略一致。

本机已登录 gcloud 时，可使用 `pnpm test:agent-vertex /private/input.zip /private/output /private/snapshot.json` 做隔离的 Vertex 真实模型验收；无需生产环境变量。可选项目/位置配置与凭据边界见 [Agent 导入说明](AGENT_IMPORT.md#真实模型隔离验收)。

## 人员对象执行器升级

新版将导入工具协议改为 discover/person/verify/reconcile，前端与 Worker 必须同步发布；既有0005数据库迁移继续适用，无新增Secret或运行依赖。旧版草稿和原件保留查看，重新选择原材料创建新版批次，不运行旧 pending 工具。发布前执行 `pnpm check && pnpm test:agent-browser && pnpm build`。`pnpm test:agent-person` 可单独检查对象并行、隔离与恢复。
