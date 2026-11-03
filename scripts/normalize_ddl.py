#!/usr/bin/env python3
"""把 LinkML 生成的 SQLite DDL 规范化为项目可读的形式。

LinkML 的 sqltables 生成器输出 PascalCase 表名（"Person"、"CourseMeeting"），
在 SQLite / D1 里必须带引号才能查询，非常别扭。这里做两件事：

1. 去掉生成器塞进来的逐列注释（信息已在 schema 与文档里）；
2. 表名、索引名统一转为 snake_case，非保留字不再加引号。

只做纯文本替换，不改任何列定义、约束或索引结构。
"""

from __future__ import annotations

import re
import sys

# 与 schema/rota.yaml 的 classes 一一对应
CLASS_NAMES = [
    "Term",
    "ClassPeriod",
    "Slot",
    "Person",
    "Organization",
    "Role",
    "Membership",
    "Skill",
    "PersonSkill",
    "Course",
    "CourseMeeting",
    "CourseOccurrence",
    "Unavailability",
    "Preference",
    "Task",
    "ShiftPattern",
    "Shift",
    "Assignment",
    "FairnessStat",
    "AdminUser",
    "LlmProvider",
    "ImportJob",
    "AuditEvent",
]

HEADER = """-- Project.Rota · 初始 schema
-- 由 schema/rota.yaml 生成，请勿手改；改动一律回到 LinkML 源文件。
-- 生成命令：pnpm gen
"""


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def normalize(text: str) -> str:
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("--")]
    body = "\n".join(lines)
    # 长名先换，避免 Person 命中 PersonSkill 的前缀
    for cls in sorted(CLASS_NAMES, key=len, reverse=True):
        body = re.sub(rf"(?<![A-Za-z0-9]){re.escape(cls)}(?![A-Za-z0-9])", snake(cls), body)
    body = re.sub(r"\n{3,}", "\n\n", body).strip() + "\n"
    return HEADER + body


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: normalize_ddl.py <input.sql> <output.sql>", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as src:
        normalized = normalize(src.read())
    with open(sys.argv[2], "w", encoding="utf-8") as dst:
        dst.write(normalized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
