-- Finds photos people agreed to contribute, in time order, without scanning every scan.
CREATE INDEX scan_contributions ON scan_events (created_at, id) WHERE contribute_consent = 1 AND image_key IS NOT NULL;
