import { newId } from '../../core/ids';
import type { Clock } from '../../core/time';
import { encodeCursor, decodeCursor, toPage, type Page } from '../../core/pagination';
import type { AuditRepo, AuditRow } from './audit.repo';

export type AuditEntry = {
  id: string;
  at: number;
  actor: string;
  method: string;
  path: string;
  status: number;
  requestId: string;
};

const toEntry = (r: AuditRow): AuditEntry => ({
  id: r.id,
  at: r.at,
  actor: r.actor,
  method: r.method,
  path: r.path,
  status: r.status,
  requestId: r.request_id,
});

export const AUDIT_RETENTION_MS = 180 * 86_400_000;

/** A record of every call to the admin API, refused ones included. The caller's address is kept only as a keyed hash. */
export class AdminAuditService {
  constructor(
    private repo: AuditRepo,
    private clock: Clock,
  ) {}

  async record(e: {
    actor: string;
    method: string;
    path: string;
    status: number;
    ipHash: string;
    requestId: string;
  }) {
    const at = this.clock.now();
    await this.repo.insert({
      id: newId(at),
      at,
      actor: e.actor.slice(0, 200),
      method: e.method,
      path: e.path.slice(0, 200),
      status: e.status,
      ip_hash: e.ipHash,
      request_id: e.requestId,
    });
  }

  async list(limit: number, cursor: string | undefined): Promise<Page<AuditEntry>> {
    const before = decodeCursor<{ id: string }>(cursor, ['id'])?.id ?? null;
    const rows = await this.repo.list(limit + 1, before);
    return toPage(rows.map(toEntry), limit, (last) => encodeCursor({ id: last.id }));
  }
}
