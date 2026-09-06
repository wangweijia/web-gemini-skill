# General Local Agent Bridge (GLAB) 🚀

General Local Agent Bridge (GLAB) 是一个能够桥接 **AI 网页端对话框** 与 **本地操作系统环境** 的浏览器扩展与本地代理服务系统。它通过高度集成的注入式侧边抽屉面板和安全本地 WebSocket 代理，当前适配 Gemini 和 ChatGPT，允许网页 AI 读取/写入你的项目代码、执行本地脚本 (Skills)、甚至通过模拟剪贴板粘贴多模态文件。


---

通用名称采用 GLAB，现有 `glab-call` 协议、`GLAB_WORK_DIR` 环境变量和扩展配置键保持兼容。站点域名、DOM 选择器及 `gemini` / `gpt` 路由标识用于对应模型适配。

## 📂 项目结构

```text
glab/
├── extension/          # 浏览器扩展目录 (Chrome Extension MV3)
│   ├── manifest.json   # 扩展配置文件
│   ├── content.js      # 核心逻辑 (DOM 监听、仿真回填、多模态粘贴、自动发送等)
│   └── background.js   # 扩展后台服务
├── cli/                # 本地 OS 代理服务端 (WebSocket Server)
│   ├── server.js       # Node.js WebSocket 服务，集成 Path Jail 目录锁及安全沙箱
│   └── package.json    # CLI 项目依赖
├── prd/                # 产品需求与技术规范设计文档
└── README.md           # 本文档说明
```

---

## ✨ 核心特性

- 💎 **Glassmorphism 注入式控制面板**：无感深度集成在聊天页面右下角的浮动抽屉，支持彩色呼吸灯状态提示、实时步骤深度计数器、写操作双栏 Diff 预览及终端日志流。
- 🔒 **Path Jail 安全沙箱隔离**：本地 CLI 服务端启动时必须显式绑定工作根目录，拒绝一切越权访问及相对路径逃逸（如 `../` 越权读取）。
- 📂 **多模态文件粘贴模拟**：接收本地文件的 Base64 编码，在浏览器端还原为原生的 `Blob` 与 `File` 容器，通过构建 `DataTransfer` 并派发 `ClipboardEvent('paste')` 粘贴事件，完美模拟真实剪贴板，使网页 AI 具备本地文件的多模态理解与解析能力。
- ⛓️ **多步骤队列与汇总反馈**：支持在单次请求中投递多项连续的指令，自动串行执行，并在全部执行结束后统一回填汇总信息，防止单个子任务直接截断流程。
- ⚙️ **无状态 `autoSend` 控制参数**：支持通过 JSON 指令内可选的 `autoSend` 控制是否在回填文本及粘贴完文件后自动发送至当前聊天页面。若为 `false`，则自动挂起并等待用户手动审核。
- 🔄 **强健的回填与发送重试机制**：
  - **输入兜底**：使用 `execCommand('insertHTML')` 写入并触发 React 状态绑定事件。若因焦点丢失写入失效，会自动触发 DOM `innerHTML` 直接改写作为强力兜底。
  - **轮询重试**：针对 SPA 页面重绘导致发送按钮延迟启用的情况，采用 200ms 的轮询重试机制（最高 10 次，共 2 秒），确保 100% 成功点击发送，并在成功后自动重置深度步骤计数器。

---

## 🛠️ 安装与配置说明

### 1. 导入 Chrome 浏览器扩展
1. 打开 Chrome 浏览器，导航至 `chrome://extensions/`。
2. 开启右上角的 **“开发者模式”** (Developer Mode)。
3. 点击 **“加载已解压的扩展程序”** (Load unpacked)。
4. 选择本项目中的 `extension` 文件夹导入。

### 2. 启动本地 CLI 代理服务
本地服务运行在 Node.js 环境中，需要首先安装依赖：
```bash
cd cli
npm install
```
启动服务时，可选择性通过 `--skills-dir` 提供指定的脚本技能目录，或者用 `--port` 指定自定义端口（默认为 9003）。默认不传参数启动即可：
```bash
node server.js
```
> [!NOTE]
> 新安装默认使用 `~/.glab-skills`。若新目录不存在而旧目录 `~/.web-gemini-skill` 已存在，则继续使用旧目录，不自动搬迁文件。插件保存的 Skills 路径优先于 CLI 默认值，`--skills-dir=/绝对路径` 可指定 CLI 默认目录。

