# GLAB 网页 AI 产出转 ACP 开发计划与设计

> 日期：2026-10-20  
> 开发分支：`feat/gpt-acp-preview`  
> 当前阶段：已实现手动导出与本地预览原型；尚未接入 ACP 消费者。

## 一、目标与边界

将 ChatGPT 网页中的 AI 产出提取为结构化内容，再由 GLAB 转换为 ACP（Agent Client Protocol）消息，供其他项目查看或处理。网页模型本身不需要了解或生成 ACP。

开发分为两类能力，不能混淆协议方向：

| 场景 | GLAB 角色 | ACP 消息 |
|------|-----------|----------|
| 其他项目查看、调用网页 GPT 的回答 | ACP Agent | 通过 `session/update` 的 `agent_message_chunk` 输出回答 |
| 将网页 GPT 的回答交给另一个 Agent 继续处理 | ACP Client | 将回答作为 `session/prompt` 的输入资料 |

`agent_message_chunk` 是输出通知，不是向另一个 Agent 发起任务的请求。不能只把它发给目标 Agent，就期望对方开始执行。

当前没有消费者，先验证以下链路：

```text
GPT 聊天窗
  → 手动提取 AI 回复
  → Markdown 正文
  → GLAB 本地 WebSocket
  → ACP 输出通知快照
  → 本地临时页面查看 / 复制 JSONL
```

当前不实现自动监听转发、实时流式、模型调用、完整 ACP 会话、工具调用映射或跨机器服务。不采集用户消息、未加载的历史、隐藏推理、Cookie 或令牌。

## 二、阶段规划

| 阶段 | 交付内容 | 状态与前置条件 |
|------|----------|----------------|
| P0：只读预览 | 手动导出最新 / 已加载 AI 回复，转换为通知，本地查看与复制 | 当前分支已实现原型，需在真实 GPT 页面试用 |
| P1：转发给其他 Agent | 目标项目配置、ACP Client、初始化与会话建立、发送资料、展示处理结果 | 待开发；以 P0 提取与转换能力为基础，需要确定目标 Agent |
| P2：暴露网页 ACP Agent | stdio 入口、会话隔离、输入回填、回复关联、完成和取消 | 待开发；以 P0 为基础，不依赖 P1 完成 |
| P3：增强能力 | 保守流式、多标签页并发、会话恢复、经授权的工具映射 | 待开发；分别在对应基础能力稳定后推进 |

首要原则是内容正确和会话不串话，不以模拟 token 级流式为第一版目标。

## 三、P0 已实现架构

```text
extension/chat-export.js
  提取 assistant 正文，序列化为 Markdown
          ↓
extension/content.js
  用户确认，发送 acp_preview_capture，处理独立确认消息
          ↓ WebSocket
cli/server.js
  分发只读预览请求，不进入 executeAction
          ↓
cli/acp-preview.js
  校验、转换为 ACP 通知、维护有界内存记录
          ↓ HTTP
cli/acp-preview.html + cli/acp-preview-client.js
  展示正文、JSON、复制 JSONL，每 1.5 秒刷新
```

预览页面与现有 CLI 共用本机端口，默认地址：

```text
http://127.0.0.1:9003/acp-preview
```

自定义端口时随 CLI 和扩展配置一起调整，不额外启动网页服务器。

### 3.1 操作流程

1. 更新 CLI 并重新加载扩展，刷新 GPT 对话页。
2. 等待 AI 输出结束，在 GLAB 面板点击「导出 GPT → ACP」。
3. 默认仅导出最新 AI 回复；取消对应复选框后导出全部已加载 AI 回复。
4. 确认本地导出提示，等待服务确认结果。
5. 点击「查看 ACP 消息」，检查正文与协议 JSON，按需复制 JSONL。

此流程不要求工作目录或初始化对话规则，但需要本地 WebSocket 连接及 GPT 角色握手。导出不回填输入框、不发送模型请求，不执行回答中的 `glab-call`。

原有 Auto-run 和指令监听流程保持不变；导出功能不是全局只读开关，不能据此认为其他已启用的执行流程被禁用。

### 3.2 正文提取

按 DOM 顺序查找 assistant 容器，兼容以下标识：

- `[data-message-author-role="assistant"]`
- `[data-testid="assistant-message"]`
- `[data-markdown-text-style="assistant-message"]`

