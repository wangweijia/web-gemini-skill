const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 8 * MAX_CAPTURE_BYTES;

function createPreview() {
  const records = [];
  let historyBytes = 0;
  const assets = new Map([
    ["/acp-preview", ["text/html; charset=utf-8", "acp-preview.html"]],
    ["/acp-preview.js", ["text/javascript; charset=utf-8", "acp-preview-client.js"]],
  ]);

  function capture(params, context) {
    if (context.role !== "gpt") throw new Error("ACP 预览仅接受已握手的 GPT 连接");
    if (!params || !Array.isArray(params.messages) || !params.messages.length || params.messages.length > 200) {
      throw new Error("请提供 1–200 条已加载的 AI 回复");
    }
    if (typeof params.conversationId !== "string" || !params.conversationId.length || params.conversationId.length > 200) {
      throw new Error("对话标识无效");
    }
    if (Buffer.byteLength(JSON.stringify(params), "utf8") > MAX_CAPTURE_BYTES) {
      throw new Error("单次导出超过 1 MiB，请改为仅导出最新回复");
    }
    for (const message of params.messages) {
      if (!message || typeof message.messageId !== "string" || !message.messageId.length ||
          message.messageId.length > 200 || typeof message.text !== "string" || !message.text.trim()) {
        throw new Error("AI 回复必须包含有效的 messageId 和正文");
      }
    }
    const id = randomUUID();
    const sessionId = `preview_${id}`;
    const record = {
      id,
      capturedAt: new Date().toISOString(),
      source: { provider: "gpt", conversationId: params.conversationId },
      sessionId,
      messages: params.messages.map((message, index) => ({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: `${sessionId}_${index + 1}`,
            content: { type: "text", text: message.text },
          },
        },
      })),
    };
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    records.push({ record, bytes });
    historyBytes += bytes;
    while (records.length > 20 || historyBytes > MAX_HISTORY_BYTES) {
      historyBytes -= records.shift().bytes;
    }
    return { captureId: id, messageCount: record.messages.length, previewPath: "/acp-preview" };
  }

  function handleHttp(request, response) {
    const route = request.url?.split("?")[0];
    if (!assets.has(route) && route !== "/acp-preview/messages") return false;
    const expectedHost = `127.0.0.1:${request.socket.localPort}`;
    const expectedOrigin = `http://${expectedHost}`;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const previewNavigation = route === "/acp-preview" && request.method === "GET" &&
      request.headers["sec-fetch-mode"] === "navigate" && request.headers["sec-fetch-dest"] === "document";
    if (request.headers.host !== expectedHost ||
        (request.headers.origin && request.headers.origin !== expectedOrigin) ||
        (request.headers["sec-fetch-site"] === "cross-site" && !previewNavigation)) {
      response.writeHead(403);
      response.end("Forbidden");
      return true;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method not allowed");
      return true;
    }
    if (route === "/acp-preview/messages") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(records.map(entry => entry.record)));
      return true;
    }
    const [contentType, file] = assets.get(route);
    response.writeHead(200, { "Content-Type": contentType });
    response.end(fs.readFileSync(path.join(__dirname, file)));
    return true;
  }

  return { capture, handleHttp };
}

module.exports = { createPreview };
