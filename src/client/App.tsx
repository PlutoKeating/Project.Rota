import { AuthGate } from "./components/AuthGate";
import { useEffect, lazy, Suspense } from "react";
import { EmptyState } from "./components/EmptyState";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { ToastProvider } from "./components/Toast";
import { useRoute } from "./lib/router";
import { FairnessPage } from "./pages/FairnessPage";
const ImportsPage=lazy(()=>import("./pages/ImportsPage").then(m=>({default:m.ImportsPage})));

import { PeoplePage } from "./pages/PeoplePage";
import { SchedulePage } from "./pages/SchedulePage";
import { SettingsPage } from "./pages/SettingsPage";
import { TasksPage } from "./pages/TasksPage";
import { TermsPage } from "./pages/TermsPage";
import { TimetablePage } from "./pages/TimetablePage";

const PAGE_TITLES: Record<string, string> = {
  "": "排班",
  terms: "学期与节次",
  people: "人员与组织",
  timetable: "课表",
  tasks: "任务",
  schedule: "排班",
  fairness: "公平账本",
  imports: "导入",
  settings: "管理",
};

function metaFor(segments: string[]): { title: string } {
  const head = segments[0] ?? "";
  if (head === "tasks" && segments[1]) return { title: "任务详情" };
  if (head === "imports" && segments[1]) return { title: "导入详情" };
  return { title: PAGE_TITLES[head] ?? "页面不存在" };
}

function renderPage(segments: string[]) {
  const head = segments[0] ?? "";
  const detailId = segments[1] ?? null;

  switch (head) {
    case "":
      return <SchedulePage />;
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
      return <Suspense fallback={<p role="status">正在打开导入…</p>}><ImportsPage /></Suspense>;
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
    <Layout title={meta.title} path={route.path}>
      <ErrorBoundary key={route.path}>
        {renderPage(route.segments)}
      </ErrorBoundary>
    </Layout>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthGate>
        <RoutedApp />
      </AuthGate>
    </ToastProvider>
  );
}
