#!/usr/bin/env bash
# paseo-install-local.sh — 把当前仓库源码以「npm 全局安装」的方式装到系统里
#
# 效果等同于官方文档的：
#   npm install -g @getpaseo/server @getpaseo/cli
# 区别：装的是当前 checkout 的源码（含本分支全部改动），而不是 npm registry 上的发布版。
#
# 做法（为什么不是直接 npm i -g 仓库目录）：
#   workspace 里的 @getpaseo/* 互相依赖（如 cli → server/client/protocol），registry 上
#   只有旧版 0.2.3，直接全局安装仓库目录会让 npm 回 registry 拉旧版。所以先：
#     1. npm pack 出各 workspace 包的 tarball
#     2. 把每个包 package.json 里的 @getpaseo/* 依赖重写成 file: 引用
#     3. 用 --ignore-scripts 二次打包成自包含 tarball（跳过 prepack，保住 file: 改写）
#     4. npm install -g <cli 最终 tarball>
#
# 用法：
#   ./scripts/paseo-install-local.sh                      # 打包 + 全局安装（询问后重启 daemon）
#   ./scripts/paseo-install-local.sh --no-restart         # 装完不重启 daemon
#   ./scripts/paseo-install-local.sh --restart            # 装完直接重启（危险：中断运行中的 agent）
#   ./scripts/paseo-install-local.sh --pack-only          # 只打自包含 tarball，不做全局安装
#   ./scripts/paseo-install-local.sh --release-dir DIR    # 产出可分发目录（tarball + install.sh），可拷到任何机器
#   ./scripts/paseo-install-local.sh --uninstall          # 卸载全局安装
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RESTART_MODE="ask" # ask | yes | no
PACK_ONLY=0
UNINSTALL=0
RELEASE_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-restart) RESTART_MODE="no"; shift ;;
    --restart) RESTART_MODE="yes"; shift ;;
    --pack-only) PACK_ONLY=1; shift ;;
    --release-dir) RELEASE_DIR="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

# ---------- 卸载 ----------
if [[ "$UNINSTALL" == "1" ]]; then
  echo "==> 卸载全局 @getpaseo/cli（连带 @getpaseo/* 依赖）"
  npm uninstall -g @getpaseo/cli
  echo "✅ 已卸载。仓库内的 node_modules 与 dist 不受影响。"
  exit 0
fi

STAGING="$REPO_ROOT/.dev/global-install"
RAW_DIR="$STAGING/tarballs-raw" # npm pack 原始产物
FINAL_DIR="$STAGING/tarballs"   # file: 重写后的最终 tarball（路径为本机绝对路径）
PKG_DIR="$STAGING/pkg"          # 解包 + 改写的中间目录
NPM_CACHE="$STAGING/npm-cache"

# 工作区里以 @getpaseo/* 互相引用、registry 上版本对不上、必须本地打包的包
LOCAL_PACKAGES=(highlight relay protocol client server cli)

echo "==> [1/5] 检查依赖与构建产物"
if [[ ! -d node_modules ]]; then
  echo "    仓库尚未安装依赖，执行 npm install（约几分钟）..."
  npm install
fi

need_build=0
for pkg in "${LOCAL_PACKAGES[@]}"; do
  [[ -d "packages/$pkg/dist" ]] || need_build=1
done
if [[ "$need_build" == "1" ]]; then
  echo "    存在未构建的包，执行 npm run build:server ..."
  npm run build:server
else
  echo "    dist 产物已存在，跳过构建（如需强制重建请先 npm run build:server）"
fi

echo "==> [2/5] npm pack 各 workspace 包（prepack 会重建，约 1-2 分钟）"
rm -rf "$STAGING"
mkdir -p "$RAW_DIR" "$FINAL_DIR" "$PKG_DIR" "$NPM_CACHE"

pkg_name() { node -p "require('./packages/$1/package.json').name"; }
pkg_ver() { node -p "require('./packages/$1/package.json').version"; }
# @getpaseo/cli → getpaseo-cli-0.2.0.tgz
tgz_basename() {
  local scope_short="${1#@}"
  scope_short="${scope_short/\//-}"
  echo "${scope_short}-$2.tgz"
}

