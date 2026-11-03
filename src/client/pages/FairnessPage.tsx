import { useEffect, useMemo, useState } from "react";
import type { FairnessRow, ListResponse } from "../../shared/types";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Field, Select } from "../components/Field";
import { ListState } from "../components/ListState";
import { DataTable, type Column } from "../components/Table";
import { useToast } from "../components/Toast";
import { api, messageOf } from "../lib/api";
import { dateFull, hhmm, minutesText } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { useOrgsState, useTermsState } from "../lib/resources";

export function FairnessPage() {
  const toast = useToast();
  const terms = useTermsState();
  const orgsState = useOrgsState();

  const [termId, setTermId] = useState("");
  const [windowValue, setWindowValue] = useState("");
  const [orgId, setOrgId] = useState("");
  const [version, setVersion] = useState(0);
  const [recomputing, setRecomputing] = useState(false);

  useEffect(() => {
    if (!termId && terms.current) setTermId(terms.current.id);
  }, [terms.current, termId]);

  useEffect(() => {
    setWindowValue("");
  }, [termId]);

  const term = terms.terms.find((item) => item.id === termId) ?? terms.current;

  const fairness = useAsync(async () => {
    const params = new URLSearchParams();
    if (windowValue) params.set("windowKey", windowValue);
    if (orgId) params.set("orgId", orgId);
    const query = params.toString();
    return api.get<ListResponse<FairnessRow>>(`/fairness${query ? `?${query}` : ""}`);
  }, [windowValue, orgId, version]);

  const rows = useMemo(() => {
    const items = fairness.data?.items ?? [];
    return [...items].sort(
      (a, b) => (a.shiftCount ?? 0) - (b.shiftCount ?? 0) || (a.carryOver ?? 0) - (b.carryOver ?? 0),
    );
  }, [fairness.data]);

  async function recompute(): Promise<void> {
    setRecomputing(true);
    try {
      await api.post("/fairness/recompute", {
        ...(windowValue ? { windowKey: windowValue } : {}),
        ...(orgId ? { orgId } : {}),
      });
      toast.success("公平账本已重算");
      setVersion((value) => value + 1);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setRecomputing(false);
    }
  }

  const columns: Column<FairnessRow>[] = [
    {
      key: "name",
      header: "姓名",
      render: (row) => <p className="font-medium">{row.fullName}</p>,
    },
    {
      key: "org",
      header: "部门",
      render: (row) => row.orgName ?? "—",
    },
    {
      key: "count",
      header: "次数",
      className: "tabular-nums",
      render: (row) => <span className="font-medium">{row.shiftCount ?? 0}</span>,
    },
    {
      key: "minutes",
      header: "分钟",
      className: "tabular-nums",
      render: (row) => <span title={`${row.minutes ?? 0} 分钟`}>{minutesText(row.minutes ?? 0)}</span>,
    },
    {
      key: "carry",
      header: "结转",
      className: "tabular-nums",
      render: (row) => (
        <span className={(row.carryOver ?? 0) > 0 ? "text-amber-600 dark:text-amber-400" : ""}>
          {(row.carryOver ?? 0).toFixed(2)}
        </span>
      ),
    },
    {
      key: "last",
      header: "上次被排",
      render: (row) =>
        row.lastAssignedAt ? (
          <span className="text-xs tabular-nums">
            {dateFull(row.lastAssignedAt)} {hhmm(row.lastAssignedAt)}
          </span>
        ) : (
          <Badge tone="warning">从未</Badge>
        ),
    },
  ];

  const totalShifts = rows.reduce((total, row) => total + row.shiftCount, 0);
  const totalMinutes = rows.reduce((total, row) => total + row.minutes, 0);

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card
        title="公平账本"
        description="按次数升序，最少的人排在最前；结转来自上一个窗口。"
        actions={
          <Button variant="secondary" size="sm" loading={recomputing} onClick={() => void recompute()}>
            重算账本
          </Button>
        }
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="学期">
            <Select value={termId} onChange={(event) => setTermId(event.target.value)}>
              <option value="">当前学期</option>
              {terms.terms.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="窗口" hint={term ? `窗口名格式：${term.name}-W<周次>` : undefined}>
            <Select value={windowValue} onChange={(event) => setWindowValue(event.target.value)}>
              <option value="">自动（当前周）</option>
              {term ? (
                <optgroup label="按周">
                  {Array.from({ length: Math.max(1, term.weekCount) }, (_, index) => index + 1).map((week) => (
                    <option key={`week-${week}`} value={`${term.name}-W${week}`}>
                      第 {week} 周
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {term ? (
                <optgroup label="按月">
                  {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                    <option key={`month-${month}`} value={`${term.name}-M${month}`}>
                      {month} 月
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
          </Field>
          <Field label="部门">
            <Select value={orgId} onChange={(event) => setOrgId(event.target.value)}>
              <option value="">全部部门</option>
              {(orgsState.data?.items ?? []).map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <Badge tone="neutral">{`${rows.length} 人`}</Badge>
          <Badge tone="info">{`共 ${totalShifts} 人次`}</Badge>
          <Badge tone="neutral">{`共 ${minutesText(totalMinutes)}`}</Badge>
          <span className="break-all">窗口：{windowValue || "自动（当前周）"}</span>
        </div>

        {terms.error ? (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">学期加载失败：{terms.error}</p>
        ) : null}
        {orgsState.error ? (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">组织加载失败：{orgsState.error}</p>
        ) : null}

        <div className="mt-4">
          <ListState
            loading={fairness.loading}
            error={fairness.error}
            empty={rows.length === 0}
            onRetry={fairness.reload}
            emptyTitle="这个窗口还没有账本数据"
            emptyDescription="先完成一次排班分配，或点右上角「重算账本」从 assignment 重建。"
          >
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => `${row.personId}-${row.orgId ?? "none"}-${row.windowKey}`}
              minWidth="min-w-[760px]"
            />
          </ListState>
        </div>
      </Card>
    </div>
  );
}