没有这些标识时，尝试从对话轮次和 `main article` 中定位正文，并排除包含用户消息标识的轮次。对嵌套命中的容器去重，优先序列化内部 `.markdown` 正文。

DOM 是网页私有实现，选择器与回退规则均属于适配启发式，不保证未来网页版本不变，也不保证能恢复未加载的历史。预览是人工核对提取结果的入口。

| 内容 | P0 处理 |
|------|---------|
| 段落、标题、强调、引用、列表 | 转换为 Markdown |
| 代码块 | 保留代码文本和缩进；支持 `pre` 和新版 `data-markdown-copy="code-block"` 容器 |
| 代码围栏 | 根据代码中的反引号长度选择围栏，避免提前闭合 |
| 表格 | 转换为 Markdown 表格 |
| HTTP(S) 绝对链接 | 保留链接文本与 URL |
| 按钮、脚本、样式、导航、GLAB 面板、显式隐藏节点 | 排除 |
| 图片 | 输出未完整导出的占位说明 |
| 附件、复杂公式、网页工具活动 | 不承诺完整、无损转换 |

当前 Markdown 转换不是网页 HTML 的无损导出。内容以文本呈现在预览页，不作为 HTML 执行。

## 四、消息格式与转换规则

### 4.1 浏览器到 CLI：GLAB 内部请求

以下是内部协议，不是 ACP：

```json
{
  "id": "acp_preview_1792488000000",
  "action": "acp_preview_capture",
  "params": {
    "conversationId": "conversation_123",
    "messages": [
      {
        "messageId": "source_message_1",
        "text": "## 建议\n\n先建立独立的消息适配层。"
      }
    ]
  }
}
```

有网页消息 ID 时使用该 ID，否则在本次提取中按位置分配临时标识。没有可识别的对话 URL 时，当前实现使用 `default_session`。这些来源标识不能作为未来多项目路由的可靠唯一键。

客户端确认请求使用 `acp_preview_` 前缀，响应单独处理，不进入模型反馈路径。等待确认超过 10 秒时显示超时；确认超时不代表服务一定没有收到数据，用户应检查预览页后决定是否重试。

### 4.2 CLI 到预览：ACP 输出通知

每次导出分配新的 `preview_<UUID>` 会话标识。每条 AI 回复转换为一条通知：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "preview_example",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "messageId": "preview_example_1",
      "content": {
        "type": "text",
        "text": "## 建议\n\n先建立独立的消息适配层。"
      }
    }
  }
}
```

Markdown 作为 `content.type: "text"` 的内容传输。代码块、标题不需要发明新的 ACP 类型。通知不包含 JSON-RPC 请求 `id`。

预览 HTTP 返回记录数组，每条记录包含 `id`、`capturedAt`、`source`、`sessionId`、`messages`。其中时间、来源等是预览记录元数据，不是新增 ACP 顶层字段。复制 JSONL 时只复制 `messages`，每行一条通知，并以换行结尾。

**预览通知不是完整 ACP 会话。** 当前没有 `initialize`、`session/new` 或待处理的 `session/prompt`，因此不伪造 `end_turn` 响应，也不能把这些快照直接当成一个可调用的 ACP Agent。

### 4.3 本地接口与资源限制

| 接口 / 限制 | 行为 |
|-------------|------|
| WebSocket `acp_preview_capture` | 只接受已登记为 `gpt` 的连接，校验消息后入内存 |
| `GET /acp-preview` | 静态预览页面 |
| `GET /acp-preview.js` | 预览页面脚本 |
| `GET /acp-preview/messages` | 当前内存中的记录数组 |
| 单次导出 | 1–200 条回复，内部参数 JSON 的 UTF-8 编码不超过 1 MiB |
| 内存记录 | 最多 20 次导出，记录序列化字节累计不超过 8 MiB，先进先出淘汰 |
| 生命周期 | 不写磁盘，CLI 重启清空；手动重复导出作为不同快照保留 |

## 五、安全与错误处理

预览服务只监听 `127.0.0.1`。HTTP 接口校验 Host 和 Origin，不返回开放跨域读取的 CORS 头；跨站请求被拒绝，但允许从 GPT 页面顶层导航到静态预览页。页面使用 CSP 禁止第三方资源和 iframe 嵌入，返回 `Cache-Control: no-store`，正文通过 `textContent` 展示。

这些措施不等于本机身份认证。同机可访问服务的进程仍可能读取内存预览，复制到剪贴板后数据也超出预览记录的生命周期。导出前必须保留用户确认，不能默认自动收集全部对话或向远程发送。

错误须明确显示，包括未连接、非 GPT 页面、生成中、无可提取回复、超限、服务拒绝、确认超时和断线。预览页连接失败时显示错误并重试，不显示虚假的连接成功。

未来接入消费者后必须继续保持：

- 外部 AI 回答是输入资料，不是执行授权。
- 转发 `glab-call` 文本不等于执行对应命令。
- ACP `cwd` 不自动扩大浏览器连接的文件权限。
- 不把网页中“正在修改文件”的描述伪造成真实工具调用。
- 不把普通解释文字映射成隐藏推理输出。

## 六、P1：将产出交给其他 ACP Agent

新增 GLAB ACP Client，配置目标 Agent 的命令、参数和目标项目工作目录。目标配置须由用户明确选择，不从网页回答中自动解析或执行启动命令。

```text
用户选择 GPT 回复及目标项目
  → 预览正文并确认
  → GLAB 启动目标 ACP Agent
  → initialize
  → session/new
  → session/prompt：用户的处理要求 + GPT 回答资料
  → session/update：显示目标 Agent 结果
  → session/prompt 响应：记录结束原因
