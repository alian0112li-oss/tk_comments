// content.js —— 运行在 ISOLATED world。
// 主方案：直接解析 DOM（TikTok 是虚拟列表，边滚边抓、去重累积）。
//   回复关系由 DOM 嵌套决定：每个 DivCommentObjectWrapper = 一个顶层评论 + 它的 DivReplyContainer(回复)。
// 兜底：注入 interceptor.js 抓评论 API JSON（若网站结构里能拿到）。

(function () {
  "use strict";

  // 防重复：manifest 注入 与 popup 的 scripting 注入可能同时发生，只允许一份运行
  if (window.__TK_CONTENT_LOADED__) return;
  window.__TK_CONTENT_LOADED__ = true;

  const TAG = "TK_SCRAPER";
  const clog = (...a) => console.log("%c[TK内容]", "color:#00b894", ...a);

  // ---------- 注入页面拦截器（兜底，非主力）----------
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/interceptor.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (e) {
    clog("注入拦截器失败", e);
  }

  // ================= 工具 =================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function awemeId() {
    const m = location.href.match(/\/video\/(\d+)/) || location.href.match(/\/photo\/(\d+)/);
    return m ? m[1] : "current";
  }

  // 稳定 id：无 cid，用 作者+正文+时间 生成短哈希，保证跨滚动去重一致
  function hashId(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return "c_" + (h >>> 0).toString(36);
  }

  // "1764" / "1.2万" / "3.4K" -> number
  function parseCount(t) {
    if (!t) return 0;
    t = String(t).trim().replace(/,/g, "");
    let mul = 1;
    if (/万/.test(t)) mul = 10000;
    else if (/[kK]/.test(t)) mul = 1000;
    else if (/[mM]/.test(t)) mul = 1000000;
    const n = parseFloat(t.replace(/[^\d.]/g, ""));
    return isNaN(n) ? 0 : Math.round(n * mul);
  }

  // ================= DOM 解析 =================

  const SEL = {
    scroller: '[class*="DivCommentListContainer"]',
    thread: '[class*="DivCommentObjectWrapper"]',
    itemWrapper: '[class*="DivCommentItemWrapper"]',
    replyContainer: '[class*="DivReplyContainer"]',
    username: '[data-e2e^="comment-username-"]',
    level: '[data-e2e^="comment-level-"]',
    subContent: '[class*="DivCommentSubContentWrapper"]',
    like: '[class*="DivLikeContainer"]',
    viewReplies: '[class*="DivViewRepliesContainer"]',
  };

  // 从一个「评论行」DOM 节点解析出评论对象（不含父子，父子在 thread 层面赋值）
  function parseItem(item) {
    const levelEl = item.querySelector(SEL.level);
    if (!levelEl) return null;
    const text = (levelEl.textContent || "").trim();

    // 用户名 + 主页 handle
    const userEl = item.querySelector(SEL.username);
    let nickname = "";
    let handle = "";
    if (userEl) {
      const a = userEl.querySelector("a[href^='/@']");
      if (a) {
        nickname = (a.textContent || "").trim();
        handle = (a.getAttribute("href") || "").replace(/^\/@/, "").replace(/\/.*$/, "");
      }
      if (!nickname) nickname = (userEl.textContent || "").trim();
    }

    // data-e2e 后缀里的层级数字（1=顶层, 2=回复）
    const de = (levelEl.getAttribute("data-e2e") || "").match(/comment-level-(\d+)/);
    const domLevel = de ? parseInt(de[1], 10) : 1;

    // 时间（相对文案，如 "5 天前"）—— sub-content 里第一个 span
    let timeText = "";
    const sub = item.querySelector(SEL.subContent);
    if (sub) {
      const sp = sub.querySelector("span");
      if (sp) timeText = (sp.textContent || "").trim();
    }

    // 点赞数
    let digg = 0;
    const likeEl = item.querySelector(SEL.like);
    if (likeEl) {
      const aria = likeEl.getAttribute("aria-label") || "";
      const m = aria.match(/([\d.,]+\s*[万kKmM]?)\s*个赞/) || aria.match(/([\d.,]+\s*[万kKmM]?)/);
      if (m) digg = parseCount(m[1]);
      else {
        const sp = likeEl.querySelector("span");
        if (sp) digg = parseCount(sp.textContent);
      }
    }

    // 楼中楼："回复 @xxx：" 前缀 -> 记录被回复者
    let replyToUsername = "";
    let cleanText = text;
    const rm = text.match(/^回复\s*@([^\s:：]+)[：:]\s*/);
    if (rm) {
      replyToUsername = rm[1];
      cleanText = text.replace(/^回复\s*@[^\s:：]+[：:]\s*/, "");
    }

    if (!cleanText && !nickname) return null;

    const cid = hashId(handle + "|" + cleanText + "|" + timeText);
    return {
      cid,
      aweme_id: awemeId(),
      text: cleanText,
      create_time: 0,
      create_time_text: timeText,
      digg_count: digg,
      reply_comment_total: 0,
      reply_id: "",
      reply_to_reply_id: "",
      reply_to_username: replyToUsername,
      parent_id: null,
      level: domLevel - 1, // 0=顶层,1=回复
      user: { uid: "", unique_id: handle, nickname, sec_uid: "" },
    };
  }

  // 解析当前 DOM 里所有可见的评论线程，返回归一化数组（含父子关系）
  function scanDom() {
    const out = [];
    const threads = document.querySelectorAll(SEL.thread);
    for (const thread of threads) {
      // 顶层评论：thread 的直接子 itemWrapper
      let topItem = null;
      for (const child of thread.children) {
        if (child.matches && child.matches(SEL.itemWrapper)) {
          topItem = child;
          break;
        }
      }
      if (!topItem) continue;
      const top = parseItem(topItem);
      if (!top) continue;
      top.level = 0;
      top.parent_id = null;

      // 顶层评论的"查看 N 条回复"总数
      const vr = thread.querySelector(SEL.viewReplies);
      if (vr) {
        const m = (vr.textContent || "").match(/(\d[\d,\.]*\s*[万kKmM]?)\s*条回复/);
        if (m) top.reply_comment_total = parseCount(m[1]);
      }
      out.push(top);

      // 回复：DivReplyContainer 内的所有 itemWrapper
      const rc = thread.querySelector(SEL.replyContainer);
      if (rc) {
        const replies = rc.querySelectorAll(SEL.itemWrapper);
        for (const r of replies) {
          const rep = parseItem(r);
          if (!rep) continue;
          rep.level = rep.level === 0 ? 1 : rep.level; // 至少为回复层
          rep.reply_id = top.cid; // 所属顶层评论
          rep.parent_id = top.cid; // DOM 里回复平铺在顶层评论下
          out.push(rep);
        }
      }
    }
    return out;
  }

  function flush() {
    const comments = scanDom();
    if (!comments.length) return 0;
    try {
      chrome.runtime.sendMessage(
        { type: "COMMENTS", source: "dom", comments, pageUrl: location.href },
        (resp) => {
          if (chrome.runtime.lastError) clog("转发失败", chrome.runtime.lastError.message);
        }
      );
    } catch (e) {
      clog("sendMessage 异常", e);
    }
    return comments.length;
  }

  // ================= 展开回复 + 滚动 =================

  const EXPAND_RE = /(查看|展开)\s*\d?[\d,\.]*\s*[万kKmM]?\s*条?回复|view\s+\d+\s+repl|more\s+repl/i;

  function clickExpanders() {
    let clicked = 0;
    // "查看 N 条回复" / "展开更多回复" —— 优先在回复容器内找可点元素
    const nodes = document.querySelectorAll(
      SEL.viewReplies + " button, " + SEL.viewReplies + " span, " + SEL.viewReplies + ", [class*='DivViewMoreRepliesWrapper'] button"
    );
    for (const el of nodes) {
      const t = (el.textContent || "").trim();
      if (t && t.length < 30 && EXPAND_RE.test(t)) {
        try {
          el.click();
          clicked++;
        } catch (_) {}
      }
    }
    return clicked;
  }

  function getScroller() {
    return document.querySelector(SEL.scroller);
  }

  let collecting = false;
  let abort = false;

  async function autoCollect(opts) {
    if (collecting) return { ok: false, msg: "已在采集中" };
    collecting = true;
    abort = false;
    const pause = (opts && opts.pause) || 1000;
    const maxRounds = (opts && opts.maxRounds) || 600;

    const scroller = getScroller();
    clog("开始采集，找到滚动容器:", !!scroller);

    let lastTop = -1;
    let stable = 0;
    let grand = 0;

    for (let i = 0; i < maxRounds && !abort; i++) {
      // 1) 展开当前视口内的回复（可能要点多次逐步加载）
      for (let k = 0; k < 3; k++) {
        const c = clickExpanders();
        if (!c) break;
        await sleep(500);
        flush(); // 展开后立刻抓，避免滚走被虚拟列表回收
      }

      // 2) 抓当前 DOM
      grand += flush();

      // 3) 向下滚动一屏
      if (scroller) {
        scroller.scrollTop = scroller.scrollTop + Math.max(400, scroller.clientHeight * 0.9);
      } else {
        window.scrollBy(0, window.innerHeight * 0.9);
      }
      await sleep(pause);

      // 4) 到底判定
      const top = scroller ? scroller.scrollTop : window.scrollY;
      if (Math.abs(top - lastTop) < 4) {
        stable++;
        if (stable >= 5) {
          // 再尝试展开一次，确认没有新增
          const c = clickExpanders();
          await sleep(pause);
          flush();
          if (c === 0) break;
          stable = 0;
        }
      } else {
        stable = 0;
        lastTop = top;
      }
    }

    flush();
    collecting = false;
    clog("采集结束，本次累计抓取(含重复)约", grand);
    return { ok: true, aborted: abort };
  }

  // ================= 接收拦截器 JSON（兜底）=================

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== TAG) return;
    if (d.kind !== "list" && d.kind !== "reply") return;
    let payload = d.payload;
    if (!payload && d.payloadText) {
      try { payload = JSON.parse(d.payloadText); } catch (_) { payload = null; }
    }
    if (!payload || !Array.isArray(payload.comments)) return;
    // 简单转发原始接口评论（字段更全时优先），此处复用同一存储通道
    const comments = payload.comments.map((c) => ({
      cid: String(c.cid),
      aweme_id: String(c.aweme_id || awemeId()),
      text: c.text || "",
      create_time: c.create_time || 0,
      create_time_text: "",
      digg_count: c.digg_count || 0,
      reply_comment_total: c.reply_comment_total || 0,
      reply_id: c.reply_id && c.reply_id !== "0" ? String(c.reply_id) : "",
      reply_to_reply_id: c.reply_to_reply_id && c.reply_to_reply_id !== "0" ? String(c.reply_to_reply_id) : "",
      reply_to_username: c.reply_to_username || "",
      parent_id:
        c.reply_to_reply_id && c.reply_to_reply_id !== "0"
          ? String(c.reply_to_reply_id)
          : c.reply_id && c.reply_id !== "0"
          ? String(c.reply_id)
          : null,
      level: c.reply_to_reply_id && c.reply_to_reply_id !== "0" ? 2 : c.reply_id && c.reply_id !== "0" ? 1 : 0,
      user: {
        uid: (c.user && (c.user.uid || c.user.uid_str)) || "",
        unique_id: (c.user && c.user.unique_id) || "",
        nickname: (c.user && c.user.nickname) || "",
        sec_uid: (c.user && c.user.sec_uid) || "",
      },
    }));
    clog(`拦截器命中 ${d.kind}: ${comments.length} 条`);
    try { chrome.runtime.sendMessage({ type: "COMMENTS", source: "api", comments }); } catch (_) {}
  });

  // ================= 指令 =================

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === "START_COLLECT") {
      autoCollect(msg.opts || {}).then((r) => {
        try { chrome.runtime.sendMessage({ type: "COLLECT_DONE", result: r }); } catch (_) {}
      });
      sendResponse({ started: true });
      return true;
    }
    if (msg.type === "STOP_COLLECT") {
      abort = true;
      sendResponse({ stopped: true });
      return true;
    }
    if (msg.type === "SCAN_ONCE") {
      const n = flush();
      sendResponse({ ok: true, scanned: n });
      return true;
    }
    if (msg.type === "PING") {
      sendResponse({ ok: true, collecting, threads: document.querySelectorAll(SEL.thread).length });
      return true;
    }
  });

  clog("content.js 就绪，视频:", awemeId());
})();
