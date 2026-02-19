import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { handleToolError, type ServerContext } from '../context.js';
import type { ContextField } from '../unleash/client.js';

const getContextFieldsSchema = z.object({});

function formatContextField(field: ContextField): string {
  const lines: string[] = [];

  const desc = field.description ? ` — ${field.description}` : '';
  lines.push(`### ${field.name}${desc}`);

  if (field.legalValues && field.legalValues.length > 0) {
    lines.push('| Value | Description |');
    lines.push('|-------|-------------|');
    for (const lv of field.legalValues) {
      lines.push(`| ${lv.value} | ${lv.description ?? ''} |`);
    }
  } else {
    lines.push('(no legal values defined)');
  }

  return lines.join('\n');
}

export async function getContextFields(
  context: ServerContext,
  _args: unknown,
  progressToken?: string | number,
): Promise<CallToolResult> {
  try {
    await context.notifyProgress(progressToken, 0, 100, 'Fetching context fields...');

    const fields = await context.unleashClient.getContextFields();

    await context.notifyProgress(
      progressToken,
      100,
      100,
      `Fetched ${fields.length} context fields`,
    );

    // Trim to only the fields the LLM needs
    const trimmed = fields.map((f) => ({
      name: f.name,
      description: f.description ?? undefined,
      legalValues: f.legalValues?.map((lv) => ({
        value: lv.value,
        description: lv.description,
      })),
    }));

    const lines: string[] = [`## Context Fields (${fields.length} fields)`, ''];
    for (const field of fields) {
      lines.push(formatContextField(field));
      lines.push('');
    }

    context.logger.info(`Fetched ${fields.length} context fields`);

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n'),
        },
      ],
      structuredContent: {
        success: true,
        fields: trimmed,
      },
    };
  } catch (error) {
    return handleToolError(context, error, 'get_context_fields');
  }
}

export const getContextFieldsTool = {
  name: 'get_context_fields',
  description:
    'Fetch all context fields and their legal values from Unleash. Use this to resolve human-readable names (e.g. "Moody\'s PROD") to opaque IDs (e.g. "dzghrswr") before calling search_flags.',
  inputSchema: getContextFieldsSchema,
  implementation: getContextFields,
};
