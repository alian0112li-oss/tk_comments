// interceptor.js —— 运行在页面 MAIN world，document_start 注入。
// 目的：在 TikTok 自己发起评论请求时，劫持 fetch / XMLHttpRequest 的响应，
// 拿到评论 API 的原始 JSON（里面自带回复关系字段），通过 postMessage 转交给 content.js。
// 不伪造/不主动发请求 —— 只是"搭便车"读取网站自己拉取的数据，签名参数由 TikTok 页面自行生成。

(function () {
  "use strict";

  const TAG = "TK_SCRAPER";

  // 需要捕获的评论接口。TikTok web 端：
  //   /api/comment/list/         -> 顶层评论
  //   /api/comment/list/reply/   -> 某条评论下的回复
  const COMMENT_URL_RE = /\/api\/comment\/list(\/reply)?\//;

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
    return /\/reply\//.test(url) ? "reply" : "list";
  }

  function forward(kind, url, json) {
    try {
      window.postMessage(
        { source: TAG, kind: kind, url: url, payload: json, ts: Date.now() },
        "*"
      );
    } catch (e) {
      // JSON 里若有无法结构化克隆的内容，退化为字符串传递
      try {
        window.postMessage(
          { source: TAG, kind: kind, url: url, payloadText: JSON.stringify(json), ts: Date.now() },
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
      return p.then(function (resp) {
        try {
          // clone 后异步读取，绝不影响页面自己的消费
          resp
            .clone()
            .json()
            .then(function (json) {
              forward(kind, url, json);
            })
            .catch(function () {});
        } catch (_) {}
        return resp;
      });
    };
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
        self.addEventListener("load", function () {
          try {
            let json = null;
            if (self.responseType === "" || self.responseType === "text") {
              json = JSON.parse(self.responseText);
            } else if (self.responseType === "json") {
              json = self.response;
            }
            if (json) forward(self.__tk_kind, self.__tk_url, json);
          } catch (_) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  // 让 content.js 知道拦截器已就位
  window.postMessage({ source: TAG, kind: "ready", ts: Date.now() }, "*");
})();
