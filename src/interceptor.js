// interceptor.js —— 由 content.js 注入到页面 MAIN 上下文运行。
// 目的：在 TikTok 自己发起评论请求时，劫持 fetch / XMLHttpRequest 的响应，
// 拿到评论 API 的原始 JSON（里面自带回复关系字段），通过 postMessage 转交给 content.js。
// 不伪造/不主动发请求 —— 只是"搭便车"读取网站自己拉取的数据，签名参数由 TikTok 页面自行生成。

(function () {
  "use strict";
  if (window.__TK_SCRAPER_HOOKED__) return; // 防重复注入
  window.__TK_SCRAPER_HOOKED__ = true;

  const TAG = "TK_SCRAPER";
  const DEBUG = true;
  const dlog = (...a) => DEBUG && console.log("%c[TK拦截]", "color:#6c5ce7", ...a);

  // 需要捕获的评论接口。放宽匹配以适配改版：
  //   /api/comment/list/         -> 顶层评论
  //   /api/comment/list/reply/   -> 某条评论下的回复
  const COMMENT_URL_RE = /\/api\/comment\/list/i;

  function urlOf(input) {
    try {
      if (typeof input === "string") return input;
      if (input instanceof Request) return input.url;
      if (input && input.url) return input.url;
      if (input && typeof input.toString === "function") return input.toString();
    } catch (_) {}
    return "";
  }

  function classify(url) {
    if (!COMMENT_URL_RE.test(url)) return null;
    return /\/reply\b|reply\//i.test(url) ? "reply" : "list";
  }

  function forward(kind, url, json) {
    const n = json && Array.isArray(json.comments) ? json.comments.length : 0;
    dlog(`捕获 ${kind}：${n} 条`, url.slice(0, 120));
    try {
      window.postMessage({ source: TAG, kind, url, payload: json, ts: Date.now() }, "*");
    } catch (e) {
      try {
        window.postMessage(
          { source: TAG, kind, url, payloadText: JSON.stringify(json), ts: Date.now() },
          "*"
        );
      } catch (_) {}
    }
  }

  // ---- 劫持 fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = urlOf(input);
      const kind = classify(url);
      const p = origFetch.apply(this, arguments);
      if (!kind) return p;
      dlog("fetch 命中评论接口", url.slice(0, 120));
      return p.then(function (resp) {
        try {
          resp
            .clone()
            .json()
            .then((json) => forward(kind, url, json))
            .catch((e) => dlog("解析 fetch 响应失败", e));
        } catch (_) {}
        return resp;
      });
    };
    dlog("fetch 已劫持");
  } else {
    dlog("警告：window.fetch 不可用");
  }

  // ---- 劫持 XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        this.__tk_url = url;
        this.__tk_kind = classify(String(url || ""));
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      const self = this;
      if (self.__tk_kind) {
        dlog("XHR 命中评论接口", String(self.__tk_url).slice(0, 120));
        self.addEventListener("load", function () {
          try {
            let json = null;
            if (self.responseType === "" || self.responseType === "text") {
              json = JSON.parse(self.responseText);
            } else if (self.responseType === "json") {
              json = self.response;
            }
            if (json) forward(self.__tk_kind, self.__tk_url, json);
          } catch (e) {
            dlog("解析 XHR 响应失败", e);
          }
        });
      }
      return origSend.apply(this, arguments);
    };
    dlog("XMLHttpRequest 已劫持");
  }

  dlog("拦截器就绪 ✅");
  window.postMessage({ source: TAG, kind: "ready", ts: Date.now() }, "*");
})();
