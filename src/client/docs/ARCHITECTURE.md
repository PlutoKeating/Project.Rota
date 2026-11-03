# 前端架构

`AuthGate` 提供 Session context；`Layout` 负责固定页眉、导航、账号菜单、主题及独立滚动内容区。`QuickSearch` 搜索人员与任务。`App` 保留旧路由兼容，首页渲染 SchedulePage。

`Modal` 统一侧栏与对话框，使用 portal、顶层窗口栈、inert、焦点循环及关闭后恢复焦点。嵌套配置不得让底层窗口处理 Escape。

`WorkComposer` 只提交 `/work`，服务端原子创建任务和全部重复班次。班次候选始终请求 `/preview`；正式分配单独确认。批量预览显示整个任务当前各班次缺口和候选数量，确认时服务端逐次检查，预览不承诺最终人数。

`ModelsPage` 读取 `/admin/model-config` 快照，所有新增、启停、删除、密钥替换和排序仅写当前组件内存草稿。保存栏显示未保存状态，点击保存后一次 PUT 整页配置；失败保留草稿，放弃更改重新读取服务端。未应用的添加或密钥输入会阻止保存，避免漏存。保存期间禁用编辑。已有模型可随时测试已保存配置，测试按模型 ID 独立管理 pending/result，不使用全局 busy，不阻塞其他测试、编辑、排序、删除或保存。新增模型需先保存。测试结果留在对应卡片下，并注明测试时的已保存配置。密钥不进入浏览器持久化；API 只返回 hasKey。

排序使用 @dnd-kit 的 PointerSensor、KeyboardSensor、SortableContext 和 DragOverlay；仅 44px 抓手启动拖动，其他区域仍可滚动/选字。相邻条目用 280ms transform 弹性让位，放下动效同速；新草稿行用 220ms 入场。系统减少动态效果时取消空间动画。保留上移/下移按钮和中文读屏提示。beforeunload、hash 路由和管理 tab 切换在有草稿时提醒放弃。

页面状态与网络状态通过现有 useAsync 管理。日期范围保存在 sessionStorage；侧栏操作保留底层页面筛选和滚动上下文。明暗主题保存在 localStorage。没有引入新路由框架或组件框架。
