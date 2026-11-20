# 来源与署名 / Attribution

## 原项目

| 项目 | 内容 |
| --- | --- |
| 名称 | vscode-wallpaper-engine |
| 原作者 | **vakesamahere（Vake）** |
| 原仓库 | https://github.com/vakesamahere/vscode-wallpaper-engine |
| 原许可证 | MIT License |
| 原始版权 | `Copyright (c) 2025 Vake` |
| 本分支基础版本 | v0.0.5 |

## 本分支

- 本仓库是上述项目的**非官方修改分支（unofficial fork）**。
- 维护者：本仓库所有者（GitHub 用户名见仓库地址）。
- 本分支与原作者**无隶属关系**，也**未获得原作者背书**。
- 本分支的修改内容按 MIT License 发布；原项目的版权、署名和 MIT 许可声明继续有效。
- 如果你要转载、再发布或制作安装包，请保留本文件、`LICENSE.txt` 以及 README 顶部的来源说明。

## 主要修改

- 适配 VS Code 1.147 / Electron 43 的 `workbench.html` 注入方式。
- 重写壁纸注入层，修复透明化不生效、背景不显示等问题。
- 新增视频 / Web / Scene 壁纸支持与本地 HTTP Range 流。
- 新增 Scene 壁纸真实实时渲染：Wallpaper Engine 屏幕外渲染 + `PrintWindow` 抓帧。
- 新增 Scene 属性控制（bool / color / slider / combo），只修改隔离副本，不改桌面 WE 配置。
- 新增可视化透明度控制台、实时预览、自定义 CSS / JS。
- 新增与 Wallpaper Engine 当前壁纸同步、切换监听。
- 0.3.2：使用 `WS_EX_TOOLWINDOW`、`WS_EX_NOACTIVATE`、`ITaskbarList::DeleteTab` 隐藏 Scene 预览窗口。

## 商标声明

Wallpaper Engine 是其各自权利人的商标或注册商标；VS Code 是 Microsoft Corporation 的产品。本项目与 Wallpaper Engine 开发团队、Valve、Microsoft 均无隶属或背书关系。

## 许可证

完整 MIT 许可证文本见 [LICENSE.txt](LICENSE.txt)。
