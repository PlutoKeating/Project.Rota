import { useEffect } from "react";
import { EmptyState } from "./components/EmptyState";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { ToastProvider } from "./components/Toast";
import { useRoute } from "./lib/router";
import { FairnessPage } from "./pages/FairnessPage";
import { ImportsPage } from "./pages/ImportsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PeoplePage } from "./pages/PeoplePage";
import { SchedulePage } from "./pages/SchedulePage";
import { SettingsPage } from "./pages/SettingsPage";
import { TasksPage } from "./pages/TasksPage";
import { TermsPage } from "./pages/TermsPage";
import { TimetablePage } from "./pages/TimetablePage";

const PAGE_META: Record<string, { title: string; subtitle: string }> = {
  "": { title: "概览", subtitle: "当前学期、人员与待排班次一览" },
  terms: { title: "学期与节次", subtitle: "校历网格的起点：开学日、周数、节次" },
  people: { title: "人员与组织", subtitle: "成员、部门、角色与可排时长" },
  timetable: { title: "课表", subtitle: "7 天 × 节次网格，课程与请假一目了然" },
  tasks: { title: "任务", subtitle: "一件活、它的班次与按周生成规则" },
  schedule: { title: "排班", subtitle: "试排、确认分配、整任务自动排" },
  fairness: { title: "公平账本", subtitle: "按次数升序，谁最亏谁在前" },
  imports: { title: "导入", subtitle: "上传课表，解析后人工确认再落库" },
  settings: { title: "设置", subtitle: "评分权重、冷却、模型供应商与审计" },
};

function metaFor(segments: string[]): { title: string; subtitle: string } {
  const head = segments[0] ?? "";
  if (head === "tasks" && segments[1]) {
    return { title: "任务详情", subtitle: "班次列表、添加班次与按周生成" };
  }
  if (head === "imports" && segments[1]) {
    return { title: "导入详情", subtitle: "解析状态与结果确认" };
  }
  return PAGE_META[head] ?? { title: "页面不存在", subtitle: "检查一下地址，或从左侧导航进入" };
}

function renderPage(segments: string[]) {
  const head = segments[0] ?? "";
  const detailId = segments[1] ?? null;

  switch (head) {
    case "":
      return <OverviewPage />;
    case "terms":
      return <TermsPage />;
    case "people":
      return <PeoplePage />;
    case "timetable":
      return <TimetablePage />;
    case "tasks":
      return <TasksPage taskId={detailId} />;
    case "schedule":
      return <SchedulePage />;
    case "fairness":
      return <FairnessPage />;
    case "imports":
      return <ImportsPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return (
        <EmptyState
          title="这个页面不存在"
          description="地址里的 hash 可能拼错了。"
          action={
            <a
              href="#/"
              className="inline-flex items-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
            >
              回到概览
            </a>
          }
        />
      );
  }
}

function RoutedApp() {
  const route = useRoute();
  const meta = metaFor(route.segments);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.path]);

  return (
    <Layout title={meta.title} subtitle={meta.subtitle} path={route.path}>
      <ErrorBoundary key={route.path}>{renderPage(route.segments)}</ErrorBoundary>
    </Layout>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <RoutedApp />
    </ToastProvider>
  );
}
