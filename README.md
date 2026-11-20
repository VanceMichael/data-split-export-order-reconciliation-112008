# 跨境订单的分箱采集与货值差异复核

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。项目只使用随 Node.js 提供的运行库。

```sh
npm start
npm test
```

不同终端分别启动服务和执行独立来源测试。默认地址为 `http://127.0.0.1:4173`，可设置 `SOURCE_PORT`。来源使用进程内演练时钟，启动时处于 `sale`。用 `PUT /_source_clock?step=boxed` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `sale`、`boxed`、`split`、`partial-refund`、`late-proof`、`replacement`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料。

## 来源约定

`/shops/orders?account=west` 与 `/shops/orders?account=south` 提供各店铺订单、套件销售版本、金额变动及明确的退款指向，`minorAmount` 用币种最小单位。 `/shops/kits` 的 `weight` 是套件各品件的成交金额比例按整数权重表达。按可核对的销售行与实际所装品件分配，先舍去不足一分的余数，再按未舍位的余数从大到小分配，仍相同则按套件清单里的品件顺序。退款若映射到多个实际封箱且平台未说明对应品件，应查询人工审核。
仓库 `/warehouse/closeouts` 列出装箱实例的演变， `/warehouse/manifest?page=1` 给出封箱实例与零件， `blank` 表示此页没有可读条目仍待补，只有带 `cleared` 的显式清空能证明某个箱已撤。货代 `/forwarder/handover` 使用见证的封箱号和实物标签接收，`at` 为实际接收时间，`receivedAt` 是凭据到达时间。
