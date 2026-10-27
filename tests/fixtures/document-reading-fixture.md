---
title: 文档阅读一致性
category: research
---
# 文档阅读一致性

同一份 Markdown，在阅读、大纲和源码中保持一致。

[跳到研究结论](#研究结论) · [阅读方法][method] · 引用证据[^source]

## 嵌套结构

- 研究材料
  - 论文与笔记
    - 保留层级
  - [x] 阅读完成
  - [ ] 核验来源

> 研究摘录
>
> 1. 保留结构
> 2. 核验结果
>
> ```text
> # 这不是大纲标题
> ```

## 数学公式

行内公式 $E=mc^2$ 与矩阵使用同一套排版。

$$
A = \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix},\quad \sum_{i=1}^{n} x_i
$$

| 项目 | 阅读状态 | 检查结果 |
| :--- | :---: | ---: |
| 嵌套列表 | 可阅读 | 通过 |
| 公式 | 可缩放 | 通过 |

## 代码与原文

```python
def greet(name):
    return f"Hello, {name}!"

print(greet("AI Bro"))
```

研究结论
--------

这里是真正的结论目标。页内跳转应保留当前文档。

## 重复标题

第一个标题。

## 重复标题

第二个标题。

![参考图][figure]

[method]: https://commonmark.org/help/ "Markdown 语法参考"
[figure]: IMAGE_REFERENCE
[^source]: 来自经过核对的原始文献。点击返回标记回到引用位置。
