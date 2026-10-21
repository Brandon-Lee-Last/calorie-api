-- Shared catalogue foods can be tied to a dish id from the model's taxonomy and found by other names.
ALTER TABLE foods ADD COLUMN dish_id TEXT;
ALTER TABLE foods ADD COLUMN aliases_norm TEXT;
CREATE INDEX foods_catalogue_dish ON foods (dish_id) WHERE user_id IS NULL AND dish_id IS NOT NULL AND deleted_at IS NULL;
