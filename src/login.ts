/**
 * 扫码登录。
 *
 * 流程（经验证）：
 *   GET  /api/v3/user/login/app-web-pre-info   → { qrContent, token }
 *   POST /api/v3/user/login/app-web-login      → 长轮询，成功时 { UserID, Auth, Name } + Set-Cookie: sessionid
 *
 * 关键点：
 * - 这是「长轮询」而非轮询。单请求挂起，超时后重发；每 2 秒发一次会造成请求堆积。
 * - `qrImage` 恒为空字符串，必须自行渲染 `qrContent`。
 * - 四区独立，扫错区无效。
 */

import { REGIONS, YktError, isRegion, type Region } from './client.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ISSUE_PATH = '/api/v3/user/login/app-web-pre-info';
const POLL_PATH = '/api/v3/user/login/app-web-login';

/** 单次长轮询的挂起上限。平台侧通常更快返回，超时即重发。 */
const POLL_TIMEOUT_MS = 35_000;
/** 整个扫码窗口。二维码有效期约 5 分钟，留出扫码与确认时间。 */
const LOGIN_WINDOW_MS = 280_000;

export interface QrTicket {
  region: Region;
  /** 二维码内容，交给调用方渲染。 */
  qrContent: string;
  /** 轮询令牌，不对外暴露。 */
  token: string;
  issuedAt: number;
}

export interface LoginResult {
  region: Region;
  sessionid: string;
  /** 平台返回的展示名，用于让用户确认登录的是哪个账号。 */
  name: string;
  userId: string;
}

/** 申请二维码。不需要任何鉴权。 */
export async function requestQr(region: Region, signal?: AbortSignal): Promise<QrTicket> {
  if (!isRegion(region)) throw new YktError(`未知区域: ${String(region)}`);
  const base = `https://${REGIONS[region]}`;

  const res = await fetch(base + ISSUE_PATH, {
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': UA,
      Referer: `${base}/web`,
    },
    signal,
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new YktError(`获取二维码失败: HTTP ${res.status}`, { status: res.status, retryable: true });
  }
  const body: unknown = await res.json();
  if (!body || typeof body !== 'object') {
    throw new YktError('二维码响应不是对象');
  }
  const rec = body as Record<string, unknown>;
  if (rec.code !== 0) {
    throw new YktError(typeof rec.msg === 'string' ? rec.msg : '获取二维码被拒绝', {
      code: rec.code as number | string,
    });
  }
  if (!rec.data || typeof rec.data !== 'object') {
    throw new YktError('二维码响应缺少 data');
  }
  const data = rec.data as Record<string, unknown>;
  if (typeof data.qrContent !== 'string' || typeof data.token !== 'string') {
    throw new YktError('二维码字段结构变化（qrContent/token 缺失）', { nextAction: 'report schema change' });
  }
  return { region, qrContent: data.qrContent, token: data.token, issuedAt: Date.now() };
}

/**
 * 等待扫码确认。成功返回会话，超时返回 null。
 *
 * 内部按长轮询推进：一次 fetch 可能挂起数十秒，返回后立即续上，
 * 直到整体窗口耗尽或被 signal 取消。
 */
export async function waitForLogin(
  ticket: QrTicket,
  opts: { signal?: AbortSignal } = {},
): Promise<LoginResult | null> {
  const base = `https://${REGIONS[ticket.region]}`;
  const deadline = ticket.issuedAt + LOGIN_WINDOW_MS;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new YktError('登录已取消');

    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), POLL_TIMEOUT_MS);

    let res: Response | null = null;
    try {
      res = await fetch(base + POLL_PATH, {
        method: 'POST',
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'Content-Type': 'application/json',
          'User-Agent': UA,
          Referer: `${base}/web`,
        },
        body: JSON.stringify({ token: ticket.token }),
        signal: ac.signal,
        redirect: 'follow',
      });
    } catch {
      // 长轮询超时或网络抖动：继续下一轮，不视为失败。
      res = null;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (res) {
      const sessionid = extractSession(res);
      const text = await res.text();
      if (text) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === 'object') {
          const rec = parsed as Record<string, unknown>;
          if (rec.code === 0 && rec.data && typeof rec.data === 'object') {
            const data = rec.data as Record<string, unknown>;
            if (!sessionid) {
              throw new YktError('登录成功但未收到 sessionid', { nextAction: 'retry login' });
            }
            return {
              region: ticket.region,
              sessionid,
              name: typeof data.Name === 'string' ? data.Name : '',
              userId: data.UserID === undefined ? '' : String(data.UserID),
            };
          }
        }
      }
    }
  }
  return null;
}

/** 从 Set-Cookie 中取 sessionid。Node 20+ 提供 getSetCookie。 */
function extractSession(res: Response): string | null {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const cookie of raw) {
    const first = cookie.split(';', 1)[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    if (first.slice(0, eq).trim() !== 'sessionid') continue;
    const value = first.slice(eq + 1).trim();
    if (/^[A-Za-z0-9._-]{8,512}$/.test(value)) return value;
  }
  return null;
}
