# VSCode Wallpaper Engine（非官方修复分支 0.3.2）

> [!IMPORTANT]
> **这是非官方修改分支（unofficial fork），不是原作者发布的官方版本。**
>
> - 原项目：[vakesamahere/vscode-wallpaper-engine](https://github.com/vakesamahere/vscode-wallpaper-engine)
> - 原作者：**vakesamahere（Vake）**
> - 原项目许可证：**MIT License**，`Copyright (c) 2025 Vake`
> - 本分支基于原项目 **v0.0.5**，主要增加了 VS Code 1.147 / Electron 43 适配、Scene 实时渲染、场景属性控制、透明度控制台、壁纸同步和预览窗口隐藏等改动。
> - 本分支由本仓库维护者独立修改，**与原作者无隶属关系，也未获得原作者背书**。
>
> 原项目的代码、设计与版权归原作者所有。完整来源声明见 [NOTICE.md](NOTICE.md)，许可证见 [LICENSE.txt](LICENSE.txt)。

## 这个分支做了什么

本分支基于原项目 **v0.0.5**，针对 VS Code **1.147 / Electron 43** 重写了注入层，修复了原版在新版 VS Code 上“注入成功但完全不显示 / 不透明 / 场景壁纸黑屏”的问题，并新增：

- **Scene 壁纸真实实时渲染**：由 Wallpaper Engine 在屏幕外渲染，逐帧送到 VS Code，不再是封面图。
- **Scene 属性控制**：bool / color / slider / combo，修改只作用于隔离副本，不改桌面 WE 配置。
- **可视化透明度控制台**：各 UI 区域 0–100% 实时调节。
- **同步 Wallpaper Engine**：跟随当前桌面壁纸，并监听切换。
- **隐藏 Scene 预览窗口**：不出现在任务栏 / Alt+Tab，后台仍可正常抓帧。
- **视频 / Web / Scene 全类型支持**，以及自定义 CSS / JS。

## 功能

| 功能 | 说明 |
| --- | --- |
| 视频壁纸 | `.mp4 / .webm / .mov`，自动循环、静音、封面裁剪 |
| Web 壁纸 | 通过本地服务加载 Wallpaper Engine 的 Web 类型壁纸（含 WE API mock） |
| 场景壁纸 | **WE 实时渲染**：由 Wallpaper Engine 在屏幕外渲染真实场景，逐帧送到 VS Code，不再是封面图 |
| 场景属性控制 | 开关 / 颜色 / 滑块 / 下拉，全部来自壁纸作者的 `project.json`，修改后 2 秒内生效 |
| 界面透明化 | 编辑区 / 侧边栏 / 面板 / 终端 / 活动栏 / 标题栏 / 状态栏 / 标签栏，逐项 0–100% 调节 |
| 实时预览 | 拖动滑块即刻生效，无需重载窗口 |
| 同步 WE | 读取 Wallpaper Engine `config.json`，跟随当前正在使用的壁纸，并监听切换 |
| 自定义 CSS | 注入任意 CSS 做进一步美化 |

## 安装

1. VS Code → 扩展面板右上角 `...` → **从 VSIX 安装**，选择
   `vscode-wallpaper-engine-0.3.2.vsix`。
2. 首次启用会修改 VS Code 安装目录下的 `workbench.html`（用于注入壁纸层），
   并自动备份为 `workbench.html.vswe-orig`。若 VS Code 安装在 `Program Files`，
   需要以管理员身份运行一次 VS Code（或让安装目录可写）。
3. 安装后插件会自动注入并重新加载一次窗口；如果没有自动重载，手动执行
   `Ctrl+Shift+P` → `Developer: Reload Window`。

## 配置

打开设置（`Ctrl+,`）搜索 `vscode-wallpaper-engine`：

- `workshopPath`：创意工坊目录，例如
  `D:/Program Files/steam/steamapps/workshop/content/431960`
- `wallpaperEnginePath`：可选，留空自动推断
- `autoSync`：跟随 Wallpaper Engine 当前壁纸（默认开启）

## 使用

| 命令 | 作用 |
| --- | --- |
| `Set Wallpaper: 设置壁纸` | 从创意工坊中选择壁纸 |
| `Sync with Wallpaper Engine: 同步当前壁纸` | 立即同步 WE 正在使用的壁纸 |
| `Open Wallpaper Settings: 打开壁纸设置` | **透明度控制台**（滑块实时生效） |
| `Refresh Wallpaper: 刷新壁纸` | 重新加载媒体 |
| `Restart Scene Render: 重启场景实时渲染` | 场景卡住/异常时重启 WE 弹窗与抓帧 |
| `Disable Wallpaper: 关闭壁纸` | 隐藏壁纸层 |
| `Repair Installation: 修复安装校验` | 重新注入并修复 `product.json` 校验值（出现“安装似乎损坏”时使用） |
| `Uninstall Wallpaper Engine: 卸载注入` | 还原 `workbench.html` 并清理注入 |

### 透明度控制台

`Ctrl+Shift+P` → `Open Wallpaper Settings`：

- **壁纸不透明度**：控制壁纸本身亮度（建议 35%–70%）
- **界面透明化**：每个区域的 0–100% 不透明度，0 = 完全透明
- 预设：全透明 / 柔和 / 全部不透明
- 透明基底色：留空自动跟随深/浅色主题
- 自定义 CSS

## 关于“场景（Scene）”壁纸

场景壁纸是 Wallpaper Engine 私有的 `.pkg`（着色器 + 粒子系统），Electron 无法直接渲染。
0.3.0 起改为**真实实时渲染**（0.3.1 修复了窗口失焦后停止刷新、多个 VS Code 窗口连错端口的问题）：

1. 插件把你选中的场景**复制到扩展的存储目录**，属性只写进这份副本；
2. 用 `wallpaper64.exe -control openWallpaper ... -playInWindow "VSWE Scene ..."`
   打开一个**带标题的弹出窗口**，然后把它移到屏幕外（-3000,-3000）；
3. 扩展内置的 `bin/scene-helper.exe` 用 `PrintWindow(PW_RENDERFULLCONTENT)`
   抓取该窗口画面，压缩成 JPEG，通过本地 HTTP 流送进 VS Code 背景。

**为什么这样不会换掉桌面壁纸？**
因为始终带 `-playInWindow`，Wallpaper Engine 只会新开一个窗口，
不会写入 `config.json` 里的 `selectedwallpapers`（桌面壁纸配置）。
关闭 VS Code 时插件会关闭自己创建的窗口并结束抓帧进程。

### 场景属性控制

打开 `Open Wallpaper Settings`，当壁纸是 Scene 类型时会多出「场景控制」面板：

- 自动读取壁纸作者定义的所有属性（bool / color / slider / combo / 文本说明）
- 初始值取自 Wallpaper Engine 当前桌面实例的属性（`wproperties`），所以和桌面一致
- 修改属性 → 只改副本 → 重启一次预览窗口（约 2 秒）→ 新画面立刻出现在 VS Code 里
- 可调场景帧率（5–60 FPS）；渲染尺寸按 VS Code 窗口自动匹配

> 预览窗口会设置 `WS_EX_TOOLWINDOW` 并从任务栏移除，因此不会出现在任务栏 / Alt+Tab；
> 它仍然在屏幕外正常渲染，PrintWindow 抓帧不受影响。
>
> 说明：Wallpaper Engine 的命令行 `applyProperties` 对弹出窗口无效（实测不会生效），
> 因此这里采用「隔离副本 + 重启窗口」的方式，效果稳定且绝不改动桌面配置。

## 常见问题

**壁纸不显示？**
1. 确认 `workshopPath` 正确；
2. 执行一次 `Set Wallpaper` 后重载窗口；
3. 查看输出面板 `Wallpaper Engine` 与开发者工具控制台（`Ctrl+Shift+I`）中的 `[VSWE]` 日志。

**场景显示封面 / 黑屏？**
1. 确认 **Wallpaper Engine 正在运行**（插件会在必要时尝试静默启动）；
2. 场景第一次启动需要 3–5 秒，面板状态会显示「正在启动…」；
3. 若一直「启动失败」，打开输出面板 `Wallpaper Engine` 查看日志，
   常见原因是 `workshopPath` 不对，或该场景本身在 WE 里也无法预览。

**场景占 CPU / 帧率低？**
在设置面板调低「场景帧率」（例如 15 FPS），或把 `sceneMaxWidth` 调小（例如 1280）。

**视频黑屏？**
VS Code 自带 ffmpeg 可能缺少 H.264 解码。可改用 `.webm` 壁纸，或替换 VS Code 目录下的
`ffmpeg.dll` 为对应 Electron 版本的完整版。

**提示“安装似乎损坏，请重新安装”？**
这不是文件真的损坏，而是 VS Code 的完整性检查发现 `workbench.html` 被注入过。
0.2.1 起插件会：

1. 以**无填充 Base64**（43 字符）写入正确的校验值；
2. 每次启动自动检测，发现不一致立即修复；
3. 修复后提示重新加载窗口。

也可以手动执行 `Repair Installation: 修复安装校验`。
**不要点“重新安装”**：重装会还原 `workbench.html`，壁纸注入随之失效。

**VS Code 更新后失效？**
更新会覆盖 `workbench.html` 与 `product.json`。重新加载窗口时插件会自动重新注入；
若提示权限不足，请以管理员身份运行一次 VS Code，或手动执行 `Repair Installation: 修复安装校验`。

## 卸载

执行 `Uninstall Wallpaper Engine: 卸载注入`，然后卸载扩展并重启 VS Code。
`workbench.html` 会从 `.vswe-orig` 备份恢复。
