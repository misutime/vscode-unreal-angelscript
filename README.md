# Unreal AngelScript (Misutime)

本仓库独立维护定制 UE AngelScript 的语言服务、调试与格式化，扩展标识为 `misutime.unreal-angelscript`，当前版本为 1.13.0。成员回调覆盖原生单播委托，以及原生动态多播/稀疏事件的订阅与解除。初始语言服务来自 Hazelight 1.9.4，格式化适配来自官方格式化插件 3.1.0。后续以我们的 AS 引擎为兼容目标，不要求与官方方言继续兼容；上游改动按需要选择采纳。

安装后卸载 `hazelight.unreal-angelscript` 和 `hazelight.unreal-angelscript-clang-format`，避免重复提供语言与格式化能力。原设置名称、快捷键和格式化配置生成命令继续沿用。语言服务原许可证见 [LICENSE](LICENSE)，格式化适配与二进制来源见 [第三方来源](THIRD_PARTY.md)。

## 本地维护与安装

在仓库根目录运行以下命令。Node.js 24 已在本机验证；根目录及两个子项目均保留依赖锁文件。

```powershell
npm ci
npm run compile
npm run typecheck
npm test
npm run package:local
code --install-extension .\dist\unreal-angelscript-misutime.vsix --force
code --uninstall-extension hazelight.unreal-angelscript
code --uninstall-extension hazelight.unreal-angelscript-clang-format
```

`npm run compile` 会先重新生成语法，再构建客户端与语言服务器。`typecheck` 检查项目 TypeScript，跳过第三方声明文件检查。`npm test` 包含语言检查与真实 VS Code 扩展宿主中的格式化回归，后者使用隔离的用户数据和扩展目录，不更改日常 VS Code 窗口，也不需要启动 UE。Windows 默认使用本机安装的 VS Code；其他环境可以设置 `AS_TEST_VSCODE` 为可执行文件路径，否则测试工具下载测试用 VS Code。最低支持 VS Code 1.108.1。

VSIX 安装后，在已打开的 VS Code 中执行“开发人员: 重新加载窗口”。如果用户或工作区设置曾将 `[angelscript].editor.defaultFormatter` 指向旧格式化扩展，需要改成 `misutime.unreal-angelscript`；扩展提供的默认值不能覆盖用户明确指定的旧值。

以后从本仓库重新构建、安装 VSIX，不再直接修改官方扩展安装目录。`origin` 指向自有 GitHub 仓库，`upstream` 作为官方参考入口。采纳上游代码时检查语法、语言数据库、调试协议及格式化行为，重新执行上述验证；不自动合并上游。

## 内置格式化

主插件提供整文件、选区和输入时格式化，默认使用内置 clang-format 21.1.8，也可指定自定义程序。原配置键 `unreal-angelscript-clang-format.executable` 和 `unreal-angelscript-clang-format.style` 保留，路径支持工作区相对路径。运行 `Unreal AngelScript (Misutime): Generate Formatting Config` 创建默认样式副本；项目样式需要在 style 设置中明确指定，未指定时使用扩展内置样式。

`UnrealAngelscript.formatting.enabled` 控制内置格式化是否生效。保存时和输入时的自动触发仍由 VS Code 的 `editor.formatOnSave` 与 `editor.formatOnType` 控制，不在升级时更改这些用户偏好。格式化适配保留 AS 的特殊语法过滤和 UTF-8 编辑位置转换，并保护 export、local、mixin 等声明修饰词。内置程序按需加载，找不到匹配平台的二进制时仅格式化报告失败，语言服务仍可启动；此时可以指定自定义程序。

2026 年 10 月 12 日，构建、TypeScript 检查及语言回归通过，覆盖 Global、14 组结构化类、6 组字段角色、19 组成员回调和 6 组配置规则。隔离 VS Code 1.108.1 中的 24 组宿主检查同时验证格式化、实际四份 Asasi 脚本的语义保持与幂等，以及跳转、悬停、重命名、字段标记、Required、impl 职责标题和原生多播订阅/解除。日常安装版 1.13.0 重跑相同 24 组检查通过。宿主使用独立反射夹具，不连接正在使用的 UE 项目。内置程序携带上游提供的八个平台版本，本轮只实跑 Windows x64。

## config、state 与同文件 impl

当前扩展识别定制引擎的结构化类语法。数据仍直接属于原类，各实现块共享同一个类型与访问权限，不创建额外配置对象。

```angelscript
class UCameraControl : UActorComponent
{
    config
    {
        UPROPERTY()
        UInputAction ZoomAction;
        float DefaultDistance = 1600.0;
    }
    state
    {
        float CurrentDistance = 0.0;
    }
}

// 输入与状态更新
impl UCameraControl
{
    UFUNCTION(BlueprintCallable)
    void ResetDistance()
    {
        CurrentDistance = DefaultDistance;
    }
}

// 查询
impl UCameraControl
{
    float GetDistance() const
    {
        return CurrentDistance;
    }
}
```

