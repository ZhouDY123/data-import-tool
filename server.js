const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const ATTACHMENT_DIR = path.join(DATA_DIR, 'attachments');
const TASK_DIR = path.join(DATA_DIR, 'tasks');
const AUTOMATION_FILE = path.join(DATA_DIR, 'automation.json');
const SYNC_STATE_FILE = path.join(DATA_DIR, 'sync-state.json');
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const STORES = {
  jd: { id: 1, label: '京东 · 三奇旗舰店', endpoint: 'https://shopview.sanqifz.com:33033/api_ingest_jd.php' },
  tmall: { id: 2, label: '天猫 · 三奇旗舰店', endpoint: 'https://shopview.sanqifz.com:33033/api_ingest_tmall.php' },
  pdd: { id: 3, label: '拼多多 · 三奇旗舰店', endpoint: 'https://shopview.sanqifz.com:33033/api_ingest_pdd.php' }
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new Error('请求内容不是有效 JSON。'); }
}

function cookieHeader(response) {
  const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
  return raw.map(item => item.split(';')[0]).join('; ');
}

function htmlText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function normalizeText(value) { return String(value ?? '').replace(/^\uFEFF/, '').trim(); }
function moneyToFen(value) {
  const text = normalizeText(value).replace(/[￥¥,\t\s]/g, '');
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}
function regionFromAddress(value) {
  const match = normalizeText(value).match(/(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/);
  return match ? match[1] : '—';
}
function categoryFromName(value) {
  const name = normalizeText(value);
  const hasMask = name.includes('口罩');
  if (hasMask && /(儿童|婴儿|宝宝|小孩|幼儿)/.test(name)) return 2;
  if (hasMask && name.includes('成人')) return 0;
  if (hasMask && name.includes('医用')) return 1;
  if (!hasMask && name.includes('消毒')) return 3;
  return 4;
}
function standard(orderNo, paidAt, sku, name, amountFen, quantity, region, row) {
  const errors = [];
  if (!orderNo) errors.push('缺少订单号');
  if (!paidAt) errors.push('缺少成交时间');
  if (!sku) errors.push('缺少稳定商品标识');
  if (amountFen === null) errors.push('金额不是有效数字');
  const count = Number(quantity);
  if (!Number.isInteger(count) || count <= 0) errors.push('数量必须是正整数');
  return {
    order: {
      orderNo, paidAt, sku, name, amountFen, quantity: count || 1, region: region || '—', categoryNo: categoryFromName(name),
      dataType: /^(VJD|VTM|VPD)/.test(orderNo) ? 'virtual' : 'real'
    },
    errors: errors.map(message => ({ row, message }))
  };
}

function parseJd(rows) {
  return rows.map((row, index) => {
    const orderNo = normalizeText(row['订单号']);
    const sku = normalizeText(row['商品ID']) || normalizeText(row['商家SKUID']);
    return standard(orderNo, normalizeText(row['付款确认时间']) || normalizeText(row['下单时间']), sku,
      normalizeText(row['商品名称']), moneyToFen(row['商家应收']) ?? moneyToFen(row['应付金额']), row['订购数量'],
      regionFromAddress(row['客户地址']), index + 2);
  });
}

function parsePdd(rows) {
  return rows.map((row, index) => {
    const specification = normalizeText(row['样式ID']) || `${normalizeText(row['商品id'])}:${normalizeText(row['商品规格'])}`;
    const address = row['收货地址'] || row['收货省份'] || row['地区'] || row['省份'] || row['省'] || '';
    return standard(normalizeText(row['订单号']), normalizeText(row['订单成交时间']), specification,
      // 拼多多 CSV 常在首列表头携带 UTF-8 BOM；兼容两种表头写法。
      normalizeText(row['商品'] || row['\uFEFF商品']), moneyToFen(row['商家实收金额(元)']) ?? moneyToFen(row['用户实付金额(元)']),
      row['商品数量(件)'], regionFromAddress(address), index + 2);
  });
}

function parseTmall(rows) {
  // 2026-09 起天猫附件改为按商品行导出，字段不再包含主/子订单编号。
  if (rows.some(row => Object.prototype.hasOwnProperty.call(row, '订单编号'))) {
    return rows.filter(row => !/(交易失败|交易关闭)/.test(normalizeText(row['订单状态']))).map((row, index) => {
      const name = normalizeText(row['商品标题']);
      // 新模板部分行没有商家编码；使用商品规格或商品标题保持同一商品的覆盖标识稳定。
      const sku = normalizeText(row['商家编码']) || normalizeText(row['商品属性SKU']) || name;
      const amountFen = moneyToFen(row['总金额']) ?? moneyToFen(row['买家实付金额']) ?? moneyToFen(row['实付金额']) ?? moneyToFen(row['订单金额']) ?? moneyToFen(row['商品金额']);
      return standard(normalizeText(row['订单编号']), normalizeText(row['订单付款时间']) || normalizeText(row['订单创建时间']), sku,
        name, amountFen, row['宝贝总数量'], regionFromAddress(row['收货地址']), index + 2);
    });
  }
  const groups = new Map();
  rows.forEach((row, index) => {
    const key = normalizeText(row['主订单编号']) || normalizeText(row['子订单编号']);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, sourceRow: index + 2 });
  });
  const result = [];
  for (const [orderNo, items] of groups) {
    const totalFen = moneyToFen(items[0].row['买家实付金额']) ?? moneyToFen(items[0].row['买家应付货款']);
    const weights = items.map(({ row }) => (Number(row['商品价格']) || 0) * (Number(row['购买数量']) || 0));
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    let allocated = 0;
    items.forEach(({ row, sourceRow }, index) => {
      const amountFen = totalFen === null ? null : index === items.length - 1 ? totalFen - allocated : Math.round(totalFen * (weightTotal ? weights[index] / weightTotal : 1 / items.length));
      allocated += amountFen || 0;
      // 子订单号确保同一主订单中同商品的多条记录仍可覆盖更新。
      const sku = `${normalizeText(row['商品ID']) || 'item'}:${normalizeText(row['子订单编号']) || sourceRow}`;
      result.push(standard(orderNo, normalizeText(row['订单付款时间']), sku, normalizeText(row['商品标题']), amountFen, row['购买数量'], '—', sourceRow));
    });
  }
  return result;
}

