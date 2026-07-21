# TikTok 评论采集（Playwright 版）

用真实浏览器抓评论，绕开后端签名（X-Dynosaur）限制。评论请求由浏览器
原生发出、原生签名，脚本只做两件事：注入登录态 cookie + 拦截评论响应。

## 为什么用这个

DouK 的 Python 后端只能算 `X-Gnarly`，不会 `X-Dynosaur`。TikTok 评论接口
现在强制双签名，所以后端 `采集作品评论数据(TikTok)` 返回空。Playwright 驱动
真实 Chromium，签名由浏览器完成，因此能拿到评论。

## 安装（一次）

```bash
pip install playwright
playwright install chromium
```

## 使用

复用 `../Volume/settings.json` 里的 `cookie_tiktok` 和 `proxy_tiktok`，无需重配。

```bash
# 在项目根目录执行
python playwright_collector/collect_comments.py https://www.tiktok.com/@user/video/1234567890
```

- 默认弹出浏览器窗口（headed，更稳、能看进度）。加 `--headless` 可无窗口运行。
- 会自动滚动评论区加载分页、点击"查看更多回复"。

## 输出

`Volume/Comments/comments_<aweme_id>.json`

```jsonc
{
  "aweme_id": "…",
  "top_level_count": 120,
  "reply_count": 45,
  "comments": [ { "cid": "…", "text": "…", "reply_comment_total": 3, "user": {…}, … } ],
  "replies":  [ { "cid": "…", "text": "…", "reply_id": "父评论cid", "reply_to_reply_id": "…", … } ]
}
```

字段自带 `cid` / `reply_id` / `reply_to_reply_id`，可完整还原树形回复关系。

## 下一步（仿写）

把生成的 `comments_<id>.json` 交给 Claude，即可按"每组=顶层评论+其回复"
的结构仿写。
