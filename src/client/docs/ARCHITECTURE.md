# 前端架构

`AuthGate` 提供 Session context；`Layout` 负责固定页眉、导航、账号菜单、主题及独立滚动内容区。`QuickSearch` 搜索人员与任务。`App` 保留旧路由兼容，首页渲染 SchedulePage。

`Modal` 统一侧栏与对话框，使用 portal、顶层窗口栈、inert、焦点循环及关闭后恢复焦点。嵌套配置不得让底层窗口处理 Escape。

`WorkComposer` 只提交 `/work`，服务端原子创建任务和全部重复班次。班次候选始终请求 `/preview`；正式分配单独确认。批量预览显示整个任务当前各班次缺口和候选数量，确认时服务端逐次检查，预览不承诺最终人数。

`ModelsPage` 读取 `/admin/model-config` 快照，所有新增、启停、删除、密钥替换和排序仅写当前组件内存草稿。保存栏显示未保存状态，点击保存后一次 PUT 整页配置；失败保留草稿，放弃更改重新读取服务端。未应用的添加或密钥输入会阻止保存，避免漏存。保存期间禁用编辑。已有模型可随时测试已保存配置，测试按模型 ID 独立管理 pending/result，不使用全局 busy，不阻塞其他测试、编辑、排序、删除或保存。新增模型需先保存。测试结果留在对应卡片下，并注明测试时的已保存配置。密钥不进入浏览器持久化；API 只返回 hasKey。

排序使用 @dnd-kit 的 PointerSensor、KeyboardSensor、SortableContext 和 DragOverlay；仅 44px 抓手启动拖动，其他区域仍可滚动/选字。相邻条目用 280ms transform 弹性让位，放下动效同速；新草稿行用 220ms 入场。系统减少动态效果时取消空间动画。保留上移/下移按钮和中文读屏提示。beforeunload、hash 路由和管理 tab 切换在有草稿时提醒放弃。

页面状态与网络状态通过现有 useAsync 管理。日期范围保存在 sessionStorage；侧栏操作保留底层页面筛选和滚动上下文。明暗主题保存在 localStorage。没有引入新路由框架或组件框架。

## 人员对象导入

导入采用 ImportSession + m 个 PersonWorkspace。协调器分派来源并维护公共日历，子智能体只填写和复核本人的 A/B；默认3个人员并行，失败隔离、检查点恢复、已完成人员复用。全批完成后由唯一投影逻辑匹配身份，生成按学期/明确周次覆盖的差异，审核确认后提交。

客户端 `person-runner.ts` 负责对象执行，`projection.ts` 负责共享草稿，`runtime.ts` 负责人工编辑和提交，`state.ts`/`store.ts` 负责状态和持久化。原有文件解码、OCR、图片预算、来源覆盖、领域展开与提交事务继续复用。旧版全局对话、交接和通用 CRUD 工具已删除。

Worker `llm/agent.ts` 保留已有 AI SDK 与供应商适配，只开放 discover/person/verify/reconcile 对应的工具。人员不能写公共日历或他人对象。前后端需同步发布，无新增依赖、环境变量或业务迁移。旧版未完成批次原件保留，重新导入后使用新执行器。

验证：`pnpm check`、`pnpm test:agent-browser`、`pnpm build`；人员专项 `pnpm test:agent-person`。浏览器测试拦截模型，不代表真实识别或耗时已验收。完整契约、恢复与覆盖边界见根目录 `docs/AGENT_IMPORT.md`。

复核工具 `finish_person.checks` 使用显式数组，每项包含课表 `key` 和字段核对结果；不使用动态键字典，以确保 Google 工具 schema 保留核对字段。对象持久化与正式审核报告仍按课表键保存检查结果，无新增依赖、环境变量或数据库迁移。
