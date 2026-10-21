import { badRequest, conflict, notFound, validationFailed } from '../../core/errors';
import { newId } from '../../core/ids';
import type { Clock } from '../../core/time';
import { normalizeName } from '../../lib/text';
import { r2Key } from '../media/media.service';
import type { MediaData, MediaRepo, MediaRow } from '../media/media.repo';
import { sniffImageType, type ObjectStorage } from '../media/object-storage';
import type { AdminRepo, ProgramWrite } from './admin.repo';

const UPLOAD_TYPES: Record<string, 'video' | 'image' | 'pdf'> = {
  'video/mp4': 'video',
  'video/webm': 'video',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'application/pdf': 'pdf',
}; // fmt: skip

export const toAdminMedia = (m: MediaRow) => ({
  id: m.id,
  key: m.key,
  kind: m.kind,
  provider: m.provider,
  location: m.location,
  mime: m.mime,
  bytes: m.bytes,
  durationS: m.duration_s,
  title: m.title,
  tier: m.tier,
  uploaded: m.provider !== 'r2' || m.bytes !== null,
}); // fmt: skip

type MediaInput = {
  kind: 'video' | 'image' | 'pdf';
  provider: 'r2' | 'stream' | 'external';
  location?: string | null;
  mime?: string | null;
  durationS?: number | null;
  width?: number | null;
  height?: number | null;
  title?: string | null;
  tier: 'free' | 'pro';
}; // fmt: skip

export class AdminService {
  constructor(
    private repo: AdminRepo,
    private mediaRepo: MediaRepo,
    private storage: ObjectStorage,
    private clock: Clock,
  ) {}

  // ---- media ---------------------------------------------------------------------------------------------------

  async putMedia(key: string, input: MediaInput) {
    const problems: { path: string; message: string }[] = [];
    if (input.provider === 'external') {
      try {
        if (!input.location || new URL(input.location).protocol !== 'https:') throw new Error();
      } catch {
        problems.push({ path: 'location', message: 'External media needs an https URL' });
      }
    }
    if (input.provider === 'stream' && !input.location)
      problems.push({ path: 'location', message: 'Stream media needs the Stream video id' });
    if (problems.length) throw validationFailed(problems);

    const existing = await this.mediaRepo.getByKey(key);
    const data: MediaData = {
      key,
      kind: input.kind,
      provider: input.provider,
      location: input.provider === 'r2' ? null : (input.location ?? null),
      mime: input.mime ?? existing?.mime ?? null,
      bytes: input.provider === 'r2' ? (existing?.bytes ?? null) : null,
      duration_s: input.durationS ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      title: input.title ?? null,
      tier: input.tier,
    }; // fmt: skip
    await this.mediaRepo.upsertByKey(existing?.id ?? newId(this.clock.now()), data, this.clock.now());
    return toAdminMedia((await this.mediaRepo.getByKey(key))!);
  }

  /** Store the bytes of an r2 media entry. */
  async uploadMedia(key: string, contentType: string | undefined, bytes: Uint8Array) {
    const media = await this.mediaRepo.getByKey(key);
    if (!media) throw notFound('Media');
    if (media.provider !== 'r2') throw badRequest('Only media with provider "r2" has a file to upload');
    const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
    const kind = UPLOAD_TYPES[type];
    if (!kind)
      throw badRequest(`Unsupported content type. Use one of: ${Object.keys(UPLOAD_TYPES).join(', ')}`);
    if (kind !== media.kind) throw badRequest(`This entry is a ${media.kind}, but the upload is a ${kind}`);
    if (bytes.length === 0) throw badRequest('The file is empty');
    if (kind === 'image' && sniffImageType(bytes) !== type)
      throw badRequest('The file is not the image type it claims to be');
    await this.storage.put(r2Key(key), bytes, type);
    await this.mediaRepo.upsertByKey(
      media.id,
      { ...media, mime: type, bytes: bytes.length },
      this.clock.now(),
    );
    return toAdminMedia((await this.mediaRepo.getByKey(key))!);
  }

  async deleteMedia(key: string) {
    const media = await this.mediaRepo.getByKey(key);
    if (!media) return;
    if (media.provider === 'r2') await this.storage.delete(r2Key(key));
    await this.mediaRepo.delete(media.id);
  }

  private async mediaId(key: string | null | undefined, field: string): Promise<string | null> {
    if (!key) return null;
    const m = await this.mediaRepo.getByKey(key);
    if (!m) throw validationFailed([{ path: field, message: `No media with key "${key}"; create it first` }]);
    return m.id;
  }

  // ---- exercises -----------------------------------------------------------------------------------------------

  async putExercise(
    slug: string,
    input: {
      name: string;
      muscleGroups: string[];
      equipment: string[];
      difficulty: string;
      instructions: string;
      tips?: string | null;
      imageMediaKey?: string | null;
      videoMediaKey?: string | null;
      source?: string | null;
      licence?: string | null;
    }, // fmt: skip
  ) {
    const existing = await this.repo.getExerciseId(slug);
    await this.repo.upsertExercise(
      {
        id: existing?.id ?? newId(this.clock.now()),
        slug,
        name: input.name,
        nameNorm: normalizeName(input.name),
        muscleGroups: JSON.stringify([...new Set(input.muscleGroups)]),
        equipment: JSON.stringify([...new Set(input.equipment)]),
        difficulty: input.difficulty,
        instructions: input.instructions,
        tips: input.tips ?? null,
        imageMediaId: await this.mediaId(input.imageMediaKey, 'imageMediaKey'),
        videoMediaId: await this.mediaId(input.videoMediaKey, 'videoMediaKey'),
        source: input.source ?? null,
        licence: input.licence ?? null,
      },
      this.clock.now(),
    ); // fmt: skip
    return { slug };
  }

