import { FEATURE_NAMES, type FeatureName } from '../../config/features';
import type { Config } from '../../env';
import type { Logger } from '../../core/logger';
import type { Clock } from '../../core/time';
import { compareVersions, formatVersion, parseVersion } from '../../lib/semver';
import type { SettingsRepo } from './settings.repo';

export type AppSettings = {
  maintenance: { enabled: boolean; message: string };
  minAppVersion: string;
  latestAppVersion: string;
  disabledFeatures: FeatureName[];
};

export type SettingsPatch = {
  maintenance?: { enabled: boolean; message?: string | null } | null;
  minAppVersion?: string | null;
  latestAppVersion?: string | null;
  disabledFeatures?: FeatureName[] | null;
};

export type UpdateState = 'unknown' | 'none' | 'available' | 'required';

const CACHE_MS = 15_000;
export const DEFAULT_MAINTENANCE_MESSAGE = 'We are making improvements and will be back shortly.';

/**
 * Settings are read on every request (the maintenance gate), so one copy is kept per Worker instance for a few seconds. A change
 * made through the admin API clears the copy on that instance and reaches the others within seconds.
 */
let cache: { db: D1Database; at: number; value: Record<string, string> } | undefined;
export const clearSettingsCache = () => {
  cache = undefined;
};

export class SettingsService {
  constructor(
    private repo: SettingsRepo,
    private db: D1Database,
    private config: Config,
    private clock: Clock,
    private logger: Logger,
  ) {}

  private async rows(): Promise<Record<string, string>> {
    const now = this.clock.now();
    if (cache && cache.db === this.db && now - cache.at >= 0 && now - cache.at < CACHE_MS) return cache.value;
    try {
      const value = await this.repo.list();
      cache = { db: this.db, at: now, value };
      return value;
    } catch (e) {
      // The gate must not take the whole API down with it: fall back to what the deploy configured.
      this.logger.warn('settings unavailable, using deploy defaults', { message: String(e) });
      return {};
    }
  }

  async get(): Promise<AppSettings> {
    const rows = await this.rows();
    const c = this.config;
    const message = rows.maintenanceMessage || c.MAINTENANCE_MESSAGE || DEFAULT_MAINTENANCE_MESSAGE;
    return {
      maintenance: {
        enabled: rows.maintenance !== undefined ? rows.maintenance === 'true' : c.MAINTENANCE_MODE,
        message,
      },
      minAppVersion: rows.minAppVersion ?? c.MIN_APP_VERSION ?? '0.0.0',
      latestAppVersion: rows.latestAppVersion ?? c.LATEST_APP_VERSION ?? '0.0.0',
      disabledFeatures: parseFeatures(rows.disabledFeatures),
    };
  }

  async isEnabled(feature: FeatureName): Promise<boolean> {
    return !(await this.get()).disabledFeatures.includes(feature);
  }

  /** Where this app version stands against the minimum and the newest. An unreadable version is "unknown", never blocked. */
  updateState(appVersion: string | null | undefined, s: AppSettings): UpdateState {
    const v = parseVersion(appVersion);
    if (!v) return 'unknown';
    const min = parseVersion(s.minAppVersion);
    const latest = parseVersion(s.latestAppVersion);
    if (min && compareVersions(v, min) < 0) return 'required';
    if (latest && compareVersions(v, latest) < 0) return 'available';
    return 'none';
  }

  /** `null` removes an override so the deploy's value applies again. */
  async update(patch: SettingsPatch): Promise<AppSettings> {
    const now = this.clock.now();
    const put = async (key: string, value: string | null | undefined) => {
      if (value === undefined) return;
      if (value === null) await this.repo.remove(key);
      else await this.repo.set(key, value, now);
    };
    if (patch.maintenance !== undefined) {
      if (patch.maintenance === null) {
        await put('maintenance', null);
        await put('maintenanceMessage', null);
      } else {
        await put('maintenance', String(patch.maintenance.enabled));
        if (patch.maintenance.message !== undefined)
          await put('maintenanceMessage', patch.maintenance.message);
      }
    }
    // Versions are stored in their canonical form, so "1.4" and "1.4.0" are the same setting.
    for (const key of ['minAppVersion', 'latestAppVersion'] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      await put(key, v === null ? null : formatVersion(parseVersion(v)!));
    }
    if (patch.disabledFeatures !== undefined)
      await put(
        'disabledFeatures',
        patch.disabledFeatures === null ? null : [...new Set(patch.disabledFeatures)].sort().join(','),
      );
    clearSettingsCache();
    return this.get();
  }
}

function parseFeatures(text: string | undefined): FeatureName[] {
  return (text ?? '').split(',').filter((f): f is FeatureName => (FEATURE_NAMES as string[]).includes(f));
}
