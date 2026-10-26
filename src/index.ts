#!/usr/bin/env node
/**
 * @powercess/yuketang-mcp — MCP 服务器入口。
 *
 * 传输：stdio。会话保存在 $YKT_STATE_DIR 或 ~/.yuketang-mcp/。
 * 也可用环境变量直接提供会话，跳过扫码：
 *   YKT_REGION=standard  YKT_SESSIONID=<sessionid>
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { YktClient, REGION_NAMES, isRegion, type Region } from './client.ts';
import { loadSession, saveSession, stateDir } from './session.ts';
import { buildServer } from './tools.ts';

async function main() {
  const envRegion = process.env.YKT_REGION;
  const envSession = process.env.YKT_SESSIONID?.trim();

  if (envSession) {
    const region: Region = isRegion(envRegion) ? envRegion : 'standard';
    saveSession(region, envSession);
    process.stderr.write(`已从环境变量导入 ${REGION_NAMES[region]} 会话\n`);
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`yuketang-mcp 已启动（stdio）\n`);
  process.stderr.write(`会话目录: ${stateDir()}\n`);

  const stored = (['standard', 'hetang', 'changjiang', 'huanghe'] as const).filter((r) => loadSession(r));
  if (stored.length === 0) {
    process.stderr.write(`尚未登录，请调用 ykt_login\n`);
  } else {
    process.stderr.write(`已保存区域: ${stored.map((r) => REGION_NAMES[r]).join('、')}\n`);
    for (const region of stored) {
      const s = loadSession(region);
      if (!s) continue;
      try {
        const info = await new YktClient(region, s.sessionid).verify();
        const name = typeof info.name === 'string' ? info.name : '';
        process.stderr.write(`  ${REGION_NAMES[region]}: ${name || '已登录'}\n`);
      } catch {
        process.stderr.write(`  ${REGION_NAMES[region]}: 会话已失效，需重新扫码\n`);
      }
    }
  }
}

main().catch((e) => {
  process.stderr.write(`启动失败: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
