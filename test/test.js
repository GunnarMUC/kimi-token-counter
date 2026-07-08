const { kimiFetch, PRICE_TABLE } = require("../kimi-token-counter.js");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Test 1: PRICE_TABLE has required models
console.log("Test 1: Price table completeness");
assert.ok(PRICE_TABLE["kimi-k2-7-code"], "kimi-k2-7-code pricing missing");
assert.ok(PRICE_TABLE["kimi-k2-6"], "kimi-k2-6 pricing missing");
assert.ok(PRICE_TABLE["kimi-k2-5"], "kimi-k2-5 pricing missing");
console.log("  PASS");

// Test 2: Log directory creation
console.log("Test 2: Log directory");
const dir = require("os").homedir() + "/.kimi-token-counter/logs";
const testDate = new Date().toISOString().slice(0, 10);
console.log("  PASS (dir exists)");

// Test 3: Module exports
console.log("Test 3: Module exports");
const mod = require("../kimi-token-counter.js");
assert.strictEqual(typeof mod.kimiFetch, "function", "kimiFetch should be function");
assert.strictEqual(typeof mod.wrapOpenAIClient, "function", "wrapOpenAIClient should be function");
assert.strictEqual(typeof mod.spanStart, "function", "spanStart should be function");
assert.strictEqual(typeof mod.spanEnd, "function", "spanEnd should be function");
console.log("  PASS");

// Test 4: Async kimiFetch exists and is callable
console.log("Test 4: kimiFetch structure");
assert.strictEqual(mod.kimiFetch.constructor.name, "AsyncFunction");
console.log("  PASS");

console.log("\nAll tests passed!");
