-- Claude models are spelled with dashes (`claude-opus-5-5`, Anthropic's API
-- ids, which Claude Code logs); agents that name models from provider
-- catalogs log dots (`claude-opus-5.5`). Ingest now canonicalizes dots to
-- dashes in `claude-…` names (apps/api usage/models.ts); this rewrites stored
-- rows the same way. Where both spellings exist for one (device, date,
-- source), they were synced in the same report as separate usage, so they
-- are summed (not latest-snapshot merged). `counted_by` survives only when
-- every merged row agrees on it; otherwise NULL, which is always replaced.
CREATE TABLE `_claude_model_dashes` AS
WITH `affected` AS (
	SELECT DISTINCT
		`device_id`,
		`date`,
		`source`,
		replace(`model`, '.', '-') AS `canonical_model`
	FROM `usage_days`
	WHERE `model` LIKE 'claude-%' AND instr(`model`, '.') > 0
)
SELECT
	`usage_days`.`device_id`,
	max(`usage_days`.`user_id`) AS `user_id`,
	`usage_days`.`date`,
	`usage_days`.`source`,
	`affected`.`canonical_model` AS `model`,
	sum(`usage_days`.`input_tokens`) AS `input_tokens`,
	sum(`usage_days`.`output_tokens`) AS `output_tokens`,
	sum(`usage_days`.`cache_creation_tokens`) AS `cache_creation_tokens`,
	sum(`usage_days`.`cache_read_tokens`) AS `cache_read_tokens`,
	sum(`usage_days`.`total_tokens`) AS `total_tokens`,
	sum(`usage_days`.`cost_usd`) AS `cost_usd`,
	max(`usage_days`.`synced_at`) AS `synced_at`,
	CASE
		WHEN count(`usage_days`.`counted_by`) = count(*)
			AND count(DISTINCT `usage_days`.`counted_by`) = 1
		THEN max(`usage_days`.`counted_by`)
	END AS `counted_by`
FROM `usage_days`
INNER JOIN `affected`
	ON `affected`.`device_id` = `usage_days`.`device_id`
	AND `affected`.`date` = `usage_days`.`date`
	AND `affected`.`source` = `usage_days`.`source`
	AND `affected`.`canonical_model` = replace(`usage_days`.`model`, '.', '-')
WHERE `usage_days`.`model` LIKE 'claude-%'
GROUP BY
	`usage_days`.`device_id`,
	`usage_days`.`date`,
	`usage_days`.`source`,
	`affected`.`canonical_model`;--> statement-breakpoint
DELETE FROM `usage_days`
WHERE `model` LIKE 'claude-%'
	AND EXISTS (
		SELECT 1
		FROM `_claude_model_dashes`
		WHERE `_claude_model_dashes`.`device_id` = `usage_days`.`device_id`
			AND `_claude_model_dashes`.`date` = `usage_days`.`date`
			AND `_claude_model_dashes`.`source` = `usage_days`.`source`
			AND `_claude_model_dashes`.`model` = replace(`usage_days`.`model`, '.', '-')
	);--> statement-breakpoint
INSERT INTO `usage_days` (
	`device_id`,
	`user_id`,
	`date`,
	`source`,
	`model`,
	`input_tokens`,
	`output_tokens`,
	`cache_creation_tokens`,
	`cache_read_tokens`,
	`total_tokens`,
	`cost_usd`,
	`synced_at`,
	`counted_by`
)
SELECT
	`device_id`,
	`user_id`,
	`date`,
	`source`,
	`model`,
	`input_tokens`,
	`output_tokens`,
	`cache_creation_tokens`,
	`cache_read_tokens`,
	`total_tokens`,
	`cost_usd`,
	`synced_at`,
	`counted_by`
FROM `_claude_model_dashes`;--> statement-breakpoint
DROP TABLE `_claude_model_dashes`;
