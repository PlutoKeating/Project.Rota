import { useMemo, useState } from "react";
import type {
  ListResponse,
  MembershipView,
  Org,
  PersonStatus,
  PersonView,
  Role,
} from "../../shared/types";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Checkbox, Field, Select, TextInput } from "../components/Field";
import { ListState } from "../components/ListState";
import { Modal } from "../components/Modal";
import { DataTable, type Column } from "../components/Table";
import { useToast } from "../components/Toast";
import { api, messageOf } from "../lib/api";
import { dateFull, minutesText } from "../lib/format";
import { useAsync, useDebouncedValue } from "../lib/hooks";
import {
  ORG_KIND_OPTIONS,
  PERSON_STATUS_OPTIONS,
  membershipStatusLabel,
  membershipStatusTone,
  orgKindLabel,
  personStatusLabel,
  personStatusTone,
} from "../lib/labels";
import { useOrgsState, useTermsState } from "../lib/resources";

interface PersonFormValues {
  fullName: string;
  studentNo: string;
  email: string;
  phone: string;
  status: PersonStatus;
}

function personFormValues(person: PersonView | null): PersonFormValues {
  return {
    fullName: person?.fullName ?? "",
    studentNo: person?.studentNo ?? "",
    email: person?.email ?? "",
    phone: person?.phone ?? "",
    status: person?.status ?? "active",
  };
}

interface PersonFormModalProps {
  person: PersonView | null;
  onClose: () => void;
  onSaved: () => void;
}

