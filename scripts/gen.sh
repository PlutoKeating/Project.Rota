#!/usr/bin/env bash
# 由 LinkML schema 生成下游产物。任何手改都会在下次生成时丢失。
#
# 依赖：python3 + linkml（见 docs/QUICK_START.md 的 venv 步骤）
set -euo pipefail

cd "$(dirname "$0")/.."

LINKML_BIN="${LINKML_BIN:-linkml}"
SCHEMA="schema/rota.yaml"
OUT_DDL="migrations/0001_init.sql"
TMP_DDL="$(mktemp)"
trap 'rm -f "$TMP_DDL"' EXIT

echo "→ 校验 schema"
"$LINKML_BIN" lint "$SCHEMA" >/dev/null || echo "  (lint 有警告，见上一步输出)"

echo "→ 生成 SQLite DDL"
"$LINKML_BIN" generate sqltables --dialect sqlite --no-rename-foreign-keys "$SCHEMA" >"$TMP_DDL"
python3 scripts/normalize_ddl.py "$TMP_DDL" "$OUT_DDL"

echo "→ 生成 ER 图"
"$LINKML_BIN" generate erdiagram "$SCHEMA" >docs/er.md

echo "→ 生成 JSON Schema"
"$LINKML_BIN" generate json-schema "$SCHEMA" >schema/rota.schema.json

echo "完成：$OUT_DDL / docs/er.md / schema/rota.schema.json"
