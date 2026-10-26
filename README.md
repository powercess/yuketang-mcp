# @powercess/yuketang-mcp

雨课堂（Yuketang / 雨课堂）MCP 服务器：把雨课堂网页端的能力封装成 AI 可直接调用的工具。

扫码登录一次，即可让 AI 助手读取课程、课件、课堂回顾、AI 思维导图、回放时间线与作业进度。

## 能做什么

| 工具 | 能力 |
|---|---|
| `ykt_login` | 扫码登录（二维码直接在对话里显示） |
| `ykt_status` | 检查会话有效性，确认登录的是哪个账号 |
| `ykt_logout` | 清除本地会话 |
| `ykt_courses` | 课程列表（按学期分组） |
| `ykt_classroom` | 课程班级详情 |
| `ykt_activities` | 课程活动时间轴（上课记录 / 作业 / 公告） |
| `ykt_lesson` | 课时详情与课件清单 |
| `ykt_slides` | 课件全量幻灯片 + 图片地址 |
| `ykt_lesson_summary` | 课堂概览（课件、签到状态） |
| `ykt_replay_timeline` | 回放时间线，含老师每次翻页 |
| `ykt_mind_map` | AI 生成的课堂思维导图 |
| `ykt_notes` | 课堂笔记目录与正文 |
| `ykt_score` | 学情分数构成 |
| `ykt_course_progress` | 章节树 + 完成度 + 分数 + 截止时间 |
| `ykt_live` | 正在上课 / 待开始考试 |
| `ykt_discussion` | 课程公告与讨论区 |

**全部为只读操作。** 签到、答题、发弹幕等会产生副作用的行为不在此实现——那等于代替你本人操作。

## 安装

需要 Node ≥ 23.4 或 Bun ≥ 1.x。

```bash
npm install -g @powercess/yuketang-mcp
yuketang-mcp
```

本地开发：

```bash
npm install && npm run build   # Node
bun run dev                    # Bun，直接运行 TypeScript，无需构建
```

## 接入 MCP 客户端

```json
{
  "mcpServers": {
    "yuketang": {
      "command": "npx",
      "args": ["-y", "@powercess/yuketang-mcp"]
    }
  }
}
```

## 登录

雨课堂分四个区域，**会话互不通用**，登录时必须选对：

| region | 名称 |
|---|---|
| `standard` | 雨课堂（默认） |
| `hetang` | 荷塘雨课堂 |
| `changjiang` | 长江雨课堂 |
| `huanghe` | 黄河雨课堂 |

调用 `ykt_login` 会返回二维码，用微信或雨课堂 App 扫码确认即可。二维码有效期约 5 分钟。

也可以跳过扫码，用环境变量直接提供会话：

```bash
YKT_REGION=standard YKT_SESSIONID=<your-sessionid> yuketang-mcp
```

会话保存在 `~/.yuketang-mcp/`（目录 0700、文件 0600），只存 `sessionid`，不存姓名或学号。

## 配置

| 环境变量 | 说明 |
|---|---|
| `YKT_REGION` | 区域，配合 `YKT_SESSIONID` 使用 |
| `YKT_SESSIONID` | 直接提供会话，跳过扫码 |
| `YKT_STATE_DIR` | 会话保存目录，默认 `~/.yuketang-mcp/` |

## 使用提示

- **课件图片无需鉴权**：`ykt_slides` 返回的图片地址可直接 HTTP 下载，不需要 Cookie。
- **判断「哪些页讲过」用回放时间线**：课件接口的 `visible` 字段恒为 true，没有区分度；`ykt_replay_timeline` 的 `shownSlideIndexes` 才是实际展示过的页。
- **章节数据用 `ykt_course_progress`**：它含完成度、分数与截止时间，比抽象的章节树更适合直接消费。
- **活动分页**：`offset` 是每页条数而非跳过条数，`page` 从 0 开始。

## 已知边界

- 雨课堂没有公开 API，本服务使用学生端接口。平台改版可能失效。
- 进入课堂实时内容需要先签到换取课堂令牌。本服务不代签到，因此只提供只读概览。
- 已完成的作业无法读取题面（平台返回无权限）。
- 未实现的能力：位置签到、动态二维码签到、考试作答、讨论发帖。

## License

MIT
