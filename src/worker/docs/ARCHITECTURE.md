# Worker 边界

- `/work` 在写入前验证日期、人数、部门和每次重复所在学期，单个 batch 提交 task、shift 与审计，失败不留下空任务。
- `/persons/import` 限制 1–300 人，必填姓名/学号；重复学号整批拒绝。人员、可选部门成员关系与审计一次提交。
- `llm/catalog.ts` 从固定 HTTPS models.dev/api.json 获取目录，按一小时缓存，支持手动刷新。刷新失败返回带 stale 标记的上次成功目录；首次失败返回可重试错误。未知 SDK 协议不出现在可选列表，不假设全部兼容 OpenAI。
- `llm/secrets.ts` 用独立 Worker Secret 中的 32 字节 base64 密钥执行 AES-GCM；每条密钥使用新的随机 12 字节 IV。密文存在 provider.params.encryptedKey，公开视图移除密文，只提供 hasKey。参数更新保留已有密文，不能通过 params 注入密文。旧 Worker Secret 名称配置兼容。
- `llm:order` 保存配置 ID 顺序。网关逐请求读取，跳过停用条目；图片输入跳过明确标记不支持图片的条目。明确指定 providerId 时使用指定模型。此版本没有跨供应商自动失败转移。
- 上游模型请求禁止重定向；错误不回显上游响应正文或请求 URL，以避免密钥被上游错误带回。连接测试与真实识别使用同一网关。

配置/API 仍要求 owner；普通业务仍允许 admin。密钥明文不得进入日志、审计、浏览器存储或公开响应。
