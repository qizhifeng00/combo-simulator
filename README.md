# combo-simulator

基于 `koishipro-core.js` 的简单 YGO Combo 推演脚本。

## 目录结构

- `combo-simulator.cjs`：主脚本
- `lib/slm.ydk`：默认卡组
- `lib/cards.cdb`：默认卡池数据库
- `lib/ygopro-scripts`：默认脚本目录

## 安装

在当前目录执行：

```bash
npm install
```

## 使用

```bash
npm run simulate -- --help
```

或直接：

```bash
node combo-simulator.cjs --help
```

## 常用示例

仅查看 Top 路径：

```bash
npm run simulate -- --top 5 --max-depth 200 --max-nodes 2000
```

导出 Top 路径 replay：

```bash
npm run simulate -- --top 3 --export-yrp replays --yrp-version 1
```

## 可选参数

- `--deck` 主玩家 `.ydk`
- `--cards` `cards.cdb` 路径
- `--scripts` 脚本目录
- `--resource-dir` 资源根目录（推导 deck/cards/scripts）
- `--opponent-deck` 对手 `.ydk`
- `--seed` 随机种子
- `--draw-count` 起手张数
- `--max-depth` 搜索深度
- `--max-nodes` 搜索节点上限
- `--beam-width` 束宽参数
- `--max-actions` 每节点最大动作数
- `--top` 输出 Top 路径数量
- `--expand-script-keywords` 放开 `reposition/set` 的关键词过滤
- `--export-yrp` 导出 `.yrp`
- `--yrp-version` replay 版本（`1` 或 `2`）
- `--verbose` 详细输出
