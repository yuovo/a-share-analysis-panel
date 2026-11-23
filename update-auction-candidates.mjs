import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const JSON_FILE = path.join(ROOT, 'auction-candidates.json');
const JS_FILE = path.join(ROOT, 'auction-candidates.js');
const ZT_UT = '7eea3edcaed734bea9cbfc24409ed989';
const SOURCE_VERSION = 'auction-candidates-v1-20261120';
const GENERATED_AT = new Date().toISOString();

function beijingParts() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((item) => [item.type, item.value]));
}

function beijingToday() {
  const p = beijingParts();
  return `${p.year}${p.month}${p.day}`;
}

function beijingSeconds() {
  const p = beijingParts();
  return Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
}

function beijingClock() {
  const p = beijingParts();
  return `${p.hour}:${p.minute}:${p.second}`;
}

function isWeekday(day = beijingToday()) {
  const parsed = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T12:00:00+08:00`);
  return parsed.getDay() >= 1 && parsed.getDay() <= 5;
}

async function fetchJson(url, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; apanel-auction-candidates/1.0)' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return JSON.parse(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithProxy(url, timeout = 30000) {
  try {
    return await fetchJson(url, Math.min(timeout, 20000));
  } catch (directError) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`https://r.jina.ai/${url}`, {
        signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; apanel-auction-candidates/1.0)' }
      });
      if (!response.ok) throw directError;
      const text = await response.text();
      const marker = text.indexOf('Markdown Content:');
      const body = (marker >= 0 ? text.slice(marker + 17) : text).trim();
      return JSON.parse(body.slice(body.indexOf('{')));
    } finally {
      clearTimeout(timer);
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stockCode(item) {
  const raw = String(item?.c || '');
  if (!/^\d{6}$/.test(raw)) return '';
  if (/^(4|8|92)/.test(raw)) return `bj${raw}`;
  return `${Number(item?.m) === 1 ? 'sh' : 'sz'}${raw}`;
}

function mainBoardEligible(code, name = '') {
  return /^(sh|sz)\d{6}$/.test(code) &&
    !/^(sz300|sz301|sh688|sh689)/.test(code) &&
    !/ST|退/i.test(name);
}

function scoreC(height, marketHeight) {
  const h = Math.max(1, Number(height) || 1);
  let value = h === 1 ? 4 : h === 2 ? 10 : h === 3 ? 8 : h === 4 ? 6 : 2;
  if (marketHeight <= 4) value *= 0.6;
  else if (marketHeight >= 6) value *= h <= 2 ? 1.2 : 0.9;
  return clamp(value, 0, 12);
}

function scoreD(firstTime) {
  const time = Number(firstTime);
  if (!Number.isFinite(time) || time <= 0) return 0;
  if (time <= 100000) return 6;
  if (time <= 130000) return 3;
  return 1;
}

function scoreE(breaks) {
  const value = Math.max(0, Number(breaks) || 0);
  return value === 0 ? 4 : value === 1 ? 2 : value === 2 ? 0 : -5;
}

function normalizeRows(pool) {
  const rows = pool.map((item) => {
    const code = stockCode(item);
    return {
      code,
      name: String(item.n || code),
      sector: String(item.hybk || '其他'),
      boards: Math.max(1, Number(item.lbc || item.ylbc) || 1),
      firstTime: Number(item.fbt || item.yfbt) || null,
      breaks: Math.max(0, Number(item.zbc) || 0),
      amount: Number(item.amount) || 0,
      sealAmount: Number(item.fund) || 0,
      turnover: Number(item.hs) || 0,
      floatCap: Number(item.ltsz) || 0,
      streakDays: Math.max(1, Number(item.zttj?.days) || 1),
      streakCount: Math.max(1, Number(item.zttj?.ct) || 1),
      finalPct: Number.isFinite(Number(item.zdp)) ? Number(item.zdp) : null,
      finalPrice: Number(item.p) > 0 ? Number(item.p) / 100 : null,
      downgraded: /^(300|301|688|689)/.test(code.replace(/^(sh|sz|bj)/, ''))
    };
  }).filter((row) => row.code && row.name && mainBoardEligible(row.code, row.name));
  const marketHeight = rows.reduce((max, row) => Math.max(max, row.boards), 1);
  const groups = new Map();
  rows.forEach((row) => {
    if (!groups.has(row.sector)) groups.set(row.sector, []);
    groups.get(row.sector).push(row);
  });
  for (const group of groups.values()) {
    group.sort((a, b) => b.boards - a.boards ||
      (a.firstTime || Infinity) - (b.firstTime || Infinity) ||
      b.amount - a.amount);
    group.forEach((row, index) => {
      row.sectorRank = index + 1;
      row.sectorLeader = index === 0;
      row.sectorCount = group.length;
      row.marketHeight = marketHeight;
      const sectorStrength = group.length >= 3 ? 6 : group.length === 2 ? 4 : 0;
      const leaderBonus = index === 0 ? 4 : 0;
      row.candidateScore = round(48 + scoreC(row.boards, marketHeight) +
        scoreD(row.firstTime) + scoreE(row.breaks) +
        Math.min(10, sectorStrength + leaderBonus), 1);
    });
  }
  return { rows, marketHeight };
}

async function fetchAnnouncements(rows) {
  const numeric = rows.map((row) => row.code.replace(/^(sh|sz|bj)/, ''));
  const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann' +
    `?sr=-1&page_size=500&page_index=1&ann_type=A&client_source=web&stock_list=${numeric.join(',')}`;
  const payload = await fetchJsonWithProxy(url);
  const list = Array.isArray(payload?.data?.list) ? payload.data.list : [];
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const riskPattern = /(立案|调查|行政处罚|监管函|问询函|警示函|关注函|退市风险|终止上市|重大诉讼|违规|风险提示|业绩预亏|预亏|减持|股票交易异常波动)/;
  const grouped = Object.fromEntries(numeric.map((code) => [code, []]));
  list.forEach((item) => {
    const date = String(item.display_time || item.notice_date || '').slice(0, 10);
    const title = String(item.title || '');
    if (!date || date < cutoff || !title) return;
    (item.codes || []).forEach((mapping) => {
      const code = String(mapping?.stock_code || '');
      if (grouped[code]) grouped[code].push({ date, title });
    });
  });
  return Object.fromEntries(rows.map((row) => {
    const code = row.code.replace(/^(sh|sz|bj)/, '');
    const recent = grouped[code].sort((a, b) => b.date.localeCompare(a.date));
    const risky = recent.filter((item) => riskPattern.test(item.title));
    return [row.code, {
      status: 'ok',
      risk: risky.length > 0,
      latestDate: recent[0]?.date || '',
      latestTitle: recent[0]?.title || '',
      titles: risky.slice(0, 3).map((item) => item.title)
    }];
  }));
}

async function fetchOrderFlow(row, day) {
  const secid = row.code.startsWith('sh') ? `1.${row.code.slice(2)}` : `0.${row.code.slice(2)}`;
  const url = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get' +
    '?lmt=20&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63' +
    `&secid=${secid}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const payload = await fetchJsonWithProxy(`${url}&_=${Date.now()}`, 30000);
      const line = (payload?.data?.klines || [])
        .map((raw) => String(raw || '').split(','))
        .find((values) => String(values[0] || '').replaceAll('-', '') === day);
      if (line) {
        return {
          main: Number(line[1]),
          small: Number(line[2]),
          medium: Number(line[3]),
          large: Number(line[4]),
          superLarge: Number(line[5]),
          mainPct: Number(line[6]),
          closePct: Number(line[12])
        };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return null;
}

function marketCapInfo(floatCap) {
  const yi = Number(floatCap) / 100000000;
  if (!(yi > 0)) return { label: '市值待补', wide: '--', score: 0 };
  if (yi <= 80) return { label: `${round(yi, 1)}亿·小盘`, wide: `${round(yi, 1)}亿`, score: 2 };
  if (yi <= 300) return { label: `${round(yi, 0)}亿·中盘`, wide: `${round(yi, 0)}亿`, score: 1 };
  if (yi <= 800) return { label: `${round(yi, 0)}亿·大盘`, wide: `${round(yi, 0)}亿`, score: -1 };
  return { label: `${round(yi, 0)}亿·超大盘`, wide: `${round(yi, 0)}亿`, score: -3 };
}

function nextDayScore(row) {
  const amount = Number(row.amount);
  const sealAmount = Number(row.sealAmount);
  const turnover = Number(row.turnover);
  const floatCap = Number(row.floatCap);
  const sealRatio = amount > 0 && sealAmount > 0 ? sealAmount / amount * 100 : null;
  const cap = marketCapInfo(floatCap);
  const sealRate = (turnover >= 20 ? 0.012 : turnover >= 10 ? 0.01 : 0.008) +
    (row.boards >= 3 ? 0.002 : 0);
  const requiredSeal = floatCap > 0 ? clamp(floatCap * sealRate, 30000000, 1200000000) : null;
  const sealCoverage = requiredSeal && sealAmount > 0 ? sealAmount / requiredSeal : null;
  const mainFlow = Number(row.mainFlow?.main);
  let score = Number(row.candidateScore) || 0;
  if (row.announcement?.risk) score -= 18;
  else if (row.announcement?.status === 'ok') score += 2;
  if (Number.isFinite(mainFlow)) score += mainFlow > 0 ? 4 : mainFlow < 0 ? -5 : 0;
  if (Number.isFinite(sealRatio)) {
    score += sealRatio >= 20 ? 5 : sealRatio >= 10 ? 3 : sealRatio >= 5 ? 1 : sealRatio < 1 ? -2 : 0;
  }
  if (Number.isFinite(sealCoverage)) score += sealCoverage >= 1 ? 4 : sealCoverage >= 0.7 ? 1 : sealCoverage < 0.5 ? -3 : 0;
  score += cap.score;
  return {
    nextDayScore: round(clamp(score, 0, 99), 1),
    requiredSeal: round(requiredSeal, 0),
    sealRatio: round(sealRatio, 1),
    sealCoverage: round(sealCoverage, 3),
    capLabel: cap.label,
    capWide: cap.wide
  };
}

async function existingCurrent(day) {
  try {
    const payload = JSON.parse(await fs.readFile(JSON_FILE, 'utf8'));
    return String(payload.day) === day ? payload : null;
  } catch {
    return null;
  }
}

async function main() {
  const today = beijingToday();
  const day = process.env.AUCTION_CANDIDATE_DATE || today;
  const historical = day < today;
  if (!isWeekday(day)) {
    console.log(`Skip ${day}: weekend`);
    return;
  }
  if (!historical && beijingSeconds() < 54060) {
    console.log(`Skip ${day}: close data is not final before 15:01`);
    return;
  }
  if (!historical && beijingSeconds() > 79200) {
    console.warn(`Skip ${day}: refusing to generate stale candidate data after 22:00`);
    return;
  }
  if (await existingCurrent(day) && process.env.AUCTION_FORCE !== '1') {
    console.log(`Skip ${day}: shared candidates already exist`);
    return;
  }
  const poolUrl = `https://push2ex.eastmoney.com/getTopicZTPool?ut=${ZT_UT}` +
    `&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=${encodeURIComponent('fbt:asc')}` +
    `&date=${day}&_=${Date.now()}`;
  const poolPayload = await fetchJson(poolUrl);
  const pool = Array.isArray(poolPayload?.data?.pool) ? poolPayload.data.pool : [];
  if (String(poolPayload?.data?.qdate || '') !== day || !pool.length) {
    throw new Error(`Limit-up pool unavailable for ${day}`);
  }
  const { rows } = normalizeRows(pool);
  if (!rows.length) throw new Error('No main-board candidates');
  const announcements = await fetchAnnouncements(rows);
  const flowRows = [];
  for (let start = 0; start < rows.length; start += 6) {
    const chunk = rows.slice(start, start + 6);
    const flows = await Promise.all(chunk.map((row) => fetchOrderFlow(row, day)));
    chunk.forEach((row, index) => {
      if (flows[index]) flowRows.push({ ...row, mainFlow: flows[index], announcement: announcements[row.code] });
    });
  }
  const complete = flowRows.filter((row) =>
    row.mainFlow && row.announcement?.status === 'ok'
  ).map((row) => ({
    ...row,
    ...nextDayScore(row),
    flowFetched: true,
    conditionFetched: true
  }));
  complete.sort((a, b) => b.nextDayScore - a.nextDayScore ||
    b.candidateScore - a.candidateScore || b.boards - a.boards);
  if (!complete.length) {
    throw new Error(`No complete candidates: pool=${rows.length}, flowRows=${flowRows.length}`);
  }
  const payload = {
    schema: 'auction-server-candidates-v1',
    version: 1,
    generatedAt: GENERATED_AT,
    day,
    updatedAt: beijingClock(),
    totalCount: rows.length,
    sourceVersion: SOURCE_VERSION,
    rows: complete.slice(0, 20)
  };
  await fs.writeFile(JSON_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    JS_FILE,
    `/* Auto-generated by update-auction-candidates.mjs. Do not edit manually. */\nwindow.AUCTION_SERVER_CANDIDATES = ${JSON.stringify(payload)};\n`,
    'utf8'
  );
  console.log(`Wrote ${payload.rows.length}/${payload.totalCount} candidates for ${day}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
