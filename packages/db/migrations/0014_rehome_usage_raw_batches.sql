-- Raw report rows used to keep the user id they were first ingested under,
-- while usage_days followed device re-approval and account merges. Re-home
-- every row whose device still exists to that device's current owner.
-- Rows for already-deleted devices are left for an out-of-band cleanup:
-- their R2 objects cannot be removed from SQL.
UPDATE `usage_raw_batches`
SET `user_id` = (
	SELECT `devices`.`user_id`
	FROM `devices`
	WHERE `devices`.`id` = `usage_raw_batches`.`device_id`
)
WHERE EXISTS (
	SELECT 1
	FROM `devices`
	WHERE `devices`.`id` = `usage_raw_batches`.`device_id`
		AND `devices`.`user_id` <> `usage_raw_batches`.`user_id`
);
