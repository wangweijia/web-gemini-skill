# Gemini Local Agent Bridge (GLAB) 🚀

Gemini Local Agent Bridge (GLAB) 是一个能够无缝桥接 **Gemini 网页端对话框** 与 **本地操作系统环境** 的浏览器扩展与本地代理服务系统。它通过高度集成的注入式侧边抽屉面板和安全本地 WebSocket 代理，允许 Gemini 直接安全地读取/写入你的项目代码、执行本地脚本 (Skills)、甚至通过模拟剪贴板粘贴多模态文件。

---

## 📂 项目结构

```text
web-gemini-skill/
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

- 💎 **Glassmorphism 注入式控制面板**：无感深度集成在 Gemini 右下角的浮动抽屉，支持彩色呼吸灯状态提示、实时步骤深度计数器、写操作双栏 Diff 预览及终端日志流。
- 🔒 **Path Jail 安全沙箱隔离**：本地 CLI 服务端启动时必须显式绑定工作根目录，拒绝一切越权访问及相对路径逃逸（如 `../` 越权读取）。
- 📂 **多模态文件粘贴模拟**：接收本地文件的 Base64 编码，在浏览器端还原为原生的 `Blob` 与 `File` 容器，通过构建 `DataTransfer` 并派发 `ClipboardEvent('paste')` 粘贴事件，完美模拟真实剪贴板，使 Gemini 具备本地文件的多模态理解与解析能力。
- ⛓️ **多步骤队列与汇总反馈**：支持在单次请求中投递多项连续的指令，自动串行执行，并在全部执行结束后统一回填汇总信息，防止单个子任务直接截断流程。
- ⚙️ **无状态 `autoSend` 控制参数**：支持通过 JSON 指令内可选的 `autoSend` 控制是否在回填文本及粘贴完文件后自动发送至 Gemini 页面。若为 `false`，则自动挂起并等待用户手动审核。
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
启动服务时，可选择性通过 `--skills-dir` 提供脚本技能目录，或者用 `--port` 指定自定义端口（默认为 9003）：
```bash
node server.js --skills-dir=/path/to/your/skills
```

### 3. 初始化连接与运行
1. 打开 [Gemini Chat](https://gemini.google.com/)。
2. 你将会在页面右下角发现一个带绿色呼吸灯的 **🤖 机器人悬浮球**。
3. 点击悬浮球展出抽屉面板，点击 **[🚀 Init GLAB (设置工作目录)]**，在弹出的窗口中填入你在上一步中指定的绝对路径，点击保存。
4. 页面输入框会自动回填初始化 Rules Prompt 并自动发送以教导 Gemini 学会本地指令的调用格式。

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
| `list_skills` | 列出 Skills 目录下已声明的所有技能脚本 | 无 |
| `load_skill` | 加载指定技能脚本的入口内容与文档 | `name` (string, 必填) |
| `run_skill` | 触发执行指定技能脚本，并传递参数 | `name` (string, 必填), `args` (object, 可选) |

---

## ⚖️ 安全机制

1. **Auto-run 开关**：在关闭 Auto-run 模式时，任何写/变更操作（`write_file`, `update_file`, `run_code`, `run_command`, `run_skill`）均会触发浏览器端抽屉的二次确认。插件会展示 Diff 变更内容，仅在用户手工点击 `[✔️ 批准]` 后，指令才会下发给 CLI 执行。
2. **防 AI 陷入死循环限制**：单轮自动化执行步骤深度上限设为 `10`，达到后自动切断自动执行以防资源消耗，由用户确认后手动接管。
