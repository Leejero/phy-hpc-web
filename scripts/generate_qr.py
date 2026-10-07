#!/usr/bin/env python3
"""生成 HPC 集群监控 App 的下载二维码。

用法：
    python scripts/generate_qr.py [URL] [输出路径]

默认生成 download/qrcode-app.png，指向 GitHub Pages 上的 APK 直链。
依赖：qrcode[pil]
"""

import sys
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_H

# 默认下载直链（GitHub Pages）
DEFAULT_URL = "https://leejero.github.io/phy-hpc-web/download/PhyHPC-Monitor.apk"
DEFAULT_OUT = "download/qrcode-app.png"

# 纠错等级 H（约 30% 冗余）：即使二维码有污损、反光或打印偏色仍可识别
ERROR_LEVEL = ERROR_CORRECT_H
BOX_SIZE = 8      # 每个模块 8px；最终边长约 450-470px，屏幕显示缩至 200px 仍清晰
BORDER = 4        # 静默区 4 个模块（QR 规范推荐的最小值）
FILL = "#0f172a"  # 深蓝黑，与站点主色系协调，对白底对比度约 17:1，不影响识别
BACK = "#ffffff"


def build_qr(url: str):
    qr = qrcode.QRCode(
        version=None,               # 自动选择最小可用版本
        error_correction=ERROR_LEVEL,
        box_size=BOX_SIZE,
        border=BORDER,
    )
    qr.add_data(url)
    qr.make(fit=True)
    return qr


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    out = Path(sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT)

    qr = build_qr(url)
    img = qr.make_image(fill_color=FILL, back_color=BACK)

    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)

    print(f"目标 URL : {url}")
    print(f"QR 版本  : {qr.version}（{qr.modules_count}x{qr.modules_count} 模块）")
    print(f"图片尺寸 : {img.size[0]}x{img.size[1]} px")
    print(f"输出文件 : {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
