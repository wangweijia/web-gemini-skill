# GLAB 跨模型中转与校验方案

> 生成日期：2026-08-05

---

## 一、可行性评估结论（背景）

### 现有架构能力盘点

| 能力 | 当前状态 |
|------|----------|
| 同时向 Gemini / ChatGPT 注入脚本 | ✅ manifest.json 已声明双域名 host_permissions |
| 输入框 / 发送按钮双站适配 | ✅ findInputElement / findSendButton 已适配 |
| 多步队列执行 | ✅ activeTaskQueue / queueResultsCollector 完整实现 |
| WebSocket 多客户端连接 | ✅ ws 库天然支持，wss.on('connection') 每次得到独立 ws |
| 跨 tab 消息路由 | ❌ 缺失 |
| 每连接独立上下文（Path Jail） | ❌ safeRoot/skillsDir 是进程级全局变量，多客户端会互相覆盖 |

### 核心障碍：全局 safeRoot

```
Gemini tab 握手  →  safeRoot = "/Users/x/project-a"
GPT tab 握手    →  safeRoot = "/Users/x/project-b"   ← 覆盖了 Gemini 的
Gemini 执行 read_file  →  实际访问 project-b          ← 错误
```

**必须把 safeRoot / skillsDir 从全局变量迁移到每连接上下文对象，是所有后续功能的前提。**

### 改动范围

| 位置 | 改动类型 | 约估行数 |
|------|----------|---------|
| cli/server.js | 全局变量 → per-conn ctx；clients Map；relay 指令 | ~60 行 |
| extension/content.js | 握手带 role；relay_incoming 处理器 | ~30 行 |
| 新增依赖 | 无 | — |

---

## 二、Proposer-Verifier 模式设计

### 2.1 角色定义

| 角色 | 职责 |
|------|------|
| **Proposer（提案方）** | 接收用户任务，执行本地操作，产出结论 |
| **Verifier（校验方）** | 独立审查 Proposer 的操作记录与结论，给出 verdict |

两个角色可以互换，也可以固定（例如 Gemini 永远是 Proposer，GPT 永远是 Verifier）。

### 2.2 触发方式（三种，可叠加）

```
① 显式触发  —— Proposer 的 AI 在回答中主动输出 relay_verify glab-call
② 自动触发  —— content.js 中的 finishQueueExecution 执行完后，若开启了 auto-verify 开关，自动打包发送
③ 手动触发  —— 用户点击 GLAB 面板中的「发送校验」按钮
```

### 2.3 完整数据流

```
┌─────────────────────────────────────────────────────┐
│  用户 → Tab A (Proposer: Gemini)                     │
│         AI 处理任务，执行 glab-call 队列              │
│         finishQueueExecution 汇总结果                 │
│         AI 生成最终结论                               │
│         输出 relay_verify glab-call  ────────────────┼──► CLI
│                                                      │       │
└─────────────────────────────────────────────────────┘       │
                                                              │ CLI 组装校验提示
                                                              │ 推送 relay_incoming
                                                              │
┌─────────────────────────────────────────────────────┐       │
│  Tab B (Verifier: GPT)   ◄────────────────────────── ┼──────┘
│         收到 relay_incoming                           │
│         replyToChat() 填入结构化校验提示            │
│         AI 审查并输出 verdict + relay_result glab-call│
│         content.js 拦截 relay_result ─────────────────┼──► CLI
│                                                      │       │
└─────────────────────────────────────────────────────┘       │
                                                              │ CLI 推送 relay_incoming
┌─────────────────────────────────────────────────────┐       │
│  Tab A (Proposer)  ◄──────────────────────────────── ┼──────┘
│         收到 relay_incoming (verdict)                 │
│         replyToChat() 展示校验结论给用户            │
│         AI 可选择接受建议并修正，或标记任务完成        │
└─────────────────────────────────────────────────────┘
```

