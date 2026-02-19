import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ensureProjectId, handleToolError, type ServerContext } from '../context.js';
import type {
  FeatureDetails,
  FeatureEnvironment,
  FeatureFlagSummary,
  FeatureStrategy,
} from '../unleash/client.js';

// ── Schema ──────────────────────────────────────────────────────────

const searchFlagsBaseSchema = z.object({
  projectId: z
    .string()
    .optional()
    .describe(
      'Project ID to search in (optional if UNLEASH_DEFAULT_PROJECT is set)',
    ),
  nameContains: z
    .string()
    .optional()
    .describe('Substring match on flag name (case-insensitive)'),
  flagType: z
    .enum(['release', 'experiment', 'operational', 'kill-switch', 'permission'])
    .optional()
    .describe('Filter by flag type'),
  environment: z
    .string()
    .optional()
    .describe('Only return/evaluate data for this environment'),
  enabledIn: z
    .string()
    .optional()
    .describe('Only flags enabled in this environment'),
  disabledIn: z
    .string()
    .optional()
    .describe('Only flags disabled in this environment'),
  constraintContext: z
    .string()
    .optional()
    .describe('Match constraints on this context field (e.g. "ecosystemId")'),
  constraintValue: z
    .string()
    .optional()
    .describe('Exact value to match in constraints (e.g. the resolved ID)'),
  constraintOperator: z
    .string()
    .optional()
    .describe('Match constraint operator (e.g. "NOT_IN", "IN")'),
  segmentId: z.number().optional().describe('Match flags using this segment'),
  strategyName: z
    .string()
    .optional()
    .describe('Match flags using this strategy type'),
  stale: z.boolean().optional().describe('Filter by stale status'),
  concurrency: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe('Parallel API requests (1-20, default 5)'),
});

// Separate the refinement so it doesn't wrap the schema in ZodEffects,
// which breaks JSON Schema serialization (produces empty properties).
const searchFlagsSchema = searchFlagsBaseSchema.refine(
  (data) => {
    const {
      projectId: _p,
      concurrency: _c,
      ...filters
    } = data;
    return Object.values(filters).some((v) => v !== undefined);
  },
  {
    message: 'At least one filter parameter is required',
  },
);

type SearchFlagsInput = z.infer<typeof searchFlagsSchema>;

// ── Types ───────────────────────────────────────────────────────────

interface TrimmedConstraint {
  contextName: string;
  operator: string;
  values?: string[];
  inverted: boolean;
}

interface TrimmedStrategy {
  name: string;
  title?: string;
  rollout?: string;
  constraints?: TrimmedConstraint[];
  segments?: number[];
}

interface TrimmedEnvironment {
  name: string;
  enabled: boolean;
  strategies?: TrimmedStrategy[];
}

