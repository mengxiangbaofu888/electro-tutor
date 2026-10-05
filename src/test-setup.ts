/**
 * 测试环境准备。
 *
 * 业务代码里的 db 层用的是 IndexedDB（浏览器 API），Node 下没有。
 * fake-indexeddb 提供一个内存实现，让涉及数据库的模块可以在 Node 里直接 import。
 */
import 'fake-indexeddb/auto';
