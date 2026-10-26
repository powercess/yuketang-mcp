import test from 'node:test';
import assert from 'node:assert/strict';
import { errorFamily, readStatus, classify, readData, YktError } from '../dist/client.js';

test('三套成功字段各自归一到正确体系', () => {
  // /api/v3/*: code + msg
  assert.equal(errorFamily({ code: 0, msg: 'OK' }), 'code');
  const a = readStatus({ code: 0, msg: 'OK', data: {} });
  assert.equal(a.ok, true);
  assert.equal(a.family, 'code');

  const aErr = readStatus({ code: 50080, msg: 'LESSON_DELETED' });
  assert.equal(aErr.ok, false);
  assert.equal(aErr.code, 50080);
  assert.equal(aErr.message, 'LESSON_DELETED');

  // /v2/api/web/*: errcode + errmsg
  assert.equal(errorFamily({ errcode: 0, errmsg: 'Success' }), 'errcode');
  const b = readStatus({ errcode: 0, errmsg: 'Success', data: { list: [] } });
  assert.equal(b.ok, true);
  assert.equal(b.family, 'errcode');

  const bErr = readStatus({ errcode: 401002, errmsg: 'Cookie has no sessionid' });
  assert.equal(bErr.ok, false);
  assert.equal(bErr.code, 401002);

  // /c27/*, /mooc-api/*: success + error_code + sub_code
  assert.equal(errorFamily({ success: true, data: {} }), 'success');
  const c = readStatus({ success: true, data: {} });
  assert.equal(c.ok, true);
  assert.equal(c.family, 'success');

  const cErr = readStatus({
    msg: 'XTBZ IS REQUIRED',
    error_code: 40000,
    sub_code: 400,
    data: {},
    success: false,
  });
  assert.equal(cErr.ok, false);
  assert.equal(cErr.code, 40000);
});

test('success:false 即使带 error_code=0 也判失败', () => {
  const r = readStatus({ success: false, error_code: 0, msg: 'no' });
  assert.equal(r.ok, false);
});

test('errcode 为字符串 "0" 视为成功', () => {
  assert.equal(readStatus({ errcode: '0', errmsg: 'ok' }).ok, true);
});

test('/v2/api/web 对不存在的资源返回 errcode 0 + 空 data，仅凭状态无法判断', () => {
  const r = readStatus({ errcode: 0, errmsg: 'Success', data: {} });
  assert.equal(r.ok, true, '状态为成功');
  assert.equal(Object.keys(r).includes('data'), false, 'readStatus 不替调用方判断 data 是否为空');
});

test('非对象响应当作失败', () => {
  assert.equal(readStatus(null).ok, false);
  assert.equal(readStatus('text').ok, false);
  assert.equal(readStatus([]).ok, false);
});

test('错误码归类给出可操作建议', () => {
  assert.equal(classify(50000, '').nextAction, 'login');
  assert.equal(classify(401002, '').nextAction, 'login');
  assert.equal(classify(10005, '').nextAction, 'login');
  assert.match(String(classify(40000, '').nextAction), /xtbz/);
  assert.match(String(classify(80005, '').nextAction), /ykt/);
  assert.match(String(classify(80019, '').nextAction), /course_progress/);
  assert.match(String(classify(50401, '').nextAction), /snake_case|camelCase/i);
  // 业务码与 HTTP 状态不同源，五位业务码不应被当作 5xx
  assert.equal(classify(50080, '').retryable, false);
  assert.equal(classify(50000, '').retryable, false);
});

test('readData 取出 data，缺失时抛 YktError', () => {
  assert.deepEqual(readData({ code: 0, data: { a: 1 } }), { a: 1 });
  assert.throws(() => readData({ code: 0 }), YktError);
  assert.throws(() => readData(null), YktError);
});

test('YktError 保留平台码与体系', () => {
  const e = new YktError('x', { code: 40000, family: 'success', retryable: true });
  assert.equal(e.code, 40000);
  assert.equal(e.family, 'success');
  assert.equal(e.retryable, true);
  assert.equal(e.name, 'YktError');
});