### 3. 初始化连接与运行
1. 打开 [Gemini](https://gemini.google.com/) 或 [ChatGPT](https://chatgpt.com/)。
2. 你将会在页面右下角发现一个 **🤖 机器人悬浮球**。即使你从未设置过本地路径，插件启动时也会自动连接至本地 CLI 服务。
3. 点击悬浮球展出抽屉面板，直接点击工作根目录旁的 **[📂 选择]** 按钮，CLI 将唤起系统原生文件选择器。选择你想要授权操作的本地项目根目录，然后点击 **[保存配置]**。
4. 保存后双端会自动完成目录锁定的安全握手校验。此时点击 **[🚀 初始化对话规则]**，页面输入框会自动回填初始化 Rules Prompt 并发送，让当前 AI 了解可用的本地指令格式。

---

## 📝 指令集控制规范

AI 可以通过在回答中输出 `language-glab-call` 的 Markdown 代码块来向插件发送指令。

### 单步指令示例：
```glab-call
{
  "id": "check_files",
  "action": "list_dir",
  "params": {
    "path": "./src"
  },
  "autoSend": true
}
```

### 生成新 Skill

AI 创建 Skill 前应先调用只读命令 `prepare_skill`，等待它返回当前连接使用的 Skills 目录、草稿路径、必需文件、`skill.json` 模板、所选运行时检测结果和完整安装流程：

```glab-call
{
  "id": "prepare_my_skill",
  "action": "prepare_skill",
  "params": { "name": "my-skill", "runtime": "python3" },
  "autoSend": true
}
```

然后在工作目录的 `.glab-skill-drafts/my-skill/` 中生成 `skill.json`、`SKILL.md` 和入口脚本。长文件按分片规则逐轮生成。完成后调用：

```glab-call
{
  "id": "install_my_skill",
  "action": "install_skill",
  "params": { "name": "my-skill" },
  "autoSend": true
}
```

`install_skill` 校验配置、入口和说明文档后安装到当前 Skills 目录。它不会覆盖已有 Skill，不会安装依赖或执行脚本；关闭 Auto-run 时需要批准。安装后让 AI 执行 `list_skills` 和 `load_skill` 确认，无需重启服务来刷新列表。

此流程用于新建 Skill；已有同名目录需要另行修复或选择新名称。新增规则需重新加载扩展、刷新聊天并再次初始化，新增 CLI 命令需重启服务。

### 长输出与分轮写入

普通短指令支持批量发送（JSON 数组或多个代码块）。**一个过长命令拆出的各块必须线性分轮**：生成当前块 → 执行成功 → 才生成下一块，不能一次输出多个分块或把它们打包成数组。

需要写入的文件内容超过 2,000 字符或 40 行时，使用 `write_file_chunk` 拆分内容，每片同时满足这两个上限。每轮只生成该文件当前的一片，收到成功反馈后再生成下一片。长脚本先分片写入，全部完成后再单独运行。普通短指令批次的完整 JSON 合计建议不超过约 6,000 字符（保守输出预算，并非平台硬上限），超过时也要分轮等待反馈。

```glab-call
{
  "id": "write_part_0",
  "action": "write_file_chunk",
  "params": {
    "path": "./example.txt",
    "transferId": "example_write_001",
    "chunkIndex": 0,
    "totalChunks": 2,
    "content": "第一部分\n"
  },
  "autoSend": true
}
```

当前片执行成功后，按 `nextChunkIndex` 生成并发送下一片，保持 `path`、`transferId`、`totalChunks` 不变。相同编号和内容的重试不会重复写入；乱序、修改总数或重复编号内容冲突会被拒绝。只有 `complete: true` 才表示目标文件已替换。

需要调整分片大小时，使用新的 `transferId`，从第 0 片重新发送整个文件；这会替代该路径上尚未完成的旧传输。重试记录保存在 CLI 进程内，断线重连可继续，CLI 重启后需重新开始。未完成数据暂存在目标目录旁的 `.glab-chunks-*` 目录中；异常退出可能留下临时目录。

输出截断或消失时，等待生成结束，点击面板的 **反馈输出中断**，让模型减半分片并逐轮重试。插件发现无效 JSON 时会显示提示并暂停本次扫描，不会自动发送错误反馈；已经消失的内容无法自动判断。

更新后需要重启 CLI、重新加载扩展、刷新聊天页面，并再次点击 **初始化对话规则**。

运行回归测试：`node --test tests/*.test.cjs`。

### 多步骤队列指令示例：
```glab-call
[
  {
    "id": "list_images",
    "action": "list_dir",
    "params": {
      "path": "./images"
    }
  },
  {
    "id": "paste_selected_img",
    "action": "paste_file",
    "params": {
      "path": "./images/test.png"
    },
    "autoSend": true
  }
]
```

### 支持指令一览：
| 指令名称 (`action`) | 说明 | 参数限制与规范 |
| :--- | :--- | :--- |
| `list_dir` | 列出相对路径下的子文件与目录 | `path` (string, 可选) |
| `read_file` | 读取指定相对路径下的文件内容 | `path` (string, 必填), `maxBytes` (number, 可选) |
| `write_file` | 在相对路径下新建或写覆盖文件 | `path` (string, 必填), `content` (string, 必填) |
| `update_file` | 应用 Patch 补丁增量修改已有文件 | `path` (string, 必填), `mode`: "patch", `patches`: `[{find, replace}]` |
| `run_code` | 在 CLI 端的 VM 沙箱中执行临时 JS 代码 | `code` (string, 必填) |
| `run_command` | 在本地工作根目录下执行指定的 Shell 命令行指令 | `command` (string, 必填) |
| `paste_file` | 将本地文件作为剪贴板内容粘贴入输入框 | `path` (string, 必填) |
| `prepare_skill` | 获取生成 Skill 的目录、格式、环境及安装条件（只读） | `name` (string, 必填), `runtime` (可选，默认 python3) |
| `install_skill` | 校验并安装工作目录内的 Skill 草稿，不覆盖已有目录 | `name` (string, 必填) |
| `list_skills` | 列出 Skills 目录下已声明的所有技能脚本 | 无 |
| `load_skill` | 加载指定技能脚本的入口内容与文档 | `name` (string, 必填) |
| `run_skill` | 触发执行指定技能脚本，并传递参数 | `name` (string, 必填), `args` (object, 可选) |

---

## ⚖️ 安全机制

1. **Auto-run 开关**：在关闭 Auto-run 模式时，任何写/变更操作（`write_file`, `update_file`, `run_code`, `run_command`, `run_skill`）均会触发浏览器端抽屉的二次确认。插件会展示 Diff 变更内容，仅在用户手工点击 `[✔️ 批准]` 后，指令才会下发给 CLI 执行。
2. **防 AI 陷入死循环限制**：单轮自动化执行步骤深度上限设为 `10`，达到后自动切断自动执行以防资源消耗，由用户确认后手动接管。
