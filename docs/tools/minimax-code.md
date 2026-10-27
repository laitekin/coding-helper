# MiniMax Code

使用 coding-helper enter minimax-code 配置。官方 mcode provider add 在临时数据目录中运行，成功并校验后才通过共享事务写回；Key 通过环境变量传入，错误输出不回显凭据。卸载还原原文件。需要安装支持 MINIMAX_DATA_DIR/MAVIS_DATA_DIR 的 mcode，命令可能进行远端连通性检测。

Run coding-helper enter minimax-code. The official provider command runs in a temporary data directory; validated output is committed through the shared transaction. The key is passed by environment, and raw command errors are withheld. Unload restores original bytes. Requires mcode support for its data-directory overrides; the provider command may perform network checks.
