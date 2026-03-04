const state = {
  contractsByProduct: new Map(),
  tickersByProduct: new Map(),
  positions: [],
  closed: [],
  nextId: 1,
  nextAlertId: 1,
  equityStart: 1000,
  realizedPnl: 0,
  alerts: [],
  alertHistory: [],
  editingTpSlId: null,
  editingCloseId: null,
  currentUser: null,
  authToken: null,
  authMode: "server",
  isStateDirty: false,
  lastMarketUpdateTs: 0,
};

const DEFAULT_MAKER_FEE = 0.0002;
const DEFAULT_TAKER_FEE = 0.0006;
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const WS_URL = "wss://ws.bitget.com/v2/ws/public";
const WS_PING_INTERVAL_MS = 20000;
const WS_RECONNECT_MS = 1500;
const REST_FALLBACK_INTERVAL_MS = 8000;
const STALE_MARKET_RELOAD_MS = 5000;
const STALE_CHECK_INTERVAL_MS = 2000;
const RECOMPUTE_INTERVAL_MS = 1000;
const STATE_SAVE_INTERVAL_MS = 5000;
const ACCOUNT_PULL_INTERVAL_MS = 7000;
const ALERT_HISTORY_LIMIT = 300;
const AUTH_SESSION_KEY = "bitget_demo_trading_session_v2";
const GUEST_STATE_KEY = "bitget_demo_trading_guest_state_v1";
const GUEST_AUTH_DB_KEY = "bitget_demo_trading_guest_auth_db_v1";
const GUEST_SESSION_KEY = "bitget_demo_trading_guest_session_v1";
const LEGACY_MIGRATED_TO_SERVER_KEY = "bitget_demo_trading_legacy_migrated_to_server_v1";
const LEGACY_MIGRATION_TARGET_USER = "mn848931";
const BITGET_PROXY_BASE = window.BITGET_PROXY_BASE || "/api/bitget";

const wsState = {
  socket: null,
  isOpen: false,
  pingTimer: null,
  reconnectTimer: null,
  subscribed: new Set(),
};

window.addEventListener("error", (event) => {
  const target = document.getElementById("authStatus");
  if (!target) return;
  const msg = event?.message ? String(event.message) : "Unexpected app error.";
  target.textContent = `App error: ${msg}`;
});

window.addEventListener("unhandledrejection", (event) => {
  const target = document.getElementById("authStatus");
  if (!target) return;
  const reason = event?.reason instanceof Error ? event.reason.message : String(event?.reason || "Unknown async error");
  target.textContent = `App error: ${reason}`;
});

function setDefaultAccountState() {
  state.positions = [];
  state.closed = [];
  state.nextId = 1;
  state.nextAlertId = 1;
  state.equityStart = 1000;
  state.realizedPnl = 0;
  state.alerts = [];
  state.alertHistory = [];
  state.editingTpSlId = null;
  state.editingCloseId = null;
  state.isStateDirty = false;
}

function getAccountPayload() {
  return {
    nextId: state.nextId,
    nextAlertId: state.nextAlertId,
    equityStart: state.equityStart,
    realizedPnl: state.realizedPnl,
    positions: state.positions,
    closed: state.closed,
    alerts: state.alerts,
    alertHistory: state.alertHistory,
  };
}

function getDefaultAccountPayload() {
  return {
    nextId: 1,
    nextAlertId: 1,
    equityStart: 1000,
    realizedPnl: 0,
    positions: [],
    closed: [],
    alerts: [],
    alertHistory: [],
  };
}

function markStateDirty() {
  if (!state.currentUser) return;
  state.isStateDirty = true;
}

function isStateEmpty(candidate) {
  if (!candidate || typeof candidate !== "object") return true;
  const positions = Array.isArray(candidate.positions) ? candidate.positions : [];
  const closed = Array.isArray(candidate.closed) ? candidate.closed : [];
  const realized = Number(candidate.realizedPnl || 0);
  const equityStart = Number(candidate.equityStart || 1000);
  return positions.length === 0 && closed.length === 0 && realized === 0 && equityStart === 1000;
}

function getLegacyGuestStateForMigration() {
  const legacy = loadGuestState();
  if (!legacy || typeof legacy !== "object") return null;
  return isStateEmpty(legacy) ? null : legacy;
}

function clearLegacyGuestState() {
  try {
    localStorage.removeItem(GUEST_STATE_KEY);
  } catch (_) {
    // Ignore local storage errors.
  }
}

