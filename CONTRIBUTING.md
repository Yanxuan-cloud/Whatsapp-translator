# 贡献指南

感谢你有兴趣为 WhatsApp 双语翻译助手做贡献！以下是一些参与方式和建议。

## 报告问题

- 在 GitHub Issues 中搜索是否已有相同问题
- 如果没有，请新建 Issue，描述清楚：
  - 复现步骤
  - 期望行为 vs 实际行为
  - Chrome 版本、操作系统
  - 控制台报错截图（如有）

## 提交代码

1. Fork 本仓库
2. 创建分支：`git checkout -b feature/your-feature` 或 `git checkout -b fix/your-fix`
3. 提交更改，commit message 用中英文均可，格式：`类型: 简述`（如 `fix: 修复深色模式下译文不可见`、`feat: 新增阿拉伯语支持`）
4. 提交 Pull Request，描述清楚改了什么、为什么改

## 开发须知

- 本插件是 Manifest V3 架构，Chrome 扩展
- `content.js` 中的 `SELECTORS` 是 WhatsApp Web 的 DOM 选择器，WhatsApp 经常改前端代码，选择器失效是最常见的 bug 来源
- 翻译引擎的调用逻辑在 `background.js`，新增引擎参考 `callDeepL` / `callGoogleTranslate` 的写法
- **安全红线**：不要引入任何自动修改 WhatsApp 输入框内容或自动点击发送按钮的代码。v0.2.0 专门去掉了这个高风险行为，这是本插件的核心设计原则

## 代码风格

- 使用双引号字符串
- 缩进 2 空格
- 变量名用英文，注释可以用中文
- DOM 操作优先用 `textContent` / `createElement`，避免 `innerHTML`（防 XSS）

## 测试

- 目前没有自动化测试，改完代码后在 Chrome `chrome://extensions` 重新加载插件，在 `web.whatsapp.com` 手动验证
- 重点测试：收消息翻译、发消息译文建议、引擎切换、额度统计、深色模式
