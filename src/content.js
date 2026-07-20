// content.js —— 运行在 ISOLATED world。
// 职责：
//  1. 接收 interceptor.js 通过 postMessage 传来的评论 API JSON；
//  2. 归一化字段、计算每条评论的父节点（回复关系）；
//  3. 转发给 background 累积存储；
//  4. 响应 popup 的指令：自动滚动加载 + 自动展开回复、状态查询。

(function () {
  "use strict";

  const TAG = "TK_SCRAPER";
  const clog = (...a) => console.log("%c[TK内容]", "color:#00b894", ...a);

  // ---------- 注入页面拦截器（MAIN 上下文）----------
  // 用 <script src> 注入，兼容性好于 manifest 的 world:MAIN。
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/interceptor.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
    clog("已注入拦截器");
  } catch (e) {
    clog("注入拦截器失败", e);
  }

  // ---------- 归一化 ----------

  function pickUser(u) {
    u = u || {};
    return {
      uid: u.uid || u.uid_str || "",
      unique_id: u.unique_id || "",
      nickname: u.nickname || "",
      sec_uid: u.sec_uid || "",
    };
  }

  // 从一条原始评论对象里抽取我们关心的字段，并计算父子关系。
  function normalize(c, awemeId) {
    if (!c || !c.cid) return null;

    const replyId = c.reply_id && c.reply_id !== "0" ? String(c.reply_id) : "";
    const replyToReply =
      c.reply_to_reply_id && c.reply_to_reply_id !== "0"
        ? String(c.reply_to_reply_id)
        : "";

    // 父节点判定：
    //   顶层评论            -> parent = null, level = 0
    //   回复顶层评论        -> parent = reply_id(顶层cid), level = 1
    //   回复某条回复(楼中楼) -> parent = reply_to_reply_id, level = 2
    let parentId = null;
    let level = 0;
    if (replyToReply) {
      parentId = replyToReply;
      level = 2;
    } else if (replyId) {
      parentId = replyId;
      level = 1;
    }

    return {
      cid: String(c.cid),
      aweme_id: String(c.aweme_id || awemeId || ""),
      text: c.text || "",
      create_time: c.create_time || 0,
      digg_count: c.digg_count || 0,
      reply_comment_total: c.reply_comment_total || 0,
      // 关系字段（原样保留 + 计算结果）
      reply_id: replyId, // 所属顶层评论 cid（回复才有）
      reply_to_reply_id: replyToReply, // 直接回复的那条回复 cid（楼中楼才有）
      reply_to_username: c.reply_to_username || "",
      parent_id: parentId,
      level: level,
      user: pickUser(c.user),
    };
  }

  // 一个评论列表响应里，除了顶层评论，顶层评论对象里还可能内嵌 reply_comment 预览。
  function extractAll(payload) {
    const out = [];
    const awemeId = payload && payload.comments && payload.comments[0]
      ? payload.comments[0].aweme_id
      : "";
    const list = (payload && payload.comments) || [];
    for (const c of list) {
      const n = normalize(c, awemeId);
      if (n) out.push(n);
      // 顶层评论里内嵌的少量回复预览
      if (Array.isArray(c.reply_comment)) {
        for (const rc of c.reply_comment) {
          const rn = normalize(rc, awemeId);
          if (rn) out.push(rn);
        }
      }
    }
    return out;
  }

  // ---------- 接收拦截数据 ----------

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== TAG) return;

    if (d.kind === "list" || d.kind === "reply") {
      let payload = d.payload;
      if (!payload && d.payloadText) {
        try {
          payload = JSON.parse(d.payloadText);
        } catch (_) {
          payload = null;
        }
      }
      if (!payload) return;
      const comments = extractAll(payload);
      clog(`收到 ${d.kind}，解析出 ${comments.length} 条`);
      if (comments.length) {
        try {
          chrome.runtime.sendMessage(
            {
              type: "COMMENTS",
              source: d.kind,
              url: d.url,
              comments: comments,
              has_more: payload.has_more,
              total: payload.total,
              pageUrl: location.href,
            },
            (resp) => {
              if (chrome.runtime.lastError) {
                clog("转发到后台失败", chrome.runtime.lastError.message);
              } else if (resp) {
                clog(`后台已存，新增 ${resp.added}，累计 ${resp.stats && resp.stats.total}`);
              }
            }
          );
        } catch (e) {
          clog("sendMessage 异常", e);
        }
      }
    } else if (d.kind === "ready") {
      clog("拦截器就绪信号已收到 ✅");
    }
  });

  // ---------- 自动采集：滚动 + 展开回复 ----------

  let collecting = false;
  let collectAbort = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 找到评论区可滚动容器（best-effort，多重回退）
  function findCommentScroller() {
    const candidates = [
      '[class*="DivCommentListContainer"]',
      '[data-e2e="comment-list"]',
      '[class*="CommentListContainer"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // 点击所有"查看更多回复 / 展开回复"按钮，触发 reply 接口
  function clickExpanders() {
    let clicked = 0;
    const nodes = document.querySelectorAll(
      '[data-e2e="comment-reply"], p, span, button, div'
    );
    const re = /(view|查看|展开)[^\n]{0,12}(repl|回复|条回复|more)/i;
    for (const el of nodes) {
      const t = (el.textContent || "").trim();
      if (t.length > 0 && t.length < 40 && re.test(t)) {
        // 避免点到父级大容器
        if (el.childElementCount <= 3) {
          try {
            el.click();
            clicked++;
          } catch (_) {}
        }
      }
    }
    return clicked;
  }

  async function autoCollect(opts) {
    if (collecting) return { ok: false, msg: "已在采集中" };
    collecting = true;
    collectAbort = false;

    const maxRounds = (opts && opts.maxRounds) || 400;
    const pause = (opts && opts.pause) || 900;

    const scroller = findCommentScroller();
    let lastH = -1;
    let stable = 0;

    for (let i = 0; i < maxRounds && !collectAbort; i++) {
      // 先展开可见的回复
      clickExpanders();
      await sleep(300);

      // 滚动评论容器；找不到容器就滚动窗口
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
      await sleep(pause);

      const h = scroller ? scroller.scrollHeight : document.body.scrollHeight;
      if (h === lastH) {
        stable++;
        // 连续多轮高度不变，再点一次展开确认到底
        if (stable >= 4) {
          const c = clickExpanders();
          await sleep(pause);
          if (c === 0) break; // 没有可展开的、也不再增长 -> 结束
          stable = 0;
        }
      } else {
        stable = 0;
        lastH = h;
      }
    }

    collecting = false;
    return { ok: true, aborted: collectAbort };
  }

  // ---------- 与 popup / background 通信 ----------

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === "START_COLLECT") {
      autoCollect(msg.opts || {}).then((r) => {
        try {
          chrome.runtime.sendMessage({ type: "COLLECT_DONE", result: r, pageUrl: location.href });
        } catch (_) {}
      });
      sendResponse({ started: true });
      return true;
    }
    if (msg.type === "STOP_COLLECT") {
      collectAbort = true;
      sendResponse({ stopped: true });
      return true;
    }
    if (msg.type === "PING") {
      sendResponse({ ok: true, collecting: collecting, pageUrl: location.href });
      return true;
    }
  });
})();
