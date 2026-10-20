"""把 film/logos/*.svg 转成内嵌数据写入 film/logos.js（canvas 用 data: 图片不会被跨域污染，逐帧导出才能成功）

用法: python3 film/tools/build-logos.py
"""
import base64
import json
import re
from pathlib import Path

here = Path(__file__).resolve().parent.parent
MAP = {'codex': 'codex-color', 'opencode': 'opencode', 'qwen': 'qwen-color', 'kimi': 'kimi', 'droid': 'factory',
       'grok': 'grok', 'minimax': 'minimax-color', 'codebuddy': 'codebuddy-color', 'hermes': 'hermesagent', 'qiniu': 'qiniu-color'}

out = {}
for key, name in MAP.items():
    s = (here / 'logos' / f'{name}.svg').read_text()
    head = re.match(r'<svg[^>]*>', s).group(0)
    w = re.search(r'\swidth="([\d.]+)"', head)
    h = re.search(r'\sheight="([\d.]+)"', head)
    new = re.sub(r'\s(width|height)="[^"]*"', '', head)
    # 外层没有 viewBox 时按原始宽高补上，否则改尺寸会裁掉内容
    if 'viewBox' not in new and w and h:
        new = new.replace('<svg', f'<svg viewBox="0 0 {w.group(1)} {h.group(1)}"', 1)
    new = new.replace('<svg', '<svg width="256" height="256"', 1)
    s = s.replace(head, new, 1)
    out[key] = 'data:image/svg+xml;base64,' + base64.b64encode(s.encode()).decode()
(here / 'logos.js').write_text('// 由 film/tools/build-logos.py 根据 film/logos/*.svg 生成，来源见 logos/SOURCES.md\nwindow.LOGO_SRC = '
                               + json.dumps(out) + ';\n')
print(f'{len(out)} logos → logos.js')