interface TrimmedFlag {
  name: string;
  type: string;
  description?: string;
  stale: boolean;
  createdAt?: string;
  environments: TrimmedEnvironment[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseConstraint(raw: Record<string, unknown>): TrimmedConstraint {
  const contextName = String(raw.contextName ?? '');
  const operator = String(raw.operator ?? '');
  const inverted = Boolean(raw.inverted);

  let values: string[] | undefined;
  if (Array.isArray(raw.values)) {
    values = raw.values.map(String);
  } else if (typeof raw.value === 'string' && raw.value) {
    values = [raw.value];
  }

  return { contextName, operator, values, inverted };
}

function getActiveStrategies(env: FeatureEnvironment): FeatureStrategy[] {
  return (env.strategies ?? []).filter((s) => !s.disabled);
}

function trimStrategy(s: FeatureStrategy): TrimmedStrategy {
  const constraints = (s.constraints ?? []).map((c) =>
    parseConstraint(c as Record<string, unknown>),
  );

  const result: TrimmedStrategy = {
    name: s.name,
  } as TrimmedStrategy;

  if (s.title) result.title = s.title;
  if (s.parameters?.rollout) result.rollout = s.parameters.rollout;
  if (constraints.length > 0) result.constraints = constraints;
  if (s.segments && s.segments.length > 0) result.segments = s.segments;

  return result;
}

function trimEnvironment(env: FeatureEnvironment): TrimmedEnvironment {
  const activeStrategies = getActiveStrategies(env);
  const result: TrimmedEnvironment = {
    name: env.environment ?? env.name,
    enabled: env.enabled,
  } as TrimmedEnvironment;

  if (activeStrategies.length > 0) {
    result.strategies = activeStrategies.map(trimStrategy);
  }

  return result;
}

function trimFlag(feature: FeatureDetails, envFilter?: string): TrimmedFlag {
  let environments = feature.environments ?? [];
  if (envFilter) {
    environments = environments.filter(
      (env) =>
        (env.environment ?? env.name).toLowerCase() === envFilter.toLowerCase(),
    );
  }

  const result: TrimmedFlag = {
    name: feature.name,
    type: feature.type ?? 'unknown',
    stale: feature.stale ?? false,
    environments: environments.map(trimEnvironment),
  };

  if (feature.description) {
    result.description = feature.description.length > 300
      ? feature.description.slice(0, 300) + '...'
      : feature.description;
  }
  if (feature.createdAt) result.createdAt = feature.createdAt.slice(0, 10);

  return result;
}

// ── Filters ─────────────────────────────────────────────────────────

function matchesAllFilters(
  feature: FeatureDetails,
  input: SearchFlagsInput,
): boolean {
  // enabledIn / disabledIn
  if (input.enabledIn) {
    const env = (feature.environments ?? []).find(
      (e) =>
        (e.environment ?? e.name).toLowerCase() ===
        input.enabledIn!.toLowerCase(),
    );
    if (!env || !env.enabled) return false;
  }

  if (input.disabledIn) {
    const env = (feature.environments ?? []).find(
      (e) =>
        (e.environment ?? e.name).toLowerCase() ===
        input.disabledIn!.toLowerCase(),
    );
    if (!env || env.enabled) return false;
  }

  // stale
  if (input.stale !== undefined) {
    if ((feature.stale ?? false) !== input.stale) return false;
  }

  // Collect all active strategies across relevant environments
  let environments = feature.environments ?? [];
  if (input.environment) {
    environments = environments.filter(
      (e) =>
        (e.environment ?? e.name).toLowerCase() ===
        input.environment!.toLowerCase(),
    );
  }
  const activeStrategies = environments.flatMap(getActiveStrategies);

  // strategyName
  if (input.strategyName) {
    const match = activeStrategies.some(
      (s) => s.name.toLowerCase() === input.strategyName!.toLowerCase(),
    );
    if (!match) return false;
  }

  // segmentId
  if (input.segmentId !== undefined) {
    const match = activeStrategies.some((s) =>
      (s.segments ?? []).includes(input.segmentId!),
    );
    if (!match) return false;
  }

  // constraint matching
  if (input.constraintContext || input.constraintValue || input.constraintOperator) {
    const allConstraints = activeStrategies.flatMap((s) =>
      (s.constraints ?? []).map((c) => parseConstraint(c as Record<string, unknown>)),
    );

    const match = allConstraints.some((c) => {
      if (input.constraintContext && c.contextName !== input.constraintContext) {
        return false;
      }
      if (
        input.constraintValue &&
        !(c.values ?? []).includes(input.constraintValue)
      ) {
        return false;
      }
      if (input.constraintOperator && c.operator !== input.constraintOperator) {
        return false;
      }
      return true;
    });

    if (!match) return false;
  }

  return true;
}

// ── Concurrency ─────────────────────────────────────────────────────

async function fetchWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<FeatureDetails>,
  onProgress: (completed: number, total: number) => Promise<void>,
): Promise<{ results: FeatureDetails[]; errors: number }> {
  const results: FeatureDetails[] = [];
  let errors = 0;
  let completed = 0;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map((item, batchIdx) => fn(item, i + batchIdx)),
    );

