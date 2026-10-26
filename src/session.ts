/**
 * 会话持久化。
 *
 * 布局与权限：
 *   目录 0700，文件 0600，写入走 `<file>.tmp` + rename，避免半写文件被读到。
 *   位置：$YKT_STATE_DIR 或 ~/.yuketang-mcp/
 *   文件：session.<region>.json
 *
 * 只存 sessionid 与区域，不存账号姓名/学号等身份信息。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRegion, type Region } from './client.ts';

export interface StoredSession {
  region: Region;
  sessionid: string;
  /** ISO 时间戳，仅用于提示「可能过期」，不作为失效依据。 */
  savedAt: string;
}

export function stateDir(): string {
  const fromEnv = process.env.YKT_STATE_DIR;
  const dir = fromEnv && fromEnv.trim() ? path.resolve(fromEnv) : path.join(os.homedir(), '.yuketang-mcp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function sessionPath(region: Region): string {
  return path.join(stateDir(), `session.${region}.json`);
}

/** 读取已保存的会话；不存在或结构损坏返回 null。 */
export function loadSession(region: Region): StoredSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionPath(region), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.region !== region || typeof rec.sessionid !== 'string') return null;
  if (!/^[A-Za-z0-9._-]{8,512}$/.test(rec.sessionid)) return null;
  return {
    region,
    sessionid: rec.sessionid,
    savedAt: typeof rec.savedAt === 'string' ? rec.savedAt : new Date(0).toISOString(),
  };
}

export function saveSession(region: Region, sessionid: string): StoredSession {
  const record: StoredSession = { region, sessionid, savedAt: new Date().toISOString() };
  const target = sessionPath(region);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return record;
}

export function clearSession(region: Region): boolean {
  try {
    fs.unlinkSync(sessionPath(region));
    return true;
  } catch {
    return false;
  }
}

/** 列出所有已保存会话的区域（不含 sessionid 本身）。 */
export function listStoredRegions(): Region[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir());
  } catch {
    return [];
  }
  const out: Region[] = [];
  for (const name of entries) {
    const m = /^session\.([a-z]+)\.json$/.exec(name);
    if (!m) continue;
    const region = m[1];
    if (isRegion(region) && loadSession(region)) out.push(region);
  }
  return out;
}
