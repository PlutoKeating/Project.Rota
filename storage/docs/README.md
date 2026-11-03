# 数据服务

Node.js 24 内置 `node:sqlite` 和 HTTP 服务，不依赖第三方 npm 包。业务数据库、管理员、登录会话、设置与课表原件均持久化到 `DATA_DIR`。生产由独立 ECS 容器运行，Worker 通过带认证的 HTTPS 访问。真实部署地址、凭据、宿主机配置仅存私有运维记录。

本地启动见 [QUICK_START](QUICK_START.md)，协议和事务边界见 [ARCHITECTURE](ARCHITECTURE.md)。
