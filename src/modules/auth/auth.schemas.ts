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

export const signInSessionSchema = sessionSchema
  .extend({
    linked: z.boolean().describe('The sign-in method was attached to the signed-in account'),
    created: z.boolean().describe('A brand new account was created'),
  })
  .openapi('SignInSession');

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

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.string().email())
  .openapi({ example: 'person@example.com' });

export const emailStartBodySchema = z.object({ email }).openapi('EmailStartRequest');

export const emailStartResultSchema = z
  .object({
    sent: z.literal(true).describe('Always true, whether or not the address has an account'),
    expiresIn: z.number().int().describe('Seconds the code works for'),
    resendAfter: z.number().int().describe('Seconds to wait before asking for another code'),
  })
  .openapi('EmailStartResult');

export const emailVerifyBodySchema = z
  .object({
    email,
    code: z.string().regex(/^\d{6}$/, 'The code is six digits'),
    deviceLabel,
    discardAnonymousData: googleBodySchema.shape.discardAnonymousData,
  })
  .openapi('EmailVerifyRequest');
