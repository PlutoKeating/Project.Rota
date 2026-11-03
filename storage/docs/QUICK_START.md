# 启动与部署

在仓库根目录：

```bash
cp .env.example .env
pnpm data:dev
```

`.env` 中 `DATA_AUTHORIZATION` 必须与 Worker `.dev.vars` 的 `DATA_SERVICE_AUTHORIZATION` 一致。默认监听 loopback:8080，数据保存在忽略的 `.data/`。生产使用独立生成的强凭据，不使用示例值。

```bash
docker build -f storage/Dockerfile -t rota-data:local .
```

镜像构建时规范化代码只读权限，兼容私有部署环境的 umask 077。容器以 UID 1000 运行。事先创建仅该用户可写的持久目录，挂载 `/data`；通过 env_file 注入 `DATA_AUTHORIZATION`，可设置 `BASE_PATH`（默认空），发布端口仅监听宿主机 loopback。镜像内置迁移，启动时自动执行。实际 compose、隧道、SSH 与备份策略保留在私有部署配置中。

运行 `pnpm check` 包含 HTTP 认证、事务失败回滚、DELETE RETURNING、设置持久化、文件上限/路径保护和 Worker 适配器测试。

在线快照：`node storage/backup.mjs /data/snapshot.sqlite`。更新前备份，保留旧镜像和卷；回滚镜像不会撤销数据库迁移。
