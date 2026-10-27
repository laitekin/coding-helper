# Copilot / Claude launcher

先通过 coding-helper auth 设置 Key，再在 enter copilot 选择模型，使用 coding-helper run copilot -- <args> 启动。只向子进程注入 COPILOT_PROVIDER_* 与 COPILOT_MODEL，不写客户端配置。Claude 可使用 coding-helper run claude -- <args>；已有 settings.json 的 /model 设置仍由客户端处理，需要时传入客户端 --model 参数明确覆盖。

Set the key with coding-helper auth, select a model in enter copilot, then use coding-helper run copilot -- <args>. Only subprocess environment is changed. Claude also supports run claude; existing settings.json selections remain effective unless overridden with the client --model option. Requires client versions supporting these environment variables.
