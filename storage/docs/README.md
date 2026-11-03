# 数据服务

Node.js 24 内置 `node:sqlite` 和 HTTP 服务，不依赖第三方 npm 包。业务数据库、管理员、登录会话、设置与课表原件均持久化到 `DATA_DIR`。生产由独立 ECS 容器运行，Worker 通过带认证的 HTTPS 访问。真实部署地址、凭据、宿主机配置仅存私有运维记录。

本地启动见 [QUICK_START](QUICK_START.md)，协议和事务边界见 [ARCHITECTURE](ARCHITECTURE.md)。

## 浏览器 Agent 导入持久化

`0005_browser_agent_import.sql` 增加独立课表/作息/实际占用、人员班级专业，以及导入批次、相关数据租约、修订号和事务断言。现有 `/query` 单事务执行 Worker 生成的参数化 SQL；锁触发器统一阻止其他 CRUD 修改已锁记录，错误标识 `agent_locked` 由 Worker 转为 409。数据库不运行 Agent，不解包、不读取 Office，也不保存新导入的原件或模型对话。

迁移随既有镜像的 `migrations/` 打包并在启动时执行；没有新增镜像依赖或环境变量。应先应用迁移再更新应用。原件与草稿清理由浏览器完成，正式批次关联和审计持久保留。详见根目录 `docs/AGENT_IMPORT.md`。
