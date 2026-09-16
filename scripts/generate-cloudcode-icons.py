#!/usr/bin/env python3
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

"""Export the checked-in CloudCode SVG to desktop, web and installer assets.

Maintainer-only tool: requires CairoSVG and Pillow. Normal builds consume the
generated assets directly and do not need these Python packages or Cairo.
"""

import io
from pathlib import Path
import xml.etree.ElementTree as ET

import cairosvg
from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'resources/cloudcode/cloudcode.svg'
ICO_SIZES = [(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)]
NS = '{http://www.w3.org/2000/svg}'
SVG = SOURCE.read_text(encoding='utf-8')
MARK = ''.join(SVG.splitlines()[1:-1])


def render(svg, size):
	return Image.open(io.BytesIO(cairosvg.svg2png(
		bytestring=svg.encode('utf-8'), output_width=size, output_height=size,
	))).convert('RGBA')


def write_text(path, content):
	(ROOT / path).write_text(content, encoding='utf-8')


def save_icon(path, image):
	destination = ROOT / path
	if destination.suffix == '.ico':
		image.save(destination, sizes=ICO_SIZES)
	else:
		image.save(destination)


def watermark(color, opacity):
	cloud = ET.fromstring(SVG).find(f'.//{NS}path[@id="cloud"]').get('d')
	arrows = ET.fromstring(SVG).find(f'.//{NS}path[@id="arrows"]').get('d')
	# The cloud outline ends at the badge; no background fill is needed.
	return f'''<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260" viewBox="0 0 128 128">
\t<g fill="none" stroke="{color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="{opacity}">
\t\t<path d="{cloud}"/>
\t\t<circle cx="99" cy="96" r="26"/>
\t\t<path d="{arrows}"/>
\t</g>
</svg>
'''


def write_xpm(image):
	# XPM has binary transparency. Keep an explicit transparent palette entry.
	indexed = image.convert('RGB').quantize(colors=63)
	palette = indexed.getpalette()
	symbols = ' .+@#$%&*=-;:>,<1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno'
	lines = ['/* XPM */', 'static char * code_xpm[] = {',
			 f'"{image.width} {image.height} 64 1",', '"  c None",']
	for i in range(63):
		r, g, b = palette[i * 3:i * 3 + 3]
		lines.append(f'"{symbols[i + 1]} c #{r:02x}{g:02x}{b:02x}",')
	for y in range(image.height):
		row = ''.join(symbols[indexed.getpixel((x, y)) + 1]
					  if image.getpixel((x, y))[3] >= 128 else ' '
					  for x in range(image.width))
		lines.append(f'"{row}"' + (',' if y < image.height - 1 else ''))
	write_text('resources/linux/rpm/code.xpm', '\n'.join(lines) + '\n};\n')


# Existing vector language glyphs keep file associations distinguishable. Every
# document is regenerated from vectors, with the CloudCode badge in one place.
GLYPHS = ROOT / 'extensions/theme-modern-icons/fileicons/images'
FILE_GLYPHS = {
	'bat': ('shell', '#50647d'), 'bower': ('package', '#ac5b23'),
	'c': ('c', '#356d9b'), 'config': ('settings', '#65717e'),
	'cpp': ('cpp', '#356d9b'), 'csharp': ('csharp', '#8153a4'),
	'css': ('hash', '#356d9b'), 'default': ('lines', '#8b959f'),
	'go': ('go2', '#387e99'), 'html': ('html', '#b85c36'),
	'jade': ('jade', '#64812f'), 'java': ('java', '#a85f2b'),
	'javascript': ('javascript', '#947720'), 'json': ('json', '#89952c'),
	'less': ('less', '#356d9b'), 'markdown': ('markdown', '#50647d'),
	'php': ('php', '#696a9c'), 'powershell': ('powershell', '#356d9b'),
	'python': ('python', '#387e99'), 'react': ('react', '#387e99'),
	'ruby': ('ruby', '#a84245'), 'sass': ('sass', '#ab577e'),
	'shell': ('shell', '#50647d'), 'sql': ('database', '#947720'),
	'typescript': ('typescript', '#356d9b'), 'vue': ('vue', '#448066'),
	'xml': ('xml', '#a85f2b'), 'yaml': ('yaml', '#a84245'),
}
LINE_GLYPHS = {
	'package': '<path d="M2 4L8 1L14 4V12L8 15L2 12Z M2 4L8 7L14 4 M8 7V15"/>',
	'c': '<path d="M11 3C3-1 1 17 11 13"/>',
	'cpp': '<path d="M7 3C0-1 0 17 7 13 M9 6V10 M7 8H11 M14 6V10 M12 8H16"/>',
	'csharp': '<path d="M7 3C0-1 0 17 7 13 M11 5L10 11 M14 5L13 11 M9 7H15 M9 9H15"/>',
	'hash': '<path d="M6 2L4 14 M12 2L10 14 M2 6H14 M1 10H13"/>',
	'lines': '<path d="M1 3H15 M1 7H10 M1 11H15 M1 15H10"/>',
	'database': '<ellipse cx="8" cy="3" rx="6" ry="2"/><path d="M2 3V13C2 16 14 16 14 13V3 M2 8C2 11 14 11 14 8"/>',
	'yaml': '<path d="M2 2L8 8L14 2 M8 8V15"/>',
}


