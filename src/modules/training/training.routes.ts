import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { commonErrors, json, z } from '../../core/openapi';
import { pageQuerySchema } from '../../core/pagination';
import { requireAdmin } from '../../middleware/admin';

export const trainingRoutes = new OpenAPIHono<AppEnv>();
const guarded = { security: [{ adminKey: [] }], middleware: requireAdmin };

const itemSchema = z
  .object({
    id: z.string().describe('The scan id; use it to download the photo'),
    donor: z.string().describe('Keyed hash of the person: equal for one person’s photos, not reversible'),
    createdAt: z.number().int(),
    modelVersion: z.string(),
    outcome: z.enum(['saved', 'edited', 'discarded', 'not_food']),
    kind: z.enum(['food', 'not_food', 'unlabelled']),
    predictedCalories: z.number().nullable(),
    label: z
      .object({
        calories: z.number().nullable(),
        massG: z.number().nullable(),
        fatG: z.number().nullable(),
        carbG: z.number().nullable(),
        proteinG: z.number().nullable(),
        edited: z.boolean(),
      })
      .nullable()
      .describe('What the person kept. An estimate they accepted or corrected, not a measurement.'),
    photoType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  })
  .openapi('Contribution');

const pageSchema = z
  .object({ items: z.array(itemSchema), nextCursor: z.string().nullable() })
  .openapi('ContributionPage');

trainingRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/training/contributions',
    tags: ['Admin'],
    summary: 'Photos people agreed to contribute, with what they kept',
    ...guarded,
    description:
      'Oldest first. Only photos whose owner still consents appear: taking consent back removes the photo. ' +
      'Turn the result into a training folder with `scripts/export-training-data.mjs`.',
    request: { query: pageQuerySchema.extend({ since: z.coerce.number().int().min(0).default(0) }) },
    responses: { 200: json(pageSchema, 'A page of contributions'), 401: commonErrors[400] },
  }), // fmt: skip
  async (c) => {
    const { limit, cursor, since } = c.req.valid('query');
    return c.json(await c.get('deps').training.list(limit, cursor, since), 200);
  },
);

trainingRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/training/contributions/{id}/photo',
    tags: ['Admin'],
    summary: 'Download a contributed photo',
    ...guarded,
    request: { params: z.object({ id: z.string().min(8).max(40) }) },
    responses: {
      200: { description: 'The image', content: { 'image/jpeg': { schema: z.any() } } },
      401: commonErrors[400],
      404: commonErrors[400],
    },
  }), // fmt: skip
  async (c) => {
    const photo = await c.get('deps').training.photo(c.req.valid('param').id);
    return new Response(photo.body, {
      status: 200,
      headers: {
        'content-type': photo.type,
        'cache-control': 'no-store',
        'content-disposition': 'attachment',
      },
    }) as never;
  },
);
