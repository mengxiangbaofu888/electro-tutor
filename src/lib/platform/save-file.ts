/**
 * 导出 / 保存文件。网页版和 App 版必须走不同的路。
 *
 * 为什么不能只用网页那套「Blob + <a download>」：
 *   App 版跑在 Capacitor 的 WebView 里，而整个 Capacitor 安卓运行时
 *   **没有实现下载**（既没有 DownloadListener，也没有 onDownloadStart）。
 *   于是 <a download> 在 App 里点下去完全没反应，也不会报错——
 *   用户会以为备份已经存好了，换手机时才发现数据全丢。
 *   对"导出备份"这种数据安全功能来说，静默失败是最糟的失败方式。
 *
 * 所以：
 *   · 网页版 → Blob + a[download]（浏览器原生下载）
 *   · App 版 → 先写入应用缓存目录，再调起系统分享面板，
 *     让用户存到网盘 / 微信 / 文件管理器
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export interface SaveTextFileParams {
  filename: string;
  content: string;
  /** 网页版用于 Blob 的 MIME 类型 */
  mime: string;
  /** App 版分享面板的标题，例如「保存备份文件」 */
  dialogTitle?: string;
}

export interface SaveTextFileResult {
  /** download = 触发了浏览器下载；share = 调起了系统分享面板 */
  via: 'download' | 'share';
  /** 用户在分享面板上取消了（不算失败，不该报错） */
  cancelled?: boolean;
}

/** 当前是不是跑在 App（原生壳）里 */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export async function saveTextFile(params: SaveTextFileParams): Promise<SaveTextFileResult> {
  const { filename, content, mime, dialogTitle } = params;

  if (Capacitor.isNativePlatform()) {
    const written = await Filesystem.writeFile({
      path: filename,
      data: content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    try {
      await Share.share({
        title: filename,
        files: [written.uri],
        dialogTitle: dialogTitle ?? '保存或分享文件',
      });
      return { via: 'share' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 用户在分享面板按返回属于正常操作，不该弹红字
      if (/cancel/i.test(message)) return { via: 'share', cancelled: true };
      throw e;
    }
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return { via: 'download' };
}