一个类最多有一个 config 区和一个 state 区，可有多个 impl 块；impl 必须位于同文件、同命名空间中已经声明的脚本类之后。新式类的方法放入 impl，组件声明和 default 语句留在 class。字段区默认 private，显式 protected 或既有 access 规则仍可使用。config 在业务方法中只读；UPROPERTY 的配置默认仅在类默认值中编辑并隐藏蓝图访问，state 默认不可编辑且隐藏蓝图访问。config/state 显式 BlueprintReadOnly 自动补齐私有字段的蓝图读取权限；state 已默认不可编辑，不重复写 NotEditable。BlueprintReadWrite 和 BlueprintSetter 与字段角色冲突。传统内联 class 仍可使用，普通名为 config、state、impl 的标识符不会被全局保留。

扩展提供上下文高亮、字段角色悬停、私有成员补全、分块大纲、原始声明位置跳转、引用搜索、重命名及重新解析后的符号清理。离线规则检查覆盖声明位置、重复字段区、矛盾宏和直接配置写入；可写引用、容器原地修改、UE 绑定与最终编译是否合法，仍由配套引擎编译器判断。格式化保护 class 与 impl 的换行边界，不搬移方法或改写语义。impl 大纲标题使用块前职责注释，缺少注释时保留原类型名。

`UPROPERTY(Required)` 声明 config 的 UObject 硬引用必须配置。补全只在 config 中提供，悬停解释用途；离线诊断拒绝错误字段区、参数值、已知不支持的类型和保留元数据。实际资产是否完整由 UE Data Validation 检查，工具不能从 AS 初值推断蓝图继承后的配置。该声明不会自动填值、改变输入绑定或替代运行时 IsValid。

字段名的声明与使用处由语言服务器根据实际角色标记：config 默认为金色，state 默认为青绿色；名称相同的局部变量和参数仍使用各自的普通标记。继承与 this 访问沿用声明字段的角色，传统成员不自动归类。深色主题使用金色 `#D7BA7D`、青绿色 `#4EC9B0`；名称包含 Light 的浅色主题使用深金色 `#865500`、深青绿色 `#006D62`。配色属于扩展提供的默认值，安装不写入用户设置。

补全列表在字段名旁显示 `[config 配置]` 或 `[state 状态]`，同时保留原类型；补全详情也显示角色。选择补全仍只插入原字段名，跳转、引用搜索和重命名使用原符号。字段角色重新解析后，颜色与标签随声明更新，不通过变量名前缀推断。

语义分类使用 `as_config_field`、`as_state_field` 两个 property 子类型，着色规则为 `as_config_field:angelscript` 和 `as_state_field:angelscript`。用户可在 `editor.semanticTokenColorCustomizations` 中覆盖；浅色主题的默认规则在 `[*Light*]` 内，针对浅色主题自定义时可覆盖该组。AS 默认启用语义高亮，在 `[angelscript]` 中显式关闭 `editor.semanticHighlighting.enabled` 仍有效。这些设置使用 [VS Code 官方语义高亮机制](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide)，不改变脚本访问语法，也不新增游戏运行时对象。

扩展升级本身不赋予旧 UE 二进制新语法能力。配套引擎的源码实现、DLL 链接与运行验收分别记录；工具验证通过不能替代引擎验收，也不会迁移现有游戏脚本。

## 成员方法回调

语言服务支持在有明确原生单播 void 委托类型的位置使用 `this.Method`，包括方法实参、显式委托变量初始化和赋值；原生多播事件使用 `Event.Add(this.Method)` / `Event.Unbind(this.Method)`。方法必须由当前脚本类声明，带 `UFUNCTION()`，返回 `void`，参数为原生签名的连续前缀。可以完全不声明参数，但不能跳过中间参数、转换类型宽度或声明引用、输出参数。其他对象接收者、继承目标、重载、蓝图事件、覆写、RPC、构造期绑定和 `auto` 方法值不支持；脚本自定义 event/delegate 不因本次升级获得成员引用。

例如原生输入委托有四个参数，而缩放只使用第一个，可以写 `Input.BindAction(Action, ETriggerEvent::Triggered, this.OnZoom)`，对应 `UFUNCTION() private void OnZoom(FInputActionValue Value)`。重置可以使用零参数方法。格式器保留成员引用，不把它改成调用，也不改写作者的方法签名。

委托位置的 `this.` 补全筛选合法方法，显示 `[回调 k/n]`，选择和解析补全都只插入方法名，用户开启自动插入括号也不会把回调变成调用。定义跳转、引用、重命名和语义高亮复用真实方法符号；悬停与签名帮助显示完整委托及保留前缀。缺失方法的生成操作按原生完整签名生成，作者再明确删去不用的尾部参数。已有对象／名字绑定仍要求完整签名，委托字段的普通复制和赋值保持原语义。

多播订阅与解除共享方法符号，常规与稀疏动态事件采用相同作者写法。事件内部签名辅助类型不作为新用户类型显示；补全描述、方法提示与悬停展示原生事件名称和参数。Add 按接收者及入口去重，Unbind 只移除对应方法，生命周期清理仍需显式执行；完整签名兼容旧名字绑定的身份，短签名解除使用成员引用。多播 IsBound 只说明列表中仍有订阅项，不保证接收者有效。

