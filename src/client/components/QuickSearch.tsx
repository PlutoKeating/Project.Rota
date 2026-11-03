import { useState } from "react";
import type { PersonView, Task, ListResponse } from "../../shared/types";
import { useAsync, useDebouncedValue } from "../lib/hooks";
import { api } from "../lib/api";
import { Modal } from "./Modal";
import { TextInput } from "./Field";
import { Button } from "./Button";
import { TimetablePage } from "../pages/TimetablePage";
export function QuickSearch() {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [person, setPerson] = useState<PersonView | null>(null);
  const q = useDebouncedValue(query);
  const results = useAsync(async () => {
    if (!open || !q.trim()) return { people: [], tasks: [] };
    const [p, t] = await Promise.all([
      api.get<ListResponse<PersonView>>(`/persons?q=${encodeURIComponent(q)}`),
      api.get<ListResponse<Task>>("/tasks"),
    ]);
    return {
      people: p.items,
      tasks: t.items.filter((t) => t.title.includes(q)),
    };
  }, [q, open]);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        搜索
      </Button>
      {open && (
        <Modal
          title="搜索人员、任务或操作"
          onClose={() => {
            setOpen(false);
            setPerson(null);
          }}
        >
          {person ? (
            <>
              <Button variant="ghost" onClick={() => setPerson(null)}>
                返回搜索
              </Button>
              <TimetablePage initialPersonId={person.id} />
            </>
          ) : (
            <>
              <TextInput
                autoFocus
                aria-label="全局搜索"
                placeholder="输入姓名或工作名称"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="flex flex-wrap gap-3">
                {[
                  ["/", "安排工作"],
                  ["/people", "新增人员"],
                  ["/imports", "导入课表"],
                  ["/settings", "管理配置"],
                ].map(([path, label]) => (
                  <a
                    className="rounded-lg border border-slate-200 px-3 py-2"
                    key={path}
                    href={`#${path}`}
                    onClick={() => {
                      setOpen(false);
                      if (path === "/")
                        setTimeout(
                          () =>
                            window.dispatchEvent(new Event("rota:create-work")),
                          100,
                        );
                    }}
                  >
                    {label}
                  </a>
                ))}
              </div>
              {results.loading && q && <p role="status">正在搜索…</p>}
              {results.error && <p role="alert">{results.error}</p>}
              <ul className="divide-y divide-slate-200">
                {results.data?.people.map((p) => (
                  <li key={p.id}>
                    <button
                      className="w-full py-3 text-left"
                      onClick={() => setPerson(p)}
                    >
                      {p.fullName}{" "}
                      <span className="text-slate-500">{p.studentNo}</span>
                    </button>
                  </li>
                ))}
                {results.data?.tasks.map((t) => (
                  <li key={t.id}>
                    <a
                      className="block py-3"
                      href={`#/tasks/${t.id}`}
                      onClick={() => setOpen(false)}
                    >
                      {t.title}
                    </a>
                  </li>
                ))}
              </ul>
              {q &&
                !results.loading &&
                !results.error &&
                !results.data?.people.length &&
                !results.data?.tasks.length && (
                  <p>没有找到匹配的人员或任务。</p>
                )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
