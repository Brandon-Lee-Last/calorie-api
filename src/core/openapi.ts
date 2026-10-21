import { z } from '@hono/zod-openapi';

export const errorBodySchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'validation_failed' }),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string(),
    }),
  })
  .openapi('ErrorBody');

const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorBodySchema } },
});

/** Error responses most routes can produce, to spread into a route's `responses`. */
export const commonErrors = {
  400: err('Bad request'),
  422: err('Validation failed'),
  429: err('Rate limited or quota reached'),
  500: err('Unexpected server error'),
};

export const authErrors = { 401: err('Missing, invalid or expired access token'), ...commonErrors };

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: { 'application/json': { schema } },
});

export const bearer = [{ bearerAuth: [] }];
export { z };