### 2.4 新增 glab-call 指令

#### `relay_verify`（Proposer → Verifier）

```json
{
  "id": "verify_001",
  "action": "relay_verify",
  "params": {
    "target": "gpt",
    "question": "用户的原始问题",
    "actions_summary": "执行了哪些操作的文字摘要",
    "conclusion": "Proposer AI 给出的最终结论",
    "execution_log": []
  },
  "autoSend": true
}
```

> `execution_log` 可选，传入 queueResultsCollector 快照，供 Verifier 审查原始执行细节。

#### `relay_result`（Verifier → Proposer）

```json
{
  "id": "result_001",
  "action": "relay_result",
  "params": {
    "target": "gemini",
    "verdict": "PASS",
    "confidence": 88,
    "issues": [],
    "suggestion": "无问题，建议保持当前方案。"
  },
  "autoSend": true
}
```

### 2.5 CLI 组装的校验提示模板

CLI 在收到 `relay_verify` 后，**不把原始 params 直接转发**，而是组装成标准校验提示再推给 Verifier：

```
你是独立校验者（Verifier）。以下是另一个 AI（Proposer）处理用户任务的完整记录，
请客观审查，不要受 Proposer 结论影响。

【原始问题】
{question}

【执行摘要】
{actions_summary}

【Proposer 的结论】
{conclusion}

---
请从以下维度审查：
1. 操作路径是否合理？是否存在更优方案？
2. 结论是否正确？是否有遗漏或逻辑错误？
3. 是否存在安全风险？

完成审查后，你必须输出一个 relay_result glab-call 指令将结论返回：

\`\`\`glab-call
{
  "id": "result_unique_id",
  "action": "relay_result",
  "params": {
    "target": "{from_role}",
    "verdict": "PASS | WARN | FAIL",
    "confidence": 0-100,
    "issues": ["如有问题请列出"],
    "suggestion": "改进建议（可为空字符串）"
  },
  "autoSend": true
}
\`\`\`

不要在 glab-call 之外添加额外解释。
```

### 2.6 Proposer 收到 verdict 后的提示

CLI 把 `relay_result` 转发给 Proposer 时，同样包装成自然语言提示：

```
【GLAB 跨模型校验结论】来自：{verifier_role}

校验结果：{verdict}（置信度：{confidence}%）
发现问题：{issues 列表，如无则显示"无"}
建议：{suggestion}

---
请根据上述校验结论决定下一步行动：
- 若结果为 PASS，可告知用户任务已完成并经独立校验。
- 若结果为 WARN / FAIL，请根据建议修正并重新执行。
```

---

## 三、CLI 侧具体改动点（server.js）

### 3.1 全局变量 → per-connection ctx

```javascript
// 改造前（全局）
let safeRoot = '';
let skillsDir = defaultSkillsDir;

// 改造后（每连接）
const clients = new Map();          // role → ws
const connContexts = new WeakMap(); // ws → { safeRoot, skillsDir, role }

wss.on('connection', (ws) => {
  connContexts.set(ws, { safeRoot: '', skillsDir: defaultSkillsDir, role: '' });
  // ...
  ws.on('close', () => {
    const ctx = connContexts.get(ws);
    if (ctx.role) clients.delete(ctx.role);
    connContexts.delete(ws);
  });
});
```

### 3.2 shakehand 扩展

```javascript
if (action === "shakehand") {
  const ctx = connContexts.get(ws);
  ctx.safeRoot = params.workDir ? path.resolve(params.workDir) : '';
  ctx.skillsDir = params.skillsDir ? path.resolve(params.skillsDir) : defaultSkillsDir;
  ctx.role = params.role || '';          // 新增：'gemini' | 'gpt' | ''
  if (ctx.role) clients.set(ctx.role, ws);
  // ...
}
```

### 3.3 relay_verify 指令

