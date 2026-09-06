const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Retry state survives WebSocket reconnects, but not a CLI restart.
function createChunkWriter() {
  const sessions = new Map();
  return function writeChunk(targetPath, params) {
    const { transferId, chunkIndex, totalChunks, content } = params;
    if (typeof transferId !== 'string' || !transferId.trim() || transferId.length > 128) {
      throw new Error('分片需要 transferId（1–128 字符）；同一次写入保持不变，重新写入使用新 ID。');
    }
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 10000 ||
        !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks || typeof content !== 'string') {
      throw new Error('分片参数无效：编号和总数必须为整数，0 <= chunkIndex < totalChunks <= 10000，content 必须为字符串。');
    }
    if (content.length > 2000 || content.split('\n').length > 40) {
      throw new Error('分片超过 2000 字符或 40 行。请缩小分片，使用新的 transferId 从第 0 片重新开始并重新规划 totalChunks。');
    }
    const key = JSON.stringify([targetPath, transferId]);
    let session = sessions.get(key);
    if (!session) {
      if (chunkIndex !== 0) throw new Error('找不到写入会话（可能 CLI 已重启），请用新的 transferId 从第 0 片重新开始。');
      if ([...sessions.values()].some(s => s.targetPath === targetPath && !s.complete && s.transferId !== transferId)) {
        // A new first chunk explicitly replaces the unfinished transfer for this file.
        for (const s of sessions.values()) {
          if (s.targetPath === targetPath && !s.complete && !s.abandoned) {
            fs.rmSync(s.tempDir, { recursive: true, force: true });
            s.abandoned = true;
          }
        }
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const tempDir = fs.mkdtempSync(path.join(path.dirname(targetPath), '.glab-chunks-'));
      session = { targetPath, transferId, totalChunks, tempDir, hashes: [], complete: false };
      sessions.set(key, session);
    }
    if (session.abandoned) throw new Error('该写入会话已被新的 transferId 替代，请勿继续发送旧分片。');
    if (session.totalChunks !== totalChunks) throw new Error('totalChunks 与首片不一致；如需重新规划，请使用新的 transferId 从第 0 片开始。');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (chunkIndex < session.hashes.length) {
      if (session.hashes[chunkIndex] !== hash) throw new Error('重复分片的内容不一致，已拒绝修改。请使用新的 transferId 重新开始。');
    } else {
      if (chunkIndex !== session.hashes.length) throw new Error(`分片乱序：下一片应为 chunkIndex=${session.hashes.length}。`);
      fs.writeFileSync(path.join(session.tempDir, String(chunkIndex)), content, 'utf8');
      session.hashes.push(hash);
    }
    if (!session.complete && session.hashes.length === totalChunks) {
      const output = path.join(session.tempDir, 'output');
      fs.writeFileSync(output, '');
      for (let i = 0; i < totalChunks; i++) fs.appendFileSync(output, fs.readFileSync(path.join(session.tempDir, String(i))));
      fs.renameSync(output, targetPath);
      session.complete = true;
      fs.rmSync(session.tempDir, { recursive: true, force: true });
    }
    return {
      message: session.complete ? '全部分片写入完成' : `分片 ${chunkIndex + 1}/${totalChunks} 已接收；收到本条成功反馈后，再按 nextChunkIndex 生成下一片，下一轮只发送该文件的这一片。`,
      path: params.path, transferId, nextChunkIndex: session.hashes.length, complete: session.complete,
    };
  };
}
module.exports = { createChunkWriter };
