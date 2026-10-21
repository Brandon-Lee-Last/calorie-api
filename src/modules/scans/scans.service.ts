import { badRequest, conflict, notFound } from '../../core/errors';
import type { Clock } from '../../core/time';
import { sanitizeClientTime } from '../../core/validation';
import { stripMetadata } from '../../lib/image-metadata';
import { IMAGE_TYPES, type ImageType, type ObjectStorage } from '../media/object-storage';
import type { ScanData, ScanRow, ScansRepo } from './scans.repo';

export type ScanInput = {
  modelVersion: string;
  foodProbability?: number | null;
  predicted?: ScanData['predicted'];
  outcome: ScanData['outcome'];
  final?: ScanData['final'];
  portion?: number | null;
  contributeConsent: boolean;
  clientCreatedAt: number;
}; // fmt: skip

export const MAX_CONTRIBUTION_BYTES = 3 * 1024 * 1024;

export const contributionKey = (userId: string, scanId: string, type: ImageType) =>
  `contrib/${userId}/${scanId}.${IMAGE_TYPES[type]}`;

const nut = (c: number | null, m: number | null, f: number | null, cb: number | null, p: number | null) =>
  c === null ? null : { calories: c, massG: m ?? 0, fatG: f ?? 0, carbG: cb ?? 0, proteinG: p ?? 0 };

export const toScan = (r: ScanRow) => ({
  id: r.id,
  modelVersion: r.model_version,
  foodProbability: r.food_probability,
  predicted: nut(r.pred_calories, r.pred_mass_g, r.pred_fat_g, r.pred_carb_g, r.pred_protein_g),
  outcome: r.outcome,
  final: nut(r.final_calories, r.final_mass_g, r.final_fat_g, r.final_carb_g, r.final_protein_g),
  portion: r.portion,
  contributeConsent: r.contribute_consent === 1,
  hasContributedPhoto: r.image_key !== null,
  clientCreatedAt: r.client_created_at,
  createdAt: r.created_at,
}); // fmt: skip

export class ScansService {
  constructor(
    private repo: ScansRepo,
    private storage: ObjectStorage,
    private clock: Clock,
    /** Called once for each new scan, to count it towards the daily total the app shows. */
    private onNewScan: (userId: string) => Promise<void> = async () => {},
  ) {}

  async record(userId: string, id: string, input: ScanInput) {
    const now = this.clock.now();
    if (await this.repo.idTakenByAnother(userId, id)) throw conflict('That id is already in use');
    const before = await this.repo.get(userId, id);
    await this.repo.upsert(
      userId,
      id,
      {
        modelVersion: input.modelVersion,
        foodProbability: input.foodProbability ?? null,
        predicted: input.predicted ?? null,
        outcome: input.outcome,
        final: input.final ?? null,
        portion: input.portion ?? null,
        contributeConsent: input.contributeConsent,
        clientCreatedAt: sanitizeClientTime(input.clientCreatedAt, now),
      },
      now,
    );
    if (!before) await this.onNewScan(userId);
    // Taking consent back removes the photo that was given under it.
    if (before?.image_key && !input.contributeConsent) {
      await this.storage.delete(before.image_key);
      await this.repo.setImageKey(userId, id, null);
    }
    return toScan((await this.repo.get(userId, id))!);
  }

  /** The photo behind a scan, kept only when the person agreed to contribute it. */
  async contributePhoto(userId: string, id: string, upload: { bytes: Uint8Array; type: ImageType }) {
    const scan = await this.repo.get(userId, id);
    if (!scan) throw notFound('Scan');
    if (scan.contribute_consent !== 1)
      throw badRequest('The person has not agreed to contribute this photo', { reason: 'no_consent' });
    const key = contributionKey(userId, id, upload.type);
    // A contributed photo is kept for training, so it goes in without the position and device details the phone wrote into it.
    await this.storage.put(key, stripMetadata(upload.bytes, upload.type), upload.type);
    if (scan.image_key && scan.image_key !== key) await this.storage.delete(scan.image_key);
    await this.repo.setImageKey(userId, id, key);
    return toScan((await this.repo.get(userId, id))!);
  }

  async deleteContribution(userId: string, id: string) {
    const scan = await this.repo.get(userId, id);
    if (!scan?.image_key) return;
    await this.storage.delete(scan.image_key);
    await this.repo.setImageKey(userId, id, null);
  }

  async get(userId: string, id: string) {
    const scan = await this.repo.get(userId, id);
    if (!scan) throw notFound('Scan');
    return toScan(scan);
  }
}