    for (const outcome of settled) {
      completed++;
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        errors++;
      }
    }

    await onProgress(completed, items.length);
  }

  return { results, errors };
}

// ── Format ──────────────────────────────────────────────────────────

function formatConstraintText(c: TrimmedConstraint): string {
  const vals = c.values && c.values.length > 0 ? ` [${c.values.join(', ')}]` : '';
  const inv = c.inverted ? ' (inverted)' : '';
  return `${c.contextName} ${c.operator}${vals}${inv}`;
}

function formatStrategyText(s: TrimmedStrategy): string {
  const parts: string[] = [];

  if (s.title) parts.push(`"${s.title}":`);

  const constraintParts = (s.constraints ?? []).map(formatConstraintText);
  if (constraintParts.length > 0) parts.push(constraintParts.join('; '));

  if (s.rollout) parts.push(`→ rollout ${s.rollout}%`);
  if (s.segments && s.segments.length > 0) {
    parts.push(`segments: ${s.segments.join(', ')}`);
  }

  return `- ${parts.length > 0 ? parts.join(' ') : s.name}`;
}

function formatFlagText(flag: TrimmedFlag): string {
  const lines: string[] = [];
  const desc = flag.description ? ` — ${flag.description}` : '';
  lines.push(`### ${flag.name} (${flag.type})${desc}`);

  if (flag.createdAt) lines.push(`  Created: ${flag.createdAt}`);

  for (const env of flag.environments) {
    const status = env.enabled ? 'enabled' : 'disabled';
    const strategies = env.strategies ?? [];
    const count = strategies.length;
    lines.push(
      `  ${env.name} (${status}): ${count} active strateg${count === 1 ? 'y' : 'ies'}`,
    );
    for (const s of strategies) {
      lines.push(`    ${formatStrategyText(s)}`);
    }
  }

  return lines.join('\n');
}

function buildQueryDescription(input: SearchFlagsInput): string {
  const parts: string[] = [];
  if (input.nameContains) parts.push(`name~"${input.nameContains}"`);
  if (input.flagType) parts.push(`flagType=${input.flagType}`);
  if (input.environment) parts.push(`environment=${input.environment}`);
  if (input.enabledIn) parts.push(`enabledIn=${input.enabledIn}`);
  if (input.disabledIn) parts.push(`disabledIn=${input.disabledIn}`);
  if (input.constraintContext) parts.push(`constraintContext=${input.constraintContext}`);
  if (input.constraintValue) parts.push(`constraintValue=${input.constraintValue}`);
  if (input.constraintOperator) parts.push(`constraintOperator=${input.constraintOperator}`);
  if (input.segmentId !== undefined) parts.push(`segmentId=${input.segmentId}`);
  if (input.strategyName) parts.push(`strategyName=${input.strategyName}`);
  if (input.stale !== undefined) parts.push(`stale=${input.stale}`);
  return parts.join(', ');
}

// ── Main ────────────────────────────────────────────────────────────

