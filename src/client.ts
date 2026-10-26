/**
 * 雨课堂 HTTP 客户端。
 *
 * 协议要点（均经请求级验证）：
 * - 鉴权只需 `Cookie: sessionid`，无需 Referer / classroom-id / platform-id。
 * - `xtbz: ykt` 仅对 `/c27/*` 与 `/mooc-api/*` 必需；全局发送无害。
 * - 响应成功字段有三套：`code`、`errcode`、`success`，必须按前缀分流判断。
 * - 四区 session 互不通用，host 由 region 决定。
 */

export const REGIONS = {
  standard: 'www.yuketang.cn',
  hetang: 'pro.yuketang.cn',
  changjiang: 'changjiang.yuketang.cn',
  huanghe: 'huanghe.yuketang.cn',
} as const;

export type Region = keyof typeof REGIONS;

export const REGION_NAMES: Record<Region, string> = {
  standard: '雨课堂',
  hetang: '荷塘雨课堂',
  changjiang: '长江雨课堂',
  huanghe: '黄河雨课堂',
};

export function isRegion(v: unknown): v is Region {
  return typeof v === 'string' && Object.hasOwn(REGIONS, v);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 业务错误。code 是平台原始码，family 标明来自哪一套字段体系。 */
export class YktError extends Error {
  constructor(
    message: string,
    readonly options: {
      code?: number | string;
      family?: ErrorFamily;
      status?: number;
      retryable?: boolean;
      nextAction?: string;
    } = {},
  ) {
    super(message);
    this.name = 'YktError';
  }

  get code() {
    return this.options.code;
  }
  get family() {
    return this.options.family;
  }
  get status() {
    return this.options.status;
  }
  get retryable() {
    return this.options.retryable ?? false;
  }
  get nextAction() {
    return this.options.nextAction;
  }
}

export type ErrorFamily = 'code' | 'errcode' | 'success';

export type Json = Record<string, unknown>;

/** 取出 payload.data；缺失即抛错。供多处复用，避免反复内联断言。 */
export function readData<T = Json>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const { data } = payload as { data: T };
    if (data !== undefined) return data;
  }
  throw new YktError('响应缺少 data 字段', { nextAction: 'report schema change' });
}

/** 按前缀判定响应属于哪套成功字段。
 * 乱序试探是安全的：三套字段互斥，不太可能同时出现。
 */
export function errorFamily(payload: unknown): ErrorFamily {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'code';
  const p = payload as Json;
  if (typeof p.success === 'boolean') return 'success';
  if (typeof p.errcode === 'number' || typeof p.errcode === 'string') return 'errcode';
  return 'code';
}

/** 提取业务码与是否成功。三套体系（code / errcode / success+error_code）统一归一。 */
export function readStatus(payload: unknown): {
  ok: boolean;
  code?: number | string;
  family: ErrorFamily;
  message: string;
} {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, family: 'code', message: '响应不是 JSON 对象' };
  }
  const p = payload as Json;
  const family = errorFamily(p);

  if (family === 'success') {
    return {
      ok: p.success === true,
      code: (p.error_code ?? p.sub_code) as number | string | undefined,
      family,
      message: typeof p.msg === 'string' ? p.msg : '',
    };
  }
  if (family === 'errcode') {
    const raw = p.errcode;
    const ok = raw === 0 || raw === '0';
    return {
      ok,
      code: raw as number | string,
      family,
      message: typeof p.errmsg === 'string' ? p.errmsg : '',
    };
  }
  const raw = p.code;
  const ok = raw === 0 || raw === '0';
  return {
    ok,
    code: raw as number | string | undefined,
    family,
    message: typeof p.msg === 'string' ? p.msg : '',
  };
}

/**
 * 把平台错误归类为 Agent 可操作的下一步。
 *
 * 注意：业务码是五位（50000/50080/80019…），与 HTTP 4xx/5xx 不同源，
 * 不能按数值区间判定可重试性。
 */
export function classify(code: number | string | undefined, message: string): YktError['options'] {
  const n = typeof code === 'string' ? Number(code) : code;
  if (n === 50000 || n === 401002 || n === 10005) {
    return { retryable: false, nextAction: 'login', code: n, message } as never;
  }
  if (n === 40000) {
    return {
      retryable: false,
      nextAction: 'send xtbz: ykt header (required by /c27 and /mooc-api)',
      code: n,
    };
  }
  if (n === 80005) {
    return { retryable: false, nextAction: 'use xtbz: ykt instead of cloud on /mooc-api', code: n };
  }
  if (n === 80019) {
    return { retryable: false, nextAction: 'use course_progress instead of chapter', code: n };
  }
  if (n === 20009 || n === 20007) {
    return { retryable: false, nextAction: 'resource not readable with current role', code: n };
  }
  if (n === 50401) {
    return { retryable: false, nextAction: 'check query parameter naming (snake_case vs camelCase)', code: n };
  }
  return { retryable: false, code: n };
}

export interface CallOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CallResult<T = Json> {
  status: number;
  payload: T;
}

export class YktClient {
  readonly region: Region;
  readonly host: string;
  #session: string;

  constructor(region: Region, session: string) {
    if (!isRegion(region)) throw new YktError(`unknown region: ${String(region)}`);
    if (!/^[A-Za-z0-9._-]{8,512}$/.test(session)) {
      throw new YktError('sessionid 格式不合法，请重新登录');
    }
    this.region = region;
    this.host = REGIONS[region];
    this.#session = session;
  }

  get base() {
    return `https://${this.host}`;
  }

  /** 会话未失效时返回 basic-info 的 data。 */
  async verify(): Promise<Json> {
    const { payload } = await this.call('/api/v3/user/basic-info');
    const st = readStatus(payload);
    if (!st.ok) {
      throw new YktError(st.message || '会话无效', {
        code: st.code,
        family: st.family,
        nextAction: 'login',
      });
    }
    return readData(payload);
  }

  async call<T = Json>(path: string, opts: CallOptions = {}): Promise<CallResult<T>> {
    const { method = 'GET', query, body, signal, timeoutMs = 30_000 } = opts;
    const url = new URL(this.base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      Cookie: `sessionid=${this.#session}`,
      'User-Agent': UA,
      // 仅 /c27 与 /mooc-api 需要；统一带上避免遗漏，实测无副作用。
      xtbz: 'ykt',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
        redirect: 'follow',
      });
    } catch (e) {
      throw new YktError(
        e instanceof Error && e.name === 'AbortError' ? '请求超时' : `网络错误: ${String(e)}`,
        { retryable: true, nextAction: 'retry' },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new YktError(`HTTP ${res.status}`, {
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
        nextAction: res.status === 401 ? 'login' : 'check status',
      });
    }
    if (!text) {
      throw new YktError('空响应', { status: res.status, retryable: true });
    }

    let payload: T;
    try {
      payload = JSON.parse(text) as T;
    } catch {
      throw new YktError('响应不是 JSON', { status: res.status });
    }

    const st = readStatus(payload);
    if (!st.ok) {
      const cls = classify(st.code, st.message);
      throw new YktError(st.message || `业务错误 ${String(st.code)}`, {
        ...cls,
        code: st.code,
        family: st.family,
        status: res.status,
      });
    }

    return { status: res.status, payload };
  }

  /** 解包 data 字段；缺失时抛错。 */
  async data<T = Json>(path: string, opts: CallOptions = {}): Promise<T> {
    const { payload } = await this.call<{ data?: T }>(path, opts);
    if (payload.data === undefined) {
      throw new YktError('响应缺少 data 字段', { nextAction: 'report schema change' });
    }
    return payload.data;
  }
}
