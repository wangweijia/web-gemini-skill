#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
app_path="${repo_root}/dist/GLAB.app"
contents="${app_path}/Contents"
node_path="$(command -v node)"

if [[ ! -f "${repo_root}/cli/node_modules/ws/package.json" ]]; then
  print -u2 '缺少 CLI 依赖，请先在 cli 目录运行 npm ci'
  exit 1
fi
if [[ -z "${node_path}" ]]; then
  print -u2 '未找到 Node.js，请先安装 Node.js 20 或更新版本'
  exit 1
fi

mkdir -p "${contents}/MacOS" "${contents}/Resources/cli" "${contents}/Resources/runtime"
mkdir -p "${repo_root}/dist/.swift-module-cache"
cp "${repo_root}/mac/Info.plist" "${contents}/Info.plist"
cp "${node_path}" "${contents}/Resources/runtime/node"
chmod 755 "${contents}/Resources/runtime/node"
for filename in server.js service.js origins.js chunk-writer.js skill-authoring.js skills-directory.js package.json; do
  cp "${repo_root}/cli/${filename}" "${contents}/Resources/cli/${filename}"
done
cp -R "${repo_root}/cli/node_modules" "${contents}/Resources/cli/"
/usr/bin/swiftc -target arm64-apple-macos13.0 -module-cache-path "${repo_root}/dist/.swift-module-cache" -O "${repo_root}/mac/GLABApp.swift" -o "${contents}/MacOS/GLAB"
/usr/bin/codesign --force --deep --sign - "${app_path}"
print "已生成 ${app_path}"
