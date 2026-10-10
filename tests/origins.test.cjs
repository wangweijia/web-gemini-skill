const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedOrigin } = require('../cli/origins.js');

test('persistent service accepts only the supported browser origins', () => {
  assert.equal(isAllowedOrigin('https://chatgpt.com'), true);
  assert.equal(isAllowedOrigin('https://gemini.google.com'), true);
  assert.equal(isAllowedOrigin(`chrome-extension://${'a'.repeat(32)}`), true);
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('https://chatgpt.com.evil.example'), false);
  assert.equal(isAllowedOrigin('null'), false);
});