export async function searchFlags(
  context: ServerContext,
  args: unknown,
  progressToken?: string | number,
): Promise<CallToolResult> {
  try {
    const input = searchFlagsSchema.parse(args) as SearchFlagsInput;
    const projectId = ensureProjectId(
      input.projectId,
      context.config.unleash.defaultProject,
    );
    const concurrency = input.concurrency ?? 5;

    await context.notifyProgress(
      progressToken,
      0,
      100,
      `Listing flags in project "${projectId}"...`,
    );

    // 1. List all flags
    const allFlags = await context.unleashClient.listFeatureFlags(projectId);

    // 2. Pre-filter by nameContains and flagType (avoids unnecessary detail fetches)
    let candidates: FeatureFlagSummary[] = allFlags;

    if (input.nameContains) {
      const needle = input.nameContains.toLowerCase();
      candidates = candidates.filter((f) =>
        f.name.toLowerCase().includes(needle),
      );
    }

    if (input.flagType) {
      candidates = candidates.filter((f) => f.type === input.flagType);
    }

    await context.notifyProgress(
      progressToken,
      10,
      100,
      `Pre-filtered to ${candidates.length} of ${allFlags.length} flags. Fetching details...`,
    );

    // If only pre-filter criteria were used and no detail-level filters needed,
    // we can still skip detail fetches if no detail-level filters are active.
    const needsDetails =
      input.enabledIn !== undefined ||
      input.disabledIn !== undefined ||
      input.constraintContext !== undefined ||
      input.constraintValue !== undefined ||
      input.constraintOperator !== undefined ||
      input.segmentId !== undefined ||
      input.strategyName !== undefined ||
      input.stale !== undefined ||
      input.environment !== undefined;

    let matchedFlags: TrimmedFlag[];
    let fetchErrors = 0;

    if (!needsDetails && candidates.length > 0) {
      // No detail-level filters — return pre-filtered flags with basic info
      // Still fetch details for trimmed output
      const { results, errors } = await fetchWithConcurrency(
        candidates,
        concurrency,
        (flag) => context.unleashClient.getFeature(projectId, flag.name),
        async (completed, total) => {
          const pct = 10 + Math.round((completed / total) * 80);
          await context.notifyProgress(
            progressToken,
            pct,
            100,
            `Fetched ${completed}/${total} flag details...`,
          );
        },
      );
      fetchErrors = errors;
      matchedFlags = results.map((f) => trimFlag(f, input.environment));
    } else if (candidates.length > 0) {
      // 3. Fetch details with bounded concurrency
      const { results, errors } = await fetchWithConcurrency(
        candidates,
        concurrency,
        (flag) => context.unleashClient.getFeature(projectId, flag.name),
        async (completed, total) => {
          const pct = 10 + Math.round((completed / total) * 80);
          await context.notifyProgress(
            progressToken,
            pct,
            100,
            `Fetched ${completed}/${total} flag details...`,
          );
        },
      );
      fetchErrors = errors;

      // 4. Apply detail-level filters
      const filtered = results.filter((f) => matchesAllFilters(f, input));

      // 5. Trim results
      matchedFlags = filtered.map((f) => trimFlag(f, input.environment));
    } else {
      matchedFlags = [];
    }

    await context.notifyProgress(
      progressToken,
      100,
      100,
      `Found ${matchedFlags.length} matching flags`,
    );

    // 6. Format output
    const query = buildQueryDescription(input);
    const lines: string[] = [
      `## Search Results: ${matchedFlags.length} of ${allFlags.length} flags matched (project "${projectId}")`,
      `Query: ${query}`,
    ];

    if (fetchErrors > 0) {
      lines.push(`(${fetchErrors} flag${fetchErrors === 1 ? '' : 's'} failed to fetch)`);
    }

    lines.push('');

    for (const flag of matchedFlags) {
      lines.push(formatFlagText(flag));
      lines.push('');
    }

    context.logger.info(
      `search_flags: ${matchedFlags.length}/${allFlags.length} matched in project "${projectId}"`,
    );

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n'),
        },
      ],
      structuredContent: {
        success: true,
        projectId,
        query,
        total: allFlags.length,
        matched: matchedFlags.length,
        fetchErrors,
        flags: matchedFlags,
      },
    };
  } catch (error) {
    return handleToolError(context, error, 'search_flags');
  }
}

export const searchFlagsTool = {
  name: 'search_flags',
  description:
    'Search and filter feature flags server-side with compact results. Supports filtering by name, type, environment state, constraints, segments, and strategy. Use get_context_fields first to resolve human-readable names to IDs. All filters are ANDed together; at least one filter is required. NOTE: This tool fetches full details (strategies, constraints, segments) for every matched flag — prefer list_flags for simple listing/browsing tasks where strategy details are not needed.',
  // Use the base ZodObject (not the ZodEffects from .refine()) so the MCP SDK
  // can serialize it to a proper JSON Schema with all properties visible.
  // The .refine() validation still runs at parse time inside the implementation.
  inputSchema: searchFlagsBaseSchema,
  implementation: searchFlags,
};
