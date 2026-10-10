function isAllowedOrigin(origin) {
  if (!origin) return true; // Native localhost clients do not send Origin.
  return origin === "https://chatgpt.com" || origin === "https://gemini.google.com" ||
    /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

module.exports = { isAllowedOrigin };
