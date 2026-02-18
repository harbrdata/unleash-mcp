import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ensureProjectId, handleToolError, type ServerContext } from '../context.js';
import type { FeatureDetails, FeatureEnvironment } from '../unleash/client.js';

const listFlagsSchema = z.object({
  projectId: z
    .string()
    .optional()
    .describe(
      'Project ID to list flags from (optional if UNLEASH_DEFAULT_PROJECT is set)',
    ),
  includeEnvironments: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include environment status for each flag (default: true)'),
  environment: z
    .string()
    .optional()
    .describe('Filter to show only a specific environment'),
});

type ListFlagsInput = z.infer<typeof listFlagsSchema>;

interface FlagEnvironmentSummary {
  name: string;
  enabled: boolean;
  strategyCount: number;
  activeStrategies: number;
}

interface FlagSummary {
  name: string;
  type: string;
  description?: string;
  enabled: boolean;
  archived: boolean;
  stale: boolean;
  environments?: FlagEnvironmentSummary[];
  url: string;
}

function summarizeEnvironment(env: FeatureEnvironment): FlagEnvironmentSummary {
  const strategyCount = env.strategies?.length ?? 0;
  const activeStrategies = env.strategies?.filter((s) => !s.disabled).length ?? 0;
  return {
    name: env.environment ?? env.name,
    enabled: env.enabled,
    strategyCount,
    activeStrategies,
  };
}

function formatFlagLine(flag: FlagSummary, environmentFilter?: string): string {
  const statusIcon = flag.archived ? '📦' : flag.stale ? '⚠️' : flag.enabled ? '✅' : '❌';

  let envSummary = '';
  if (flag.environments && flag.environments.length > 0) {
    const envs = environmentFilter
      ? flag.environments.filter((e) => e.name.toLowerCase() === environmentFilter.toLowerCase())
      : flag.environments;

    const enabledEnvs = envs.filter((e) => e.enabled).map((e) => e.name);
    const disabledEnvs = envs.filter((e) => !e.enabled).map((e) => e.name);

    if (enabledEnvs.length > 0 && disabledEnvs.length > 0) {
      envSummary = ` | Enabled: ${enabledEnvs.join(', ')} | Disabled: ${disabledEnvs.join(', ')}`;
    } else if (enabledEnvs.length > 0) {
      envSummary = ` | Enabled in all: ${enabledEnvs.join(', ')}`;
    } else if (disabledEnvs.length > 0) {
      envSummary = ` | Disabled in all: ${disabledEnvs.join(', ')}`;
    }
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

    // Get list of all flags
    const flagList = await context.unleashClient.listFeatureFlags(projectId);

    if (flagList.length === 0) {
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
          summary: {
            total: 0,
            enabled: 0,
            disabled: 0,
            archived: 0,
          },
        },
      };
    }

    const flags: FlagSummary[] = [];
    const total = flagList.length;

    // Fetch details for each flag to get environment info
    if (input.includeEnvironments) {
      for (let i = 0; i < flagList.length; i++) {
        const flagInfo = flagList[i];

        await context.notifyProgress(
          progressToken,
          Math.round(((i + 1) / total) * 90),
          100,
          `Fetching details for "${flagInfo.name}" (${i + 1}/${total})...`,
        );

        try {
          const details: FeatureDetails = await context.unleashClient.getFeature(
            projectId,
            flagInfo.name,
          );

          let environments = details.environments ?? [];
          if (input.environment) {
            environments = environments.filter(
              (env) =>
                env.environment?.toLowerCase() === input.environment?.toLowerCase() ||
                env.name.toLowerCase() === input.environment?.toLowerCase(),
            );
          }

          flags.push({
            name: details.name,
            type: details.type ?? 'unknown',
            description: details.description ?? undefined,
            enabled: details.enabled ?? false,
            archived: details.archived ?? false,
            stale: details.stale ?? false,
            environments: environments.map(summarizeEnvironment),
            url: flagInfo.url,
          });
        } catch (error) {
          // If we can't fetch details, use basic info
          flags.push({
            name: flagInfo.name,
            type: flagInfo.type ?? 'unknown',
            description: flagInfo.description,
            enabled: false,
            archived: flagInfo.archived ?? false,
            stale: false,
            url: flagInfo.url,
          });
        }
      }
    } else {
      // Just use basic flag info without environment details
      for (const flagInfo of flagList) {
        flags.push({
          name: flagInfo.name,
          type: flagInfo.type ?? 'unknown',
          description: flagInfo.description,
          enabled: false,
          archived: flagInfo.archived ?? false,
          stale: false,
          url: flagInfo.url,
        });
      }
    }

    await context.notifyProgress(progressToken, 100, 100, `Listed ${flags.length} feature flags`);

    // Calculate summary stats
    const enabledCount = flags.filter((f) => f.enabled && !f.archived).length;
    const disabledCount = flags.filter((f) => !f.enabled && !f.archived).length;
    const archivedCount = flags.filter((f) => f.archived).length;

    // Find flags not enabled in all environments
    const notFullyEnabled = flags.filter((f) => {
      if (!f.environments || f.environments.length === 0) return false;
      return f.environments.some((env) => !env.enabled);
    });

    // Build output text
    const lines: string[] = [
      `## Feature Flags in "${projectId}"`,
      '',
      `Total: ${flags.length} | Enabled: ${enabledCount} | Disabled: ${disabledCount} | Archived: ${archivedCount}`,
      '',
    ];

    if (notFullyEnabled.length > 0 && input.includeEnvironments) {
      lines.push(`### Flags NOT enabled in all environments (${notFullyEnabled.length}):`);
      lines.push('');
      for (const flag of notFullyEnabled) {
        lines.push(formatFlagLine(flag, input.environment));
      }
      lines.push('');
    }

    lines.push('### All Flags:');
    lines.push('');
    for (const flag of flags) {
      lines.push(formatFlagLine(flag, input.environment));
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
          enabled: enabledCount,
          disabled: disabledCount,
          archived: archivedCount,
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
    'List all feature flags in a project with their environment states. Useful for finding flags that are not enabled in all environments or auditing flag status.',
  inputSchema: listFlagsSchema,
  implementation: listFlags,
};
