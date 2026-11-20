# 发布到 GitHub

本目录已经是一份可直接上传的扩展源码。下面两种方式任选其一。

## 准备

- 一个 GitHub 账号。
- 建议仓库名：`vscode-wallpaper-engine`。
- 创建仓库时**不要**勾选 `Add a README file`、`Add .gitignore`、`Choose a license`，否则会和本目录中的文件冲突。

## 方式一：网页上传（最简单）

1. 打开 <https://github.com/new>。
2. `Repository name` 填 `vscode-wallpaper-engine`。
3. 选择 `Public`（想先私有也可以选 `Private`）。
4. 不要勾选任何初始化选项，点击 `Create repository`。
5. 在空仓库页面点击 **uploading an existing file**。
6. 把本目录中的文件和文件夹全部拖进去，至少包括：
   - `extension.js`
   - `package.json`
   - `README.md`
   - `CHANGELOG.md`
   - `LICENSE.txt`
   - `NOTICE.md`
   - `PUBLISH.md`
   - `bin/`
   - `media/`
   - `.gitignore`、`.gitattributes`（Windows 默认隐藏，按 `Ctrl+H` 显示隐藏文件）
7. 填写提交说明，例如 `Initial commit: unofficial fork of vakesamahere/vscode-wallpaper-engine`，点击 `Commit changes`。

> GitHub 网页上传单文件限制为 100 MB，本仓库文件都远小于该限制。

## 方式二：Git 命令

在本目录打开 PowerShell：

```powershell
# 只需第一次配置 Git 身份时执行
git config --global user.name "你的名字"
git config --global user.email "你的GitHub邮箱"

cd "本目录路径"
git init
git add .
git commit -m "Initial commit: unofficial fork of vakesamahere/vscode-wallpaper-engine"
git branch -M main

# 先在 GitHub 网页创建空仓库，然后：
git remote add origin https://github.com/<你的GitHub用户名>/vscode-wallpaper-engine.git
git push -u origin main
```

## 方式三：GitHub CLI（可选）

```powershell
winget install --id GitHub.cli
gh auth login
cd "本目录路径"
gh repo create vscode-wallpaper-engine --public --source . --remote origin --push
```

## 离线打包（无需 npm）

如果 `npx` 下载慢或没有网络，可以使用仓库自带的脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-vsix.ps1
```

生成文件位于 `dist-vsix\vscode-wallpaper-engine-0.3.2.vsix`，内容与标准 `vsce` 打包一致，并包含
`LICENSE.txt` 与 `NOTICE.md`。

## 发布 VSIX 到 GitHub Releases

在目录中执行：

```powershell
npx @vscode/vsce package
```

会生成 `vscode-wallpaper-engine-0.3.2.vsix`。然后在 GitHub 仓库：

1. 右侧点击 `Releases` → `Draft a new release`。
2. Tag 填 `v0.3.2`。
3. 标题写 `v0.3.2 - Unofficial fork`。
4. 上传 VSIX。
5. Release 说明中保留原项目链接和“非官方分支”声明。

## 如果要发布到 VS Code Marketplace

> **不要使用 `vakesamahere` 作为发布者身份。** 那是原作者的 Publisher ID。

如果要发布到 Marketplace：

1. 在 Azure DevOps 创建自己的 Publisher（例如 `your-name`）。
2. 把 `package.json` 里的 `"publisher": "vakesamahere"` 改成你自己的 Publisher ID。
3. 注意：Publisher 改变后扩展 ID 也会改变，不会覆盖原版扩展，会作为另一个扩展安装。
4. 使用 `vsce login <你的PublisherId>` 和 `vsce publish` 发布。
5. README、NOTICE、LICENSE 中的原作者署名必须保留。

## 可选：补上仓库地址

创建 GitHub 仓库后，可以把 `package.json` 增加为：

```json
"repository": {
  "type": "git",
  "url": "https://github.com/<你的GitHub用户名>/vscode-wallpaper-engine.git"
},
"homepage": "https://github.com/<你的GitHub用户名>/vscode-wallpaper-engine#readme",
"bugs": {
  "url": "https://github.com/<你的GitHub用户名>/vscode-wallpaper-engine/issues"
}
```
