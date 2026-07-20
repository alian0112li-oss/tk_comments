# TikTok 评论采集器（Chrome 扩展 · MV3）

采集 TikTok 视频评论区数据，**保留评论与回复的上下文关系**（顶层评论 → 回复 → 楼中楼回复），导出为树形 JSON 或扁平 CSV。

## 工作原理

**主方案：解析 DOM。** 回复关系由 DOM 嵌套天然编码——每个 `DivCommentObjectWrapper` = 一个顶层评论 + 它的 `DivReplyContainer`（该评论的所有回复）。扩展边自动滚动边解析，把「谁回复谁」按层级还原。因为 TikTok 是**虚拟列表**（滚出视口的评论会从 DOM 移除），所以采用「边滚边抓 + 去重累积」。

用到的稳定锚点：

| 锚点 | 含义 |
| --- | --- |
| `[class*="DivCommentObjectWrapper"]` | 一个顶层评论线程（含其回复）|
| `[data-e2e="comment-username-1/2"]` | 用户名（`-1` 顶层 / `-2` 回复）|
| `[data-e2e="comment-level-1/2"]` | 评论正文 |
| `[class*="DivReplyContainer"]` | 回复容器 |
| `查看 N 条回复`（在 `DivViewRepliesContainer`）| 回复总数 & 展开按钮 |
| `[class*="DivLikeContainer"]` | 点赞数 |

因 DOM 无评论 id，扩展用「作者+正文+时间」生成稳定哈希作 `cid` 去重；每条回复的 `parent_id` 指向所属顶层评论，`level`（0/1）标记层级，楼中楼再记 `reply_to_username`。

**兜底方案：网络拦截。** 同时注入脚本劫持 `fetch`/`XHR`，若能抓到评论 API JSON（自带 `cid`/`reply_id`/`reply_to_reply_id`），字段更全时一并存入。

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
4. 导出三选一（均已精简为「评论内容 + 回复关系」）：
   - **📊 导出 Excel(树形)** —— 标准 `.xlsx`，行按树形深度优先排序（回复紧跟父评论），列：`层级 | 评论内容(缩进) | 昵称 | 回复给`。零依赖生成（内置 `src/xlsx.js`），Excel/WPS 直接打开。
   - **导出 JSON(树)** —— 嵌套结构，节点只含 `text / nickname / reply_to / replies`。
   - **导出 CSV** —— 同 Excel 的四列。

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