工具回归覆盖上述规则、连续解析时清理旧绑定记录，以及隔离扩展宿主中的真实补全解析、跳转、重命名、中文注释、整文件、选区和输入格式化。源码引擎已验证自动适配、方法体软重载、PIE 中结构变更拒绝换入及失败回滚、缓存冷启动和接收者生命周期；真实相机已使用三个成员引用与 1、0、1 参数回调。引擎规则与具体验证范围见 `UnrealEngine-release/docs/AngelScript成员方法回调绑定设计.md`。

## export 与 Global::

本地扩展支持定制引擎的公开自由函数语法：

```cpp
export bool IsValidTarget(AActor Target)
{
    return Target != nullptr;
}

// 其他文件使用显式 Global 前缀。
bool CanAttack(AActor Target)
{
    return Global::IsValidTarget(Target);
}
```

导出函数仍由原文件持有；本文件可以直接调用，其他文件必须使用 `Global::`。普通自由函数不因这次改动加入 Global，已有 namespace 行为保持原样。扩展提供 export 高亮与解析、Global 补全、原声明跳转、悬停、引用搜索和重命名；本地名称与 Global 入口关联为同一函数。重复引擎信息同步保留源码位置，移除 export 后清理入口。函数重名、非法声明位置与保留名约束由定制引擎编译器最终判断。

2026 年 10 月 3 日，上述语言功能的自动检查与本地构建通过。完整 UE 调试交互尚未在新扩展中人工验收；定制引擎的编译与运行验收范围由引擎维护文档记录。官方引擎未实现 export 语法，安装扩展本身不会赋予引擎这项能力。

下文保留官方扩展的功能说明。

Language Server and Debug Adapter for use with the UnrealEngine-Angelscript plugin from https://angelscript.hazelight.se

## Getting Started
After building or downloading the Unreal Editor version with Angelscript
enabled from the github page linked above, start the editor and use visual
studio code to open the 'Script' folder created in your project directory.
Your 'Script' folder must be set as the root/opened folder for the extension to
function.

## Features
### Editor Connection
The unreal-angelscript extension automatically makes a connection to the
running Unreal Editor instance for most of its functionality. If the editor
is not running, certain features will not be available.

### Code Completion
The extension will try to complete your angelscript code as you type it
using normal visual studio code language server features.

### Error Display
When saving a file the unreal editor automatically compiles and reloads it,
sending any errors to the visual code extension. Errors will be highlighted
in the code display and in the problems window.

### Debugging
You can start debugging from the Debug sidebar or by pressing F5. While
debug mode is active, breakpoints can be set in angelscript files and
the unreal editor will automatically break and stop execution when
they are reached.

Hitting 'Stop' on the debug toolbar will not close the unreal editor,
it merely stops the debug connection, causing breakpoints to be ignored.

When the debug connection is active, any exceptions that occur during
angelscript execution will automatically cause the editor and visual
studio code to pause execution and show the exception.

### Go to Symbol
The default visual studio code 'Go to Definition' (F12) is implemented for
angelscript symbols. A separate command is added to the right click menu
(default shortcut: Alt+G), named 'Go to Symbol'. This command functions
identically to 'Go to Definition' for angelscript symbols.

If you have the Unreal Editor open as well as Visual Studio proper showing
the C++ source code for unreal, the extension will try to use its
unreal editor connection to browse your Visual Studio to the right place,
similar to double clicking a C++ class or function in blueprints.

This uses the standard unreal source navigation system, which is only
implemented for classes and functions.

### More Language Features
This extension acts as a full language server for angelscript code. This includes
semantic highlighting, signature help, reference search, rename symbol and a number
of helpful code actions and quickfixes.

Some of these features require an active connection to the unreal editor.

### Semantic Symbol Colors
There are more types of semantic symbols generated by the extension than there
are colors specified by most color themes.

The default visual studio code color theme will display all variables in blue,
for example, regardless of whether the variable is a member, parameter or local.

You can add a snippet to your `.vscode/settings.json` inside your project folder
to add extra colors to make these differences more visible.

For example, to add extra colors to the default vscode dark theme:

```
    "editor.tokenColorCustomizations": {
		"[Default Dark+]": {
			"textMateRules": [
				{
					"scope": "support.type.component.angelscript",
					"settings": {
						"foreground": "#4ec962"
					}
				},
				{
					"scope": "support.type.actor.angelscript",
					"settings": {
						"foreground": "#2eb0c9"
					}
				},
				{
					"scope": "variable.parameter.angelscript",
					"settings": {
						"foreground": "#ffe5d9"
					}
				},
				{
					"scope": "variable.other.local.angelscript",
					"settings": {
						"foreground": "#e8ffed"
					}
				},
				{
					"scope": "variable.other.global.angelscript",
					"settings": {
						"foreground": "#b99cfe"
					}
				},
				{
					"scope": "variable.other.global.accessor.angelscript",
					"settings": {
						"foreground": "#b99cfe"
					}
				},
				{
					"scope": "entity.name.function.angelscript",
					"settings": {
						"foreground": "#b99cfe"
					}
				},
			]
		}
	}
```
