/**
 * 只读业务接口。
 *
 * 选型依据「接口代际」结论，每个能力只实现最新一代，不做旧接口回退：
 * - 课件页：`lesson-summary/student/presentation`（`classroom-report/student/ppt` 的
 *   `visible` 恒为 true，无信息量；`lesson/presentation/fetch` 课后 401）
 * - 章节：`c27/.../course/progress`（`mooc-api/.../course/chapter` 返回 80019）
 * - 上课检测：`classroom/on-lesson`（`v/course_meta/on_lesson_courses` 会漏报）
 */

import { type Json, type YktClient, readData } from './client.ts';

export interface Course {
  classroomId: string;
  courseId: string;
  name: string;
  className: string;
  teacher: string;
  term: number;
  universityId?: number;
}

export interface Activity {
  id: string;
  type: number;
  title: string;
  coursewareId: string;
  createTime: number;
  finished: boolean;
  attended?: boolean;
}

export interface LessonInfo {
  lessonId: string;
  lessonName: string;
  courseName: string;
  classroomName: string;
  teacherName: string;
  activityId: string;
  skuId?: string;
  presentationIds: string[];
}

export interface Slide {
  id: string;
  /** 1-based 页码 */
  index: number;
  cover: string;
  problem: Json | null;
}

export interface Presentation {
  id: string;
  title: string;
  cover: string;
  slidesCount: number;
}

export interface LiveLesson {
  classroomId: string;
  courseId: string;
  courseName: string;
  classroomName: string;
  lessonId: string;
}

export interface LeafProgress {
  name: string;
  leafId: string;
  leafType: number;
  locked: boolean;
  scoreDeadline: number;
  status: string;
  userScore?: number;
  totalScore?: number;
  done?: number;
  total?: number;
}

export interface TimelineEvent {
  kind: 'slide' | 'event';
  /** 页码（仅 slide 事件） */
  slideIndex?: number;
  presentationId?: string;
  code?: string;
  title?: string;
  /** 毫秒时间戳 */
  at: number;
}



function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 课程列表。`identity=2` 是学生视角。 */
export async function listCourses(c: YktClient): Promise<Course[]> {
  const data = await c.data<Json>('/v2/api/web/courses/list', { query: { identity: 2 } });
  return asArray(data.list).map((raw) => {
    const item = asRecord(raw);
    const course = asRecord(item.course);
    return {
      classroomId: str(item.classroom_id),
      courseId: str(course.id),
      name: str(course.name) || str(item.name),
      className: str(item.name),
      teacher: str(asRecord(item.teacher).name),
      term: num(item.term),
      universityId: typeof course.university_id === 'number' ? course.university_id : undefined,
    };
  });
}

/** 课程详情，含 `free_sku_id` / `uv_id` 等后续接口需要的上下文。 */
export async function getClassroom(
  c: YktClient,
  classroomId: string,
): Promise<{ name: string; courseName: string; uvId?: number; skuId?: number; courseId: string }> {
  const data = await c.data<Json>(`/v2/api/web/classrooms/${classroomId}`, { query: { role: 5 } });
  return {
    name: str(data.name),
    courseName: str(data.course_name),
    uvId: typeof data.uv_id === 'number' ? data.uv_id : undefined,
    skuId: typeof data.free_sku_id === 'number' ? data.free_sku_id : undefined,
    courseId: str(data.course_id),
  };
}

/**
 * 课程活动时间轴。
 *
 * `offset` 是每页条数而非跳过条数；`page` 是 0 起的页号。
 * `has_more` 不可信（实测声称还有时其实已取完），因此用「返回条数 < offset」判断。
 */
export async function listActivities(
  c: YktClient,
  classroomId: string,
  opts: { page?: number; size?: number } = {},
): Promise<{ activities: Activity[]; complete: boolean }> {
  const size = Math.min(Math.max(opts.size ?? 50, 1), 200);
  const data = await c.data<Json>(`/v2/api/web/logs/learn/${classroomId}`, {
    query: { actype: -1, page: opts.page ?? 0, offset: size, sort: -1 },
  });
  const activities = asArray(data.activities).map((raw) => {
    const a = asRecord(raw);
    const out: Activity = {
      id: str(a.id),
      type: num(a.type),
      title: str(a.title),
      coursewareId: str(a.courseware_id),
      createTime: num(a.create_time),
      finished: a.is_finished === true,
    };
    if (a.attend_status !== undefined) out.attended = a.attend_status === true;
    return out;
  });
  return { activities, complete: activities.length < size };
}

