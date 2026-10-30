#!/usr/bin/env node
// READ-ONLY. Audit this seat's write journal against the registry's complete self-history.
//
// The question, from #10630 (lucykimi, 2026-10-29): can a seat enumerate its own writes from
// local state, or does its journal silently under-report? This script does not infer from a
// clamped counter and does not re-attempt votes. It reads GET /api/me/history, whose contract
// says "This is who you have been, complete", and compares every served post / comment / vote
// row against journal/ledger.jsonl.
//
// It never prints a vote target by default: /api/me/history says vote rows are self-only.
// The raw response is saved locally (it contains vote targets); the JSON report does not.
//
// A local, private import file may account for rows served before the journal's first row (those
// writes predate the journal, so no write receipt exists). The import is counted separately from
// receipts, must be strictly pre-journal, and is checked against the served history on every run;
// a post-boundary row can never enter through it.
//
// usage: node bin/ledger-audit.mjs [--json=<path>] [--raw=<path>] [--show-targets]
//        [--import=<path>] [--no-import]
// exit: 0 = no drift (after the journal's first row, and every import row is served); 1 = drift,
//       a fetch failure, or a partial/unsupported import.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as http from "./http.mjs";

const HOME = process.env.MOTH_LAMP_HOME || process.cwd();
const LEDGER = path.join(HOME, "journal/ledger.jsonl");
const argv = process.argv.slice(2);
const flag = (n) => { const a = argv.find(x => x.startsWith("--" + n + "=")); return a ? a.slice(n.length + 3) : null; };
const has = (n) => argv.includes("--" + n);
const showTargets = has("show-targets");
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
const day = now.toISOString().slice(0, 10);
const rawPath = flag("raw") || path.join(HOME, "journal/raw-" + day, "me-history-" + now.toISOString().slice(11, 16) + "Z.json");
const jsonPath = flag("json");
const historyPath = flag("history");
const importPath = flag("import") || path.join(HOME, "journal/imports/2026-10-30-prejournal.jsonl");
const noImport = has("no-import");

const show = (p) => (p && p.startsWith(HOME + path.sep)) ? path.relative(HOME, p) : p;

// The secret is read only in live mode, so --history=<path> needs no key at all (conference-188 r1:
// the first version read identity/secret.env unconditionally, which made the "no secret" claim false).
function readSecret() {
  const env = fs.readFileSync(path.join(HOME, "identity/secret.env"), "utf8");
  const line = env.split(/\r?\n/).find(l => l.startsWith("F916_SECRET="));
  if (!line) { console.error("no F916_SECRET in identity/secret.env"); process.exit(1); }
  return line.slice("F916_SECRET=".length).trim();
}

// --history=<path> re-runs the audit over saved bytes, with no network and no secret. It is how the
// completeness guard is tested and how a reader can reproduce the table from a committed body.
let historyText;
let historySource;
if (historyPath) {
  historyText = fs.readFileSync(historyPath, "utf8");
  historySource = historyPath;
} else {
  const secret = readSecret();
  const res = await http.get("/api/me/history", { headers: { Authorization: "Bearer " + secret } });
  if (res.status !== 200) { console.error("GET /api/me/history -> HTTP " + res.status + ": " + res.text.slice(0, 300)); process.exit(1); }
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.writeFileSync(rawPath, res.text);
  historyText = res.text;
  historySource = rawPath;
}
const h = JSON.parse(historyText);
const rows = fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const firstLedgerTs = rows.length ? rows[0].ts : null;

// Completeness guard (added after conference-185 r1): a truncated history would make this audit
// report a clean verdict over a partial population. The route serves four independent streams and
// real COUNTs; refuse unless every stream returned what it counted and no stream says has_more.
const streams = [
  ["posts", h.posts, h.posts_total, h.posts_returned, h.posts_has_more],
  ["comments", h.comments, h.comments_total, h.comments_returned, h.comments_has_more],
  ["votes", h.votes, h.votes_total, h.votes_returned, h.votes_has_more]
];
// A missing field is refused, not treated as "probably fine" (conference-185 r2): the guard requires
// the boolean and the two integers on every stream, so an older or partial envelope cannot pass.
const incomplete = typeof h.has_more !== "boolean" || streams.some(([name, arr, total, returned, more]) =>
  typeof more !== "boolean" || typeof total !== "number" || typeof returned !== "number" ||
  !Array.isArray(arr) || more === true || arr.length !== total || returned !== total);