function PersonFormModal({ person, onClose, onSaved }: PersonFormModalProps) {
  const toast = useToast();
  const [values, setValues] = useState<PersonFormValues>(() => personFormValues(person));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(patch: Partial<PersonFormValues>): void {
    setValues((previous) => ({ ...previous, ...patch }));
  }

  async function submit(): Promise<void> {
    if (!values.fullName.trim()) {
      setError("请填写姓名");
      return;
    }
    setError(null);

    const body: Record<string, unknown> = {
      fullName: values.fullName.trim(),
      status: values.status,
    };
    if (values.studentNo.trim()) body.studentNo = values.studentNo.trim();
    if (values.email.trim()) body.email = values.email.trim();
    if (values.phone.trim()) body.phone = values.phone.trim();

    setBusy(true);
    try {
      if (person) {
        await api.patch(`/persons/${encodeURIComponent(person.id)}`, body);
        toast.success("人员资料已更新");
      } else {
        await api.post("/persons", body);
        toast.success("人员已创建");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={person ? "编辑人员" : "新建人员"}
      description={person ? person.fullName : "只填姓名也能创建，学号稍后补。"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            {person ? "保存" : "创建"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="姓名" required error={error ?? undefined}>
          <TextInput value={values.fullName} onChange={(event) => update({ fullName: event.target.value })} autoFocus />
        </Field>
        <Field label="学号">
          <TextInput value={values.studentNo} onChange={(event) => update({ studentNo: event.target.value })} />
        </Field>
        <Field label="邮箱">
          <TextInput type="email" value={values.email} onChange={(event) => update({ email: event.target.value })} />
        </Field>
        <Field label="手机号">
          <TextInput value={values.phone} onChange={(event) => update({ phone: event.target.value })} />
        </Field>
        <Field label="状态">
          <Select
            value={values.status}
            onChange={(event) => update({ status: event.target.value as PersonStatus })}
          >
            {PERSON_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

interface MembershipModalProps {
  person: PersonView;
  orgs: Org[];
  roles: Role[];
  onClose: () => void;
  onChanged: () => void;
}

function MembershipModal({ person, orgs, roles, onClose, onChanged }: MembershipModalProps) {
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const list = useAsync(
    async () =>
      api.get<ListResponse<MembershipView>>(`/memberships?personId=${encodeURIComponent(person.id)}`),
    [person.id, version],
  );

  const [orgId, setOrgId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy] = useState(false);

  const availableRoles = useMemo(
    () => roles.filter((role) => (orgId ? role.orgId === orgId || role.orgId === null : role.orgId === null)),
    [roles, orgId],
  );

  async function addMembership(): Promise<void> {
    if (!orgId) {
      toast.error("请选择组织");
      return;
    }
    setBusy(true);
    try {
      await api.post("/memberships", {
        personId: person.id,
        orgId,
        roleId: roleId || null,
        validFrom: validFrom || undefined,
        validTo: validTo || undefined,
        isPrimary,
      });
      toast.success("成员关系已添加");
      setRoleId("");
      setValidFrom("");
      setValidTo("");
      setIsPrimary(false);
      setVersion((value) => value + 1);
      onChanged();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeMembership(id: string): Promise<void> {
    try {
      await api.del(`/memberships/${encodeURIComponent(id)}`);
      toast.success("成员关系已移除");
      setVersion((value) => value + 1);
      onChanged();
    } catch (error) {
      toast.error(messageOf(error));
    }
  }

  return (
    <Modal
      title={`部门与角色 · ${person.fullName}`}
      description="成员关系不物理删除，移除只会置为 ended。"
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <ListState
        loading={list.loading}
        error={list.error}
        empty={(list.data?.items.length ?? 0) === 0}
        onRetry={list.reload}
        emptyTitle="还没有成员关系"
        emptyDescription="在下面选择一个组织，把这个人加进去。"
      >
        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
          <DataTable
            columns={[
              {
                key: "org",
                header: "组织",
                render: (item: MembershipView) => (
                  <div>
                    <p className="font-medium">{item.orgName}</p>
                    <p className="text-[11px] text-slate-400">{item.roleName ?? "无角色"}</p>
                  </div>
                ),
              },
              {
                key: "period",
                header: "起止",
                render: (item: MembershipView) => (
                  <span className="text-xs tabular-nums">
                    {item.validFrom ? dateFull(item.validFrom) : "—"} → {item.validTo ? dateFull(item.validTo) : "至今"}
                  </span>
                ),
              },
              {
                key: "status",
                header: "状态",
                render: (item: MembershipView) => (
                  <Badge tone={membershipStatusTone(item.status)}>{membershipStatusLabel(item.status)}</Badge>
                ),
              },
              {
                key: "primary",
                header: "主属",
                render: (item: MembershipView) => (item.isPrimary ? "是" : "—"),
              },
              {
                key: "action",
                header: "",
                className: "text-right",
                render: (item: MembershipView) => (
                  <Button variant="ghost" size="sm" onClick={() => void removeMembership(item.id)}>
                    移除
                  </Button>
                ),
              },
            ]}
            rows={list.data?.items ?? []}
            rowKey={(item) => item.id}
            minWidth="min-w-[520px]"
          />
        </div>
      </ListState>

      <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
        <h3 className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">添加成员关系</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="组织" required>
            <Select
              value={orgId}
              onChange={(event) => {
                setOrgId(event.target.value);
                setRoleId("");
              }}
            >
              <option value="">选择组织</option>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="角色" hint={orgId ? "含本组织角色与全局角色" : "先选组织"}>
            <Select value={roleId} onChange={(event) => setRoleId(event.target.value)} disabled={!orgId}>
              <option value="">无角色</option>
              {availableRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="开始日期">
            <TextInput type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
          </Field>
          <Field label="结束日期" hint="留空表示至今">
            <TextInput type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Checkbox label="设为主属部门" checked={isPrimary} onChange={(event) => setIsPrimary(event.target.checked)} />
          <Button size="sm" loading={busy} disabled={!orgId} onClick={() => void addMembership()}>
            添加
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface OrgRoleModalProps {
  orgs: Org[];
  roles: Role[];
  onChanged: () => void;
  onClose: () => void;
}

function OrgRoleModal({ orgs, roles, onChanged, onClose }: OrgRoleModalProps) {
  const toast = useToast();
  const [orgName, setOrgName] = useState("");
  const [orgCode, setOrgCode] = useState("");
  const [orgKind, setOrgKind] = useState<Org["kind"]>("department");
  const [parentId, setParentId] = useState("");
  const [orgBusy, setOrgBusy] = useState(false);

  const [roleName, setRoleName] = useState("");
  const [roleCode, setRoleCode] = useState("");
  const [roleOrgId, setRoleOrgId] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [roleBusy, setRoleBusy] = useState(false);

  const orgNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const org of orgs) map.set(org.id, org.name);
    return map;
  }, [orgs]);

  async function createOrg(): Promise<void> {
    if (!orgName.trim()) {
      toast.error("请填写组织名称");
      return;
    }
    setOrgBusy(true);
    try {
      await api.post("/orgs", {
        name: orgName.trim(),
        kind: orgKind,
        ...(orgCode.trim() ? { code: orgCode.trim() } : {}),
        parentId: parentId || null,
      });
      toast.success("组织已创建");
      setOrgName("");
      setOrgCode("");
      setParentId("");
      onChanged();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setOrgBusy(false);
    }
  }

  async function createRole(): Promise<void> {
    if (!roleName.trim()) {
      toast.error("请填写角色名称");
      return;
    }
    setRoleBusy(true);
    try {
      await api.post("/roles", {
        name: roleName.trim(),
        orgId: roleOrgId || null,
        ...(roleCode.trim() ? { code: roleCode.trim() } : {}),
        ...(roleDescription.trim() ? { description: roleDescription.trim() } : {}),
      });
      toast.success("角色已创建");
      setRoleName("");
      setRoleCode("");
      setRoleDescription("");
      onChanged();
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setRoleBusy(false);
    }
  }

  return (
    <Modal
      title="部门与角色"
      description="组织形成树，角色可挂在组织下，也可以全局复用。"
      size="xl"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">组织（{orgs.length}）</h3>
          <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800">
            {orgs.length === 0 ? (
              <p className="px-3 py-4 text-xs text-slate-400">暂无组织，先新建一个。</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {orgs.map((org) => (
                  <li key={org.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{org.name}</p>
                      <p className="text-[11px] text-slate-400">
                        {orgKindLabel(org.kind)}
                        {org.parentId ? ` · 上级：${orgNameById.get(org.parentId) ?? org.parentId}` : ""}
                        {org.code ? ` · ${org.code}` : ""}
                      </p>
                    </div>
                    <Badge tone={org.status === "active" ? "success" : "neutral"}>
                      {org.status === "active" ? "正常" : "归档"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="名称" required>
                <TextInput value={orgName} onChange={(event) => setOrgName(event.target.value)} placeholder="宣传部" />
              </Field>
              <Field label="编码">
                <TextInput value={orgCode} onChange={(event) => setOrgCode(event.target.value)} placeholder="PR" />
              </Field>
              <Field label="类型">
                <Select value={orgKind} onChange={(event) => setOrgKind(event.target.value as Org["kind"])}>
                  {ORG_KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="上级组织">
                <Select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                  <option value="">无（顶级）</option>
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="flex justify-end">
              <Button size="sm" loading={orgBusy} onClick={() => void createOrg()}>
                新建组织
              </Button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">角色（{roles.length}）</h3>
          <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800">
            {roles.length === 0 ? (
              <p className="px-3 py-4 text-xs text-slate-400">暂无角色。</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {roles.map((role) => (
                  <li key={role.id} className="px-3 py-2 text-sm">
                    <p className="font-medium">{role.name}</p>
                    <p className="text-[11px] text-slate-400">
                      {role.orgId ? (orgNameById.get(role.orgId) ?? role.orgId) : "全局角色"}
                      {role.code ? ` · ${role.code}` : ""}
                      {role.description ? ` · ${role.description}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="名称" required>
                <TextInput value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="部长" />
              </Field>
              <Field label="编码">
                <TextInput value={roleCode} onChange={(event) => setRoleCode(event.target.value)} placeholder="HEAD" />
              </Field>
              <Field label="所属组织">
                <Select value={roleOrgId} onChange={(event) => setRoleOrgId(event.target.value)}>
                  <option value="">全局</option>
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="说明">
                <TextInput
                  value={roleDescription}
                  onChange={(event) => setRoleDescription(event.target.value)}
                  placeholder="可选"
                />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button size="sm" loading={roleBusy} onClick={() => void createRole()}>
                新建角色
              </Button>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}

export function PeoplePage() {
  const terms = useTermsState();
  const orgsState = useOrgsState();

  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q);
  const [orgFilter, setOrgFilter] = useState("");
  const [peopleVersion, setPeopleVersion] = useState(0);
  const [rolesVersion, setRolesVersion] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [formPerson, setFormPerson] = useState<PersonView | null>(null);
  const [membershipPerson, setMembershipPerson] = useState<PersonView | null>(null);
  const [orgRoleOpen, setOrgRoleOpen] = useState(false);

  const orgs = orgsState.data?.items ?? [];

  const roles = useAsync(async () => api.get<ListResponse<Role>>("/roles"), [rolesVersion]);

  // 列表接口若没有内嵌 memberships，用一次全量成员关系兜底，避免「部门」整列空白。
  const allMemberships = useAsync(async () => api.get<ListResponse<MembershipView>>("/memberships"), [peopleVersion]);

  const membershipsByPerson = useMemo(() => {
    const map = new Map<string, MembershipView[]>();
    for (const item of allMemberships.data?.items ?? []) {
      const list = map.get(item.personId) ?? [];
      list.push(item);
      map.set(item.personId, list);
    }
    return map;
  }, [allMemberships.data]);

  const termId = terms.current?.id ?? null;
  const persons = useAsync(async () => {
    const params = new URLSearchParams();
    if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
    if (orgFilter) params.set("orgId", orgFilter);
    if (termId) params.set("termId", termId);
    const query = params.toString();
    return api.get<ListResponse<PersonView>>(`/persons${query ? `?${query}` : ""}`);
  }, [debouncedQ, orgFilter, termId, peopleVersion]);

  function openCreate(): void {
    setFormPerson(null);
    setFormOpen(true);
  }

  function openEdit(person: PersonView): void {
    setFormPerson(person);
    setFormOpen(true);
  }

  function refreshPeople(): void {
    setPeopleVersion((value) => value + 1);
  }

  function refreshOrgData(): void {
    orgsState.reload();
    setRolesVersion((value) => value + 1);
  }

  const rows = persons.data?.items ?? [];

  const columns: Column<PersonView>[] = [
    {
      key: "name",
      header: "姓名",
      render: (person) => (
        <div className="min-w-0">
          <p className="font-medium">{person.fullName}</p>
          {person.email ? <p className="truncate text-[11px] text-slate-400">{person.email}</p> : null}
        </div>
      ),
    },
    {
      key: "studentNo",
      header: "学号",
      render: (person) => <span className="font-mono text-xs">{person.studentNo ?? "—"}</span>,
    },
    {
      key: "orgs",
      header: "部门",
      render: (person) => {
        const embedded = person.memberships ?? [];
        const memberships = (embedded.length > 0 ? embedded : (membershipsByPerson.get(person.id) ?? [])).filter(
          (item) => item.status !== "ended",
        );
        if (memberships.length === 0) return <span className="text-xs text-slate-400">—</span>;
        const visible = memberships.slice(0, 3);
        return (
          <div className="flex flex-wrap gap-1">
            {visible.map((item) => (
              <Badge key={item.id} tone="neutral">
                {item.orgName}
                {item.roleName ? ` · ${item.roleName}` : ""}
              </Badge>
            ))}
            {memberships.length > visible.length ? <Badge tone="neutral">+{memberships.length - visible.length}</Badge> : null}
          </div>
        );
      },
    },
    {
      key: "status",
      header: "状态",
      render: (person) => <Badge tone={personStatusTone(person.status)}>{personStatusLabel(person.status)}</Badge>,
    },
    {
      key: "free",
      header: "可排时长",
      className: "tabular-nums",
      render: (person) =>
        person.freeMinutes === null || person.freeMinutes === undefined ? (
          <span className="text-xs text-slate-400" title="选择当前学期后可见">
            —
          </span>
        ) : (
          <span className="text-xs">{minutesText(person.freeMinutes)}</span>
        ),
    },
    {
      key: "action",
      header: "",
      className: "text-right whitespace-nowrap",
      render: (person) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => openEdit(person)}>
            编辑
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMembershipPerson(person)}>
            成员关系
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 sm:space-y-5">
      <Card
        title="人员"
        description={`当前学期：${terms.current?.name ?? "未选择"}${termId ? "（可排时长按学期计算）" : ""}`}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setOrgRoleOpen(true)}>
              部门与角色
            </Button>
            <Button size="sm" onClick={openCreate}>
              新建人员
            </Button>
          </>
        }
      >
        <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_220px]">
          <TextInput
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="搜索姓名或学号…"
            aria-label="搜索人员"
          />
          <Select
            value={orgFilter}
            onChange={(event) => setOrgFilter(event.target.value)}
            aria-label="按组织筛选"
          >
            <option value="">全部组织</option>
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </Select>
        </div>

        {terms.error ? (
          <p className="mb-2 text-[11px] text-amber-600 dark:text-amber-400">
            学期信息未加载：{terms.error}（可排时长可能为空）
          </p>
        ) : null}
        {orgsState.error ? (
          <p className="mb-2 text-[11px] text-amber-600 dark:text-amber-400">组织加载失败：{orgsState.error}</p>
        ) : null}

        <ListState
          loading={persons.loading}
          error={persons.error}
          empty={rows.length === 0}
          onRetry={persons.reload}
          emptyTitle={q || orgFilter ? "没有匹配的人员" : "还没有人员"}
          emptyDescription={
            q || orgFilter ? "换个关键词或清除筛选再试。" : "先导入名单，或手动新建第一位成员。"
          }
          emptyAction={
            q || orgFilter ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQ("");
                  setOrgFilter("");
                }}
              >
                清除筛选
              </Button>
            ) : (
              <Button size="sm" onClick={openCreate}>
                新建人员
              </Button>
            )
          }
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(person) => person.id}
            minWidth="min-w-[880px]"
          />
        </ListState>
      </Card>

      {formOpen ? (
        <PersonFormModal person={formPerson} onClose={() => setFormOpen(false)} onSaved={refreshPeople} />
      ) : null}

      {membershipPerson ? (
        <MembershipModal
          person={membershipPerson}
          orgs={orgs}
          roles={roles.data?.items ?? []}
          onClose={() => setMembershipPerson(null)}
          onChanged={refreshPeople}
        />
      ) : null}

      {orgRoleOpen ? (
        <OrgRoleModal
          orgs={orgs}
          roles={roles.data?.items ?? []}
          onChanged={refreshOrgData}
          onClose={() => setOrgRoleOpen(false)}
        />
      ) : null}
    </div>
  );
}