/** 课时元信息，含课件清单（`presentationIds` 是数组，支持一课多课件）。 */
export async function getLessonInfo(c: YktClient, lessonId: string): Promise<LessonInfo> {
  const data = await c.data<Json>('/api/v3/classroom-report/student/lesson-info', {
    query: { lesson_id: lessonId },
  });
  return {
    lessonId: str(data.lessonId),
    lessonName: str(data.lessonName),
    courseName: str(data.courseName),
    classroomName: str(data.classroomName),
    teacherName: str(data.teacherName),
    activityId: str(data.activityId),
    skuId: str(data.skuId) || undefined,
    presentationIds: asArray(data.presentationIds).map(str),
  };
}

/** 课堂小结：课件清单 + 课堂状态。 */
export async function getLessonSummary(
  c: YktClient,
  lessonId: string,
): Promise<{ presentations: Presentation[]; checkin: Json | null; lessonTitle: string }> {
  const data = await c.data<Json>('/api/v3/lesson-summary/student', { query: { lesson_id: lessonId } });
  const presentations = asArray(data.presentations).map((raw) => {
    const p = asRecord(raw);
    return {
      id: str(p.id),
      title: str(p.title),
      cover: str(p.cover),
      slidesCount: num(p.slidesCount),
    };
  });
  const checkin = data.checkIn && typeof data.checkIn === 'object' ? (data.checkIn as Json) : null;
  return { presentations, checkin, lessonTitle: str(asRecord(data.lesson).title) };
}

/** 课件全量页。图片地址可直接下载，无需 Cookie。 */
export async function listSlides(
  c: YktClient,
  presentationId: string,
  lessonId: string,
): Promise<Slide[]> {
  const data = await c.data<Json>('/api/v3/lesson-summary/student/presentation', {
    query: { presentation_id: presentationId, lesson_id: lessonId },
  });
  return asArray(data.slides)
    .map((raw, i) => {
      const s = asRecord(raw);
      return {
        id: str(s.id),
        index: num(s.index) || i + 1,
        cover: str(s.cover),
        problem: s.problem && typeof s.problem === 'object' ? (s.problem as Json) : null,
      };
    })
    .sort((a, b) => a.index - b.index);
}

/** 学情分数明细。 */
export async function getScoreDetail(c: YktClient, lessonId: string): Promise<{
  studentScore: number;
  parts: { name: string; percent: number }[];
  checkin: Json | null;
}> {
  const data = await c.data<Json>('/api/v3/classroom-report/student/score-detail', {
    query: { lesson_id: lessonId },
  });
  const parts = asArray(data.score_detail).map((raw) => {
    const p = asRecord(raw);
    return { name: str(p.name), percent: num(p.percent) };
  });
  return {
    studentScore: num(data.student_score),
    parts,
    checkin: data.checkin && typeof data.checkin === 'object' ? (data.checkin as Json) : null,
  };
}

/**
 * 回放时间线。
 *
 * 这是判断「哪些页真正讲过」的唯一可靠途径：`slide` 事件的 `slideIndex`
 * 去重后即实际展示过的页（课件接口的 `visible` 恒为 true，无区分度）。
 */
export async function getReplayTimeline(c: YktClient, lessonId: string): Promise<{
  events: TimelineEvent[];
  durationMs: number;
  shownSlideIndexes: number[];
}> {
  const data = await c.data<Json>('/api/v3/lesson-summary/replay', { query: { lesson_id: lessonId } });
  const events: TimelineEvent[] = [];
  for (const raw of asArray(data.timeLine)) {
    const e = asRecord(raw);
    if (e.type === 'slide') {
      events.push({
        kind: 'slide',
        slideIndex: num(e.si),
        presentationId: str(e.pres),
        at: num(e.dt),
      });
    } else {
      events.push({
        kind: 'event',
        code: str(e.code) || undefined,
        title: str(e.title) || undefined,
        at: num(e.dt),
      });
    }
  }
  events.sort((a, b) => a.at - b.at);
  const shownSlideIndexes = [
    ...new Set(events.filter((e) => e.kind === 'slide' && e.slideIndex).map((e) => e.slideIndex as number)),
  ].sort((a, b) => a - b);
  return { events, durationMs: num(data.lessonDuration), shownSlideIndexes };
}

