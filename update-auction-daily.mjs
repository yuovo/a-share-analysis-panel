import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const JSON_FILE = path.join(ROOT, 'auction-daily.json');
const JS_FILE = path.join(ROOT, 'auction-daily.js');
const ZT_UT = '7eea3edcaed734bea9cbfc24409ed989';
const GENERATED_AT = new Date().toISOString();
const FORCE_REFRESH = process.env.AUCTION_FORCE === '1';
const SCORING_VERSION = 'auction-v10-20261105-volume-fallback';
const SNAPSHOT_VERSION = 'auction-snapshot-v1';

function beijingToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (type) => parts.find((x) => x.type === type)?.value;
  return `${get('year')}${get('month')}${get('day')}`;
}

function beijingMinute() {
  const value = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function beijingSecond() {
  const value = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
  const [hour, minute, second] = value.split(':').map(Number);
  return hour * 3600 + minute * 60 + second;
}

function beijingClockText() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
}

function quoteTimeText(value) {
  const m = /^\d{8}(\d{2})(\d{2})(\d{2})$/.exec(String(value || ''));
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

function ymd(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10).replaceAll('-', '');
}

function parseYmd(value) {
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T12:00:00+08:00`);
}

function shiftDay(value, delta) {
  const date = parseYmd(value);
  date.setDate(date.getDate() + delta);
  return ymd(date);
}

function isWeekday(value) {
  const day = parseYmd(value).getDay();
  return day >= 1 && day <= 5;
}

function recentWeekdays(end, count) {
  const out = [];
  let cursor = end;
  while (out.length < count) {
    if (isWeekday(cursor)) out.unshift(cursor);
    cursor = shiftDay(cursor, -1);
  }
  return out;
}

async function fetchJson(url, timeout = 16000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; apanel-auction-archive/1.0)' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  } finally {
    clearTimeout(timer);
  }
}

const poolCache = new Map();
async function fetchLimitPool(endpoint, day, size, sort) {
  const key = `${endpoint}:${day}:${size}:${sort}`;
  if (poolCache.has(key)) return poolCache.get(key);
  const url = `https://push2ex.eastmoney.com/${endpoint}?ut=${ZT_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=${size}&sort=${encodeURIComponent(sort)}&date=${day}&_=${Date.now()}`;
  const data = await fetchJson(url);
  const result = data?.data || null;
  poolCache.set(key, result);
  return result;
}

/**
 * Canonical candidate pool shared by both auction frontends.
 * Today's auction uses getYesterdayZTPool; older sessions fall back to that
 * session's getTopicZTPool. Request sizes and sort orders are fixed here.
 */
async function candidatePool(day) {
  for (let offset = 0; offset <= 8; offset++) {
    const queryDay = shiftDay(day, -offset);
    let topic = null;
    try {
      topic = await fetchLimitPool('getTopicZTPool', queryDay, 300, 'fbt:asc');
    } catch {
      continue;
    }
    if (!topic || !Array.isArray(topic.pool) || !topic.pool.length) continue;
    const poolDay = String(topic.qdate || queryDay);
    if (poolDay === day) {
      let previous = null;
      try {
        previous = await fetchLimitPool('getYesterdayZTPool', poolDay, 400, 'zdp:desc');
      } catch {}
      if (previous && Array.isArray(previous.pool) && previous.pool.length) {
        return { day: poolDay, pool: previous.pool, poolType: 'today-yesterday' };
      }
      continue;
    }
    if (poolDay > day) continue;
    return { day: poolDay, pool: topic.pool, poolType: 'previous-limit-up' };
  }
  throw new Error('最近交易日涨停池未取得');
}

function stockCode(item) {
  const raw = String(item?.c || '');
  if (/^(4|8|92)/.test(raw)) return `bj${raw}`;
  return `${Number(item?.m) === 1 ? 'sh' : 'sz'}${raw}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function fetchKline(code) {
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${encodeURIComponent(code)},day,,,90,qfq`;
  const data = await fetchJson(url);
  const node = data?.data?.[code];
  const rows = node?.qfqday || node?.day || [];
  const candles = [];
  for (const row of rows) {
    const date = String(row?.[0] || '').replaceAll('-', '');
    const open = Number(row?.[1]);
    const close = Number(row?.[2]);
    if (date.length === 8 && open > 0 && close > 0) candles.push({ date, open, close });
  }
  return candles;
}

