CREATE TABLE `_usage_days_normalized` AS
WITH `normalized` AS (
	SELECT
		`device_id`,
		`user_id`,
		`date`,
		`source`,
		`model`,
		CASE
			WHEN lower(substr(`model`, 1, length(`source`) + 2)) = lower('[' || `source` || ']')
				AND length(ltrim(substr(`model`, length(`source`) + 3))) > 0
			THEN ltrim(substr(`model`, length(`source`) + 3))
			ELSE `model`
		END AS `normalized_model`,
		`input_tokens`,
		`output_tokens`,
		`cache_creation_tokens`,
		`cache_read_tokens`,
		`total_tokens`,
		`cost_usd`,
		`synced_at`
	FROM `usage_days`
),
`affected_keys` AS (
	SELECT DISTINCT
		`device_id`,
		`date`,
		`source`,
		`normalized_model`
	FROM `normalized`
	WHERE `model` <> `normalized_model`
),
`latest` AS (
	SELECT
		`normalized`.*,
		max(`normalized`.`synced_at`) OVER (
			PARTITION BY
				`normalized`.`device_id`,
				`normalized`.`date`,
				`normalized`.`source`,
				`normalized`.`normalized_model`
		) AS `latest_synced_at`
	FROM `normalized`
	INNER JOIN `affected_keys`
		ON `affected_keys`.`device_id` = `normalized`.`device_id`
		AND `affected_keys`.`date` = `normalized`.`date`
		AND `affected_keys`.`source` = `normalized`.`source`
		AND `affected_keys`.`normalized_model` = `normalized`.`normalized_model`
)
SELECT
	`device_id`,
	max(`user_id`) AS `user_id`,
	`date`,
	`source`,
	`normalized_model` AS `model`,
	sum(`input_tokens`) AS `input_tokens`,
	sum(`output_tokens`) AS `output_tokens`,
	sum(`cache_creation_tokens`) AS `cache_creation_tokens`,
	sum(`cache_read_tokens`) AS `cache_read_tokens`,
	sum(`total_tokens`) AS `total_tokens`,
	sum(`cost_usd`) AS `cost_usd`,
	`latest_synced_at` AS `synced_at`
FROM `latest`
WHERE `synced_at` = `latest_synced_at`
GROUP BY `device_id`, `date`, `source`, `normalized_model`, `latest_synced_at`;--> statement-breakpoint
DELETE FROM `usage_days`
WHERE EXISTS (
	SELECT 1
	FROM `_usage_days_normalized`
	WHERE `_usage_days_normalized`.`device_id` = `usage_days`.`device_id`
		AND `_usage_days_normalized`.`date` = `usage_days`.`date`
		AND `_usage_days_normalized`.`source` = `usage_days`.`source`
		AND `_usage_days_normalized`.`model` = CASE
			WHEN lower(substr(`usage_days`.`model`, 1, length(`usage_days`.`source`) + 2)) = lower('[' || `usage_days`.`source` || ']')
				AND length(ltrim(substr(`usage_days`.`model`, length(`usage_days`.`source`) + 3))) > 0
			THEN ltrim(substr(`usage_days`.`model`, length(`usage_days`.`source`) + 3))
			ELSE `usage_days`.`model`
		END
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
	`synced_at`
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
	`synced_at`
FROM `_usage_days_normalized`;--> statement-breakpoint
DROP TABLE `_usage_days_normalized`;
