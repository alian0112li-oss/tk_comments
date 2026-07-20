// background.js —— service worker。
// 职责：按视频(aweme_id)累积去重存储所有采集到的评论；为 popup 提供查询/清空接口。

const STORAGE_KEY = "tk_comments_store";

// 内存缓存： { [awemeId]: { [cid]: commentObj } }
let store = {};
let loaded = false;

async function ensureLoaded() {
  if (loaded) return;
  const data = await chrome.storage.local.get(STORAGE_KEY);
  store = data[STORAGE_KEY] || {};
  loaded = true;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: store });
    } catch (e) {
      console.warn("[TK] 保存失败", e);
    }
  }, 500);
}

function addComments(comments) {
  let added = 0;
  for (const c of comments || []) {
    const aid = c.aweme_id || "unknown";
    if (!store[aid]) store[aid] = {};
    const bucket = store[aid];
    if (!bucket[c.cid]) {
      bucket[c.cid] = c;
      added++;
    } else {
      // 已存在：用信息更多的版本覆盖（例如 reply_comment_total 更大、或补齐关系字段）
      const old = bucket[c.cid];
      bucket[c.cid] = Object.assign({}, old, {
        reply_comment_total: Math.max(old.reply_comment_total || 0, c.reply_comment_total || 0),
        parent_id: c.parent_id || old.parent_id,
        reply_id: c.reply_id || old.reply_id,
        reply_to_reply_id: c.reply_to_reply_id || old.reply_to_reply_id,
        level: c.level || old.level,
      });
    }
  }
  if (added) scheduleSave();
  return added;
}

function stats() {
  const per = {};
  let total = 0;
  for (const aid of Object.keys(store)) {
    const n = Object.keys(store[aid]).length;
    per[aid] = n;
    total += n;
  }
  return { total, per };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    await ensureLoaded();

    switch (msg.type) {
      case "COMMENTS": {
        const added = addComments(msg.comments);
        sendResponse({ ok: true, added, stats: stats() });
        break;
      }
      case "GET_STATS": {
        sendResponse({ ok: true, stats: stats() });
        break;
      }
      case "GET_DATA": {
        // 返回指定视频（或全部）的评论数组
        const aid = msg.awemeId;
        if (aid && store[aid]) {
          sendResponse({ ok: true, comments: Object.values(store[aid]), awemeId: aid });
        } else {
          const all = [];
          for (const k of Object.keys(store)) all.push(...Object.values(store[k]));
          sendResponse({ ok: true, comments: all });
        }
        break;
      }
      case "CLEAR": {
        if (msg.awemeId && store[msg.awemeId]) {
          delete store[msg.awemeId];
        } else {
          store = {};
        }
        scheduleSave();
        sendResponse({ ok: true, stats: stats() });
        break;
      }
      default:
        sendResponse({ ok: false, msg: "unknown type" });
    }
  })();

  return true; // 异步响应
});
