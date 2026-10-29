# 音色模型放这里（**不会**被提交）

这个目录只放**你自己训练的** RVC 音色：

```
voice-models/
  你的音色.pth      ← 必需
  你的音色.index    ← 可选，强烈建议，音色更像
```

文件名就是控制台里"音色模型"的名字。

> ⚠️ `.pth` / `.index` 已在 `.gitignore` 里排除 —— 训练出来的是个人资产，
> 体积几十到几百 MB，而且**不该随仓库分发**（音色等于某个人的声音）。

训练方法见 [RVC 官方文档](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)
或各类 RVC 一键包；本仓库只提供**推理**这一环。