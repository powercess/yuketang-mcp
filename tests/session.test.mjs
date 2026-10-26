import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ykt-session-'));
process.env.YKT_STATE_DIR = tmp;

const mod = await import('../dist/session.js');

test('保存后可读回，且文件权限为 0600', () => {
  const saved = mod.saveSession('standard', 'abcdefgh12345678');
  assert.equal(saved.region, 'standard');
  assert.equal(saved.sessionid, 'abcdefgh12345678');

  const back = mod.loadSession('standard');
  assert.equal(back?.sessionid, 'abcdefgh12345678');

  const file = path.join(tmp, 'session.standard.json');
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('目录权限为 0700', () => {
  const mode = fs.statSync(tmp).mode & 0o777;
  assert.equal(mode, 0o700);
});

test('区域之间互不干扰', () => {
  mod.saveSession('changjiang', 'cccccccc11111111');
  assert.equal(mod.loadSession('standard')?.sessionid, 'abcdefgh12345678');
  assert.equal(mod.loadSession('changjiang')?.sessionid, 'cccccccc11111111');
  assert.equal(mod.loadSession('hetang'), null);
});

test('拒绝读取 sessionid 不合法的文件', () => {
  fs.writeFileSync(
    path.join(tmp, 'session.huanghe.json'),
    JSON.stringify({ region: 'huanghe', sessionid: 'a', savedAt: new Date().toISOString() }),
  );
  assert.equal(mod.loadSession('huanghe'), null);
});

test('拒绝区域不匹配的文件', () => {
  fs.writeFileSync(
    path.join(tmp, 'session.hetang.json'),
    JSON.stringify({ region: 'standard', sessionid: 'abcdefgh12345678', savedAt: new Date().toISOString() }),
  );
  assert.equal(mod.loadSession('hetang'), null);
});

test('损坏的 JSON 返回 null 而不抛错', () => {
  fs.writeFileSync(path.join(tmp, 'session.hetang.json'), '{not json');
  assert.equal(mod.loadSession('hetang'), null);
});

test('listStoredRegions 只列有效会话，不泄露 sessionid', () => {
  const regions = mod.listStoredRegions();
  assert.deepEqual(regions.sort(), ['changjiang', 'standard']);
});

test('clearSession 删除文件', () => {
  assert.equal(mod.clearSession('standard'), true);
  assert.equal(mod.loadSession('standard'), null);
  assert.equal(mod.clearSession('standard'), false);
});

test('保存时不写入姓名等身份字段', () => {
  mod.saveSession('hetang', 'hhhhhhhh22222222');
  const raw = fs.readFileSync(path.join(tmp, 'session.hetang.json'), 'utf8');
  const rec = JSON.parse(raw);
  assert.deepEqual(Object.keys(rec).sort(), ['region', 'savedAt', 'sessionid']);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
