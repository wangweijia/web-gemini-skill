# GLAB 技术方案评估与优化建议报告

针对 `Gemini Script Runner Extension PRD.md` 规约文档，从系统架构、安全边界、通信机制、状态管理与容错五个核心维度进行了深度评估，特制定本优化建议报告。

---

## 1. 核心安全隐患：`run_code` 动作缺乏实质隔离
* **问题分析**：PRD 4.2 提到“在 Node.js 中使用内置 `vm` 模块执行代码”。Node.js 官方文档明确指出：`vm` 模块并不是一个安全沙箱，不能用来执行不受信任的代码。由于 `run_code` 最终由 AI 生成，一旦 AI 产生幻觉或被恶意注入，生成的代码可以通过原型链污染轻松逃逸出 `vm`，从而直接控制 Mac 宿主机，使安全路径锁（Path Jail）形同虚设。
* **修改意见**：
  * **方案 A（彻底移除）**：由于方案中已经设计了完整的 `Skills` 架构（支持 Python/Node/Bash 脚本），建议直接废弃 `run_code` 动作，所有复杂逻辑转由本地预设的、代码可控的 `run_skill` 来承载。
  * **方案 B（替换为真沙箱）**：如果必须保留 `run_code` 动态执行能力，必须在本地 CLI 中引入类似 `isolated-vm` 或 `safe-eval` 这种基于 V8 Isolate 级别隔离的硬沙箱库，绝对不能使用原生 `vm` 模块。

---

## 2. 双端路径握手（`shakehand`）逻辑的死锁风险
* **问题分析**：在 `content.js` 的 `connectSocket` 中，一旦 WebSocket 连接成功，插件会发送 `shakehand` 校验路径。如果路径不一致，CLI 返回错误，插件端会弹窗 `alert()` 并将状态切为 `error`。但是，在 `socket.onclose` 中，设计了 `setTimeout(connectSocket, 5000)` 无条件自动重连。这会导致当用户配置填错时，浏览器每 5 秒就会弹出一个阻塞式的 `alert()` 且无线循环，导致页面直接卡死。
* **修改意见**：
  * 修改 `onclose` 的重连策略。引入一个状态锁，在握手失败（明确属于配置错误，而不是网络断开）时，**不要触发自动重连**，维持 `error` 状态，并在侧边栏面板显式提示“路径不匹配，请修改配置后手动点击 [🚀 Init GLAB] 重新连接”。

---

## 3. 潜在的通信死锁：缺少“指令确认机制”
* **问题分析**：目前的流程是 AI 输出 `glab-call` -> 插件拦截发送给 CLI -> 自动回填结果。这里隐藏着一个死循环隐患：如果 AI 生成了错误的 JSON 格式（例如少了个括号），插件在 `try...catch` 中将状态切为 `error`，但没有把这个错误反馈给 Gemini 网页。此时自动流程中断，AI 并不知道自己输出了错误格式，用户必须手动介入。
* **修改意见**：
  * 在插件解析 JSON 失败的 `catch` 分支中，也应当向 Gemini 网页回填一条报错提示（例如：`【GLAB 异常反馈】指令解析失败，请检查您的 JSON 语法。`），让 AI 有机会在下一轮对话中自我修正（Self-Correction），维持自动流的鲁棒性。

---

## 4. 大文件读取分片机制不完整
* **问题分析**：PRD 4.3 针对 `read_file` 做了超过 `maxBytes`（默认 50KB）自动截断的处理。然而，方案中并没有提供“读取下一片（Offset/Page）”的参数设计。当 AI 需要分析一个较大的日志或代码文件时，它永远只能拿到前 50KB，会陷入无法获取完整上下文的僵局。
* **修改意见**：
  * 在 `read_file` 的 `params` 协议中，增加 `offset` (number) 或 `page` (number) 参数。
  * 改进 CLI 实现，允许 AI 根据上一次返回的截断提示，主动发起 `{ "action": "read_file", "params": { "path": "...", "offset": 50000 } }` 来获取后续内容。

---

## 5. `MutationObserver` 性能与边界问题
* **问题分析**：
  * `content.js` 采用 `observer.observe(document.body, { childList: true, subtree: true })` 监听了整个 body 的微小变动。在 Gemini 这种高频渲染长文本的重度 SPA 网页上，这会引发海量的回调，导致页面出现可见的卡顿。
  * 采用 `execCommand` 写入文本后，300ms~500ms 的硬编码延时（`setTimeout`）在网络或网页渲染卡顿时，极易出现“发送按钮还未激活就触发了 `.click()`”的竞态条件。
* **修改意见**：
  * **缩小监听范围**：在 window 加载后，先等待主要聊天容器（如 `main` 标签或包含聊天历史的特定 `div`）挂载，然后仅监听该聊天区域。
  * **动态检测按钮状态**：在准备发送时，使用一个短间隔的轮询器（如每 50ms 检查一次 `sendButton.disabled`），直到按钮真正可用时再触发点击，或者利用 `MutationObserver` 专门监听发送按钮的 `disabled` 属性变更。
