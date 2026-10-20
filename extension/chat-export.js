(function (root) {
  const ignoredTags = new Set(["BUTTON", "SCRIPT", "STYLE", "SVG", "NAV", "TEXTAREA"]);
  const blockTags = new Set(["P", "DIV", "SECTION", "ARTICLE"]);

  function escapeText(text) {
    return text.replace(/([\\`*_{}[\]<>|])/g, "\\$1");
  }

  function serialize(node) {
    if (node.nodeType === 3) return escapeText(node.textContent.replace(/\s+/g, " "));
    if (node.nodeType !== 1) return "";
    if (ignoredTags.has(node.tagName) || node.hidden ||
        node.getAttribute("aria-hidden") === "true" ||
        node.id === "glab-panel-root") return "";
    const children = () => Array.from(node.childNodes).map(serialize).join("");
    const tag = node.tagName;
    if (tag === "BR") return "\n";
    if (tag === "HR") return "\n\n---\n\n";
    if (tag === "IMG") return `[Image not exported: ${escapeText(node.getAttribute("alt") || "image")}]`;
    if (tag === "PRE" || node.getAttribute("data-markdown-copy") === "code-block") {
      const code = node.querySelector("code") || node;
      const text = code.textContent.replace(/\n$/, "");
      const language = (code.className || "").match(/(?:^|\s)language-([\w+-]+)/)?.[1] || "";
      const runs = text.match(/`+/g) || [];
      const fence = "`".repeat(Math.max(3, ...runs.map(run => run.length + 1)));
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
    }
    if (tag === "CODE") {
      const text = node.textContent;
      const fence = "`".repeat(Math.max(1, ...(text.match(/`+/g) || []).map(run => run.length + 1)));
      const padding = /^[` ]|[` ]$/.test(text) ? " " : "";
      return `${fence}${padding}${text}${padding}${fence}`;
    }
    if (/^H[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${children().trim()}\n\n`;
    if (tag === "STRONG" || tag === "B") return `**${children()}**`;
    if (tag === "EM" || tag === "I") return `*${children()}*`;
    if (tag === "A") {
      const text = children();
      const href = node.getAttribute("href") || "";
      if (!/^https?:\/\//i.test(href)) return text;
      return `[${text}](<${href.replace(/>/g, "%3E").replace(/</g, "%3C")}>)`;
    }
    if (tag === "BLOCKQUOTE") return `\n\n${children().trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
    if (tag === "UL" || tag === "OL") {
      const start = Number(node.getAttribute("start")) || 1;
      const items = Array.from(node.children).filter(child => child.tagName === "LI");
      return "\n\n" + items.map((item, index) => {
        const marker = tag === "OL" ? `${start + index}. ` : "- ";
        const lines = Array.from(item.childNodes).map(serialize).join("").trim().split("\n");
        return marker + lines.join("\n" + " ".repeat(marker.length));
      }).join("\n") + "\n\n";
    }
    if (tag === "TABLE") {
      const rows = Array.from(node.querySelectorAll("tr")).map(row =>
        Array.from(row.children).filter(cell => ["TH", "TD"].includes(cell.tagName))
          .map(cell => serialize(cell).trim().replace(/(?<!\\)\|/g, "\\|").replace(/\n+/g, "<br>")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map(row => row.length));
      const line = row => `| ${Array.from({ length: width }, (_, index) => row[index] || "").join(" | ")} |`;
      return `\n\n${line(rows[0])}\n${line(Array(width).fill("---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
    }
    const text = children();
    return blockTags.has(tag) ? `\n\n${text.trim()}\n\n` : text;
  }

  function extractReplies(document) {
    let replies = Array.from(document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-testid="assistant-message"], [data-markdown-text-style="assistant-message"]'));
    if (!replies.length) {
      replies = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"], main article'))
        .filter(turn => !turn.querySelector('[data-message-author-role="user"], [data-testid="user-message"]') &&
          turn.querySelector('.markdown, .prose, [data-markdown-copy="code-block"]'));
    }
    replies = replies.filter(reply => !replies.some(other => other !== reply && other.contains(reply)));
    return replies.map((reply, index) => {
      const markdown = Array.from(reply.querySelectorAll(".markdown"))
        .filter(element => !element.parentElement?.closest(".markdown"));
      const text = (markdown.length ? markdown.map(serialize).join("\n\n") : serialize(reply)).trim();
      return { messageId: reply.getAttribute("data-message-id") || `reply_${index + 1}`, text };
    }).filter(reply => reply.text);
  }

  const api = { serialize, extractReplies };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GLABChatExport = api;
})(globalThis);
