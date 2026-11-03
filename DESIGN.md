---
name: PlutoKeating Design System — Project.Rota
description: 暖中性色与橙色动作强调的学生组织排班工作界面。
colors:
  indigo-50: "#fff3e6"
  indigo-100: "#f9dfc5"
  indigo-300: "#f5b67c"
  indigo-400: "#f0a35e"
  indigo-500: "#b85c21"
  indigo-600: "#a94d12"
  indigo-700: "#8a3d0c"
  slate-50: "#f5f2ec"
  slate-100: "#ede8df"
  slate-200: "#ddd7ce"
  slate-300: "#bcb4aa"
  slate-400: "#72685e"
  emerald-600: "#087650"
  amber-600: "#945000"
  slate-500: "#686159"
  slate-600: "#57514a"
  slate-700: "#403b35"
  slate-800: "#302e2b"
  slate-900: "#17181c"
  slate-950: "#0e0f11"
  white: "#ffffff"
  dark-muted: "#a9a49c"
  dark-secondary: "#aaa49b"
  dark-text: "#e8e4dd"
  dark-accent-active: "#e29651"
  dark-accent-text: "#1a120a"
typography:
  headline:
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "24px"
    fontWeight: 600
    lineHeight: "32px"
  title:
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
  body:
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "21px"
  label:
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  badge:
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "16.5px"
rounded:
  control: "8px"
  navigation: "12px"
  card: "14px"
  dialog: "16px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  section: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.indigo-600}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.indigo-500}"
  button-primary-active:
    backgroundColor: "{colors.indigo-700}"
  button-primary-dark:
    backgroundColor: "{colors.indigo-400}"
    textColor: "{colors.dark-accent-text}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.slate-700}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-ghost:
    textColor: "{colors.slate-600}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.slate-900}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.card}"
    padding: "16px"
  badge-neutral:
    backgroundColor: "{colors.slate-100}"
    textColor: "{colors.slate-600}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  navigation-active:
    textColor: "{colors.indigo-600}"
    rounded: "{rounded.navigation}"
    padding: "12px 16px"
---

# Design System: PlutoKeating / Project.Rota

## Overview

沿用用户确认的 **PlutoKeating Design System**：暖中性色、橙色动作强调、精简工作界面。排班是首页；主要内容是实际班次、人员和导入任务，不使用装饰渐变或展示性指标。

本文由 `src/client/index.css` 与实际组件提取。前置 token 是规范层，`.impeccable/design.json` 补充主题映射、交互、阴影和预览片段。未覆盖的工具类沿用 Tailwind 4 默认值。原方向稿中的浅色纸面与文字色已按实际代码校正；未另外引入新视觉隐喻。

## Colors

橙色动作配合暖灰底面。为保持现有组件兼容，源码保留 `indigo-*`、`slate-*` 名称；它们分别代表橙色与暖中性色，不代表默认 Tailwind 蓝紫色与冷灰色。

- 主操作：`indigo-600`，悬停 `indigo-500`，按下 `indigo-700`。浅色主按钮使用白字。
- 浅色：页面 `slate-50`，卡片与页眉 `white`，正文 `slate-900`，次要文字 `slate-500`，边线 `slate-200`。`slate-400` 已加深，用于提示与占位文字。
- 深色：页面 `slate-950`，表面 `slate-900`，正文通常 `slate-100`，未显式覆盖的 `text-slate-900` 使用 `dark-text`。`slate-400/500` 分别映射 `dark-muted/dark-secondary`；动作 `indigo-600/500/700` 分别映射 `indigo-400/indigo-300/dark-accent-active`。橙色实心按钮使用 `dark-accent-text`。
- 成功、警告、危险沿用 emerald、amber、rose 语义色；600 级成功与警告色已加深。Badge 使用对应 50/700 色阶，深色使用半透明 500 底与 300 字，不能把全部状态替换成橙色。

## Typography

Inter variable 字体自托管，字重 100–900，`font-display: swap`；中文回退 PingFang SC、Microsoft YaHei、sans-serif。页面标题 24px/32px、600 字重；卡片与弹层标题 14px/20px、600 字重；正文和普通控件 14px，字段标签与辅助按钮 12px。提示与状态标签使用 11px，部分紧凑技术信息为 10px。日期与数字按需采用 tabular-nums，标识符按需采用系统等宽字。

## Layout

固定 64px 页眉；768px 起展示 192px 桌面侧栏，以下改为底部三入口导航，并保留底部安全区。主内容独立滚动，最大宽度 1440px；水平留白手机 16px、桌面 32px，顶部 96px，底部手机 96px、桌面 40px。卡片默认内边距 16px，640px 起 20px。

首页首屏提供日期范围、部门、名称及缺员筛选、安排工作和 CSV 导出，呈现真实班次或可操作空态。任务与公平账本归入排班上下文。管理分类在窄屏水平滚动；不把低频配置加入日常三个入口。