function deduplicate(parsed) {
  const valid = [];
  const errors = [];
  const seen = new Set();
  for (const item of parsed) {
    if (item.errors.length) { errors.push(...item.errors); continue; }
    const key = `${item.order.orderNo}\u0000${item.order.sku}`;
    if (seen.has(key)) { errors.push({ row: '—', message: `重复订单项：${item.order.orderNo} / ${item.order.sku}` }); continue; }
    seen.add(key);
    valid.push(item.order);
  }
  return { orders: valid, errors };
}

function parseAttachment(storeKey, bytes) {
  const isCsv = storeKey === 'pdd';
  // xlsx 将 Buffer 形式的 CSV 按本地代码页处理；拼多多导出为 UTF-8 BOM，必须先转为文本。
  const workbook = isCsv
    ? XLSX.read(bytes.toString('utf8'), { type: 'string', raw: true })
    : XLSX.read(bytes, { type: 'buffer', raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const importableRows = rows.filter(row => normalizeText(row['订单状态']) !== '交易关闭');
  const parsed = storeKey === 'jd' ? parseJd(importableRows) : storeKey === 'tmall' ? parseTmall(importableRows) : parsePdd(importableRows);
  return { ...deduplicate(parsed), sourceRows: rows.length, format: isCsv ? 'CSV' : 'Excel' };
}

async function resolveLatestAttachment(credentials, store) {
  const loginUrl = 'https://shopview.sanqifz.com:33033/login.php';
  const loginPage = await fetch(loginUrl);
  const csrf = (await loginPage.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('无法读取后台登录令牌。');
  const firstCookies = cookieHeader(loginPage);
  const form = new URLSearchParams({ csrf, username: credentials.username, password: credentials.password });
  const login = await fetch(loginUrl, { method: 'POST', headers: { cookie: firstCookies, 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
  const cookies = [firstCookies, cookieHeader(login)].filter(Boolean).join('; ');
  if (![302, 303].includes(login.status)) throw new Error('登录失败，请检查账号或密码。');
  // 附件替换后后台会分配新编号，因此每次从当前店铺列表取得最新下载链接。
  const list = await fetch(`https://shopview.sanqifz.com:33033/admin_attachments.php?shop_id=${store.id}`, { headers: { cookie: cookies } });
  if (!list.ok) throw new Error(`无法读取附件列表（HTTP ${list.status}）。`);
  const listHtml = await list.text();
  const link = [...listHtml.matchAll(/admin_attachment_download\.php\?id=(\d+)/g)][0];
  const attachmentId = link?.[1];
  if (!attachmentId) throw new Error('该店铺没有可下载的附件。');
  const rowStart = listHtml.lastIndexOf('<tr', link.index);
  const rowEnd = listHtml.indexOf('</tr>', link.index);
  const cells = [...listHtml.slice(rowStart, rowEnd).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
  const filename = htmlText(cells[0]?.[1]) || `attachment-${attachmentId}`;
  return { cookies, attachmentId, filename };
}

async function loginAndDownload(credentials, store) {
  const { cookies, attachmentId, filename } = await resolveLatestAttachment(credentials, store);
  const download = await fetch(`https://shopview.sanqifz.com:33033/admin_attachment_download.php?id=${attachmentId}`, { headers: { cookie: cookies } });
  if (!download.ok) throw new Error(`附件下载失败（HTTP ${download.status}）。`);
  return { bytes: Buffer.from(await download.arrayBuffer()), filename };
}

async function preview(credentials, storeKeys) {
  if (!credentials?.username || !credentials?.password) throw new Error('请输入后台账号和密码。');
  const taskId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const stores = [];
  for (const storeKey of storeKeys) {
    const store = STORES[storeKey];
    if (!store) continue;
    const { bytes, filename } = await loginAndDownload(credentials, store);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const extension = storeKey === 'pdd' ? 'csv' : 'xlsx';
    const attachmentPath = path.join(ATTACHMENT_DIR, storeKey, `${hash}.${extension}`);
    await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
    await fs.writeFile(attachmentPath, bytes);
    const result = parseAttachment(storeKey, bytes);
    stores.push({ key: storeKey, label: store.label, endpoint: store.endpoint, attachment: { hash, filename, bytes: bytes.length }, ...result, preview: result.orders.slice(0, 8) });
  }
  const task = { id: taskId, createdAt: new Date().toISOString(), stores, status: 'previewed' };
  await fs.mkdir(TASK_DIR, { recursive: true });
  await fs.writeFile(path.join(TASK_DIR, `${taskId}.json`), JSON.stringify(task, null, 2));
  return publicTask(task);
}

function publicTask(task) {
  return {
    id: task.id,
    createdAt: task.createdAt,
    status: task.status,
    stores: task.stores.map(({ orders, errors, ...store }) => ({
      ...store,
      ordersCount: orders.length,
      errors: errors.slice(0, 100),
      errorCount: errors.length
    }))
  };
}

async function importTask(taskId, storeKey) {
  const task = JSON.parse(await fs.readFile(path.join(TASK_DIR, `${taskId}.json`), 'utf8'));
  const store = task.stores.find(item => item.key === storeKey);
  if (!store) throw new Error('未找到待导入店铺。');
  // 历史任务也按现行商品命名规则分类，重导时可修正此前的分类结果。
  for (const order of store.orders) order.categoryNo = categoryFromName(order.name);
  const chunks = [];
  for (let offset = 0; offset < store.orders.length; offset += 200) {
    const orders = store.orders.slice(offset, offset + 200);
    const response = await fetch(store.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orders }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(`第 ${chunks.length + 1} 批导入失败：${body.error || `HTTP ${response.status}`}`);
    chunks.push(body);
  }
  store.import = { completedAt: new Date().toISOString(), batches: chunks.length, received: chunks.reduce((sum, item) => sum + Number(item.received || 0), 0), skipped: chunks.reduce((sum, item) => sum + Number(item.skipped || 0), 0) };
  task.status = task.stores.every(item => item.import || item.orders.length === 0) ? 'imported' : 'partially_imported';
  await fs.writeFile(path.join(TASK_DIR, `${taskId}.json`), JSON.stringify(task, null, 2));
  return store.import;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function cleanupAttachments() {
  const cutoff = Date.now() - ATTACHMENT_RETENTION_MS;
  for (const storeKey of Object.keys(STORES)) {
    const directory = path.join(ATTACHMENT_DIR, storeKey);
    try {
      const files = await fs.readdir(directory);
      for (const file of files) {
        const target = path.join(directory, file);
        if ((await fs.stat(target)).mtimeMs < cutoff) await fs.unlink(target);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

let syncRunning = false;
async function automaticSync() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    const settings = await readJson(AUTOMATION_FILE, null);
    const credentials = settings?.credentials;
    if (!credentials?.username || !credentials?.password) return console.log('自动同步未配置账号，已跳过。');
    const state = await readJson(SYNC_STATE_FILE, { stores: {} });
    for (const [storeKey, store] of Object.entries(STORES)) {
      const latest = await resolveLatestAttachment(credentials, store);
      if (state.stores?.[storeKey]?.filename === latest.filename) {
        console.log(`${store.label}：附件名称未变化，跳过。`);
        continue;
      }
      const download = await fetch(`https://shopview.sanqifz.com:33033/admin_attachment_download.php?id=${latest.attachmentId}`, { headers: { cookie: latest.cookies } });
      if (!download.ok) throw new Error(`${store.label}附件下载失败（HTTP ${download.status}）。`);
      const bytes = Buffer.from(await download.arrayBuffer());
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      const extension = storeKey === 'pdd' ? 'csv' : 'xlsx';
      const attachmentPath = path.join(ATTACHMENT_DIR, storeKey, `${hash}.${extension}`);
      await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
      await fs.writeFile(attachmentPath, bytes);
      const result = parseAttachment(storeKey, bytes);
      const taskId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const task = { id: taskId, createdAt: new Date().toISOString(), status: 'previewed', stores: [{ key: storeKey, label: store.label, endpoint: store.endpoint, attachment: { hash, filename: latest.filename, bytes: bytes.length }, ...result, preview: result.orders.slice(0, 8) }] };
      await fs.mkdir(TASK_DIR, { recursive: true });
      await fs.writeFile(path.join(TASK_DIR, `${taskId}.json`), JSON.stringify(task, null, 2));
      const imported = await importTask(taskId, storeKey);
      state.stores ||= {};
      state.stores[storeKey] = { filename: latest.filename, syncedAt: new Date().toISOString(), received: imported.received, skipped: imported.skipped };
      await fs.writeFile(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`${store.label}：已自动导入 ${imported.received} 条。`);
    }
    await cleanupAttachments();
  } catch (error) {
    console.error(`自动同步失败：${error.message}`);
  } finally {
    syncRunning = false;
  }
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'POST' && url.pathname === '/api/preview') {
      const body = await readBody(req); return json(res, 200, await preview(body.credentials, body.stores || Object.keys(STORES)));
    }
    if (req.method === 'POST' && url.pathname === '/api/import') {
      const body = await readBody(req); return json(res, 200, await importTask(body.taskId, body.storeKey));
    }
    if (req.method === 'GET' && url.pathname === '/api/stores') return json(res, 200, STORES);
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const file = url.pathname === '/' ? path.join(ROOT, 'public', 'index.html') : path.join(ROOT, 'public', path.basename(url.pathname));
    const safeRoot = path.join(ROOT, 'public');
    if (!file.startsWith(safeRoot)) return json(res, 403, { error: 'Forbidden' });
    const content = await fs.readFile(file);
    const extension = path.extname(file);
    res.writeHead(200, { 'content-type': mime[extension] || 'application/octet-stream' });
    res.end(content);
  } catch (error) {
    if (!res.headersSent) json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message || '处理失败。' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`订单导入台已启动：http://127.0.0.1:${PORT}`);
  void automaticSync();
  setInterval(() => void automaticSync(), SYNC_INTERVAL_MS);
});
