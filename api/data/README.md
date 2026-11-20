# Device location data / 设备地点数据

设备登录及活动时，服务器读取本地 IPv4 或 IPv6 地址库。仅保存国家、省份、城市中有数据的部分。IP 对应网络出口位置，代理、移动网络和运营商路由都会影响结果。

The API looks up the network exit address locally using the matching IP family. The device record stores the available country, region and city. Each database is decompressed asynchronously on first use and reused by the API process.

Both gzip files contain the unmodified XDB from [ip2region, revision 200f4cc7](https://github.com/lionsoul2014/ip2region/tree/200f4cc7a6452843ef515a889c72d295281e8da3/data). The [upstream license](./ip2region-LICENSE.md) accompanies them. When updating the snapshot, replace both families, record their compressed SHA-256 values and verify the city and fallback cases in `tests/unit/device-location.test.ts`.

| File | SHA-256 |
| --- | --- |
| ip2region_v4.xdb.gz | d73257334b21c85ff4202272e7d945bd843b2fcfe9ff678c7d8fc99c990ac3b2 |
| ip2region_v6.xdb.gz | e43bcf6c46fbdaa7dc069ac3518db9d1000ead1cb1e64ee13eeda875420e4697 |
