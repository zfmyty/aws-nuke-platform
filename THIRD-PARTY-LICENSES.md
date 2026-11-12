# 第三方组件许可声明（Third-Party Notices）

本项目包含以下第三方组件。各组件版权归其原作者所有，本平台以**未修改的官方形式**集成，并遵循其原始许可条款。

## aws-nuke CLI

- 项目主页：https://github.com/ekristen/aws-nuke
- 许可协议：MIT License
- 集成形式：官方 Windows AMD64 二进制（`runtime/bin/aws-nuke.exe`，未修改），或其官方发行包
- 版权归属：本项目为 `rebuy-de/aws-nuke` 的完整分支（fork），先后由 reBuy reCommerce GmbH 与 Erik Kristensen 维护
- 版权声明：见下方 MIT 许可文本首部的版权行，原件位于 `runtime/bin/LICENSE`

MIT License

Copyright (c) 2016 reBuy reCommerce GmbH
Copyright (c) 2021 Erik Kristensen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### 与上游许可的关系

MIT 许可要求在软件的所有副本中保留上述版权声明与许可文本。本项目因此：

- 通过 `runtime/bin/LICENSE` 随二进制原样保留上游版权与许可（该文件由 aws-nuke 官方发行包自带）；
- 在本文件中复述完整版权行与许可文本，确保源码仓库单独可查。

本平台与 aws-nuke 上游之间不存在赞助、背书或隶属关系。

## 其它运行时依赖

后端运行时依赖（Express 及其传递依赖）与前端依赖（Vue、Vite、Pinia、Vue Router）
均遵循各自仓库的开源许可，本项目未修改其源码，版权与担保条款以各项目原文为准。

## 与本平台的关系

上述第三方组件的版权归其原作者所有；本平台自身代码的版权独立归属本平台作者，
两者互不影响。集成第三方组件不改变本平台代码的许可状态。