async function fetchTencentQuotes(codes) {
  const result = new Map();
  for (let start = 0; start < codes.length; start += 40) {
    const chunk = codes.slice(start, start + 40);
    try {
      const response = await fetch(`https://qt.gtimg.cn/q=${chunk.join(',')}&_=${Date.now()}`, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; apanel-auction-archive/1.0)' }
      });
      if (!response.ok) continue;
      const text = new TextDecoder('gbk').decode(await response.arrayBuffer());
      const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
      let match;
      while ((match = re.exec(text))) {
        const code = match[1];
        const p = match[2].split('~');
        const open = Number(p[5]);
        const prevClose = Number(p[4]);
        const price = Number(p[3]);
        const time = String(p[30] || '');
        const combo = String(p[35] || '').split('/');
        const volume = Number(combo[1] ?? p[6]);
        const amount = Number(combo[2] ?? p[37]);
        if (open > 0 && prevClose > 0) result.set(code, { open, prevClose, price, volume, amount, time });
      }
    } catch {
      // A later scheduled attempt will retry the incomplete batch.
    }
  }
  return result;
}

function openForDay(candles, day) {
  const index = candles.findIndex((x) => x.date === day);
  if (index <= 0) return { open: null, prevClose: null };
  const candle = candles[index];
  const prevClose = candles[index - 1]?.close;
  return {
    open: candle.open > 0 ? candle.open : null,
    prevClose: prevClose > 0 ? prevClose : null
  };
}