/** AI 生成的课堂思维导图（树形）。 */
export async function getMindMap(c: YktClient, lessonId: string): Promise<Json | null> {
  const data = await c.data<Json>('/api/v3/lesson-summary/query-lesson-mind-map', {
    query: { lesson_id: lessonId },
  });
  const overall = data.overallMindMap;
  return overall && typeof overall === 'object' ? (overall as Json) : null;
}

/** 课堂笔记目录。 */
export async function listLectureNotes(
  c: YktClient,
  lessonId: string,
): Promise<{ notes: { liveId: string; durationMs: number }[]; taskStatus: number; visible: boolean }> {
  const data = await c.data<Json>('/api/v3/lesson-summary/query-lecture-note', {
    query: { lesson_id: lessonId },
  });
  const notes = asArray(data.list).map((raw) => {
    const n = asRecord(raw);
    return { liveId: str(n.liveId), durationMs: num(n.duration) };
  });
  return { notes, taskStatus: num(data.taskStatus), visible: num(data.studentVisible) === 1 };
}

/**
 * 笔记正文。
 * 参数名是 `liveId`（驼峰），写成 `live_id` 会返回 50401。
 */
export async function getLectureNoteDetail(
  c: YktClient,
  lessonId: string,
  liveId: string,
): Promise<Json[]> {
  const data = await c.data<Json>('/api/v3/lesson-summary/query-lecture-note-detail', {
    query: { lesson_id: lessonId, liveId },
  });
  return asArray(data.notes).map(asRecord);
}

/** 正在进行的课堂 + 待开始考试。 */
export async function getLiveLessons(c: YktClient): Promise<{
  lessons: LiveLesson[];
  upcomingExams: Json[];
}> {
  const data = await c.data<Json>('/api/v3/classroom/on-lesson-upcoming-exam');
  const lessons = asArray(data.onLessonClassrooms).map((raw) => {
    const l = asRecord(raw);
    return {
      classroomId: str(l.classroomId),
      courseId: str(l.courseId),
      courseName: str(l.courseName),
      classroomName: str(l.classroomName),
      lessonId: str(l.lessonId),
    };
  });
  return { lessons, upcomingExams: asArray(data.upcomingExam).map(asRecord) };
}

/**
 * 课程进度树：章节 → 叶子（含完成度、分数、截止）。
 *
 * 这是章节数据的首选来源，绕开 `mooc-api/.../course/chapter` 的 80019。
 */
export async function getCourseProgress(
  c: YktClient,
  classroomId: string,
  courseId: string,
): Promise<{ skuId?: number; leaves: LeafProgress[] }> {
  const data = await c.data<Json>('/c27/online_courseware/schedule/course/progress/', {
    query: { classroom_id: classroomId, course_id: courseId },
  });
  const leaves: LeafProgress[] = [];
  for (const secRaw of asArray(data.course_progress)) {
    for (const leafRaw of asArray(asRecord(secRaw).section_leaf_list)) {
      const lf = asRecord(leafRaw);
      const prog = asRecord(lf.progress);
      const leaf: LeafProgress = {
        name: str(lf.name),
        leafId: str(lf.id),
        leafType: num(lf.leaf_type),
        locked: lf.is_locked === true,
        scoreDeadline: num(lf.score_deadline),
        status: str(prog.status),
      };
      if (prog.user_score !== undefined) leaf.userScore = num(prog.user_score);
      if (prog.total_score !== undefined) leaf.totalScore = num(prog.total_score);
      if (prog.done !== undefined) leaf.done = num(prog.done);
      if (prog.total !== undefined) leaf.total = num(prog.total);
      leaves.push(leaf);
    }
  }
  return { skuId: typeof data.sku_id === 'number' ? data.sku_id : undefined, leaves };
}

/** 讨论区公告。 */
export async function listAnnouncements(
  c: YktClient,
  classroomId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<Json[]> {
  const data = await c.data<Json>('/v/discussion/v2/announcements/', {
    query: { cid: classroomId, limit: opts.limit ?? 20, offset: opts.offset ?? 0, type: 9 },
  });
  return asArray(data.data).map(asRecord);
}

/** 讨论区帖子。 */
export async function listTopics(
  c: YktClient,
  classroomId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ count: number; results: Json[] }> {
  const data = await c.data<Json>('/v/discussion/v2/topics/', {
    query: { cid: classroomId, limit: opts.limit ?? 20, offset: opts.offset ?? 0 },
  });
  return { count: num(data.count), results: asArray(data.results).map(asRecord) };
}

export { readData };
