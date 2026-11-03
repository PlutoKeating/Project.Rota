import { useState } from "react";
import { Button } from "./Button";
import { Field, Select, Textarea } from "./Field";
import { Card } from "./Card";
import { useOrgsState } from "../lib/resources";
import { api, messageOf } from "../lib/api";
export function PeopleImport() {
  const [text, setText] = useState(""),
    [org, setOrg] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const orgs = useOrgsState();
  const rows = text
    .split(/\r?\n/)
    .filter((s) => s.trim())
    .map((line) => {
      const [fullName, studentNo] = line.split(/\t|,/).map((s) => s.trim());
      return { fullName, studentNo };
    });
  async function save() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const r = await api.post<{ created: number }>("/persons/import", {
        items: rows,
        orgId: org || undefined,
      });
      setSuccess(`已导入 ${r.created} 人`);
      setText("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="批量导入人员"
      description="从表格复制两列：姓名、学号（不含表头）。支持制表符或逗号分隔；重复学号会阻止整批导入。"
    >
      <div className="space-y-4">
        <Field label="人员清单">
          <Textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="姓名,学号"
          />
        </Field>
        <Field label="加入部门（可选）">
          <Select value={org} onChange={(e) => setOrg(e.target.value)}>
            <option value="">暂不加入部门</option>
            {orgs.data?.items.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        {rows.length > 0 && (
          <div className="max-h-60 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="py-2">姓名</th>
                  <th>学号</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-200">
                    <td className="py-2">{r.fullName}</td>
                    <td>{r.studentNo || "缺少学号"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && (
          <p role="alert" className="text-rose-600">
            {error}
          </p>
        )}
        {success && <p role="status">{success}</p>}
        <Button
          disabled={
            !rows.length || rows.some((r) => !r.fullName || !r.studentNo)
          }
          loading={busy}
          onClick={() => void save()}
        >
          确认导入 {rows.length || ""} 人
        </Button>
      </div>
    </Card>
  );
}
