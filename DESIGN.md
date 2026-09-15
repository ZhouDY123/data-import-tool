---
version: 1
name: "订单导入台"
description: "面向运营人员的本地订单附件导入工具。"
colors:
  ink: "#17324D"
  teal: "#087E8B"
  mint: "#D8F1EE"
  canvas: "#F4F8FA"
  paper: "#FFFFFF"
  line: "#D8E2E8"
  success: "#18794E"
  warning: "#9A6700"
  danger: "#C43D2F"
  focus: "#005FCC"
typography:
  sans:
    fontFamily: "Inter, 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif"
  mono:
    fontFamily: "'Cascadia Mono', Consolas, monospace"
rounded:
  sm: "0.375rem"
  md: "0.625rem"
  lg: "1rem"
spacing:
  section-gap: "1.5rem"
  page-max: "86rem"
components:
  button: {}
  card: {}
  table: {}
  form: {}
---

# 订单导入台设计系统

## Overview

### Creative North Star

以订单拣货单和库房标签为参照：清楚、可核对、能追溯。界面用深蓝承载信息层级，以青绿色标记可安全推进的导入步骤。

### Product context and register

- **Audience and primary job:** 店铺运营人员下载三个店铺的当前附件，核对解析结果后导入订单。
- **Target market(s) and evidence:** 中国大陆；数据源与字段均为中文电商后台。
- **Locale(s) and language policy:** 简体中文、北京时间，所有界面与错误提示使用中文。
- **Usage scene:** Windows 桌面端后台操作，需并列核对三家店铺及订单明细。
- **Register:** 内部管理工具。
- **Memorable signature:** 顶部“导入流水线”清晰表现下载、解析、导入三个阶段。
- **Restraint:** 数据表、错误信息和操作按钮保持安静直接，不用装饰性图标代替文字。
- **Anti-references:** 不采用营销页的大幅宣传语或金融交易终端式的高密度闪烁信息。
- **Token ownership/runtime mapping:** 本文件的颜色、字体和圆角由 `public/styles.css` 的 CSS 变量实现。

## Colors

`ink` 用于标题与高优先级文字；`teal` 是主要操作色；`mint` 标示已完成或可继续；`danger` 仅用于失败和不可导入记录。焦点环固定使用 `focus`，保留足够对比度。

## Typography

正文使用系统中文字体，订单号、金额和任务编号使用等宽字体以便核对。标题紧凑，表格保持 14px 以上，长商品名允许换行。

## Layout

内容最大宽度 86rem。页面在宽屏以三张店铺卡片并列，在窄屏自动堆叠；明细表仅自身横向滚动，页面仍保持自然滚动。

## Elevation & Depth

层级由白色表面、细边框与轻阴影表达。导入结果区域不用浮层，避免遮住明细。

## Shapes

卡片使用 `lg` 圆角，输入与按钮使用 `md` 圆角。表格和分隔线保持利落。

## Components

### Foundational visual states

按钮在处理中维持原有尺寸并显示忙碌文案；成功、警告和错误均有文字说明。所有控件提供可见焦点环。

### Buttons and actions

“获取并解析”是主操作；“导入”仅在解析完成且有有效订单时可用。导入不是危险删除操作，因此不额外弹窗确认，但页面会显示目标平台、有效条数和覆盖更新规则。

### Navigation and data display

店铺卡片显示来源、文件名、解析状态和条数。预览表固定显示代表行，完整导入结果以任务日志保留。

### Forms and overlays

登录凭据只在当前浏览器请求中提交给本地服务，页面不使用本地存储；密码默认隐藏并有显示开关。错误在字段附近和全局状态区同时提供。

### Motion

只对进度条使用短暂过渡；用户启用减少动态效果时取消过渡。

## Do's and Don'ts

- **Do:** 让每一个导入动作都显示来源、目标接口、条数和结果。
- **Do:** 保留能定位到原始文件和行号的错误描述。
- **Don't:** 在页面、日志或浏览器存储中显示密码。
- **Don't:** 把“已解析”误写成“已导入”。
