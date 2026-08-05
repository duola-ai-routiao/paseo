#!/usr/bin/env bash
# paseo-enroll.sh — 本地 Paseo daemon 飞书登录 + 中继器 enrollment 一键脚本
#
# 流程（与 packages/server/src/server/hub/ginit-enroller.ts 一致）：
#   1. POST {BASE}/auth/device/start            → 拿 device_code + verification_uri
#   2. 浏览器打开 verification_uri 完成飞书授权
#   3. 轮询 POST {BASE}/auth/device/poll        → 拿 ginit_ user token
#   4. 生成/复用 Ed25519 设备密钥对             → ~/.paseo/hub-device-keypair.json
#   5. POST {BASE}/api/paseo/enrollments        → enrollment ticket
#   6. POST {BASE}/api/paseo/enrollments/redeem → pht_ 设备 token
#   7. 写回 ~/.paseo/config.json 的 daemon.hub / daemon.relay
#   8. 重启 daemon 生效
#
# 用法：
#   ./scripts/paseo-enroll.sh                      # 完整流程（device flow + enroll）
#   ./scripts/paseo-enroll.sh --token ginit_xxx    # 已有 user token，跳过浏览器授权
#   ./scripts/paseo-enroll.sh --status             # 只查当前 enrollment 状态
#
set -euo pipefail

# ---------- 参数 ----------
GINIT_BASE="${GINIT_BASE:-http://150.5.173.43:8090}"   # ginit-server HTTP API
HUB_WS_URL="${HUB_WS_URL:-ws://150.5.173.43:8235/ws/v1/paseo}"  # Hub WS 网关
RELAY_ENDPOINT="${RELAY_ENDPOINT:-150.5.173.43:8234}"  # 自托管 relay
PASEO_HOME_DIR="${PASEO_HOME:-$HOME/.paseo}"
PASEO_CLI="${PASEO_CLI:-/home/alan/paseo/packages/cli/bin/paseo}"
USER_TOKEN=""
STATUS_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token) USER_TOKEN="$2"; shift 2 ;;
    --status) STATUS_ONLY=1; shift ;;
    --base) GINIT_BASE="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

CONFIG="$PASEO_HOME_DIR/config.json"
KEYPAIR="$PASEO_HOME_DIR/hub-device-keypair.json"

# ---------- 状态查询 ----------
if [[ "$STATUS_ONLY" == "1" ]]; then
  python3 - "$CONFIG" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
h = c.get("daemon", {}).get("hub", {})
print("hub.enabled:   ", h.get("enabled"))
print("hub.url:       ", h.get("url"))
print("hub.deviceId:  ", h.get("deviceId"))
print("hub.token:     ", (h.get("token") or "")[:12] + "..." if h.get("token") else None)
print("ginitBaseUrl:  ", h.get("ginitBaseUrl"))
print("ginitToken:    ", (h.get("ginitToken") or "")[:12] + "..." if h.get("ginitToken") else None)
PY
  exit 0
fi

# ---------- Step 1-3: 拿 ginit_ user token ----------
if [[ -z "$USER_TOKEN" ]]; then
  echo "==> [1/3] 发起飞书 device flow ..."
  START=$(curl -sf -X POST "$GINIT_BASE/auth/device/start")
  DEVICE_CODE=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['device_code'])" "$START")
  VERIFY_URI=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['verification_uri'])" "$START")
  EXPIRES=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['expires_in'])" "$START")

  echo ""
  echo "  请在浏览器打开以下链接完成飞书授权（${EXPIRES}s 内有效）："
  echo ""
  echo "      $VERIFY_URI"
  echo ""
  # 尝试自动打开浏览器（有桌面环境时）
  command -v xdg-open >/dev/null && xdg-open "$VERIFY_URI" 2>/dev/null || true

  echo "==> [2/3] 等待授权（每 3s 轮询，超时 ${EXPIRES}s）..."
  DEADLINE=$(( $(date +%s) + EXPIRES ))
  while [[ $(date +%s) -lt $DEADLINE ]]; do
    POLL=$(curl -s -X POST "$GINIT_BASE/auth/device/poll" \
      -H "content-type: application/json" \
      -d "{\"device_code\": \"$DEVICE_CODE\"}" || true)
    STATUS=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('status',''))" "$POLL" 2>/dev/null || echo "")
    if [[ "$STATUS" == "completed" ]]; then
      USER_TOKEN=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['token'])" "$POLL")
      break
    fi
    sleep 3
  done
  [[ -z "$USER_TOKEN" ]] && { echo "❌ 授权超时，请重试" >&2; exit 1; }
  echo "    ✅ 拿到 user token: ${USER_TOKEN:0:12}..."
else
  echo "==> 使用已有 user token: ${USER_TOKEN:0:12}..."
fi

# ---------- Step 4: 设备密钥对（复用或生成，格式与 device-keypair.ts 一致） ----------
echo "==> [3/3] 准备设备密钥对 ..."
node - "$KEYPAIR" <<'JS'
const fs = require("fs");
const crypto = require("crypto");
const file = process.argv[2];