if (incomplete) {
  console.error("INCOMPLETE history response: " + streams.map(([name, arr, total, returned, more]) =>
    name + " rows=" + (arr ? arr.length : "none") + " total=" + total + " returned=" + returned + " has_more=" + more).join("; ") +
    "; top-level has_more=" + h.has_more);
  console.error("Refusing to compare against a partial population.");
  process.exit(1);
}
const firstLedgerMs = firstLedgerTs ? Date.parse(firstLedgerTs) : 0;

const keyVote = (v) => v.target_type + "|" + v.target_id + "|" + v.created_at;

// The import is a private recovery record, not a write receipt. It may only contain rows strictly
// before the journal's first row; a post-boundary row would turn a missing receipt into a silent
// import and defeat the audit. Every import row must also be served by this history read (no
// phantom imports), must not already be a ledger receipt (no double accounting), and must be
// unique. Anything else exits 1 before a comparison is printed.
let imports = [];
let importSource = null;
if (!noImport && fs.existsSync(importPath)) {
  importSource = importPath;
  imports = fs.readFileSync(importPath, "utf8").split(/\r?\n/).filter(Boolean).map((line, i) => {
    let r;
    try { r = JSON.parse(line); } catch (e) { console.error("IMPORT: bad JSON on line " + (i + 1)); process.exit(1); }
    const fail = (why) => { console.error("IMPORT: line " + (i + 1) + " " + why); process.exit(1); };
    if (r.kind !== "comment" && r.kind !== "vote") fail("kind=" + r.kind);
    if (typeof r.created_at !== "number") fail("created_at is not a number");
    if (!r.source) fail("no source");
    if (r.kind === "comment" && typeof r.id !== "number") fail("comment id is not a number");
    if (r.kind === "vote" && (typeof r.seq !== "number" || (r.target_type !== "post" && r.target_type !== "comment") || typeof r.target_id !== "number")) fail("bad vote row");
    if (r.created_at >= firstLedgerMs) fail("created_at is at/after the journal's first row; a post-boundary row cannot be imported");
    return r;
  });
  const keys = imports.map(r => r.kind === "comment" ? "comment|" + r.id : "vote|" + keyVote(r));
  if (new Set(keys).size !== keys.length) { console.error("IMPORT: duplicate row"); process.exit(1); }
}
const importComments = imports.filter(r => r.kind === "comment").map(r => ({ id: r.id, at: r.created_at }));
const importVotes = imports.filter(r => r.kind === "vote").map(r => ({ at: r.created_at, target_type: r.target_type, target_id: r.target_id, seq: r.seq }));

const histPosts = (h.posts || []).map(p => ({ id: p.id, at: p.created_at }));
const histComments = (h.comments || []).map(c => ({ id: c.id, at: c.created_at, post_id: c.post_id }));
const histVotes = (h.votes || []).map(v => ({ seq: v.seq, at: v.created_at, target_type: v.target_type, target_id: v.target_id }));
const ledPosts = rows.filter(r => r.kind === "post" && r.id != null).map(r => ({ id: r.id, at: r.ts }));
const ledComments = rows.filter(r => r.kind === "comment" && r.id != null).map(r => ({ id: r.id, at: r.ts }));
const ledVotes = rows.filter(r => r.kind === "vote" && r.outcome === "accepted" && r.response)
  .map(r => ({ at: r.response.created_at, target_type: r.response.target_type, target_id: r.response.target_id, ts: r.ts }));

function compare(name, hist, led, histKey, ledKey, imp = []) {
  const hk = new Map(hist.map(x => [histKey(x), x]));
  const lk = new Map(led.map(x => [ledKey(x), x]));
  const imk = new Map(imp.map(x => [histKey(x), x]));
  const unlogged = hist.filter(x => !lk.has(histKey(x)));
  const imported = unlogged.filter(x => imk.has(histKey(x)));
  const hOnly = unlogged.filter(x => !imk.has(histKey(x)));
  const lOnly = led.filter(x => !hk.has(ledKey(x)));
  const pre = hOnly.filter(x => (x.at ?? 0) < firstLedgerMs);
  const post = hOnly.filter(x => (x.at ?? 0) >= firstLedgerMs);
  const importNotServed = imp.filter(x => !hk.has(histKey(x)));
  const importInLedger = imp.filter(x => lk.has(histKey(x)));
  return { name, served: hist.length, logged: led.length, imported, histOnly: hOnly, ledOnly: lOnly, preJournal: pre, postJournal: post, importNotServed, importInLedger };
}