## Elevation & Depth

日常卡片以边框和底色分层，不附加卡片阴影。按钮与输入使用 Tailwind `shadow-sm`，账号菜单 `shadow-lg`，弹层 `shadow-2xl`；弹层遮罩为 `slate-900` 的 35% 透明度。主导航和页眉为 z-40，弹层 z-50，跳过导航链接聚焦时 z-90。

控件沿用 Tailwind 默认 transition（150ms，cubic-bezier(0.4, 0, 0.2, 1)）。`prefers-reduced-motion: reduce` 关闭动画与过渡，并恢复即时滚动。未添加装饰性入场动画。

## Shapes

控件 8px、导航与小容器 12px、Card 14px、普通弹层 16px 圆角；状态标签为胶囊。边框通常 1px。普通弹层手机贴底、仅顶部圆角，640px 起居中；默认最大宽度 512px，可选 384/672/896px，高度上限 92dvh。上下文侧栏靠右、直角、最高 100dvh，640px 起最大宽度 672px。

## Components

### Buttons and fields

Button 提供 primary、secondary、ghost、danger 四种样式；默认 8px × 14px 内边距，sm 为 6px × 10px。loading 显示 spinner 并禁用按钮，disabled 透明度 60%。全局键盘焦点为橙色 2px outline、3px 偏移；Button 使用 2px 的 indigo-500/50 ring，输入使用 indigo-500 边框与 20% ring。字段 label 关联控件 ID，提示与错误关联 aria-describedby，错误设置 aria-invalid；错误文字保持语义色。

### Cards and badges

Card 可选标题、说明和动作，标题区与正文分开；默认正文 16px/20px 内边距。Badge 为紧凑状态描述，使用 neutral、success、warning、danger、info，不模拟可点击按钮。

### Navigation and management

排班、人员、导入是桌面与手机的三个日常入口。当前项通过 aria-current、橙色文字与 10% 橙色底标识；管理在桌面底部或账号菜单。管理内容由按钮切换排班规则、学期与节次、模型服务、账号授权、审计记录；保持现有 owner 权限边界。旧 hash 地址继续兼容。明暗主题优先读取保存偏好，否则读取系统主题，手动选择存入 localStorage。

### Context panels and confirmation

安排工作在同一侧栏填写名称、部门、日期、起止时间、人数和按周重复，补充人员或学期后返回保留的草稿。人员详情与排班候选在上下文侧栏处理，保留底层页面。预览只计算，确认才写入分配；批量预览的候选数是快照，最终确认由服务端重新检查。课表识别必须人工确认后落库。

Modal 使用 portal 与窗口栈：根页面 inert，打开子窗口时父窗口 inert，仅最上层处理 Tab 和 Escape；关闭后恢复上一层及原焦点，最后一层关闭才恢复页面滚动。遮罩和关闭按钮可关闭当前窗口。重用组件，不为局部配置再实现一套焦点逻辑。

### Model setup

模型页展示 models.dev 目录更新时间、刷新状态、已配置条目与内联供应商选择器。选择供应商、搜索并勾选模型；默认只显示支持图片输入的模型。密钥用 password 控件粘贴，仅存在当前组件内存，服务端加密保存，API 仅返回密钥存在状态；Workers AI 使用绑定，无需密钥。

支持连接测试、启停、删除、替换密钥和拖拽/上移/下移排序。排序用于未指定模型时的首选，并不代表逐个失败回退；指定导入模型优先。模型配置采用整页内存草稿，新增、启停、密钥、删除和排序在点击统一保存后生效；失败保留草稿，放弃更改恢复服务端快照。保存栏常驻可见，未应用的输入先加入草稿。拖动仅从 44px 抓手开始，相邻条目弹性让位，放下插入；支持键盘和减少动态效果。页面离开、hash 路由及管理 tab 切换提醒未保存内容。

## Do's and Don'ts

- **Do** 从共享组件和现有色阶扩展新屏幕，同时核对明暗主题。
- **Do** 用真实数据、加载、错误重试和明确下一步的空态组织工作界面。
- **Do** 保持上下文操作、显式预览与确认，以及键盘可见焦点。
- **Don't** 用方向稿未落地的颜色覆盖现有 token，或恢复 Tailwind 默认蓝紫主色。
- **Don't** 引入装饰渐变、展示性仪表盘或生产演示数据。
- **Don't** 回显已保存密钥、把密钥写入浏览器持久化，或将预览描述为已完成分配。


模型连接测试相互独立，不阻塞其他测试或配置编辑、排序、保存。测试使用已保存配置，结果位于对应模型卡片内；失败展示 HTTP 状态、上游代码/类型和可滚动的完整错误正文（敏感信息脱敏），不占用页面顶部错误区域。