function hasLegacyServerMigrationDone() {
  try {
    return localStorage.getItem(LEGACY_MIGRATED_TO_SERVER_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function markLegacyServerMigrationDone() {
  try {
    localStorage.setItem(LEGACY_MIGRATED_TO_SERVER_KEY, "1");
  } catch (_) {
    // Ignore local storage errors.
  }
}

function clearGuestLocalAuthArtifacts() {
  try {
    localStorage.removeItem(GUEST_AUTH_DB_KEY);
    localStorage.removeItem(GUEST_SESSION_KEY);
    localStorage.removeItem(GUEST_STATE_KEY);
  } catch (_) {
    // Ignore local storage errors.
  }
}

function saveGuestState() {
  try {
    localStorage.setItem(GUEST_STATE_KEY, JSON.stringify(getAccountPayload()));
  } catch (_) {
    // Ignore local storage errors.
  }
}

function loadGuestState() {
  try {
    const raw = localStorage.getItem(GUEST_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function loadGuestAuthDb() {
  try {
    const raw = localStorage.getItem(GUEST_AUTH_DB_KEY);
    if (!raw) return { users: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.users !== "object" || !parsed.users) {
      return { users: {} };
    }
    return parsed;
  } catch (_) {
    return { users: {} };
  }
}

function saveGuestAuthDb(db) {
  try {
    localStorage.setItem(GUEST_AUTH_DB_KEY, JSON.stringify(db));
  } catch (_) {
    // Ignore local storage errors.
  }
}

function saveGuestSession(username) {
  try {
    if (!username) {
      localStorage.removeItem(GUEST_SESSION_KEY);
      return;
    }
    localStorage.setItem(GUEST_SESSION_KEY, JSON.stringify({ username }));
  } catch (_) {
    // Ignore local storage errors.
  }
}

function loadGuestSession() {
  try {
    const raw = localStorage.getItem(GUEST_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.username !== "string") return null;
    return parsed.username;
  } catch (_) {
    return null;
  }
}

function getFallbackSymbols(productType) {
  if (productType === "COIN-FUTURES") {
    return ["BTCUSD", "ETHUSD", "SOLUSD"];
  }
  if (productType === "USDC-FUTURES") {
    return ["BTCUSDC", "ETHUSDC", "SOLUSDC"];
  }
  return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
}

function ensureFallbackContracts(productType) {
  const existing = state.contractsByProduct.get(productType);
  if (existing && existing.size > 0) return;
  const map = new Map();
  for (const symbol of getFallbackSymbols(productType)) {
    map.set(symbol, {
      symbol,
      makerFeeRate: DEFAULT_MAKER_FEE,
      takerFeeRate: DEFAULT_TAKER_FEE,
      minLeverage: 1,
      maxLeverage: 100,
      mmr: null,
      pricePrecision: 2,
    });
  }
  state.contractsByProduct.set(productType, map);
}

function applyAccountPayload(parsed) {
  setDefaultAccountState();
  if (!parsed || typeof parsed !== "object") return;
  if (Number.isFinite(parsed.nextId) && parsed.nextId > 0) {
    state.nextId = Math.floor(parsed.nextId);
  }
  if (Number.isFinite(parsed.nextAlertId) && parsed.nextAlertId > 0) {
    state.nextAlertId = Math.floor(parsed.nextAlertId);
  }
  if (Number.isFinite(parsed.equityStart) && parsed.equityStart > 0) {
    state.equityStart = Number(parsed.equityStart);
  }
  if (Number.isFinite(parsed.realizedPnl)) {
    state.realizedPnl = Number(parsed.realizedPnl);
  }
  if (Array.isArray(parsed.positions)) {
    state.positions = parsed.positions.map((p) => ({
      ...p,
      openTs: Number.isFinite(p.openTs) ? Number(p.openTs) : Date.now(),
      lastFundingTs: Number.isFinite(p.lastFundingTs) ? Number(p.lastFundingTs) : Date.now(),
      lastMarkTs: Number.isFinite(p.lastMarkTs) ? Number(p.lastMarkTs) : Date.now(),
      closeLimitPrice: p.closeLimitPrice == null ? null : Number(p.closeLimitPrice),
      tpPrice: p.tpPrice == null ? null : Number(p.tpPrice),
      slPrice: p.slPrice == null ? null : Number(p.slPrice),
      pricePrecision: Number.isFinite(p.pricePrecision) ? Number(p.pricePrecision) : getSymbolPricePrecision(p.productType, p.symbol),
    }));
  }
  if (Array.isArray(parsed.closed)) {
    state.closed = parsed.closed.map((p) => ({
      ...p,
      openTs: Number.isFinite(p.openTs) ? Number(p.openTs) : null,
      closeTs: Number.isFinite(p.closeTs) ? Number(p.closeTs) : null,
      roiPct: Number.isFinite(p.roiPct) ? Number(p.roiPct) : ((Number(p.marginUsdt) > 0) ? (Number(p.realizedPnl) / Number(p.marginUsdt)) * 100 : 0),
    }));
  }
  if (Array.isArray(parsed.alerts)) {
    state.alerts = parsed.alerts
      .map((a) => ({
        id: Number.isFinite(a.id) ? Number(a.id) : null,
        productType: String(a.productType || ""),
        symbol: String(a.symbol || ""),
        direction: a.direction === "below" ? "below" : "above",
        targetPrice: Number(a.targetPrice),
        createdTs: Number.isFinite(a.createdTs) ? Number(a.createdTs) : Date.now(),
      }))
      .filter((a) => a.id && a.productType && a.symbol && Number.isFinite(a.targetPrice) && a.targetPrice > 0)
      .slice(0, 2000);
  }
  if (Array.isArray(parsed.alertHistory)) {
    state.alertHistory = parsed.alertHistory
      .map((h) => ({
        ...h,
        triggerTs: Number.isFinite(h.triggerTs) ? Number(h.triggerTs) : Date.now(),
        targetPrice: Number(h.targetPrice),
        triggerPrice: Number(h.triggerPrice),
      }))
      .filter((h) => h.productType && h.symbol && Number.isFinite(h.targetPrice))
      .slice(0, ALERT_HISTORY_LIMIT);
  }
}

async function authRequest(path, method = "GET", body = null) {
  const headers = {};
  if (state.authToken) {
    headers.Authorization = `Bearer ${state.authToken}`;
  }
  if (body != null) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json || {};
}

function saveSession() {
  if (!state.currentUser || !state.authToken) {
    localStorage.removeItem(AUTH_SESSION_KEY);
    return;
  }
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
    username: state.currentUser,
    token: state.authToken,
  }));
}

function loadSession() {
  const raw = localStorage.getItem(AUTH_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.username !== "string" || typeof parsed.token !== "string") return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

async function savePersistentState() {
  if (!state.isStateDirty) return;
  if (state.authMode === "guest") {
    const username = state.currentUser;
    if (!username) return;
    const db = loadGuestAuthDb();
    const user = db.users[username];
    if (!user) return;
    user.state = getAccountPayload();
    saveGuestAuthDb(db);
    saveGuestState();
    state.isStateDirty = false;
    return;
  }
  if (!state.currentUser || !state.authToken) return;
  try {
    await authRequest("/api/account/state", "PUT", { state: getAccountPayload() });
    state.isStateDirty = false;
  } catch (err) {
    console.error("state save failed", err);
  }
}

async function pullPersistentStateIfClean() {
  if (state.authMode !== "server") return;
  if (!state.currentUser || !state.authToken) return;
  if (state.isStateDirty) return;
  if (isInlineEditing()) return;
  try {
    const json = await authRequest("/api/account/state", "GET");
    if (!json || !json.state) return;
    applyAccountPayload(json.state);
    for (const pos of [...state.positions]) {
      recomputePosition(pos);
    }
    if (!isInlineEditing()) {
      renderPositions();
    }
    renderClosed();
    renderAlerts();
    renderAccountStats();
  } catch (_) {
    // Ignore transient pull failures.
  }
}

async function hasWorkingAuthApi() {
  try {
    const res = await fetch("/api/auth/me", { method: "GET" });
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const looksLikeApi = contentType.includes("application/json");
    if (!looksLikeApi) return false;
    return res.status === 401 || res.status === 200 || res.status === 403;
  } catch (_) {
    return false;
  }
}

const els = {
  authUsername: document.getElementById("authUsername"),
  authPassword: document.getElementById("authPassword"),
  registerBtn: document.getElementById("registerBtn"),
  loginBtn: document.getElementById("loginBtn"),
  headerLogoutBtn: document.getElementById("headerLogoutBtn"),
  authStatus: document.getElementById("authStatus"),
  authPanel: document.getElementById("authPanel"),
  userHeader: document.getElementById("userHeader"),
  headerUsername: document.getElementById("headerUsername"),
  productType: document.getElementById("productType"),
  symbol: document.getElementById("symbol"),
  symbolList: document.getElementById("symbolList"),
  side: document.getElementById("side"),
  leverage: document.getElementById("leverage"),
  sizeUsdt: document.getElementById("sizeUsdt"),
  openPosition: document.getElementById("openPosition"),
  alertDirection: document.getElementById("alertDirection"),
  alertTargetPrice: document.getElementById("alertTargetPrice"),
  addAlertBtn: document.getElementById("addAlertBtn"),
  activeAlerts: document.getElementById("activeAlerts"),
  alertHistory: document.getElementById("alertHistory"),
  positionsBody: document.getElementById("positionsBody"),
  closedBody: document.getElementById("closedBody"),
  marketStats: document.getElementById("marketStats"),
  accountStats: document.getElementById("accountStats"),
  resetAccount: document.getElementById("resetAccount"),
  fullReset: document.getElementById("fullReset"),
  authRequiredPanels: Array.from(document.querySelectorAll(".requires-auth")),
};

function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPrice(value) {
  if (!Number.isFinite(value)) return "-";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 12,
  });
}

function detectPrecision(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v.includes(".")) return 0;
  const frac = v.split(".")[1];
  if (!frac) return 0;
  return frac.length;
}

function fmtPriceFixed(value, precision) {
  if (!Number.isFinite(value)) return "-";
  const p = Number.isFinite(precision) ? clamp(Math.floor(precision), 0, 12) : 6;
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: p,
    maximumFractionDigits: p,
  });
}

function fmtDateTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts).toLocaleString();
}

function parseMsTimestamp(raw) {
  const ts = Number(raw);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

function didCrossThreshold(side, fromPrice, toPrice, triggerPrice, mode) {
  if (!Number.isFinite(fromPrice) || !Number.isFinite(toPrice) || !Number.isFinite(triggerPrice)) return false;
  if (mode === "up") {
    return side === "long" ? fromPrice < triggerPrice && toPrice >= triggerPrice : fromPrice > triggerPrice && toPrice <= triggerPrice;
  }
  return side === "long" ? fromPrice > triggerPrice && toPrice <= triggerPrice : fromPrice < triggerPrice && toPrice >= triggerPrice;
}

function estimateCrossTimestamp(fromPrice, toPrice, fromTs, toTs, triggerPrice) {
  const startTs = Number.isFinite(fromTs) ? fromTs : null;
  const endTs = Number.isFinite(toTs) ? toTs : Date.now();
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) return endTs;
  if (!Number.isFinite(fromPrice) || !Number.isFinite(toPrice) || fromPrice === toPrice) return endTs;
  const ratio = clamp((triggerPrice - fromPrice) / (toPrice - fromPrice), 0, 1);
  return Math.floor(startTs + (endTs - startTs) * ratio);
}