function deviceIdFor(pubB64) {
  const chars = crypto.createHash("sha256").update(pubB64).digest("hex").slice(0, 32).split("");
  chars[12] = "5"; chars[16] = "a";
  const hex = chars.join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

if (fs.existsSync(file)) {
  const k = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`    复用已有 keypair, deviceId=${k.deviceId}`);
} else {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const bundle = { v: 1, deviceId: deviceIdFor(pubB64), publicKeyB64: pubB64, privateKeyB64: privB64, secretKeyB64: privB64 };
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
  console.log(`    已生成新 keypair → ${file}, deviceId=${bundle.deviceId}`);
}
JS

DEVICE_ID=$(python3 -c "import json; print(json.load(open('$KEYPAIR'))['deviceId'])")
PUBLIC_KEY=$(python3 -c "import json; print(json.load(open('$KEYPAIR'))['publicKeyB64'])")
SERVER_ID=$(cat "$PASEO_HOME_DIR/server-id" 2>/dev/null | tr -d '[:space:]' || true)
[[ -z "$SERVER_ID" ]] && SERVER_ID="srv_$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)"

# ---------- Step 5-6: enroll + redeem ----------
echo "==> enrollment ticket ..."
TICKET_RES=$(curl -sf -X POST "$GINIT_BASE/api/paseo/enrollments" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $USER_TOKEN")
TICKET=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['ticket'])" "$TICKET_RES")

echo "==> redeem 换 pht_ 设备 token (device: $DEVICE_ID, daemon: $SERVER_ID) ..."
REDEEM_RES=$(curl -s -X POST "$GINIT_BASE/api/paseo/enrollments/redeem" \
  -H "content-type: application/json" \
  -d "{\"ticket\": \"$TICKET\", \"device\": {\"device_id\": \"$DEVICE_ID\", \"daemon_id\": \"$SERVER_ID\", \"public_key\": \"$PUBLIC_KEY\", \"name\": \"paseo-$(hostname)\"}}")

if ! echo "$REDEEM_RES" | python3 -c "import json,sys; json.loads(sys.argv[1])['token']" "$REDEEM_RES" 2>/dev/null; then
  if echo "$REDEEM_RES" | grep -q "device_id already enrolled"; then
    echo "    ⚠️  设备已 enroll 过（device_id already enrolled）"
    echo "    pht_ 明文 token 无法找回（hub 只存 HMAC hash）。选项："
    echo "      1) 若 ~/.paseo/config.json 里已有 hub.token，直接复用即可，无需重新 enroll"
    echo "      2) 想换绑账号：先 DELETE $GINIT_BASE/api/paseo/devices/$DEVICE_ID （带旧账号 token），再重跑本脚本"
    exit 1
  fi
  echo "❌ redeem 失败: $REDEEM_RES" >&2
  exit 1
fi
DEVICE_TOKEN=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['token'])" "$REDEEM_RES")
echo "    ✅ pht_ token: ${DEVICE_TOKEN:0:12}..."

# ---------- Step 7: 写回 config.json ----------
echo "==> 写回 $CONFIG ..."
python3 - "$CONFIG" "$HUB_WS_URL" "$DEVICE_ID" "$DEVICE_TOKEN" "$GINIT_BASE" "$USER_TOKEN" "$RELAY_ENDPOINT" <<'PY'
import json, sys
path, hub_url, device_id, device_token, base, user_token, relay = sys.argv[1:8]
try:
    c = json.load(open(path))
except FileNotFoundError:
    c = {}
d = c.setdefault("daemon", {})
d["hub"] = {
    "enabled": True,
    "url": hub_url,
    "deviceId": device_id,
    "token": device_token,
    "ginitBaseUrl": base,
    "ginitToken": user_token,
}
r = d.setdefault("relay", {})
r.update({"enabled": True, "endpoint": relay, "publicEndpoint": relay,
          "useTls": False, "publicUseTls": False})
json.dump(c, open(path, "w"), indent=2, ensure_ascii=False)
print("    ✅ daemon.hub + daemon.relay 已写入")
PY

# ---------- Step 8: 重启 daemon ----------
echo "==> 重启 daemon 使配置生效 ..."
if [[ -x "$PASEO_CLI" ]]; then
  "$PASEO_CLI" daemon restart && echo "    ✅ daemon 已重启"
else
  echo "    ⚠️  未找到 paseo CLI ($PASEO_CLI)，请手动重启 daemon"
fi

echo ""
echo "🎉 完成。验证："
echo "   本脚本状态:  $0 --status"
echo "   hub 侧设备:  curl -s -H 'Authorization: Bearer $USER_TOKEN' $GINIT_BASE/api/paseo/devices | python3 -m json.tool"
echo "   日志确认:    grep hub-connector $PASEO_HOME_DIR/daemon.log | tail -3   # 期望看到 'Hub welcome received; device online'"
