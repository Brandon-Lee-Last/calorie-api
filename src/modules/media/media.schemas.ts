import { z } from '../../core/openapi';
import { clientIdSchema, timestampSchema } from '../../core/schemas';

export const mediaAccessSchema = z
  .object({
    url: z
      .string()
      .describe(
        'Give this to the video or image player. Fetch it with plain GET requests; it supports Range.',
      ),
    expiresAt: timestampSchema
      .nullable()
      .describe('When the link stops working (null for links that do not expire)'),
    kind: z.enum(['video', 'image', 'pdf']),
    mime: z.string().nullable(),
    durationS: z.number().int().nullable(),
    provider: z.enum(['r2', 'stream', 'external']),
  })
  .openapi('MediaAccess');

export const mediaFileQuerySchema = z.object({
  exp: z.coerce.number().int().min(0),
  sig: z.string().min(10).max(128),
});

export const mediaIdParam = z.object({ id: clientIdSchema });