```

发送时将处理要求和外部资料分块，标注来源。默认不携带完整对话 URL 或历史。目标请求的权限申请、取消、超时和进程退出需要显式处理；不得通过自动批准所有权限来简化接入。

P1 是否复用目标会话需作为用户可见选择，不能因为项目路径相同就隐式复用上下文。处理结果先显示在 GLAB 面板，不自动回填或发送给网页模型。

## 七、P2：将网页 GPT 暴露为 ACP Agent

新增独立的 `cli/acp-agent.js`（规划文件，当前不存在），由消费者启动，通过 stdio 提供 ACP。它连接现有本地 GLAB 服务，不重新争抢服务监听端口。

```text
其他项目 / IDE（ACP Client）
  ↕ stdio ACP JSON-RPC
GLAB ACP Agent 适配进程
  ↕ 本机 WebSocket
GLAB CLI
  ↕ 浏览器连接
GPT 网页
```

### 7.1 协议与能力

至少实现 `initialize`、`session/new`、`session/prompt` 和 `session/cancel`。只声明实际支持的能力；初版仅文本，不宣称图片、音频、任意 MCP Server 或会话恢复能力。

stdio 使用 UTF-8、每行一条 JSON-RPC 消息；文本中的换行由 JSON 转义。stdout 只能写 ACP 消息，日志写 stderr。现有 CLI 的日志输出不能直接复用为 ACP stdout。

### 7.2 会话与路由

现有 `clients` 按 `gpt` / `gemini` 角色登记，不能作为多标签页、多项目路由依据。需要建立独立连接标识和绑定关系：

```text
browserConnections:
  connectionId → 浏览器连接、站点、连接代次

sessionBindings:
  sessionId → connectionId、conversationId、已授权 cwd

activeTurns:
  sessionId → turnId、ACP 请求 ID、状态、超时信息
