---
name: flag-ecosystem-matrix
description: >-
  Build a flag × ecosystem coverage matrix for Unleash feature flags — showing
  per ecosystem whether each flag is ON / OFF / partially-on, plus a "Default"
  column for what a new (unlisted) prod ecosystem gets. Use this whenever the
  user asks where flags are enabled or disabled, which ecosystems have a flag,
  flag coverage / rollout state across ecosystems, the default state for a new
  ecosystem, or wants an audit/report of feature flags by ecosystem — even if
  they don't say the word "matrix". Triggers on phrasings like "which ecosystems
  have X on", "where is flag Y enabled", "report of release flags per ecosystem",
  "what does a new ecosystem get by default".
---

# Flag × ecosystem coverage matrix

Produce a report that pivots Unleash feature flags against Harbr ecosystems: rows
are flags, columns are prod ecosystems, plus a leading **Default** column showing
what a brand-new ecosystem (named in no strategy) would get.

The hard part is not fetching data — it's **correctly evaluating Unleash strategies**
into a single ON/OFF/partial verdict per ecosystem. The rules for that live in
`references/strategy-evaluation.md`; read that file before computing verdicts.

## Tools

Uses the Unleash MCP server (`mcp__Unleash__*`). The two calls that matter:
- `get_context_fields` — resolves `ecosystemId` IDs → names and tags each as
  `[PRODs]` / `[STAGINGS]` / `[DEVs]`. This is how you build the ecosystem columns
  dynamically (do **not** hardcode the legend — it changes as tenants are added).
- `search_flags` — fetches flags **with their per-environment strategies** in one
  call. Filter by `flagType` (e.g. `release`) or, for every flag, by `environment`.

## Procedure

1. **Resolve ecosystems.** Call `get_context_fields`. From `ecosystemId.legalValues`,
   build an `id → name` map. Strip the `[PRODs]`/etc. tag from the description for the
   display name. The matrix **columns are the `[PRODs]` ecosystems** (ecosystems are
   production tenants); keep staging/dev ones aside for an optional note. Print the
   id→name key under the table so opaque IDs are legible.

2. **Fetch flags + strategies.** Call `search_flags` with the requested filter.
   Default to the flag type the user named (e.g. `{flagType: "release"}`); if they
   want all flags, pass `{environment: "prods"}` (search_flags needs ≥1 filter).
   Each flag returns an `environments[]` array, each with `enabled` and `strategies[]`.
   `flagType` is a single value — to cover several types (e.g. "all other types"),
   make one `search_flags` call per type. Also call `list_flags` with the same filter:
   it returns the **full, untruncated descriptions** (search_flags truncates long ones)
   that you'll need for the appendix.

3. **Evaluate the `prods` environment for each flag.** Ecosystems are evaluated in
   their prod context, so use the `prods` environment block. Apply the algorithm in
   `references/strategy-evaluation.md` to compute, for every prod ecosystem **and** for
   the hypothetical new/unlisted ecosystem (the Default column):
   - ✅ ON · ❌ OFF · ◐ ON for a few named users/orgs only (constraint AND-ed with the ecosystem)
   - If the `prods` env `enabled` is `false`, the flag is **dormant**: Default ❌ and every
     ecosystem ❌, regardless of staged strategies. Note in caveats if a 100% catch-all is
     staged behind the off toggle (flipping the env on would turn it ON everywhere at once).

4. **Render the matrix.** One row per flag, columns `Default | <each prod ecosystem>`.
   Order rows so **Default-✅ flags come first** (catch-all 100% rules, then `NOT_IN`
   rules), then **Default-❌ flags** (allowlist-gated), then **dormant** flags (env off,
   ❌ everywhere). This grouping makes the onboarding story readable at a glance.

5. **Write it to a markdown file under `reports/`** (e.g. `reports/release-flags-by-ecosystem.md`,
   named after the flag type). `reports/` is gitignored — these are generated artifacts, not
   source, so they must not be committed. Create the folder if it's missing. Then summarize the
   standout reads in chat (most- and least-covered ecosystems, any flag a tenant is unexpectedly
   missing).