declare -A PKG_VER=()
for pkg in "${LOCAL_PACKAGES[@]}"; do
  PKG_VER[$(pkg_name "$pkg")]=$(pkg_ver "$pkg")
done

for pkg in "${LOCAL_PACKAGES[@]}"; do
  npm pack --workspace "packages/$pkg" --pack-destination "$RAW_DIR" >/dev/null
  echo "    ✓ $(pkg_name "$pkg")@${PKG_VER[$(pkg_name "$pkg")]}"
done

echo "==> [3/5] 解包并把 @getpaseo/* 依赖重写为 file:<tarball 绝对路径>"
declare -A RAW_TGZ=()
for pkg in "${LOCAL_PACKAGES[@]}"; do
  name=$(pkg_name "$pkg")
  RAW_TGZ[$name]="$RAW_DIR/$(tgz_basename "$name" "${PKG_VER[$name]}")"
done
export TGZ_LIST="$(printf '%s\n' "${RAW_TGZ[@]}")"

for pkg in "${LOCAL_PACKAGES[@]}"; do
  name=$(pkg_name "$pkg")
  short="${name#@getpaseo/}"
  dest="$PKG_DIR/$short"
  mkdir -p "$dest"
  tar -xzf "${RAW_TGZ[$name]}" -C "$dest" --strip-components=1
  node - "$dest/package.json" <<'JS'
