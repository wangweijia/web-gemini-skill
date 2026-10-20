const status = document.getElementById("status");
const captures = document.getElementById("captures");
let lastSnapshot = "";

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function copyButton(text) {
  const button = element("button", "复制 ACP JSONL");
  button.type = "button";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "已复制，每行一条 ACP JSON-RPC 通知。";
    } catch (error) {
      status.textContent = `复制失败，请手动选择 JSON：${error.message}`;
    }
  });
  return button;
}

async function refresh() {
  try {
    const response = await fetch("/acp-preview/messages", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const records = await response.json();
    const snapshot = JSON.stringify(records);
    status.textContent = records.length ? `已连接 · ${records.length} 次导出 · 每 1.5 秒刷新` : "已连接，等待 GPT 页面手动导出。";
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      captures.replaceChildren();
      for (const record of records.slice().reverse()) {
        const article = element("article");
        article.append(element("h2", `${record.messages.length} 条 AI 回复 · ${new Date(record.capturedAt).toLocaleString()}`));
        const meta = element("p", `GPT 对话：${record.source.conversationId} · 预览会话：${record.sessionId}`);
        meta.className = "meta";
        article.append(meta, copyButton(record.messages.map(message => JSON.stringify(message)).join("\n") + "\n"));
        record.messages.forEach((message, index) => {
          const details = element("details");
          details.append(element("summary", "原始 ACP JSON"), element("pre", JSON.stringify(message, null, 2)));
          article.append(element("h3", `回复 ${index + 1} · Markdown 源文`),
            element("pre", message.params.update.content.text), details);
        });
        captures.append(article);
      }
    }
  } catch (error) {
    status.textContent = `本地服务连接失败：${error.message}。请确认 CLI 已更新并启动；将自动重试。`;
  } finally {
    setTimeout(refresh, 1500);
  }
}

refresh();
