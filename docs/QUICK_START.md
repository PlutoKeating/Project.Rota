# 上手与部署

## 环境

Node.js 24+（真实 SQL 测试使用 `node:sqlite`），Corepack，项目固定版本 pnpm。Python 仅用于 LinkML 模型生成。

```bash
corepack enable
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm db:local
pnpm dev
```

打开 `http://localhost:5173`。本地 `.dev.vars` 同时设置 `APP_ENV=development` 与 `AUTH_DEV_BYPASS=true` 才会使用本地管理员；不要把这两个设置上传生产。Android/proot 中 workerd 可能受 mmap 限制，不能据此认定普通 Linux 环境也无法运行。

本地文件导入需要配置可用的 HTTPS 文件服务（见下文）。`.dev.vars` 与 `.env` 均忽略，不提交。

## 验证

```bash
pnpm check       # Worker/Client 类型检查与自动化测试
pnpm build       # Worker 与静态资源
```

测试包含实际 SQLite 的业务流程、并发排班、导入失败回滚、OIDC 验签与攻击输入、会话撤销、CSRF、权限和文件存储错误。

## 业务流程

登录后依次创建学期与节次、人员与组织成员、课程、任务与班次，试排并确认分配，在公平页查看历史分配，导出 CSV。课表也可上传 Excel/CSV/ICS/截图，先确认解析结果再应用。截图识别需在设置里启用视觉模型，可使用 Workers AI 或配置外部供应商的 Worker Secret。

## 新部署

1. 使用自己的 Cloudflare 账户创建 D1、KV，并替换 `wrangler.jsonc` 中对应账户和资源标识；设置 Worker 名称和公开 `APP_ORIGIN`。
2. 在身份提供方登记授权码 + PKCE 客户端，精确回调地址为 `APP_ORIGIN + /api/auth/callback`。issuer 必须与发现文档完全一致（包括末尾 `/`）。本项目使用公共客户端，不需要客户端密码；机密客户端可设置 `OIDC_CLIENT_SECRET`。
3. 初始化数据库，并通过私有 SQL 文件插入已核验 OIDC subject 的 `admin_user`，role 为 owner、enabled 为 1。不要把真实身份信息放进迁移或仓库。
4. 配置文件存储，设置 Secrets，部署。

```bash
pnpm exec wrangler d1 create rota
pnpm exec wrangler kv namespace create CONFIG
pnpm db:remote
# 按自己的部署资源修改 wrangler.jsonc 后：
pnpm exec wrangler secret put STORAGE_URL
pnpm exec wrangler secret put STORAGE_AUTHORIZATION
pnpm deploy
```

`pnpm deploy` 执行 check、build、远程迁移、Worker 发布。生产资源由服务端提供，不需要 R2。

## 文件存储协议

`STORAGE_URL` 为 HTTPS 基础 URL，`STORAGE_AUTHORIZATION` 为完整 Authorization 头值，两者都使用 Worker Secrets，不发送给浏览器。适配器访问 `<base>/imports/<id>/<encoded-filename>`：PUT 二进制，DELETE 原件。服务必须验证凭据、禁止目录列表、限制单文件 5 MiB，并提供持久化与备份。可使用标准 Nginx WebDAV PUT/DELETE 或等效服务。

私有生产地址、容器端口、SSH 信息和密钥不在此文档记录。

## GitHub 自动部署

1. GitHub 创建公开 `Project.Rota`，push 经检查的提交。
2. Cloudflare Worker → Settings → Builds → Connect，选择仓库和 `main`。
3. 构建命令：`pnpm run check && pnpm run build`。
4. 部署命令：`pnpm run db:remote && pnpm exec wrangler deploy`。
5. 构建镜像 Node 版本设为 24，使用 package.json 中的 pnpm 版本；如自动安装不识别 Corepack，安装命令设 `corepack enable && pnpm install --frozen-lockfile`。
6. 为构建令牌授予此 Worker 发布与 D1 迁移所需权限。运行时 Secrets 留在 Worker，不写进构建日志或 GitHub。
7. 推送后核对 GitHub Validate 与 Cloudflare Builds 的成功记录，再检查 `/api/health`、匿名业务接口 401、登录跳转和实际业务操作。

Wrangler OAuth 登录权限不一定包含 Workers Builds 配置权限，配置 API 返回 403 时需要控制台连接或具有该权限的用户 API token。不要把 Wrangler 的 OAuth token 复制到 CI。

## 模型生成

```bash
python3 -m venv .venv
.venv/bin/pip install linkml
LINKML_BIN=.venv/bin/linkml bash scripts/gen.sh
```

`0001_init.sql` 已部署后不得改写；领域模型变更必须另建增量迁移。认证运行时存储与数据库约束使用独立迁移，不由领域本体生成器覆盖。

## 回滚

Worker 可回滚到上一个版本，但数据库迁移不会随 Worker 回滚。迁移须兼容先前版本，重大变更前导出备份。文件存储独立备份；不要删除持久卷。具体生产操作与账号信息留在私有运维记录。
