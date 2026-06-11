# Strategy evaluation — turning Unleash strategies into a per-ecosystem verdict

For each flag you need one verdict (✅ / ❌ / ◐) per prod ecosystem, plus the **Default**
verdict for an ecosystem named in no strategy. This file is the algorithm for that.

Evaluate against the **`prods`** environment block (ecosystems are prod tenants). A flag is
**ON** for ecosystem `E` if *any* active strategy grants it to a normal user in `E`.

## Step 0 — environment toggle

If the `prods` environment's `enabled` is `false`, the flag is **dormant**: Default ❌ and
every ecosystem ❌, no matter what strategies exist. If a dormant flag has a staged
unconstrained 100% strategy, note in caveats that flipping the env on turns it ON everywhere
at once. Otherwise continue.

## Step 1 — consider only active strategies

Skip any strategy with `disabled: true`. Each remaining strategy either grants or doesn't
grant a given ecosystem; OR the grants together.

## Step 2 — does a strategy grant ecosystem E?

A strategy grants `E` only if **all** its constraints pass for a normal user in `E` **and**
its rollout/segment gate passes. Evaluate each constraint, then combine:

### Constraint evaluation (operator + inverted)

Compute `matches = <operator applied to E's value vs. values[]>`, then **if `inverted` is
true, flip it**. Truth table for `ecosystemId`:

| operator | inverted | grants … |
|----------|----------|----------|
| `IN`     | false    | ecosystems **in** the list |
| `IN`     | true     | ecosystems **not in** the list (→ Default ✅) |
| `NOT_IN` | false    | ecosystems **not in** the list (→ Default ✅) |
| `NOT_IN` | true     | ecosystems **in** the list (double-negative) |

⚠️ `NOT_IN` + `inverted: true` is a contradictory double-encoding. Evaluate it as "in the
list" per the table, but **flag it in caveats** — intended behaviour easily diverges from
config here. Sanity-check against the strategy `title` (titles usually name the ecosystem the
author meant to grant).

### Other constraint context fields

- `cloudProvider IN [azure]` → grants ecosystems whose cloud is Azure. You don't get a direct
  ecosystem→cloud map, but `get_context_fields` descriptions often hint (e.g. "azure-test").
  In `prods` this gating is rare; if present, mark affected ecosystems per their cloud and note
  the assumption. (Most prod gating is `ecosystemId`-based.)
- `userId IN [...]` or `organizationId IN [...]` **AND-ed with** an `ecosystemId` constraint →
  the flag reaches only those named principals inside that ecosystem. That is **◐**, not ✅.
  Surface the user/org lists in caveats.
- A `userId`/`organizationId` constraint with **no** `ecosystemId` → it can match users across
  many ecosystems; treat as ◐ for the ecosystems it plausibly covers and explain in caveats.

### Rollout & segments

- `rollout: "100"` with no constraints/segments → **catch-all**: grants everyone (Default ✅,
  every ecosystem ✅). This is the only thing that makes Default ✅ besides a `NOT_IN`/inverted rule.
- `rollout` < 100 → percentage rollout; mark ◐ and note the percentage.
- `segments: [..]` → segment-gated. Segment membership isn't expanded here, so a segment-only
  strategy does **not** count as covering a generic ecosystem user → treat as ❌ for the
  ecosystem-wide view and note it. (If the user needs segment contents resolved, that's a
  follow-up.)

## Step 3 — the Default column

Default = the verdict for an ecosystem that matches no `ecosystemId` list and has no special
user/org/segment:
- **✅** if an active unconstrained 100% strategy exists, **or** a `NOT_IN`/`IN+inverted` rule
  exists and the new ecosystem isn't in its exclusion list.
- **❌** otherwise (allowlist-only, or dormant env).

## Step 4 — combine

Ecosystem `E`'s verdict = ✅ if any active strategy grants it fully; ◐ if its only grant is
user/org/percentage/segment-limited; else ❌. When both a full and a partial grant exist, full
(✅) wins.

## Worked examples (from real `prods` data)

- `activityLog`: one `flexibleRollout` @100%, no constraints → Default ✅, all ✅.
- `newSearch`: many `flexibleRollout` @100% each `ecosystemId IN [oneId]` → Default ❌; ✅ only
  for listed ids.
- `newAdminUI`: one strategy `ecosystemId IN [dynhoaow] inverted:true` (title "ALL except Moodys
  Prod") → Default ✅; ❌ only for `dynhoaow`.
- `accurateProductBodyText`: `ecosystemId NOT_IN [dctapxia,dynhoaow,dypxovnn,lvpnlwpw]` → Default
  ✅; ❌ for those four.
- `exchangeProductAIInsights` prods: `ecosystemId IN [hyfhdikd] AND userId IN [4 ids]` → Default
  ❌; AZ-Demo gets ◐ (only those 4 users); all others ❌.
- `newSubscriptionsUX` "Signal 49": `ecosystemId NOT_IN [ujutsypz] inverted:true` → evaluates to
  "IN [ujutsypz]" = Signal-49 ✅; flag the odd encoding in caveats.
