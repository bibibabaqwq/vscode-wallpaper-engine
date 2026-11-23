> 本文件属于 vscode-wallpaper-engine 的非官方修改分支。
> 原项目：https://github.com/vakesamahere/vscode-wallpaper-engine
> 原作者：vakesamahere（Vake），原始代码 Copyright (c) 2025 Vake，MIT License。

# Changelog

## 0.3.3

- **修复切换壁纸后旧 Scene 窗口偶发被拉到前台、看起来像独立 Wallpaper Engine 程序**：
  - 彻底移除 `ShowWindow(SW_RESTORE)`；最小化时改用 `SW_SHOWNOACTIVATE`，不再激活任何窗口
  - 场景启动 / 停止 / 属性更新统一进入串行队列，并用版本号取消已经过期的切换任务
  - 新预览窗口通过预先启动的 `place` 进程在创建瞬间隐藏并移出屏幕，不再等待 420ms
  - 记录并关闭本扩展创建过的全部 `VSWE Scene ...` 窗口；关闭后等待窗口真正消失
  - 新增 helper 的 `close` / `waitgone` 命令，并清理上一扩展进程遗留的抓帧进程与窗口
- **修复场景属性面板显示 `imgsrchttp...` 超长乱码**：
  - 清洗 HTML、脚本、图片 URL 与 HTML 实体，只保留真正可读的文字
  - 识别并拒绝超长 key / slug，不再把 Wallpaper Engine 错误生成的属性 key 当作名称
  - 无标题属性回退为「场景开关 / 场景颜色 / 场景滑块 / 场景选项 + 序号」
  - 下拉选项标签同样清洗，避免选项值出现乱码

## 0.3.2

- **隐藏场景预览窗口**：给 WE 弹窗设置 `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`，并调用
  `ITaskbarList::DeleteTab` 移除任务栏按钮，因此不会出现在任务栏 / Alt+Tab
- 不改变窗口的渲染表面（刻意避开 `SWP_FRAMECHANGED`），实测 PrintWindow 抓帧仍然正常，
  不会出现纯黑画面
- 场景属性切换 / 重新启动预览窗口时自动重新应用隐藏样式

## 0.3.1

- **修复场景壁纸失焦后停止刷新**：场景帧循环不再因为 VS Code 失去焦点而暂停，仅在窗口
  真正最小化/隐藏时暂停；切到浏览器或终端后壁纸仍持续播放
- **修复多个 VS Code 窗口连接错服务端口**：注入页面用当前窗口的 `logsPath` 指纹匹配自己的
  扩展实例，避免新窗口显示另一个窗口的壁纸或旧版本的封面图
- **修复新窗口 / 首次安装时加载旧注入的问题**：首次注入或 bootstrap 升级后自动重新加载一次窗口；
  端口变化无需重载
- 场景未就绪时先显示封面并自动重试，就绪后无缝切换到实时画面
- 场景帧请求连续失败时自动重新探测服务端口并恢复
- 场景抓帧进程异常退出后，设置面板会显示状态，可一键重启

## 0.3.0

- **场景（Scene）壁纸改为真实实时渲染**：不再显示 `preview.gif` 封面，而是由 Wallpaper Engine
  在屏幕外渲染真实场景，`bin/scene-helper.exe` 用 PrintWindow 抓帧后以 JPEG 流送进 VS Code
- 新增**场景属性控制面板**：bool / color / slider / combo 全覆盖，初始值同步 WE 桌面实例
- 属性修改采用「隔离副本 + 重启预览窗口」，只影响 VS Code，绝不改动桌面壁纸与 WE 配置
- 新增设置：`sceneEnabled` / `sceneFps` / `sceneQuality` / `sceneMaxWidth` / `sceneMuted`
- 新增命令 `Restart Scene Render: 重启场景实时渲染`
- 场景渲染尺寸自动匹配 VS Code 窗口大小
- 关闭壁纸、切换壁纸、退出 VS Code 时自动关闭 WE 弹窗并结束抓帧进程
- 弹窗始终使用 `-playInWindow`，修复“桌面壁纸被替换”的问题

## 0.2.1

- 修复写入 `product.json` 时使用带 `=` 的 Base64，导致 VS Code 提示“安装似乎损坏，请重新安装”
- 启动时自动检测并修复 `workbench.html` 校验值（无填充 Base64）
- 新增命令 `Repair Installation: 修复安装校验`，一键修复注入与校验并重载窗口
- 注入时仅在内容变化时写盘；只对未注入的原始 `workbench.html` 建立备份
- 注入/校验失败时给出明确提示与日志入口

## 0.2.0

- 重写注入层，适配 VS Code 1.147 / Electron 43（`workbench.html` + 外置脚本）
- 修复透明化完全不生效的问题（覆盖 modern UI 的 shell 背景变量）
- 新增可视化透明度面板，滑块实时生效（SSE 推送，无需重载）
- 场景壁纸自动使用 `preview.gif` 动画预览 / `preview.jpg` 静态缩放
- 新增 Wallpaper Engine 当前壁纸同步与切换监听
- 媒体服务支持 HTTP Range（4K 视频更流畅）
- 自动更新 `product.json` 校验和，避免“安装似乎已损坏”提示
- 自动清理 0.0.5 旧版注入

## 0.0.5

- 初版
