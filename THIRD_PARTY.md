# 第三方来源

本仓库独立维护，不自动同步上游。保留来源是为了追溯实现与许可证，不承诺继续兼容官方 AS 方言。

| 组成 | 初始来源 | 许可证 |
| --- | --- | --- |
| 语言服务与调试客户端 | Hazelight/vscode-unreal-angelscript，初始提交 `ffc7ab2`，版本 1.9.4 | 根目录 LICENSE |
| AS 格式化适配、默认样式与样例 | Hazelight/vscode-unreal-angelscript-formatter，提交 `8f49f65102404757e46df7d41cd4d7ec4eb5205c`，版本 3.1.0 | licenses/formatter-MIT.txt；包含原 vscode-clang-format 的版权说明 |
| clang-format 分发与路径选择 | npm clang-format-node 2.0.7，程序版本 21.1.8 | 随 npm 包保留 LICENSE.md；LLVM 许可证另见 licenses/LLVM.txt |
| XML 格式化编辑解析 | npm sax 1.4.4 | licenses/sax.txt（BlueOak-1.0.0） |

本地修改包括 export/Global 语言支持、统一扩展注册与配置入口、目标文档对应的工作区设置解析、输入时格式化的错误传播，以及独立于语言服务加载的格式化程序解析。后续修改按定制引擎契约维护与测试。