const fs = require("fs");
const pkgPath = process.argv[2];
const tgzByName = {};
for (const p of (process.env.TGZ_LIST || "").trim().split("\n")) {
  const base = p.split("/").pop(); // getpaseo-cli-0.2.0.tgz
  const m = base.match(/^getpaseo-(.+)-(\d+\.\d+\.\d+.*)\.tgz$/);
  if (m) tgzByName[`@getpaseo/${m[1]}`] = p;
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
let rewritten = 0;
for (const section of ["dependencies", "optionalDependencies"]) {
  if (!pkg[section]) continue;
  for (const dep of Object.keys(pkg[section])) {
    if (tgzByName[dep]) {
      pkg[section][dep] = `file:${tgzByName[dep]}`;
      rewritten++;
    }
  }
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
if (rewritten > 0) console.log(`    ✓ ${pkg.name}: 重写 ${rewritten} 个内部依赖`);
JS
done

echo "==> [4/5] 二次打包为自包含 tarball（--ignore-scripts 保住 file: 改写）"
declare -A FINAL_TGZ=()
for pkg in "${LOCAL_PACKAGES[@]}"; do
  name=$(pkg_name "$pkg")
  short="${name#@getpaseo/}"
  (cd "$PKG_DIR/$short" && npm pack --pack-destination "$FINAL_DIR" --ignore-scripts >/dev/null)
  FINAL_TGZ[$name]="$FINAL_DIR/$(tgz_basename "$name" "${PKG_VER[$name]}")"
  echo "    ✓ $(basename "${FINAL_TGZ[$name]}")"
done

# ---------- 产出可分发 release 目录 ----------
if [[ -n "$RELEASE_DIR" ]]; then
  echo "==> 产出可分发目录 $RELEASE_DIR"
  rm -rf "$RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  # release 目录布局：6 个自包含 tarball + install.sh。
  # 所有 tarball 内的 @getpaseo/* 依赖都改写成 file:./<同目录文件名>（相对路径），
  # 因此整个目录拷到任何机器、从任何 cwd 执行 install.sh 都能解析。
  #
  # 先拷原件（占住文件名），再对含内部依赖的包做「相对路径重写 + 重打」。
  for pkg in "${LOCAL_PACKAGES[@]}"; do
    name=$(pkg_name "$pkg")
    cp "${RAW_TGZ[$name]}" "$RELEASE_DIR/"
  done
  # 重写函数：解包 → @getpaseo/* 依赖改 file:./<basename> → --ignore-scripts 重打
  repack_relative() {
    local pkg="$1"
    local name short dest
    name=$(pkg_name "$pkg")
    short="${name#@getpaseo/}"
    dest="$RELEASE_DIR/.pkg-$short"
    mkdir -p "$dest"
    tar -xzf "${RAW_TGZ[$name]}" -C "$dest" --strip-components=1
    node - "$dest/package.json" "$RELEASE_DIR" <<'JS'
const fs = require("fs");
const pkgPath = process.argv[2];
const releaseDir = process.argv[3];
const tgzByName = {};
for (const f of fs.readdirSync(releaseDir)) {
  const m = f.match(/^getpaseo-(.+)-(\d+\.\d+\.\d+.*)\.tgz$/);
  if (m) tgzByName[`@getpaseo/${m[1]}`] = `./${f}`;
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
let rewritten = 0;
for (const section of ["dependencies", "optionalDependencies"]) {
  if (!pkg[section]) continue;
  for (const dep of Object.keys(pkg[section])) {
    if (tgzByName[dep]) {
      pkg[section][dep] = `file:${tgzByName[dep]}`;
      rewritten++;
    }
  }
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`    ✓ ${pkg.name}: release 相对路径重写 ${rewritten} 个`);
JS
    (cd "$dest" && npm pack --pack-destination "$RELEASE_DIR" --ignore-scripts >/dev/null)
    rm -rf "$dest"
  }
  # 含 @getpaseo/* 内部依赖的包：
  #   cli    → client/protocol/server
  #   server → client/highlight/protocol/relay
  #   client → protocol/relay
  repack_relative client
  repack_relative server
  repack_relative cli
  cat > "$RELEASE_DIR/install.sh" <<'EOS'
#!/usr/bin/env bash
# 在目标机器上执行：cd 到本目录后运行 ./install.sh
# 或从任意目录运行 /path/to/本目录/install.sh（脚本会自动切到自身目录）。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
npm install -g ./getpaseo-cli-*.tgz --no-audit --no-fund
echo "✅ 安装完成: $(command -v paseo)"
EOS
  chmod +x "$RELEASE_DIR/install.sh"
  echo "    ✓ 目录内容："
  ls -1 "$RELEASE_DIR" | sed 's/^/      /'
  echo ""
  echo "    分发方式：整个目录拷到目标机器（或作为 GitHub Release assets 上传），"
  echo "    在目标机器执行 ./install.sh 即可全局安装。"
  echo ""
fi

if [[ "$PACK_ONLY" == "1" || -n "$RELEASE_DIR" ]]; then
  if [[ "$PACK_ONLY" == "1" ]]; then
    echo ""
    echo "📦 打包完成（--pack-only，未做全局安装）。tarball 位于："
    ls -1 "$FINAL_DIR"
  fi
  exit 0
fi

echo "==> [5/5] npm install -g @getpaseo/cli（file: 链解析全部内部依赖）"
npm install -g "${FINAL_TGZ[@getpaseo/cli]}" \
  --cache "$NPM_CACHE" \
  --no-audit --no-fund

echo ""
GLOBAL_ROOT="$(npm root -g)"
installed_ver="$(node -p "require('$GLOBAL_ROOT/@getpaseo/cli/package.json').version" 2>/dev/null || echo '?')"
echo "    全局安装路径: $GLOBAL_ROOT/@getpaseo/cli"
echo "    paseo 命令:    $(command -v paseo || echo '(未在 PATH 中)')"
echo "    安装版本:      $installed_ver（当前仓库 checkout）"

echo ""
echo "验证命令："
echo "    paseo daemon status"

case "$RESTART_MODE" in
  yes)
    echo ""
    echo "==> 按 --restart 重启 daemon（会中断正在运行的 agent）"
    paseo daemon restart
    ;;
  no)
    echo ""
    echo "提示：已在运行中的 daemon 仍是旧进程。要让全局安装版本接管，请手动执行："
    echo "    paseo daemon restart    # ⚠️ 会中断正在运行的 agent，确认后再执行"
    ;;
  ask)
    echo ""
    read -r -p "是否现在重启 6767 daemon 让全局安装版本接管？会中断运行中的 agent。[y/N] " ans
    if [[ "${ans,,}" == "y" ]]; then
      paseo daemon restart
    else
      echo "    已跳过。稍后手动执行: paseo daemon restart"
    fi
    ;;
esac

echo ""
echo "🎉 完成。卸载请运行: $0 --uninstall"
echo "   （中间产物在 $STAGING，可整目录删除；$FINAL_DIR 里的 tarball 可复制到其它机器复用）"
