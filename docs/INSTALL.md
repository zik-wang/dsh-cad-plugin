# Windows 本机安装

需要已安装 DSH 桌面版、Node.js、Python 3.12（原机环境）、LibreCAD，以及自己的 DeepSeek API 凭据。插件使用 DSH 原生 `tools/systemPrompt/attachments/jobs` 和桌面包内 headless CLI；不同 DSH 版本接口可能不同。这里只提供插件，不重新分发 DSH、LibreCAD 或 Python 二进制。

1. 将整个仓库放在可写目录，例如 `D:/cad-delivery`。目录不要只读；运行时会生成任务和状态。
2. 使用准备给插件调用的 Python 安装依赖：

   ```powershell
   & 'C:/path/to/python.exe' -m pip install -r requirements.txt
   ```

   `requirements.txt` 是直接依赖清单，不是跨机器已验证的完整锁文件。原机用 ezdxf 1.4.5；其他库版本与可用 wheel 请根据本地 Python 配置。也可用 `--target D:/cad-deps` 安装，并在配置里填写对应目录。
3. 复制 `config.example.json` 为 `config.local.json`，填写 DSH 可执行文件、Python、LibreCAD 的真实绝对路径。`pythonPackages` 是额外包目录；常规安装可填对应 Python 的 `site-packages`。
4. 为独立审图创建仅本机当前 Windows 用户可解密的凭据文件：

   ```powershell
   powershell -NoProfile -File scripts/Save-Credential.ps1 -CredentialPath 'D:/cad-private/deepseek.dpapi'
   ```

   按提示隐藏输入自己的 DeepSeek API key。选择仓库之外的私有目录，并把脚本输出的文件路径填入 `credentialFile`。DSH 桌面需要在账户设置中配置同一个服务。
5. 生成三个插件各自的配置与入口：

   ```powershell
   node scripts/configure.mjs config.local.json
   ```

   该步骤只验证文件存在、生成路径配置，不运行模型、不自动安装插件、不改现有 DSH 配置。生成的 `runtime/settings.json` 和 `cordis.patch.yml` 已被 Git 忽略。迁移目录后重新运行。
6. 在 DSH 桌面“插件 → 添加插件”输入 `link:D:/cad-delivery/plugins/easy`（用实际目录），安装并启用。原版和降本版对应 `original` 与 `cost`。只启用一个 CAD 插件，新建对话，选择官方 DeepSeek Flash 模型（源码使用 provider `deepseek-official` / model `deepseek-flash`）。
7. 上传图片，说“帮我做成 CAD”。缺图时补上传即可。文字看不清时插件应请求关键局部图；别让它凭空补尺寸。

插件当前面向 Windows。审图启动器读取 Windows DPAPI 凭据并启动 DSH 包内 headless CLI；不能直接把旧电脑的 `.dpapi` 拷到别的用户或电脑使用。

## 本地交付检查

配置成功后，命令会打印三个 `link:` 地址。将所选地址添加到 DSH 插件库，在新对话里先发一句「帮我做成 CAD」，检查插件是否提示上传图片。

## 原版额外依赖

`plugins/original/runtime/settings.example.json` 保留旧识图服务字段的占位值。若确实复现原版，请自行在生成的 `settings.json` 填写原环境对应的 atlas/visionServiceId/reviewVisionServiceId。未配置服务时可能阻塞原版流程；降本版和简易入口没有这个依赖。

## 排查

- 插件找不到：先运行 configure，检查生成的 file URL 是否指向当前目录，再重新安装/刷新插件库。
- 审图卡住：查看当前任务 `.host` 下的报告和运行状态、审图子任务；不要盲目反复重开以抹掉预算或候选记录。
- 预算不足：保留候选和报告。10 元是每原生对话的建模及审图合计估算；同一对话继续不会清零，新对话独立记账。
- 超出审图限次：当前源码每次原图修订最多 4 个不同的已完成审图候选；模型应保存进度并报告阻塞。不要把停止状态当作交付成功。
- 同一插件的旧命令行辅助脚本保留作历史源码；本交付支持路径为“配置 → 桌面插件库 → 原生对话”。不要直接运行 legacy `review-job.mjs` 代替原生审图。