function scoreCandidate(candidate) {
  const a = scoreA(candidate.gap);
  const b = scoreB(candidate.volRatio, candidate.auctionAmountRatio);
  const c = scoreC(candidate.height, candidate.marketMaxHeight);
  const d = scoreD(candidate.firstTime);
  const e = scoreE(candidate.breaks);
  const f = scoreF(candidate);
  const raw = 48 + a + b + c + d + e + f;
  return {
    a, b, c, d, e, f,
    base: raw,
    total: Math.round(raw * candidate.multiplier * 10) / 10
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function interp(x, x1, y1, x2, y2) {
  if (!Number.isFinite(x) || x2 === x1) return Number.isFinite(y2) ? y2 : 0;
  return y1 + (y2 - y1) * clamp((x - x1) / (x2 - x1), 0, 1);
}

function scoreA(gap) {
  if (!Number.isFinite(gap) || gap < -2.5 || gap > 6.5) return 0;
  if (gap < 0) return interp(gap, -2.5, 0, 0, 4);
  if (gap < 2) return interp(gap, 0, 4, 2, 10);
  if (gap < 3) return interp(gap, 2, 14, 3, 16);
  if (gap < 4) return interp(gap, 3, 16, 4, 12);
  if (gap < 5) return interp(gap, 4, 12, 5, 8);
  return interp(gap, 5, 8, 6.5, 4);
}

function scoreB(volumeRatio, amountRatio) {
  const vr = Number(volumeRatio);
  const ar = Number(amountRatio);
  const ratioScore = vr >= 5 ? 10 : vr >= 3 ? 6 : vr >= 2 ? 3 : 0;
  const amountScore = ar > 20 ? -6 : ar >= 10 ? 1 : ar >= 5 ? 4 : ar >= 3 ? 2 : 0;
  return clamp(ratioScore + amountScore, 0, 14);
}

function scoreC(height, marketHeight) {
  const h = Math.max(1, Number(height) || 1);
  let score = h === 1 ? 4 : h === 2 ? 10 : h === 3 ? 8 : h === 4 ? 6 : 2;
  if (marketHeight <= 4) score *= 0.6;
  else if (marketHeight >= 6) score *= h <= 2 ? 1.2 : 0.9;
  return clamp(score, 0, 12);
}

function scoreD(firstTime) {
  const t = Number(firstTime);
  if (!Number.isFinite(t) || t <= 0 || t > 143000) return 0;
  if (t <= 100000) return 6;
  if (t <= 130000) return 3;
  return 1;
}

function scoreE(breaks) {
  const b = Math.max(0, Number(breaks) || 0);
  return b === 0 ? 4 : b === 1 ? 2 : b === 2 ? 0 : -5;
}

function scoreF(candidate) {
  const count = Math.max(0, Number(candidate.sectorCount) || 0);
  const link = count >= 3 ? 6 : count === 2 ? 4 : 0;
  let position = 0;
  if (candidate.sectorHigher && Number.isFinite(candidate.sectorLeaderGap) && Number.isFinite(candidate.gap)) {
    if (candidate.sectorLeaderGap > candidate.gap + 2) position = -6;
    else if (candidate.sectorLeaderGap < candidate.gap - 1) position = 2;
  }
  return clamp(link + position, -8, 6);
}

function boardDowngraded(code) {
  const n = String(code || '').replace(/^(sh|sz|bj)/, '');
  return /^(300|301|688|689)/.test(n);
}

function ladderStage(height) {
  const h = Math.max(1, Number(height) || 1);
  return h === 1 ? '1进2' : h === 2 ? '2进3' : h === 3 ? '3进4' : '4进5以上';
}

function ladderCycle(topGap, marketHeight, highOpenRatio) {
  if (!Number.isFinite(topGap) || topGap < -3 || highOpenRatio < 0.35) {
    return { key: 'retreat', label: '退潮期', note: '空仓或极轻仓；不打高位板' };
  }
  if (marketHeight <= 2) return { key: 'ice', label: '冰点期', note: '只允许主线1进2极小仓试错' };
  if (marketHeight >= 5 && topGap >= 2) return { key: 'climax', label: '高潮期', note: '只持筹、少新开，不接一致加速' };
  if (marketHeight >= 4 && topGap >= 0 && highOpenRatio >= 0.5) {
    return { key: 'ferment', label: '发酵期', note: '主线完整时以3进4为核心' };
  }
  if (topGap < 0 || highOpenRatio < 0.5) return { key: 'diverge', label: '分歧期', note: '只做弱转强或分歧回封' };
  return { key: 'launch', label: '启动期', note: '优先板块前三辨识度' };
}

function environment(topGap) {
  if (!Number.isFinite(topGap)) return { multiplier: 1, threshold: 58, maxPicks: 2, level: '数据缺失', tone: 'neutral' };
  if (topGap < -3) return { multiplier: 0.85, threshold: 63, maxPicks: 1, level: '高风险降权', tone: 'risk' };
  if (topGap < -1) return { multiplier: 0.95, threshold: 60, maxPicks: 2, level: '弱化', tone: 'risk' };
  return { multiplier: 1, threshold: 58, maxPicks: 2, level: '正常', tone: 'opp' };
}

async function fetchAuctionBaseline(code) {
  const secid = code.startsWith('sh') ? `1.${code.slice(2)}` : `0.${code.slice(2)}`;
  const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}` +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=5&ut=7eea3edcaed734bea9cbfc24409ed989';
  try {
    const data = await fetchJson(url, 10000);
    const rows = Array.isArray(data?.data?.trends) ? data.data.trends : [];
    const byDay = new Map();
    for (const raw of rows) {
      const p = String(raw || '').split(',');
      const day = String(p[0] || '').slice(0, 10).replaceAll('-', '');
      const time = String(p[0] || '').slice(11, 16);
      if (day.length === 8 && time === '09:25') byDay.set(day, { volume: Number(p[5]) || 0, amount: Number(p[6]) || 0 });
    }
    const today = beijingToday();
    const todayRow = byDay.get(today) || null;
    const history = [...byDay.entries()].filter(([day]) => day < today).sort(([a], [b]) => a.localeCompare(b)).slice(-5).map(([, row]) => row);
    if (history.length < 3) return {
      ratio: null, days: history.length,
      currentVolume: todayRow?.volume || null, currentAmount: todayRow?.amount || null,
      history
    };
    const histVolume = mean(history.map((x) => x.volume).filter((x) => x > 0));
    const currentVolume = todayRow?.volume > 0 ? todayRow.volume : null;
    if (!(histVolume > 0) || !(currentVolume > 0)) return {
      ratio: null, days: history.length,
      currentVolume: todayRow?.volume || null, currentAmount: todayRow?.amount || null,
      history
    };
    return {
      ratio: currentVolume / histVolume, days: history.length,
      currentVolume: currentVolume, currentAmount: todayRow?.amount || null,
      history
    };
  } catch {
    return { ratio: null, days: 0, currentVolume: null, currentAmount: null, history: [] };
  }
}

function trackAction(gap) {
  if (!Number.isFinite(gap)) return '等待有效竞价，先不操作';
  if (gap > 3) return '冲高分批止盈；剩余仓位跌破开盘价或分时均价线即走';
  if (gap > 1.5) return '先卖一半；不能继续走强或板块转弱时卖出剩余';
  if (gap >= -0.5) return '观察 5–15 分钟：翻红站上均价线可留半仓，否则退出';
  if (gap >= -2) return '不补仓；09:45 前不能回补缺口并站上均价线就止损';
  return '低开超过 -2%，开盘减仓或清仓，禁止摊低成本';
}

function nextWeekday(day) {
  let cursor = shiftDay(day, 1);
  while (!isWeekday(cursor)) cursor = shiftDay(cursor, 1);
  return cursor;
}

async function buildRecord(day, poolDay, pool, openMap, snapshotMode, poolType) {
  const rows = pool.filter((item) => stockCode(item)).map((item) => ({
    item,
    height: Math.max(1, Number(item.ylbc || item.lbc) || 1),
    firstTime: Number(item.fbt || item.yfbt) || Infinity,
    amount: Number(item.amount) || 0
  }));
  const representativeRow = rows.slice().sort((a, b) =>
    b.height - a.height || a.firstTime - b.firstTime || b.amount - a.amount
  )[0];
  const representativeCode = representativeRow ? stockCode(representativeRow.item) : '';
  const representativeQuote = openMap.get(representativeCode) || null;
  const topGap = representativeQuote && representativeQuote.prevClose > 0
    ? (representativeQuote.open / representativeQuote.prevClose - 1) * 100 : null;
  const env = environment(topGap);
  const marketMaxHeight = rows.reduce((max, row) => Math.max(max, row.height), 0);
  const selected = rows.slice().sort((a, b) =>
    a.firstTime - b.firstTime || b.amount - a.amount || b.height - a.height
  ).slice(0, 120);

  const candidates = selected.map(({ item }) => {
    const code = stockCode(item);
    const quote = openMap.get(code) || {};
    const gap = Number(quote.open) > 0 && Number(quote.prevClose) > 0 ? (Number(quote.open) / Number(quote.prevClose) - 1) * 100 : null;
    const height = Math.max(1, Number(item.ylbc || item.lbc) || 1);
    const sector = String(item.hybk || '其他');
    const auctionAmount = Number(quote.amount) > 0 ? Number(quote.amount) : null;
    const ydayAmount = Number(item.amount) > 0 ? Number(item.amount) : null;
    const auctionAmountRatio = auctionAmount > 0 && ydayAmount > 0 ? auctionAmount / ydayAmount * 100 : null;
    return {
      code, name: item.n || code, sector, height, gap: round(gap, 3),
      boardDowngraded: boardDowngraded(code),
      price: round(quote.open, 2), lastPrice: round(quote.price || quote.open, 2),
      liveChange: quote.prevClose > 0 ? round((Number(quote.price || quote.open) / Number(quote.prevClose) - 1) * 100, 3) : null,
      prevClose: round(quote.prevClose, 3), auctionVolume: Number(quote.volume) || null,
      auctionAmount, ydayAmount, auctionAmountRatio: round(auctionAmountRatio, 3),
      breaks: Math.max(0, Number(item.zbc) || 0),
      firstTime: Number(item.fbt || item.yfbt) || null,
      quoteSource: quote.open ? '腾讯09:25竞价' : '缺失',
      volRatio: auctionAmountRatio, volumeRatioMode: '成交额占昨额代理', baselineDays: 0,
      sectorCount: 0, sectorMaxHeight: 0, sectorLeaderGap: null, sectorHigher: false,
      scoreA: 0, scoreB: 0, scoreC: 0, scoreD: 0, scoreE: 0, scoreF: 0,
      baseScore: 48, finalScore: null, filtered: '', watchOnly: false, watchReason: '', rank: 0,
      mode: height >= 3 && gap > 0 ? '强转强' : sector !== '其他' && gap > 0 ? '板块共振' : '观察承接'
    };
  });

  const sectorsMap = new Map();
  for (const candidate of candidates) {
    const sector = sectorsMap.get(candidate.sector) || { name: candidate.sector, count: 0, gapSum: 0, gapN: 0, high: 0, leader: null };
    sector.count += 1;
    if (Number.isFinite(candidate.gap)) {
      sector.gapSum += candidate.gap;
      sector.gapN += 1;
      if (candidate.gap > 0) sector.high += 1;
    }
    if (!sector.leader || candidate.height > sector.leader.height ||
      (candidate.height === sector.leader.height && candidate.firstTime < sector.leader.firstTime)) sector.leader = candidate;
    sectorsMap.set(candidate.sector, sector);
  }
  for (const candidate of candidates) {
    const sector = sectorsMap.get(candidate.sector);
    candidate.sectorCount = sector?.count || 0;
    candidate.sectorMaxHeight = sector?.leader?.height || 0;
    candidate.sectorHigher = !!(sector?.leader && sector.leader.code !== candidate.code && sector.leader.height > candidate.height);
    candidate.sectorLeaderGap = sector?.leader?.gap ?? null;
  }
  const sectorGroups = new Map();
  for (const candidate of candidates) {
    if (!sectorGroups.has(candidate.sector)) sectorGroups.set(candidate.sector, []);
    sectorGroups.get(candidate.sector).push(candidate);
  }
  for (const group of sectorGroups.values()) {
    group.sort((a, b) =>
      b.height - a.height || (a.firstTime || Infinity) - (b.firstTime || Infinity) ||
      (b.ydayAmount || 0) - (a.ydayAmount || 0)
    ).forEach((candidate, index) => { candidate.sectorRank = index + 1; });
  }

  const validGaps = candidates.filter((candidate) => Number.isFinite(candidate.gap));
  const highOpenRatio = validGaps.length ? validGaps.filter((candidate) => candidate.gap > 0).length / validGaps.length : null;
  const ladder = ladderCycle(topGap, marketMaxHeight, highOpenRatio);
  if (ladder.key === 'retreat') {
    env.threshold = Math.max(env.threshold, 63);
    env.maxPicks = 1;
  } else if (['ice', 'climax', 'diverge'].includes(ladder.key)) {
    env.maxPicks = 1;
  }

  for (const candidate of candidates) {
    if (/ST|退/i.test(candidate.name)) candidate.filtered = 'ST / 退市风险';
    else if (!candidate.price || !Number.isFinite(candidate.gap)) candidate.filtered = '竞价行情缺失';
    else if (!Number.isFinite(candidate.ydayAmount)) candidate.filtered = '昨日成交额缺失';
    else if (candidate.gap < -2.5) candidate.filtered = '竞价低开超过 -2.5%';
    else if (candidate.gap > 6.5) candidate.filtered = '竞价高开超过 6.5%';
    else if (candidate.code === representativeCode && topGap < -3) candidate.filtered = '昨日最高标代表竞价低于 -3%';
    else if (!Number.isFinite(candidate.firstTime) || candidate.firstTime <= 0) candidate.filtered = '昨日封板时间缺失';
    else if (candidate.firstTime > 143000) candidate.filtered = '昨日 14:30 后封板';
    else if (candidate.firstTime > 133000 && candidate.gap < -1) candidate.filtered = '13:30 后封板且竞价低于 -1%';
    else if (candidate.sectorCount < 2) candidate.filtered = '无板块联动（孤立涨停）';
    else if (candidate.sectorRank > 3) candidate.filtered = '板块辨识度未进前三';
    else if (candidate.height === 1 && candidate.firstTime > 100000) candidate.filtered = '1进2非早盘强势板';
    else if (ladder.key === 'retreat' && candidate.height >= 2) candidate.filtered = '退潮期不打高位板';
    else if (ladder.key === 'ice' && candidate.height >= 4) candidate.filtered = '冰点期高位板不参与';
    else if (ladder.key === 'climax' && candidate.height >= 3 && candidate.gap > 5) candidate.filtered = '高潮期不接一致加速板';
  }

  const scorePool = candidates.filter((candidate) => !candidate.filtered);
  const baselineMap = {};
  for (let start = 0; start < scorePool.length; start += 8) {
    await Promise.all(scorePool.slice(start, start + 8).map(async (candidate) => {
      const baseline = await fetchAuctionBaseline(candidate.code);
      baselineMap[candidate.code] = {
        currentVolume: baseline.currentVolume,
        currentAmount: baseline.currentAmount,
        history: Array.isArray(baseline.history) ? baseline.history : []
      };
      candidate.baselineDays = baseline.days;
      if (Number.isFinite(baseline.currentVolume) && baseline.currentVolume > 0) candidate.auctionVolume = baseline.currentVolume;
      if (Number.isFinite(baseline.currentAmount) && baseline.currentAmount > 0) candidate.auctionAmount = baseline.currentAmount;
      if (candidate.ydayAmount > 0 && candidate.auctionAmount > 0) {
        candidate.auctionAmountRatio = round(candidate.auctionAmount / candidate.ydayAmount * 100, 3);
      }
      if (Number.isFinite(baseline.ratio)) {
        candidate.volRatio = baseline.ratio;
        candidate.volumeRatioMode = `5日竞价量比（${baseline.days}/5）`;
      }
    }));
  }
  for (const candidate of scorePool) {
    const volumeReady = Number.isFinite(Number(candidate.auctionVolume)) && Number.isFinite(Number(candidate.auctionAmount));
    if (!volumeReady) {
      candidate.volRatio = 0;
      candidate.volumeRatioMode = '量能数据缺失（B项保守记0分）';
    }
    if (candidate.breaks < 3) continue;
    const realRatio = candidate.volumeRatioMode.startsWith('5日竞价量比');
    if (realRatio && candidate.volRatio >= 8 && candidate.auctionAmountRatio >= 10) {
      candidate.watchOnly = true;
      candidate.watchReason = `开板 ${candidate.breaks} 次，但竞价量比 ${round(candidate.volRatio, 2)}、竞价额占昨日全天 ${round(candidate.auctionAmountRatio, 1)}%，进入观察池，不参与排名`;
    } else if (!volumeReady) {
      candidate.filtered = `昨日开板 ${candidate.breaks} 次，且量能数据缺失，无法确认承接`;
    } else {
      candidate.filtered = `昨日开板 ${candidate.breaks} 次（未满足量能豁免）`;
    }
  }
  for (const candidate of scorePool.filter((x) => !x.filtered && !x.watchOnly)) {
    Object.assign(candidate, { marketMaxHeight, multiplier: env.multiplier });
    const sc = scoreCandidate(candidate);
    Object.assign(candidate, {
      scoreA: round(sc.a, 3), scoreB: round(sc.b, 3), scoreC: round(sc.c, 3),
      scoreD: round(sc.d, 3), scoreE: round(sc.e, 3), scoreF: round(sc.f, 3),
      baseScore: round(sc.base, 3), finalScore: round(sc.total, 3)
    });
    if (candidate.finalScore < env.threshold) candidate.filtered = `最终分低于动态阈值 ${env.threshold}`;
  }

  const ranked = candidates.filter((candidate) => !candidate.filtered && !candidate.watchOnly && Number.isFinite(candidate.finalScore))
    .sort((a, b) => b.finalScore - a.finalScore || b.gap - a.gap || a.code.localeCompare(b.code));
  const picks = ranked.filter((candidate) => !candidate.boardDowngraded).slice(0, env.maxPicks).map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    stage: ladderStage(candidate.height),
    positionPct: env.multiplier < 1 ? '5%–10%' : index === 0 ? '15%–20%' : '10%–15%'
  }));
  const rankMap = new Map(picks.map((pick) => [pick.code, pick.rank]));
  candidates.forEach((candidate) => { candidate.rank = rankMap.get(candidate.code) || 0; });
  const watchPool = candidates.filter((candidate) => candidate.watchOnly);
  const filtered = candidates.filter((candidate) => !!candidate.filtered);
  const sectors = [...sectorsMap.values()].map((sector) => ({
    name: sector.name, count: sector.count, maxHeight: sector.leader?.height || 1,
    leadName: sector.leader?.name || '', leadCode: sector.leader?.code || '',
    leadershipGap: round(sector.leader?.gap, 3),
    avgGap: round(sector.gapN ? sector.gapSum / sector.gapN : null, 3),
    highRatio: round(sector.gapN ? sector.high / sector.gapN : null, 4)
  })).sort((a, b) => b.count - a.count || (b.avgGap ?? -999) - (a.avgGap ?? -999));
  const reasons = [
    `昨日全市场最高连板 ${marketMaxHeight} 板；代表 ${representativeRow?.item?.n || representativeCode}（${representativeCode}）竞价 ${topGap == null ? '--' : `${topGap >= 0 ? '+' : ''}${round(topGap, 2)}%`}。`,
    `最高标环境 ${env.level}；乘数 ${env.multiplier}，动态阈值 ${env.threshold} 分，最多 ${env.maxPicks} 只。`,
    `全市场候选 ${rows.length} 只，按封板时间 / 成交额 / 连板高度截取 ${candidates.length} 只；竞价高开比例 ${highOpenRatio == null ? '--' : `${round(highOpenRatio * 100, 1)}%`}。`,
    picks.length ? `今日优选：${picks.map((pick) => `${pick.name} ${round(pick.finalScore, 1)} 分`).join(' / ')}` : '没有股票达到动态阈值，今天不生成优选。'
  ];
  const risks = [];
  if (topGap < -3) risks.push('最高标代表竞价低于 -3%：全局乘数 0.85、阈值 63 分、最多 1 只。');
  if (topGap >= -3 && topGap < -1) risks.push('最高标代表竞价处于 -3% 至 -1%：全局乘数 0.95、阈值 60 分。');
  if (filtered.length) risks.push(`硬过滤与动态阈值共剔除 ${filtered.length} 只。`);
  const quoteClock = snapshotMode === 'live' && beijingSecond() <= 33960
    ? quoteTimeText(representativeQuote?.time)
    : '09:25:00';
  const snapshotId = `${SNAPSHOT_VERSION}:${day}:${poolDay}:${SCORING_VERSION}:${GENERATED_AT}`;
  const rawSnapshot = {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotId,
    capturedAt: GENERATED_AT,
    day,
    poolDay,
    poolType,
    quoteClock,
    pool,
    quotes: Object.fromEntries([...openMap.entries()].map(([code, quote]) => [code, {
      open: quote.open,
      prevClose: quote.prevClose,
      price: quote.price,
      volume: quote.volume,
      amount: quote.amount,
      time: quote.time,
      source: quote.source || '腾讯09:25竞价'
    }])),
    baselines: baselineMap
  };

  return {
    day, candidatePoolDate: poolDay, verificationDate: nextWeekday(day),
    sourceLabel: snapshotMode === 'live'
      ? '每日定稿榜 · 09:25首次完整快照'
      : '每日定稿榜 · 09:25历史分钟重建',
    archiveSource: 'shared',
    archiveMode: snapshotMode === 'live' ? '09:25-first-complete-snapshot' : '09:25-history-rebuild',
    snapshotMode,
    snapshotId,
    rawSnapshot,
    scoringVersion: SCORING_VERSION, recordType: 'live', actionable: true,
    boardDowngradeCount: candidates.filter((candidate) => candidate.boardDowngraded).length,
    ladderCycle: ladder,
    baseScore: 48, generatedAt: GENERATED_AT, lockedAt: beijingClockText(), finalizedAt: beijingClockText(),
    snapshotLockedAt: snapshotMode === 'live' ? beijingClockText() : '09:25:00',
    quoteClock,
    auctionDataMode: snapshotMode === 'live'
      ? '09:25竞价开盘价 + 09:25历史分钟量能校正'
      : '日K开盘价 + 09:25历史分钟量能重建',
    candidates, sectors, picks, watchPool, filtered, tracking: null,
    decision: {
      baseScore: 48, threshold: env.threshold, multiplier: env.multiplier, maxPicks: env.maxPicks,
      level: env.level, tone: picks.length ? env.tone : 'risk',
      verdict: picks.length ? `竞价定稿完成，今日优选 ${picks.length} 只` : '无股票达到动态门槛，今日空仓',
      summary: '首次完整快照已锁定；之后只更新展示行情，不改分数与排名。',
      topGap: round(topGap, 3), topCode: representativeCode, topName: representativeRow?.item?.n || '--',
      maxHeight: marketMaxHeight, allCount: rows.length, poolCount: candidates.length,
      highOpenRatio: round(highOpenRatio, 4), reasons, risks,
      score: picks.length ? picks[0].finalScore : null,
      ladderCycle: ladder,
      boardDowngradeCount: candidates.filter((candidate) => candidate.boardDowngraded).length
    }
  };
}

async function writeArchive(records) {
  const normalized = records
    .filter((record) => record?.day && record.recordType === 'live' && record.actionable === true)
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-20);
  let previous = null;
  try { previous = JSON.parse(await fs.readFile(JSON_FILE, 'utf8')); } catch { /* first write */ }
  const recordsUnchanged = !!previous && JSON.stringify(previous.records || []) === JSON.stringify(normalized);
  const payload = {
    version: 1,
    generatedAt: recordsUnchanged && previous.generatedAt ? previous.generatedAt : GENERATED_AT,
    scoringVersion: SCORING_VERSION,
    snapshotVersion: SNAPSHOT_VERSION,
    records: normalized
  };
  await fs.writeFile(JSON_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    JS_FILE,
    `/* Auto-generated by scripts/update-auction-daily.mjs. Do not edit manually. */\nwindow.AUCTION_DAILY_ARCHIVE = ${JSON.stringify(payload)};\n`,
    'utf8'
  );
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await fs.mkdir(ROOT, { recursive: true });
  let previous = { records: [] };
  try {
    previous = JSON.parse(await fs.readFile(JSON_FILE, 'utf8'));
  } catch {
    // First run.
  }

  const existing = new Map((previous.records || [])
    .filter((record) => record && record.recordType === 'live' && record.actionable === true)
    .map((record) => [record.day, record]));
  const days = [process.env.AUCTION_DATE || beijingToday()];
  const runDay = process.env.AUCTION_DATE || beijingToday();
  let runSecond = beijingSecond();
  if (runSecond >= 33900 && runSecond < 33902) {
    await sleep((33902 - runSecond) * 1000 + 250);
    runSecond = beijingSecond();
  }
  if (runSecond < 33902 && runDay === beijingToday()) {
    console.log(`Skip ${runDay}: 09:25:02 has not completed`);
    return;
  }
  const snapshotMode = runDay === beijingToday() && isWeekday(runDay) &&
    runSecond >= 33902 && runSecond <= 33960 ? 'live' : 'rebuild';
  const sourceDays = [];
  for (const day of days) {
    let source;
    try {
      source = await candidatePool(day);
    } catch (error) {
      console.warn(`Skip ${day}: ${error.message}`);
      continue;
    }
    sourceDays.push({ day, source });
  }

  const neededCodes = new Set();
  for (const { day, source } of sourceDays) {
    source.pool.forEach((item) => neededCodes.add(stockCode(item)));
    const prior = existing.get(shiftDay(day, -1));
    (prior?.picks || []).forEach((pick) => neededCodes.add(pick.code));
  }

  const liveQuotes = snapshotMode === 'live' ? await fetchTencentQuotes([...neededCodes]) : new Map();

  const records = [];
  let priorRecord = null;
  for (const { day, source } of sourceDays) {
    if (day !== runDay) {
      priorRecord = existing.get(shiftDay(day, -1)) || priorRecord;
      continue;
    }
    const currentExisting = existing.get(day);
    if (!FORCE_REFRESH && currentExisting?.scoringVersion === SCORING_VERSION) {
      priorRecord = currentExisting;
      continue;
    }
    if (!source.pool.length) {
      priorRecord = existing.get(shiftDay(day, -1)) || priorRecord;
      continue;
    }

    const openMap = new Map();
    const quoteDay = runDay;
    if (snapshotMode === 'live') {
      for (const code of neededCodes) {
        const q = liveQuotes.get(code);
        const m = /^(\d{8})(\d{2})(\d{2})(\d{2})$/.exec(String(q?.time || ''));
        if (!q || !m || m[1] !== quoteDay) continue;
        const sec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
        if (sec < 33902) continue;
        openMap.set(code, q);
      }
    } else {
      const codes = [...neededCodes];
      for (let start = 0; start < codes.length; start += 8) {
        await Promise.all(codes.slice(start, start + 8).map(async (code) => {
          try {
            const candles = await fetchKline(code);
            const price = openForDay(candles, quoteDay);
            if (price.open > 0 && price.prevClose > 0) {
              openMap.set(code, {
                open: price.open,
                prevClose: price.prevClose,
                price: price.open,
                volume: null,
                amount: null,
                time: `${quoteDay}092500`,
                source: '日K开盘 + 09:25历史分钟量能'
              });
            }
          } catch {
            // Missing one code is handled by the same coverage threshold as live data.
          }
        }));
      }
    }
    const quoteCount = source.pool.filter((item) => openMap.has(stockCode(item))).length;
    const quoteNeed = Math.max(3, Math.ceil(source.pool.length * 0.95));
    if (quoteCount < quoteNeed) {
      console.warn(`Skip ${day}: ${quoteCount}/${source.pool.length} opening quotes, need ${quoteNeed}`);
      if (currentExisting) priorRecord = currentExisting;
      continue;
    }
    const representative = source.pool.slice().sort((a, b) =>
      Math.max(1, Number(b.ylbc || b.lbc) || 1) - Math.max(1, Number(a.ylbc || a.lbc) || 1) ||
      (Number(a.fbt || a.yfbt) || Infinity) - (Number(b.fbt || b.yfbt) || Infinity) ||
      (Number(b.amount) || 0) - (Number(a.amount) || 0)
    )[0];
    if (!representative || !openMap.has(stockCode(representative))) {
      console.warn(`Skip ${day}: representative highest-board quote is missing`);
      if (currentExisting) priorRecord = currentExisting;
      continue;
    }
    const record = await buildRecord(day, source.day, source.pool, openMap, snapshotMode, source.poolType);
    if (priorRecord?.picks?.length) {
      record.tracking = {
        date: priorRecord.day,
        verificationDay: day,
        rows: priorRecord.picks.map((pick) => {
          const quote = openMap.get(pick.code) || {};
          const gap = quote.open > 0 && quote.prevClose > 0 ? (quote.open / quote.prevClose - 1) * 100 : null;
          const pnl = quote.open > 0 && Number(pick.price) > 0 ? (quote.open / Number(pick.price) - 1) * 100 : null;
          return {
            ...pick,
            gap: round(gap, 3),
            price: round(quote.open, 2),
            buyRef: pick.price,
            pnl: round(pnl, 3),
            action: trackAction(gap)
          };
        })
      };
    }
    existing.set(day, record);
    records.push(record);
    priorRecord = record;
  }

  const payload = await writeArchive([...existing.values()]);
  console.log(`Wrote ${payload.records.length} auction records to ${JSON_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
