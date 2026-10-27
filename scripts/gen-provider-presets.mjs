#!/usr/bin/env node
/* Builds app/provider-presets-data.js from the MIT-licensed CC Switch preset tables (see docs/THIRD_PARTY.md).
   Usage: CC_SWITCH_SRC=<checkout of the CC Switch repo> node scripts/gen-provider-presets.mjs
   Drops the partner / promotion fields and every tracking query string; keeps only
   {name, family, plan, region, category, baseUrl, protocol, models[], websiteUrl, apiKeyUrl, aliases}. Static data, never fetched at run time. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const src = process.env.CC_SWITCH_SRC;
if (!src) { console.error('set CC_SWITCH_SRC to the CC Switch checkout'); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'app', 'provider-presets-data.js');
const work = mkdtempSync(path.join(tmpdir(), 'aibro-presets-'));
const require = createRequire(import.meta.url);

async function load(file, name) {
  const outfile = path.join(work, `${name}.cjs`);
  await build({ entryPoints: [path.join(src, 'src/config', file)], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error', loader: { '.ts': 'ts' } });
  return require(outfile);
}

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CATEGORY = { cn_official: 'vendor', aggregator: 'platform', third_party: 'platform', cloud_provider: 'cloud', local: 'local' };
const PROTOCOL = { openai_responses: 'responses', openai_chat: 'chat', anthropic: 'anthropic' };
const PROTOCOL_RANK = { responses: 0, chat: 1, anthropic: 2 };
// 推广 / 邀请链接（路径里带 CC Switch 的邀请码）一律丢掉，只留官网和去掉查询串的地址。
const referral = url => /cc-?switch|invite|[?&](aff|ref|track_id)=/i.test(url || '');
const clean = url => { try { const u = new URL(url); u.search = ''; u.hash = ''; return u.toString().replace(/\/$/, ''); } catch (_) { return ''; } };
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '');
const baseKey = url => { try { const u = new URL(url); return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, ''); } catch (_) { return ''; } };

function modelEntry(raw) {
  const efforts = (raw.reasoningLevels || []).filter(level => EFFORTS.includes(level));
  const modalities = raw.inputModalities || [];
  const caps = { text: true };
  if (modalities.length) caps.vision = modalities.includes('image');
  caps.think = efforts.some(level => level !== 'none');
  const entry = { model: raw.model, label: raw.displayName || raw.model, caps };
  const window = Number(String(raw.contextWindow || '').replace(/[,_\s]/g, ''));
  if (Number.isSafeInteger(window) && window >= 1024) entry.contextWindow = window;
  if (efforts.length) entry.efforts = efforts;
  return entry;
}

const codex = await load('codexProviderPresets.ts', 'codex');
const claude = await load('claudeProviderPresets.ts', 'claude');
const families = (await load('presetFamilies.ts', 'families')).PRESET_FAMILIES || {};
const aliases = (await load('presetSearchAliases.ts', 'aliases')).PRESET_SEARCH_ALIASES || {};

const skipped = { oauth: 0, official: 0, hidden: 0, nobase: 0, uncategorised: 0 };
const raw = [];
for (const preset of codex.codexProviderPresets) {
  if (preset.hidden) { skipped.hidden += 1; continue; }
  if (preset.requiresOAuth || preset.providerType) { skipped.oauth += 1; continue; }
  if (preset.isOfficial || preset.category === 'official') { skipped.official += 1; continue; }
  const base = /base_url\s*=\s*"([^"]+)"/.exec(preset.config || '')?.[1] || '';
  const wire = /wire_api\s*=\s*"([^"]+)"/.exec(preset.config || '')?.[1];
  const model = /^model\s*=\s*"([^"]+)"/m.exec(preset.config || '')?.[1] || '';
  const protocol = PROTOCOL[preset.apiFormat] || (wire === 'chat' ? 'chat' : 'responses');
  if (!clean(base) || /\$\{|\{\{/.test(base)) { skipped.nobase += 1; continue; }
  const models = (preset.modelCatalog || []).map(modelEntry);
  if (!models.length && model) models.push({ model, label: model, caps: { text: true } });
  raw.push({ preset, base: clean(base), protocol, models, category: CATEGORY[preset.category] });
}
for (const preset of claude.providerPresets) {
  if (preset.hidden) { skipped.hidden += 1; continue; }
  if (preset.requiresOAuth || preset.providerType) { skipped.oauth += 1; continue; }
  if (preset.isOfficial || preset.category === 'official') { skipped.official += 1; continue; }
  const env = preset.settingsConfig?.env || {};
  const base = env.ANTHROPIC_BASE_URL || '';
  if (!clean(base) || /\$\{|\{\{/.test(base)) { skipped.nobase += 1; continue; }
  const names = [...new Set([env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL].filter(Boolean))];
  const protocol = PROTOCOL[preset.apiFormat] || (preset.apiFormat === 'openai_chat' ? 'chat' : 'anthropic');
  raw.push({ preset, base: clean(base), protocol, models: names.map(model => ({ model, label: model, caps: { text: true } })), category: CATEGORY[preset.category] });
}

// 同名预设（同一家的 Responses / Chat / Anthropic 入口）合成一张卡：首选协议为主，其余放进 alt。
const byName = new Map();
for (const item of raw) {
  if (!item.category) { skipped.uncategorised += 1; continue; }
  const key = item.preset.name;
  const group = byName.get(key) || [];
  group.push(item); byName.set(key, group);
}
const presets = [];
const seenIds = new Set();
for (const [name, group] of byName) {
  group.sort((a, b) => PROTOCOL_RANK[a.protocol] - PROTOCOL_RANK[b.protocol]);
  const main = group[0], p = main.preset;
  const alt = [];
  const seen = new Set([baseKey(main.base)]);
  for (const other of group.slice(1)) { const key = baseKey(other.base); if (!seen.has(key)) { seen.add(key); alt.push({ protocol: other.protocol, baseUrl: other.base }); } }
  const models = [];
  for (const item of group) for (const model of item.models) if (!models.some(entry => entry.model === model.model)) models.push(model);
  let id = slug(name) || 'preset'; for (let n = 2; seenIds.has(id); n += 1) id = `${slug(name)}-${n}`; seenIds.add(id);
  const entry = { id, name, category: main.category, baseUrl: main.base, protocol: main.protocol, models };
  if (p.family && families[p.family]) { entry.family = p.family; entry.familyName = families[p.family].name; }
  if (p.planKey) entry.plan = p.planKey;
  if (p.regionKey) entry.region = p.regionKey;
  if (alt.length) entry.alt = alt;
  const site = /cc-?switch|invite/i.test(clean(p.websiteUrl || '')) ? '' : clean(p.websiteUrl || ''), keys = referral(p.apiKeyUrl) ? '' : clean(p.apiKeyUrl || '');
  if (site) entry.websiteUrl = site; else { try { entry.websiteUrl = new URL(main.base).origin; } catch (_) { /* no site */ } }
  if (keys) entry.apiKeyUrl = keys;
  if (aliases[name]) entry.aliases = aliases[name];
  presets.push(entry);
}
presets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
const header = `/* Provider preset table, generated by scripts/gen-provider-presets.mjs from the MIT-licensed CC Switch preset data.
   Copyright (c) 2025 Jason Young (CC Switch). The licence text and registration are in docs/THIRD_PARTY.md. Static data: never fetched at run time. */
(function (root, factory) {
  const data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.ProviderPresetData = data;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return `;
writeFileSync(out, header + JSON.stringify({ version: 1, presets }) + ';\n}));\n');
console.log(`wrote ${presets.length} presets to ${path.relative(process.cwd(), out)}`, skipped);
