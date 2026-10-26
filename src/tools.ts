/**
 * MCP 工具定义。
 *
 * 设计原则：
 * - 只暴露只读能力。签到、答题、发弹幕等写操作会代替用户产生副作用，不在此处提供。
 * - 参数命名一律 camelCase 对外，内部转换到平台实际的 snake_case / 驼峰混用。
 * - 错误统一转成可读文本 + 下一步建议，不把原始 body 抛给调用方。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import QRCode from 'qrcode';
import { REGION_NAMES, YktClient, YktError, isRegion, type Region } from './client.ts';
import { requestQr, waitForLogin, type LoginResult } from './login.ts';
import { clearSession, listStoredRegions, loadSession, saveSession, stateDir } from './session.ts';
import {
  getClassroom,
  getCourseProgress,
  getLectureNoteDetail,
  getLessonInfo,
  getLessonSummary,
  getLiveLessons,
  getMindMap,
  getReplayTimeline,
  getScoreDetail,
  listActivities,
  listAnnouncements,
  listCourses,
  listLectureNotes,
  listSlides,
  listTopics,
} from './api.ts';

const regionEnum = z.enum(['standard', 'hetang', 'changjiang', 'huanghe']);

/** 由区域取已保存的客户端；未登录时给出明确指引。 */
function clientFor(region: Region): YktClient {
  const stored = loadSession(region);
  if (!stored) {
    throw new YktError(`${REGION_NAMES[region]} 尚未登录`, {
      nextAction: `先调用 ykt_login 并选择 region="${region}"`,
    });
  }
  return new YktClient(region, stored.sessionid);
}

