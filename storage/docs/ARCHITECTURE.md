# 数据服务架构

`server.mjs` 初始化 SQLite WAL、外键与 busy_timeout，依序执行 `migrations/*.sql`，在 `service_migrations` 记录已应用迁移。每次迁移独立事务，失败则拒绝启动。`app_kv` 保存应用设置和配置版本，文件使用同一持久卷的 `rota/imports/` 目录。

所有端点包括健康检查都验证完整 Authorization 头，以常量时间比较。容器只应绑定宿主机 loopback，前置 HTTPS 隧道；不得把 SQL 服务暴露给浏览器或公开分发凭据。

- `POST <base>/query`：`{statements:[{sql,params}]}`，返回 `{success,results,meta}` 数组。每次请求使用一个 BEGIN IMMEDIATE 事务，任一语句失败全部回滚；仅接受查询和数据修改语句，不接受 DDL、PRAGMA 或显式事务控制。凭据持有者具有全库数据权限。
- `GET/PUT <base>/kv/<key>`：读取 `{value:string|null}`，或直接写入文本；SQLite 持久化。
- `PUT/GET/DELETE <base>/imports/<id>/<filename>`：认证文件访问，单文件最大 5 MiB，拒绝路径穿越，临时文件写入后原子重命名，不列目录。
- `GET <base>/health`：查询 SQLite，成功返回 `{ok:true}`。

Worker 的 `remote-data.ts` 保持领域层 prepare/bind/first/all/run/batch 接口；类型名称 D1Database 仅作为兼容接口，不代表生产存在 Cloudflare D1 绑定。CONFIG 同样是 SQLite 设置适配器。请求禁止跟随重定向、超时 30 秒。生产必须 HTTPS，本地 development 允许 loopback HTTP。数据库错误只返回约束标记，不返回 SQL/参数。

SQLite 同步执行令每个请求的事务不会与其他请求交错；跨 HTTP 请求的业务流程并非全局事务。数据库与文件写入仍非原子事务，上传后业务写入失败由 Worker 尽力清理。单进程服务适合当前单组织规模，跨区域逐条查询有延迟，不应据此声称高并发性能。

备份必须使用 `backup.mjs` 的 SQLite 在线快照后归档原件，不可直接复制活动 WAL 数据库。恢复时停止容器，将快照恢复为 `rota.sqlite`，同时恢复 `rota/` 文件树；启动后检查 integrity_check、foreign_key_check、管理员和导入记录。备份应另行复制到独立存储，同盘快照不覆盖整机故障。

## 浏览器 Agent 导入持久化

`0005_browser_agent_import.sql` 增加独立课表/作息/实际占用、人员班级专业，以及导入批次、相关数据租约、修订号和事务断言。现有 `/query` 单事务执行 Worker 生成的参数化 SQL；锁触发器统一阻止其他 CRUD 修改已锁记录，错误标识 `agent_locked` 由 Worker 转为 409。数据库不运行 Agent，不解包、不读取 Office，也不保存新导入的原件或模型对话。

迁移随既有镜像的 `migrations/` 打包并在启动时执行；没有新增镜像依赖或环境变量。应先应用迁移再更新应用。原件与草稿清理由浏览器完成，正式批次关联和审计持久保留。详见根目录 `docs/AGENT_IMPORT.md`。

SQL 批事务在提交时校验外键（`defer_foreign_keys`），允许同批新增上级、迁移子记录及删除旧上级；最终悬空引用仍使整个事务回滚。
