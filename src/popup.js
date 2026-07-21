// popup.js —— 控制面板：启动/停止采集、显示统计、重建评论树并导出。

const $ = (id) => document.getElementById(id);
const log = (m) => ($("log").textContent = m);

function sendToBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp || {}));
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function rawSend(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(resp || {});
    });
  });
}

// 主动把 content script 注入当前标签页（解决"重载扩展后没刷新页面"导致的
// Receiving end does not exist；content.js 内有防重复保护）
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
    return true;
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
}

async function sendToTab(msg) {
  const tab = await activeTab();
  if (!tab) return { error: "无活动标签页" };
  if (!/^https?:\/\/([a-z0-9-]+\.)?tiktok\.com\//i.test(tab.url || "")) {
    return { error: "当前不是 tiktok.com 页面：" + (tab.url || "").slice(0, 60) };
  }
  let r = await rawSend(tab.id, msg);
  if (r.error && /Receiving end does not exist|Could not establish/i.test(r.error)) {
    // content script 不在 -> 主动注入后重试
    const inj = await ensureInjected(tab.id);
    if (inj !== true) return { error: "注入失败：" + inj };
    await new Promise((s) => setTimeout(s, 300));
    r = await rawSend(tab.id, msg);
  }
  return r;
}

// 从当前标签页 URL 里解析 aweme_id（.../video/<id>）
async function currentAwemeId() {
  const tab = await activeTab();
  if (!tab || !tab.url) return null;
  const m = tab.url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

async function refreshStats() {
  const r = await sendToBg({ type: "GET_STATS" });
  if (!r.ok) return;
  $("count").textContent = r.stats.total;
  const box = $("videos");
  box.innerHTML = "";
  const entries = Object.entries(r.stats.per).sort((a, b) => b[1] - a[1]);
  for (const [aid, n] of entries) {
    const div = document.createElement("div");
    div.textContent = `视频 ${aid}: ${n} 条`;
    box.appendChild(div);
  }
}

// ---------- 评论树重建 ----------

function buildTree(comments) {
  const byId = new Map();
  for (const c of comments) byId.set(c.cid, Object.assign({ children: [] }, c));

  const roots = [];
  for (const node of byId.values()) {
    let parent = null;
    if (node.parent_id && byId.has(node.parent_id)) {
      parent = byId.get(node.parent_id);
    } else if (node.reply_id && byId.has(node.reply_id)) {
      // 楼中楼的直接父回复没采到，退回到所属顶层评论
      parent = byId.get(node.reply_id);
    }
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  // 每层按时间排序
  const sortRec = (arr) => {
    arr.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
    arr.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

// ---------- 导出 ----------

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// 精简：只保留 层级 / 评论内容(缩进) / 昵称 / 回复给，按树形深度优先排序
function buildSimpleRows(comments) {
  // 每个顶层评论 + 它的所有回复 = 一组；没有回复的评论自成一组。
  const tree = buildTree(comments);
  const rows = [["分组", "层级", "评论内容", "昵称", "回复给"]];
  tree.forEach((root, i) => {
    const g = i + 1;
    const walk = (n, depth) => {
      const indent = "    ".repeat(depth) + (depth ? "└ " : "");
      rows.push([g, depth, indent + (n.text || ""), (n.user && n.user.nickname) || "", n.reply_to_username || ""]);
      (n.children || []).forEach((ch) => walk(ch, depth + 1));
    };
    walk(root, 0);
    if (i < tree.length - 1) rows.push(["", "", "", "", ""]); // 组间空行分隔
  });
  return rows;
}

function rowsToCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

async function getComments() {
  const aid = await currentAwemeId();
  const r = await sendToBg({ type: "GET_DATA", awemeId: aid });
  return { comments: (r && r.comments) || [], awemeId: aid };
}

// ---------- 事件绑定 ----------

$("start").addEventListener("click", async () => {
  const r = await sendToTab({ type: "START_COLLECT", opts: { pause: 900 } });
  if (r.error) log("无法在此页面启动，请确认在 tiktok.com 视频页：" + r.error);
  else log("采集中… 保持此标签页在前台，滚动会自动进行。");
});

$("stop").addEventListener("click", async () => {
  await sendToTab({ type: "STOP_COLLECT" });
  log("已发送停止。");
  refreshStats();
});

$("scanOnce").addEventListener("click", async () => {
  const r = await sendToTab({ type: "SCAN_ONCE" });
  if (r.error) log("无法在此页面扫描（需在 tiktok.com 视频页）：" + r.error);
  else log(`已扫描当前页面，解析出 ${r.scanned} 条（含已存在的）。`);
  setTimeout(refreshStats, 300);
});

$("refresh").addEventListener("click", refreshStats);

// 检测当前标签页 content script 是否连通，并显示可见评论线程数
async function checkConn() {
  const r = await sendToTab({ type: "PING" });
  const el = $("conn");
  if (r.error || !r.ok) {
    el.textContent = "· 未连接";
    el.style.color = "#e17055";
  } else {
    el.textContent = `· 已连接(可见${r.threads}条)`;
    el.style.color = "#00b894";
  }
}

$("clear").addEventListener("click", async () => {
  if (!confirm("确定清空所有已采集数据？")) return;
  await sendToBg({ type: "CLEAR" });
  log("已清空。");
  refreshStats();
});

$("exportJson").addEventListener("click", async () => {
  const { comments, awemeId } = await getComments();
  if (!comments.length) return log("没有数据可导出。");
  // 精简节点：只留 评论内容 / 昵称 / 回复给 / 子回复
  const simplify = (n) => {
    const o = { text: n.text || "", nickname: (n.user && n.user.nickname) || "" };
    if (n.reply_to_username) o.reply_to = n.reply_to_username;
    const kids = (n.children || []).map(simplify);
    if (kids.length) o.replies = kids;
    return o;
  };
  // 每个顶层评论及其回复 = 一组
  const groups = buildTree(comments).map((root, i) => ({ group: i + 1, comment: simplify(root) }));
  download(`tiktok_comments_${awemeId || "all"}.json`, JSON.stringify(groups, null, 2), "application/json");
  log(`已导出 ${groups.length} 组 / ${comments.length} 条。`);
});

$("exportCsv").addEventListener("click", async () => {
  const { comments, awemeId } = await getComments();
  if (!comments.length) return log("没有数据可导出。");
  download(`tiktok_comments_${awemeId || "all"}.csv`, "﻿" + rowsToCsv(buildSimpleRows(comments)), "text/csv;charset=utf-8");
  log(`已导出 ${comments.length} 条（CSV）。`);
});

function downloadBytes(filename, bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}

$("exportXlsx").addEventListener("click", async () => {
  const { comments, awemeId } = await getComments();
  if (!comments.length) return log("没有数据可导出。");
  if (!window.TKXlsx) return log("Excel 模块未加载，请重载扩展。");

  const bytes = window.TKXlsx.build([{ name: "评论(按组)", rows: buildSimpleRows(comments) }]);
  downloadBytes(
    `tiktok_comments_${awemeId || "all"}.xlsx`,
    bytes,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  log(`已导出 ${comments.length} 条（Excel，按组）。`);
});

// 监听 background 的实时更新（采集过程中数量变化）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "COLLECT_DONE") {
    log("本轮自动滚动结束。");
    refreshStats();
  }
});

// 打开时刷新一次，并定时刷新以显示实时增长
refreshStats();
checkConn();
setInterval(refreshStats, 1500);