function failText(e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (e instanceof YktError) {
    const lines = [`错误: ${e.message}`];
    if (e.code !== undefined) lines.push(`平台码: ${e.code}（字段体系: ${e.family ?? '未知'}）`);
    if (e.nextAction) lines.push(`建议: ${e.nextAction}`);
    if (e.retryable) lines.push('可重试');
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
  }
  return {
    content: [{ type: 'text', text: `错误: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

function jsonText(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** 相对毫秒时间戳转可读时间，避免调用方自己算。 */
function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'yuketang', version: '0.1.0' });

  server.registerTool(
    'ykt_login',
    {
      title: '雨课堂扫码登录',
      description:
        '获取二维码并等待扫码确认。二维码以文本形式返回（可直接在终端显示），同时给出图片文件路径。' +
        '四个区域（standard/hetang/changjiang/huanghe）的会话互不通用，请选择账号实际所在的区域。',
      inputSchema: {
        region: regionEnum.default('standard').describe('雨课堂区域'),
        timeoutSeconds: z.number().int().min(30).max(280).default(200).describe('等待扫码的秒数'),
      },
    },
    async ({ region, timeoutSeconds }) => {
      try {
        const ticket = await requestQr(region);
        const ascii = await QRCode.toString(ticket.qrContent, { type: 'terminal', small: true });

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutSeconds * 1000);
        let result: LoginResult | null;
        try {
          result = await waitForLogin(ticket, { signal: ac.signal });
        } finally {
          clearTimeout(timer);
        }

        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: `等待超时，未完成扫码。\n\n${ascii}\n\n二维码内容:\n${ticket.qrContent}`,
              },
            ],
            isError: true,
          };
        }

        saveSession(result.region, result.sessionid);
        return jsonText({
          ok: true,
          region: result.region,
          regionName: REGION_NAMES[result.region],
          account: result.name,
          userId: result.userId,
          savedAt: stateDir(),
          next: '可调用 ykt_courses 查看课程',
        });
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_status',
    {
      title: '登录状态',
      description: '检查各区域已保存的会话是否仍然有效，返回账号名用于确认登录的是哪个账号。',
      inputSchema: {
        region: regionEnum.optional().describe('只检查某个区域；省略则检查全部'),
      },
    },
    async ({ region }) => {
      const regions = region ? [region as Region] : listStoredRegions();
      if (regions.length === 0) {
        return jsonText({ loggedIn: false, hint: '未保存任何会话，请调用 ykt_login' });
      }
      const results = [];
      for (const r of regions) {
        const stored = loadSession(r);
        if (!stored) {
          results.push({ region: r, loggedIn: false, reason: '未保存' });
          continue;
        }
        try {
          const client = new YktClient(r, stored.sessionid);
          const info = await client.verify();
          results.push({
            region: r,
            regionName: REGION_NAMES[r],
            loggedIn: true,
            name: typeof info.name === 'string' ? info.name : '',
            school: typeof info.school === 'string' ? info.school : '',
          });
        } catch (e) {
          results.push({
            region: r,
            loggedIn: false,
            reason: e instanceof YktError ? e.message : String(e),
            hint: '会话可能已过期，重新调用 ykt_login',
          });
        }
      }
      return jsonText({ loggedIn: results.some((r) => r.loggedIn), regions: results });
    },
  );

  server.registerTool(
    'ykt_logout',
    {
      title: '退出登录',
      description: '删除本地保存的会话。不会影响其他设备上的登录状态。',
      inputSchema: { region: regionEnum.describe('要清除的区域') },
    },
    async ({ region }) => {
      const removed = clearSession(region);
      return jsonText({ removed, region });
    },
  );

  server.registerTool(
    'ykt_courses',
    {
      title: '课程列表',
      description:
        '列出所有课程（按学期分组）。classroomId 是后续查活动、章节、公告的入口；' +
        'courseId 用于查章节进度。',
      inputSchema: {
        region: regionEnum.default('standard'),
        term: z.number().int().optional().describe('只返回某学期，如 202601；省略返回全部'),
      },
    },
    async ({ region, term }) => {
      try {
        const client = clientFor(region);
        const all = await listCourses(client);
        const filtered = term === undefined ? all : all.filter((c) => c.term === term);
        const byTerm = new Map<number, typeof filtered>();
        for (const c of filtered) {
          const arr = byTerm.get(c.term) ?? [];
          arr.push(c);
          byTerm.set(c.term, arr);
        }
        const terms = [...byTerm.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([t, list]) => ({ term: t, count: list.length, courses: list }));
        return jsonText({ total: filtered.length, terms });
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_activities',
    {
      title: '课程活动时间轴',
      description:
        '列出某课程的活动（上课记录、作业、公告）。type 含义：5=试卷作业，9=公告，14=上课记录，19=章节作业。' +
        '上课记录的 coursewareId 即 lessonId，用于查课件。',
      inputSchema: {
        region: regionEnum.default('standard'),
        classroomId: z.string().min(1).describe('课程班级 ID'),
        page: z.number().int().min(0).default(0).describe('页号，从 0 开始'),
        size: z.number().int().min(1).max(200).default(50).describe('每页条数'),
      },
    },
    async ({ region, classroomId, page, size }) => {
      try {
        const client = clientFor(region);
        const { activities, complete } = await listActivities(client, classroomId, { page, size });
        return jsonText({
          page,
          count: activities.length,
          complete,
          activities: activities.map((a) => ({
            ...a,
            createTimeText: fmtTime(a.createTime),
            typeName:
              a.type === 5
                ? '试卷作业'
                : a.type === 9
                  ? '公告'
                  : a.type === 14
                    ? '上课记录'
                    : a.type === 19
                      ? '章节作业'
                      : `类型${a.type}`,
          })),
        });
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_lesson',
    {
      title: '课时详情',
      description:
        '查询一次课堂的元信息与课件清单。presentationIds 是数组，一次课可能有多份课件。',
      inputSchema: {
        region: regionEnum.default('standard'),
        lessonId: z.string().min(1).describe('课时 ID（来自活动列表的 coursewareId）'),
      },
    },
    async ({ region, lessonId }) => {
      try {
        const client = clientFor(region);
        const info = await getLessonInfo(client, lessonId);
        return jsonText({ ...info, startText: undefined });
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_slides',
    {
      title: '课件幻灯片',
      description:
        '获取一份课件的全部页面。返回页码与图片地址；图片可直接 HTTP 下载，无需 Cookie 或鉴权参数。' +
        '题目字段通常为 null（课后不返回题目内容）。',
      inputSchema: {
        region: regionEnum.default('standard'),
        presentationId: z.string().min(1).describe('课件 ID'),
        lessonId: z.string().min(1).describe('所属课时 ID'),
        withProblem: z.boolean().default(false).describe('是否附带题目字段（若存在）'),
      },
    },
    async ({ region, presentationId, lessonId, withProblem }) => {
      try {
        const client = clientFor(region);
        const slides = await listSlides(client, presentationId, lessonId);
        return jsonText({
          count: slides.length,
          slides: slides.map((s) => ({
            index: s.index,
            id: s.id,
            image: s.cover,
            ...(withProblem ? { problem: s.problem } : {}),
          })),
        });
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_lesson_summary',
    {
      title: '课堂小结',
      description: '课堂概览：课件清单、签到状态、课堂标题。用于快速了解一次课的构成。',
      inputSchema: {
        region: regionEnum.default('standard'),
        lessonId: z.string().min(1),
      },
    },
    async ({ region, lessonId }) => {
      try {
        const client = clientFor(region);
        const summary = await getLessonSummary(client, lessonId);
        return jsonText(summary);
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_replay_timeline',
    {
      title: '回放时间线',
      description:
        '获取课堂回放的完整事件序列，包括老师每次翻页的页码与时间。' +
        'shownSlideIndexes 是实际展示过的页，这是判断「哪些页讲过」的唯一可靠途径。',
      inputSchema: {
        region: regionEnum.default('standard'),
        lessonId: z.string().min(1),
        includeEvents: z.boolean().default(true).describe('是否返回完整事件序列'),
      },
    },
    async ({ region, lessonId, includeEvents }) => {
      try {
        const client = clientFor(region);
        const { events, durationMs, shownSlideIndexes } = await getReplayTimeline(client, lessonId);
        return jsonText({
          durationMinutes: Math.round(durationMs / 60000),
          shownSlideCount: shownSlideIndexes.length,
          shownSlideIndexes,
          ...(includeEvents
            ? {
                events: events.map((e) => ({
                  ...e,
                  atText: fmtTime(e.at),
                })),
              }
            : {}),
        });
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_mind_map',
    {
      title: 'AI 课堂思维导图',
      description: '获取平台为这节课自动生成的思维导图（树形结构，含层级）。',
      inputSchema: {
        region: regionEnum.default('standard'),
        lessonId: z.string().min(1),
      },
    },
    async ({ region, lessonId }) => {
      try {
        const client = clientFor(region);
        const map = await getMindMap(client, lessonId);
        if (!map) return jsonText({ available: false, hint: '该课时没有生成思维导图' });
        return jsonText({ available: true, mindMap: map });
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_notes',
    {
      title: '课堂笔记',
      description:
        '列出课堂笔记；提供 liveId 时返回该笔记的正文。先用不带 liveId 的调用拿目录，再按需取正文。',
      inputSchema: {
        region: regionEnum.default('standard'),
        lessonId: z.string().min(1),
        liveId: z.string().optional().describe('省略则只返回目录'),
      },
    },
    async ({ region, lessonId, liveId }) => {
      try {
        const client = clientFor(region);
        if (liveId) {
          const notes = await getLectureNoteDetail(client, lessonId, liveId);
          return jsonText({ liveId, count: notes.length, notes });
        }
        return jsonText(await listLectureNotes(client, lessonId));
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_score',
    {
      title: '学情分数',
      description: '某次课的得分构成：签到、课堂题、测验各占比例与得分。',
      inputSchema: {
        region: regionEnum.default('standard'),
        lessonId: z.string().min(1),
      },
    },
    async ({ region, lessonId }) => {
      try {
        const client = clientFor(region);
        return jsonText(await getScoreDetail(client, lessonId));
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_course_progress',
    {
      title: '课程章节与进度',
      description:
        '获取课程完整章节树，含每个叶子的类型、完成度、分数与截止时间。' +
        'leafType 含义：0=视频，3=推荐，4=讨论，5=考试/作业，6=作业，8=签到/课堂，19=章节作业。',
      inputSchema: {
        region: regionEnum.default('standard'),
        classroomId: z.string().min(1),
        courseId: z.string().min(1).describe('课程 ID（来自 ykt_courses 的 courseId）'),
      },
    },
    async ({ region, classroomId, courseId }) => {
      try {
        const client = clientFor(region);
        const { skuId, leaves } = await getCourseProgress(client, classroomId, courseId);
        return jsonText({
          skuId,
          count: leaves.length,
          leaves: leaves.map((l) => ({
            ...l,
            deadlineText: l.scoreDeadline ? fmtTime(l.scoreDeadline) : null,
          })),
        });
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_live',
    {
      title: '正在上课 / 待考试',
      description:
        '列出当前正在进行的课堂和即将开始的考试。' +
        '进入课堂实时内容需要先签到换取课堂令牌，本服务不代签到，因此只提供只读概览。',
      inputSchema: { region: regionEnum.default('standard') },
    },
    async ({ region }) => {
      try {
        const client = clientFor(region);
        return jsonText(await getLiveLessons(client));
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_discussion',
    {
      title: '讨论区与公告',
      description: '读取课程公告或讨论区帖子列表。',
      inputSchema: {
        region: regionEnum.default('standard'),
        classroomId: z.string().min(1),
        kind: z.enum(['announcements', 'topics']).default('announcements'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ region, classroomId, kind, limit, offset }) => {
      try {
        const client = clientFor(region);
        if (kind === 'topics') {
          return jsonText(await listTopics(client, classroomId, { limit, offset }));
        }
        return jsonText({ items: await listAnnouncements(client, classroomId, { limit, offset }) });
      } catch (e) {
        return failText(e);
      }
    },
  );

  server.registerTool(
    'ykt_classroom',
    {
      title: '课程班级详情',
      description: '某课程班级的详细信息：课程名、教师、学校 ID、班级起止时间。',
      inputSchema: {
        region: regionEnum.default('standard'),
        classroomId: z.string().min(1),
      },
    },
    async ({ region, classroomId }) => {
      try {
        const client = clientFor(region);
        return jsonText(await getClassroom(client, classroomId));
      } catch (e) {
        return failText(e);
      }
    },
  );

  return server;
}

export { isRegion };
