# Worker

Hono 统一提供认证、业务 API、目录代理与模型网关。继续使用 ECS 数据服务的 SQL/KV 兼容接口，没有新增 Cloudflare 数据绑定或数据库迁移。

新增能力：`POST /work` 原子创建任务与重复班次；`POST /persons/import` 原子导入人员与部门关系；管理端 models.dev 目录、模型优先顺序与加密 API 密钥。

验证：`pnpm check`（类型、真实 SQLite 集成测试及数据服务测试），`pnpm build`。生产发布命令与密钥配置见根目录 docs/QUICK_START.md。

OpenCode Go/Zen 已内建真实客户端标识与稳定会话头适配；既有配置即时生效，无新增依赖、环境变量或迁移。


### 模型配置草稿与排序

整页模型配置由 GET/PUT `/admin/model-config` 提供，要求 owner。PUT 验证整份输入、加密新密钥后，在同一 SQLite batch 中比较版本并保存模型、顺序和审计；冲突或错误保留原配置。
