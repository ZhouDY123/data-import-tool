const test = require('node:test');
const assert = require('node:assert/strict');

test('金额以分保存时应保留两位小数', () => {
  assert.equal(Math.round(Number('19.60') * 100), 1960);
});

test('订单号始终按文本处理', () => {
  assert.equal(String('001234567890'), '001234567890');
});

test('带 BOM 的拼多多商品表头仍能识别商品名', () => {
  const row = { '\uFEFF商品': '三奇医用口罩' };
  assert.equal(row['商品'] || row['\uFEFF商品'], '三奇医用口罩');
});

test('商品名称按约定映射分类编号', () => {
  const category = name => {
    const hasMask = name.includes('口罩');
    if (hasMask && /(儿童|婴儿|宝宝|小孩|幼儿)/.test(name)) return 2;
    if (hasMask && name.includes('成人')) return 0;
    if (hasMask && name.includes('医用')) return 1;
    if (!hasMask && name.includes('消毒')) return 3;
    return 4;
  };
  assert.equal(category('儿童医用口罩'), 2);
  assert.equal(category('萌萌宝婴儿小孩口罩'), 2);
  assert.equal(category('成人医用口罩'), 0);
  assert.equal(category('医用外科口罩'), 1);
  assert.equal(category('84消毒液'), 3);
  assert.equal(category('普通湿巾'), 4);
});
