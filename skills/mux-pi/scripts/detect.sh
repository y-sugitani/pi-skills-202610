#!/usr/bin/env bash
# mux-pi: 端末マルチプレクサ（Herdr）の検出
# stdout に JSON 1 行を出力する。破壊的操作はしない。
set -euo pipefail

# HERDR_ENV=1 のときだけ backend=herdr。それ以外は none
# （Herdr 外は pane を持てないので、委譲は subagent の async で代用する）。
backend="none"
if [[ "${HERDR_ENV:-}" == "1" ]]; then
  backend="herdr"
fi

# preferred（backend=none のときの起動先）
preferred="none"
if command -v herdr >/dev/null 2>&1; then
  preferred="herdr"
fi

herdr_bin=""
pi_bin=""
command -v herdr >/dev/null 2>&1 && herdr_bin="$(command -v herdr)"
command -v pi >/dev/null 2>&1 && pi_bin="$(command -v pi)"

# herdr server 状態: `herdr status` が成功すれば running
herdr_server="unknown"
if [[ -n "$herdr_bin" ]]; then
  if herdr status >/dev/null 2>&1; then
    herdr_server="running"
  else
    herdr_server="stopped"
  fi
fi

in_mux="false"
[[ "$backend" == "herdr" ]] && in_mux="true"

# python3 で JSON を組み立てる（jq 不要）
python3 - "$backend" "$preferred" "${HERDR_ENV:-0}" "$herdr_bin" "$pi_bin" "$herdr_server" "$in_mux" <<'PY'
import json, sys
backend, preferred, herdr_env, herdr_bin, pi_bin, herdr_server, in_mux = sys.argv[1:]
print(json.dumps({
    "ok": True,
    "agent": "pi",
    "backend": backend,
    "preferred": preferred,
    "herdr_env": herdr_env == "1",
    "herdr_bin": herdr_bin or None,
    "pi_bin": pi_bin or None,
    "herdr_server": herdr_server,
    "in_mux": in_mux == "true",
}))
PY