def document_svg(glyph, color):
	if glyph in LINE_GLYPHS:
		symbol = f'<g fill="none" stroke="{color}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">{LINE_GLYPHS[glyph]}</g>'
	else:
		element = ET.fromstring((GLYPHS / f'{glyph}.svg').read_text(encoding='utf-8'))
		element.set('color', color)
		# These glyphs all have a 16-unit viewBox; nested SVGs retain their styles.
		element.set('width', '16')
		element.set('height', '16')
		symbol = ET.tostring(element, encoding='unicode')
	return f'''<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<path d="M20 5H80L108 33V121H20Z" fill="#f8fafc" stroke="#b7bec7" stroke-width="2" stroke-linejoin="round"/>
<path d="M80 5V33H108" fill="#e7ebf0" stroke="#b7bec7" stroke-width="2" stroke-linejoin="round"/>
<g transform="translate(38 44) scale(3.2)">{symbol}</g>
<g transform="translate(77 79) scale(.39)">{MARK}</g>
</svg>'''


def main():
	master = render(SVG, 1024)
	for path in ('src/vs/workbench/browser/media/code-icon.svg',
				 'extensions/github-authentication/media/code-icon.svg'):
		write_text(path, SVG)
	for path in ('resources/win32/code.ico', 'resources/darwin/code.icns',
				 'resources/server/favicon.ico', 'resources/linux/code.png'):
		save_icon(path, master)
	for path, size in (('resources/win32/code_70x70.png', 70),
					   ('resources/win32/code_150x150.png', 150),
					   ('resources/server/code-192.png', 192),
					   ('resources/server/code-512.png', 512)):
		save_icon(path, master.resize((size, size), Image.Resampling.LANCZOS))
	write_xpm(master)

	for theme, color, opacity in (('dark', '#ffffff', '.09'), ('light', '#000000', '.1'),
								  ('hcDark', '#ffffff', '.4'), ('hcLight', '#000000', '.4')):
		write_text(f'src/vs/workbench/browser/parts/editor/media/letterpress-{theme}.svg',
				   watermark(color, opacity))

	big_sizes = ((164, 314), (192, 386), (246, 459), (273, 556), (328, 604), (355, 700), (410, 797))
	small_sizes = ((55, 55), (64, 68), (83, 80), (92, 97), (110, 106), (119, 123), (138, 140))
	for family, dimensions in (('big', big_sizes), ('small', small_sizes)):
		for dpi, (width, height) in zip(range(100, 251, 25), dimensions):
			canvas = Image.new('RGB', (width, height), 'white')
			size = round(width * (.72 if family == 'big' else .85))
			icon = master.resize((size, size), Image.Resampling.LANCZOS)
			top = round(height * .15) if family == 'big' else (height - size) // 2
			canvas.paste(icon, ((width - size) // 2, top), icon)
			canvas.save(ROOT / f'resources/win32/inno-{family}-{dpi}.bmp')

	for name, (glyph, color) in FILE_GLYPHS.items():
		document = render(document_svg(glyph, color), 1024)
		for platform, suffix in (('win32', 'ico'), ('darwin', 'icns')):
			path = f'resources/{platform}/{name}.{suffix}'
			if (ROOT / path).exists():
				save_icon(path, document)
	print('CloudCode desktop, web, document and installer icons regenerated.')


if __name__ == '__main__':
	main()
