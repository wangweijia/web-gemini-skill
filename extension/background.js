// GLAB Background Service Worker
chrome.runtime.onInstalled.addListener(() => {
  console.log("[GLAB Background] 插件已成功安装并启动。");
});

// 未来扩展使用：接收来自 content script 的中继消息或控制逻辑
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[GLAB Background] 收到消息:", message);
  // 可在此处集成对特定 API 的跨域中转（如必要）
  sendResponse({ status: "received" });
});