  async deleteExercise(slug: string) {
    try {
      await this.repo.deleteExercise(slug);
    } catch (e) {
      if (e instanceof Error && /FOREIGN KEY|constraint/i.test(e.message)) {
        throw conflict('This exercise is used by a workout. Remove it from the programs first.');
      }
      throw e;
    }
  }

  // ---- programs ------------------------------------------------------------------------------------------------

  async putProgram(
    slug: string,
    input: {
      title: string;
      summary: string;
      description: string;
      level: string;
      goal: string;
      weeks: number;
      daysPerWeek: number;
      equipment: string[];
      coverMediaKey?: string | null;
      tier: string;
      author?: string | null;
      position: number;
      workouts: {
        key: string;
        week: number;
        day: number;
        position: number;
        title: string;
        notes?: string | null;
        estMinutes?: number | null;
        tierOverride?: string | null;
        exercises: {
          exerciseSlug: string;
          sets: number;
          repsMin?: number | null;
          repsMax?: number | null;
          durationS?: number | null;
          restS?: number | null;
          notes?: string | null;
        }[];
      }[];
    }, // fmt: skip
  ) {
    const now = this.clock.now();
    const ids = await this.repo.exerciseIdsBySlug(
      input.workouts.flatMap((w) => w.exercises.map((e) => e.exerciseSlug)),
    );
    const missing = [
      ...new Set(input.workouts.flatMap((w) => w.exercises.map((e) => e.exerciseSlug))),
    ].filter((s) => !ids.has(s));
    if (missing.length)
      throw validationFailed([
        { path: 'workouts', message: `Unknown exercises: ${missing.join(', ')}. Create them first.` },
      ]);
    const coverMediaId = await this.mediaId(input.coverMediaKey, 'coverMediaKey');

    const existing = await this.repo.getProgramBySlug(slug);
    const programId = existing?.id ?? newId(now);
    const existingWorkouts = existing ? await this.repo.existingWorkoutIds(programId) : [];
    const idByKey = new Map(existingWorkouts.map((w) => [w.key, w.id]));
    const write: ProgramWrite = {
      id: programId,
      slug,
      title: input.title,
      summary: input.summary,
      description: input.description,
      level: input.level,
      goal: input.goal,
      weeks: input.weeks,
      daysPerWeek: input.daysPerWeek,
      equipment: JSON.stringify([...new Set(input.equipment)]),
      coverMediaId,
      tier: input.tier,
      author: input.author ?? null,
      position: input.position,
      workouts: input.workouts.map((w) => ({
        id: idByKey.get(w.key) ?? newId(now),
        key: w.key,
        week: w.week,
        day: w.day,
        position: w.position,
        title: w.title,
        notes: w.notes ?? null,
        estMinutes: w.estMinutes ?? null,
        tierOverride: w.tierOverride ?? null,
        exercises: w.exercises.map((e) => ({
          exerciseId: ids.get(e.exerciseSlug)!,
          sets: e.sets,
          repsMin: e.repsMin ?? null,
          repsMax: e.repsMax ?? null,
          durationS: e.durationS ?? null,
          restS: e.restS ?? null,
          notes: e.notes ?? null,
        })),
      })),
    }; // fmt: skip
    await this.repo.writeProgram(write, existingWorkouts, now);
    return {
      slug,
      id: programId,
      published: existing?.published_at != null,
      workouts: write.workouts.length,
    };
  }

  async publish(slug: string) {
    const p = await this.repo.getProgramBySlug(slug);
    if (!p) throw notFound('Program');
    if ((await this.repo.emptyWorkouts(p.id)) > 0)
      throw conflict('Every workout needs at least one exercise before the program can be published');
    await this.repo.setPublished(slug, p.published_at ?? this.clock.now(), this.clock.now());
  }

  async unpublish(slug: string) {
    if ((await this.repo.setPublished(slug, null, this.clock.now())) === 0) throw notFound('Program');
  }

  async deleteProgram(slug: string) {
    await this.repo.deleteProgram(slug);
  }

  async listPrograms() {
    return {
      items: (await this.repo.listPrograms()).map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        tier: p.tier as 'free' | 'pro',
        published: p.published_at !== null,
        workoutCount: p.workout_count,
        updatedAt: p.updated_at,
      })),
    };
  }

  // ---- model feedback ------------------------------------------------------------------------------------------

  async scanAccuracy(modelVersion: string | null) {
    const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
    return {
      models: (await this.repo.accuracy(modelVersion)).map((r) => ({
        modelVersion: r.model_version,
        scans: r.scans,
        notFood: r.not_food ?? 0,
        discarded: r.discarded ?? 0,
        kept: r.kept ?? 0,
        editedShare: r.kept ? Math.round(((r.edited ?? 0) / r.kept) * 1000) / 1000 : null,
        meanCorrectionKcal: r1(r.mean_abs_kcal),
        meanSignedCorrectionKcal: r1(r.mean_signed_kcal),
        contributedPhotos: r.photos ?? 0,
      })),
    }; // fmt: skip
  }
}