## Output format

Use this exact shape (abbreviate long ecosystem names in headers; give the key below):

```markdown
# <Flag type> flags — flag × ecosystem matrix

**Date:** <date> · **Project:** `default` · **Flags:** N <type>

Rows are flags; columns are prod ecosystems. **Default** = state a new prod ecosystem
gets if it isn't named in any strategy.

- ✅ = ON · ❌ = OFF · ◐ = ON for a few named users only

**Ecosystem key:** `AZ`=AZ-Demo · `DGE-Pr`=DGE-Prod · … (from get_context_fields)

| Flag | Default | AZ | DGE-PP | DGE-Pr | … |
|------|:-------:|:--:|:------:|:------:|:--|
| activityLog | ✅ | ✅ | ✅ | ✅ | … |
| newSearch   | ❌ | ✅ | ✅ | ✅ | … |
| …           |    |    |    |    |   |

## How to read the Default column
- **Default ✅** — has a catch-all / NOT_IN rule, so a new ecosystem is ON automatically.
- **Default ❌** — allowlist or dormant; a new ecosystem stays OFF until added explicitly.

## Caveats
- <NOT_IN + inverted oddities, segment/percentage strategies, dormant-but-staged flags>

## Appendix — flag names & descriptions
| Flag | Description |
|------|-------------|
| <flag> | <full description from list_flags, or _(no description set)_ if absent> |
```

Always end the report with the **appendix** (flag name + full description, in matrix-row
order). It makes the matrix self-explanatory for readers who don't know each flag. Pull the
text from `list_flags` (full), not `search_flags` (truncated); condense only descriptions that
run to many paragraphs, and write `_(no description set)_` where Unleash has none.

## Scaling: the bundled evaluator script

Hand-evaluating works for a handful of flags, but for a whole flag type (dozens of
flags × 16 ecosystems) it's slow and error-prone. `scripts/build_matrix.mjs` does the
evaluation deterministically and emits the full report (matrix + notes + appendix).

```bash
# 1. Save the live inputs to files (the model fetches these via MCP):
#    - get_context_fields → context.json
#    - search_flags {flagType: X} → flags.json   (large results auto-persist to a
#      file whose path is in the tool result; small ones you save yourself)
# 2. Run (one --flags file per type; pass several to combine types in one report):
node scripts/build_matrix.mjs --context context.json --flags flags.json \
     --title "Permission" --date <today> --out reports/permission-flags-by-ecosystem.md
```

The script reads raw `search_flags` JSON (`.flags[]` with `environments[].strategies[]`),
derives the prod ecosystem columns from `context.json`, applies the
`references/strategy-evaluation.md` truth table, and groups rows Default-✅ → Default-❌ →
dormant. Two known limits, both surfaced in the report's auto-notes: `search_flags` omits
`disabled` strategies (re-check anomalies with `get_flag_state`), and it can't resolve an
ecosystem's cloud, so `cloudProvider`-gated grants render as ☁. Prefer the script for
accuracy and consistency; fall back to hand-evaluation only for one-off single-flag checks.

## Notes & gotchas

- **Don't hardcode ecosystem IDs.** Always rebuild the legend from `get_context_fields`
  so the report reflects tenants added since this skill was written.
- **`◐` matters.** A constraint like `ecosystemId IN [hyfhdikd] AND userId IN [...]` grants
  the flag to only those named users within that ecosystem — that's ◐, not ✅. Surface the
  user/org lists in caveats rather than pretending the whole ecosystem has it.
- **Flag the odd `NOT_IN` + `inverted:true` encoding** when you see it (a double-negative).
  Evaluate it per the truth table in the reference, but call it out for manual confirmation,
  because it's an easy place for the intended behaviour to diverge from what's configured.
- **Cross-check with `az-demo-prods-migration-audit.md`** if it exists in the repo — it
  records intended per-ecosystem behaviour and is useful for separating deliberate
  exclusions from missed onboarding.
- Scope is parameterizable: the same procedure works for any `flagType`
  (`operational`, `kill-switch`, `permission`, `experiment`) or all flags.
