"""
TikTok 评论采集（Playwright 版）
====================================

借真实浏览器发请求，评论 API 的 X-Gnarly / X-Dynosaur 签名由浏览器原生生成，
从而绕开 DouK 后端无法生成 X-Dynosaur 的限制。

复用同目录上层 Volume/settings.json 里已配置好的:
  - cookie_tiktok  (登录态)
  - proxy_tiktok   (代理)

依赖安装:
    pip install playwright
    playwright install chromium

用法:
    python playwright_collector/collect_comments.py <视频链接>
    # 无头(不弹窗)模式:
    python playwright_collector/collect_comments.py <视频链接> --headless

输出:
    Volume/Comments/comments_<aweme_id>.json
    含 comments(顶层评论) 与 replies(回复) 的原始 JSON，字段带 cid /
    reply_id / reply_to_reply_id，可直接还原"谁回复谁"的树形关系。
"""

import asyncio
import json
import re
import sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print(
        "未安装 playwright，请先运行:\n"
        "  pip install playwright\n"
        "  playwright install chromium"
    )
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
SETTINGS = ROOT / "Volume" / "settings.json"
OUT_DIR = ROOT / "Volume" / "Comments"


def load_settings() -> dict:
    for enc in ("utf-8-sig", "utf-8"):
        try:
            with open(SETTINGS, encoding=enc) as f:
                return json.load(f)
        except FileNotFoundError:
            raise SystemExit(f"找不到配置文件: {SETTINGS}")
        except (UnicodeError, json.JSONDecodeError):
            continue
    raise SystemExit(f"配置文件解析失败: {SETTINGS}")


def to_pw_cookies(cookie_dict: dict) -> list[dict]:
    out = []
    for k, v in cookie_dict.items():
        out.append(
            {
                "name": str(k),
                "value": str(v),
                "domain": ".tiktok.com",
                "path": "/",
            }
        )
    return out


def extract_aweme_id(url: str) -> str:
    m = re.search(r"/video/(\d+)", url) or re.search(r"(\d{15,})", url)
    return m.group(1) if m else "unknown"


async def collect(video_url: str, headless: bool = False) -> None:
    s = load_settings()
    cookie_dict = s.get("cookie_tiktok") or {}
    if not isinstance(cookie_dict, dict) or not cookie_dict:
        raise SystemExit("settings.json 中 cookie_tiktok 为空或不是字典格式")
    proxy = s.get("proxy_tiktok") or None
    aweme_id = extract_aweme_id(video_url)

    comments: dict[str, dict] = {}  # cid -> 顶层评论原始 JSON
    replies: dict[str, dict] = {}  # cid -> 回复原始 JSON
    state = {"has_more": None, "pages": 0}
    pending: set = set()

    async def on_response(resp) -> None:
        url = resp.url
        if "/api/comment/list" not in url:
            return
        try:
            data = await resp.json()
        except Exception:
            return
        items = data.get("comments") or []
        if "/api/comment/list/reply" in url:
            for c in items:
                if cid := c.get("cid"):
                    replies[cid] = c
            if items:
                print(f"  [回复] +{len(items)}  累计回复 {len(replies)}")
        else:
            new = 0
            for c in items:
                cid = c.get("cid")
                if cid and cid not in comments:
                    comments[cid] = c
                    new += 1
            state["has_more"] = data.get("has_more")
            state["pages"] += 1
            print(
                f"  [评论] +{new}  累计 {len(comments)}  "
                f"has_more={state['has_more']}"
            )

    def handler(resp) -> None:
        t = asyncio.create_task(on_response(resp))
        pending.add(t)
        t.add_done_callback(pending.discard)

    async with async_playwright() as pw:
        launch_kwargs = {
            "headless": headless,
            "args": ["--disable-blink-features=AutomationControlled"],
        }
        if proxy:
            launch_kwargs["proxy"] = {"server": proxy}
            print(f"使用代理: {proxy}")
        browser = await pw.chromium.launch(**launch_kwargs)
        context = await browser.new_context(
            locale="ja-JP",
            viewport={"width": 1280, "height": 900},
        )
        await context.add_cookies(to_pw_cookies(cookie_dict))
        page = await context.new_page()
        page.on("response", handler)

        print(f"打开视频: {video_url}")
        await page.goto(video_url, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(5000)

        # best-effort 关闭登录/弹窗
        for sel in (
            '[data-e2e="modal-close-inner-button"]',
            'div[aria-label="Close"]',
            'div[aria-label="閉じる"]',
        ):
            try:
                if el := await page.query_selector(sel):
                    await el.click()
                    await page.wait_for_timeout(800)
            except Exception:
                pass

        print("开始滚动加载评论...")
        stagnant = 0
        last_count = 0
        for _ in range(200):
            await page.evaluate(
                """() => {
                const item = document.querySelector('[class*="DivCommentObjectWrapper"]');
                let el = item;
                while (el) {
                    const st = getComputedStyle(el);
                    if ((st.overflowY === 'auto' || st.overflowY === 'scroll')
                        && el.scrollHeight > el.clientHeight + 20) {
                        el.scrollTop = el.scrollHeight;
                        return;
                    }
                    el = el.parentElement;
                }
                window.scrollTo(0, document.body.scrollHeight);
            }"""
            )
            await page.wait_for_timeout(1800)
            if len(comments) == last_count:
                stagnant += 1
            else:
                stagnant = 0
                last_count = len(comments)
            if state["has_more"] == 0 and stagnant >= 2:
                break
            if stagnant >= 6:
                break

        # best-effort 展开"查看更多回复"，触发回复接口
        print("展开回复...")
        for _ in range(80):
            btns = await page.query_selector_all(
                '[class*="DivViewRepliesContainer"], [class*="ViewRepliesContainer"]'
            )
            clicked = 0
            for b in btns:
                try:
                    await b.scroll_into_view_if_needed(timeout=2000)
                    await b.click(timeout=2000)
                    clicked += 1
                    await page.wait_for_timeout(500)
                except Exception:
                    pass
            if clicked == 0:
                break
            await page.wait_for_timeout(800)

        await page.wait_for_timeout(2000)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await browser.close()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"comments_{aweme_id}.json"
    result = {
        "aweme_id": aweme_id,
        "video_url": video_url,
        "top_level_count": len(comments),
        "reply_count": len(replies),
        "comments": list(comments.values()),
        "replies": list(replies.values()),
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n完成：顶层评论 {len(comments)} 条，回复 {len(replies)} 条")
    print(f"已保存: {out}")
    if not comments:
        print(
            "\n未采到评论。排查：\n"
            "  1) 浏览器窗口里是否已登录、评论区是否正常显示？\n"
            "  2) 该视频是否关闭了评论 / 评论数为 0？\n"
            "  3) 代理是否为可访问 TikTok 的节点？"
        )


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(
            "用法: python playwright_collector/collect_comments.py "
            "<视频链接> [--headless]"
        )
        sys.exit(1)
    url = args[0]
    headless = "--headless" in args[1:]
    asyncio.run(collect(url, headless=headless))


if __name__ == "__main__":
    main()
