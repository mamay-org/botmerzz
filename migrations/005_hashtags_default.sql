UPDATE settings
SET settings_json = JSON_SET(settings_json, '$.hashtags', JSON_ARRAY())
WHERE id=1 AND JSON_CONTAINS_PATH(settings_json, 'one', '$.hashtags') = 0;
