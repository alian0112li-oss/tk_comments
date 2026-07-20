# TikTok 评论采集器（Chrome 扩展 · MV3）

采集 TikTok 视频评论区数据，**保留评论与回复的上下文关系**（顶层评论 → 回复 → 楼中楼回复），导出为树形 JSON 或扁平 CSV。

## 工作原理

不主动构造请求（TikTok 的接口需要签名参数），而是**搭便车**：在页面里劫持 `fetch` / `XMLHttpRequest`，读取 TikTok 自己拉取评论时返回的 JSON。这些响应天然带有关系字段：

| 字段 | 含义 |
| --- | --- |
| `cid` | 评论唯一 id |
| `reply_id` | 该回复所属的**顶层评论** cid（顶层评论为 `0`）|
| `reply_to_reply_id` | 楼中楼时，直接回复的那条**回复** cid |
| `reply_comment_total` | 顶层评论的回复总数 |

扩展据此计算每条评论的 `parent_id` 与 `level`（0=顶层 / 1=回复 / 2=楼中楼），并在导出时重建成树。

## 目录结构

```
manifest.json          扩展清单（MV3）
src/interceptor.js     MAIN world：劫持 fetch/XHR，捕获评论 API 响应
src/content.js         ISOLATED：归一化、算父子关系、自动滚动+展开回复
src/background.js      service worker：按视频去重累积存储
src/popup.html/js      控制面板：采集/统计/重建树/导出 JSON·CSV
```

## 安装（目标电脑上）

1. Chrome 打开 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本项目文件夹
4. 确保浏览器已登录 TikTok

## 使用

1. 打开某个视频页，展开评论区（让评论至少加载出第一屏）。
2. 点扩展图标 → 「▶ 开始采集」。脚本会自动滚动评论区、点击「查看更多回复」，实时拦截数据。
3. 面板里的「已采集评论」数字会实时增长；到底后会自动停止，也可手动「■ 停止」。
4. 「导出 JSON(树)」得到带 `children` 的树形结构；「导出 CSV」得到扁平表（含 `parent_id`/`level` 关系列）。

> 采集期间请保持该标签页在前台。数据按 `aweme_id`（视频）去重存储在扩展本地，可跨多个视频累积。

## 导出示例（JSON 树）

```json
{
  "aweme_id": "7xxxx",
  "total": 128,
  "tree": [
    {
      "cid": "111", "text": "顶层评论", "level": 0, "digg_count": 20,
      "user": { "nickname": "A", "unique_id": "a" },
      "children": [
        { "cid": "222", "text": "回复A", "level": 1, "parent_id": "111",
          "children": [
            { "cid": "333", "text": "回复222的楼中楼", "level": 2, "parent_id": "222", "reply_to_username": "B", "children": [] }
          ]
        }
      ]
    }
  ]
}
```

## 已知限制 / 待打磨

- 自动"展开回复"按钮靠文案匹配（中英文），TikTok 改版可能需要调整 `content.js` 里的选择器/正则。
- 楼中楼很深时，若某个中间回复未被加载，树会把它挂到所属顶层评论下（不会丢，只是层级回退）。
- 仅采集页面已加载的数据，不做无限翻页之外的额外请求。
