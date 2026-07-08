#!/usr/bin/env node
// Build a flag × ecosystem coverage matrix from Unleash `search_flags` output.
//
// Usage:
//   node build_matrix.mjs --context context-fields.json \
//        --flags flagsA.json [flagsB.json ...] \
//        --title "Release" [--env prods] [--out out.md]
//
// Each --flags file is the raw `search_flags` result (an object with a `flags`
// array, or a bare array). Each flag needs `name`, optional `description`,
// optional `createdAt` (rendered as the Created column), and `environments[]`
// with `enabled` + `strategies[]` (name, rollout, title, constraints[],
// segments[]). See references/strategy-evaluation.md for the rules.
//
// NOTE: `search_flags` does not report a strategy's `disabled` flag, so all
// listed strategies are treated as active. If a flag looks wrong, re-check it
// with `get_flag_state`, which includes `disabled`.

import fs from 'node:fs';

// ---- args -------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, multi = false) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.push(argv[++i]);
    }
  }
  return multi ? out : out[0];
};
const contextFile = opt('context');
const flagFiles = opt('flags', true);
const title = opt('title') || 'Flag';
const env = opt('env') || 'prods';
const outFile = opt('out');
if (!contextFile || !flagFiles.length) {
  console.error('need --context <file> and --flags <file...>');
  process.exit(1);
}

// ---- ecosystem columns (driven by get_context_fields) -----------------
// Preferred display order + short header, matched by id. Unknown prod ids are
// appended with a cleaned name. This keeps output stable/legible without
// hardcoding the *membership* (that still comes from context fields).
const ORDER = ['hyfhdikd','preprod1','production1','staging1','diolprod','ikgtrvhp','cce-stg','ukdataex','take2','ujutsypz','wlgypxwd','fkqujvno','dctapxia','lvpnlwpw','dypxovnn','dynhoaow'];
const ABBR = {hyfhdikd:'AZ',preprod1:'DGE-PP',production1:'DGE-Pr',staging1:'DGE-St',diolprod:'Diol',ikgtrvhp:'CCE','cce-stg':'CCE-S',ukdataex:'UKDX',take2:'Take2',ujutsypz:'Sig49',wlgypxwd:'Tieto',fkqujvno:'MC',dctapxia:'ADB',lvpnlwpw:'ADI',dypxovnn:'Moo-S',dynhoaow:'Moo-P'};

const ctx = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
const ecoField = ctx.fields.find((f) => f.name === 'ecosystemId');
const clean = (d) => d.replace(/^\s*\[[^\]]*\]\s*/, '').trim();
const prodVals = ecoField.legalValues.filter((v) => /\[?\s*PROD/i.test(v.description));
const idName = Object.fromEntries(ecoField.legalValues.map((v) => [v.value, clean(v.description)]));
const prodIds = [
  ...ORDER.filter((id) => prodVals.some((v) => v.value === id)),
  ...prodVals.map((v) => v.value).filter((id) => !ORDER.includes(id)),
];
const header = (id) => ABBR[id] || idName[id] || id;

// ---- strategy evaluation ----------------------------------------------
// Verdict ranks: full(✅) > partial(◐) > cloud(☁) > none(❌)
const RANK = { full: 3, partial: 2, cloud: 1, none: 0 };
const SYM = { full: '✅', partial: '◐', cloud: '☁', none: '❌' };

const inList = (c, id) => {
  const present = (c.values || []).includes(id);
  let m = c.operator === 'NOT_IN' ? !present : present; // base operator
  if (c.inverted) m = !m; // inverted flips
  return m;
};

// How does one strategy treat ecosystem `id`? id===null means "a brand-new ecosystem".
function strategyVerdict(s, id) {
  if (s.disabled) return 'none';
  const cons = s.constraints || [];
  const eco = cons.filter((c) => c.contextName === 'ecosystemId');
  const cloud = cons.filter((c) => c.contextName === 'cloudProvider');
  const principal = cons.filter((c) => c.contextName === 'userId' || c.contextName === 'organizationId');
  const segs = s.segments || [];
  // ecosystem gate: every ecosystemId constraint must pass for this id
  for (const c of eco) {
    if (id === null) {
      // new ecosystem: in no list. IN→false, NOT_IN→true, then invert.
      let m = c.operator === 'NOT_IN';
      if (c.inverted) m = !m;
      if (!m) return 'none';
    } else if (!inList(c, id)) return 'none';
  }
  // segment-only strategy (no ecosystem gate): can't assume membership
  if (segs.length && !eco.length) return 'none';
  // ecosystem gate passed (or none present → applies broadly)
  if (principal.length) return 'partial';   // restricted to named users/orgs
  if (segs.length) return 'partial';        // segment within an ecosystem
  if (cloud.length) return 'cloud';          // depends on the ecosystem's cloud
  return 'full';
}

function flagVerdict(strategies, id) {
  let best = 'none';
  for (const s of strategies) {
    const v = strategyVerdict(s, id);
    if (RANK[v] > RANK[best]) best = v;
  }
  return best;
}

// ---- load flags -------------------------------------------------------
const flags = [];
for (const f of flagFiles) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const fl of Array.isArray(j) ? j : j.flags) flags.push(fl);
}

