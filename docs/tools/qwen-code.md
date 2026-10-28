# Qwen Code

通过 coding-helper enter qwen-code 选择模型并装载。共享事务保存原文件；重复装载不覆盖最初记录，卸载逐字节还原。外部修改会阻止重载和卸载，请先恢复备份再重试。无装载记录时不删除配置。

Use coding-helper enter qwen-code to select and apply a model. Original files are backed up and restored byte-for-byte. External edits block replacement; recover from backup before retrying. No load record means no deletion.

本层不包含 profiles、context 设置或独立模型槽位。 / Profiles, context settings and separate model slots are excluded.