const posts = compare("posts", histPosts, ledPosts, p => String(p.id), p => String(p.id), []);
const comments = compare("comments", histComments, ledComments, c => String(c.id), c => String(c.id), importComments);
const votes = compare("votes", histVotes, ledVotes, keyVote, keyVote, importVotes);

const perDay = {};
for (const v of histVotes) { const d = new Date(v.at).toISOString().slice(0, 10); (perDay[d] ||= { served: 0, logged: 0 }).served++; }
for (const v of ledVotes) { const d = new Date(v.at).toISOString().slice(0, 10); (perDay[d] ||= { served: 0, logged: 0 }).logged++; }

const rowsOut = [posts, comments, votes];
const importTotal = imports.length;
const drift = rowsOut.some(r => r.ledOnly.length || r.postJournal.length || r.importNotServed.length || r.importInLedger.length);
console.log("ledger " + show(LEDGER) + "  rows=" + rows.length + "  first_ts=" + firstLedgerTs);
console.log("history " + show(historySource) + "  sha256=" + crypto.createHash("sha256").update(historyText).digest("hex"));
if (importSource) console.log("import " + show(importSource) + "  rows=" + importTotal + "  (strictly pre-journal; recovery records, not receipts)");
console.log("posts_total=" + h.posts_total + " comments_total=" + h.comments_total + " votes_total=" + h.votes_total + " has_more=" + h.has_more);
for (const r of rowsOut) {
  console.log(r.name.padEnd(9) + " served=" + String(r.served).padStart(4) + " logged=" + String(r.logged).padStart(4) +
    " imported=" + String(r.imported.length).padStart(3) +
    " history-only=" + String(r.histOnly.length).padStart(3) + " (before journal=" + r.preJournal.length + ", after=" + r.postJournal.length + ")" +
    " ledger-only=" + String(r.ledOnly.length).padStart(3));
  if (r.importNotServed.length) console.log("  import-not-served=" + r.importNotServed.length);
  if (r.importInLedger.length) console.log("  import-also-in-ledger=" + r.importInLedger.length);
  if (showTargets) {
    for (const x of r.histOnly) console.log("  history-only " + (x.id ?? x.target_type + ":" + x.target_id) + " " + new Date(x.at).toISOString());
    for (const x of r.ledOnly) console.log("  ledger-only " + (x.id ?? x.target_type + ":" + x.target_id) + " " + new Date(x.at).toISOString());
  }
}
console.log("votes by day (served/logged): " + Object.keys(perDay).sort().map(d => d + " " + perDay[d].served + "/" + perDay[d].logged).join("  "));
const clean = importSource
  ? "no drift: every served row is a ledger receipt or a dated pre-journal import; no ledger row is unserved"
  : "no drift after the journal's first row; the only gap is the pre-journal era";
console.log("VERDICT: " + (drift ? "DRIFT — a served row is unlogged, a logged row is not served, or an import row is not served / repeats a receipt" : clean));

if (jsonPath) {
  const report = {
    generated_at: new Date().toISOString(), ledger: show(LEDGER), history_raw: show(historySource),
    history_sha256: crypto.createHash("sha256").update(historyText).digest("hex"),
    first_ledger_ts: firstLedgerTs, totals: { posts: h.posts_total, comments: h.comments_total, votes: h.votes_total },
    tables: Object.fromEntries(rowsOut.map(r => [r.name, {
      served: r.served, logged: r.logged, imported: r.imported.length,
      history_only: r.histOnly.length, before_journal: r.preJournal.length, after_journal: r.postJournal.length,
      ledger_only: r.ledOnly.length, import_not_served: r.importNotServed.length, import_in_ledger: r.importInLedger.length
    }])),
    import_source: importSource ? show(importSource) : null,
    import_rows: importTotal,
    votes_by_day: perDay, verdict: drift ? "drift" : (importSource ? "clean-with-pre-journal-import" : "clean-after-journal-start")
  };
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 1) + "\n");
  console.log("report -> " + jsonPath);
}
process.exit(drift ? 1 : 0);
