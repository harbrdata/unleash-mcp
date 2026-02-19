import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ensureProjectId, handleToolError, type ServerContext } from '../context.js';

const listFlagsSchema = z.object({
  projectId: z
    .string()
    .optional()
    .describe(
      'Project ID to list flags from (optional if UNLEASH_DEFAULT_PROJECT is set)',
    ),
  environment: z
    .string()
    .optional()
    .describe('Filter to show only a specific environment'),
  nameContains: z
    .string()
    .optional()
    .describe('Substring match on flag name (case-insensitive)'),
  flagType: z
    .enum(['release', 'experiment', 'operational', 'kill-switch', 'permission'])
    .optional()
    .describe('Filter by flag type'),
});

type ListFlagsInput = z.infer<typeof listFlagsSchema>;

interface FlagEnvironmentSummary {
  name: string;
  enabled: boolean;
}

interface FlagSummary {
  name: string;
  type: string;
  description?: string;
  createdAt?: string;
  lastSeenAt?: string | null;
  stale: boolean;
  tags?: Array<{ type?: string; value?: string }>;
  environments: FlagEnvironmentSummary[];
}

function formatFlagLine(flag: FlagSummary): string {
  const statusIcon = flag.stale ? '⚠️' : '•';

  const enabledEnvs = flag.environments.filter((e) => e.enabled).map((e) => e.name);
  const disabledEnvs = flag.environments.filter((e) => !e.enabled).map((e) => e.name);

  let envSummary = '';
  if (enabledEnvs.length > 0 && disabledEnvs.length > 0) {
    envSummary = ` | Enabled: ${enabledEnvs.join(', ')} | Disabled: ${disabledEnvs.join(', ')}`;
  } else if (enabledEnvs.length > 0) {
    envSummary = ` | Enabled in all: ${enabledEnvs.join(', ')}`;
  } else if (disabledEnvs.length > 0) {
    envSummary = ` | Disabled in all: ${disabledEnvs.join(', ')}`;
  }

  return `${statusIcon} ${flag.name} (${flag.type})${envSummary}`;
}

export async function listFlags(
  context: ServerContext,
  args: unknown,
  progressToken?: string | number,
): Promise<CallToolResult> {
  try {
    const input: ListFlagsInput = listFlagsSchema.parse(args);
    const projectId = ensureProjectId(input.projectId, context.config.unleash.defaultProject);

    await context.notifyProgress(
      progressToken,
      0,
      100,
      `Fetching feature flags from project "${projectId}"...`,
    );

    // Single API call — environments, tags, stale, lastSeenAt come for free
    const flagList = await context.unleashClient.listFeatureFlags(projectId);

    // Client-side filtering
    let filtered = flagList;

    if (input.nameContains) {
      const needle = input.nameContains.toLowerCase();
      filtered = filtered.filter((f) => f.name.toLowerCase().includes(needle));
    }

    if (input.flagType) {
      filtered = filtered.filter((f) => f.type === input.flagType);
    }

    if (filtered.length === 0) {
      await context.notifyProgress(progressToken, 100, 100, 'No feature flags found');

      return {
        content: [
          {
            type: 'text',
            text: `No feature flags found in project "${projectId}".`,
          },
        ],
        structuredContent: {
          success: true,
          projectId,
          flags: [],
          summary: { total: 0 },
        },
      };
    }

    // Map to slim FlagSummary shape
    const flags: FlagSummary[] = filtered.map((f) => {
      let environments: FlagEnvironmentSummary[] = (f.environments ?? []).map((e) => ({
        name: e.name,
        enabled: e.enabled,
      }));

      if (input.environment) {
        environments = environments.filter(
          (e) => e.name.toLowerCase() === input.environment!.toLowerCase(),
        );
      }

      const result: FlagSummary = {
        name: f.name,
        type: f.type ?? 'unknown',
        stale: f.stale ?? false,
        environments,
      };

      if (f.description) result.description = f.description;
      if (f.createdAt) result.createdAt = f.createdAt.slice(0, 10);
      if (f.lastSeenAt !== undefined) result.lastSeenAt = f.lastSeenAt;
      if (f.tags && f.tags.length > 0) result.tags = f.tags;

      return result;
    });

    await context.notifyProgress(progressToken, 100, 100, `Listed ${flags.length} feature flags`);

    // Find flags not enabled in all environments
    const notFullyEnabled = flags.filter((f) =>
      f.environments.length > 0 && f.environments.some((env) => !env.enabled),
    );

    // Build output text
    const lines: string[] = [
      `## Feature Flags in "${projectId}"`,
      '',
      `Total: ${flags.length} | Not fully enabled: ${notFullyEnabled.length}`,
      '',
    ];

    if (notFullyEnabled.length > 0) {
      lines.push(`### Flags NOT enabled in all environments (${notFullyEnabled.length}):`);
      lines.push('');
      for (const flag of notFullyEnabled) {
        lines.push(formatFlagLine(flag));
      }
      lines.push('');
    }

    lines.push('### All Flags:');
    lines.push('');
    for (const flag of flags) {
      lines.push(formatFlagLine(flag));
    }

    const summaryText = lines.join('\n');

    context.logger.info(`Listed ${flags.length} feature flags from project "${projectId}"`);

    return {
      content: [
        {
          type: 'text',
          text: summaryText,
        },
      ],
      structuredContent: {
        success: true,
        projectId,
        environmentFilter: input.environment,
        flags,
        notFullyEnabled: notFullyEnabled.map((f) => f.name),
        summary: {
          total: flags.length,
          notFullyEnabledCount: notFullyEnabled.length,
        },
      },
    };
  } catch (error) {
    return handleToolError(context, error, 'list_flags');
  }
}

export const listFlagsTool = {
  name: 'list_flags',
  description:
    'List all feature flags in a project with their environment states. This is the DEFAULT tool for listing, browsing, or auditing flags — it is fast (single API call) and returns flag name, type, description, tags, and enabled/disabled status per environment. Use search_flags ONLY when you need to filter by strategy details (constraints, segments, rollout%) or by enabled/disabled state in a specific environment.',
  inputSchema: listFlagsSchema,
  implementation: listFlags,
};
