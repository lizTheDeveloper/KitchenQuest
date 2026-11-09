import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { CONSENT_PURPOSES } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { deleteHealthDataIn } from './health-data.js';
import { consentHistory, grantConsent, isConsentPurpose, withdrawConsentIn } from './ledger.js';
import { NOTICES, noticeSha256 } from './notices.js';

const GrantBody = z
  .object({
    purpose: z.enum(CONSENT_PURPOSES),
    noticeVersion: z.string().min(1).max(64),
    /** How the client collected it; the consent card (C-17) is a tap. */
    method: z.enum(['tap', 'api']).default('api'),
  })
  .strict();

const WithdrawBody = z
  .object({
    /**
     * Required when withdrawing `health_data`: delete it now, or keep it
     * read-only until the player deletes it or the account (C-1).
     */
    healthData: z.enum(['delete', 'keep']).optional(),
  })
  .strict();

export async function consentRoutes(app: FastifyInstance): Promise<void> {
  const { db, now } = app.deps;

  app.get('/me/consents', { preHandler: requireUser }, async (req) => ({
    consents: await consentHistory(db, req.user.id),
    notices: NOTICES,
  }));

  app.post('/me/consents', { preHandler: requireUser }, async (req, reply) => {
    const { purpose, noticeVersion, method } = GrantBody.parse(req.body);
    const notice = NOTICES[purpose];
    if (!notice) throw new ApiError(400, 'bad_request', `Consent for ${purpose} is not offered`);
    if (noticeVersion !== notice.version) {
      throw new ApiError(400, 'bad_request', 'That notice is out of date; show the current one', {
        currentVersion: notice.version,
      });
    }
    const at = now();
    await grantConsent(db, req.user.id, purpose, notice.version, noticeSha256(notice), method, at, req.id);
    const consent = (await consentHistory(db, req.user.id)).filter((c) => c.purpose === purpose && c.withdrawnAt === null).at(-1);
    return reply.status(201).send({ consent });
  });

  app.delete<{ Params: { purpose: string } }>('/me/consents/:purpose', { preHandler: requireUser }, async (req, reply) => {
    const { purpose } = req.params;
    if (!isConsentPurpose(purpose)) throw new ApiError(400, 'bad_request', 'Unknown consent purpose');
    const { healthData } = WithdrawBody.parse(req.body ?? {});
    if (purpose === 'health_data' && healthData === undefined) {
      throw new ApiError(400, 'bad_request', 'Choose whether to delete your health data now or keep it read-only', {
        field: 'healthData',
        options: ['delete', 'keep'],
      });
    }
    const at = now();
    // One transaction: consent is never withdrawn with a requested deletion left undone.
    await db.transaction(async (tx) => {
      await withdrawConsentIn(tx, req.user.id, purpose, at, req.id);
      if (purpose === 'health_data' && healthData === 'delete') await deleteHealthDataIn(tx, req.user.id, at, req.id);
    });
    return reply.status(204).send();
  });
}