```

初版建议一个会话独占一个已授权标签页。创建新会话时使用独立网页对话；绑定已有对话需要用户明确确认。没有可用标签页或工作目录授权不匹配时明确失败，不静默复用另一个项目的对话。

### 7.3 回答关联与生命周期

发送前记录已有消息基线，确认输入框没有用户未发送的草稿。提交后确认新用户消息实际出现，再采集它之后的新 AI 回复。不能以“发送按钮被点击”认定提交成功，也不能把上一轮最新回答返回给新请求。

内部事件需关联 `turnId`、网页消息标识和连接代次，拒绝过期或乱序事件，避免重连、切换对话和取消后串入下一轮。

```text
IDLE → SUBMITTING → WAITING_FOR_REPLY → GENERATING → SETTLING → COMPLETED
活动状态 → CANCELLING → CANCELLED
活动状态 → FAILED
```

正常完成需综合新回答出现、生成信号结束、正文稳定和网页错误状态判断。现有约 2 秒稳定检测只能作为启发式信号；无法确认完成时明确超时，不假报 `end_turn`，也不凭截断文本猜测 `max_tokens`。

通过 `session/update` 发送正文后，再响应原 `session/prompt` 的请求 ID 并给出结束原因。取消时尝试停止网页生成，清理任务和待处理事件；确认取消完成后返回 `cancelled`。停止失败必须明确报告。

## 八、P3：流式与工具增强

### 8.1 网页快照不等于 token 流

网页可能追加内容，也可能重绘、改写先前段落。普通 `agent_message_chunk` 是追加语义，没有通用的撤回或替换历史文本机制。

初版完整 Agent 应等回答结束后再发送最终正文。后续保守流式维护“已提交前缀”和“未提交缓冲区”，只有稳定段落、闭合代码块才尝试输出；稳定一段时间仍不能保证以后不被改写。

一旦新快照改写已提交前缀，必须停止错误追加并显式报告。若要无损实时修订，需消费者配合实现自定义快照 / 修订扩展，并与基础 ACP 能力明确区分。

### 8.2 工具调用

第一版完整 Agent 对其控制的网页会话禁用自动执行链路，仅提供文本问答。后续只将真实工具执行事件映射到 `tool_call` / `tool_call_update`，并接入消费者权限申请；不得仅依赖模型文字推断执行状态。

会话恢复需要真实的会话持久化、历史重放和网页绑定恢复，不能复用 P0 的临时预览 ID 来宣称已经实现。

## 九、实现清单与部署

| 文件 | 当前职责 |
|------|----------|
| `extension/chat-export.js` | DOM 正文提取、Markdown 序列化 |
| `extension/content.js` | 导出按钮、确认、请求与响应隔离、查看入口 |
| `extension/manifest.json` | 在主内容脚本前加载提取模块 |
| `cli/acp-preview.js` | 校验、ACP 转换、有界记录、HTTP 路由 |
| `cli/acp-preview.html` | 临时查看页 |
| `cli/acp-preview-client.js` | 轮询、安全展示、复制 JSONL |
| `cli/server.js` | 接入预览 WebSocket 与 HTTP 请求 |
| `cli/service.js`、`scripts/build-mac-app.sh` | 打包预览模块及静态资源 |

后台服务安装复制的是源码副本，修改源码后仅重启服务不会更新安装副本。需在 `cli` 目录执行 `npm run service:install`；菜单栏 App 用户需重新打包并安装服务。前台运行者重启新版 CLI 即可。扩展修改后必须重新加载扩展并刷新 GPT 页面。

## 十、验证与验收

当前原型的自动化覆盖入口：

```bash
node --test tests/acp-preview.test.cjs tests/acp-preview-client.test.cjs tests/chat-export.test.cjs tests/server-service.test.cjs tests/service.test.cjs tests/streaming-guards.test.cjs tests/panel-status.test.cjs tests/extension-config-paths.test.cjs
```

P0 验收重点：

- 最新 / 全部已加载回复选择正确，用户消息不被当作 AI 产出。
- 常见 Markdown 结构、代码缩进和反引号围栏正确。
- 每条回复产生格式正确的 ACP 输出通知，无伪造的请求响应。
- 生成中、空回复、超限和取消确认时不发送快照。
- 导出确认、失败和断线不会进入模型反馈或指令执行路径。
- 页面把 HTML、脚本和 `glab-call` 当作文本展示。
- 超限记录被淘汰，服务新实例没有上次记录。
- 静态资源随服务和 App 打包；预览导航正常，跨站读取受限。

还需在真实浏览器中验证当前 GPT DOM、长对话加载、代码 / 表格 / 引用、生成期间点击、重新加载扩展和不同端口配置。模拟 DOM 和本机集成测试不能替代实际网页兼容性验证。

P1 / P2 后续验收需增加：目标 Agent 的真实协议互通、两个项目与两个标签页隔离、提交失败、网页限额、断线重连、取消后的过期事件隔离和权限拒绝。

## 十一、协议参考

- [ACP 初始化与能力协商](https://agentclientprotocol.com/protocol/initialization)
- [ACP 会话建立](https://agentclientprotocol.com/protocol/session-setup)
- [ACP 回答通知、结束与取消](https://agentclientprotocol.com/protocol/prompt-turn)
- [ACP stdio 传输](https://agentclientprotocol.com/protocol/transports)

未来实现完整 ACP 接口时应重新核对目标消费者与所选 SDK 对应的协议版本，按实际支持能力协商，不把原型快照等同于完整兼容性声明。