```javascript
case 'relay_verify': {
  const targetWs = clients.get(params.target);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    throw new Error(`目标 [${params.target}] 未连接`);
  }
  const ctx = connContexts.get(ws);
  const prompt = buildVerifyPrompt(params, ctx.role);
  targetWs.send(JSON.stringify({
    action: 'relay_incoming',
    from: ctx.role,
    payload: prompt,
    autoSend: params.autoSend !== false
  }));
  return { message: `已转发校验请求至 [${params.target}]` };
}
```

### 3.4 relay_result 指令

```javascript
case 'relay_result': {
  const targetWs = clients.get(params.target);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    throw new Error(`目标 [${params.target}] 未连接`);
  }
  const ctx = connContexts.get(ws);
  const summary = buildVerdictSummary(params, ctx.role);
  targetWs.send(JSON.stringify({
    action: 'relay_incoming',
    from: ctx.role,
    payload: summary,
    autoSend: params.autoSend !== false
  }));
  return { message: `已转发校验结论至 [${params.target}]` };
}
```

### 3.5 executeAction 签名变更

```javascript
// 改造前
async function executeAction(action, params)

// 改造后：传入连接上下文，用 ctx.safeRoot 替代全局 safeRoot
async function executeAction(action, params, ctx)
```

---

## 四、content.js 侧具体改动点

### 4.1 握手带 role

```javascript
// 由域名自动识别角色
function detectRole() {
  if (location.hostname.includes('gemini.google.com')) return 'gemini';
  if (location.hostname.includes('chatgpt.com')) return 'gpt';
  return '';
}

// shakehand 时附加 role
socket.send(JSON.stringify({
  action: "shakehand",
  params: { workDir, skillsDir, role: detectRole() }
}));
```

### 4.2 relay_incoming 处理器（新增）

```javascript
if (response.action === 'relay_incoming') {
  logToTerminal(`收到来自 [${response.from}] 的中转消息，自动填入输入框...`);
  replyToChat(response.payload, [], response.autoSend !== false);
  return;
}
```

### 4.3 面板新增「发送校验」按钮（可选）

手动将当前页面最后一条 AI 回答打包成 relay_verify 发送，无需等 AI 主动输出。

---

## 五、运行模式汇总

| 模式 | 描述 | 触发方 | 轮次 |
|------|------|--------|------|
| **单向校验** | A 做完后发给 B 验证，B 的结论展示给用户 | A 的 AI 或用户按钮 | 1 |
| **全回环校验** | A→B 验证，B 的 verdict 自动返回 A，A 展示并决定是否修正 | A 的 AI | 2 |
| **多轮对话校验** | A↔B 反复交互直到达成共识（受 autoRunDepth ≤ 10 保护） | A 的 AI | N |

---

## 六、风险与防护

| 风险 | 防护措施 |
|------|----------|
| 目标 tab 未连接 | CLI 返回明确错误，content.js 日志提示 |
| 无限循环对话 | 复用现有 autoRunDepth ≤ 10，两个 tab 各自计数 |
| 网页选择器变更失效 | 现有多层兜底选择器已覆盖 |
| prompt injection 通过 relay payload | CLI 拼接时对用户内容做 HTML 转义；Verifier 提示词固定不可被覆盖 |
| 两个 tab 工作目录不同 | per-conn ctx 迁移后天然隔离，各自独立 Path Jail |

---

## 七、实施顺序

```
Step 1  cli/server.js  — per-conn ctx 迁移（前提，必须最先做）
Step 2  cli/server.js  — clients Map + shakehand role 注册
Step 3  cli/server.js  — relay_verify / relay_result 指令 + prompt 模板
Step 4  content.js     — shakehand 带 role + relay_incoming 处理器
Step 5  content.js     — 面板「发送校验」按钮（可选，后期加）
Step 6  content.js     — 初始化 Prompt 更新：告知 AI relay_verify 用法
```

总计：~90 行新增/修改，零新增 npm 依赖。