// ---- compute rows -----------------------------------------------------
const rows = flags.map((fl) => {
  const prodEnv = (fl.environments || []).find((e) => e.name === env);
  const enabled = !!(prodEnv && prodEnv.enabled);
  const strategies = enabled ? prodEnv.strategies || [] : [];
  const def = enabled ? flagVerdict(strategies, null) : 'none';
  const cells = prodIds.map((id) => (enabled ? flagVerdict(strategies, id) : 'none'));
  return { name: fl.name, type: fl.type, createdAt: (fl.createdAt || '').slice(0, 10), description: (fl.description || '').replace(/\s+/g, ' ').trim(), enabled, def, cells };
});

// group: Default-on first, then Default-off (env on), then dormant (env off)
const defOn = (r) => r.enabled && r.def !== 'none';
rows.sort((a, b) => {
  const ga = !a.enabled ? 2 : defOn(a) ? 0 : 1;
  const gb = !b.enabled ? 2 : defOn(b) ? 0 : 1;
  return ga - gb;
});

// ---- render -----------------------------------------------------------
const today = (opt('date') || new Date().toISOString().slice(0, 10));
let md = '';
md += `# ${title} flags — flag × ecosystem matrix\n\n`;
md += `**Date:** ${today} · **Project:** \`default\` · **Environment:** \`${env}\` · **Flags:** ${rows.length}\n\n`;
md += `Rows are flags; columns are prod ecosystems. **Default** = state a new prod ecosystem gets if it isn't named in any strategy.\n\n`;
md += `- ✅ = ON · ❌ = OFF · ◐ = ON for named users/orgs only · ☁ = depends on the ecosystem's cloud provider\n\n`;
md += `**Ecosystem key:** ` + prodIds.map((id) => `\`${header(id)}\`=${idName[id]}`).join(' · ') + `\n\n`;

md += `| Flag | Created | Default | ${prodIds.map(header).join(' | ')} |\n`;
md += `|------|:-------:|:-------:|${prodIds.map(() => ':--:').join('|')}|\n`;
for (const r of rows) {
  md += `| ${r.name} | ${r.createdAt || '—'} | ${SYM[r.def]} | ${r.cells.map((c) => SYM[c]).join(' | ')} |\n`;
}

// auto notes
const partials = rows.filter((r) => r.def === 'partial' || r.cells.includes('partial'));
const clouds = rows.filter((r) => r.def === 'cloud' || r.cells.includes('cloud'));
const dormant = rows.filter((r) => !r.enabled);
md += `\n## Notes\n`;
md += `- **Default ✅** flags have a catch-all or \`NOT_IN\` rule (new ecosystem auto-on); **Default ❌** are allowlist-gated or dormant.\n`;
if (partials.length) md += `- **◐ (named users/orgs only):** ${partials.map((r) => r.name).join(', ')} — the flag is AND-ed with a userId/organizationId list, so only listed principals get it. Check the strategy for the exact list.\n`;
if (clouds.length) md += `- **☁ (cloud-dependent):** ${clouds.map((r) => r.name).join(', ')} — granted via a \`cloudProvider\` constraint, so on only for ecosystems on that cloud. \`search_flags\` doesn't expose each ecosystem's cloud; confirm if it matters.\n`;
if (dormant.length) md += `- **Dormant (env \`${env}\` off, ❌ everywhere):** ${dormant.map((r) => r.name).join(', ')}.\n`;
md += `- \`search_flags\` doesn't report \`disabled\` strategies; all listed strategies are treated as active. Re-check anomalies with \`get_flag_state\`.\n`;

// appendix
md += `\n## Appendix — flag names & descriptions\n\n`;
md += `In matrix-row order. Flags with no text have no description set in Unleash.\n\n`;
md += `| Flag | Description |\n|------|-------------|\n`;
for (const r of rows) md += `| ${r.name} | ${r.description ? r.description.replace(/\|/g, '\\|') : '_(no description set)_'} |\n`;

if (outFile) {
  fs.writeFileSync(outFile, md);
  console.error(`wrote ${outFile} (${rows.length} flags)`);
} else {
  process.stdout.write(md);
}
