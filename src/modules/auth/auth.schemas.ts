import { z } from '../../core/openapi';

export const sessionSchema = z
  .object({
    accessToken: z.string().describe('Short-lived JWT; send as `Authorization: Bearer ...`'),
    refreshToken: z
      .string()
      .describe('Long-lived, single use. Store securely and replace it every time you refresh.'),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().describe('Seconds until the access token expires'),
    userId: z.string(),
    isAnonymous: z.boolean().describe('True until a sign-in method such as Google is linked'),
  })
  .openapi('Session');

export const googleSessionSchema = sessionSchema
  .extend({
    linked: z.boolean().describe('The Google account was attached to the signed-in anonymous account'),
    created: z.boolean().describe('A brand new account was created'),
  })
  .openapi('GoogleSession');

const deviceLabel = z.string().trim().min(1).max(64).optional();

export const anonymousBodySchema = z.object({ deviceLabel }).openapi('AnonymousRequest');

export const googleBodySchema = z
  .object({
    idToken: z.string().min(20).max(8192),
    deviceLabel,
    discardAnonymousData: z
      .boolean()
      .default(false)
      .describe(
        'Confirm that data on this anonymous account may be left behind when the Google account already has data',
      ),
  })
  .openapi('GoogleRequest');

export const refreshBodySchema = z
  .object({ refreshToken: z.string().min(20).max(256) })
  .openapi('RefreshRequest');
