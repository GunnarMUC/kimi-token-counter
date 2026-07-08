#!/usr/bin/env node
/**
 * kimi-token-counter — Zero-dependency Kimi API token usage tracker & dashboard.
 *
 * Usage:
 *   node kimi-token-counter.js                     # Live dashboard
 *   node kimi-token-counter.js --once              # Snapshot, then exit
 *   node kimi-token-counter.js mark start "label"  # Start a span
 *   node kimi-token-counter.js mark end            # End current span
 *   node kimi-token-counter.js mark list           # List recent spans
 *   node kimi-token-counter.js mark status         # Show active span
 *   node kimi-token-counter.js mark cancel         # Cancel active span
 *
 * Wrapper modes (used inside your app):
 *   import { kimiFetch } from './kimi-token-counter.js';
 *   import { wrapOpenAIClient } from './kimi-token-counter.js';
 *
 * Apache 2.0 — Copyright 2026 Gunnar Mueller
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

// ────────────────────────────────────────────────────────
// 1. PRICE TABLE
//    All prices in USD per 1,000,000 tokens.
//    Update this table when Kimi pricing changes.
// ────────────────────────────────────────────────────────

const PRICE_TABLE = {
  "kimi-k2-7-code":  { input: 0.95, cache_hit: 0.19, output: 4.00, batch_input: 0.57, batch_output: 2.40 },
  "kimi-k2.7-code": { input: 0.95, cache_hit: 0.19, output: 4.00, batch_input: 0.57, batch_output: 2.40 },
  "kimi-k2-6":      { input: 0.95, cache_hit: 0.16, output: 4.00, batch_input: 0.57, batch_output: 2.40 },
  "kimi-k2.6":      { input: 0.95, cache_hit: 0.16, output: 4.00, batch_input: 0.57, batch_output: 2.40 },
  "kimi-k2-5":      { input: 0.60, cache_hit: 0.10, output: 3.00, batch_input: null, batch_output: null },
  "kimi-k2.5":      { input: 0.60, cache_hit: 0.10, output: 3.00, batch_input: null, batch_output: null },
};

// Web search surcharge per call
const WEB_SEARCH_COST = 0.005;

// ────────────────────────────────────────────────────────
// 2. CONFIGURATION (environment-variable overrides)
// ────────────────────────────────────────────────────────

const CONFIG = {
  baseDir:   process.env.KTC_DIR        || path.join(require("os").homedir(), ".kimi-token-counter"),
  session:   process.env.KTC_SESSION    || randomUUID().slice(0, 8),
  project:   process.env.KTC_PROJECT    || "default",
  noColor:   !!process.env.NO_COLOR,
};

// ────────────────────────────────────────────────────────
// 3. HELPER FUNCTIONS
// ────────────────────────────────────────────────────────

function fmtUSD(cents) { return `$${(cents).toFixed(2)}`; }
function padR(s, n) { return s.padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }
function ts() { return new Date().toISOString(); }
function tsShort() { return new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function dateStr() { return new Date().toISOString().slice(0, 10); }

function logDir() {
  const d = path.join(CONFIG.baseDir, "logs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ────────────────────────────────────────────────────────
// 4. PRICE LOOKUP
// ────────────────────────────────────────────────────────

function getPricing(model) {
  model = model.toLowerCase();
  for (const [key, prices] of Object.entries(PRICE_TABLE)) {
    if (model.includes(key)) return prices;
  }
  return null; // unknown model → no cost data
}

function computeCost(model, usage) {
  const prices = getPricing(model);
  if (!prices) return { cost: 0, unknown: true };

  const inputToks = usage.prompt_tokens || usage.input_tokens || 0;
  const outputToks = usage.completion_tokens || usage.output_tokens || 0;
  const totalToks = usage.total_tokens || (inputToks + outputToks);
  const cachedToks = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  const uncachedToks = Math.max(0, inputToks - cachedToks);

  const cost = (uncachedToks * prices.input + cachedToks * prices.cache_hit + outputToks * prices.output) / 1_000_000;

  return {
    cost,
    uncachedToks,
    cachedToks,
    totalToks,
    inputToks,
    outputToks,
    unknown: false,
  };
}

// ────────────────────────────────────────────────────────
// 5. JSONL LOGGER
// ────────────────────────────────────────────────────────

async function appendLog(requestId, model, usage, metadata = {}) {
  const calc = computeCost(model, usage);
  const entry = {
    timestamp: ts(),
    session_id: CONFIG.session,
    model: model,
    request_id: requestId,
    usage: {
      input_tokens: calc.inputToks,
      output_tokens: calc.outputToks,
      total_tokens: calc.totalToks,
      cached_tokens: calc.cachedToks,
      uncached_input_tokens: calc.uncachedToks,
    },
    cost_usd: parseFloat(calc.cost.toFixed(6)),
    metadata: {
      project: CONFIG.project,
      span_label: metadata.spanLabel || "",
    },
  };

  const dir = logDir();

  // Daily log
  const dailyFile = path.join(dir, `daily-${dateStr()}.jsonl`);
  await fsp.appendFile(dailyFile, JSON.stringify(entry) + "\n");

  // Session log
  const sessionFile = path.join(dir, `session-${CONFIG.session}.jsonl`);
  await fsp.appendFile(sessionFile, JSON.stringify(entry) + "\n");

  return entry;
}

// ────────────────────────────────────────────────────────
// 6. SPAN MARKER SYSTEM
// ────────────────────────────────────────────────────────

const MARKERS_FILE = path.join(CONFIG.baseDir, "markers.json");
const MARKERS_LOG  = path.join(logDir(), "markers.log");
const MARKERS_JSONL = path.join(logDir(), "markers.jsonl");

function readMarkers() {
  try {
    return JSON.parse(fs.readFileSync(MARKERS_FILE, "utf8"));
  } catch {
    return { active: null, history: [] };
  }
}

function writeMarkers(data) {
  fs.mkdirSync(path.dirname(MARKERS_FILE), { recursive: true });
  fs.writeFileSync(MARKERS_FILE, JSON.stringify(data, null, 2));
}

function spanStart(label) {
  const markers = readMarkers();
  if (markers.active) return `Already have active span: "${markers.active.label}" — end it first (mark end).`;

  const span = { label, start: ts(), start_short: tsShort() };
  markers.active = span;
  markers.history.unshift(span);
  writeMarkers(markers);

  const logLine = `${tsShort()}  ${label}  STARTED\n`;
  fs.appendFileSync(MARKERS_LOG, logLine);
  fs.appendFileSync(MARKERS_JSONL, JSON.stringify({ type: "start", ...span }) + "\n");

  return `Span started: "${label}" at ${tsShort()}`;
}

function spanEnd() {
  const markers = readMarkers();
  if (!markers.active) return "No active span. Start one first: mark start \"label\"";

  const span = markers.active;
  const entries = loadEntriesBetween(span.start, ts());

  // Aggregate
  let inToks = 0, outToks = 0, cachedToks = 0, totalToks = 0, cost = 0, requests = 0;
  const models = new Map();
  for (const e of entries) {
    inToks += e.usage.input_tokens;
    outToks += e.usage.output_tokens;
    cachedToks += e.usage.cached_tokens;
    totalToks += e.usage.total_tokens;
    cost += e.cost_usd;
    requests++;

    const m = models.get(e.model) || { input: 0, output: 0, cached: 0, cost: 0, requests: 0 };
    m.input += e.usage.input_tokens;
    m.output += e.usage.output_tokens;
    m.cached += e.usage.cached_tokens;
    m.cost += e.cost_usd;
    m.requests++;
    models.set(e.model, m);
  }

  const startD = new Date(span.start);
  const endD = new Date();
  const durationMs = endD - startD;
  const mins = Math.floor(durationMs / 60000);
  const secs = Math.floor((durationMs % 60000) / 1000);
  const durStr = `${mins}m ${secs}s`;

  const logLine = `${tsShort()}  ${span.label}  ${durStr}  (${span.start_short}→${tsShort()})  in=${inToks.toLocaleString()} out=${outToks.toLocaleString()} cached=${cachedToks.toLocaleString()}  total=${totalToks.toLocaleString()}  cost=${fmtUSD(cost)}  requests=${requests}  sessions=1\n`;
  fs.appendFileSync(MARKERS_LOG, logLine);

  const markerEntry = {
    type: "end",
    label: span.label,
    start: span.start,
    end: ts(),
    duration_ms: durationMs,
    input_tokens: inToks,
    output_tokens: outToks,
    cached_tokens: cachedToks,
    total_tokens: totalToks,
    cost_usd: parseFloat(cost.toFixed(6)),
    requests,
  };
  fs.appendFileSync(MARKERS_JSONL, JSON.stringify(markerEntry) + "\n");

  markers.active = null;
  markers.history[0] = { ...markers.history[0], end: ts(), duration_ms: durationMs, tokens: totalToks, cost: parseFloat(cost.toFixed(4)), requests };
  writeMarkers(markers);

  return `Span ended: "${span.label}"  ${durStr}  ${totalToks.toLocaleString()} tokens  ${fmtUSD(cost)}  ${requests} requests`;
}

function spanStatus() {
  const markers = readMarkers();
  if (!markers.active) return "No active span.";
  const s = markers.active;
  const durMs = Date.now() - new Date(s.start).getTime();
  const mins = Math.floor(durMs / 60000);
  const secs = Math.floor((durMs % 60000) / 1000);
  return `Active span: "${s.label}"  since ${s.start_short}  (${mins}m ${secs}s ago)`;
}

function spanList() {
  const markers = readMarkers();
  if (!markers.history.length) return "No spans recorded.";
  return markers.history.slice(0, 20).map((s, i) => {
    const label = s.label || "(unnamed)";
    const dur = s.duration_ms ? `${Math.floor(s.duration_ms / 60000)}m` : "active";
    const tok = s.tokens ? `${s.tokens.toLocaleString()}t` : "-";
    const cst = s.cost !== undefined ? fmtUSD(s.cost) : "-";
    return `${i + 1}. ${label}  ${dur}  ${tok}  ${cst}`;
  }).join("\n");
}

function spanCancel() {
  const markers = readMarkers();
  if (!markers.active) return "No active span to cancel.";
  const label = markers.active.label;
  markers.active = null;
  markers.history.shift(); // remove from history
  writeMarkers(markers);
  return `Span cancelled: "${label}"`;
}

// ────────────────────────────────────────────────────────
// 7. ENTRY LOADING (for dashboard aggregation)
// ────────────────────────────────────────────────────────

function loadEntriesBetween(start, end) {
  const entries = [];
  const dir = logDir();
  const startDate = start.slice(0, 10);
  const endDate = (end || ts()).slice(0, 10);

  let current = new Date(startDate);
  const endD = new Date(endDate);
  while (current <= endD) {
    const f = path.join(dir, `daily-${current.toISOString().slice(0, 10)}.jsonl`);
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.timestamp >= start && e.timestamp <= end) entries.push(e);
        } catch {}
      }
    }
    current.setDate(current.getDate() + 1);
  }
  return entries;
}

function loadAllEntries() {
  const entries = [];
  const dir = logDir();
  if (!fs.existsSync(dir)) return entries;
  for (const fname of fs.readdirSync(dir)) {
    if (fname.startsWith("daily-") && fname.endsWith(".jsonl")) {
      const lines = fs.readFileSync(path.join(dir, fname), "utf8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch {}
      }
    }
  }
  return entries;
}

// ────────────────────────────────────────────────────────
// 8. LIVE TERMINAL DASHBOARD
// ────────────────────────────────────────────────────────

function dashboard(once = false) {
  const { clear, moveTo, getSize } = createTerminal();

  let running = true;
  let redrawScheduled = false;

  function scheduleRedraw() {
    if (redrawScheduled) return;
    redrawScheduled = true;
    setImmediate(() => {
      redrawScheduled = false;
      if (running) render();
    });
  }

  function render() {
    const size = getSize();
    const width = Math.min(size.columns || 120, 120);
    const now = new Date();
    const today = dateStr();

    const allEntries = loadAllEntries();
    const todayEntries = allEntries.filter(e => e.timestamp.startsWith(today));

    // Aggregations
    function agg(list) {
      let inToks = 0, outToks = 0, cachedToks = 0, totalToks = 0, cost = 0, requests = 0;
      const models = new Map();
      for (const e of list) {
        inToks += e.usage.input_tokens;
        outToks += e.usage.output_tokens;
        cachedToks += e.usage.cached_tokens;
        totalToks += e.usage.total_tokens;
        cost += e.cost_usd;
        requests++;
        const m = models.get(e.model) || { input: 0, output: 0, cached: 0, cost: 0, requests: 0 };
        m.input += e.usage.input_tokens;
        m.output += e.usage.output_tokens;
        m.cached += e.usage.cached_tokens;
        m.cost += e.cost_usd;
        m.requests++;
        models.set(e.model, m);
      }
      return { inToks, outToks, cachedToks, totalToks, cost, requests, models, count: list.length };
    }

    const todayAgg = agg(todayEntries);
    const allAgg = agg(allEntries);

    // Active span
    const markers = readMarkers();
    const activeSpan = markers.active;

    // Build output
    const lines = [];

    // Header
    lines.push(" Kimi Token Tracker" + " ".repeat(Math.max(0, width - 50)) + tsShort());
    lines.push("─".repeat(width));

    // Active span
    if (activeSpan) {
      const durMs = Date.now() - new Date(activeSpan.start).getTime();
      const mins = Math.floor(durMs / 60000);
      const secs = Math.floor((durMs % 60000) / 1000);
      const spanEntries = loadEntriesBetween(activeSpan.start, ts());
      const spanAgg = agg(spanEntries);
      lines.push(` ▶ SPAN ${activeSpan.label}  since ${activeSpan.start_short}  (${mins}m ${secs}s)`);
      lines.push(`   in ${spanAgg.inToks.toLocaleString()}  out ${spanAgg.outToks.toLocaleString()}  cached ${spanAgg.cachedToks.toLocaleString()}`);
      lines.push(`   tokens ${spanAgg.totalToks.toLocaleString()}   requests ${spanAgg.count}   cost ${fmtUSD(spanAgg.cost)}`);
      lines.push("");
    }

    // Current session
    lines.push(` CURRENT SESSION  ·  ${CONFIG.project}  ·  ${CONFIG.session.slice(0, 8)}   ● live`);
    const sessionAgg = agg(allEntries.filter(e => e.session_id === CONFIG.session));
    lines.push(`   in ${sessionAgg.inToks.toLocaleString()}   out ${sessionAgg.outToks.toLocaleString()}   cached ${sessionAgg.cachedToks.toLocaleString()}`);
    lines.push(`   requests ${sessionAgg.count}   updated just now   cost ${fmtUSD(sessionAgg.cost)}`);
    lines.push("");

    // Today
    lines.push(` TODAY  ${today}   tokens ${todayAgg.totalToks.toLocaleString()}   requests ${todayAgg.count}   cost ${fmtUSD(todayAgg.cost)}`);
    lines.push(`   ${padR("model", 25)} ${padL("input", 10)} ${padL("output", 8)} ${padL("cached", 9)} ${padL("cost", 8)}`);
    for (const [model, m] of todayAgg.models) {
      lines.push(`   ${padR(model, 25)} ${padL(m.input.toLocaleString(), 10)} ${padL(m.output.toLocaleString(), 8)} ${padL(m.cached.toLocaleString(), 9)} ${padL(fmtUSD(m.cost), 8)}`);
    }
    lines.push("");

    // All time
    lines.push(` ALL TIME   tokens ${allAgg.totalToks.toLocaleString()}   requests ${allAgg.count}   cost ${fmtUSD(allAgg.cost)}`);
    lines.push(`   ${padR("model", 25)} ${padL("input", 10)} ${padL("output", 8)} ${padL("cached", 9)} ${padL("cost", 8)}`);
    for (const [model, m] of allAgg.models) {
      lines.push(`   ${padR(model, 25)} ${padL(m.input.toLocaleString(), 10)} ${padL(m.output.toLocaleString(), 8)} ${padL(m.cached.toLocaleString(), 9)} ${padL(fmtUSD(m.cost), 8)}`);
    }
    lines.push("");

    // Recent (last 5)
    const recent = allEntries.slice(-5).reverse();
    lines.push(" RECENT");
    for (const e of recent) {
      const time = e.timestamp.slice(11, 19);
      lines.push(`   ${time}  ${padR(e.model, 20)} in ${e.usage.input_tokens}  out ${e.usage.output_tokens}  cached ${e.usage.cached_tokens}  ${fmtUSD(e.cost_usd)}`);
    }

    // Footer
    lines.push("─".repeat(width));
    lines.push(` ${allEntries.length} entries · ${new Set(allEntries.map(e => e.metadata.project)).size} projects · log:daily · keys m span  q quit`);

    // Render
    clear();
    process.stdout.write(lines.join("\n") + "\n");
  }

  // Watch for file changes
  let watcher;
  try {
    const d = logDir();
    watcher = fs.watch(d, { persistent: false }, () => scheduleRedraw());
  } catch {
    // Directory may not exist yet
  }

  // Keyboard handling
  const stdin = process.stdin;
  if (!once && stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", async (buf) => {
      const key = buf.toString();
      if (key === "q" || key === "\x03") {
        running = false;
        if (watcher) watcher.close();
        clear();
        render(); // final render
        process.exit(0);
      } else if (key === "m") {
        if (activeSpan) {
          process.stdout.write("\n" + spanEnd() + "\n");
        } else {
          process.stdout.write("\nStart span label: ");
          // Need to temporarily exit raw mode for input
          stdin.setRawMode(false);
          const label = await new Promise(resolve => {
            const onData = (b) => { stdin.removeListener("data", onData); resolve(b.toString().trim()); };
            stdin.on("data", onData);
          });
          stdin.setRawMode(true);
          process.stdout.write(spanStart(label) + "\n");
        }
        setTimeout(scheduleRedraw, 500);
      }
      scheduleRedraw();
    });
  }

  // Initial render
  render();

  // Poll refresh (1s)
  if (!once && !stdin.isTTY) {
    setInterval(scheduleRedraw, 1000);
  }

  if (once) {
    setTimeout(() => process.exit(0), 100);
  }

  // Keep alive
  if (running) {
    process.stdin.resume();
  }
}

// ────────────────────────────────────────────────────────
// 9. TERMINAL HELPERS (ANSI, cross-platform)
// ────────────────────────────────────────────────────────

function createTerminal() {
  const ESC = "\x1b";
  return {
    clear() {
      process.stdout.write(ESC + "[2J" + ESC + "[0;0H");
    },
    moveTo(row, col) {
      process.stdout.write(ESC + `[${row};${col}H`);
    },
    getSize() {
      return { columns: process.stdout.columns || 80, rows: process.stdout.rows || 40 };
    },
  };
}

// ────────────────────────────────────────────────────────
// 10. SDK WRAPPER — MODE A (fetch drop-in)
// ────────────────────────────────────────────────────────

async function kimiFetch(url, options = {}) {
  const startTime = Date.now();
  const response = await fetch(url, options);

  // Only intercept Kimi chat completion calls
  if (url.includes("api.moonshot.cn/v1/chat/completions")) {
    const cloned = response.clone();
    const body = await cloned.json().catch(() => null);
    if (body && body.usage && body.model) {
      const requestId = body.id || (`req-${randomUUID().slice(0, 8)}`);
      await appendLog(requestId, body.model, body.usage);
    }
  }

  return response;
}

// ────────────────────────────────────────────────────────
// 11. SDK WRAPPER — MODE B (OpenAI-Client Interceptor)
// ────────────────────────────────────────────────────────

function wrapOpenAIClient(client) {
  const orig = client.chat.completions.create.bind(client.chat.completions);

  client.chat.completions.create = async function (...args) {
    const result = await orig(...args);

    if (result && result.usage && result.model) {
      const requestId = result.id || (`req-${randomUUID().slice(0, 8)}`);
      await appendLog(requestId, result.model, result.usage);
    }

    return result;
  };

  // Also wrap streaming
  if (client.chat.completions._originalStreamCreate) return client;
  client.chat.completions._originalStreamCreate = true;

  const origStream = (client.chat.completions.stream || client.chat.completions._stream).bind(client.chat.completions);
  if (origStream) {
    client.chat.completions.stream = async function (...args) {
      const stream = await origStream(...args);
      const origController = stream.controller;
      const chunks = [];
      const origOn = stream.on.bind(stream);

      // Monkey-patch to capture final chunk
      stream.on = function (event, handler) {
        if (event === "finalChatCompletion" || event === "chatCompletion") {
          return origOn(event, async (completion) => {
            if (completion && completion.usage && completion.model) {
              const requestId = completion.id || (`req-${randomUUID().slice(0, 8)}`);
              await appendLog(requestId, completion.model, completion.usage);
            }
            handler(completion);
          });
        }
        return origOn(event, handler);
      };

      return stream;
    };
  }

  return client;
}

// ────────────────────────────────────────────────────────
// 12. CLI DISPATCH
// ────────────────────────────────────────────────────────

function printUsage() {
  console.log(`kimi-token-counter — Kimi API token tracker & dashboard

Usage:
  node kimi-token-counter.js                         Live dashboard
  node kimi-token-counter.js --once                  Single snapshot
  node kimi-token-counter.js --log <daily|session>   Rolling report mode

Span markers:
  node kimi-token-counter.js mark start "<label>"    Start a span
  node kimi-token-counter.js mark end                End current span
  node kimi-token-counter.js mark status             Show active span
  node kimi-token-counter.js mark list               Recent spans
  node kimi-token-counter.js mark cancel             Cancel active span

Environment:
  KTC_DIR         Base directory (~/.kimi-token-counter)
  KTC_SESSION     Session ID (auto-generated)
  KTC_PROJECT     Project name (default)
  NO_COLOR        Disable ANSI colors`);
}

async function main() {
  const args = process.argv.slice(2);

  // Dispatch
  if (args[0] === "mark") {
    const cmd = args[1];
    const label = args[2];

    fs.mkdirSync(CONFIG.baseDir, { recursive: true });
    fs.mkdirSync(logDir(), { recursive: true });

    switch (cmd) {
      case "start":  console.log(spanStart(label || "unnamed")); break;
      case "end":    console.log(spanEnd()); break;
      case "status": console.log(spanStatus()); break;
      case "list":   console.log(spanList()); break;
      case "cancel": console.log(spanCancel()); break;
      default: printUsage(); break;
    }
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const once = args.includes("--once");

  // Ensure directories
  fs.mkdirSync(CONFIG.baseDir, { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });

  dashboard(once);
}

// Run CLI if called directly
if (require.main === module) {
  main().catch(err => { console.error("Error:", err.message); process.exit(1); });
}

// ────────────────────────────────────────────────────────
// 13. EXPORTS (for use as library)
// ────────────────────────────────────────────────────────

module.exports = { kimiFetch, wrapOpenAIClient, appendLog, spanStart, spanEnd, spanStatus, spanList, spanCancel, PRICE_TABLE };