function estimateCloseAtPrice(pos, exitPrice) {
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    return { closeFee: pos.sizeUsdt * pos.takerFeeRate, realizedPnl: NaN };
  }
  const dir = pos.side === "long" ? 1 : -1;
  const gross = dir * ((exitPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeUsdt;
  const closeFee = pos.sizeUsdt * pos.takerFeeRate;
  const realizedPnl = gross - pos.openFee - closeFee - pos.fundingAccrued;
  return { closeFee, realizedPnl };
}

function closePreviewHtml(label, price, pos) {
  const { closeFee, realizedPnl } = estimateCloseAtPrice(pos, price);
  const pnlClass = Number.isFinite(realizedPnl) ? (realizedPnl >= 0 ? "good" : "bad") : "";
  const priceText = Number.isFinite(price) ? fmtPriceFixed(price, pos.pricePrecision) : "-";
  const pnlText = Number.isFinite(realizedPnl) ? fmt(realizedPnl) : "-";
  return `${label} @ ${priceText} | Est PnL: <span class="${pnlClass}">${pnlText}</span> USDT | Close Fee: ${fmt(closeFee)} USDT`;
}

function tpSlPreviewHtml(label, price, pos) {
  const { realizedPnl } = estimateCloseAtPrice(pos, price);
  const pnlClass = Number.isFinite(realizedPnl) ? (realizedPnl >= 0 ? "good" : "bad") : "";
  const priceText = Number.isFinite(price) ? fmtPriceFixed(price, pos.pricePrecision) : "-";
  const pnlText = Number.isFinite(realizedPnl) ? fmt(realizedPnl) : "-";
  return `${label} @ ${priceText} | Est PnL: <span class="${pnlClass}">${pnlText}</span> USDT`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function bitgetGet(endpoint, params = {}) {
  const query = new URLSearchParams(params);
  const suffix = `${endpoint}${query.toString() ? `?${query.toString()}` : ""}`;
  const urls = [`${BITGET_PROXY_BASE}${suffix}`, `https://api.bitget.com${suffix}`];
  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Bitget request failed");
}

async function loadContracts(productType) {
  const json = await bitgetGet("/api/v2/mix/market/contracts", { productType });
  const rows = Array.isArray(json.data) ? json.data : [];
  const map = new Map();
  for (const r of rows) {
    const symbol = r.symbol || r.symbolName;
    if (!symbol) continue;
    map.set(symbol, {
      symbol,
      makerFeeRate: parseFloat(r.makerFeeRate ?? r.makerFee ?? DEFAULT_MAKER_FEE) || DEFAULT_MAKER_FEE,
      takerFeeRate: parseFloat(r.takerFeeRate ?? r.takerFee ?? DEFAULT_TAKER_FEE) || DEFAULT_TAKER_FEE,
      minLeverage: parseFloat(r.minLever ?? 1) || 1,
      maxLeverage: parseFloat(r.maxLever ?? 100) || 100,
      mmr: parseFloat(r.keepMarginRate ?? r.maintainMarginRate ?? "") || null,
      pricePrecision: parseInt(r.pricePlace ?? r.pricePrecision ?? r.priceScale ?? "", 10),
    });
  }
  state.contractsByProduct.set(productType, map);
}

async function loadTickers(productType) {
  const prevMap = state.tickersByProduct.get(productType) || new Map();
  const json = await bitgetGet("/api/v2/mix/market/tickers", { productType });
  const rows = Array.isArray(json.data) ? json.data : [];
  const map = new Map();
  for (const r of rows) {
    const symbol = r.symbol;
    if (!symbol) continue;
    const mark = parseFloat(r.markPrice ?? "");
    const last = parseFloat(r.lastPr ?? r.last ?? "");
    const best = firstFinite(mark, last);
    const next = {
      markPrice: best,
      lastPrice: Number.isFinite(last) ? last : best,
      fundingRate: parseFloat(r.fundingRate ?? "0"),
      pricePrecision: detectPrecision(r.markPrice ?? r.lastPr ?? r.last ?? ""),
      ts: parseMsTimestamp(r.ts ?? r.systemTime) ?? Date.now(),
    };
    map.set(symbol, next);
    state.lastMarketUpdateTs = Math.max(state.lastMarketUpdateTs || 0, Number.isFinite(next.ts) ? next.ts : Date.now());
    const prev = prevMap.get(symbol);
    const prevBest = firstFinite(prev?.markPrice, prev?.lastPrice);
    processAlertsForPrice(
      productType,
      symbol,
      prevBest,
      best,
      next.ts,
      [prev?.markPrice, prev?.lastPrice],
      [mark, last, next.markPrice, next.lastPrice]
    );
  }
  state.tickersByProduct.set(productType, map);
}

async function getFundingRate(productType, symbol) {
  try {
    const json = await bitgetGet("/api/v2/mix/market/current-fund-rate", { productType, symbol });
    if (json?.data?.fundingRate != null) {
      return parseFloat(json.data.fundingRate) || 0;
    }
  } catch (_) {
    return 0;
  }
  return 0;
}

function estimateMMR(leverage, contractMMR) {
  if (Number.isFinite(contractMMR) && contractMMR > 0) {
    return contractMMR * 100;
  }
  if (leverage <= 20) return 0.5;
  if (leverage <= 50) return 1.0;
  if (leverage <= 75) return 1.5;
  return 2.0;
}

function calcLiqPrice(pos, markPrice) {
  const mmr = pos.mmrPct / 100;
  const closeFee = pos.sizeUsdt * pos.takerFeeRate;
  const carryingCost = pos.openFee + pos.fundingAccrued;
  const rhs = mmr * pos.sizeUsdt + closeFee + carryingCost - pos.marginUsdt;
  const ratio = rhs / pos.sizeUsdt;

  if (pos.side === "long") {
    return pos.entryPrice * (1 + ratio);
  }
  return pos.entryPrice * (1 - ratio);
}

function calcUnrealized(pos, markPrice) {
  const dir = pos.side === "long" ? 1 : -1;
  const gross = dir * ((markPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeUsdt;
  const estCloseFee = pos.sizeUsdt * pos.takerFeeRate;
  const net = gross - pos.openFee - estCloseFee - pos.fundingAccrued;
  return { gross, net };
}

function getTicker(productType, symbol) {
  const byProduct = state.tickersByProduct.get(productType);
  return byProduct ? byProduct.get(symbol) : null;
}

function getSymbolPricePrecision(productType, symbol) {
  const contract = state.contractsByProduct.get(productType)?.get(symbol);
  if (Number.isFinite(contract?.pricePrecision) && contract.pricePrecision >= 0) {
    return clamp(contract.pricePrecision, 0, 12);
  }
  const ticker = getTicker(productType, symbol);
  if (Number.isFinite(ticker?.pricePrecision) && ticker.pricePrecision >= 0) {
    return clamp(ticker.pricePrecision, 0, 12);
  }
  return 6;
}

function getEstimatedEquity() {
  const unrealized = state.positions.reduce((acc, p) => acc + p.unrealizedNet, 0);
  return state.equityStart + state.realizedPnl + unrealized;
}

function isInlineEditing() {
  return state.editingTpSlId !== null || state.editingCloseId !== null;
}

function fullResetAll() {
  setDefaultAccountState();
  markStateDirty();
  syncWsSubscriptions();
  renderPositions();
  renderClosed();
  renderAlerts();
  renderAccountStats();
  savePersistentState();
}

function subKey(productType, symbol) {
  return `${productType}|${symbol}`;
}

function parseSubKey(key) {
  const [productType, symbol] = key.split("|");
  return { productType, symbol };
}

function getDesiredSubKeys() {
  const keys = new Set();
  const productType = els.productType.value;
  const currentSymbol = (els.symbol.value || "").trim().toUpperCase();
  if (currentSymbol) {
    keys.add(subKey(productType, currentSymbol));
  }
  for (const pos of state.positions) {
    keys.add(subKey(pos.productType, pos.symbol));
  }
  for (const alert of state.alerts) {
    keys.add(subKey(alert.productType, alert.symbol));
  }
  return keys;
}

function wsArgsFromKeys(keys) {
  return [...keys].map((key) => {
    const [productType, symbol, channel = "ticker"] = key.split("|");
    return { instType: productType, channel, instId: symbol };
  });
}

function wsStreamKeysFromSymbolKeys(symbolKeys) {
  const out = new Set();
  for (const key of symbolKeys) {
    const { productType, symbol } = parseSubKey(key);
    out.add(`${productType}|${symbol}|ticker`);
    out.add(`${productType}|${symbol}|trade`);
  }
  return out;
}

function wsSend(op, args) {
  if (!wsState.isOpen || !wsState.socket) return;
  if (!args.length) return;
  wsState.socket.send(JSON.stringify({ op, args }));
}

function syncWsSubscriptions() {
  if (!wsState.isOpen) return;
  const desired = wsStreamKeysFromSymbolKeys(getDesiredSubKeys());
  const toUnsub = [...wsState.subscribed].filter((k) => !desired.has(k));
  const toSub = [...desired].filter((k) => !wsState.subscribed.has(k));

  if (toUnsub.length) {
    wsSend("unsubscribe", wsArgsFromKeys(toUnsub));
    for (const k of toUnsub) wsState.subscribed.delete(k);
  }
  if (toSub.length) {
    wsSend("subscribe", wsArgsFromKeys(toSub));
    for (const k of toSub) wsState.subscribed.add(k);
  }
}

function scheduleWsReconnect() {
  if (wsState.reconnectTimer) return;
  wsState.reconnectTimer = setTimeout(() => {
    wsState.reconnectTimer = null;
    connectMarketWs();
  }, WS_RECONNECT_MS);
}

function upsertTickerFromWs(productType, symbol, row) {
  if (!productType || !symbol) return;
  if (!state.tickersByProduct.has(productType)) {
    state.tickersByProduct.set(productType, new Map());
  }
  const byProduct = state.tickersByProduct.get(productType);
  const prev = byProduct.get(symbol) || { markPrice: NaN, lastPrice: NaN, fundingRate: 0, pricePrecision: null, ts: null };
  const rowMark = parseFloat(row.markPrice ?? "");
  const rowLast = parseFloat(row.lastPr ?? row.last ?? "");
  const rowBid = parseFloat(row.bidPr ?? row.bidPrice ?? "");
  const rowAsk = parseFloat(row.askPr ?? row.askPrice ?? "");
  const prevBest = firstFinite(prev.markPrice, prev.lastPrice);
  const nextBest = firstFinite(rowMark, rowLast, rowBid, rowAsk, prevBest);
  const next = {
    markPrice: nextBest,
    lastPrice: Number.isFinite(rowLast) ? rowLast : nextBest,
    fundingRate: parseFloat(row.fundingRate ?? prev.fundingRate ?? 0),
    pricePrecision: detectPrecision(String(row.markPrice ?? row.lastPr ?? row.last ?? row.bidPr ?? row.askPr ?? "")) ?? prev.pricePrecision,
    ts: parseMsTimestamp(row.ts ?? row.systemTime) ?? Date.now(),
  };
  byProduct.set(symbol, next);
  state.lastMarketUpdateTs = Number.isFinite(next.ts) ? next.ts : Date.now();
  processAlertsForPrice(
    productType,
    symbol,
    prevBest,
    nextBest,
    next.ts,
    [prev.markPrice, prev.lastPrice],
    [rowMark, rowLast, rowBid, rowAsk, next.markPrice, next.lastPrice]
  );
}

function upsertTickerFromTrade(productType, symbol, row) {
  if (!productType || !symbol) return;
  if (!state.tickersByProduct.has(productType)) {
    state.tickersByProduct.set(productType, new Map());
  }
  const byProduct = state.tickersByProduct.get(productType);
  const prev = byProduct.get(symbol) || { markPrice: NaN, lastPrice: NaN, fundingRate: 0, pricePrecision: null, ts: null };
  const tradePrice = parseFloat(row.price ?? row.lastPr ?? row.last ?? row.p ?? row.tradePrice ?? row.px ?? "");
  const nextTs = parseMsTimestamp(row.ts ?? row.systemTime ?? row.t) ?? Date.now();
  const prevBest = firstFinite(prev.lastPrice, prev.markPrice);
  const nextBest = firstFinite(tradePrice, prevBest);
  const next = {
    markPrice: nextBest,
    lastPrice: nextBest,
    fundingRate: prev.fundingRate ?? 0,
    pricePrecision: detectPrecision(String(row.price ?? row.lastPr ?? row.last ?? row.p ?? row.tradePrice ?? row.px ?? "")) ?? prev.pricePrecision,
    ts: nextTs,
  };
  byProduct.set(symbol, next);
  state.lastMarketUpdateTs = nextTs;
  processAlertsForPrice(
    productType,
    symbol,
    prevBest,
    nextBest,
    nextTs,
    [prev.markPrice, prev.lastPrice],
    [tradePrice, next.markPrice, next.lastPrice]
  );
}

function connectMarketWs() {
  if (wsState.socket && (wsState.socket.readyState === WebSocket.OPEN || wsState.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const ws = new WebSocket(WS_URL);
  wsState.socket = ws;

  ws.onopen = () => {
    wsState.isOpen = true;
    wsState.subscribed.clear();
    syncWsSubscriptions();

    if (wsState.pingTimer) clearInterval(wsState.pingTimer);
    wsState.pingTimer = setInterval(() => {
      if (wsState.socket?.readyState === WebSocket.OPEN) {
        wsState.socket.send("ping");
      }
    }, WS_PING_INTERVAL_MS);
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string" && event.data.toLowerCase() === "pong") return;

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }

    if (!msg || !msg.arg || !Array.isArray(msg.data)) return;
    const channel = (msg.arg.channel || "").toLowerCase();
    if (channel !== "ticker" && channel !== "trade" && channel !== "trades") return;

    const productType = msg.arg.instType || msg.arg.productType || "";
    for (const row of msg.data) {
      const symbol = row.symbol || row.instId || msg.arg.instId || "";
      if (channel === "trade" || channel === "trades") {
        upsertTickerFromTrade(productType, symbol, row);
      } else {
        upsertTickerFromWs(productType, symbol, row);
      }
    }

    for (const pos of [...state.positions]) {
      recomputePosition(pos);
    }
    if (!isInlineEditing()) {
      renderPositions();
    }
    renderMarketStats();
    renderAccountStats();
  };

  ws.onclose = () => {
    wsState.isOpen = false;
    wsState.subscribed.clear();
    if (wsState.pingTimer) {
      clearInterval(wsState.pingTimer);
      wsState.pingTimer = null;
    }
    scheduleWsReconnect();
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch (_) {
      // Ignore close errors.
    }
  };
}

function renderSymbols() {
  const productType = els.productType.value;
  let contracts = state.contractsByProduct.get(productType);
  let symbols = contracts ? Array.from(contracts.keys()).sort() : [];
  if (!symbols.length) {
    ensureFallbackContracts(productType);
    contracts = state.contractsByProduct.get(productType);
    symbols = contracts ? Array.from(contracts.keys()).sort() : [];
  }
  const current = (els.symbol.value || "").trim();

  els.symbolList.innerHTML = "";
  for (const s of symbols) {
    const opt = document.createElement("option");
    opt.value = s;
    els.symbolList.appendChild(opt);
  }
  if (!symbols.includes(current)) {
    els.symbol.value = symbols[0] || "";
  }

  renderMarketStats();
}

function renderMarketStats() {
  const productType = els.productType.value;
  const symbol = (els.symbol.value || "").trim().toUpperCase();
  const ticker = getTicker(productType, symbol);
  const contracts = state.contractsByProduct.get(productType);
  const contract = contracts?.get(symbol);

  const mark = ticker?.markPrice ?? 0;
  const fund = ticker?.fundingRate ?? 0;
  const maker = contract?.makerFeeRate ?? DEFAULT_MAKER_FEE;
  const taker = contract?.takerFeeRate ?? DEFAULT_TAKER_FEE;
  const maxLev = contract?.maxLeverage ?? 100;

  const rows = [
    ["Mark Price", `${fmtPrice(mark)} USDT`],
    ["Funding Rate", `${fmt(fund * 100, 4)} %`],
    ["Maker Fee", `${fmt(maker * 100, 4)} %`],
    ["Taker Fee", `${fmt(taker * 100, 4)} %`],
    ["Max Leverage", `${maxLev}x`],
  ];

  els.marketStats.innerHTML = rows
    .map(([k, v]) => `<div class="stat"><div class="label">${k}</div><div class="value">${v}</div></div>`)
    .join("");
}

function renderAccountStats() {
  const unrealized = state.positions.reduce((acc, p) => acc + p.unrealizedNet, 0);
  const equity = getEstimatedEquity();

  const rows = [
    ["Starting Balance", `${fmt(state.equityStart)} USDT`],
    ["Realized PnL", `${fmt(state.realizedPnl)} USDT`],
    ["Unrealized PnL", `${fmt(unrealized)} USDT`],
    ["Estimated Equity", `${fmt(equity)} USDT`],
    ["Open Positions", String(state.positions.length)],
  ];

  els.accountStats.innerHTML = rows
    .map(([k, v]) => `<div class="stat"><div class="label">${k}</div><div class="value">${v}</div></div>`)
    .join("");

  els.resetAccount.disabled = equity >= 100;
}

function alertDirectionLabel(direction) {
  return direction === "below" ? "<=" : ">=";
}

function renderAlerts() {
  if (!els.activeAlerts || !els.alertHistory) return;
  const activeHtml = state.alerts
    .slice()
    .sort((a, b) => b.createdTs - a.createdTs)
    .map((a) => `<div class="alert-item">
      <div class="row"><strong>${a.symbol}</strong><span>${a.productType}</span></div>
      <div class="row"><span>Trigger ${alertDirectionLabel(a.direction)} ${fmtPriceFixed(a.targetPrice, 6)}</span></div>
      <div class="row"><span>${fmtDateTime(a.createdTs)}</span><button class="secondary small" data-action="alert-remove" data-id="${a.id}">Remove</button></div>
    </div>`)
    .join("");
  els.activeAlerts.innerHTML = activeHtml || `<div class="alert-empty">No active alerts</div>`;

  const historyHtml = state.alertHistory
    .slice()
    .reverse()
    .map((h) => `<div class="alert-item">
      <div class="row"><strong>${h.symbol}</strong><span>${h.productType}</span></div>
      <div class="row"><span>Target ${alertDirectionLabel(h.direction)} ${fmtPriceFixed(h.targetPrice, 6)}</span></div>
      <div class="row"><span>Hit ${fmtPriceFixed(h.triggerPrice, 6)}</span><span>${fmtDateTime(h.triggerTs)}</span></div>
      <div class="row"><span>${h.status || "sent"}</span></div>
    </div>`)
    .join("");
  els.alertHistory.innerHTML = historyHtml || `<div class="alert-empty">No alert history</div>`;
}

async function sendTelegramAlertMessage(text) {
  if (!state.currentUser || !state.authToken) return;
  await authRequest("/api/notify/telegram", "POST", { text });
}

function pushAlertHistory(entry) {
  state.alertHistory.push(entry);
  if (state.alertHistory.length > ALERT_HISTORY_LIMIT) {
    state.alertHistory.splice(0, state.alertHistory.length - ALERT_HISTORY_LIMIT);
  }
}

function shouldTriggerAlert(direction, targetPrice, prevPrice, nextPrice) {
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return false;
  if (!Number.isFinite(nextPrice) || nextPrice <= 0) return false;
  if (direction === "below") {
    if (Number.isFinite(prevPrice)) return prevPrice > targetPrice && nextPrice <= targetPrice;
    return nextPrice <= targetPrice;
  }
  if (Number.isFinite(prevPrice)) return prevPrice < targetPrice && nextPrice >= targetPrice;
  return nextPrice >= targetPrice;
}

function firstFinite(...values) {
  for (const v of values) {
    if (Number.isFinite(v)) return Number(v);
  }
  return NaN;
}

function shouldTriggerByEnvelope(direction, targetPrice, prevCandidates, nextCandidates) {
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return false;
  const prices = [...prevCandidates, ...nextCandidates].filter((v) => Number.isFinite(v) && v > 0);
  if (!prices.length) return false;
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  if (direction === "below") {
    return lo <= targetPrice;
  }
  return hi >= targetPrice;
}

function processAlertsForPrice(productType, symbol, prevPrice, nextPrice, ts, prevCandidates = [], nextCandidates = []) {
  if (!state.currentUser) return;
  const prevAll = [...prevCandidates];
  const nextAll = [...nextCandidates];
  if (Number.isFinite(prevPrice)) prevAll.push(prevPrice);
  if (Number.isFinite(nextPrice)) nextAll.push(nextPrice);
  const triggered = state.alerts.filter((a) =>
    a.productType === productType
    && a.symbol === symbol
    && (shouldTriggerAlert(a.direction, a.targetPrice, prevPrice, nextPrice)
      || shouldTriggerByEnvelope(a.direction, a.targetPrice, prevAll, nextAll))
  );
  if (!triggered.length) return;

  const nowTs = Number.isFinite(ts) ? Number(ts) : Date.now();
  const triggerPrice = Number.isFinite(nextPrice) ? Number(nextPrice) : NaN;
  const triggeredIds = new Set(triggered.map((a) => a.id));
  state.alerts = state.alerts.filter((a) => !triggeredIds.has(a.id));
  markStateDirty();
  renderAlerts();
  savePersistentState();

  for (const alert of triggered) {
    const history = {
      id: `${alert.id}-${nowTs}`,
      productType: alert.productType,
      symbol: alert.symbol,
      direction: alert.direction,
      targetPrice: alert.targetPrice,
      triggerPrice,
      triggerTs: nowTs,
      status: "sent",
    };
    pushAlertHistory(history);
    const text = `[Bitget Alert] ${alert.symbol} (${alert.productType}) hit ${fmtPriceFixed(triggerPrice, 6)}. Target ${alertDirectionLabel(alert.direction)} ${fmtPriceFixed(alert.targetPrice, 6)}.`;
    sendTelegramAlertMessage(text).catch((err) => {
      history.status = `failed: ${err instanceof Error ? err.message : "send error"}`;
      renderAlerts();
      markStateDirty();
      savePersistentState();
    });
  }
  renderAlerts();
  markStateDirty();
  savePersistentState();
}

function createPriceAlert() {
  if (!state.currentUser) {
    alert("Please login first.");
    return;
  }
  const productType = els.productType.value;
  const symbol = (els.symbol.value || "").trim().toUpperCase();
  const direction = els.alertDirection.value === "below" ? "below" : "above";
  const targetPrice = Number(els.alertTargetPrice.value);
  if (!symbol) {
    alert("Select a symbol first.");
    return;
  }
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
    alert("Target price must be a positive number.");
    return;
  }
  const item = {
    id: state.nextAlertId++,
    productType,
    symbol,
    direction,
    targetPrice,
    createdTs: Date.now(),
  };

  const ticker = getTicker(productType, symbol);
  const currentPrice = firstFinite(ticker?.markPrice, ticker?.lastPrice);
  const immediateHit = direction === "below"
    ? (Number.isFinite(currentPrice) && currentPrice <= targetPrice)
    : (Number.isFinite(currentPrice) && currentPrice >= targetPrice);
  if (immediateHit) {
    const nowTs = Number.isFinite(ticker?.ts) ? Number(ticker.ts) : Date.now();
    const history = {
      id: `${item.id}-${nowTs}`,
      productType: item.productType,
      symbol: item.symbol,
      direction: item.direction,
      targetPrice: item.targetPrice,
      triggerPrice: currentPrice,
      triggerTs: nowTs,
      status: "sent",
    };
    pushAlertHistory(history);
    const text = `[Bitget Alert] ${item.symbol} (${item.productType}) hit ${fmtPriceFixed(currentPrice, 6)}. Target ${alertDirectionLabel(item.direction)} ${fmtPriceFixed(item.targetPrice, 6)}.`;
    sendTelegramAlertMessage(text).catch((err) => {
      history.status = `failed: ${err instanceof Error ? err.message : "send error"}`;
      renderAlerts();
      markStateDirty();
      savePersistentState();
    });
    markStateDirty();
    renderAlerts();
    savePersistentState();
    els.alertTargetPrice.value = "";
    return;
  }

  state.alerts.push(item);
  markStateDirty();
  renderAlerts();
  savePersistentState();
  els.alertTargetPrice.value = "";
}

function setAuthLockedUi(locked) {
  for (const panel of els.authRequiredPanels) {
    panel.style.display = locked ? "none" : "block";
  }
  els.authPanel.style.display = locked ? "block" : "none";
  els.userHeader.style.display = locked ? "none" : "flex";
  
  if (!locked && state.currentUser) {
    els.headerUsername.textContent = state.currentUser;
  }

  els.headerLogoutBtn.style.display = locked ? "none" : "inline-block";
  
  els.openPosition.disabled = locked;
  if (els.addAlertBtn) {
    els.addAlertBtn.disabled = locked;
  }
  els.resetAccount.disabled = locked || getEstimatedEquity() >= 100;
  els.fullReset.disabled = locked;
}

function renderAuthStatus(message = "") {
  if (state.currentUser) {
    els.authStatus.textContent = message || `Logged in as ${state.currentUser}.`;
  } else {
    els.authStatus.textContent = message || "Please login or register to start trading.";
  }
  setAuthLockedUi(!state.currentUser);
}

function applyLoggedInState(username, token, accountState) {
  state.currentUser = username;
  state.authToken = token;
  if (state.authMode === "guest") {
    saveGuestSession(username);
  } else {
    saveSession();
  }
  applyAccountPayload(accountState);
  state.isStateDirty = false;
  for (const pos of [...state.positions]) {
    recomputePosition(pos);
  }
  syncWsSubscriptions();
  renderPositions();
  renderClosed();
  renderAlerts();
  renderAccountStats();
  renderAuthStatus();
}

async function loginUser(username, password) {
  if (state.authMode === "guest") {
    const db = loadGuestAuthDb();
    const user = db.users[username];
    if (!user || user.password !== password) {
      throw new Error("Invalid username or password.");
    }
    applyLoggedInState(username, null, user.state || null);
    return;
  }
  const json = await authRequest("/api/auth/login", "POST", { username, password });
  applyLoggedInState(json.username, json.token, json.state);
}

async function logoutUser(message = "Logged out.") {
  if (state.authMode !== "guest") {
    try {
      if (state.authToken) {
        await authRequest("/api/auth/logout", "POST", {});
      }
    } catch (_) {
      // Ignore logout network errors and clear local session anyway.
    }
  }
  state.currentUser = null;
  state.authToken = null;
  state.isStateDirty = false;
  if (state.authMode === "guest") {
    saveGuestSession(null);
  } else {
    saveSession();
  }
  setDefaultAccountState();
  syncWsSubscriptions();
  renderPositions();
  renderClosed();
  renderAlerts();
  renderAccountStats();
  renderAuthStatus(message);
}

function renderPositions() {
  const body = state.positions
    .map((p) => {
      const pnlClass = p.unrealizedNet >= 0 ? "good" : "bad";
      const isEditing = state.editingTpSlId === p.id;
      const isCloseEditing = state.editingCloseId === p.id;
      const tpValue = p.tpPrice == null ? "" : p.tpPrice;
      const slValue = p.slPrice == null ? "" : p.slPrice;
      const tpSlCell = isEditing
        ? `<div class="tpsl-editor">
            <input class="tpsl-input" data-role="tp-input" data-id="${p.id}" type="number" step="any" placeholder="TP" value="${tpValue}" />
            <input class="tpsl-input" data-role="sl-input" data-id="${p.id}" type="number" step="any" placeholder="SL" value="${slValue}" />
            <button class="secondary" data-action="tpsl-save" data-id="${p.id}">Confirm</button>
            <button class="secondary" data-action="tpsl-cancel" data-id="${p.id}">Cancel</button>
            <div class="close-preview" data-role="tp-preview" data-id="${p.id}">${tpSlPreviewHtml("TP", p.tpPrice, p)}</div>
            <div class="close-preview" data-role="sl-preview" data-id="${p.id}">${tpSlPreviewHtml("SL", p.slPrice, p)}</div>
          </div>`
        : `<div class="tpsl-editor">
            <button class="secondary" data-action="tpsl-edit" data-id="${p.id}">${p.tpPrice || p.slPrice ? "Edit" : "TP/SL"}</button>
            ${(p.tpPrice != null || p.slPrice != null) ? `<button class="secondary" data-action="tpsl-clear" data-id="${p.id}">Cancel TP/SL</button>` : ""}
          </div>`;
      const closeCell = isCloseEditing
        ? (() => {
            const marketPrice = Number.isFinite(p.markPrice) ? p.markPrice : null;
            const marketPreview = closePreviewHtml("Market", marketPrice, p);
            const limitDraft = p.closeLimitPrice;
            const limitPreview = closePreviewHtml("Limit", limitDraft, p);
            return `<div class="tpsl-editor">
            <button class="danger" data-action="close-market" data-id="${p.id}">Market</button>
            <input class="tpsl-input" data-role="close-limit-input" data-id="${p.id}" type="number" step="any" placeholder="Limit price" value="${p.closeLimitPrice ?? ""}" />
            <button class="secondary" data-action="close-limit-save" data-id="${p.id}">Limit Confirm</button>
            <button class="secondary" data-action="close-cancel" data-id="${p.id}">Cancel</button>
            <div class="close-preview" data-role="close-market-preview" data-id="${p.id}">${marketPreview}</div>
            <div class="close-preview" data-role="close-limit-preview" data-id="${p.id}">${limitPreview}</div>
          </div>`;
          })()
        : `<div class="tpsl-editor">
            <button class="danger" data-action="close-edit" data-id="${p.id}">Close</button>
            ${p.closeLimitPrice != null ? `<span>Pending Lmt: ${fmtPriceFixed(p.closeLimitPrice, p.pricePrecision)}</span>` : ""}
            ${p.closeLimitPrice != null ? `<button class="secondary" data-action="close-limit-clear" data-id="${p.id}">Cancel Limit</button>` : ""}
          </div>`;
      return `
      <tr>
        <td>${p.id}</td>
        <td>${p.symbol}</td>
        <td>${p.side.toUpperCase()}</td>
        <td>${p.leverage}x</td>
        <td class="${pnlClass}">${fmt(p.unrealizedNet)}</td>
        <td class="${pnlClass}">${fmt(p.roe, 2)}</td>
        <td>${fmt(p.sizeUsdt)}</td>
        <td>${fmt(p.marginUsdt)}</td>
        <td>${fmt(p.mmrPct, 2)}</td>
        <td>${fmtPrice(p.entryPrice)}</td>
        <td>${fmtPrice(p.markPrice)}</td>
        <td>${fmtPriceFixed(p.liqPrice, p.pricePrecision)}</td>
        <td>${tpSlCell}</td>
        <td>${closeCell}</td>
      </tr>`;
    })
    .join("");

  els.positionsBody.innerHTML = body || `<tr><td colspan="14" style="text-align:center;">No open positions</td></tr>`;
}

function renderClosed() {
  const body = state.closed
    .slice()
    .reverse()
    .map(
      (p) => `<tr>
        <td>${p.id}</td>
        <td>${p.symbol}</td>
        <td>${p.side.toUpperCase()}</td>
        <td class="${p.realizedPnl >= 0 ? "good" : "bad"}">${fmt(p.realizedPnl)}</td>
        <td class="${p.roiPct >= 0 ? "good" : "bad"}">${fmt(p.roiPct, 2)}</td>
        <td>${fmtPrice(p.entryPrice)}</td>
        <td>${fmtPrice(p.exitPrice)}</td>
        <td>${fmtDateTime(p.openTs)}</td>
        <td>${fmtDateTime(p.closeTs)}</td>
      </tr>`
    )
    .join("");

  els.closedBody.innerHTML = body || `<tr><td colspan="8" style="text-align:center;">No closed positions</td></tr>`;
}

function recomputePosition(pos) {
  const ticker = getTicker(pos.productType, pos.symbol);
  if (!ticker || !Number.isFinite(ticker.markPrice) || ticker.markPrice <= 0) return;

  const now = Number.isFinite(ticker.ts) ? ticker.ts : Date.now();
  const dt = now - pos.lastFundingTs;
  if (dt > 0) {
    const directionFunding = pos.side === "long" ? 1 : -1;
    const incremental = pos.sizeUsdt * pos.fundingRate * (dt / FUNDING_INTERVAL_MS) * directionFunding;
    pos.fundingAccrued += incremental;
    pos.lastFundingTs = now;
  }

  const prevMark = Number.isFinite(pos.markPrice) ? pos.markPrice : ticker.markPrice;
  const prevTs = Number.isFinite(pos.lastMarkTs) ? pos.lastMarkTs : pos.lastFundingTs;
  const nextMark = ticker.markPrice;
  const nextTs = now;
  pos.markPrice = nextMark;
  const { net } = calcUnrealized(pos, pos.markPrice);
  pos.unrealizedNet = net;
  pos.roe = (net / pos.marginUsdt) * 100;
  pos.liqPrice = calcLiqPrice(pos, pos.markPrice);

  if (pos.closeLimitPrice != null) {
    const hitCloseLimit = didCrossThreshold(pos.side, prevMark, nextMark, pos.closeLimitPrice, "up")
      || ((pos.side === "long" && nextMark >= pos.closeLimitPrice) || (pos.side === "short" && nextMark <= pos.closeLimitPrice));
    if (hitCloseLimit) {
      const closeTs = estimateCrossTimestamp(prevMark, nextMark, prevTs, nextTs, pos.closeLimitPrice);
      closePosition(pos.id, "Limit Close", pos.closeLimitPrice, closeTs);
      return;
    }
  }

  const tpCross = pos.tpPrice != null && didCrossThreshold(pos.side, prevMark, nextMark, pos.tpPrice, "up");
  const slCross = pos.slPrice != null && didCrossThreshold(pos.side, prevMark, nextMark, pos.slPrice, "down");
  const tpNow = pos.tpPrice != null && ((pos.side === "long" && nextMark >= pos.tpPrice) || (pos.side === "short" && nextMark <= pos.tpPrice));
  const slNow = pos.slPrice != null && ((pos.side === "long" && nextMark <= pos.slPrice) || (pos.side === "short" && nextMark >= pos.slPrice));

  if (tpCross || slCross || tpNow || slNow) {
    const reason = (tpCross || tpNow) ? "TP" : "SL";
    const triggerPrice = reason === "TP" ? pos.tpPrice : pos.slPrice;
    const closeTs = estimateCrossTimestamp(prevMark, nextMark, prevTs, nextTs, triggerPrice);
    closePosition(pos.id, reason, null, closeTs);
    return;
  }

  const liqCross = didCrossThreshold(pos.side, prevMark, nextMark, pos.liqPrice, "down");
  const liquidated = liqCross || ((pos.side === "long" && nextMark <= pos.liqPrice) || (pos.side === "short" && nextMark >= pos.liqPrice));
  if (liquidated) {
    const closeTs = estimateCrossTimestamp(prevMark, nextMark, prevTs, nextTs, pos.liqPrice);
    closePosition(pos.id, "Liq", null, closeTs);
    return;
  }
  pos.lastMarkTs = nextTs;
}

function closePosition(id, reason = "Manual", exitPriceOverride = null, closeTsOverride = null) {
  const idx = state.positions.findIndex((p) => p.id === id);
  if (idx === -1) return;

  const pos = state.positions[idx];
  const ticker = getTicker(pos.productType, pos.symbol);
  const exitPrice = Number.isFinite(exitPriceOverride) ? Number(exitPriceOverride) : (ticker?.markPrice ?? pos.markPrice ?? pos.entryPrice);
  const dir = pos.side === "long" ? 1 : -1;
  const gross = dir * ((exitPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeUsdt;
  const closeFee = pos.sizeUsdt * pos.takerFeeRate;
  const realized = gross - pos.openFee - closeFee - pos.fundingAccrued;

  state.realizedPnl += realized;
  state.closed.push({
    ...pos,
    exitPrice,
    realizedPnl: realized,
    roiPct: pos.marginUsdt > 0 ? (realized / pos.marginUsdt) * 100 : 0,
    closeTs: Number.isFinite(closeTsOverride) ? Number(closeTsOverride) : Date.now(),
    closeReason: reason,
  });
  state.positions.splice(idx, 1);
  markStateDirty();
  if (state.editingTpSlId === id) {
    state.editingTpSlId = null;
  }
  if (state.editingCloseId === id) {
    state.editingCloseId = null;
  }
  syncWsSubscriptions();

  renderPositions();
  renderClosed();
  renderAccountStats();
  savePersistentState();
}

async function openPosition() {
  if (!state.currentUser) {
    alert("Please login first.");
    return;
  }
  const productType = els.productType.value;
  const symbol = (els.symbol.value || "").trim().toUpperCase();
  const side = els.side.value;
  const leverageInput = Number(els.leverage.value);
  const sizeUsdt = Number(els.sizeUsdt.value);

  if (!symbol) {
    alert("Select a symbol");
    return;
  }
  if (!Number.isFinite(sizeUsdt) || sizeUsdt <= 0) {
    alert("Size must be positive");
    return;
  }

  const contract = state.contractsByProduct.get(productType)?.get(symbol);
  if (!contract) {
    alert("Invalid symbol for selected product type");
    return;
  }
  const ticker = getTicker(productType, symbol);
  if (!ticker || !Number.isFinite(ticker.markPrice) || ticker.markPrice <= 0) {
    alert("No valid mark price for this symbol right now");
    return;
  }

  const minLev = Math.max(1, Math.floor(contract?.minLeverage ?? 1));
  const maxLev = Math.min(100, Math.floor(contract?.maxLeverage ?? 100));
  const leverage = clamp(Math.floor(leverageInput || 1), minLev, maxLev);
  els.leverage.value = String(leverage);

  const marginUsdt = sizeUsdt / leverage;
  const fundingRate = Number.isFinite(ticker.fundingRate)
    ? ticker.fundingRate
    : await getFundingRate(productType, symbol);
  const makerFeeRate = contract?.makerFeeRate ?? DEFAULT_MAKER_FEE;
  const takerFeeRate = contract?.takerFeeRate ?? DEFAULT_TAKER_FEE;
  const openFee = sizeUsdt * takerFeeRate;

  const pos = {
    id: state.nextId++,
    productType,
    symbol,
    side,
    leverage,
    sizeUsdt,
    marginUsdt,
    entryPrice: ticker.markPrice,
    markPrice: ticker.markPrice,
    fundingRate,
    fundingAccrued: 0,
    lastFundingTs: Number.isFinite(ticker.ts) ? ticker.ts : Date.now(),
    lastMarkTs: Number.isFinite(ticker.ts) ? ticker.ts : Date.now(),
    makerFeeRate,
    takerFeeRate,
    openFee,
    mmrPct: estimateMMR(leverage, contract?.mmr),
    pricePrecision: getSymbolPricePrecision(productType, symbol),
    liqPrice: 0,
    unrealizedNet: 0,
    roe: 0,
    tpPrice: null,
    slPrice: null,
    closeLimitPrice: null,
    openTs: Date.now(),
  };

  recomputePosition(pos);
  state.positions.push(pos);
  markStateDirty();
  syncWsSubscriptions();
  renderPositions();
  renderAccountStats();
  savePersistentState();
}

function saveTpSl(id) {
  const pos = state.positions.find((p) => p.id === id);
  if (!pos) return;
  const tpEl = els.positionsBody.querySelector(`input[data-role="tp-input"][data-id="${id}"]`);
  const slEl = els.positionsBody.querySelector(`input[data-role="sl-input"][data-id="${id}"]`);
  if (!(tpEl instanceof HTMLInputElement) || !(slEl instanceof HTMLInputElement)) return;

  const tp = tpEl.value.trim() === "" ? null : Number(tpEl.value);
  const sl = slEl.value.trim() === "" ? null : Number(slEl.value);

  if (tp !== null && (!Number.isFinite(tp) || tp <= 0)) {
    alert("TP must be a positive number or blank");
    return;
  }
  if (sl !== null && (!Number.isFinite(sl) || sl <= 0)) {
    alert("SL must be a positive number or blank");
    return;
  }

  if (Number.isFinite(pos.markPrice)) {
    if (pos.side === "long") {
      if (tp !== null && tp <= pos.markPrice) {
        alert("For LONG, TP must be above current mark price.");
        return;
      }
      if (sl !== null && sl >= pos.markPrice) {
        alert("For LONG, SL must be below current mark price.");
        return;
      }
    } else {
      if (tp !== null && tp >= pos.markPrice) {
        alert("For SHORT, TP must be below current mark price.");
        return;
      }
      if (sl !== null && sl <= pos.markPrice) {
        alert("For SHORT, SL must be above current mark price.");
        return;
      }
    }
  }

  pos.tpPrice = tp;
  pos.slPrice = sl;
  markStateDirty();
  state.editingTpSlId = null;
  renderPositions();
  savePersistentState();
}

function saveCloseLimit(id) {
  const pos = state.positions.find((p) => p.id === id);
  if (!pos) return;
  const limitEl = els.positionsBody.querySelector(`input[data-role="close-limit-input"][data-id="${id}"]`);
  if (!(limitEl instanceof HTMLInputElement)) return;

  const limit = limitEl.value.trim() === "" ? null : Number(limitEl.value);
  if (limit === null || !Number.isFinite(limit) || limit <= 0) {
    alert("Limit close price must be a positive number.");
    return;
  }

  // If limit is marketable, execute immediate market close as requested.
  if ((pos.side === "long" && limit <= pos.markPrice) || (pos.side === "short" && limit >= pos.markPrice)) {
    closePosition(id, "Market Close (Marketable Limit)");
    return;
  }

  pos.closeLimitPrice = limit;
  markStateDirty();
  state.editingCloseId = null;
  renderPositions();
  savePersistentState();
}

function updateCloseLimitPreview(id, rawInput) {
  const pos = state.positions.find((p) => p.id === id);
  if (!pos) return;
  const limitPreviewEl = els.positionsBody.querySelector(`div[data-role="close-limit-preview"][data-id="${id}"]`);
  if (!(limitPreviewEl instanceof HTMLElement)) return;
  const limitPrice = rawInput.trim() === "" ? null : Number(rawInput);
  limitPreviewEl.innerHTML = closePreviewHtml("Limit", limitPrice, pos);
}

function updateTpSlPreview(id, role, rawInput) {
  const pos = state.positions.find((p) => p.id === id);
  if (!pos) return;
  if (role === "tp-input") {
    const tpEl = els.positionsBody.querySelector(`div[data-role="tp-preview"][data-id="${id}"]`);
    if (!(tpEl instanceof HTMLElement)) return;
    const price = rawInput.trim() === "" ? null : Number(rawInput);
    tpEl.innerHTML = tpSlPreviewHtml("TP", price, pos);
    return;
  }
  if (role === "sl-input") {
    const slEl = els.positionsBody.querySelector(`div[data-role="sl-preview"][data-id="${id}"]`);
    if (!(slEl instanceof HTMLElement)) return;
    const price = rawInput.trim() === "" ? null : Number(rawInput);
    slEl.innerHTML = tpSlPreviewHtml("SL", price, pos);
  }
}

function bindEvents() {
  window.__dtAppBound = true;
  els.registerBtn.addEventListener("click", async () => {
    renderAuthStatus("Registering...");
    const username = (els.authUsername.value || "").trim();
    const password = els.authPassword.value || "";
    if (!username || !password) {
      renderAuthStatus("Username and password are required.");
      return;
    }
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      renderAuthStatus("Username must be 3-32 chars: letters, numbers, _, ., -");
      return;
    }
    if (password.length < 6) {
      renderAuthStatus("Password must be at least 6 characters.");
      return;
    }
    try {
      if (state.authMode === "guest") {
        const db = loadGuestAuthDb();
        if (db.users[username]) {
          throw new Error("Username already exists.");
        }
        const legacy = getLegacyGuestStateForMigration();
        const canMigrateLegacy =
          legacy &&
          !hasLegacyServerMigrationDone() &&
          username === LEGACY_MIGRATION_TARGET_USER;
        db.users[username] = {
          password,
          state: canMigrateLegacy ? legacy : getDefaultAccountPayload(),
        };
        saveGuestAuthDb(db);
        applyLoggedInState(username, null, db.users[username].state);
        if (canMigrateLegacy) {
          clearLegacyGuestState();
          markLegacyServerMigrationDone();
          markStateDirty();
          savePersistentState();
        }
      } else {
        const json = await authRequest("/api/auth/register", "POST", { username, password });
        applyLoggedInState(json.username, json.token, json.state);
        const legacy = getLegacyGuestStateForMigration();
        if (
          legacy &&
          !hasLegacyServerMigrationDone() &&
          username === LEGACY_MIGRATION_TARGET_USER &&
          isStateEmpty(json.state)
        ) {
          applyAccountPayload(legacy);
          markStateDirty();
          renderPositions();
          renderClosed();
          renderAccountStats();
          await savePersistentState();
          clearLegacyGuestState();
          markLegacyServerMigrationDone();
        }
      }
      renderAuthStatus(`Registered and logged in as ${username}.`);
    } catch (err) {
      renderAuthStatus(err instanceof Error ? err.message : "Registration failed.");
    }
    els.authPassword.value = "";
  });

  els.loginBtn.addEventListener("click", async () => {
    renderAuthStatus("Logging in...");
    const username = (els.authUsername.value || "").trim();
    const password = els.authPassword.value || "";
    if (!username || !password) {
      renderAuthStatus("Username and password are required.");
      return;
    }
    try {
      await loginUser(username, password);
      const legacy = getLegacyGuestStateForMigration();
      if (
        state.authMode !== "guest" &&
        legacy &&
        !hasLegacyServerMigrationDone() &&
        username === LEGACY_MIGRATION_TARGET_USER &&
        isStateEmpty(getAccountPayload())
      ) {
        applyAccountPayload(legacy);
        markStateDirty();
        renderPositions();
        renderClosed();
        renderAccountStats();
        await savePersistentState();
        clearLegacyGuestState();
        markLegacyServerMigrationDone();
      }
      renderAuthStatus(`Logged in as ${username}.`);
    } catch (err) {
      renderAuthStatus(err instanceof Error ? err.message : "Invalid username or password.");
    }
    els.authPassword.value = "";
  });

  const handleAuthEnter = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    els.loginBtn.click();
  };
  els.authUsername.addEventListener("keydown", handleAuthEnter);
  els.authPassword.addEventListener("keydown", handleAuthEnter);

  els.headerLogoutBtn.addEventListener("click", async () => {
    await logoutUser();
  });

  els.productType.addEventListener("change", async () => {
    const productType = els.productType.value;
    if (!state.contractsByProduct.has(productType)) {
      try {
        await loadContracts(productType);
      } catch (_) {
        ensureFallbackContracts(productType);
      }
    }
    if (!state.tickersByProduct.has(productType)) {
      try {
        await loadTickers(productType);
      } catch (_) {
        // Ignore transient or CORS failures.
      }
    }
    renderSymbols();
    syncWsSubscriptions();
  });

  els.symbol.addEventListener("change", () => {
    renderMarketStats();
    syncWsSubscriptions();
  });
  els.symbol.addEventListener("input", () => {
    renderMarketStats();
    syncWsSubscriptions();
  });

  els.openPosition.addEventListener("click", () => {
    openPosition().catch((err) => {
      console.error(err);
      alert("Failed to open position");
    });
  });

  if (els.addAlertBtn) {
    els.addAlertBtn.addEventListener("click", () => {
      createPriceAlert();
    });
  }

  els.positionsBody.addEventListener("click", (evt) => {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    const id = Number(target.dataset.id);
    if (!action || !id) return;

    if (action === "tpsl-edit") {
      state.editingTpSlId = id;
      state.editingCloseId = null;
      renderPositions();
      return;
    }
    if (action === "tpsl-cancel") {
      state.editingTpSlId = null;
      renderPositions();
      return;
    }
    if (action === "tpsl-save") {
      saveTpSl(id);
      return;
    }
    if (action === "tpsl-clear") {
      const pos = state.positions.find((p) => p.id === id);
      if (!pos) return;
      pos.tpPrice = null;
      pos.slPrice = null;
      markStateDirty();
      state.editingTpSlId = null;
      renderPositions();
      savePersistentState();
      return;
    }
    if (action === "close-edit") {
      state.editingCloseId = id;
      state.editingTpSlId = null;
      renderPositions();
      return;
    }
    if (action === "close-cancel") {
      state.editingCloseId = null;
      renderPositions();
      return;
    }
    if (action === "close-market") {
      closePosition(id, "Market Close");
      return;
    }
    if (action === "close-limit-save") {
      saveCloseLimit(id);
      return;
    }
    if (action === "close-limit-clear") {
      const pos = state.positions.find((p) => p.id === id);
      if (!pos) return;
      pos.closeLimitPrice = null;
      markStateDirty();
      state.editingCloseId = null;
      renderPositions();
      savePersistentState();
    }
  });

  els.positionsBody.addEventListener("input", (evt) => {
    const target = evt.target;
    if (!(target instanceof HTMLInputElement)) return;
    const role = target.dataset.role;
    if (role !== "close-limit-input" && role !== "tp-input" && role !== "sl-input") return;
    const id = Number(target.dataset.id);
    if (!id) return;
    if (role === "close-limit-input") {
      updateCloseLimitPreview(id, target.value);
      return;
    }
    updateTpSlPreview(id, role, target.value);
  });

  if (els.activeAlerts) {
    els.activeAlerts.addEventListener("click", (evt) => {
      const target = evt.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.action !== "alert-remove") return;
      const id = Number(target.dataset.id);
      if (!id) return;
      const before = state.alerts.length;
      state.alerts = state.alerts.filter((a) => a.id !== id);
      if (state.alerts.length !== before) {
        markStateDirty();
        renderAlerts();
        savePersistentState();
      }
    });
  }

  els.resetAccount.addEventListener("click", () => {
    if (!state.currentUser) {
      alert("Please login first.");
      return;
    }
    const equity = getEstimatedEquity();
    if (equity >= 100) {
      alert("Reset is available only when estimated equity is below 100 USDT.");
      return;
    }
    const ok = confirm("Reset account and re-deposit 1,000 USDT? This closes all current progress.");
    if (!ok) return;

    state.positions = [];
    state.closed = [];
    state.realizedPnl = 0;
    state.equityStart = 1000;
    state.nextId = 1;
    state.editingTpSlId = null;
    state.editingCloseId = null;
    markStateDirty();
    syncWsSubscriptions();

    renderPositions();
    renderClosed();
    renderAccountStats();
    savePersistentState();
  });

  els.fullReset.addEventListener("click", () => {
    if (!state.currentUser) {
      alert("Please login first.");
      return;
    }
    const ok = confirm("Full reset will clear balance, open positions, closed history, and saved state. Continue?");
    if (!ok) return;
    fullResetAll();
  });
}

async function refreshMarket() {
  const productTypes = new Set([els.productType.value]);
  for (const pos of state.positions) {
    productTypes.add(pos.productType);
  }

  await Promise.all(
    [...productTypes].map(async (p) => {
      try {
        await loadTickers(p);
      } catch (_) {
        // Ignore transient market fetch issues.
      }
    })
  );

  for (const pos of [...state.positions]) {
    recomputePosition(pos);
  }

  if (!isInlineEditing()) {
    renderPositions();
  }
  renderMarketStats();
  renderAccountStats();
}

async function init() {
  bindEvents();
  const isLocalHost = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  if (isLocalHost) {
    clearGuestLocalAuthArtifacts();
  }
  try {
    await loadContracts("USDT-FUTURES");
  } catch (_) {
    ensureFallbackContracts("USDT-FUTURES");
  }
  try {
    await loadTickers("USDT-FUTURES");
  } catch (_) {
    // Keep running; websocket and periodic refresh can still recover data.
  }

  const authApiReady = await hasWorkingAuthApi();
  state.authMode = "server";
  const session = loadSession();
  if (session && authApiReady) {
    state.authToken = session.token;
    try {
      const me = await authRequest("/api/auth/me", "GET");
      state.currentUser = me.username;
      els.authUsername.value = me.username;
      applyAccountPayload(me.state);
      for (const pos of [...state.positions]) {
        recomputePosition(pos);
      }
      renderAuthStatus(`Session restored for ${me.username}.`);
    } catch (_) {
      state.currentUser = null;
      state.authToken = null;
      saveSession();
      setDefaultAccountState();
      renderAuthStatus("Not logged in. Login or register to start trading.");
    }
  } else {
    state.currentUser = null;
    state.authToken = null;
    saveSession();
    setDefaultAccountState();
    if (!authApiReady && isLocalHost) {
      renderAuthStatus("Local server auth API is unavailable. Start server.py and open http://127.0.0.1:8000");
    } else if (!authApiReady) {
      renderAuthStatus("Server auth API is unavailable. Check Cloudflare Pages Functions + BITGET_DEMO_KV binding.");
    } else {
      renderAuthStatus("Not logged in. Login or register to start trading.");
    }
  }

  renderSymbols();
  renderPositions();
  renderClosed();
  renderAlerts();
  renderAccountStats();
  connectMarketWs();
  syncWsSubscriptions();

  setInterval(() => {
    refreshMarket().catch((err) => console.error("refresh failed", err));
  }, REST_FALLBACK_INTERVAL_MS);

  setInterval(() => {
    const now = Date.now();
    const last = Number.isFinite(state.lastMarketUpdateTs) ? state.lastMarketUpdateTs : 0;
    if (now - last > STALE_MARKET_RELOAD_MS) {
      refreshMarket().catch((err) => console.error("stale refresh failed", err));
    }
  }, STALE_CHECK_INTERVAL_MS);

  setInterval(() => {
    for (const pos of [...state.positions]) {
      recomputePosition(pos);
    }
    if (!isInlineEditing()) {
      renderPositions();
    }
    renderAccountStats();
  }, RECOMPUTE_INTERVAL_MS);

  setInterval(() => {
    savePersistentState();
  }, STATE_SAVE_INTERVAL_MS);

  setInterval(() => {
    pullPersistentStateIfClean();
  }, ACCOUNT_PULL_INTERVAL_MS);
}

init().catch((err) => {
  console.error(err);
  alert("Initialization failed. Make sure the local server is running and Bitget API is reachable.");
});
